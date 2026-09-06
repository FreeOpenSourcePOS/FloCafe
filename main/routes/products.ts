import { Router, Request, Response } from 'express';
import { getDatabase, now, generateShortId, getSettingValue } from '../db';
import { requireRole, isBlockedSsrfTarget } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { getHttpRequestSignal } from '../shutdown';
import { getActiveCountryPack, hasConfiguredTaxCategories } from '../services/tax';
import * as crypto from 'crypto';
import * as dns from 'dns';
import * as https from 'https';
import * as net from 'net';
import { asyncHandler } from '../middleware/async-handler';

const MAX_FETCH_BYTES = 10 * 1024 * 1024;

/** Resolves hostname and rejects loopback/private/metadata/reserved IPs (SSRF guard). */
async function resolvePublicHostname(hostname: string, signal: AbortSignal): Promise<string> {
  const directAddress = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(directAddress)) {
    if (isBlockedSsrfTarget(directAddress)) throw new Error('URL resolves to a disallowed address');
    return directAddress;
  }
  let addresses: dns.LookupAddress[];
  const resolver = new dns.promises.Resolver();
  const createAbortError = () => {
    const error = new Error('Hostname resolution aborted');
    error.name = 'AbortError';
    return error;
  };
  if (signal.aborted) {
    throw createAbortError();
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      resolver.cancel();
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const lookup = (async () => {
    const results = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    if (signal.aborted) {
      throw createAbortError();
    }
    const resolvedAddresses: dns.LookupAddress[] = [];
    let firstError: { code?: string } | undefined;
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        const family: 4 | 6 = index === 0 ? 4 : 6;
        resolvedAddresses.push(...result.value.map((address) => ({ address, family })));
      } else {
        const error = result.reason as { code?: string } | undefined;
        if (error?.code !== 'ENODATA' && error?.code !== 'ENOTFOUND') {
          firstError ??= error;
        }
      }
    }
    if (resolvedAddresses.length > 0) {
      return resolvedAddresses;
    }
    if (firstError) {
      throw firstError;
    }
    const error = new Error('Hostname not found');
    (error as NodeJS.ErrnoException).code = 'ENOTFOUND';
    throw error;
  })();
  try {
    addresses = await Promise.race([lookup, aborted]);
  } catch (error: any) {
    if (error?.name === 'AbortError' || error?.code === 'ENOTFOUND') {
      throw error;
    }
    throw new Error('Could not resolve hostname');
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  if (addresses.length === 0) {
    throw new Error('Could not resolve hostname');
  }
  for (const { address } of addresses) {
    if (isBlockedSsrfTarget(address)) {
      throw new Error('URL resolves to a disallowed address');
    }
  }
  return addresses[0].address;
}

function fetchPinnedHttps(
  rawUrl: string,
  resolvedAddress: string,
  signal: AbortSignal,
): Promise<{ status: number; headers: Headers; body: Buffer }> {
  const parsedUrl = new URL(rawUrl);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: { status: number; headers: Headers; body: Buffer }) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result!);
    };

    const request = https.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: 'GET',
      headers: { 'User-Agent': 'FloCafe-ImageProxy/1.0' },
      servername: parsedUrl.hostname,
      signal,
      lookup: ((_hostname, options, callback) => {
        const family = net.isIP(resolvedAddress);
        // Restrict lookup strictly to the verified SSRF-safe address.
        if (options.all) {
          callback(null, [{ address: resolvedAddress, family }]);
          return;
        }
        callback(null, resolvedAddress, family);
      }) as net.LookupFunction,
    }, (response) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      response.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_FETCH_BYTES) {
          response.destroy();
          request.destroy();
          finish(new Error('Image too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(undefined, {
        status: response.statusCode || 502,
        headers: new Headers(response.headers as Record<string, string>),
        body: Buffer.concat(chunks),
      }));
      response.on('error', (error) => finish(error));
    });

    request.on('error', (error) => finish(error));
    request.end();
  });
}

/** Validates image data URI format (webp/png/jpeg) and length limit. */
function validateImageUrl(imageUrl: any): { valid: boolean; error?: string } {
  if (imageUrl === null || imageUrl === undefined) {
    return { valid: true }; // null means "clear the image"
  }
  if (typeof imageUrl !== 'string') {
    return { valid: false, error: 'image_url must be a string or null' };
  }
  if (!imageUrl.startsWith('data:image/')) {
    return { valid: false, error: 'image_url must be a Base64 data URI' };
  }
  const formatMatch = imageUrl.match(/^data:image\/(webp|png|jpeg|jpg);base64,/);
  if (!formatMatch) {
    return { valid: false, error: 'Invalid image format. Supported: webp, png, jpeg' };
  }
  if (imageUrl.length > 50_000) {
    return { valid: false, error: 'Image too large (max 50,000 characters)' };
  }
  return { valid: true };
}

/** Batch loads category and addon group relations for a list of products. */
function loadProductRelationsBatch(db: any, products: any[]) {
  if (products.length === 0) return new Map();

  const productIds = products.map((p: any) => p.id);
  const categoryIds = [...new Set(products.map((p: any) => p.category_id).filter(Boolean))];

  // 1. Load ONLY referenced categories
  const categoryMap = new Map<string, any>();
  if (categoryIds.length > 0) {
    const catPlaceholders = categoryIds.map(() => '?').join(',');
    const categoryRows = db.prepare(
      `SELECT * FROM categories WHERE id IN (${catPlaceholders})`
    ).all(...categoryIds) as any[];
    for (const c of categoryRows) {
      categoryMap.set(c.id, c);
    }
  }

  // 2. Load all addon_group ↔ product mappings for these products
  const placeholders = productIds.map(() => '?').join(',');
  const agpRows = db.prepare(
    `SELECT product_id, addon_group_id FROM addon_group_product WHERE product_id IN (${placeholders})`
  ).all(...productIds) as any[];

  // Group addon_group_ids by product_id
  const addonGroupIdsByProduct = new Map<string, string[]>();
  for (const row of agpRows) {
    const ids = addonGroupIdsByProduct.get(row.product_id) || [];
    ids.push(row.addon_group_id);
    addonGroupIdsByProduct.set(row.product_id, ids);
  }

  // 3. Load all referenced addon groups in one query
  const allAddonGroupIds = [...new Set(agpRows.map((r: any) => r.addon_group_id))];
  const addonGroupMap = new Map<string, any>();
  if (allAddonGroupIds.length > 0) {
    const agPlaceholders = allAddonGroupIds.map(() => '?').join(',');
    const addonGroups = db.prepare(
      `SELECT * FROM addon_groups WHERE is_active = 1 AND id IN (${agPlaceholders})`
    ).all(...allAddonGroupIds) as any[];
    for (const ag of addonGroups) {
      addonGroupMap.set(ag.id, ag);
    }
  }

  // 4. Load all addons for these groups in one query
  const addonMap = new Map<string, any[]>();
  if (allAddonGroupIds.length > 0) {
    const agPlaceholders = allAddonGroupIds.map(() => '?').join(',');
    const addons = db.prepare(
      `SELECT * FROM addons WHERE is_active = 1 AND addon_group_id IN (${agPlaceholders})`
    ).all(...allAddonGroupIds) as any[];
    for (const addon of addons) {
      const list = addonMap.get(addon.addon_group_id) || [];
      list.push(addon);
      addonMap.set(addon.addon_group_id, list);
    }
  }

  // 5. Assemble results
  const result = new Map<string, { category: any; addon_groups: any[] }>();
  for (const p of products) {
    const category = p.category_id ? categoryMap.get(p.category_id) || null : null;

    const agIds = addonGroupIdsByProduct.get(p.id) || [];
    const addon_groups = agIds
      .map((agId: string) => {
        const ag = addonGroupMap.get(agId);
        if (!ag) return null;
        return { ...ag, addons: addonMap.get(agId) || [] };
      })
      .filter(Boolean);

    result.set(p.id, { category, addon_groups });
  }

  return result;
}

const VALID_TAX_BEHAVIORS = ['country_default', 'inclusive', 'exclusive', 'exempt'];
const VALID_SALE_UNITS = ['each', 'kg', 'g', 'lb'] as const;

const router = Router();

function hasOwn(body: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 1;
}

function serializeCategory(category: any): any {
  if (!category) return category;
  return { ...category, is_active: toBoolean(category.is_active) };
}

function serializeAddon(addon: any): any {
  if (!addon) return addon;
  return {
    ...addon,
    is_active: toBoolean(addon.is_active),
    inherit_parent_tax_category: toBoolean(addon.inherit_parent_tax_category),
  };
}

function serializeAddonGroup(group: any): any {
  if (!group) return group;
  return {
    ...group,
    is_required: toBoolean(group.is_required),
    allow_multiple_quantities: toBoolean(group.allow_multiple_quantities),
    is_active: toBoolean(group.is_active),
    addons: Array.isArray(group.addons) ? group.addons.map(serializeAddon) : group.addons,
  };
}

function serializeProduct(product: any): any {
  if (!product) return product;
  return {
    ...product,
    is_active: toBoolean(product.is_active),
    track_inventory: toBoolean(product.track_inventory),
    allow_fractional_quantity: toBoolean(product.allow_fractional_quantity),
    has_image: toBoolean(product.has_image),
    category: serializeCategory(product.category),
    addon_groups: Array.isArray(product.addon_groups) ? product.addon_groups.map(serializeAddonGroup) : product.addon_groups,
  };
}

const PRODUCT_NUMERIC_FIELDS = [
  ['price', 0, Number.POSITIVE_INFINITY],
  ['cost_price', 0, Number.POSITIVE_INFINITY],
  ['cb_percent', 0, 100],
  ['stock_quantity', 0, Number.POSITIVE_INFINITY],
  ['low_stock_threshold', 0, Number.POSITIVE_INFINITY],
] as const;

function validateProductNumericFields(values: Record<string, unknown>, requirePrice: boolean): string | null {
  if (requirePrice && (typeof values.price !== 'number' || !Number.isFinite(values.price))) {
    return 'price must be a finite non-negative number';
  }
  for (const [field, minimum, maximum] of PRODUCT_NUMERIC_FIELDS) {
    const value = values[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
      return `${field} must be a finite number between ${minimum} and ${maximum === Number.POSITIVE_INFINITY ? 'the maximum supported value' : maximum}`;
    }
  }
  return null;
}

function normalizeSaleUnit(value: unknown): typeof VALID_SALE_UNITS[number] {
  return VALID_SALE_UNITS.includes(value as any) ? value as typeof VALID_SALE_UNITS[number] : 'each';
}

function validateWeightedProductFields(
  values: Record<string, unknown>,
  current?: { sale_unit?: string; allow_fractional_quantity?: boolean | number },
): string | null {
  if (values.sale_unit !== undefined && !VALID_SALE_UNITS.includes(values.sale_unit as any)) {
    return `sale_unit must be one of: ${VALID_SALE_UNITS.join(', ')}`;
  }
  if (values.allow_fractional_quantity !== undefined && typeof values.allow_fractional_quantity !== 'boolean') {
    return 'allow_fractional_quantity must be a boolean';
  }
  if (values.weight_precision !== undefined) {
    if (!Number.isSafeInteger(values.weight_precision) || (values.weight_precision as number) < 0 || (values.weight_precision as number) > 4) {
      return 'weight_precision must be an integer between 0 and 4';
    }
  }
  const effectiveSaleUnit = values.sale_unit !== undefined ? values.sale_unit : current?.sale_unit ?? 'each';
  const effectiveAllowFractional = values.allow_fractional_quantity !== undefined
    ? values.allow_fractional_quantity
    : Number(current?.allow_fractional_quantity) === 1;
  if (effectiveSaleUnit === 'each' && effectiveAllowFractional === true) {
    return 'allow_fractional_quantity requires a weighted sale_unit';
  }
  return null;
}

function validateTaxCategoryId(categoryId: unknown): string | null {
  if (categoryId === null || categoryId === undefined || categoryId === '') return null;
  if (typeof categoryId !== 'string') return 'tax_category_id must be a string or null';

  const country = getSettingValue('country') || 'IN';
  const businessType = getSettingValue('business_type') || 'restaurant';
  const pack = getActiveCountryPack(country);
  if (!hasConfiguredTaxCategories(pack, businessType)) {
    return `No configured tax categories are available for country ${country} and business type ${businessType}`;
  }
  if (!pack.categories.some((category) => category.id === categoryId)) {
    return `Unknown tax_category_id "${categoryId}" for country ${country}`;
  }
  return null;
}

function parseTags(raw: any): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return [];
}

function normalizeBarcode(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function normalizeNullableString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return String(raw);
  const trimmed = raw.trim();
  return trimmed || null;
}

function normalizeRequiredName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function validateCategoryId(db: any, categoryId: unknown): string | null {
  if (categoryId === null || categoryId === undefined || categoryId === '') return null;
  if (typeof categoryId !== 'string') return 'category_id must be a string or null';
  const category = db.prepare('SELECT id FROM categories WHERE id = ? AND deleted_at IS NULL AND is_active = 1').get(categoryId);
  if (!category) return 'Category not found or inactive';
  return null;
}

function validateAddonGroupIds(db: any, rawIds: unknown): { ids?: string[]; error?: string } {
  if (rawIds === undefined) return {};
  if (!Array.isArray(rawIds)) {
    return { error: 'addon_group_ids must be an array' };
  }

  const ids = rawIds.map((id) => (typeof id === 'string' ? id.trim() : id));
  if (ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    return { error: 'addon_group_ids must contain non-empty string IDs' };
  }

  const uniqueIds = [...new Set(ids as string[])];
  if (uniqueIds.length !== ids.length) {
    return { error: 'addon_group_ids must not contain duplicates' };
  }
  if (uniqueIds.length === 0) {
    return { ids: [] };
  }

  const placeholders = uniqueIds.map(() => '?').join(',');
  const activeRows = db.prepare(
    `SELECT id FROM addon_groups WHERE is_active = 1 AND id IN (${placeholders})`
  ).all(...uniqueIds) as Array<{ id: string }>;
  const activeIds = new Set(activeRows.map((row) => row.id));
  const missingIds = uniqueIds.filter((id) => !activeIds.has(id));
  if (missingIds.length > 0) {
    return { error: `Unknown or inactive addon_group_ids: ${missingIds.join(', ')}` };
  }

  return { ids: uniqueIds };
}

// Bulk product list; computes has_image in SQL to avoid loading Base64 blobs into memory.
router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    let query = `SELECT p.id, p.category_id, p.name, p.description, p.price, p.cost, p.sku, p.barcode,
      p.sale_unit, p.allow_fractional_quantity, p.weight_precision,
      p.is_active, p.sort_order, p.track_inventory, p.stock_quantity, p.low_stock_threshold,
      p.tax_type, p.tax_rate, p.tax_category_id, p.tax_behavior, p.cb_percent, p.tags, p.deleted_at, p.created_at, p.updated_at,
      CASE WHEN p.image_url IS NULL OR p.image_url = '' THEN 0 ELSE 1 END AS has_image
      FROM products p 
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.deleted_at IS NULL`;
    const params: any[] = [];

    if (req.query.category_id) {
      query += ' AND p.category_id = ?';
      params.push(req.query.category_id);
    }
    if (req.query.active === 'true' || req.query.active === '1') {
      query += ' AND p.is_active = 1 AND (c.id IS NULL OR c.is_active = 1)';
    }
    if (req.query.search) {
      query += ' AND (p.name LIKE ? OR p.sku LIKE ?)';
      const searchTerm = `%${req.query.search}%`;
      params.push(searchTerm, searchTerm);
    }
    if (req.query.barcode) {
      // Exact match — this is the scan-to-lookup path, not a fuzzy search.
      const barcode = normalizeBarcode(req.query.barcode);
      if (!barcode) {
        return res.json({ products: [] });
      }
      query += ' AND p.barcode = ?';
      params.push(barcode);
    }
    if (req.query.low_stock === 'true') {
      query += ' AND p.track_inventory = 1 AND p.stock_quantity <= p.low_stock_threshold';
    }

    query += ' ORDER BY p.sort_order, p.name';

    const products = db.prepare(query).all(...params);

    // Batch-load relations
    const relations = loadProductRelationsBatch(db, products as any[]);

    const productsWithRelations = (products as any[]).map((product: any) => {
      const rel = relations.get(product.id) || { category: null, addon_groups: [] };
      return serializeProduct({
        ...product,
        tags: parseTags(product.tags),
        category: rel.category,
        addon_groups: rel.addon_groups,
      });
    });

    res.json({ products: productsWithRelations });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id/image — serves decoded image data URI.
router.get('/:id/image', asyncHandler(async (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const row = db.prepare(
      'SELECT image_url FROM products WHERE id = ? AND deleted_at IS NULL'
    ).get(req.params.id) as any;

    if (!row || !row.image_url) {
      return res.status(404).json({ error: 'No image' });
    }

    const imageUrl = row.image_url as string;

    // Reject non-data URIs to prevent open redirects on public image route.
    if (!imageUrl.startsWith('data:')) {
      return res.status(404).json({ error: 'No image' });
    }

    // Parse data URI and restrict to permitted image mime types.
    const match = imageUrl.match(/^data:(image\/(webp|png|jpeg|jpg));base64,(.+)$/);
    if (!match) {
      return res.status(404).json({ error: 'No image' });
    }

    const contentType = match[1]; // e.g., "image/webp"
    const base64Data = match[3];  // group 2 is the extension, group 3 is the base64 data

    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length === 0) {
      return res.status(404).json({ error: 'No image' });
    }

    // ETag based on SHA-256 content hash (same perf as MD5 at this size,
    // avoids future "why MD5?" questions in code review)
    const etag = crypto.createHash('sha256').update(base64Data).digest('hex');

    // If client already has this version, return 304
    if (req.headers['if-none-match'] === `"${etag}"`) {
      return res.status(304).end();
    }

    res.set({
      'Content-Type': contentType,
      'Content-Length': buffer.length,
      'ETag': `"${etag}"`,
      'Cache-Control': 'no-cache', // Always revalidate — instant cross-terminal updates
    });
    res.send(buffer);
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}));

router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Single-product query — still batch-style for consistency
    const relations = loadProductRelationsBatch(db, [product as any]);
    const rel = relations.get((product as any).id) || { category: null, addon_groups: [] };

    res.json({ product: serializeProduct({ ...(product as any), tags: parseTags((product as any).tags), category: rel.category, addon_groups: rel.addon_groups }) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Fetches external https image URL and returns Base64 data URI.
router.post('/fetch-url', requireRole(...ROLE_ACCESS.ownerManager), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    // HTTPS only — prevents MITM and mixed-content issues
    if (!url.startsWith('https://')) {
      return res.status(400).json({ error: 'Only HTTPS URLs are supported' });
    }

    // Follow redirects manually to re-validate host and IP on each hop.
    const MAX_REDIRECTS = 5;
    let currentUrl = url;
    // Named to avoid colliding with Express's Response type imported above.
    let response: { status: number; headers: Headers; body: Buffer } | undefined;
    const controller = new AbortController();
    const requestSignal = getHttpRequestSignal(req);
    const abortForShutdown = () => controller.abort();
    if (requestSignal?.aborted) controller.abort();
    else requestSignal?.addEventListener('abort', abortForShutdown, { once: true });
    const timeout = setTimeout(() => controller.abort(), 15_000); // 15s timeout

    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(currentUrl);
      } catch {
        return res.status(400).json({ error: 'Invalid URL' });
      }
      if (parsedUrl.protocol !== 'https:') {
        return res.status(400).json({ error: 'Only HTTPS URLs are supported' });
      }
      if (parsedUrl.username || parsedUrl.password) {
        return res.status(400).json({ error: 'URLs with user credentials are not allowed' });
      }
      if (parsedUrl.port && parsedUrl.port !== '443') {
        return res.status(400).json({ error: 'Non-standard ports are not allowed' });
      }

      let resolvedAddress: string;
      try {
        resolvedAddress = await resolvePublicHostname(parsedUrl.hostname, controller.signal);
      } catch (error: any) {
        if (error?.name === 'AbortError') {
          return res.status(504).json({ error: 'Request timed out' });
        }
        if (error?.code === 'ENOTFOUND') {
          return res.status(502).json({ error: 'Could not resolve hostname' });
        }
        return res.status(400).json({ error: 'URL is not allowed' });
      }

      let hopResponse: { status: number; headers: Headers; body: Buffer };
      try {
        hopResponse = await fetchPinnedHttps(currentUrl, resolvedAddress, controller.signal);
      } catch (fetchError: any) {
        if (fetchError.name === 'AbortError') {
          return res.status(504).json({ error: 'Request timed out' });
        }
        if (fetchError.message === 'Image too large') {
          return res.status(413).json({ error: 'Image too large (max 10 MB)' });
        }
        return res.status(502).json({ error: 'Could not fetch the image' });
      }

      // "manual" redirect mode surfaces 3xx as an opaqueredirect/redirect
      // response instead of following it — inspect Location ourselves.
      if (hopResponse.status >= 300 && hopResponse.status < 400) {
        const location = hopResponse.headers.get('location');
        if (!location) {
          return res.status(502).json({ error: 'Could not fetch the image' });
        }
        if (hop === MAX_REDIRECTS) {
          return res.status(502).json({ error: 'Too many redirects' });
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      response = hopResponse;
      break;
      }

      if (!response) {
        return res.status(502).json({ error: 'Could not fetch the image' });
      }

      try {
        if (response.status < 200 || response.status >= 300) {
          return res.status(502).json({ error: 'Could not fetch the image' });
        }

      // Content-Type check — must be an image
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        return res.status(400).json({ error: 'URL does not point to an image' });
      }

      // Size limit (header) — fast rejection of obviously huge files
      const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
      if (contentLength > MAX_FETCH_BYTES) {
        return res.status(413).json({ error: 'Image too large (max 10 MB)' });
      }

      // Convert to Base64 data URI
      const base64 = response.body.toString('base64');
      const detectedType = contentType.split(';')[0].trim(); // e.g., "image/jpeg"
      const dataUri = `data:${detectedType};base64,${base64}`;

        res.json({ data: dataUri });
      } catch {
        return res.status(502).json({ error: 'Could not fetch the image' });
      }
    } finally {
      clearTimeout(timeout);
      requestSignal?.removeEventListener('abort', abortForShutdown);
    }
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}));

router.post('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const {
      category_id, name, sku, barcode, description, price, cost_price,
      sale_unit, allow_fractional_quantity, weight_precision,
      tax_category_id, tax_behavior, track_inventory, stock_quantity,
      low_stock_threshold, is_active, image_url, sort_order, cb_percent, tags, addon_group_ids
    } = req.body;
    const normalizedBarcode = normalizeBarcode(barcode);
    const productName = normalizeRequiredName(name);

    if (!productName || price === undefined) {
      return res.status(400).json({ error: 'Name and price are required' });
    }
    const numericError = validateProductNumericFields(req.body, true);
    if (numericError) return res.status(400).json({ error: numericError });
    const weightedFieldError = validateWeightedProductFields(req.body);
    if (weightedFieldError) return res.status(400).json({ error: weightedFieldError });

    if (cb_percent !== undefined && cb_percent !== null) {
      if (typeof cb_percent !== 'number' || !Number.isFinite(cb_percent) || cb_percent < 0 || cb_percent > 100) {
        return res.status(400).json({ error: 'cb_percent must be a number between 0 and 100' });
      }
    }

    if (tax_behavior !== undefined && tax_behavior !== null && !VALID_TAX_BEHAVIORS.includes(tax_behavior)) {
      return res.status(400).json({ error: `tax_behavior must be one of: ${VALID_TAX_BEHAVIORS.join(', ')}` });
    }
    const taxCategoryError = validateTaxCategoryId(tax_category_id);
    if (taxCategoryError) {
      return res.status(400).json({ error: taxCategoryError });
    }

    // Validate image_url at write time (server-side security boundary)
    const imageValidation = validateImageUrl(image_url);
    if (!imageValidation.valid) {
      return res.status(400).json({ error: imageValidation.error });
    }

    const db = getDatabase();
    const categoryError = validateCategoryId(db, category_id);
    if (categoryError) {
      return res.status(400).json({ error: categoryError });
    }

    // A barcode scan must resolve to exactly one product — unlike sku, which
    // is informational only, a duplicate barcode would make scanning ambiguous.
    if (normalizedBarcode) {
      const clash = db.prepare(
        'SELECT id FROM products WHERE barcode = ? AND deleted_at IS NULL'
      ).get(normalizedBarcode);
      if (clash) {
        return res.status(400).json({ error: 'Another product already uses this barcode' });
      }
    }

    const id = generateShortId('products');
    const addonGroupValidation = validateAddonGroupIds(db, addon_group_ids);
    if (addonGroupValidation.error) {
      return res.status(400).json({ error: addonGroupValidation.error });
    }
    const normalizedAddonGroupIds = addonGroupValidation.ids;

    // Wrap product INSERT + addon_group INSERTs in a transaction
    // so a partial failure doesn't leave orphaned records
    const insertProduct = db.transaction(() => {
      db.prepare(`
        INSERT INTO products (id, category_id, name, sku, barcode, description, price, cost,
          sale_unit, allow_fractional_quantity, weight_precision,
          tax_type, tax_rate, tax_category_id, tax_behavior, track_inventory, stock_quantity, low_stock_threshold,
          is_active, image_url, sort_order, cb_percent, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, normalizeNullableString(category_id), productName, normalizeNullableString(sku), normalizedBarcode, normalizeNullableString(description), price, cost_price || 0,
        normalizeSaleUnit(sale_unit), allow_fractional_quantity ? 1 : 0, weight_precision ?? 3,
        'none', 0, normalizeNullableString(tax_category_id), tax_behavior || 'country_default',
        track_inventory ? 1 : 0, stock_quantity || 0, low_stock_threshold || 0,
        is_active !== false ? 1 : 0, normalizeNullableString(image_url),
        sort_order || 0, cb_percent !== undefined ? cb_percent : null, JSON.stringify(tags || []),
        now(), now()
      );

      if (normalizedAddonGroupIds && normalizedAddonGroupIds.length > 0) {
        const insertAgp = db.prepare('INSERT INTO addon_group_product (addon_group_id, product_id) VALUES (?, ?)');
        for (const agId of normalizedAddonGroupIds) {
          insertAgp.run(agId, id);
        }
      }
    });
    insertProduct();

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    res.status(201).json({ product: serializeProduct(product) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as {
      sale_unit?: string;
      allow_fractional_quantity?: number;
    } | undefined;
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const {
      category_id, name, sku, barcode, description, price, cost_price,
      sale_unit, allow_fractional_quantity, weight_precision,
      tax_category_id, tax_behavior, track_inventory, stock_quantity,
      low_stock_threshold, is_active, image_url, sort_order, cb_percent, tags, addon_group_ids
    } = req.body;
    const normalizedBarcode = normalizeBarcode(barcode);
    const hasName = hasOwn(req.body, 'name');
    const productName = hasName ? normalizeRequiredName(name) : null;
    if (hasName && !productName) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const numericError = validateProductNumericFields(req.body, false);
    if (numericError) return res.status(400).json({ error: numericError });
    const weightedFieldError = validateWeightedProductFields(req.body, product);
    if (weightedFieldError) return res.status(400).json({ error: weightedFieldError });

    if (tax_behavior !== undefined && tax_behavior !== null && !VALID_TAX_BEHAVIORS.includes(tax_behavior)) {
      return res.status(400).json({ error: `tax_behavior must be one of: ${VALID_TAX_BEHAVIORS.join(', ')}` });
    }

    if (cb_percent !== undefined && cb_percent !== null) {
      if (typeof cb_percent !== 'number' || !Number.isFinite(cb_percent) || cb_percent < 0 || cb_percent > 100) {
        return res.status(400).json({ error: 'cb_percent must be a number between 0 and 100' });
      }
    }
    const taxCategoryError = validateTaxCategoryId(tax_category_id);
    if (taxCategoryError) {
      return res.status(400).json({ error: taxCategoryError });
    }
    if (hasOwn(req.body, 'category_id')) {
      const categoryError = validateCategoryId(db, category_id);
      if (categoryError) {
        return res.status(400).json({ error: categoryError });
      }
    }

    // Validate image_url at write time (server-side security boundary)
    if ('image_url' in req.body) {
      const imageValidation = validateImageUrl(image_url);
      if (!imageValidation.valid) {
        return res.status(400).json({ error: imageValidation.error });
      }
    }

    if (normalizedBarcode) {
      const clash = db.prepare(
        'SELECT id FROM products WHERE barcode = ? AND deleted_at IS NULL AND id != ?'
      ).get(normalizedBarcode, req.params.id);
      if (clash) {
        return res.status(400).json({ error: 'Another product already uses this barcode' });
      }
    }

    // Detect whether client explicitly sent image_url (even as null/undefined)
    // so we can distinguish "don't touch image_url" from "clear image_url"
    const hasImageUrl = 'image_url' in req.body;
    const hasTaxCategoryId = 'tax_category_id' in req.body;
    const hasCbPercent = 'cb_percent' in req.body;
    const hasCategoryId = hasOwn(req.body, 'category_id');
    const hasSku = hasOwn(req.body, 'sku');
    const hasBarcode = hasOwn(req.body, 'barcode');
    const hasDescription = hasOwn(req.body, 'description');
    const hasCostPrice = hasOwn(req.body, 'cost_price');
    const hasTags = hasOwn(req.body, 'tags');
    const hasSaleUnit = hasOwn(req.body, 'sale_unit');
    const hasAllowFractionalQuantity = hasOwn(req.body, 'allow_fractional_quantity');
    const hasWeightPrecision = hasOwn(req.body, 'weight_precision');

    const addonGroupValidation = validateAddonGroupIds(db, addon_group_ids);
    if (addonGroupValidation.error) {
      return res.status(400).json({ error: addonGroupValidation.error });
    }
    const normalizedAddonGroupIds = addonGroupValidation.ids;

    // Update product fields and add-on links atomically.
    const updateProduct = db.transaction(() => {
      db.prepare(`
        UPDATE products SET
          category_id = CASE WHEN @has_category_id = 1 THEN @category_id ELSE category_id END,
          name = CASE WHEN @has_name = 1 THEN @name ELSE name END,
          sku = CASE WHEN @has_sku = 1 THEN @sku ELSE sku END,
          barcode = CASE WHEN @has_barcode = 1 THEN @barcode ELSE barcode END,
          sale_unit = CASE WHEN @has_sale_unit = 1 THEN @sale_unit ELSE sale_unit END,
          allow_fractional_quantity = CASE WHEN @has_allow_fractional_quantity = 1 THEN @allow_fractional_quantity ELSE allow_fractional_quantity END,
          weight_precision = CASE WHEN @has_weight_precision = 1 THEN @weight_precision ELSE weight_precision END,
          description = CASE WHEN @has_description = 1 THEN @description ELSE description END,
          price = COALESCE(@price, price),
          cost = CASE WHEN @has_cost = 1 THEN @cost ELSE cost END,
          tax_type = 'none',
          tax_rate = 0,
          tax_category_id = CASE WHEN @has_tax_category_id = 1 THEN @tax_category_id ELSE tax_category_id END,
          tax_behavior = COALESCE(@tax_behavior, tax_behavior),
          track_inventory = COALESCE(@track_inventory, track_inventory),
          stock_quantity = COALESCE(@stock_quantity, stock_quantity),
          low_stock_threshold = COALESCE(@low_stock_threshold, low_stock_threshold),
          is_active = COALESCE(@is_active, is_active),
          image_url = CASE WHEN @has_image_url = 1 THEN @image_url ELSE image_url END,
          sort_order = COALESCE(@sort_order, sort_order),
          cb_percent = CASE WHEN @has_cb_percent = 1 THEN @cb_percent ELSE cb_percent END,
          tags = CASE WHEN @has_tags = 1 THEN @tags ELSE tags END,
          updated_at = @updated_at
        WHERE id = @id
      `).run({
        has_category_id: hasCategoryId ? 1 : 0,
        category_id: normalizeNullableString(category_id),
        has_name: hasName ? 1 : 0,
        name: productName,
        has_sku: hasSku ? 1 : 0,
        sku: normalizeNullableString(sku),
        has_barcode: hasBarcode ? 1 : 0,
        barcode: normalizedBarcode,
        has_sale_unit: hasSaleUnit ? 1 : 0,
        sale_unit: normalizeSaleUnit(sale_unit),
        has_allow_fractional_quantity: hasAllowFractionalQuantity ? 1 : 0,
        allow_fractional_quantity: allow_fractional_quantity ? 1 : 0,
        has_weight_precision: hasWeightPrecision ? 1 : 0,
        weight_precision: weight_precision ?? null,
        has_description: hasDescription ? 1 : 0,
        description: normalizeNullableString(description),
        price: price ?? null,
        has_cost: hasCostPrice ? 1 : 0,
        cost: cost_price ?? null,
        tax_category_id: normalizeNullableString(tax_category_id),
        tax_behavior: tax_behavior ?? null,
        has_tax_category_id: hasTaxCategoryId ? 1 : 0,
        track_inventory: track_inventory ? 1 : track_inventory === 0 || track_inventory === false ? 0 : null,
        stock_quantity: stock_quantity ?? null,
        low_stock_threshold: low_stock_threshold ?? null,
        is_active: is_active !== undefined ? (is_active ? 1 : 0) : null,
        has_image_url: hasImageUrl ? 1 : 0,
        image_url: hasImageUrl ? normalizeNullableString(image_url) : null,
        sort_order: sort_order ?? null,
        has_cb_percent: hasCbPercent ? 1 : 0,
        cb_percent: hasCbPercent ? cb_percent : null,
        has_tags: hasTags ? 1 : 0,
        tags: hasTags ? JSON.stringify(tags || []) : null,
        updated_at: now(),
        id: req.params.id
      });

      if (normalizedAddonGroupIds !== undefined) {
        db.prepare('DELETE FROM addon_group_product WHERE product_id = ?').run(req.params.id);
        if (normalizedAddonGroupIds.length > 0) {
          const insertAgp = db.prepare('INSERT INTO addon_group_product (addon_group_id, product_id) VALUES (?, ?)');
          for (const agId of normalizedAddonGroupIds) {
            insertAgp.run(agId, req.params.id);
          }
        }
      }
    });
    updateProduct();

    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json({ product: serializeProduct(updated) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    db.prepare('UPDATE products SET deleted_at = ? WHERE id = ?').run(now(), req.params.id);
    res.json({ message: 'Product deleted' });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/:id/stock', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const { action, quantity } = req.body;

    if (!action || quantity === undefined) {
      return res.status(400).json({ error: 'Action and quantity are required' });
    }

    if (!['set', 'increase', 'decrease'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Use: set, increase, decrease' });
    }
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) {
      return res.status(400).json({ error: 'quantity must be a non-negative number' });
    }

    const db = getDatabase();
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    let result;
    if (action === 'set') {
      result = db.prepare('UPDATE products SET stock_quantity = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
        .run(quantity, now(), req.params.id);
    } else if (action === 'increase') {
      result = db.prepare('UPDATE products SET stock_quantity = stock_quantity + ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
        .run(quantity, now(), req.params.id);
    } else {
      result = db.prepare('UPDATE products SET stock_quantity = stock_quantity - ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND stock_quantity >= ?')
        .run(quantity, now(), req.params.id, quantity);
    }
    if (result.changes === 0) {
      return res.status(400).json({ error: action === 'decrease' ? 'Insufficient stock' : 'Product not found' });
    }
    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json({ product: serializeProduct(updated) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Exposes zero-rate products so the merchant can review and opt into global loyalty.
router.get('/loyalty/global-rate-candidates', requireRole(...ROLE_ACCESS.ownerManager), (_req: Request, res: Response) => {
  try {
    const row = getDatabase().prepare(
      'SELECT COUNT(*) AS count FROM products WHERE cb_percent = 0 AND deleted_at IS NULL'
    ).get() as { count: number };
    res.json({ count: row.count });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/loyalty/apply-global-rate', requireRole(...ROLE_ACCESS.ownerManager), (_req: Request, res: Response) => {
  try {
    const result = getDatabase().prepare(
      'UPDATE products SET cb_percent = NULL, updated_at = ? WHERE cb_percent = 0 AND deleted_at IS NULL'
    ).run(now());
    res.json({ updated: result.changes });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export const productRoutes = router;

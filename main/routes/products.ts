import { Router, Request, Response } from 'express';
import { getDatabase, now, generateShortId, getSettingValue } from '../db';
import { requireRole, isBlockedSsrfTarget } from '../middleware/security';
import { getHttpRequestSignal } from '../shutdown';
import { getActiveCountryPack, hasConfiguredTaxCategories } from '../services/tax';
import * as crypto from 'crypto';
import * as dns from 'dns';
import * as https from 'https';
import * as net from 'net';
import { asyncHandler } from '../middleware/async-handler';

const MAX_FETCH_BYTES = 10 * 1024 * 1024;

/**
 * Resolves a hostname and rejects it if any resolved address is a
 * loopback/private/link-local/metadata/reserved IP (vuln-0003 SSRF guard).
 */
async function resolvePublicHostname(hostname: string): Promise<string> {
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch (error: any) {
    if (error?.code === 'ENOTFOUND') {
      throw error;
    }
    throw new Error('Could not resolve hostname');
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
        // Node 20+ may ask custom lookups for all candidate addresses while it
        // chooses an address family. We intentionally permit only the single
        // IP that passed the SSRF check, so return it in the requested shape.
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

/**
 * Validate that an image_url value is a valid Base64 data URI or null.
 * Enforces: type check, data:image/ prefix, supported formats (webp/png/jpeg),
 * and max length of 50,000 characters (~36.6 KB decoded).
 *
 * Called at write time — the GET /:id/image endpoint trusts this validation
 * and does NOT re-encode to verify (re-encode rejects valid images with
 * minor encoding variations like trailing newlines).
 */
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

/**
 * Load category and addon groups for a batch of products.
 * Returns a Map<productId, { category, addon_groups }> for O(1) lookup.
 *
 * Uses batch queries instead of N+1 — loads all categories and addon groups
 * in 3 queries regardless of product count.
 */
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

const router = Router();

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

// ── GET / — bulk product list ───────────────────────────────────────────
// Uses explicit column list to avoid loading Base64 blobs into Node.js memory.
// Computes has_image flag in SQL so the frontend knows which products have images.
router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    let query = `SELECT p.id, p.category_id, p.name, p.description, p.price, p.cost, p.sku, p.barcode,
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

// ── GET /:id — single product with relations ───────────────────────────
router.get('/:id/image', asyncHandler(async (req: Request, res: Response) => {
  // Image endpoint — must be defined BEFORE /:id to avoid route conflict
  try {
    const db = getDatabase();
    const row = db.prepare(
      'SELECT image_url FROM products WHERE id = ? AND deleted_at IS NULL'
    ).get(req.params.id) as any;

    if (!row || !row.image_url) {
      return res.status(404).json({ error: 'No image' });
    }

    const imageUrl = row.image_url as string;

    // Legacy external image URLs are not redirected. This endpoint is public
    // for <img> tags, so redirecting database values would create an open
    // redirect. Re-upload legacy images as validated Base64 data URIs.
    if (!imageUrl.startsWith('data:')) {
      return res.status(404).json({ error: 'No image' });
    }

    // Parse the data URI: "data:image/webp;base64,AAAA..."
    // Only allow formats that validateImageUrl accepts (webp/png/jpeg/jpg)
    // to prevent SVG or other dangerous content types from being served
    const match = imageUrl.match(/^data:(image\/(webp|png|jpeg|jpg));base64,(.+)$/);
    if (!match) {
      // Not a server error — it's invalid stored data. Return 404 so the
      // frontend falls back to the initials tile without creating noisy 500 logs.
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

// ── POST /fetch-url — CORS proxy for external image URLs ────────────────
// When a user pastes an https:// URL, the backend fetches the image and
// returns it as a Base64 data URI. The frontend then runs it through the
// same crop → compress pipeline as a local upload.
router.post('/fetch-url', requireRole('owner', 'manager'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    // HTTPS only — prevents MITM and mixed-content issues
    if (!url.startsWith('https://')) {
      return res.status(400).json({ error: 'Only HTTPS URLs are supported' });
    }

    // Follow redirects manually (capped) so each hop's hostname/IP is
    // re-validated — fetch()'s automatic redirect handling would otherwise
    // let an allowed URL 302 into an internal address (vuln-0003).
    const MAX_REDIRECTS = 5;
    let currentUrl = url;
    // Named to avoid colliding with Express's Response type imported above.
    let response: { status: number; headers: Headers; body: Buffer } | undefined;

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
        resolvedAddress = await resolvePublicHostname(parsedUrl.hostname);
      } catch (error: any) {
        if (error?.code === 'ENOTFOUND') {
          return res.status(502).json({ error: 'Could not resolve hostname' });
        }
        return res.status(400).json({ error: 'URL is not allowed' });
      }

      const controller = new AbortController();
      const requestSignal = getHttpRequestSignal(req);
      const abortForShutdown = () => controller.abort();
      if (requestSignal?.aborted) controller.abort();
      else requestSignal?.addEventListener('abort', abortForShutdown, { once: true });
      const timeout = setTimeout(() => controller.abort(), 15_000); // 15s timeout

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
      } finally {
        clearTimeout(timeout);
        requestSignal?.removeEventListener('abort', abortForShutdown);
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
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}));

router.post('/', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const {
      category_id, name, sku, barcode, description, price, cost_price,
      tax_category_id, tax_behavior, track_inventory, stock_quantity,
      low_stock_threshold, is_active, image_url, sort_order, cb_percent, tags, addon_group_ids
    } = req.body;
    const normalizedBarcode = normalizeBarcode(barcode);

    if (!name || price === undefined) {
      return res.status(400).json({ error: 'Name and price are required' });
    }
    const numericError = validateProductNumericFields(req.body, true);
    if (numericError) return res.status(400).json({ error: numericError });

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
          tax_type, tax_rate, tax_category_id, tax_behavior, track_inventory, stock_quantity, low_stock_threshold,
          is_active, image_url, sort_order, cb_percent, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, category_id || null, name, sku || null, normalizedBarcode, description || null, price, cost_price || 0,
        'none', 0, tax_category_id || null, tax_behavior || 'country_default',
        track_inventory ? 1 : 0, stock_quantity || 0, low_stock_threshold || 0,
        is_active !== false ? 1 : 0, image_url || null,
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

router.put('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const {
      category_id, name, sku, barcode, description, price, cost_price,
      tax_category_id, tax_behavior, track_inventory, stock_quantity,
      low_stock_threshold, is_active, image_url, sort_order, cb_percent, tags, addon_group_ids
    } = req.body;
    const normalizedBarcode = normalizeBarcode(barcode);

    const numericError = validateProductNumericFields(req.body, false);
    if (numericError) return res.status(400).json({ error: numericError });

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

    const addonGroupValidation = validateAddonGroupIds(db, addon_group_ids);
    if (addonGroupValidation.error) {
      return res.status(400).json({ error: addonGroupValidation.error });
    }
    const normalizedAddonGroupIds = addonGroupValidation.ids;

    // Update product fields and add-on links atomically.
    const updateProduct = db.transaction(() => {
      db.prepare(`
        UPDATE products SET
          category_id = COALESCE(@category_id, category_id),
          name = COALESCE(@name, name),
          sku = COALESCE(@sku, sku),
          barcode = COALESCE(@barcode, barcode),
          description = COALESCE(@description, description),
          price = COALESCE(@price, price),
          cost = COALESCE(@cost, cost),
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
          tags = COALESCE(@tags, tags),
          updated_at = @updated_at
        WHERE id = @id
      `).run({
        category_id, name, sku, barcode: normalizedBarcode, description, price, cost: cost_price,
        tax_category_id, tax_behavior,
        has_tax_category_id: hasTaxCategoryId ? 1 : 0,
        track_inventory: track_inventory ? 1 : track_inventory === 0 ? 0 : null,
        stock_quantity, low_stock_threshold,
        is_active: is_active !== undefined ? (is_active ? 1 : 0) : null,
        has_image_url: hasImageUrl ? 1 : 0,
        image_url: hasImageUrl ? image_url : null,
        sort_order,
        has_cb_percent: hasCbPercent ? 1 : 0,
        cb_percent: hasCbPercent ? cb_percent : null,
        tags: tags ? JSON.stringify(tags) : null,
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

router.delete('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
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

router.post('/:id/stock', requireRole('owner', 'manager'), (req: Request, res: Response) => {
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

// Every product created before the tri-state loyalty rates carries
// cb_percent = 0, which now reads as "earns nothing" — so an owner who sets a
// global rate on an upgraded install sees nothing happen. Migration 42
// deliberately does not rewrite those rows: "never configured" and
// "deliberately excluded" are indistinguishable in the old data, and guessing
// would silently start paying out on products a merchant had excluded. These
// two routes are the explicit, counted alternative — the owner sees how many
// products are affected, then chooses.
router.get('/loyalty/global-rate-candidates', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
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

router.post('/loyalty/apply-global-rate', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
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

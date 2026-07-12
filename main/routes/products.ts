import { Router, Request, Response } from 'express';
import { getDatabase, now, generateShortId } from '../db';
import { requireRole } from '../middleware/security';
import * as crypto from 'crypto';

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
      `SELECT * FROM addon_groups WHERE id IN (${agPlaceholders})`
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
      `SELECT * FROM addons WHERE addon_group_id IN (${agPlaceholders})`
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

const router = Router();

function parseTags(raw: any): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return [];
}

// ── GET / — bulk product list ───────────────────────────────────────────
// Uses explicit column list to avoid loading Base64 blobs into Node.js memory.
// Computes has_image flag in SQL so the frontend knows which products have images.
router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    let query = `SELECT id, category_id, name, description, price, cost, sku, barcode,
      is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold,
      tax_type, tax_rate, cb_percent, tags, deleted_at, created_at, updated_at,
      CASE WHEN image_url IS NULL OR image_url = '' THEN 0 ELSE 1 END AS has_image
      FROM products WHERE deleted_at IS NULL`;
    const params: any[] = [];

    if (req.query.category_id) {
      query += ' AND category_id = ?';
      params.push(req.query.category_id);
    }
    if (req.query.active === 'true' || req.query.active === '1') {
      query += ' AND is_active = 1';
    }
    if (req.query.search) {
      query += ' AND (name LIKE ? OR sku LIKE ?)';
      const searchTerm = `%${req.query.search}%`;
      params.push(searchTerm, searchTerm);
    }
    if (req.query.low_stock === 'true') {
      query += ' AND track_inventory = 1 AND stock_quantity <= low_stock_threshold';
    }

    query += ' ORDER BY sort_order, name';

    const products = db.prepare(query).all(...params);

    // Batch-load relations
    const relations = loadProductRelationsBatch(db, products as any[]);

    const productsWithRelations = (products as any[]).map((product: any) => {
      const rel = relations.get(product.id) || { category: null, addon_groups: [] };
      return {
        ...product,
        tags: parseTags(product.tags),
        category: rel.category,
        addon_groups: rel.addon_groups,
      };
    });

    res.json({ products: productsWithRelations });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /:id — single product with relations ───────────────────────────
router.get('/:id/image', (req: Request, res: Response) => {
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

    // Handle legacy URL strings (not Base64 data URIs)
    // 302 (not 301) because this is a temporary migration path — legacy URLs
    // should eventually be re-uploaded as Base64 through the new UI. Using 301
    // would tell browsers to permanently cache the redirect, which would prevent
    // us from later serving the re-uploaded Base64 version at this same URL.
    if (!imageUrl.startsWith('data:')) {
      return res.redirect(302, imageUrl);
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
    res.status(500).json({ error: error.message });
  }
});

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

    res.json({ product: { ...(product as any), tags: parseTags((product as any).tags), category: rel.category, addonGroups: rel.addon_groups } });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── POST /fetch-url — CORS proxy for external image URLs ────────────────
// When a user pastes an https:// URL, the backend fetches the image and
// returns it as a Base64 data URI. The frontend then runs it through the
// same crop → compress pipeline as a local upload.
router.post('/fetch-url', requireRole('owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    // HTTPS only — prevents MITM and mixed-content issues
    if (!url.startsWith('https://')) {
      return res.status(400).json({ error: 'Only HTTPS URLs are supported' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000); // 15s timeout

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'FloCafe-ImageProxy/1.0' },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return res.status(502).json({ error: 'Could not fetch the image' });
      }

      // Content-Type check — must be an image
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        return res.status(400).json({ error: 'URL does not point to an image' });
      }

      // Size limit (header) — fast rejection of obviously huge files
      const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
      if (contentLength > 10 * 1024 * 1024) {
        return res.status(413).json({ error: 'Image too large (max 10 MB)' });
      }

      // Stream with cumulative size tracking (handles chunked responses)
      const reader = response.body?.getReader();
      if (!reader) {
        return res.status(502).json({ error: 'Could not read image data' });
      }

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.length;
        if (totalBytes > MAX_BYTES) {
          reader.cancel();
          return res.status(413).json({ error: 'Image too large (max 10 MB)' });
        }
        chunks.push(value);
      }

      // Convert to Base64 data URI
      const buffer = Buffer.concat(chunks);
      const base64 = buffer.toString('base64');
      const detectedType = contentType.split(';')[0].trim(); // e.g., "image/jpeg"
      const dataUri = `data:${detectedType};base64,${base64}`;

      res.json({ data: dataUri });
    } catch (fetchError: any) {
      clearTimeout(timeout);
      if (fetchError.name === 'AbortError') {
        return res.status(504).json({ error: 'Request timed out' });
      }
      return res.status(502).json({ error: 'Could not fetch the image' });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const {
      category_id, name, sku, description, price, cost_price,
      tax_type, tax_rate, track_inventory, stock_quantity,
      low_stock_threshold, is_active, image_url, sort_order, cb_percent, tags, addon_group_ids
    } = req.body;

    if (!name || price === undefined) {
      return res.status(400).json({ error: 'Name and price are required' });
    }

    // Validate image_url at write time (server-side security boundary)
    const imageValidation = validateImageUrl(image_url);
    if (!imageValidation.valid) {
      return res.status(400).json({ error: imageValidation.error });
    }

    const db = getDatabase();
    const id = generateShortId('products');

    // Wrap product INSERT + addon_group INSERTs in a transaction
    // so a partial failure doesn't leave orphaned records
    const insertProduct = db.transaction(() => {
      db.prepare(`
        INSERT INTO products (id, category_id, name, sku, description, price, cost,
          tax_type, tax_rate, track_inventory, stock_quantity, low_stock_threshold,
          is_active, image_url, sort_order, cb_percent, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, category_id || null, name, sku || null, description || null, price, cost_price || 0,
        tax_type || 'none', tax_rate || 0,
        track_inventory ? 1 : 0, stock_quantity || 0, low_stock_threshold || 0,
        is_active !== false ? 1 : 0, image_url || null,
        sort_order || 0, cb_percent || 0, JSON.stringify(tags || []),
        now(), now()
      );

      if (addon_group_ids && addon_group_ids.length > 0) {
        const insertAgp = db.prepare('INSERT INTO addon_group_product (addon_group_id, product_id) VALUES (?, ?)');
        for (const agId of addon_group_ids) {
          insertAgp.run(agId, id);
        }
      }
    });
    insertProduct();

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    res.status(201).json({ product });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
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
      category_id, name, sku, description, price, cost_price,
      tax_type, tax_rate, track_inventory, stock_quantity,
      low_stock_threshold, is_active, image_url, sort_order, cb_percent, tags, addon_group_ids
    } = req.body;

    // Validate image_url at write time (server-side security boundary)
    if ('image_url' in req.body) {
      const imageValidation = validateImageUrl(image_url);
      if (!imageValidation.valid) {
        return res.status(400).json({ error: imageValidation.error });
      }
    }

    // Detect whether client explicitly sent image_url (even as null/undefined)
    // so we can distinguish "don't touch image_url" from "clear image_url"
    const hasImageUrl = 'image_url' in req.body;

    db.prepare(`
      UPDATE products SET 
        category_id = COALESCE(@category_id, category_id), 
        name = COALESCE(@name, name),
        sku = COALESCE(@sku, sku), 
        description = COALESCE(@description, description), 
        price = COALESCE(@price, price),
        cost = COALESCE(@cost, cost),
        tax_type = COALESCE(@tax_type, tax_type), 
        tax_rate = COALESCE(@tax_rate, tax_rate),
        track_inventory = COALESCE(@track_inventory, track_inventory),
        stock_quantity = COALESCE(@stock_quantity, stock_quantity), 
        low_stock_threshold = COALESCE(@low_stock_threshold, low_stock_threshold),
        is_active = COALESCE(@is_active, is_active),
        image_url = CASE WHEN @has_image_url = 1 THEN @image_url ELSE image_url END,
        sort_order = COALESCE(@sort_order, sort_order),
        cb_percent = COALESCE(@cb_percent, cb_percent),
        tags = COALESCE(@tags, tags),
        updated_at = @updated_at
      WHERE id = @id
    `).run({
      category_id, name, sku, description, price, cost: cost_price,
      tax_type, tax_rate,
      track_inventory: track_inventory ? 1 : track_inventory === 0 ? 0 : null,
      stock_quantity, low_stock_threshold,
      is_active: is_active !== undefined ? (is_active ? 1 : 0) : null,
      has_image_url: hasImageUrl ? 1 : 0, 
      image_url: hasImageUrl ? image_url : null,
      sort_order, cb_percent,
      tags: tags ? JSON.stringify(tags) : null,
      updated_at: now(),
      id: req.params.id
    });

    // Update addon group links — wrapped in transaction for atomicity
    if (addon_group_ids !== undefined) {
      const updateAddons = db.transaction(() => {
        db.prepare('DELETE FROM addon_group_product WHERE product_id = ?').run(req.params.id);
        if (addon_group_ids && addon_group_ids.length > 0) {
          const insertAgp = db.prepare('INSERT INTO addon_group_product (addon_group_id, product_id) VALUES (?, ?)');
          for (const agId of addon_group_ids) {
            insertAgp.run(agId, req.params.id);
          }
        }
      });
      updateAddons();
    }

    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json({ product: updated });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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

    const db = getDatabase();
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    let newQuantity = 0;
    switch (action) {
      case 'set':
        newQuantity = quantity;
        break;
      case 'increase':
        newQuantity = (product as any).stock_quantity + quantity;
        break;
      case 'decrease':
        newQuantity = (product as any).stock_quantity - quantity;
        if (newQuantity < 0) {
          return res.status(400).json({ error: 'Insufficient stock' });
        }
        break;
    }

    db.prepare('UPDATE products SET stock_quantity = ?, updated_at = ? WHERE id = ?').run(newQuantity, now(), req.params.id);
    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json({ product: updated });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export const productRoutes = router;
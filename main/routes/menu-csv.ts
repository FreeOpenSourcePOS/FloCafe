import { Router, Request, Response } from 'express';
import { getDatabase, now, generateShortId, getSettingValue } from '../db';
import { v4 as uuidv4 } from 'uuid';
import { requireRole } from '../middleware/security';
import { getActiveCountryPack, hasConfiguredTaxCategories } from '../services/tax';

const router = Router();

const VALID_TAX_BEHAVIORS = ['country_default', 'inclusive', 'exclusive', 'exempt'];

// ─── CSV helpers ─────────────────────────────────────────────────────────────

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (inQuotes) {
      if (char === '"' && normalized[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else if (char === '\n') {
      fields.push(field);
      if (fields.some((value) => value.trim())) rows.push(fields);
      fields = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length > 0 || fields.length > 0) {
    fields.push(field);
    if (fields.some((value) => value.trim())) rows.push(fields);
  }
  return rows;
}

function toObjects(rows: string[][]): Record<string, string>[] {
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = (row[i] ?? '').trim(); });
    return obj;
  });
}

function toCsvRow(fields: (string | number | null | undefined)[]): string {
  return fields
    .map((f) => {
      const s = String(f ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    })
    .join(',');
}

function isTruthy(v: string) {
  return ['yes', 'true', '1'].includes((v || '').toLowerCase());
}

// ─── Templates ───────────────────────────────────────────────────────────────

const TEMPLATES: Record<string, string> = {
  categories: [
    'name,description,color,icon,sort_order',
    'Beverages,Hot and cold drinks,blue,☕,1',
    'Food,Snacks and meals,green,🍔,2',
    'Desserts,Sweet treats,pink,🍰,3',
    'Combos,Meal deals and bundles,amber,🎁,4',
  ].join('\n'),

  products: [
    'id,sku,name,category,price,description,cost,tax_category,tax_behavior,cashback_percent,tags,is_active',
    ',,Cappuccino,Beverages,150,Rich espresso with steamed milk,50,,,,"veg,bestseller",yes',
    ',,Espresso,Beverages,100,,40,,,,veg,yes',
    ',,Cold Coffee,Beverages,130,Chilled blended coffee,45,,,,"veg,new_arrival",yes',
    ',,Classic Burger,Food,250,Juicy patty with lettuce and tomato,100,,,,non_veg,yes',
    ',,Veg Sandwich,Food,180,Fresh vegetables in toasted bread,60,,,,"veg,new_arrival",yes',
    ',,Chocolate Cake,Desserts,120,Rich chocolate slice,,,,,veg,yes',
  ].join('\n'),

  addons: [
    'group_name,addon_name,price,group_required,group_min_select,group_max_select',
    'Size,Small,0,no,1,1',
    'Size,Regular,20,no,1,1',
    'Size,Large,40,no,1,1',
    'Milk Type,Full Cream,0,yes,1,1',
    'Milk Type,Oat Milk,30,yes,1,1',
    'Milk Type,Almond Milk,40,yes,1,1',
    'Extras,Extra Shot,30,no,0,3',
    'Extras,Extra Sugar,0,no,0,3',
    'Temperature,Hot,0,yes,1,1',
    'Temperature,Cold (Iced),10,yes,1,1',
  ].join('\n'),
};

router.get('/template/:type', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  const type = req.params.type as string;
  const csv = TEMPLATES[type];
  if (!csv) return res.status(404).json({ error: 'Unknown template type' });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${type}-template.csv"`);
  res.send(csv);
});

// ─── Export ──────────────────────────────────────────────────────────────────

router.get('/export/categories', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const rows = db
      .prepare('SELECT * FROM categories WHERE deleted_at IS NULL ORDER BY sort_order, name')
      .all() as any[];
    const lines = ['name,description,color,icon,sort_order'];
    for (const c of rows)
      lines.push(toCsvRow([c.name, c.description, c.color, c.icon, c.sort_order]));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="categories-export.csv"');
    res.send(lines.join('\n'));
  } catch (err: any) {
    console.error('[API] Menu CSV export failed:', err);
    res.status(500).json({ error: 'Menu CSV export failed' });
  }
});

router.get('/export/products', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT p.*, c.name AS category_name
         FROM products p
         LEFT JOIN categories c ON p.category_id = c.id
         WHERE p.deleted_at IS NULL
         ORDER BY c.sort_order, p.sort_order, p.name`
      )
      .all() as any[];
    const lines = ['id,sku,name,category,price,description,cost,tax_category,tax_behavior,cashback_percent,tags,is_active'];
    for (const p of rows) {
      let tags = '';
      if (p.tags) {
        try { const t = JSON.parse(p.tags); tags = Array.isArray(t) ? t.join(',') : p.tags; }
        catch { tags = p.tags; }
      }
      lines.push(
        toCsvRow([p.id, p.sku, p.name, p.category_name, p.price, p.description, p.cost,
          p.tax_category_id ?? '', p.tax_behavior ?? '',
          p.cb_percent !== null ? p.cb_percent : '', tags, p.is_active ? 'yes' : 'no'])
      );
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="products-export.csv"');
    res.send(lines.join('\n'));
  } catch (err: any) {
    console.error('[API] Menu CSV export failed:', err);
    res.status(500).json({ error: 'Menu CSV export failed' });
  }
});

router.get('/export/addons', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const groups = db
      .prepare('SELECT * FROM addon_groups WHERE is_active = 1 ORDER BY sort_order, name')
      .all() as any[];
    const lines = ['group_name,addon_name,price,group_required,group_min_select,group_max_select'];
    for (const g of groups) {
      const addons = db
        .prepare('SELECT * FROM addons WHERE addon_group_id = ? AND is_active = 1 ORDER BY sort_order, name')
        .all(g.id) as any[];
      for (const a of addons)
        lines.push(toCsvRow([g.name, a.name, a.price, g.is_required ? 'yes' : 'no', g.min_selection, g.max_selection]));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="addons-export.csv"');
    res.send(lines.join('\n'));
  } catch (err: any) {
    console.error('[API] Menu CSV export failed:', err);
    res.status(500).json({ error: 'Menu CSV export failed' });
  }
});

// ─── Import ──────────────────────────────────────────────────────────────────

router.post('/import/categories', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { csv } = req.body as { csv: string };
    if (!csv) return res.status(400).json({ error: 'No CSV data provided' });

    const rows = toObjects(parseCSV(csv));
    if (!rows.length) return res.status(400).json({ error: 'CSV has no data rows' });

    const db = getDatabase();
    let created = 0, skipped = 0;
    const errors: string[] = [];

    db.transaction(() => { for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.name) { errors.push(`Row ${i + 2}: missing name`); continue; }

      const exists = db
        .prepare('SELECT id FROM categories WHERE name = ? AND deleted_at IS NULL')
        .get(r.name);
      if (exists) { skipped++; continue; }

      const slug = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      db.prepare(
        `INSERT INTO categories (id, name, slug, description, color, icon, sort_order, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).run(uuidv4(), r.name, slug, r.description || null, r.color || null, r.icon || null,
        parseInt(r.sort_order) || 0, now(), now());
      created++;
    } })();

    res.json({ created, skipped, errors });
  } catch (err: any) {
    console.error('[API] Menu CSV import failed:', err);
    res.status(500).json({ error: 'Menu CSV import failed' });
  }
});

router.post('/import/products', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { csv } = req.body as { csv: string };
    if (!csv) return res.status(400).json({ error: 'No CSV data provided' });

    const parsedCsv = parseCSV(csv);
    const headers = new Set((parsedCsv[0] || []).map((header) => header.trim().toLowerCase()));
    const hasTaxCategoryColumn = headers.has('tax_category');
    const hasTaxBehaviorColumn = headers.has('tax_behavior');
    const rows = toObjects(parsedCsv);
    if (!rows.length) return res.status(400).json({ error: 'CSV has no data rows' });

    const db = getDatabase();

    const catRows = db
      .prepare('SELECT id, name FROM categories WHERE deleted_at IS NULL')
      .all() as any[];
    const catMap: Record<string, string> = {};
    for (const c of catRows) catMap[c.name.toLowerCase()] = c.id;

    const country = getSettingValue('country') || 'IN';
    const businessType = getSettingValue('business_type') || 'restaurant';
    const activePack = getActiveCountryPack(country);
    const taxCategoriesConfigured = hasConfiguredTaxCategories(activePack, businessType);
    const taxCategoryIds = new Set(activePack.categories.map((category) => category.id));

    let created = 0, updated = 0, skipped = 0;
    const errors: string[] = [];

    db.transaction(() => { for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.name) { errors.push(`Row ${i + 2}: missing name`); continue; }

      const price = parseFloat(r.price);
      if (isNaN(price)) { errors.push(`Row ${i + 2} (${r.name}): invalid price "${r.price}"`); continue; }

      let categoryId: string | null = null;
      if (r.category) {
        categoryId = catMap[r.category.toLowerCase()] ?? null;
        if (!categoryId) {
          errors.push(`Row ${i + 2} (${r.name}): category "${r.category}" not found — import categories first`);
          continue;
        }
      }

      let tagsJson: string | null = null;
      if (r.tags) {
        const arr = r.tags.split(',').map((t: string) => t.trim()).filter(Boolean);
        if (arr.length) tagsJson = JSON.stringify(arr);
      }

      const isActive = !r.is_active || isTruthy(r.is_active) ? 1 : 0;
      const cost = parseFloat(r.cost) || 0;
      let cbPercent: number | null = null;
      if (r.cashback_percent !== undefined && r.cashback_percent !== null && r.cashback_percent.trim() !== '') {
        const parsed = Number(r.cashback_percent);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
          errors.push(`Row ${i + 2} (${r.name}): invalid cashback_percent "${r.cashback_percent}"`);
          continue;
        }
        cbPercent = parsed;
      }
      const sku = r.sku || null;

      let taxCategoryId: string | null = null;
      if (r.tax_category) {
        if (!taxCategoriesConfigured) {
          errors.push(`Row ${i + 2} (${r.name}): the active country pack (${activePack.id}) has no configured tax rules for business type ${businessType}`);
          continue;
        }
        if (!taxCategoryIds.has(r.tax_category)) {
          errors.push(`Row ${i + 2} (${r.name}): tax_category "${r.tax_category}" is not defined in the active country pack (${activePack.id})`);
          continue;
        }
        taxCategoryId = r.tax_category;
      }
      let taxBehavior: string | null = hasTaxBehaviorColumn ? 'country_default' : null;
      if (r.tax_behavior) {
        if (!VALID_TAX_BEHAVIORS.includes(r.tax_behavior)) {
          errors.push(`Row ${i + 2} (${r.name}): tax_behavior "${r.tax_behavior}" must be one of: ${VALID_TAX_BEHAVIORS.join(', ')}`);
          continue;
        }
        taxBehavior = r.tax_behavior;
      }

      // If an id is provided, try to update the existing product
      if (r.id) {
        const existing = db
          .prepare('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL')
          .get(r.id);
        if (!existing) {
          errors.push(`Row ${i + 2} (${r.name}): id "${r.id}" not found — leave id blank to create a new item`);
          continue;
        }
        db.prepare(
          `UPDATE products SET name=?, category_id=?, price=?, description=?, cost=?,
           tax_type=?, tax_rate=?,
           tax_category_id=CASE WHEN ? = 1 THEN ? ELSE tax_category_id END,
           tax_behavior=CASE WHEN ? = 1 THEN ? ELSE tax_behavior END,
           cb_percent=?, tags=?, is_active=?, sku=?, updated_at=?
           WHERE id=?`
        ).run(r.name, categoryId, price, r.description || null, cost,
          'none', 0, hasTaxCategoryColumn ? 1 : 0, taxCategoryId,
          hasTaxBehaviorColumn ? 1 : 0, taxBehavior,
          cbPercent, tagsJson, isActive, sku, now(), r.id);
        updated++;
        continue;
      }

      // No id — insert as new, skip if name+category duplicate
      const exists = db
        .prepare('SELECT id FROM products WHERE name = ? AND category_id IS ? AND deleted_at IS NULL')
        .get(r.name, categoryId);
      if (exists) { skipped++; continue; }

      db.prepare(
        `INSERT INTO products (id, name, category_id, price, description, cost, tax_type, tax_rate,
         tax_category_id, tax_behavior, cb_percent, tags, is_active, sku, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).run(generateShortId('products'), r.name, categoryId, price, r.description || null,
        cost, 'none', 0, taxCategoryId, taxBehavior || 'country_default', cbPercent, tagsJson, isActive, sku, now(), now());
      created++;
    } })();

    res.json({ created, updated, skipped, errors });
  } catch (err: any) {
    console.error('[API] Menu CSV import failed:', err);
    res.status(500).json({ error: 'Menu CSV import failed' });
  }
});

router.post('/import/addons', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { csv } = req.body as { csv: string };
    if (!csv) return res.status(400).json({ error: 'No CSV data provided' });

    const rows = toObjects(parseCSV(csv));
    if (!rows.length) return res.status(400).json({ error: 'CSV has no data rows' });

    const db = getDatabase();
    let groupsCreated = 0, addonsCreated = 0, skipped = 0;
    const errors: string[] = [];
    const groupCache: Record<string, string> = {};

    db.transaction(() => { for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.group_name || !r.addon_name) {
        errors.push(`Row ${i + 2}: missing group_name or addon_name`); continue;
      }

      const price = parseFloat(r.price);
      if (isNaN(price)) {
        errors.push(`Row ${i + 2} (${r.group_name}/${r.addon_name}): invalid price "${r.price}"`); continue;
      }

      const key = r.group_name.toLowerCase();
      let groupId = groupCache[key];
      if (!groupId) {
        const existing = db.prepare('SELECT id FROM addon_groups WHERE name = ?').get(r.group_name) as any;
        if (existing) {
          groupId = existing.id;
          // Reactivate if it was soft-deleted
          db.prepare('UPDATE addon_groups SET is_active = 1, updated_at = ? WHERE id = ?').run(now(), groupId);
        } else {
          groupId = uuidv4();
          db.prepare(
            `INSERT INTO addon_groups (id, name, is_required, min_selection, max_selection, is_active, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`
          ).run(groupId, r.group_name, isTruthy(r.group_required) ? 1 : 0,
            parseInt(r.group_min_select) || 0, parseInt(r.group_max_select) || 1, now(), now());
          groupsCreated++;
        }
        groupCache[key] = groupId;
      }

      const addonExists = db
        .prepare('SELECT id, is_active FROM addons WHERE addon_group_id = ? AND name = ?')
        .get(groupId, r.addon_name) as any;
      if (addonExists) {
        if (addonExists.is_active === 0) {
          db.prepare('UPDATE addons SET is_active = 1, price = ?, updated_at = ? WHERE id = ?')
            .run(price, now(), addonExists.id);
          addonsCreated++;
        } else {
          skipped++;
        }
        continue;
      }

      db.prepare(
        `INSERT INTO addons (id, addon_group_id, name, price, is_active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 0, ?, ?)`
      ).run(uuidv4(), groupId, r.addon_name, price, now(), now());
      addonsCreated++;
    } })();

    res.json({ groups_created: groupsCreated, addons_created: addonsCreated, skipped, errors });
  } catch (err: any) {
    console.error('[API] Menu CSV import failed:', err);
    res.status(500).json({ error: 'Menu CSV import failed' });
  }
});

export { router as menuCsvRoutes };

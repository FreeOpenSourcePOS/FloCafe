import { Router, Request, Response } from 'express';
import { getDatabase, now, generateShortId, getSettingValue } from '../db';
import { v4 as uuidv4 } from 'uuid';
import { requireRole } from '../middleware/security';
import { getActiveCountryPack, hasConfiguredTaxCategories } from '../services/tax';

const router = Router();

const VALID_TAX_BEHAVIORS = ['country_default', 'inclusive', 'exclusive', 'exempt'];

// Keep CSV imports below Express' default 100 KiB JSON body limit while also
// bounding the parser's work when it is mounted outside the production server.
const MAX_CSV_BYTES = 100_000;
const MAX_CSV_ROWS = 10_000;
const MAX_CSV_COLUMNS = 64;
const MAX_CSV_CELL_LENGTH = 10_000;
const NUMBER_TOKEN = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;

class CsvImportError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'CsvImportError';
  }
}

// ─── CSV helpers ─────────────────────────────────────────────────────────────

function parseCSV(text: string): string[][] {
  if (typeof text !== 'string') throw new CsvImportError('CSV data must be a string');
  if (Buffer.byteLength(text, 'utf8') > MAX_CSV_BYTES) {
    throw new CsvImportError(`CSV exceeds the ${MAX_CSV_BYTES}-byte size limit`);
  }

  const rows: string[][] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let afterClosingQuote = false;
  let lineNumber = 1;

  const append = (value: string) => {
    field += value;
    if (field.length > MAX_CSV_CELL_LENGTH) {
      throw new CsvImportError(`CSV cell on row ${lineNumber} exceeds the ${MAX_CSV_CELL_LENGTH}-character length limit`);
    }
  };

  const pushField = () => {
    if (fields.length >= MAX_CSV_COLUMNS) {
      throw new CsvImportError(`CSV row ${lineNumber} exceeds the ${MAX_CSV_COLUMNS}-cell limit`);
    }
    fields.push(field);
    field = '';
  };

  const pushRow = () => {
    pushField();
    if (fields.some((value) => value.trim())) {
      rows.push(fields);
      if (rows.length > MAX_CSV_ROWS) {
        throw new CsvImportError(`CSV exceeds the ${MAX_CSV_ROWS}-row limit`);
      }
    }
    fields = [];
    field = '';
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        append('"');
        i++;
      } else if (char === '"') {
        inQuotes = false;
        afterClosingQuote = true;
      } else {
        append(char);
        if (char === '\n') lineNumber++;
        else if (char === '\r') {
          if (text[i + 1] === '\n') {
            append('\n');
            i++;
          }
          lineNumber++;
        }
      }
      continue;
    }

    if (afterClosingQuote) {
      if (char === ',') {
        pushField();
        afterClosingQuote = false;
      } else if (char === '\n' || char === '\r') {
        pushRow();
        if (char === '\r' && text[i + 1] === '\n') i++;
        lineNumber++;
        afterClosingQuote = false;
      } else {
        throw new CsvImportError(`Malformed CSV: unexpected character after closing quote on row ${lineNumber}`);
      }
      continue;
    }

    if (char === '"') {
      if (field.length !== 0) {
        throw new CsvImportError(`Malformed CSV: unexpected quote on row ${lineNumber}`);
      }
      inQuotes = true;
    } else if (char === ',') {
      pushField();
    } else if (char === '\n' || char === '\r') {
      pushRow();
      if (char === '\r' && text[i + 1] === '\n') i++;
      lineNumber++;
    } else {
      append(char);
    }
  }

  if (inQuotes) {
    throw new CsvImportError(`Malformed CSV: unterminated quoted field on row ${lineNumber}`);
  }
  if (field.length > 0 || fields.length > 0 || afterClosingQuote) pushRow();

  return rows;
}

function toObjects(rows: string[][]): Record<string, string>[] {
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((row, index) => {
    if (row.length > headers.length) {
      throw new CsvImportError(`CSV row ${index + 2} has ${row.length} cells; expected at most ${headers.length}`);
    }
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = (row[i] ?? '').trim(); });
    return obj;
  });
}

type NumericParseResult = { ok: true; value: number } | { ok: false; error: string };

function parseNumericField(
  raw: string | undefined | null,
  fieldName: string,
  options: { optional?: boolean; defaultValue?: number; integer?: boolean; min?: number; max?: number } = {},
): NumericParseResult {
  const rawValue = raw ?? '';
  const value = rawValue.trim();
  if (value === '') {
    if (options.optional) return { ok: true, value: options.defaultValue ?? 0 };
    return { ok: false, error: `invalid ${fieldName} "${rawValue}"` };
  }
  if (!NUMBER_TOKEN.test(value)) return { ok: false, error: `invalid ${fieldName} "${rawValue}"` };

  const parsed = Number(value);
  if (!Number.isFinite(parsed)
    || (options.integer && !Number.isInteger(parsed))
    || (options.min !== undefined && parsed < options.min)
    || (options.max !== undefined && parsed > options.max)) {
    return { ok: false, error: `invalid ${fieldName} "${rawValue}"` };
  }
  return { ok: true, value: parsed };
}

function csvImportErrorResponse(res: Response, error: unknown): Response {
  if (error instanceof CsvImportError) {
    return res.status(error.statusCode).json({
      error: error.message,
      errors: [error.message],
      created: 0,
      updated: 0,
      reactivated: 0,
      skipped: 0,
      failed: 1,
      groups_created: 0,
      addons_created: 0,
      groups_reactivated: 0,
      addons_reactivated: 0,
    });
  }
  console.error('[API] Menu CSV import failed:', error);
  return res.status(500).json({ error: 'Menu CSV import failed' });
}

function toCsvRow(fields: (string | number | null | undefined)[]): string {
  return fields
    .map((f) => {
      let s = String(f ?? '');
      // Neutralize spreadsheet formula injection (CWE-1236 / GHSA-vrxh-633p-fhgm):
      // a cell beginning with = + - @ would be evaluated as a formula by Excel
      // or LibreOffice when the export is opened. Prefix with a single quote so
      // the cell is treated as literal text. Numeric fields are exempt so
      // legitimate negative numbers are not mangled.
      if (typeof f !== 'number' && /^[=+\-@]/.test(s)) {
        s = "'" + s;
      }
      return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
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
    if (typeof csv !== 'string' || !csv) return res.status(400).json({ error: 'No CSV data provided' });

    const rows = toObjects(parseCSV(csv));
    if (!rows.length) return res.status(400).json({ error: 'CSV has no data rows' });

    const db = getDatabase();
    let created = 0, updated = 0, reactivated = 0, skipped = 0, failed = 0;
    const errors: string[] = [];

    db.transaction(() => { for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.name) { failed++; errors.push(`Row ${i + 2}: missing name`); continue; }

      const sortOrder = parseNumericField(r.sort_order, 'sort_order', { optional: true, defaultValue: 0, integer: true });
      if (!sortOrder.ok) {
        failed++;
        errors.push(`Row ${i + 2} (${r.name}): ${sortOrder.error}`);
        continue;
      }

      const exists = db
        .prepare('SELECT id FROM categories WHERE name = ? AND deleted_at IS NULL')
        .get(r.name);
      if (exists) { skipped++; continue; }

      const slug = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      db.prepare(
        `INSERT INTO categories (id, name, slug, description, color, icon, sort_order, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).run(uuidv4(), r.name, slug, r.description || null, r.color || null, r.icon || null,
        sortOrder.value, now(), now());
      created++;
    } })();

    res.json({ created, updated, reactivated, skipped, failed, errors });
  } catch (err: any) {
    return csvImportErrorResponse(res, err);
  }
});

router.post('/import/products', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { csv } = req.body as { csv: string };
    if (typeof csv !== 'string' || !csv) return res.status(400).json({ error: 'No CSV data provided' });

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

    let created = 0, updated = 0, reactivated = 0, skipped = 0, failed = 0;
    const errors: string[] = [];

    db.transaction(() => { for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.name) { failed++; errors.push(`Row ${i + 2}: missing name`); continue; }

      const priceResult = parseNumericField(r.price, 'price', { min: 0 });
      if (!priceResult.ok) {
        failed++;
        errors.push(`Row ${i + 2} (${r.name}): ${priceResult.error}`);
        continue;
      }
      const price = priceResult.value;

      const costResult = parseNumericField(r.cost, 'cost', { optional: true, defaultValue: 0, min: 0 });
      if (!costResult.ok) {
        failed++;
        errors.push(`Row ${i + 2} (${r.name}): ${costResult.error}`);
        continue;
      }
      const cost = costResult.value;

      let categoryId: string | null = null;
      if (r.category) {
        categoryId = catMap[r.category.toLowerCase()] ?? null;
        if (!categoryId) {
          failed++;
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
      let cbPercent: number | null = null;
      if (r.cashback_percent !== undefined && r.cashback_percent !== null && r.cashback_percent.trim() !== '') {
        const cashbackResult = parseNumericField(r.cashback_percent, 'cashback_percent', { min: 0, max: 100 });
        if (!cashbackResult.ok) {
          failed++;
          errors.push(`Row ${i + 2} (${r.name}): ${cashbackResult.error}`);
          continue;
        }
        cbPercent = cashbackResult.value;
      }
      const sku = r.sku || null;

      let taxCategoryId: string | null = null;
      if (r.tax_category) {
        if (!taxCategoriesConfigured) {
          failed++;
          errors.push(`Row ${i + 2} (${r.name}): the active country pack (${activePack.id}) has no configured tax rules for business type ${businessType}`);
          continue;
        }
        if (!taxCategoryIds.has(r.tax_category)) {
          failed++;
          errors.push(`Row ${i + 2} (${r.name}): tax_category "${r.tax_category}" is not defined in the active country pack (${activePack.id})`);
          continue;
        }
        taxCategoryId = r.tax_category;
      }
      let taxBehavior: string | null = hasTaxBehaviorColumn ? 'country_default' : null;
      if (r.tax_behavior) {
        if (!VALID_TAX_BEHAVIORS.includes(r.tax_behavior)) {
          failed++;
          errors.push(`Row ${i + 2} (${r.name}): tax_behavior "${r.tax_behavior}" must be one of: ${VALID_TAX_BEHAVIORS.join(', ')}`);
          continue;
        }
        taxBehavior = r.tax_behavior;
      }

      // If an id is provided, try to update the existing product.
      if (r.id) {
        const existing = db
          .prepare('SELECT id, is_active FROM products WHERE id = ? AND deleted_at IS NULL')
          .get(r.id) as { id: string; is_active: number } | undefined;
        if (!existing) {
          failed++;
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
        if (existing.is_active === 0 && isActive === 1) reactivated++;
        else updated++;
        continue;
      }

      // No id — insert as new, skip if name+category duplicate.
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

    res.json({ created, updated, reactivated, skipped, failed, errors });
  } catch (err: any) {
    return csvImportErrorResponse(res, err);
  }
});

router.post('/import/addons', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { csv } = req.body as { csv: string };
    if (typeof csv !== 'string' || !csv) return res.status(400).json({ error: 'No CSV data provided' });

    const parsedCsv = parseCSV(csv);
    const headers = new Set((parsedCsv[0] || []).map((header) => header.trim().toLowerCase()));
    const hasGroupRequiredColumn = headers.has('group_required');
    const hasGroupMinColumn = headers.has('group_min_select');
    const hasGroupMaxColumn = headers.has('group_max_select');
    const rows = toObjects(parsedCsv);
    if (!rows.length) return res.status(400).json({ error: 'CSV has no data rows' });

    const db = getDatabase();
    let groupsCreated = 0, groupsUpdated = 0, addonsCreated = 0;
    let groupsReactivated = 0, addonsReactivated = 0;
    let skipped = 0, failed = 0;
    const errors: string[] = [];
    const groupCache: Record<string, string> = {};
    type AddonGroupImportPlan = {
      existing?: { id: string; is_active: number; is_required: number; min_selection: number; max_selection: number };
      activeAddonNames: Set<string>;
      activeAddonCount: number;
      importedAddonNames: Set<string>;
      minSelection: number;
      maxSelection: number;
      boundsError: string | null;
    };
    const groupPlans = new Map<string, AddonGroupImportPlan>();

    for (const row of rows) {
      if (!row.group_name || !row.addon_name) continue;

      const priceResult = parseNumericField(row.price, 'price', { min: 0 });
      const minResult = parseNumericField(row.group_min_select, 'group_min_select', { optional: true, defaultValue: 0, integer: true, min: 0 });
      const maxResult = parseNumericField(row.group_max_select, 'group_max_select', { optional: true, defaultValue: 1, integer: true, min: 0 });
      if (!priceResult.ok || !minResult.ok || !maxResult.ok) continue;

      const key = row.group_name.toLowerCase();
      let plan = groupPlans.get(key);
      if (!plan) {
        const existing = db.prepare(
          'SELECT id, is_active, is_required, min_selection, max_selection FROM addon_groups WHERE name = ?',
        ).get(row.group_name) as AddonGroupImportPlan['existing'];
        const activeAddons = existing
          ? db.prepare('SELECT name FROM addons WHERE addon_group_id = ? AND is_active = 1').all(existing.id) as { name: string }[]
          : [];
        const minSelection = hasGroupMinColumn ? minResult.value : (existing?.min_selection ?? 0);
        const maxSelection = hasGroupMaxColumn ? maxResult.value : (existing?.max_selection ?? 1);
        if (minSelection > maxSelection) continue;
        plan = {
          existing,
          activeAddonNames: new Set(activeAddons.map((addon) => addon.name)),
          activeAddonCount: activeAddons.length,
          importedAddonNames: new Set(),
          minSelection,
          maxSelection,
          boundsError: null,
        };
        groupPlans.set(key, plan);
      }

      const rowMinSelection = hasGroupMinColumn ? minResult.value : (plan.existing?.min_selection ?? 0);
      const rowMaxSelection = hasGroupMaxColumn ? maxResult.value : (plan.existing?.max_selection ?? 1);
      if (rowMinSelection > rowMaxSelection) continue;
      plan.importedAddonNames.add(row.addon_name);
    }

    for (const plan of groupPlans.values()) {
      const finalActiveAddonCount = plan.activeAddonCount
        + [...plan.importedAddonNames].filter((name) => !plan.activeAddonNames.has(name)).length;
      if (plan.minSelection > plan.maxSelection) {
        plan.boundsError = 'group_min_select must not exceed group_max_select';
      } else if (plan.minSelection > finalActiveAddonCount) {
        plan.boundsError = `group_min_select cannot exceed the final number of active add-ons (${finalActiveAddonCount})`;
      }
    }

    db.transaction(() => { for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.group_name || !r.addon_name) {
        failed++;
        errors.push(`Row ${i + 2}: missing group_name or addon_name`);
        continue;
      }

      const priceResult = parseNumericField(r.price, 'price', { min: 0 });
      if (!priceResult.ok) {
        failed++;
        errors.push(`Row ${i + 2} (${r.group_name}/${r.addon_name}): ${priceResult.error}`);
        continue;
      }
      const price = priceResult.value;

      const minResult = parseNumericField(r.group_min_select, 'group_min_select', { optional: true, defaultValue: 0, integer: true, min: 0 });
      if (!minResult.ok) {
        failed++;
        errors.push(`Row ${i + 2} (${r.group_name}/${r.addon_name}): ${minResult.error}`);
        continue;
      }
      const maxResult = parseNumericField(r.group_max_select, 'group_max_select', { optional: true, defaultValue: 1, integer: true, min: 0 });
      if (!maxResult.ok) {
        failed++;
        errors.push(`Row ${i + 2} (${r.group_name}/${r.addon_name}): ${maxResult.error}`);
        continue;
      }
      const key = r.group_name.toLowerCase();
      const groupPlan = groupPlans.get(key);
      const effectiveMinSelection = hasGroupMinColumn ? minResult.value : (groupPlan?.existing?.min_selection ?? 0);
      const effectiveMaxSelection = hasGroupMaxColumn ? maxResult.value : (groupPlan?.existing?.max_selection ?? 1);
      if (effectiveMinSelection > effectiveMaxSelection) {
        failed++;
        errors.push(`Row ${i + 2} (${r.group_name}/${r.addon_name}): group_min_select must not exceed group_max_select`);
        continue;
      }
      if (groupPlan?.boundsError) {
        failed++;
        errors.push(`Row ${i + 2} (${r.group_name}/${r.addon_name}): ${groupPlan.boundsError}`);
        continue;
      }

      let groupId = groupCache[key];
      if (!groupId) {
        const existing = db.prepare(
          'SELECT id, is_active, is_required, min_selection, max_selection FROM addon_groups WHERE name = ?',
        ).get(r.group_name) as {
          id: string;
          is_active: number;
          is_required: number;
          min_selection: number;
          max_selection: number;
        } | undefined;
        if (existing) {
          groupId = existing.id;
          const isRequired = hasGroupRequiredColumn ? (isTruthy(r.group_required) ? 1 : 0) : existing.is_required;
          const minSelection = hasGroupMinColumn ? minResult.value : existing.min_selection;
          const maxSelection = hasGroupMaxColumn ? maxResult.value : existing.max_selection;
          const settingsChanged = existing.is_required !== isRequired
            || existing.min_selection !== minSelection
            || existing.max_selection !== maxSelection;
          if (existing.is_active === 0) {
            db.prepare(
              `UPDATE addon_groups SET is_required = ?, min_selection = ?, max_selection = ?, is_active = 1, updated_at = ? WHERE id = ?`,
            ).run(isRequired, minSelection, maxSelection, now(), groupId);
            groupsReactivated++;
          } else if (settingsChanged) {
            db.prepare(
              `UPDATE addon_groups SET is_required = ?, min_selection = ?, max_selection = ?, updated_at = ? WHERE id = ?`,
            ).run(isRequired, minSelection, maxSelection, now(), groupId);
            groupsUpdated++;
          }
        } else {
          groupId = uuidv4();
          db.prepare(
            `INSERT INTO addon_groups (id, name, is_required, min_selection, max_selection, is_active, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`
          ).run(groupId, r.group_name, hasGroupRequiredColumn && isTruthy(r.group_required) ? 1 : 0,
            hasGroupMinColumn ? minResult.value : 0, hasGroupMaxColumn ? maxResult.value : 1, now(), now());
          groupsCreated++;
        }
        groupCache[key] = groupId;
      }

      const addonExists = db
        .prepare('SELECT id, is_active FROM addons WHERE addon_group_id = ? AND name = ?')
        .get(groupId, r.addon_name) as { id: string; is_active: number } | undefined;
      if (addonExists) {
        if (addonExists.is_active === 0) {
          db.prepare('UPDATE addons SET is_active = 1, price = ?, updated_at = ? WHERE id = ?')
            .run(price, now(), addonExists.id);
          addonsReactivated++;
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

    const created = groupsCreated + addonsCreated;
    const reactivated = groupsReactivated + addonsReactivated;
    res.json({
      created,
      updated: groupsUpdated,
      reactivated,
      skipped,
      failed,
      groups_created: groupsCreated,
      groups_updated: groupsUpdated,
      addons_created: addonsCreated,
      groups_reactivated: groupsReactivated,
      addons_reactivated: addonsReactivated,
      errors,
    });
  } catch (err: any) {
    return csvImportErrorResponse(res, err);
  }
});

export { router as menuCsvRoutes };

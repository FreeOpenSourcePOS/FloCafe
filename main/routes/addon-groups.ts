import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { getDatabase, now, withTxn, getSettingValue } from '../db';
import { randomUUID } from 'crypto';
import { requireRole } from '../middleware/security';
import { getActiveCountryPack, hasConfiguredTaxCategories } from '../services/tax';

const VALID_TAX_BEHAVIORS = ['country_default', 'inclusive', 'exclusive', 'exempt'];

const router = Router();
const addonGroupReadRateLimit = expressRateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
const addonGroupWriteRateLimit = expressRateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

type FieldErrors = Record<string, string[]>;

function hasOwn(body: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 1;
}

function normalizeBoolean(value: unknown, defaultValue = true): boolean {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  }
  return Boolean(value);
}

function parseName(value: unknown, field: string, errors: FieldErrors): string {
  if (typeof value !== 'string' || value.trim() === '') {
    errors[field] = [`${field} is required`];
    return '';
  }
  return value.trim();
}

function parseNonNegativeNumber(value: unknown, field: string, errors: FieldErrors, defaultValue?: number): number {
  if ((value === undefined || value === null || value === '') && defaultValue !== undefined) return defaultValue;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    errors[field] = [`${field} must be a finite non-negative number`];
    return defaultValue ?? 0;
  }
  return numeric;
}

function parseNonNegativeInteger(value: unknown, field: string, errors: FieldErrors, defaultValue: number): number {
  if (value === undefined || value === null || value === '') return defaultValue;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) {
    errors[field] = [`${field} must be a non-negative integer`];
    return defaultValue;
  }
  return numeric;
}

function validationErrorResponse(res: Response, errors: FieldErrors): Response | null {
  if (Object.keys(errors).length === 0) return null;
  return res.status(400).json({ errors });
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

function invalidTaxBehavior(addons: any[] | undefined): string | null {
  if (!Array.isArray(addons)) return null;
  for (const addon of addons) {
    if (addon?.tax_behavior !== undefined && addon.tax_behavior !== null && !VALID_TAX_BEHAVIORS.includes(addon.tax_behavior)) {
      return `tax_behavior must be one of: ${VALID_TAX_BEHAVIORS.join(', ')}`;
    }
  }
  return null;
}

function invalidTaxCategory(addons: any[] | undefined): string | null {
  if (!Array.isArray(addons)) return null;
  const country = getSettingValue('country') || 'IN';
  const businessType = getSettingValue('business_type') || 'restaurant';
  const pack = getActiveCountryPack(country);
  for (const addon of addons) {
    const categoryId = addon?.tax_category_id;
    if (categoryId === null || categoryId === undefined || categoryId === '') continue;
    if (typeof categoryId !== 'string') return 'tax_category_id must be a string or null';
    if (!hasConfiguredTaxCategories(pack, businessType)) {
      return `No configured tax categories are available for country ${country} and business type ${businessType}`;
    }
    if (!pack.categories.some((category) => category.id === categoryId)) {
      return `Unknown tax_category_id "${categoryId}" for country ${country}`;
    }
  }
  return null;
}

function validateSelectionBounds(minSelection: number, maxSelection: number, activeAddonCount: number): Record<string, string[]> | null {
  if (minSelection > maxSelection) {
    return { min_selection: ['Minimum selection cannot exceed maximum selection'] };
  }
  if (minSelection > activeAddonCount) {
    return { min_selection: [`Minimum selection cannot exceed the number of active add-ons (${activeAddonCount})`] };
  }
  return null;
}

// Guards against deactivating/deleting the last addon(s) that a group's min_selection depends on.
function wouldBreakMinSelection(db: ReturnType<typeof getDatabase>, groupId: string, excludeAddonId: string): Record<string, string[]> | null {
  const group = db.prepare('SELECT * FROM addon_groups WHERE id = ?').get(groupId) as { min_selection: number } | undefined;
  if (!group) return null;

  const remaining = (db.prepare(
    'SELECT COUNT(*) as count FROM addons WHERE addon_group_id = ? AND is_active = 1 AND id != ?'
  ).get(groupId, excludeAddonId) as { count: number }).count;

  if (remaining < group.min_selection) {
    return { min_selection: [`Cannot remove this addon — only ${remaining} would remain active, below the group's minimum selection of ${group.min_selection}. Lower the minimum selection first.`] };
  }
  return null;
}

router.get('/', addonGroupReadRateLimit, (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const groups = db.prepare('SELECT * FROM addon_groups WHERE is_active = 1 ORDER BY sort_order, name').all();

    const groupsWithAddons = groups.map((group: any) => {
      const addons = db.prepare('SELECT * FROM addons WHERE addon_group_id = ? AND is_active = 1 ORDER BY sort_order, name').all(group.id);
      return serializeAddonGroup({ ...group, addons });
    });

    res.json({ addon_groups: groupsWithAddons });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/:id', addonGroupReadRateLimit, (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const group = db.prepare('SELECT * FROM addon_groups WHERE id = ?').get(req.params.id);
    if (!group) {
      return res.status(404).json({ error: 'Addon group not found' });
    }

    const addons = db.prepare('SELECT * FROM addons WHERE addon_group_id = ? ORDER BY sort_order, name').all(req.params.id);
    res.json({ addon_group: serializeAddonGroup({ ...(group as any), addons }) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/', addonGroupWriteRateLimit, requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { name, description, is_required, min_selection, max_selection, allow_multiple_quantities, sort_order, addons } = req.body;

    const errors: FieldErrors = {};
    const groupName = parseName(name, 'name', errors);
    const min = parseNonNegativeInteger(min_selection, 'min_selection', errors, 0);
    const max = parseNonNegativeInteger(max_selection, 'max_selection', errors, 1);
    const order = parseNonNegativeInteger(sort_order, 'sort_order', errors, 0);
    if (addons !== undefined && !Array.isArray(addons)) {
      errors.addons = ['addons must be an array'];
    }
    const normalizedAddons = Array.isArray(addons) ? addons.map((addon: any, index: number) => {
      const addonErrors: FieldErrors = {};
      const addonName = parseName(addon?.name, `addons.${index}.name`, addonErrors);
      const price = parseNonNegativeNumber(addon?.price, `addons.${index}.price`, addonErrors, 0);
      Object.assign(errors, addonErrors);
      return {
        ...addon,
        name: addonName,
        price,
        is_active: normalizeBoolean(addon?.is_active, true),
      };
    }) : [];
    const activeAddonCount = normalizedAddons.filter((a: any) => a.is_active).length;
    const validationResponse = validationErrorResponse(res, errors);
    if (validationResponse) return validationResponse;
    const boundsError = validateSelectionBounds(min, max, activeAddonCount);
    if (boundsError) {
      return res.status(400).json({ errors: boundsError });
    }
    const taxBehaviorError = invalidTaxBehavior(normalizedAddons);
    if (taxBehaviorError) {
      return res.status(400).json({ error: taxBehaviorError });
    }
    const taxCategoryError = invalidTaxCategory(normalizedAddons);
    if (taxCategoryError) {
      return res.status(400).json({ error: taxCategoryError });
    }

    const db = getDatabase();
    const groupId = randomUUID();
    const { group, groupAddons } = withTxn(() => {
      db.prepare(`
        INSERT INTO addon_groups (id, name, description, is_required, min_selection, max_selection, allow_multiple_quantities, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        groupId, groupName, description || null, normalizeBoolean(is_required, false) ? 1 : 0, min, max,
        normalizeBoolean(allow_multiple_quantities, false) ? 1 : 0, order, now(), now()
      );

      if (normalizedAddons.length > 0) {
        const insertAddon = db.prepare(`
          INSERT INTO addons (id, addon_group_id, name, price, tax_category_id, tax_behavior, inherit_parent_tax_category, is_active, sort_order, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        normalizedAddons.forEach((addon: any, index: number) => {
          insertAddon.run(
            randomUUID(), groupId, addon.name, addon.price || 0,
            addon.tax_category_id || null, addon.tax_behavior || 'country_default',
            addon.inherit_parent_tax_category !== false ? 1 : 0,
            addon.is_active ? 1 : 0, index, now(), now(),
          );
        });
      }

      return {
        group: db.prepare('SELECT * FROM addon_groups WHERE id = ?').get(groupId),
        groupAddons: db.prepare('SELECT * FROM addons WHERE addon_group_id = ?').all(groupId),
      };
    });

    res.status(201).json({ addon_group: serializeAddonGroup(Object.assign({}, group, { addons: groupAddons })) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put('/:id', addonGroupWriteRateLimit, requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const group = db.prepare('SELECT * FROM addon_groups WHERE id = ?').get(req.params.id);
    if (!group) {
      return res.status(404).json({ error: 'Addon group not found' });
    }

    const { name, description, is_required, min_selection, max_selection, allow_multiple_quantities, sort_order, is_active, addons } = req.body;

    const errors: FieldErrors = {};
    const groupName = name === undefined ? null : parseName(name, 'name', errors);
    const effectiveMin = parseNonNegativeInteger(min_selection, 'min_selection', errors, (group as any).min_selection);
    const effectiveMax = parseNonNegativeInteger(max_selection, 'max_selection', errors, (group as any).max_selection);
    const order = parseNonNegativeInteger(sort_order, 'sort_order', errors, (group as any).sort_order);
    if (addons !== undefined && !Array.isArray(addons)) {
      errors.addons = ['addons must be an array'];
    }
    const existingAddonRows = db.prepare('SELECT * FROM addons WHERE addon_group_id = ?').all(req.params.id) as any[];
    const existingAddonIds = new Set(existingAddonRows.map((addon) => addon.id));
    const normalizedAddons = Array.isArray(addons) ? addons.map((addon: any, index: number) => {
      const addonErrors: FieldErrors = {};
      const addonName = parseName(addon?.name, `addons.${index}.name`, addonErrors);
      const price = parseNonNegativeNumber(addon?.price, `addons.${index}.price`, addonErrors, 0);
      if (addon?.id !== undefined && (typeof addon.id !== 'string' || !existingAddonIds.has(addon.id))) {
        addonErrors[`addons.${index}.id`] = ['addon id must belong to this group'];
      }
      Object.assign(errors, addonErrors);
      return {
        ...addon,
        name: addonName,
        price,
        is_active: normalizeBoolean(addon?.is_active, true),
      };
    }) : null;
    const validationResponse = validationErrorResponse(res, errors);
    if (validationResponse) return validationResponse;
    const activeAddonCount = Array.isArray(addons)
      ? normalizedAddons!.filter((a: any) => a.is_active).length
      : (db.prepare('SELECT COUNT(*) as count FROM addons WHERE addon_group_id = ? AND is_active = 1').get(req.params.id) as { count: number }).count;
    const boundsError = validateSelectionBounds(effectiveMin, effectiveMax, activeAddonCount);
    if (boundsError) {
      return res.status(400).json({ errors: boundsError });
    }
    const taxBehaviorError = invalidTaxBehavior(normalizedAddons || undefined);
    if (taxBehaviorError) {
      return res.status(400).json({ error: taxBehaviorError });
    }
    const taxCategoryError = invalidTaxCategory(normalizedAddons || undefined);
    if (taxCategoryError) {
      return res.status(400).json({ error: taxCategoryError });
    }

    const reqName = groupName;
    const hasDescription = hasOwn(req.body, 'description');
    const reqDesc = description === undefined || description === null || description === '' ? null : description;
    const reqReq = is_required === undefined ? null : (normalizeBoolean(is_required, false) ? 1 : 0);
    const reqMin = min_selection === undefined ? null : effectiveMin;
    const reqMax = max_selection === undefined ? null : effectiveMax;
    const reqAllowMult = allow_multiple_quantities === undefined ? null : (normalizeBoolean(allow_multiple_quantities, false) ? 1 : 0);
    const reqSort = sort_order === undefined ? null : order;
    const reqActive = is_active === undefined ? null : (normalizeBoolean(is_active, true) ? 1 : 0);

    const { updated, updatedAddons } = withTxn(() => {
      db.prepare(`
        UPDATE addon_groups SET name = COALESCE(?, name), description = CASE WHEN ? = 1 THEN ? ELSE description END,
          is_required = COALESCE(?, is_required), min_selection = COALESCE(?, min_selection),
          max_selection = COALESCE(?, max_selection), allow_multiple_quantities = COALESCE(?, allow_multiple_quantities),
          sort_order = COALESCE(?, sort_order), is_active = COALESCE(?, is_active), updated_at = ?
        WHERE id = ?
      `).run(reqName, hasDescription ? 1 : 0, reqDesc, reqReq, reqMin, reqMax, reqAllowMult, reqSort, reqActive, now(), req.params.id);

      if (normalizedAddons) {
        const touchedIds = new Set<string>();
        const updateAddon = db.prepare(`
          UPDATE addons SET name = ?, price = ?, tax_category_id = ?, tax_behavior = ?,
            inherit_parent_tax_category = ?, is_active = ?, sort_order = ?, updated_at = ?
          WHERE id = ? AND addon_group_id = ?
        `);
        const insertAddon = db.prepare(`
          INSERT INTO addons (id, addon_group_id, name, price, tax_category_id, tax_behavior, inherit_parent_tax_category, is_active, sort_order, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        normalizedAddons.forEach((addon: any, index: number) => {
          const addonId = addon.id || randomUUID();
          touchedIds.add(addonId);
          const values = [
            addon.name, addon.price,
            addon.tax_category_id || null, addon.tax_behavior || 'country_default',
            addon.inherit_parent_tax_category !== false ? 1 : 0,
            addon.is_active ? 1 : 0, index, now(),
          ];
          if (addon.id) {
            updateAddon.run(...values, addonId, req.params.id);
          } else {
            insertAddon.run(addonId, req.params.id, ...values.slice(0, -1), now(), now());
          }
        });
        for (const existingAddon of existingAddonRows) {
          if (!touchedIds.has(existingAddon.id) && existingAddon.is_active) {
            db.prepare('UPDATE addons SET is_active = 0, updated_at = ? WHERE id = ?').run(now(), existingAddon.id);
          }
        }
      }

      return {
        updated: db.prepare('SELECT * FROM addon_groups WHERE id = ?').get(req.params.id),
        updatedAddons: db.prepare('SELECT * FROM addons WHERE addon_group_id = ?').all(req.params.id),
      };
    });

    res.json({ addon_group: serializeAddonGroup(Object.assign({}, updated, { addons: updatedAddons })) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete('/:id', addonGroupWriteRateLimit, requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const group = db.prepare('SELECT * FROM addon_groups WHERE id = ?').get(req.params.id);
    if (!group) {
      return res.status(404).json({ error: 'Addon group not found' });
    }

    // Soft delete — order_items already snapshot chosen addons as JSON at order
    // time, but keeping the row lets historical orders/product editors resolve
    // addon_group_id without a dangling reference.
    db.prepare('UPDATE addon_groups SET is_active = 0, updated_at = ? WHERE id = ?').run(now(), req.params.id);
    res.json({ message: 'Addon group deleted' });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Addon management within a group
router.post('/:groupId/addons', addonGroupWriteRateLimit, requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { name, price, tax_category_id, tax_behavior, inherit_parent_tax_category, is_active, sort_order } = req.body;

    const errors: FieldErrors = {};
    const addonName = parseName(name, 'name', errors);
    const addonPrice = parseNonNegativeNumber(price, 'price', errors);
    const addonActive = normalizeBoolean(is_active, true);
    const addonSort = parseNonNegativeInteger(sort_order, 'sort_order', errors, 0);
    const validationResponse = validationErrorResponse(res, errors);
    if (validationResponse) return validationResponse;
    if (tax_behavior !== undefined && tax_behavior !== null && !VALID_TAX_BEHAVIORS.includes(tax_behavior)) {
      return res.status(400).json({ error: `tax_behavior must be one of: ${VALID_TAX_BEHAVIORS.join(', ')}` });
    }
    const taxCategoryError = invalidTaxCategory([{ tax_category_id }]);
    if (taxCategoryError) {
      return res.status(400).json({ error: taxCategoryError });
    }

    const db = getDatabase();
    const group = db.prepare('SELECT * FROM addon_groups WHERE id = ?').get(req.params.groupId);
    if (!group) {
      return res.status(404).json({ error: 'Addon group not found' });
    }
    if (!(group as any).is_active) {
      return res.status(400).json({ error: 'Cannot add add-ons to an inactive group' });
    }
    if (addonActive) {
      const activeAddonCount = (db.prepare('SELECT COUNT(*) as count FROM addons WHERE addon_group_id = ? AND is_active = 1').get(req.params.groupId) as { count: number }).count + 1;
      const boundsError = validateSelectionBounds((group as any).min_selection, (group as any).max_selection, activeAddonCount);
      if (boundsError) {
        return res.status(400).json({ errors: boundsError });
      }
    }

    const addonId = randomUUID();
    db.prepare(`
      INSERT INTO addons (id, addon_group_id, name, price, tax_category_id, tax_behavior, inherit_parent_tax_category, is_active, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      addonId, req.params.groupId, addonName, addonPrice,
      tax_category_id || null, tax_behavior || 'country_default', inherit_parent_tax_category !== false ? 1 : 0,
      addonActive ? 1 : 0, addonSort, now(), now(),
    );

    const addon = db.prepare('SELECT * FROM addons WHERE id = ?').get(addonId);
    res.status(201).json({ addon: serializeAddon(addon) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put('/:groupId/addons/:addonId', addonGroupWriteRateLimit, requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { name, price, tax_category_id, tax_behavior, inherit_parent_tax_category, is_active, sort_order } = req.body;

    const errors: FieldErrors = {};
    const addonName = name === undefined ? null : parseName(name, 'name', errors);
    const addonPrice = price === undefined ? null : parseNonNegativeNumber(price, 'price', errors);
    const addonSort = sort_order === undefined ? null : parseNonNegativeInteger(sort_order, 'sort_order', errors, 0);
    const addonActive = is_active === undefined ? null : normalizeBoolean(is_active, true);
    const validationResponse = validationErrorResponse(res, errors);
    if (validationResponse) return validationResponse;
    if (tax_behavior !== undefined && tax_behavior !== null && !VALID_TAX_BEHAVIORS.includes(tax_behavior)) {
      return res.status(400).json({ error: `tax_behavior must be one of: ${VALID_TAX_BEHAVIORS.join(', ')}` });
    }
    const taxCategoryError = invalidTaxCategory([{ tax_category_id }]);
    if (taxCategoryError) {
      return res.status(400).json({ error: taxCategoryError });
    }

    const db = getDatabase();
    const addon = db.prepare('SELECT * FROM addons WHERE id = ? AND addon_group_id = ?').get(req.params.addonId, req.params.groupId) as { is_active: number } | undefined;
    if (!addon) {
      return res.status(404).json({ error: 'Addon not found' });
    }
    const group = db.prepare('SELECT * FROM addon_groups WHERE id = ?').get(req.params.groupId);
    if (!group || !(group as any).is_active) {
      return res.status(400).json({ error: 'Cannot update add-ons for an inactive group' });
    }

    const hasTaxCategoryId = 'tax_category_id' in req.body;
    const updatedAtomically = withTxn(() => {
      const current = db.prepare('SELECT is_active FROM addons WHERE id = ? AND addon_group_id = ?')
        .get(req.params.addonId, req.params.groupId) as { is_active: number } | undefined;
      if (!current) return false;
      if (addonActive === false && current.is_active) {
        const boundsError = wouldBreakMinSelection(db, req.params.groupId as string, req.params.addonId as string);
        if (boundsError) return boundsError;
      }

      db.prepare(`
        UPDATE addons SET name = COALESCE(?, name), price = COALESCE(?, price),
          tax_category_id = CASE WHEN ? = 1 THEN ? ELSE tax_category_id END,
          tax_behavior = COALESCE(?, tax_behavior),
          inherit_parent_tax_category = COALESCE(?, inherit_parent_tax_category),
          is_active = COALESCE(?, is_active), sort_order = COALESCE(?, sort_order)
        WHERE id = ?
      `).run(
        addonName, addonPrice, hasTaxCategoryId ? 1 : 0, tax_category_id, tax_behavior,
        inherit_parent_tax_category === undefined ? null : (inherit_parent_tax_category ? 1 : 0),
        addonActive === null ? null : (addonActive ? 1 : 0), addonSort, req.params.addonId,
      );
      return true;
    });
    if (updatedAtomically !== true) {
      if (updatedAtomically === false) return res.status(404).json({ error: 'Addon not found' });
      return res.status(400).json({ errors: updatedAtomically });
    }

    const updated = db.prepare('SELECT * FROM addons WHERE id = ?').get(req.params.addonId);
    res.json({ addon: serializeAddon(updated) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete('/:groupId/addons/:addonId', addonGroupWriteRateLimit, requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const group = db.prepare('SELECT * FROM addon_groups WHERE id = ?').get(req.params.groupId);
    if (!group || !(group as any).is_active) {
      return res.status(400).json({ error: 'Cannot delete add-ons from an inactive group' });
    }
    const addon = db.prepare('SELECT * FROM addons WHERE id = ? AND addon_group_id = ?').get(req.params.addonId, req.params.groupId) as { is_active: number } | undefined;
    if (!addon) {
      return res.status(404).json({ error: 'Addon not found' });
    }

    const deletedAtomically = withTxn(() => {
      const current = db.prepare('SELECT is_active FROM addons WHERE id = ? AND addon_group_id = ?')
        .get(req.params.addonId, req.params.groupId) as { is_active: number } | undefined;
      if (!current) return false;
      if (current.is_active) {
        const boundsError = wouldBreakMinSelection(db, req.params.groupId as string, req.params.addonId as string);
        if (boundsError) return boundsError;
      }
      db.prepare('UPDATE addons SET is_active = 0, updated_at = ? WHERE id = ?').run(now(), req.params.addonId);
      return true;
    });
    if (deletedAtomically !== true) {
      if (deletedAtomically === false) return res.status(404).json({ error: 'Addon not found' });
      return res.status(400).json({ errors: deletedAtomically });
    }
    res.json({ message: 'Addon deleted' });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export const addonGroupRoutes = router;

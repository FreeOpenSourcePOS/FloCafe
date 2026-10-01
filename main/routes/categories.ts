import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { getDatabase, now, generateShortId } from '../db';
import { requirePermission } from '../services/authorization';

const router = Router();
const categoryWriteRateLimit = expressRateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

function hasOwn(body: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return String(value);
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeCategoryName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function validateCategoryAddonGroupIds(
  db: ReturnType<typeof getDatabase>,
  rawIds: unknown,
  categoryId?: string,
): { ids?: string[]; error?: string } {
  if (rawIds === undefined) return {};
  if (!Array.isArray(rawIds)) return { error: 'addon_group_ids must be an array' };
  const ids: string[] = [];
  for (const id of rawIds) {
    if (typeof id !== 'string' || !id.trim()) {
      return { error: 'addon_group_ids must contain non-empty string IDs' };
    }
    ids.push(id.trim());
  }

  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length !== ids.length) return { error: 'addon_group_ids must not contain duplicates' };
  if (uniqueIds.length === 0) return { ids: [] };

  const placeholders = uniqueIds.map(() => '?').join(',');
  const activeIds = new Set((db.prepare(
    `SELECT id FROM addon_groups WHERE is_active = 1 AND id IN (${placeholders})`,
  ).all(...uniqueIds) as { id: string }[]).map((row) => row.id));
  const retainedIds = categoryId
    ? new Set((db.prepare(
      `SELECT addon_group_id FROM category_addon_groups
       WHERE category_id = ? AND addon_group_id IN (${placeholders})`,
    ).all(categoryId, ...uniqueIds) as { addon_group_id: string }[]).map((row) => row.addon_group_id))
    : new Set<string>();
  const missingIds = uniqueIds.filter((id) => !activeIds.has(id) && !retainedIds.has(id));
  if (missingIds.length > 0) {
    return { error: `Unknown or inactive addon_group_ids: ${missingIds.join(', ')}` };
  }

  return { ids: uniqueIds };
}

function loadAddonGroupIdsByCategory(db: ReturnType<typeof getDatabase>, categories: { id: string }[]): Map<string, string[]> {
  const categoryIds = [...new Set(categories.map((category) => category.id).filter(Boolean))];
  if (categoryIds.length === 0) return new Map();

  const placeholders = categoryIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT category_id, addon_group_id FROM category_addon_groups
     WHERE category_id IN (${placeholders}) ORDER BY category_id, addon_group_id`,
  ).all(...categoryIds) as { category_id: string; addon_group_id: string }[];
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const ids = result.get(row.category_id) || [];
    ids.push(row.addon_group_id);
    result.set(row.category_id, ids);
  }
  return result;
}

function slugForName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function validateParentCategory(db: ReturnType<typeof getDatabase>, parentId: unknown, categoryId?: string): string | null {
  if (parentId === null || parentId === undefined || parentId === '') return null;
  if (typeof parentId !== 'string') return 'parent_id must be a string or null';
  if (categoryId && parentId === categoryId) return 'Category cannot be its own parent';

  let current = db.prepare('SELECT id, parent_id FROM categories WHERE id = ? AND deleted_at IS NULL AND is_active = 1').get(parentId) as any;
  if (!current) return 'Parent category not found or inactive';

  const seen = new Set<string>();
  while (current?.parent_id) {
    if (categoryId && current.parent_id === categoryId) return 'Category parent cannot create a cycle';
    if (seen.has(current.parent_id)) return 'Category tree already contains a cycle';
    seen.add(current.parent_id);
    current = db.prepare('SELECT id, parent_id FROM categories WHERE id = ? AND deleted_at IS NULL').get(current.parent_id) as any;
  }
  return null;
}

function isDescendantCategory(db: ReturnType<typeof getDatabase>, categoryId: string, possibleDescendantId: string): boolean {
  let current = db.prepare('SELECT parent_id FROM categories WHERE id = ? AND deleted_at IS NULL').get(possibleDescendantId) as any;
  const seen = new Set<string>();
  while (current?.parent_id) {
    if (current.parent_id === categoryId) return true;
    if (seen.has(current.parent_id)) return false;
    seen.add(current.parent_id);
    current = db.prepare('SELECT parent_id FROM categories WHERE id = ? AND deleted_at IS NULL').get(current.parent_id) as any;
  }
  return false;
}

function serializeCategory(category: any): any {
  if (!category) return category;
  return {
    ...category,
    is_active: Boolean(category.is_active),
    children: Array.isArray(category.children) ? category.children.map(serializeCategory) : category.children,
    products: Array.isArray(category.products)
      ? category.products.map((product: any) => ({
          ...product,
          is_active: Boolean(product.is_active),
          track_inventory: Boolean(product.track_inventory),
        }))
      : category.products,
  };
}

router.get('/', requirePermission('catalog.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    let query = 'SELECT * FROM categories WHERE deleted_at IS NULL';
    const params: any[] = [];

    if (req.query.active === 'true' || req.query.active === '1') {
      query += ' AND is_active = 1';
    }
    if (req.query.root === 'true') {
      query += ' AND parent_id IS NULL';
    }
    if (req.query.parent_id) {
      query += ' AND parent_id = ?';
      params.push(req.query.parent_id);
    }

    query += ' ORDER BY sort_order, name';

    const categories = db.prepare(query).all(...params) as any[];

    const childRowsByParent = new Map<string, any[]>();
    if (categories.length > 0) {
      const placeholders = categories.map(() => '?').join(',');
      const children = db.prepare(
        `SELECT * FROM categories
         WHERE parent_id IN (${placeholders}) AND deleted_at IS NULL
         ORDER BY parent_id, sort_order, name`
      ).all(...categories.map((cat) => cat.id)) as any[];
      for (const child of children) {
        const rows = childRowsByParent.get(child.parent_id) || [];
        rows.push(child);
        childRowsByParent.set(child.parent_id, rows);
      }
    }

    const allCategories = [...categories, ...[...childRowsByParent.values()].flat()];
    const addonGroupIdsByCategory = loadAddonGroupIdsByCategory(db, allCategories);

    const categoriesWithChildren = categories.map((cat) => serializeCategory({
      ...cat,
      addon_group_ids: addonGroupIdsByCategory.get(cat.id) || [],
      children: (childRowsByParent.get(cat.id) || []).map((child) => ({
        ...child,
        addon_group_ids: addonGroupIdsByCategory.get(child.id) || [],
      })),
    }));

    res.json({ categories: categoriesWithChildren });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/:id', requirePermission('catalog.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const category = db.prepare('SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as ({ id: string } & Record<string, unknown>) | undefined;
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const children = db.prepare('SELECT * FROM categories WHERE parent_id = ? AND deleted_at IS NULL ORDER BY sort_order, name').all(req.params.id) as ({ id: string } & Record<string, unknown>)[];
    const products = db.prepare('SELECT * FROM products WHERE category_id = ? AND deleted_at IS NULL').all(req.params.id);
    const addonGroupIdsByCategory = loadAddonGroupIdsByCategory(db, [category, ...children]);

    res.json({ category: serializeCategory({
      ...category,
      addon_group_ids: addonGroupIdsByCategory.get(String(req.params.id)) || [],
      children: children.map((child) => ({
        ...child,
        addon_group_ids: addonGroupIdsByCategory.get(child.id) || [],
      })),
      products,
    }) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

function createCategory(req: Request, res: Response) {
  try {
    const { name, description, parent_id, sort_order, is_active, color, icon, addon_group_ids } = req.body;

    const categoryName = normalizeCategoryName(name);
    if (!categoryName) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const db = getDatabase();
    const parentError = validateParentCategory(db, parent_id);
    if (parentError) {
      return res.status(400).json({ error: parentError });
    }

    const addonGroupValidation = validateCategoryAddonGroupIds(db, addon_group_ids);
    if (addonGroupValidation.error) {
      return res.status(400).json({ error: addonGroupValidation.error });
    }

    const slug = slugForName(categoryName);
    const id = generateShortId('categories');
    const insertCategory = db.transaction(() => {
      db.prepare(`
        INSERT INTO categories (id, name, slug, description, parent_id, sort_order, is_active, color, icon, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        categoryName,
        slug,
        normalizeOptionalString(description),
        normalizeOptionalString(parent_id),
        sort_order || 0,
        is_active !== false ? 1 : 0,
        normalizeOptionalString(color),
        normalizeOptionalString(icon),
        now(),
        now()
      );

      if (addonGroupValidation.ids) {
        const insertAddonGroup = db.prepare('INSERT INTO category_addon_groups (category_id, addon_group_id) VALUES (?, ?)');
        for (const addonGroupId of addonGroupValidation.ids) insertAddonGroup.run(id, addonGroupId);
      }
    });
    insertCategory();

    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as Record<string, unknown>;
    res.status(201).json({ category: serializeCategory({ ...category, addon_group_ids: addonGroupValidation.ids || [] }) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

router.post('/', categoryWriteRateLimit, requirePermission('catalog.manage'), createCategory);

function updateCategory(req: Request, res: Response) {
  try {
    const { name, description, parent_id, sort_order, is_active, color, icon, addon_group_ids } = req.body;
    const db = getDatabase();
    const categoryId = String(req.params.id);

    const category = db.prepare('SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL').get(categoryId);
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const hasName = hasOwn(req.body, 'name');
    const categoryName = hasName ? normalizeCategoryName(name) : null;
    if (hasName && !categoryName) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (hasOwn(req.body, 'parent_id')) {
      const parentError = validateParentCategory(db, parent_id, categoryId);
      if (parentError) {
        return res.status(400).json({ error: parentError });
      }
    }

    const addonGroupValidation: { ids?: string[]; error?: string } = hasOwn(req.body, 'addon_group_ids')
      ? validateCategoryAddonGroupIds(db, addon_group_ids, categoryId)
      : {};
    if (addonGroupValidation.error) {
      return res.status(400).json({ error: addonGroupValidation.error });
    }

    const slug = categoryName ? slugForName(categoryName) : (category as any).slug;
    const activeInt = is_active !== undefined ? (is_active ? 1 : 0) : undefined;

    const saveCategory = db.transaction(() => {
      db.prepare(`
        UPDATE categories SET
        name = CASE WHEN @has_name = 1 THEN @name ELSE name END,
        slug = @slug,
        description = CASE WHEN @has_description = 1 THEN @description ELSE description END,
        parent_id = CASE WHEN @has_parent_id = 1 THEN @parent_id ELSE parent_id END,
        sort_order = CASE WHEN @has_sort_order = 1 THEN @sort_order ELSE sort_order END,
        is_active = CASE WHEN @has_is_active = 1 THEN @is_active ELSE is_active END,
        color = CASE WHEN @has_color = 1 THEN @color ELSE color END,
        icon = CASE WHEN @has_icon = 1 THEN @icon ELSE icon END,
        updated_at = @updated_at
        WHERE id = @id
      `).run({
        has_name: hasName ? 1 : 0,
        name: categoryName,
        slug,
        has_description: hasOwn(req.body, 'description') ? 1 : 0,
        description: normalizeOptionalString(description),
        has_parent_id: hasOwn(req.body, 'parent_id') ? 1 : 0,
        parent_id: normalizeOptionalString(parent_id),
        has_sort_order: hasOwn(req.body, 'sort_order') ? 1 : 0,
        sort_order: sort_order ?? null,
        has_is_active: hasOwn(req.body, 'is_active') ? 1 : 0,
        is_active: activeInt ?? null,
        has_color: hasOwn(req.body, 'color') ? 1 : 0,
        color: normalizeOptionalString(color),
        has_icon: hasOwn(req.body, 'icon') ? 1 : 0,
        icon: normalizeOptionalString(icon),
        updated_at: now(),
        id: categoryId,
      });

      if (addonGroupValidation.ids !== undefined) {
        db.prepare('DELETE FROM category_addon_groups WHERE category_id = ?').run(categoryId);
        const insertAddonGroup = db.prepare('INSERT INTO category_addon_groups (category_id, addon_group_id) VALUES (?, ?)');
        for (const addonGroupId of addonGroupValidation.ids) insertAddonGroup.run(categoryId, addonGroupId);
      }
    });
    saveCategory();

    const updated = db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId) as Record<string, unknown>;
    const updatedAddonGroupIds = loadAddonGroupIdsByCategory(db, [{ id: categoryId }]).get(categoryId) || [];
    res.json({ category: serializeCategory({ ...updated, addon_group_ids: updatedAddonGroupIds }) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

router.put('/:id', categoryWriteRateLimit, requirePermission('catalog.manage'), updateCategory);

function deleteCategory(req: Request, res: Response) {
  try {
    const db = getDatabase();
    const categoryId = String(req.params.id);
    const category = db.prepare('SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL').get(categoryId);
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const { action, reassign_to } = req.query as { action?: string; reassign_to?: string };

    const { count: productCount } = db.prepare(
      'SELECT COUNT(*) as count FROM products WHERE category_id = ? AND deleted_at IS NULL'
    ).get(categoryId) as { count: number };

    const { count: childCount } = db.prepare(
      'SELECT COUNT(*) as count FROM categories WHERE parent_id = ? AND deleted_at IS NULL'
    ).get(categoryId) as { count: number };

    if ((productCount > 0 || childCount > 0) && !action) {
      return res.status(400).json({
        error: 'Category has active product(s) or child categories. Choose an action.',
        productCount,
        childCount,
      });
    }

    const deleteCategory = db.transaction(() => {
      if (action === 'reassign') {
        if (!reassign_to) throw new Error('reassign_to is required for reassign action');
        if (reassign_to === categoryId) throw new Error('Cannot reassign a category to itself');
        const targetCategory = db.prepare('SELECT id FROM categories WHERE id = ? AND deleted_at IS NULL').get(reassign_to);
        if (!targetCategory) throw new Error('Target category not found or deleted');
        if (isDescendantCategory(db, categoryId, reassign_to)) {
          throw new Error('Cannot reassign a category to one of its descendants');
        }
        db.prepare('UPDATE products SET category_id = ?, updated_at = ? WHERE category_id = ? AND deleted_at IS NULL')
          .run(reassign_to, now(), categoryId);
        db.prepare('UPDATE categories SET parent_id = ?, updated_at = ? WHERE parent_id = ? AND deleted_at IS NULL')
          .run(reassign_to, now(), categoryId);
      } else if (action === 'delete_all') {
        db.prepare('UPDATE products SET deleted_at = ?, updated_at = ? WHERE category_id = ? AND deleted_at IS NULL')
          .run(now(), now(), categoryId);
        db.prepare('UPDATE categories SET parent_id = NULL, updated_at = ? WHERE parent_id = ? AND deleted_at IS NULL')
          .run(now(), categoryId);
      } else if (!action && productCount === 0 && childCount === 0) {
        // Empty categories have no dependent rows to resolve.
      } else {
        throw new Error('Invalid action. Must be reassign or delete_all.');
      }
      db.prepare('UPDATE categories SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), categoryId);
    });
    try {
      deleteCategory();
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
    res.json({ message: 'Category deleted' });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

router.delete('/:id', categoryWriteRateLimit, requirePermission('catalog.manage'), deleteCategory);

export const categoryRoutes = router;

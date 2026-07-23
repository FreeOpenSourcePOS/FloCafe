import { Router, Request, Response } from 'express';
import { getDatabase, now, generateShortId } from '../db';
import { requireRole } from '../middleware/security';

const router = Router();

router.get('/', (req: Request, res: Response) => {
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

    const categories = db.prepare(query).all(...params);

    // Load children for each category
    const categoriesWithChildren = categories.map((cat: any) => {
      const children = db.prepare('SELECT * FROM categories WHERE parent_id = ? AND deleted_at IS NULL ORDER BY sort_order, name').all(cat.id);
      return { ...cat, children };
    });

    res.json({ categories: categoriesWithChildren });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const category = db.prepare('SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const children = db.prepare('SELECT * FROM categories WHERE parent_id = ? AND deleted_at IS NULL ORDER BY sort_order, name').all(req.params.id);
    const products = db.prepare('SELECT * FROM products WHERE category_id = ? AND deleted_at IS NULL').all(req.params.id);

    res.json({ category: { ...category, children, products } });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { name, description, parent_id, sort_order, is_active, color, icon } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    const db = getDatabase();
    const id = generateShortId('categories');
    db.prepare(`
      INSERT INTO categories (id, name, slug, description, parent_id, sort_order, is_active, color, icon, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, slug, description || null, parent_id || null, sort_order || 0, is_active !== false ? 1 : 0, color || null, icon || null, now(), now());

    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    res.status(201).json({ category });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { name, description, parent_id, sort_order, is_active, color, icon } = req.body;
    const db = getDatabase();

    const category = db.prepare('SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const slug = name ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') : (category as any).slug;

    const activeInt = is_active !== undefined ? (is_active ? 1 : 0) : undefined;

    db.prepare(`
      UPDATE categories SET name = COALESCE(?, name), slug = ?, description = COALESCE(?, description),
      parent_id = COALESCE(?, parent_id), sort_order = COALESCE(?, sort_order),
      is_active = COALESCE(?, is_active), color = COALESCE(?, color), icon = COALESCE(?, icon),
      updated_at = ?
      WHERE id = ?
    `).run(name, slug, description, parent_id, sort_order, activeInt, color, icon, now(), req.params.id);

    const updated = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    res.json({ category: updated });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const category = db.prepare('SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const { action, reassign_to } = req.query as { action?: string; reassign_to?: string };

    const { count: productCount } = db.prepare(
      'SELECT COUNT(*) as count FROM products WHERE category_id = ? AND deleted_at IS NULL'
    ).get(req.params.id) as { count: number };

    if (productCount > 0 && !action) {
      return res.status(400).json({
        error: `Category has ${productCount} active product(s). Choose an action.`,
        productCount,
      });
    }

    if (action === 'reassign') {
      if (!reassign_to) {
        return res.status(400).json({ error: 'reassign_to is required for reassign action' });
      }
      const targetCategory = db.prepare('SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL').get(reassign_to);
      if (!targetCategory) {
        return res.status(400).json({ error: 'Target category not found or deleted' });
      }
      db.prepare('UPDATE products SET category_id = ?, updated_at = ? WHERE category_id = ? AND deleted_at IS NULL')
        .run(reassign_to, now(), req.params.id);
    } else if (action === 'delete_all') {
      db.prepare('UPDATE products SET deleted_at = ?, updated_at = ? WHERE category_id = ? AND deleted_at IS NULL')
        .run(now(), now(), req.params.id);
    } else {
      return res.status(400).json({ error: 'Invalid action. Must be reassign or delete_all.' });
    }

    // Soft delete the category
    db.prepare('UPDATE categories SET deleted_at = ? WHERE id = ?').run(now(), req.params.id);
    res.json({ message: 'Category deleted' });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export const categoryRoutes = router;
import { Router, Request, Response } from 'express';
import { getDatabase, now, withTxn } from '../db';
import { randomUUID } from 'crypto';
import { requireRole } from '../middleware/security';

const router = Router();

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

router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const groups = db.prepare('SELECT * FROM addon_groups WHERE is_active = 1 ORDER BY sort_order, name').all();

    const groupsWithAddons = groups.map((group: any) => {
      const addons = db.prepare('SELECT * FROM addons WHERE addon_group_id = ? AND is_active = 1 ORDER BY sort_order, name').all(group.id);
      return { ...group, addons };
    });

    res.json({ addon_groups: groupsWithAddons });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const group = db.prepare('SELECT * FROM addon_groups WHERE id = ?').get(req.params.id);
    if (!group) {
      return res.status(404).json({ error: 'Addon group not found' });
    }

    const addons = db.prepare('SELECT * FROM addons WHERE addon_group_id = ? ORDER BY sort_order, name').all(req.params.id);
    res.json({ addon_group: { ...group, addons } });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { name, description, is_required, min_selection, max_selection, sort_order, addons } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const min = min_selection ?? 0;
    const max = max_selection ?? 1;
    const activeAddonCount = Array.isArray(addons) ? addons.filter((a: any) => a.is_active !== false).length : 0;
    const boundsError = validateSelectionBounds(min, max, activeAddonCount);
    if (boundsError) {
      return res.status(400).json({ errors: boundsError });
    }

    const db = getDatabase();
    const groupId = randomUUID();
    const { group, groupAddons } = withTxn(() => {
      db.prepare(`
        INSERT INTO addon_groups (id, name, description, is_required, min_selection, max_selection, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        groupId, name, description || null, is_required ? 1 : 0, min_selection || 0, max_selection || 1, sort_order || 0, now(), now()
      );

      if (addons && addons.length > 0) {
        const insertAddon = db.prepare('INSERT INTO addons (id, addon_group_id, name, price, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
        addons.forEach((addon: any, index: number) => {
          insertAddon.run(randomUUID(), groupId, addon.name, addon.price || 0, index, now(), now());
        });
      }

      return {
        group: db.prepare('SELECT * FROM addon_groups WHERE id = ?').get(groupId),
        groupAddons: db.prepare('SELECT * FROM addons WHERE addon_group_id = ?').all(groupId),
      };
    });

    res.status(201).json({ addon_group: Object.assign({}, group, { addons: groupAddons }) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const group = db.prepare('SELECT * FROM addon_groups WHERE id = ?').get(req.params.id);
    if (!group) {
      return res.status(404).json({ error: 'Addon group not found' });
    }

    const { name, description, is_required, min_selection, max_selection, sort_order, is_active, addons } = req.body;

    const effectiveMin = min_selection ?? (group as any).min_selection;
    const effectiveMax = max_selection ?? (group as any).max_selection;
    const activeAddonCount = Array.isArray(addons)
      ? addons.filter((a: any) => a.is_active !== false).length
      : (db.prepare('SELECT COUNT(*) as count FROM addons WHERE addon_group_id = ? AND is_active = 1').get(req.params.id) as { count: number }).count;
    const boundsError = validateSelectionBounds(effectiveMin, effectiveMax, activeAddonCount);
    if (boundsError) {
      return res.status(400).json({ errors: boundsError });
    }

    const { updated, updatedAddons } = withTxn(() => {
      db.prepare(`
        UPDATE addon_groups SET name = COALESCE(?, name), description = COALESCE(?, description),
          is_required = COALESCE(?, is_required), min_selection = COALESCE(?, min_selection),
          max_selection = COALESCE(?, max_selection), sort_order = COALESCE(?, sort_order),
          is_active = COALESCE(?, is_active), updated_at = ?
        WHERE id = ?
      `).run(name, description, is_required, min_selection, max_selection, sort_order, is_active, now(), req.params.id);

      if (Array.isArray(addons)) {
        db.prepare('DELETE FROM addons WHERE addon_group_id = ?').run(req.params.id);
        const insertAddon = db.prepare('INSERT INTO addons (id, addon_group_id, name, price, is_active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        addons.forEach((addon: any, index: number) => {
          insertAddon.run(randomUUID(), req.params.id, addon.name, addon.price ?? 0, addon.is_active !== false ? 1 : 0, index, now(), now());
        });
      }

      return {
        updated: db.prepare('SELECT * FROM addon_groups WHERE id = ?').get(req.params.id),
        updatedAddons: db.prepare('SELECT * FROM addons WHERE addon_group_id = ?').all(req.params.id),
      };
    });

    res.json({ addon_group: Object.assign({}, updated, { addons: updatedAddons }) });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
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
router.post('/:groupId/addons', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { name, price, is_active, sort_order } = req.body;

    if (!name || price === undefined) {
      return res.status(400).json({ error: 'Name and price are required' });
    }

    const db = getDatabase();
    const group = db.prepare('SELECT * FROM addon_groups WHERE id = ?').get(req.params.groupId);
    if (!group) {
      return res.status(404).json({ error: 'Addon group not found' });
    }

    const addonId = randomUUID();
    db.prepare('INSERT INTO addons (id, addon_group_id, name, price, is_active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(addonId, req.params.groupId, name, price, is_active !== false ? 1 : 0, sort_order || 0, now(), now());

    const addon = db.prepare('SELECT * FROM addons WHERE id = ?').get(addonId);
    res.status(201).json({ addon });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put('/:groupId/addons/:addonId', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { name, price, is_active, sort_order } = req.body;

    const db = getDatabase();
    const addon = db.prepare('SELECT * FROM addons WHERE id = ? AND addon_group_id = ?').get(req.params.addonId, req.params.groupId) as { is_active: number } | undefined;
    if (!addon) {
      return res.status(404).json({ error: 'Addon not found' });
    }

    if (is_active === false && addon.is_active) {
      const boundsError = wouldBreakMinSelection(db, req.params.groupId, req.params.addonId);
      if (boundsError) {
        return res.status(400).json({ errors: boundsError });
      }
    }

    db.prepare(`
      UPDATE addons SET name = COALESCE(?, name), price = COALESCE(?, price),
        is_active = COALESCE(?, is_active), sort_order = COALESCE(?, sort_order)
      WHERE id = ?
    `).run(name, price, is_active, sort_order, req.params.addonId);

    const updated = db.prepare('SELECT * FROM addons WHERE id = ?').get(req.params.addonId);
    res.json({ addon: updated });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete('/:groupId/addons/:addonId', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const addon = db.prepare('SELECT * FROM addons WHERE id = ? AND addon_group_id = ?').get(req.params.addonId, req.params.groupId) as { is_active: number } | undefined;
    if (!addon) {
      return res.status(404).json({ error: 'Addon not found' });
    }

    if (addon.is_active) {
      const boundsError = wouldBreakMinSelection(db, req.params.groupId, req.params.addonId);
      if (boundsError) {
        return res.status(400).json({ errors: boundsError });
      }
    }

    db.prepare('UPDATE addons SET is_active = 0, updated_at = ? WHERE id = ?').run(now(), req.params.addonId);
    res.json({ message: 'Addon deleted' });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export const addonGroupRoutes = router;
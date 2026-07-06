import { Router, Request, Response } from 'express';
import { getDatabase, now } from '../db';
import { randomUUID } from 'crypto';
import { requireRole } from '../middleware/security';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    let query = 'SELECT * FROM tables WHERE 1=1';
    const params: any[] = [];

    if (req.query.status) {
      query += ' AND status = ?';
      params.push(req.query.status);
    }
    if (req.query.floor) {
      query += ' AND floor = ?';
      params.push(req.query.floor);
    }
    if (req.query.section) {
      query += ' AND section = ?';
      params.push(req.query.section);
    }
    if (req.query.kitchen_station_id) {
      query += ' AND kitchen_station_id = ?';
      params.push(req.query.kitchen_station_id);
    }

    query += ' ORDER BY number';

    const rows = db.prepare(query).all(...params);
    // Normalize: frontend expects `name`, schema column is `number`
    const tables = rows.map((t: any) => ({ ...t, name: t.number }));
    res.json({ tables });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
    if (!table) {
      return res.status(404).json({ error: 'Table not found' });
    }

    const activeOrder = db.prepare(`
      SELECT * FROM orders WHERE table_id = ? AND status NOT IN ('completed', 'cancelled')
      ORDER BY created_at DESC LIMIT 1
    `).get(req.params.id);

    // Normalize: frontend expects `name`, schema column is `number`
    res.json({ table: { ...(table as any), name: (table as any).number, activeOrder } });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    // Accept `number` (schema column) or `name` (legacy frontend field)
    const { number, name, capacity, floor, section, position_x, position_y, kitchen_station_id } = req.body;
    const tableNumber = number || name;

    if (!tableNumber) {
      return res.status(400).json({ error: 'Table number is required' });
    }

    const db = getDatabase();
    const tableId = `tbl-${randomUUID().slice(0, 8)}`;
    const result = db.prepare(`
      INSERT INTO tables (id, number, capacity, floor, section, position_x, position_y, kitchen_station_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tableId, tableNumber, capacity || 4, floor || null, section || null,
      position_x || null, position_y || null, kitchen_station_id || null, now(), now()
    );

    const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(tableId);
    res.status(201).json({ table });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { number, name, capacity, floor, section, position_x, position_y, kitchen_station_id } = req.body;
    const tableNumber = number || name;
    const db = getDatabase();

    const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
    if (!table) {
      return res.status(404).json({ error: 'Table not found' });
    }

    db.prepare(`
      UPDATE tables SET
        number = COALESCE(?, number),
        capacity = COALESCE(?, capacity),
        floor = COALESCE(?, floor),
        section = COALESCE(?, section),
        position_x = COALESCE(?, position_x),
        position_y = COALESCE(?, position_y),
        kitchen_station_id = COALESCE(?, kitchen_station_id),
        updated_at = ?
      WHERE id = ?
    `).run(tableNumber, capacity, floor, section, position_x, position_y, kitchen_station_id, now(), req.params.id);

    const updated = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
    res.json({ table: updated });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
    if (!table) {
      return res.status(404).json({ error: 'Table not found' });
    }

    const activeOrder = db.prepare(`
      SELECT * FROM orders WHERE table_id = ? AND status NOT IN ('completed', 'cancelled')
    `).get(req.params.id);
    if (activeOrder) {
      return res.status(400).json({ error: 'Cannot delete table with active orders' });
    }

    db.prepare('DELETE FROM tables WHERE id = ?').run(req.params.id);
    res.json({ message: 'Table deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/:id/status', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const validStatuses = ['available', 'occupied', 'reserved', 'cleaning'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Use: ${validStatuses.join(', ')}` });
    }

    const db = getDatabase();
    const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
    if (!table) {
      return res.status(404).json({ error: 'Table not found' });
    }

    db.prepare('UPDATE tables SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now(), req.params.id);

    const updated = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
    res.json({ table: updated });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export const tableRoutes = router;

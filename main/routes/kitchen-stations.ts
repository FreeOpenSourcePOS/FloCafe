import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase, now } from '../db';
import { requireRole } from '../middleware/security';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    let query = 'SELECT * FROM kitchen_stations WHERE is_active = 1';
    const params: any[] = [];

    query += ' ORDER BY sort_order, name';

    const stations = db.prepare(query).all(...params);
    res.json({ kitchenStations: stations });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const station = db.prepare('SELECT * FROM kitchen_stations WHERE id = ?').get(req.params.id);
    if (!station) {
      return res.status(404).json({ error: 'Kitchen station not found' });
    }

    const tables = db.prepare('SELECT * FROM tables WHERE kitchen_station_id = ?').all(req.params.id);
    const users = db.prepare(`
      SELECT u.id, u.name, u.role FROM station_users su
      JOIN users u ON u.id = su.user_id
      WHERE su.station_id = ?
    `).all(req.params.id);
    const printer = (station as any).printer_id
      ? db.prepare('SELECT * FROM printers WHERE id = ?').get((station as any).printer_id)
      : null;
    res.json({ kitchenStation: { ...station, tables, users, printer } });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { name, description, category_ids, printer_id, printer_ip, printer_port, printer_name, sort_order } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const db = getDatabase();

    if (printer_id) {
      const printer = db.prepare('SELECT id FROM printers WHERE id = ?').get(printer_id);
      if (!printer) return res.status(400).json({ error: 'printer_id does not match an existing printer' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO kitchen_stations (id, name, description, category_ids, printer_id, printer_ip, printer_port, printer_name, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, description || null,
      category_ids ? JSON.stringify(category_ids) : null,
      printer_id || null,
      printer_ip || null, printer_port || 9100, printer_name || null,
      sort_order || 0, now(), now()
    );

    const station = db.prepare('SELECT * FROM kitchen_stations WHERE id = ?').get(id);
    res.status(201).json({ kitchenStation: station });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { name, description, category_ids, printer_id, printer_ip, printer_port, printer_name, sort_order, is_active } = req.body;
    const db = getDatabase();

    const station = db.prepare('SELECT * FROM kitchen_stations WHERE id = ?').get(req.params.id);
    if (!station) {
      return res.status(404).json({ error: 'Kitchen station not found' });
    }

    if (printer_id) {
      const printer = db.prepare('SELECT id FROM printers WHERE id = ?').get(printer_id);
      if (!printer) return res.status(400).json({ error: 'printer_id does not match an existing printer' });
    }

    db.prepare(`
      UPDATE kitchen_stations SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        category_ids = COALESCE(?, category_ids),
        printer_id = COALESCE(?, printer_id),
        printer_ip = COALESCE(?, printer_ip),
        printer_port = COALESCE(?, printer_port),
        printer_name = COALESCE(?, printer_name),
        sort_order = COALESCE(?, sort_order),
        is_active = COALESCE(?, is_active),
        updated_at = ?
      WHERE id = ?
    `).run(
      name, description,
      category_ids ? JSON.stringify(category_ids) : null,
      printer_id, printer_ip, printer_port, printer_name, sort_order, is_active,
      now(), req.params.id
    );

    const updated = db.prepare('SELECT * FROM kitchen_stations WHERE id = ?').get(req.params.id);
    res.json({ kitchenStation: updated });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /api/kitchen-stations/:id/users — replace the full set of staff logins assigned to this station
router.put('/:id/users', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const { user_ids } = req.body;
    if (!Array.isArray(user_ids)) {
      return res.status(400).json({ error: 'user_ids must be an array' });
    }

    const db = getDatabase();
    const station = db.prepare('SELECT id FROM kitchen_stations WHERE id = ?').get(req.params.id);
    if (!station) {
      return res.status(404).json({ error: 'Kitchen station not found' });
    }

    if (user_ids.length > 0) {
      const placeholders = user_ids.map(() => '?').join(',');
      const found = db.prepare(`SELECT id FROM users WHERE id IN (${placeholders})`).all(...user_ids) as { id: string }[];
      if (found.length !== user_ids.length) {
        return res.status(400).json({ error: 'One or more user_ids do not match an existing user' });
      }
    }

    const applyAssignments = db.transaction((ids: string[]) => {
      db.prepare('DELETE FROM station_users WHERE station_id = ?').run(req.params.id);
      const insert = db.prepare('INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, ?)');
      for (const userId of ids) {
        insert.run(userId, req.params.id, now());
      }
    });
    applyAssignments(user_ids);

    const users = db.prepare(`
      SELECT u.id, u.name, u.role FROM station_users su
      JOIN users u ON u.id = su.user_id
      WHERE su.station_id = ?
    `).all(req.params.id);
    res.json({ users });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const station = db.prepare('SELECT * FROM kitchen_stations WHERE id = ?').get(req.params.id);
    if (!station) {
      return res.status(404).json({ error: 'Kitchen station not found' });
    }

    const assignedTables = db.prepare('SELECT * FROM tables WHERE kitchen_station_id = ?').all(req.params.id);
    if (assignedTables.length > 0) {
      return res.status(400).json({ error: 'Cannot delete station with assigned tables' });
    }

    db.prepare('UPDATE kitchen_stations SET is_active = 0, updated_at = ? WHERE id = ?').run(now(), req.params.id);
    res.json({ message: 'Kitchen station deleted' });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export const kitchenStationRoutes = router;

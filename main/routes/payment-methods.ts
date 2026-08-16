import { Router, Request, Response } from 'express';
import { getDatabase, now, withTxn } from '../db';
import { requireRole } from '../middleware/security';
import { sendEvent } from '../services/telemetry';

const router = Router();

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') throw Object.assign(new Error('Name is required'), { statusCode: 400 });
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60) throw Object.assign(new Error('Name must be between 1 and 60 characters'), { statusCode: 400 });
  if (['cash', 'card', 'loyalty', 'loyalty wallet', 'wallet'].includes(name.toLowerCase())) {
    throw Object.assign(new Error('That name is reserved by a built-in payment method'), { statusCode: 409 });
  }
  return name;
}

function countUsage(id: number): number {
  const row = getDatabase().prepare(`
    SELECT COUNT(*) AS count FROM bills b, json_each(CASE
      WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array' THEN b.payment_details
      WHEN json_valid(b.payment_details) THEN json_array(b.payment_details)
      ELSE '[]' END) je
    WHERE CAST(json_extract(je.value, '$.payment_method_id') AS INTEGER) = ?
  `).get(id) as { count: number };
  return Number(row.count || 0);
}

function list(includeInactive = false) {
  const rows = getDatabase().prepare(`SELECT * FROM payment_methods ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY sort_order, id`).all() as any[];
  return rows.map((row) => ({ ...row, is_active: Boolean(row.is_active), ...(includeInactive ? { usage_count: countUsage(row.id) } : {}) }));
}

router.get('/merge-history', requireRole('owner', 'manager'), (_req, res) => {
  res.json({ merges: getDatabase().prepare('SELECT * FROM payment_method_merges ORDER BY merged_at DESC, id DESC LIMIT 30').all() });
});

router.get('/', requireRole('owner', 'manager', 'cashier', 'server', 'chef'), (req: Request, res: Response) => {
  const includeInactive = req.query.include_inactive === 'true' && ['owner', 'manager'].includes((req as any).user.role);
  res.json({ payment_methods: list(includeInactive) });
});

router.post('/', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const name = normalizeName(req.body?.name);
    const db = getDatabase();
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM payment_methods').get() as { n: number };
    const result = db.prepare('INSERT INTO payment_methods (name, is_active, sort_order, created_at, updated_at) VALUES (?, 1, ?, ?, ?)')
      .run(name, Number(max.n) + 10, now(), now());
    void sendEvent('feature_used', { feature: 'custom_payment_methods', action: 'added' });
    res.status(201).json({ payment_method: list(true).find((row) => row.id === Number(result.lastInsertRowid)) });
  } catch (error: any) {
    const duplicate = String(error.message || '').includes('UNIQUE constraint');
    res.status(duplicate ? 409 : error.statusCode || 500).json({ error: duplicate ? 'A payment method with this name already exists' : error.message || 'Unable to add payment method' });
  }
});

router.put('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const db = getDatabase();
    const current = db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(id) as any;
    if (!current) return res.status(404).json({ error: 'Payment method not found' });
    const name = req.body?.name === undefined ? current.name : normalizeName(req.body.name);
    const active = req.body?.is_active === undefined ? current.is_active : req.body.is_active ? 1 : 0;
    const order = req.body?.sort_order === undefined ? current.sort_order : Number(req.body.sort_order);
    if (!Number.isSafeInteger(order) || order < 0) return res.status(400).json({ error: 'Invalid sort order' });
    db.prepare('UPDATE payment_methods SET name = ?, is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?')
      .run(name, active, order, now(), id);
    if (active !== current.is_active) void sendEvent('feature_used', { feature: 'custom_payment_methods', action: active ? 'enabled' : 'disabled' });
    res.json({ payment_method: list(true).find((row) => row.id === id) });
  } catch (error: any) {
    const duplicate = String(error.message || '').includes('UNIQUE constraint');
    res.status(duplicate ? 409 : error.statusCode || 500).json({ error: duplicate ? 'A payment method with this name already exists' : error.message || 'Unable to update payment method' });
  }
});

router.delete('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const db = getDatabase();
  if (!db.prepare('SELECT 1 FROM payment_methods WHERE id = ?').get(id)) return res.status(404).json({ error: 'Payment method not found' });
  const used = countUsage(id);
  if (used) return res.status(409).json({ error: `This method has ${used} recorded payment${used === 1 ? '' : 's'}. Disable or merge it instead.` });
  db.prepare('DELETE FROM payment_methods WHERE id = ?').run(id);
  res.json({ success: true });
});

router.post('/:id/merge', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const sourceId = Number(req.params.id);
    const targetType = req.body?.target_type === 'card' ? 'card' : 'custom';
    const targetId = targetType === 'custom' ? Number(req.body?.target_id) : null;
    if (!Number.isSafeInteger(sourceId) || (targetType === 'custom' && (!Number.isSafeInteger(targetId) || sourceId === targetId))) {
      return res.status(400).json({ error: 'Choose a different merge target' });
    }
    const result = withTxn(() => {
      const db = getDatabase();
      const source = db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(sourceId) as any;
      const target = targetType === 'card' ? null : db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(targetId) as any;
      if (!source || (targetType === 'custom' && !target)) throw Object.assign(new Error('Payment method not found'), { statusCode: 404 });
      const targetName = targetType === 'card' ? 'Card' : target.name;
      const rows = db.prepare('SELECT id, payment_details FROM bills WHERE payment_details IS NOT NULL').all() as any[];
      const update = db.prepare('UPDATE bills SET payment_details = ?, updated_at = ? WHERE id = ?');
      let affected = 0;
      for (const row of rows) {
        let parsed: any;
        try { parsed = JSON.parse(row.payment_details); } catch { continue; }
        const lines = Array.isArray(parsed) ? parsed : [parsed];
        let changed = false;
        for (const line of lines) {
          if (Number(line?.payment_method_id) !== sourceId) continue;
          line.method = targetName;
          if (targetType === 'card') delete line.payment_method_id;
          else line.payment_method_id = targetId;
          affected++;
          changed = true;
        }
        if (changed) update.run(JSON.stringify(Array.isArray(parsed) ? lines : lines[0]), now(), row.id);
      }
      const sourceKey = `custom:${sourceId}`;
      const targetKey = targetType === 'card' ? 'card' : `custom:${targetId}`;
      const collision = db.prepare(`SELECT 1 FROM payment_transaction_refs s JOIN payment_transaction_refs t ON t.method = ? AND t.transaction_id = s.transaction_id WHERE s.method = ? LIMIT 1`).get(targetKey, sourceKey);
      if (collision) throw Object.assign(new Error('The methods contain the same transaction reference and cannot be merged automatically'), { statusCode: 409 });
      db.prepare('UPDATE payment_transaction_refs SET method = ? WHERE method = ?').run(targetKey, sourceKey);
      db.prepare('INSERT INTO payment_method_merges (source_name, target_name, affected_payments, merged_at) VALUES (?, ?, ?, ?)')
        .run(source.name, targetName, affected, now());
      db.prepare('DELETE FROM payment_methods WHERE id = ?').run(sourceId);
      return { source_name: source.name, target_name: targetName, affected_payments: affected };
    });
    res.json({ merge: result, payment_methods: list(true) });
    void sendEvent('feature_used', { feature: 'custom_payment_methods', action: 'merged' });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to merge payment methods' });
  }
});

export { router as paymentMethodRoutes };

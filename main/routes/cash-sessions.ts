/**
 * Cash sessions / shift lifecycle (issue #279, approach A).
 *
 * Open state lives in `cash_sessions`; closes persist as `cash_closures`
 * rows with scope='session' (the extension door documented in
 * main/routes/cash-closures.ts). Day close is untouched.
 *
 * Session attribution is raw timestamp windows (opened_at → now), so
 * sessions crossing midnight work. The opening float lives on the session
 * row and is mirrored as the day's opening_float movement (once per day)
 * so day close reconciles the same drawer; session math excludes in-window
 * float movements and cannot double-count.
 */
import { Router, Request, Response } from 'express';
import {
  getDatabase, getSettingValue, localDateInTimezone, now, withTxn,
  tenantBusinessDayStartTime, nextZNumber,
} from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import {
  getOpenSession, type CashSessionRow,
} from '../services/shift-session-gate';
import {
  computePeriodAggregates, expectedCashFromAggregates, expectedCashForWindow,
  listCashDrawerMovementsInWindow, tenantTimezone,
} from './cash-closures';

const router = Router();

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

function errorStatus(error: unknown): number {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return 500;
  return typeof error.statusCode === 'number' ? error.statusCode || 500 : 500;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message || fallback;
  return fallback;
}

function validateCents(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw httpError(`${field} must be an integer number of cents >= 0`, 400);
  }
  return raw;
}

// req.user is attached by the auth middleware, which has no typed declaration.
// Exported so cash-closures.ts can reuse it instead of adding another cast.
export interface AuthedRequest extends Request { user?: { userId: string; role: string } }

function actorId(req: AuthedRequest): string {
  const id = String(req.user?.userId || '');
  if (!id) throw httpError('Authentication required', 401);
  return id;
}

function actorRole(req: AuthedRequest): string {
  return String(req.user?.role || '');
}

function daysAgoUtc(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().replace('T', ' ').replace(/\..*$/, '');
}

/**
 * Shared close transaction used by the close endpoint and by stale
 * auto-close on open. Computes window aggregates, writes the
 * scope='session' closure row, and marks the session closed.
 * Human closes are blocked by unpaid in-window bills; system auto-close
 * skips that guard (cleanup path — the bills stay for day close).
 */
function closeSessionTxn(
  db: ReturnType<typeof getDatabase>,
  session: CashSessionRow,
  countedCashCents: number,
  closerId: string,
  notes: string | null,
  skipUnpaidBlock = false,
): { closure_id: number; variance_cents: number; expected_cash_cents: number; counted_cash_cents: number } {
  const closedAt = now();
  if (!skipUnpaidBlock) {
    // 'partial' counts: a short tender leaves an outstanding balance
    // (bills.ts settles to 'paid' only at zero balance).
    const unpaid = db.prepare(
      `SELECT COUNT(*) AS c FROM bills WHERE payment_status NOT IN ('paid', 'refunded', 'partially_refunded') AND created_at >= ? AND created_at < ?`,
    ).get(session.opened_at, closedAt) as { c: number };
    if (Number(unpaid.c) > 0) {
      throw httpError(`Cannot close: ${unpaid.c} unpaid bill(s) in this shift`, 409);
    }
  }
  const aggregates = computePeriodAggregates(
    db, session.opened_at, closedAt,
    listCashDrawerMovementsInWindow(db, session.opened_at, closedAt, false),
    Number(session.opening_float_cents || 0),
  );
  const expectedCashCents = expectedCashFromAggregates(aggregates);
  const varianceCents = countedCashCents - expectedCashCents;
  let zNumber: number;
  try {
    zNumber = nextZNumber();
  } catch (err: unknown) {
    throw httpError(`Could not allocate Z number: ${errorMessage(err, 'sequence failure')}`, 500);
  }
  const businessDate = localDateInTimezone(new Date(), tenantTimezone(), tenantBusinessDayStartTime(db));
  const insert = db.prepare(`
    INSERT INTO cash_closures (
      scope, business_date, period_start, period_end,
      opening_float_cents, expected_cash_cents, counted_cash_cents, variance_cents,
      gross_collected_cents, refunded_cents, net_collected_cents,
      bill_count, refund_count,
      payment_methods_json, staff_sales_json, tax_components_json,
      pay_in_cents, pay_out_cents, safe_drop_cents, cash_movements_json,
      z_number, closed_by, notes, created_at
    ) VALUES (
      'session', ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `).run(
    businessDate, session.opened_at, closedAt,
    Number(session.opening_float_cents || 0), expectedCashCents, countedCashCents, varianceCents,
    aggregates.grossCollectedCents, aggregates.refundedCents, aggregates.netCollectedCents,
    aggregates.billCount, aggregates.refundCount,
    JSON.stringify(aggregates.paymentMethods),
    JSON.stringify(aggregates.staffSales),
    JSON.stringify(aggregates.taxComponents),
    aggregates.payInCents, aggregates.payOutCents, aggregates.safeDropCents,
    JSON.stringify(aggregates.cashMovements),
    zNumber, closerId, notes, closedAt,
  );
  const closureId = Number(insert.lastInsertRowid);
  db.prepare(`UPDATE cash_sessions SET status = 'closed', closed_at = ?, closed_by = ?, closure_id = ? WHERE id = ?`)
    .run(closedAt, closerId, closureId, session.id);
  return { closure_id: closureId, variance_cents: varianceCents, expected_cash_cents: expectedCashCents, counted_cash_cents: countedCashCents };
}

router.post('/open', requireRole(...ROLE_ACCESS.ownerManagerCashier), (req: Request, res: Response) => {
  try {
    const openingFloatCents = validateCents((req.body || {}).opening_float_cents ?? 0, 'opening_float_cents');
    const db = getDatabase();
    const openedBy = actorId(req);
    const openedByRow = db.prepare(`SELECT name FROM users WHERE id = ?`).get(openedBy) as { name: string } | undefined;
    const result = withTxn(() => {
      // Stale auto-close: an open session older than the threshold with no
      // store activity since is system-closed (zero count, flagged) so a new
      // shift can open. Matches Square's stale-drawer rule.
      const thresholdDays = Math.max(1, parseInt(getSettingValue('stale_session_days') || '7', 10) || 7);
      const cutoff = daysAgoUtc(thresholdDays);
      const stale = db.prepare(`SELECT * FROM cash_sessions WHERE status = 'open' AND opened_at < ?`).all(cutoff) as CashSessionRow[];
      if (stale.length > 0) {
        const activity = db.prepare(
          `SELECT (SELECT COUNT(*) FROM bills WHERE paid_at >= ?) + (SELECT COUNT(*) FROM cash_drawer_movements WHERE created_at >= ?) AS c`,
        ).get(cutoff, cutoff) as { c: number };
        if (Number(activity.c) === 0) {
          for (const s of stale) {
            closeSessionTxn(db, s, 0, openedBy, 'System auto-close: stale session, flagged for manager review', true);
          }
        }
      }
      if (getOpenSession(db)) throw httpError('A shift is already open', 409);
      const openedAt = now();
      const insert = db.prepare(`
        INSERT INTO cash_sessions (opened_by, opened_by_name, opened_at, opening_float_cents, status)
        VALUES (?, ?, ?, ?, 'open')
      `).run(openedBy, openedByRow?.name ?? openedBy, openedAt, openingFloatCents);
      // Keep day close reconciling the same physical drawer: mirror the
      // float as the day's opening_float movement. Session math ignores
      // in-window float movements (openingFloatOverride), so this cannot
      // double-count there. One movement per day (schema constraint): a
      // second shift reuses the first float for day-close purposes.
      if (openingFloatCents > 0) {
        const openBusinessDate = localDateInTimezone(new Date(), tenantTimezone(), tenantBusinessDayStartTime(db));
        const existingFloat = db.prepare(
          `SELECT id FROM cash_drawer_movements WHERE business_date = ? AND movement_type = 'opening_float' AND voided_at IS NULL LIMIT 1`,
        ).get(openBusinessDate);
        if (!existingFloat) {
          db.prepare(`
            INSERT INTO cash_drawer_movements (
              business_date, movement_type, amount_cents, reason, created_by, created_at
            ) VALUES (?, 'opening_float', ?, 'Shift opening float', ?, ?)
          `).run(openBusinessDate, openingFloatCents, openedBy, openedAt);
        }
      }
      return db.prepare(`SELECT * FROM cash_sessions WHERE id = ?`).get(Number(insert.lastInsertRowid));
    });
    res.json(result);
  } catch (error: unknown) {
    const status = errorStatus(error);
    res.status(status).json({ error: status >= 500 ? 'Failed to open shift' : errorMessage(error, 'Failed to open shift') });
  }
});

router.get('/current', requireRole(...ROLE_ACCESS.ownerManagerCashier), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const session = getOpenSession(db);
    if (!session) return res.status(404).json({ error: 'No open shift' });
    // Single timestamp for the whole snapshot: now() has second granularity,
    // so two evaluations could straddle a second boundary and disagree.
    // Lightweight path: the snapshot only needs expected cash, none of the
    // display sections (payment breakdown, staff sales, tax hydration).
    const asOf = now();
    const expectedCashCents = expectedCashForWindow(
      db, session.opened_at, asOf,
      listCashDrawerMovementsInWindow(db, session.opened_at, asOf, false),
      Number(session.opening_float_cents || 0),
    );
    res.json({ ...session, expected_cash_cents: expectedCashCents });
  } catch (error: unknown) {
    const status = errorStatus(error);
    res.status(status).json({ error: status >= 500 ? 'Failed to read current shift' : errorMessage(error, 'Failed to read current shift') });
  }
});

router.post('/:id/close', requireRole(...ROLE_ACCESS.ownerManagerCashier), (req: Request, res: Response) => {
  try {
    const sessionId = Number(req.params.id);
    if (!Number.isInteger(sessionId)) throw httpError('Invalid session id', 400);
    const countedCashCents = validateCents((req.body || {}).counted_cash_cents, 'counted_cash_cents');
    const notes = typeof (req.body || {}).notes === 'string' ? (req.body.notes as string).slice(0, 500) : null;
    const db = getDatabase();
    const closer = actorId(req);
    const role = actorRole(req);
    const result = withTxn(() => {
      const session = db.prepare(`SELECT * FROM cash_sessions WHERE id = ?`).get(sessionId) as CashSessionRow | undefined;
      if (!session) throw httpError('Shift not found', 404);
      if (session.status !== 'open') throw httpError('Shift is already closed', 409);
      // Own-session rule: cashiers close only the shift they opened;
      // manager/owner may force-close anyone's (recorded via closed_by).
      if (role === 'cashier' && session.opened_by !== closer) {
        throw httpError('Cashiers can only close their own shift', 403);
      }
      return closeSessionTxn(db, session, countedCashCents, closer, notes);
    });
    res.json(result);
  } catch (error: unknown) {
    const status = errorStatus(error);
    res.status(status).json({ error: status >= 500 ? 'Failed to close shift' : errorMessage(error, 'Failed to close shift') });
  }
});

export const cashSessionRoutes = router;

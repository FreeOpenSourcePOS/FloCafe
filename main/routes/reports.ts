import { Router, Request, Response } from 'express';
import Decimal from 'decimal.js';
import { getDatabase, getSettingValue, parseDbTimestamp, utcDayBounds, utcTodayDate } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { getOrdersWithItemsForBills } from './bills';
import { aggregateTaxComponents } from '../services/tax-components';
import { getTenantCurrency } from '../services/refund';
import { getCurrencyMinorUnitFactor } from '../countries';

const router = Router();

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Mirrors main/routes/tables.ts's ACTIVE_ORDER_STATUS_SQL — an order still
// "occupying" its table until it's completed or cancelled.
const ACTIVE_ORDER_STATUS_SQL = "o.status NOT IN ('completed', 'cancelled')";

function reportDate(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

/**
 * Buckets order timestamps into local hour-of-day (0-23) and local
 * day-of-week (0=Sunday..6=Saturday), using the tenant's configured
 * timezone rather than server/UTC time — otherwise "busiest hour" would
 * reflect UTC, not when the restaurant is actually busy. SQLite has no
 * IANA timezone support (only fixed offsets), so this bucketing happens
 * in JS via Intl instead of in SQL.
 */
function bucketByLocalHourAndWeekday(timestamps: string[], timeZone: string): { hourCounts: number[]; dayCounts: number[] } {
  const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' });
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' });

  const hourCounts = new Array(24).fill(0);
  const dayCounts = new Array(7).fill(0);

  for (const ts of timestamps) {
    const d = parseDbTimestamp(ts);
    if (isNaN(d.getTime())) continue;
    const hour = parseInt(hourFmt.format(d), 10);
    if (hour >= 0 && hour <= 23) hourCounts[hour]++;
    const dayIdx = WEEKDAY_NAMES.indexOf(weekdayFmt.format(d));
    if (dayIdx >= 0) dayCounts[dayIdx]++;
  }

  return { hourCounts, dayCounts };
}

/**
 * Return payment lines in a UTC half-open range using SQLite JSON1. Keeping
 * expansion in SQL avoids loading every bill and tolerates both the current
 * array shape, legacy top-level objects, and invalid JSON.
 */
function paymentMethodBreakdown(
  db: ReturnType<typeof getDatabase>,
  startDate: string,
  endDate = startDate,
  paidOnly = false,
  attributeRefundsToBillDate = false,
) {
  const start = utcDayBounds(startDate)[0];
  const end = utcDayBounds(endDate)[1];
  const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
  return db.prepare(`
    WITH payment_lines AS (
      SELECT b.paid_at, b.created_at, je.value AS line
      FROM bills b
      JOIN json_each(CASE
        WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array'
          THEN b.payment_details
        WHEN json_valid(b.payment_details)
          THEN json_array(b.payment_details)
        ELSE '[]'
      END) je
      WHERE b.payment_details IS NOT NULL
        AND b.created_at < ?
        AND (b.paid_at IS NULL OR b.paid_at >= ?)
        AND (? = 0 OR b.paid_at IS NOT NULL)
        AND json_type(je.value) = 'object'
    ), normalized AS (
      SELECT
        COALESCE(NULLIF(json_extract(line, '$.method'), ''), 'unknown') AS method,
        CAST(json_extract(line, '$.payment_method_id') AS INTEGER) AS payment_method_id,
        json_extract(line, '$.amount') AS amount,
        COALESCE(
          datetime(NULLIF(json_extract(line, '$.timestamp'), '')),
          datetime(NULLIF(paid_at, '')),
          datetime(NULLIF(created_at, ''))
        ) AS payment_time
      FROM payment_lines
      UNION ALL
      SELECT r.method, NULL, -(r.amount_cents / ?),
        datetime(CASE WHEN ? = 1 THEN b.paid_at ELSE r.created_at END)
      FROM refunds r
      JOIN bills b ON b.id = r.bill_id
    )
    SELECT COALESCE(pm.name, normalized.method) AS method, COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN typeof(amount) IN ('integer', 'real') THEN amount ELSE 0 END), 0) AS total
    FROM normalized LEFT JOIN payment_methods pm ON pm.id = normalized.payment_method_id
    WHERE payment_time >= datetime(?) AND payment_time < datetime(?)
    GROUP BY COALESCE(pm.name, normalized.method)
    ORDER BY total DESC
  `).all(end, start, paidOnly ? 1 : 0, minorFactor, attributeRefundsToBillDate ? 1 : 0, start, end);
}

/** argmax/argmin over counts, restricted to indices where include(count) is true. Returns null if nothing qualifies. */
function pickExtreme(counts: number[], mode: 'max' | 'min', include: (count: number) => boolean): { index: number; count: number } | null {
  let best: { index: number; count: number } | null = null;
  counts.forEach((count, index) => {
    if (!include(count)) return;
    if (!best || (mode === 'max' ? count > best.count : count < best.count)) {
      best = { index, count };
    }
  });
  return best;
}

router.get('/daily-stats', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
    const today = utcTodayDate();
    const [start, end] = utcDayBounds(today);
    const salesToday = db.prepare(`
      SELECT
        COALESCE((SELECT SUM(paid_amount) FROM bills WHERE paid_at >= ? AND paid_at < ?), 0)
        - COALESCE((SELECT SUM(amount_cents) / ? FROM refunds WHERE created_at >= ? AND created_at < ?), 0) AS sales
    `).get(start, end, minorFactor, start, end) as { sales: number };
    const paymentMethodsToday = paymentMethodBreakdown(db, today) as { total: number }[];

    const runningOrders = db.prepare(`
      SELECT COUNT(*) as count FROM orders WHERE status IN ('pending', 'preparing')
    `).get() as { count: number };

    const pendingOrders = db.prepare(`
      SELECT COUNT(*) as count FROM orders WHERE status = 'pending'
    `).get() as { count: number };

    const tablesOccupied = db.prepare(`
      SELECT COUNT(*) as count FROM tables WHERE status = 'occupied'
    `).get() as { count: number };

    // Avg Table Turn: how long dine-in tables took to turn over today, for
    // orders that finished today (mirrors /insights' avgPrepTimeMinutes idiom).
    const tableTurn = db.prepare(`
      SELECT AVG((julianday(completed_at) - julianday(created_at)) * 24 * 60) as avgMinutes,
        COUNT(*) as sampleSize
      FROM orders
      WHERE type = 'dine_in' AND status = 'completed' AND completed_at IS NOT NULL
        AND completed_at >= ? AND completed_at < ?
    `).get(start, end) as { avgMinutes: number | null; sampleSize: number };

    // Avg Current Occupancy: how long tables occupied right now have been seated.
    const currentOccupancy = db.prepare(`
      SELECT AVG((julianday('now') - julianday(o.created_at)) * 24 * 60) as avgMinutes,
        COUNT(*) as sampleSize
      FROM tables t
      JOIN orders o ON o.table_id = t.id AND ${ACTIVE_ORDER_STATUS_SQL}
      WHERE t.status = 'occupied'
    `).get() as { avgMinutes: number | null; sampleSize: number };

    res.json({
      sales: salesToday.sales,
      runningOrders: runningOrders.count,
      pendingOrders: pendingOrders.count,
      tablesOccupied: tablesOccupied.count,
      avgTableTurnMinutes: tableTurn.sampleSize > 0 && tableTurn.avgMinutes !== null ? Math.round(tableTurn.avgMinutes) : null,
      avgCurrentOccupancyMinutes: currentOccupancy.sampleSize > 0 && currentOccupancy.avgMinutes !== null ? Math.round(currentOccupancy.avgMinutes) : null,
      paymentMethods: paymentMethodsToday,
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/summary', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
    // #208: an explicit date param is a UTC `YYYY-MM-DD`; resolve to the
    // half-open UTC range. `reportDate` validates the param shape.
    const date = reportDate(req.query.date, utcTodayDate());
    const [start, end] = utcDayBounds(date);

    const ordersToday = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total
      FROM orders WHERE created_at >= ? AND created_at < ?
    `).get(start, end) as { count: number; total: number };

    const billsToday = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total,
        COALESCE((SELECT SUM(paid_amount) FROM bills WHERE paid_at >= ? AND paid_at < ?), 0)
        - COALESCE((SELECT SUM(amount_cents) / ? FROM refunds WHERE created_at >= ? AND created_at < ?), 0) as collected
      FROM bills WHERE created_at >= ? AND created_at < ?
    `).get(start, end, minorFactor, start, end, start, end) as { count: number; total: number; collected: number };
    const paymentMethodsToday = paymentMethodBreakdown(db, date);

    const customersToday = db.prepare(`
      SELECT COUNT(*) as count FROM customers WHERE created_at >= ? AND created_at < ?
    `).get(start, end) as { count: number };

    const ordersByStatus = db.prepare(`
      SELECT status, COUNT(*) as count FROM orders WHERE created_at >= ? AND created_at < ? GROUP BY status
    `).all(start, end);

    res.json({
      summary: {
        date,
        orders: { count: ordersToday.count, total: ordersToday.total },
        bills: { count: billsToday.count, total: billsToday.total, collected: billsToday.collected },
        customers: { new: customersToday.count },
        ordersByStatus,
        paymentMethods: paymentMethodsToday,
      }
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/financial-summary', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const today = utcTodayDate();
    const startDate = reportDate(req.query.start_date, today);
    const endDate = reportDate(req.query.end_date, startDate);
    if ((req.query.start_date !== undefined && reportDate(req.query.start_date, '') === '')
      || (req.query.end_date !== undefined && reportDate(req.query.end_date, '') === '')) {
      return res.status(400).json({ error: 'start_date and end_date must use YYYY-MM-DD format' });
    }
    if (startDate > endDate) {
      return res.status(400).json({ error: 'start_date must be on or before end_date' });
    }
    const [start] = utcDayBounds(startDate);
    const [, end] = utcDayBounds(endDate);
    const db = getDatabase();
    const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
    const collections = db.prepare(`
      SELECT COUNT(*) AS bill_count, COALESCE(SUM(paid_amount), 0) AS gross_collected
      FROM bills WHERE paid_at >= ? AND paid_at < ?
    `).get(start, end) as { bill_count: number; gross_collected: number };
    const refundTotals = db.prepare(`
      SELECT COUNT(*) AS refund_count, COALESCE(SUM(r.amount_cents) / ?, 0) AS refunded
      FROM refunds r JOIN bills b ON b.id = r.bill_id
      WHERE b.paid_at >= ? AND b.paid_at < ?
    `).get(minorFactor, start, end) as { refund_count: number; refunded: number };
    const refunds = db.prepare(`
      SELECT r.id, r.amount_cents / ? AS amount, r.method, r.reason,
        r.created_at, b.bill_number, b.paid_at, o.order_number,
        COALESCE(approver.name, creator.name, 'Unknown') AS approved_by_name
      FROM refunds r
      JOIN bills b ON b.id = r.bill_id
      JOIN orders o ON o.id = b.order_id
      LEFT JOIN users approver ON approver.id = r.approved_by
      LEFT JOIN users creator ON creator.id = r.created_by
      WHERE b.paid_at >= ? AND b.paid_at < ?
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 50
    `).all(minorFactor, start, end);
    const grossCollected = Number(collections.gross_collected || 0);
    const refunded = Number(refundTotals.refunded || 0);

    res.json({
      financialSummary: {
        startDate,
        endDate,
        grossCollected,
        refunded,
        netCollected: grossCollected - refunded,
        billCount: Number(collections.bill_count || 0),
        refundCount: Number(refundTotals.refund_count || 0),
        averageOrderValue: collections.bill_count ? (grossCollected - refunded) / collections.bill_count : 0,
        paymentMethods: paymentMethodBreakdown(db, startDate, endDate, true, true),
        refunds,
      },
    });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Dynamic tax-component report for receipt/report consumers. Components are
// derived item by item so mixed legacy + categorized bills cannot double-count
// the categorized portion already present in the bill-level tax_breakdown.
router.get('/tax-components', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const today = utcTodayDate();
    const startDate = reportDate(req.query.start_date, today);
    const endDate = reportDate(req.query.end_date, today);
    if (startDate > endDate) {
      return res.status(400).json({ error: 'start_date must be on or before end_date' });
    }
    const windowStart = utcDayBounds(startDate)[0];
    const windowEnd = utcDayBounds(endDate)[1];

    const bills = db.prepare(`
      SELECT b.*
      FROM bills b
      JOIN orders o ON o.id = b.order_id
      WHERE b.created_at >= ? AND b.created_at < ?
        AND o.status != 'cancelled'
      ORDER BY b.created_at, b.id
    `).all(windowStart, windowEnd) as any[];

    const orders = getOrdersWithItemsForBills(db, bills);
    const documents = bills.map((bill) => ({
      tax_amount: bill.tax_amount,
      tax_snapshot: bill.tax_snapshot,
      tax_breakdown: bill.tax_breakdown,
      items: orders.get(Number(bill.id))?.items || [],
    }));
    const taxAmount = bills.reduce(
      (sum, bill) => sum.plus(bill.tax_amount || 0),
      new Decimal(0),
    );

    res.json({
      taxComponents: {
        startDate,
        endDate,
        billCount: bills.length,
        taxAmount: taxAmount.toDecimalPlaces(6).toNumber(),
        components: aggregateTaxComponents(documents),
      },
    });
  } catch (error: any) {
    console.error('[API] Tax component report failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/sales', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const today = utcTodayDate();
    const startDate = reportDate(req.query.start_date, today);
    const endDate = reportDate(req.query.end_date, today);
    if (startDate > endDate) {
      return res.status(400).json({ error: 'start_date must be on or before end_date' });
    }
    // #208: half-open UTC ranges so the orders/bills indexes apply instead
    // of `date(...)` on every row. All day boundaries are UTC.
    const windowStart = utcDayBounds(startDate)[0];
    const windowEnd = utcDayBounds(endDate)[1];

    // Daily series bucketed by UTC day (substr of the stored UTC timestamp) —
    // same labels the previous `date(created_at)` produced, at index cost.
    const dailySales = db.prepare(`
      SELECT substr(created_at, 1, 10) as date, COUNT(*) as orders, SUM(total) as sales
      FROM orders
      WHERE created_at >= ? AND created_at < ?
      GROUP BY substr(created_at, 1, 10)
      ORDER BY date
    `).all(windowStart, windowEnd);

    const byPaymentMethod = paymentMethodBreakdown(db, startDate, endDate, true) as { method: string; count: number; total: number }[];

    const byOrderType = db.prepare(`
      SELECT type, COUNT(*) as count, SUM(total) as total
      FROM orders
      WHERE created_at >= ? AND created_at < ?
      GROUP BY type
    `).all(windowStart, windowEnd);

    res.json({
      sales: {
        startDate,
        endDate,
        dailySales,
        byPaymentMethod,
        byOrderType,
      }
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/topProducts', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const today = utcTodayDate();
    const startDate = reportDate(req.query.start_date, today);
    const endDate = reportDate(req.query.end_date, today);
    if (startDate > endDate) {
      return res.status(400).json({ error: 'start_date must be on or before end_date' });
    }
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 10;
    const windowStart = utcDayBounds(startDate)[0];
    const windowEnd = utcDayBounds(endDate)[1];

    const topProducts = db.prepare(`
      SELECT oi.product_id, oi.product_name,
        SUM(oi.quantity) as total_quantity,
        SUM(oi.subtotal) as total_revenue,
        COUNT(DISTINCT oi.order_id) as order_count
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.created_at >= ? AND o.created_at < ?
      GROUP BY oi.product_id
      ORDER BY total_quantity DESC
      LIMIT ?
    `).all(windowStart, windowEnd, limit);

    res.json({ topProducts });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/recentOrders', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 20;
    const date = req.query.date === undefined ? undefined : reportDate(req.query.date, '');
    const startDate = req.query.start_date === undefined ? undefined : reportDate(req.query.start_date, '');
    const endDate = req.query.end_date === undefined ? undefined : reportDate(req.query.end_date, '');
    if (req.query.date !== undefined && !date) {
      return res.status(400).json({ error: 'date must use YYYY-MM-DD format' });
    }
    if ((req.query.start_date !== undefined && !startDate) || (req.query.end_date !== undefined && !endDate)) {
      return res.status(400).json({ error: 'start_date and end_date must use YYYY-MM-DD format' });
    }
    if (date && (startDate || endDate)) {
      return res.status(400).json({ error: 'date cannot be combined with start_date or end_date' });
    }
    if (startDate && endDate && startDate > endDate) {
      return res.status(400).json({ error: 'start_date must be on or before end_date' });
    }

    // Without a date, "most recent overall" (dashboard live view). With one,
    // scoped to that day — lets the dashboard show a past day's orders
    // instead of always the latest regardless of which date is selected.
    // #208: range filter hits idx_orders_created_at instead of full scan.
    const params: any[] = [];
    let where = '';
    if (date) {
      const [s, e] = utcDayBounds(date);
      where = 'WHERE o.created_at >= ? AND o.created_at < ?';
      params.push(s, e);
    } else if (startDate || endDate) {
      const effectiveStart = startDate || endDate!;
      const effectiveEnd = endDate || startDate!;
      const [s] = utcDayBounds(effectiveStart);
      const [, e] = utcDayBounds(effectiveEnd);
      where = 'WHERE o.created_at >= ? AND o.created_at < ?';
      params.push(s, e);
    }

    const recentOrders = db.prepare(`
      SELECT o.*, t.number as table_name, c.name as customer_name
      FROM orders o
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN customers c ON o.customer_id = c.id
      ${where}
      ORDER BY o.created_at DESC
      LIMIT ?
    `).all(...params, limit);

    // #208: batch all items in one IN() query instead of per-order N+1.
    const orderIds = recentOrders.map((o: any) => o.id);
    const itemsByOrder = new Map<number, any[]>();
    if (orderIds.length > 0) {
      const placeholders = orderIds.map(() => '?').join(',');
      const items = db.prepare(`SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY order_id, id`).all(...orderIds);
      for (const item of items as any[]) {
        const list = itemsByOrder.get(item.order_id) || [];
        list.push(item);
        itemsByOrder.set(item.order_id, list);
      }
    }
    const ordersWithItems = recentOrders.map((order: any) => ({
      ...order,
      items: itemsByOrder.get(order.id) || [],
    }));

    res.json({ recentOrders: ordersWithItems });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/tables', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const [start, end] = utcDayBounds(utcTodayDate());

    const tableStats = db.prepare(`
      SELECT t.*,
        COUNT(DISTINCT o.id) as total_orders,
        COALESCE(SUM(o.total), 0) as total_revenue,
        MAX(o.created_at) as last_order_at
      FROM tables t
      LEFT JOIN orders o ON t.id = o.table_id
        AND o.created_at >= ? AND o.created_at < ?
      GROUP BY t.id
    `).all(start, end);

    const tableUtilization = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'occupied' THEN 1 ELSE 0 END) as occupied,
        SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END) as reserved,
        SUM(CASE WHEN status = 'cleaning' THEN 1 ELSE 0 END) as cleaning,
        COUNT(*) as total
      FROM tables
    `).get();

    res.json({
      tableStats,
      tableUtilization
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /insights — dashboard metrics beyond today's snapshot ──────────────
// AOV, top staff, top categories, busiest/idlest hour & day-of-week, and
// average kitchen prep time, aggregated over a trailing window (default 30
// days) so hour/day patterns reflect a consistent trend rather than one day.
router.get('/insights', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
    const days = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 365);
    // #208: "N days back" in UTC, with the UTC day range so the window
    // filters on the index. Day boundaries are UTC; the tenant timezone only
    // drives the hour/day-of-week bucketing below.
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const timeZone = getSettingValue('timezone') || 'Asia/Kolkata';
    const [windowStart] = utcDayBounds(startDate);

    // AOV — same revenue basis ("paid bills") as the existing daily-stats tile.
    const revenue = db.prepare(`
      SELECT COUNT(*) as billCount,
        COALESCE(SUM(paid_amount), 0)
        - COALESCE((SELECT SUM(amount_cents) / ? FROM refunds WHERE created_at >= ?), 0) as total
      FROM bills
      WHERE paid_at >= ?
    `).get(minorFactor, windowStart, windowStart) as { billCount: number; total: number };
    const aov = revenue.billCount > 0 ? revenue.total / revenue.billCount : 0;

    // Kitchen velocity — substitutes for "best cook", which isn't derivable:
    // order_items has no per-chef attribution (marking an item ready doesn't
    // record who did it), so there's no data to rank individual cooks by.
    // Average prep time is the closest real signal for kitchen performance.
    const prepTime = db.prepare(`
      SELECT AVG((julianday(ready_at) - julianday(cooking_started_at)) * 24 * 60) as avgMinutes,
        COUNT(*) as sampleSize
      FROM orders
      WHERE cooking_started_at IS NOT NULL AND ready_at IS NOT NULL
        AND created_at >= ? AND status != 'cancelled'
    `).get(windowStart) as { avgMinutes: number | null; sampleSize: number };

    // Top staff by revenue — covers whoever creates orders (owner/manager/
    // cashier/server, per POST /orders' own role gate), i.e. "best cashier".
    const topStaff = db.prepare(`
      SELECT u.id as user_id, u.name, u.role,
        COALESCE(SUM(o.total), 0) as revenue,
        COUNT(o.id) as orderCount
      FROM orders o
      JOIN users u ON u.id = o.user_id
      WHERE o.created_at >= ? AND o.status != 'cancelled'
      GROUP BY u.id
      ORDER BY revenue DESC
      LIMIT 5
    `).all(windowStart);

    // Top categories by revenue.
    const topCategories = db.prepare(`
      SELECT c.id as category_id, COALESCE(c.name, 'Uncategorized') as name,
        COALESCE(SUM(oi.quantity), 0) as quantity,
        COALESCE(SUM(oi.subtotal), 0) as revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE o.created_at >= ? AND oi.status != 'cancelled'
      GROUP BY c.id
      ORDER BY revenue DESC
      LIMIT 5
    `).all(windowStart);

    // Busiest/idlest hour & day-of-week, bucketed in the tenant's local timezone.
    const orderTimestamps = (db.prepare(
      `SELECT created_at FROM orders WHERE created_at >= ? AND status != 'cancelled'`
    ).all(windowStart) as { created_at: string }[]).map((r) => r.created_at);

    const { hourCounts, dayCounts } = bucketByLocalHourAndWeekday(orderTimestamps, timeZone);

    // Hours with zero orders are excluded from busiest/idlest — almost
    // certainly "closed overnight" rather than a meaningful idle signal,
    // and would otherwise trivially always "win" idlest hour.
    const busiestHour = pickExtreme(hourCounts, 'max', (c) => c > 0);
    const idlestHour = pickExtreme(hourCounts, 'min', (c) => c > 0);

    // Day-of-week zero counts ARE kept — "closed Mondays" is a real,
    // useful signal, unlike an overnight hour with no foot traffic.
    const busiestDay = pickExtreme(dayCounts, 'max', () => true);
    const idlestDay = pickExtreme(dayCounts, 'min', () => true);

    res.json({
      windowDays: days,
      aov,
      ordersAnalyzed: orderTimestamps.length,
      avgPrepTimeMinutes: prepTime.sampleSize > 0 && prepTime.avgMinutes !== null ? Math.round(prepTime.avgMinutes) : null,
      topStaff,
      topCategories,
      busiestHour: busiestHour ? { hour: busiestHour.index, orderCount: busiestHour.count } : null,
      idlestHour: idlestHour ? { hour: idlestHour.index, orderCount: idlestHour.count } : null,
      busiestDayOfWeek: busiestDay ? { dayIndex: busiestDay.index, orderCount: busiestDay.count } : null,
      idlestDayOfWeek: idlestDay ? { dayIndex: idlestDay.index, orderCount: idlestDay.count } : null,
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export const reportRoutes = router;

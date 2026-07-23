import { Router, Request, Response } from 'express';
import { getDatabase, now, getSettingValue } from '../db';
import { requireRole } from '../middleware/security';

const router = Router();

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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
    const d = new Date(ts);
    if (isNaN(d.getTime())) continue;
    const hour = parseInt(hourFmt.format(d), 10);
    if (hour >= 0 && hour <= 23) hourCounts[hour]++;
    const dayIdx = WEEKDAY_NAMES.indexOf(weekdayFmt.format(d));
    if (dayIdx >= 0) dayCounts[dayIdx]++;
  }

  return { hourCounts, dayCounts };
}

/**
 * `bills.payment_details` is a JSON array of individual payment splits
 * (`[{method, amount, timestamp, ...}, ...]`), not a single object — a bill
 * can be paid across multiple methods (e.g. part cash, part card). Flattens
 * that with `json_each` and buckets by the split's own timestamp (not the
 * bill's `paid_at`, which only marks when the bill became fully paid and
 * would misattribute or drop earlier partial-payment splits on other days).
 */
function paymentMethodBreakdown(db: ReturnType<typeof getDatabase>, date: string) {
  return db.prepare(`
    SELECT
      json_extract(je.value, '$.method') as method,
      COUNT(*) as count,
      COALESCE(SUM(json_extract(je.value, '$.amount')), 0) as total
    FROM bills b, json_each(b.payment_details) je
    WHERE b.payment_details IS NOT NULL
      AND date(json_extract(je.value, '$.timestamp')) = date(?)
    GROUP BY method
    ORDER BY total DESC
  `).all(date);
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

router.get('/daily-stats', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const today = new Date().toISOString().slice(0, 10);

    const salesToday = db.prepare(`
      SELECT COALESCE(SUM(paid_amount), 0) as sales
      FROM bills WHERE date(created_at) = date(?)
    `).get(today) as { sales: number };

    const runningOrders = db.prepare(`
      SELECT COUNT(*) as count FROM orders WHERE status IN ('pending', 'preparing')
    `).get() as { count: number };

    const pendingOrders = db.prepare(`
      SELECT COUNT(*) as count FROM orders WHERE status = 'pending'
    `).get() as { count: number };

    const tablesOccupied = db.prepare(`
      SELECT COUNT(*) as count FROM tables WHERE status = 'occupied'
    `).get() as { count: number };

    res.json({
      sales: salesToday.sales,
      runningOrders: runningOrders.count,
      pendingOrders: pendingOrders.count,
      tablesOccupied: tablesOccupied.count,
      paymentMethods: paymentMethodBreakdown(db, today),
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/summary', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const date = req.query.date as string || new Date().toISOString().slice(0, 10);

    const ordersToday = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total
      FROM orders WHERE date(created_at) = date(?)
    `).get(date) as { count: number; total: number };

    const billsToday = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total, COALESCE(SUM(paid_amount), 0) as collected
      FROM bills WHERE date(created_at) = date(?)
    `).get(date) as { count: number; total: number; collected: number };

    const customersToday = db.prepare(`
      SELECT COUNT(*) as count FROM customers WHERE date(created_at) = date(?)
    `).get(date) as { count: number };

    const ordersByStatus = db.prepare(`
      SELECT status, COUNT(*) as count FROM orders WHERE date(created_at) = date(?) GROUP BY status
    `).all(date);

    res.json({
      summary: {
        date,
        orders: { count: ordersToday.count, total: ordersToday.total },
        bills: { count: billsToday.count, total: billsToday.total, collected: billsToday.collected },
        customers: { new: customersToday.count },
        ordersByStatus,
        paymentMethods: paymentMethodBreakdown(db, date),
      }
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/sales', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const startDate = req.query.start_date as string || new Date().toISOString().slice(0, 10);
    const endDate = req.query.end_date as string || new Date().toISOString().slice(0, 10);

    const dailySales = db.prepare(`
      SELECT date(created_at) as date, COUNT(*) as orders, SUM(total) as sales
      FROM orders
      WHERE date(created_at) BETWEEN date(?) AND date(?)
      GROUP BY date(created_at)
      ORDER BY date
    `).all(startDate, endDate);

    const byPaymentMethod = db.prepare(`
      SELECT json_extract(payment_details, '$.method') as method,
        COUNT(*) as count, SUM(paid_amount) as total
      FROM bills
      WHERE payment_status = 'paid'
        AND date(paid_at) BETWEEN date(?) AND date(?)
      GROUP BY json_extract(payment_details, '$.method')
    `).all(startDate, endDate);

    const byOrderType = db.prepare(`
      SELECT type, COUNT(*) as count, SUM(total) as total
      FROM orders
      WHERE date(created_at) BETWEEN date(?) AND date(?)
      GROUP BY type
    `).all(startDate, endDate);

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

router.get('/topProducts', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const startDate = req.query.start_date as string || new Date().toISOString().slice(0, 10);
    const endDate = req.query.end_date as string || new Date().toISOString().slice(0, 10);
    const limit = parseInt(req.query.limit as string) || 10;

    const topProducts = db.prepare(`
      SELECT oi.product_id, oi.product_name,
        SUM(oi.quantity) as total_quantity,
        SUM(oi.subtotal) as total_revenue,
        COUNT(DISTINCT oi.order_id) as order_count
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE date(o.created_at) BETWEEN date(?) AND date(?)
      GROUP BY oi.product_id
      ORDER BY total_quantity DESC
      LIMIT ?
    `).all(startDate, endDate, limit);

    res.json({ topProducts });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/recentOrders', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const limit = parseInt(req.query.limit as string) || 20;
    const date = req.query.date as string | undefined;

    // Without a date, "most recent overall" (dashboard live view). With one,
    // scoped to that day — lets the dashboard show a past day's orders
    // instead of always the latest regardless of which date is selected.
    const recentOrders = date
      ? db.prepare(`
          SELECT o.*, t.number as table_name, c.name as customer_name
          FROM orders o
          LEFT JOIN tables t ON o.table_id = t.id
          LEFT JOIN customers c ON o.customer_id = c.id
          WHERE date(o.created_at) = date(?)
          ORDER BY o.created_at DESC
          LIMIT ?
        `).all(date, limit)
      : db.prepare(`
          SELECT o.*, t.number as table_name, c.name as customer_name
          FROM orders o
          LEFT JOIN tables t ON o.table_id = t.id
          LEFT JOIN customers c ON o.customer_id = c.id
          ORDER BY o.created_at DESC
          LIMIT ?
        `).all(limit);

    const ordersWithItems = recentOrders.map((order: any) => {
      const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
      return { ...order, items };
    });

    res.json({ recentOrders: ordersWithItems });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get('/tables', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();

    const tableStats = db.prepare(`
      SELECT t.*,
        COUNT(DISTINCT o.id) as total_orders,
        COALESCE(SUM(o.total), 0) as total_revenue,
        MAX(o.created_at) as last_order_at
      FROM tables t
      LEFT JOIN orders o ON t.id = o.table_id
      WHERE date(o.created_at) = date('now') OR o.id IS NULL
      GROUP BY t.id
    `).all();

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
router.get('/insights', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const days = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 365);
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const timeZone = getSettingValue('timezone') || 'Asia/Kolkata';

    // AOV — same revenue basis ("paid bills") as the existing daily-stats tile.
    const revenue = db.prepare(`
      SELECT COUNT(*) as billCount, COALESCE(SUM(paid_amount), 0) as total
      FROM bills
      WHERE payment_status = 'paid' AND date(paid_at) >= date(?)
    `).get(startDate) as { billCount: number; total: number };
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
        AND date(created_at) >= date(?) AND status != 'cancelled'
    `).get(startDate) as { avgMinutes: number | null; sampleSize: number };

    // Top staff by revenue — covers whoever creates orders (owner/manager/
    // cashier/waiter, per POST /orders' own role gate), i.e. "best cashier".
    const topStaff = db.prepare(`
      SELECT u.id as user_id, u.name, u.role,
        COALESCE(SUM(o.total), 0) as revenue,
        COUNT(o.id) as orderCount
      FROM orders o
      JOIN users u ON u.id = o.user_id
      WHERE date(o.created_at) >= date(?) AND o.status != 'cancelled'
      GROUP BY u.id
      ORDER BY revenue DESC
      LIMIT 5
    `).all(startDate);

    // Top categories by revenue.
    const topCategories = db.prepare(`
      SELECT c.id as category_id, COALESCE(c.name, 'Uncategorized') as name,
        COALESCE(SUM(oi.quantity), 0) as quantity,
        COALESCE(SUM(oi.subtotal), 0) as revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE date(o.created_at) >= date(?) AND oi.status != 'cancelled'
      GROUP BY c.id
      ORDER BY revenue DESC
      LIMIT 5
    `).all(startDate);

    // Busiest/idlest hour & day-of-week, bucketed in the tenant's local timezone.
    const orderTimestamps = (db.prepare(
      `SELECT created_at FROM orders WHERE date(created_at) >= date(?) AND status != 'cancelled'`
    ).all(startDate) as { created_at: string }[]).map((r) => r.created_at);

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

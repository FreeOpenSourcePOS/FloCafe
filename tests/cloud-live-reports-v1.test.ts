/**
 * CloudSyncService live relay report contract v1 tests (Issue #1577).
 *
 * Verifies all five live report commands (`report.dashboard`, `report.hourly`,
 * `report.sales`, `report.items`, `report.payments`) against RevFlo's v1
 * `daily-sales-export` contract, business-day boundaries, non-UTC timezones,
 * refunds, split bills, relative/explicit ranges up to 370 days, grouping,
 * sorting/limits, and selector validation while preserving the 93-day limit on
 * the HTTP/file Daily Sales Export surface.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cloud-live-reports-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'keychain',
        encryptString: (value: string) => Buffer.from(value, 'utf8'),
        decryptString: (value: Buffer) => value.toString('utf8'),
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  getDatabase,
  closeDatabase,
  now,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  assertOrThrow,
  assertEqualOrThrow,
} = require('./helpers/test-setup');
const { CloudSyncService } = require('../main/services/cloud-sync');
const {
  DAILY_SALES_EXPORT_MAX_RANGE_DAYS,
  buildDailySalesExportDataset,
  resolveDailySalesExportRange,
} = require('../main/services/daily-sales-export');

// ── Faithful RevFlo v1 report-contract validator ─────────────────────────────

const SUPPORTED_REPORT_CONTRACT_VERSION = 1;
const EXPECTED_REPORT_BASIS = 'daily-sales-export';
const VALID_REPORT_VIEWS = ['dashboard', 'hourly', 'sales', 'items', 'payments'] as const;
const SINGLE_DAY_VIEWS = ['dashboard', 'hourly'] as const;
const MAX_INCLUSIVE_RANGE_DAYS = 370;
const DEFAULT_ITEMS_LIMIT = 50;
const MAX_CURRENCY_SYMBOL_LENGTH = 6;
const UNSAFE_CURRENCY_SYMBOL_RE = /[<>'"&\u0000-\u001f\u007f]/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CUTOFF_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const HOUR_LABEL_RE = /^(?:[01]?\d|2[0-3])(?::00)?$/;
const ISO_UTC_RE = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z$/;

function isPlainObject(val: unknown): val is Record<string, any> {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const isLeap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return isLeap ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function isValidCalendarDate(dateStr: unknown): dateStr is string {
  if (typeof dateStr !== 'string') return false;
  const match = DATE_RE.exec(dateStr);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1970 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

function dateToUtcDayMs(dateStr: string): number {
  const match = DATE_RE.exec(dateStr)!;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function addCalendarDays(dateStr: string, days: number): string {
  return new Date(dateToUtcDayMs(dateStr) + days * 86_400_000).toISOString().slice(0, 10);
}

function inclusiveDayCount(fromStr: unknown, toStr: unknown): number | null {
  if (!isValidCalendarDate(fromStr) || !isValidCalendarDate(toStr)) return null;
  const fromMs = dateToUtcDayMs(fromStr);
  const toMs = dateToUtcDayMs(toStr);
  if (fromMs > toMs) return null;
  return Math.round((toMs - fromMs) / 86_400_000) + 1;
}

function isValidIanaTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim().length === 0 || tz !== tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isValidIsoUtcTimestamp(str: unknown): str is string {
  if (typeof str !== 'string') return false;
  const match = ISO_UTC_RE.exec(str);
  if (!match || !isValidCalendarDate(match[1])) return false;
  return Number.isFinite(Date.parse(str));
}

function computeBusinessDayEndsAtUtcMs(
  currentBusinessDate: string,
  timezone: string,
  businessDayStart: string,
): number {
  const nextDate = addCalendarDays(currentBusinessDate, 1);
  const [, yStr, mStr, dStr] = DATE_RE.exec(nextDate)!;
  const [hStr, minStr] = businessDayStart.split(':');
  const targetAsUtcMs = Date.UTC(
    Number(yStr),
    Number(mStr) - 1,
    Number(dStr),
    Number(hStr),
    Number(minStr),
    0,
    0,
  );
  let guessMs = targetAsUtcMs;
  for (let i = 0; i < 3; i += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(guessMs));
    const map: Record<string, string> = {};
    for (const p of parts) {
      if (p.type !== 'literal') map[p.type] = p.value;
    }
    const localAsUtcMs = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour === '24' ? '0' : map.hour),
      Number(map.minute),
      Number(map.second),
      0,
    );
    const diffMs = targetAsUtcMs - localAsUtcMs;
    if (diffMs === 0) break;
    guessMs += diffMs;
  }
  return guessMs;
}

function validateItemRow(item: any, index: number, view: string): void {
  assertOrThrow(
    isPlainObject(item) && typeof item.name === 'string' && item.name.length > 0,
    `${view}: item[${index}] must have non-empty name`,
  );
  const qty = item.qty_sold ?? item.qty;
  const rev = item.revenue ?? item.net_item_sales;
  assertOrThrow(
    Number.isFinite(qty) && Number.isFinite(rev),
    `${view}: item[${index}] must have finite qty and revenue`,
  );
  if (item.price !== undefined && item.price !== null) {
    assertOrThrow(Number.isFinite(item.price), `${view}: item[${index}] price must be finite`);
  }
}

function validateReportResponse(
  rawEnvelope: unknown,
  requestSpec: Record<string, any> = {},
): Record<string, any> {
  assertOrThrow(
    isPlainObject(rawEnvelope) && isPlainObject(rawEnvelope.result),
    'outer { result } object wrapper exists',
  );
  const { result } = rawEnvelope;
  const { meta } = result;
  assertOrThrow(isPlainObject(meta), 'result.meta is an object');
  assertEqualOrThrow(
    meta.report_contract_version,
    SUPPORTED_REPORT_CONTRACT_VERSION,
    'meta.report_contract_version === 1',
  );
  assertEqualOrThrow(meta.basis, EXPECTED_REPORT_BASIS, 'meta.basis === daily-sales-export');
  assertOrThrow(
    VALID_REPORT_VIEWS.includes(meta.view),
    `meta.view "${String(meta.view)}" is valid`,
  );
  if (requestSpec.view) {
    assertEqualOrThrow(meta.view, requestSpec.view, 'meta.view matches requestSpec.view');
  }
  assertOrThrow(
    typeof meta.currency === 'string' && meta.currency.trim().length > 0,
    'meta.currency is non-empty string',
  );
  if (meta.currency_symbol !== undefined && meta.currency_symbol !== null) {
    assertOrThrow(
      typeof meta.currency_symbol === 'string' &&
        meta.currency_symbol.trim().length >= 1 &&
        meta.currency_symbol.trim().length <= MAX_CURRENCY_SYMBOL_LENGTH &&
        !UNSAFE_CURRENCY_SYMBOL_RE.test(meta.currency_symbol.trim()),
      'meta.currency_symbol is safe 1..6 chars when present',
    );
  }
  assertOrThrow(
    typeof meta.fraction_digits === 'number' &&
      Number.isInteger(meta.fraction_digits) &&
      meta.fraction_digits >= 0 &&
      meta.fraction_digits <= 4,
    'meta.fraction_digits is integer 0..4',
  );
  assertOrThrow(isValidIanaTimezone(meta.timezone), 'meta.timezone is valid IANA timezone');
  assertOrThrow(
    typeof meta.business_day_start === 'string' && CUTOFF_RE.test(meta.business_day_start),
    'meta.business_day_start is HH:MM',
  );
  assertOrThrow(
    isValidCalendarDate(meta.current_business_date),
    'meta.current_business_date is valid YYYY-MM-DD',
  );
  assertOrThrow(
    isValidIsoUtcTimestamp(meta.current_business_day_ends_at),
    'meta.current_business_day_ends_at is ISO UTC string',
  );
  assertOrThrow(
    isValidCalendarDate(meta.from) && isValidCalendarDate(meta.to),
    'meta.from and meta.to are valid YYYY-MM-DD',
  );
  const metaSpan = inclusiveDayCount(meta.from, meta.to);
  assertOrThrow(
    metaSpan !== null && metaSpan <= MAX_INCLUSIVE_RANGE_DAYS,
    `meta span (${String(metaSpan)}) is within 1..370`,
  );
  assertOrThrow(isValidIsoUtcTimestamp(meta.generated_at), 'meta.generated_at is ISO UTC string');

  const expectedEndsAtMs = computeBusinessDayEndsAtUtcMs(
    meta.current_business_date,
    meta.timezone,
    meta.business_day_start,
  );
  const actualEndsAtMs = Date.parse(meta.current_business_day_ends_at);
  const generatedAtMs = Date.parse(meta.generated_at);
  assertEqualOrThrow(
    actualEndsAtMs,
    expectedEndsAtMs,
    'meta.current_business_day_ends_at matches exact next business day cutoff UTC instant',
  );
  assertOrThrow(
    generatedAtMs <= actualEndsAtMs,
    'meta.generated_at <= meta.current_business_day_ends_at',
  );

  const view = meta.view as (typeof VALID_REPORT_VIEWS)[number];
  if ((SINGLE_DAY_VIEWS as readonly string[]).includes(view)) {
    assertEqualOrThrow(meta.from, meta.to, `${view}: single-day from === to`);
    if (requestSpec.date) {
      assertEqualOrThrow(meta.from, requestSpec.date, `${view}: meta.from matches date`);
    } else if (requestSpec.range === 'yesterday') {
      assertEqualOrThrow(
        meta.from,
        addCalendarDays(meta.current_business_date, -1),
        `${view}: yesterday range resolves to current_business_date - 1`,
      );
    } else {
      assertEqualOrThrow(
        meta.from,
        meta.current_business_date,
        `${view}: default/today resolves to current_business_date`,
      );
    }
  } else if (requestSpec.from && requestSpec.to) {
    assertEqualOrThrow(meta.from, requestSpec.from, `${view}: meta.from matches requestSpec.from`);
    assertEqualOrThrow(meta.to, requestSpec.to, `${view}: meta.to matches requestSpec.to`);
  } else if (requestSpec.range === 'today') {
    assertEqualOrThrow(meta.from, meta.current_business_date, `${view}: today from`);
    assertEqualOrThrow(meta.to, meta.current_business_date, `${view}: today to`);
  } else if (requestSpec.range === 'yesterday') {
    const y = addCalendarDays(meta.current_business_date, -1);
    assertEqualOrThrow(meta.from, y, `${view}: yesterday from`);
    assertEqualOrThrow(meta.to, y, `${view}: yesterday to`);
  } else {
    const expectedDays = requestSpec.range === 'last30' ? 30 : 7;
    assertEqualOrThrow(meta.to, meta.current_business_date, `${view}: relative range ends today`);
    assertEqualOrThrow(metaSpan, expectedDays, `${view}: relative range span is ${expectedDays}`);
  }

  if (view === 'sales') {
    assertEqualOrThrow(
      meta.group_by,
      requestSpec.group_by || 'day',
      'sales meta.group_by matches requested/default',
    );
    assertOrThrow(Array.isArray(result.data), 'sales result.data is array');
    result.data.forEach((row: any, idx: number) => {
      assertOrThrow(
        isPlainObject(row) && isValidCalendarDate(row.period),
        `sales row[${idx}] has valid YYYY-MM-DD period`,
      );
      assertOrThrow(
        row.period >= meta.from && row.period <= meta.to,
        `sales row[${idx}] period ${row.period} within ${meta.from}..${meta.to}`,
      );
      assertOrThrow(
        Number.isFinite(row.total) && Number.isInteger(row.bill_count) && row.bill_count >= 0,
        `sales row[${idx}] has finite total and non-negative integer bill_count`,
      );
    });
  } else if (view === 'dashboard') {
    assertOrThrow(
      Number.isFinite(result.total_sales) &&
        Number.isInteger(result.bill_count) &&
        result.bill_count >= 0 &&
        Number.isFinite(result.avg_order_value) &&
        Number.isFinite(result.total_tax) &&
        Number.isFinite(result.total_discount),
      'dashboard headline metrics are finite and bill_count is non-negative integer',
    );
    assertOrThrow(isPlainObject(result.payment_breakdown), 'dashboard payment_breakdown is object');
    for (const [method, amount] of Object.entries(result.payment_breakdown)) {
      assertOrThrow(
        Boolean(method) && Number.isFinite(amount as number),
        `dashboard payment_breakdown[${method}] is finite`,
      );
    }
    assertOrThrow(Array.isArray(result.top_items), 'dashboard top_items is array');
    assertOrThrow(result.top_items.length <= 5, 'dashboard top_items <= 5');
    result.top_items.forEach((item: any, idx: number) => validateItemRow(item, idx, 'dashboard'));
  } else if (view === 'hourly') {
    assertOrThrow(
      Array.isArray(result.hours) && result.hours.length === 24,
      'hourly report has 24 hour slots',
    );
    result.hours.forEach((slot: any, idx: number) => {
      assertOrThrow(
        isPlainObject(slot) &&
          typeof slot.hour === 'string' &&
          HOUR_LABEL_RE.test(slot.hour) &&
          slot.hour === `${String(idx).padStart(2, '0')}:00` &&
          Number.isFinite(slot.sales) &&
          Number.isInteger(slot.bills) &&
          slot.bills >= 0,
        `hourly slot[${idx}] valid`,
      );
    });
  } else if (view === 'items') {
    assertEqualOrThrow(
      meta.sort_by,
      requestSpec.sort_by || 'revenue',
      'items meta.sort_by matches requested/default',
    );
    assertEqualOrThrow(
      meta.limit,
      requestSpec.limit ?? DEFAULT_ITEMS_LIMIT,
      'items meta.limit matches requested/default',
    );
    assertOrThrow(
      Array.isArray(result.items) && result.items.length <= meta.limit,
      'items array within meta.limit',
    );
    result.items.forEach((item: any, idx: number) => validateItemRow(item, idx, 'items'));
  } else if (view === 'payments') {
    assertOrThrow(Number.isFinite(result.total), 'payments total is finite');
    assertOrThrow(Array.isArray(result.breakdown), 'payments breakdown is array');
    result.breakdown.forEach((entry: any, idx: number) => {
      assertOrThrow(
        isPlainObject(entry) &&
          typeof entry.method === 'string' &&
          entry.method.trim().length > 0 &&
          Number.isFinite(entry.amount) &&
          Number.isInteger(entry.count) &&
          entry.count >= 0 &&
          Number.isFinite(entry.percent),
        `payments breakdown[${idx}] valid`,
      );
    });
  }

  return result;
}

function sqlTimestamp(isoUtc: string): string {
  return new Date(isoUtc).toISOString().replace('T', ' ').replace(/\..*$/, '');
}

async function main() {
  console.log('Cloud live-reports v1 contract tests (Issue #1577)');
  console.log('='.repeat(64));

  try {
    const db = initTestDb();
    seedOwnerUser(db);
    seedCategory(db, 'cat-rep', 'Beverages');
    seedProduct(db, 'prod-latte', 'cat-rep', 'Latte', 100);
    seedProduct(db, 'prod-mocha', 'cat-rep', 'Mocha', 150);
    seedProduct(db, 'prod-tea', 'cat-rep', 'Masala Chai', 30);
    seedProduct(db, 'prod-cookie', 'cat-rep', 'Oat Cookie', 50);
    seedProduct(db, 'prod-cake', 'cat-rep', 'Carrot Cake', 200);
    seedProduct(db, 'prod-water', 'cat-rep', 'Sparkling Water', 40);

    const setSetting = (key: string, value: string) => {
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(key, value, now());
    };

    // Configure non-UTC half-hour timezone (Asia/Kolkata +05:30) and 04:00 business-day cutoff.
    setSetting('country', 'IN');
    setSetting('currency', 'INR');
    setSetting('timezone', 'Asia/Kolkata');
    setSetting('business_day_start_time', '04:00');

    const service = new CloudSyncService();

    const invokeReport = (
      view: (typeof VALID_REPORT_VIEWS)[number],
      payload?: Record<string, unknown>,
      useEnvelope = false,
    ) => {
      const commandPayload = useEnvelope
        ? { version: 1, payload: { view, ...(payload ?? {}) } }
        : payload;
      const result = (service as any).runCommand({
        id: `cmd-${view}`,
        type: `report.${view}`,
        payload: commandPayload,
      });
      return { result };
    };

    // ── 1. Empty store zero-activity baseline + v1 relay envelope unwrapping ──
    console.log('\n─── 1. Empty state across all 5 views + envelope unwrapping ───');
    for (const view of VALID_REPORT_VIEWS) {
      validateReportResponse(
        {
          result: (service as any).runCommand({
            id: `cmd-null-${view}`,
            type: `report.${view}`,
            payload: null,
          }),
        },
        { view },
      );
      const env = invokeReport(view, undefined, true);
      const validated = validateReportResponse(env, { view });
      assertEqualOrThrow(validated.meta.timezone, 'Asia/Kolkata', `${view}: empty state timezone`);
      assertEqualOrThrow(
        validated.meta.business_day_start,
        '04:00',
        `${view}: empty state business_day_start`,
      );
      assertEqualOrThrow(validated.meta.currency, 'INR', `${view}: empty state currency`);
      assertEqualOrThrow(validated.meta.fraction_digits, 2, `${view}: empty state fraction_digits`);
      if (view === 'dashboard') {
        assertEqualOrThrow(validated.total_sales, 0, 'empty dashboard total_sales');
        assertEqualOrThrow(validated.bill_count, 0, 'empty dashboard bill_count');
        assertEqualOrThrow(validated.avg_order_value, 0, 'empty dashboard avg_order_value');
        assert.deepEqual(validated.payment_breakdown, {});
        assert.deepEqual(validated.top_items, []);
      } else if (view === 'hourly') {
        assertEqualOrThrow(
          validated.hours.every((h: any) => h.sales === 0 && h.bills === 0),
          true,
          'empty hourly slots all zero',
        );
      } else if (view === 'sales') {
        assertEqualOrThrow(validated.data.length, 7, 'empty default sales has 7 daily rows');
        assertEqualOrThrow(
          validated.data.every((r: any) => r.total === 0 && r.bill_count === 0),
          true,
          'empty sales rows zero',
        );
      } else if (view === 'items') {
        assert.deepEqual(validated.items, []);
      } else if (view === 'payments') {
        assertEqualOrThrow(validated.total, 0, 'empty payments total');
        assert.deepEqual(validated.breakdown, []);
      }
    }

    // ── 2. Business-day cutoff (04:00 Asia/Kolkata), refunds, split bills ─────
    console.log('\n─── 2. Business-day cutoff, store-local hourly slots, refunds, split bills ───');
    let seq = 0;
    function seedOrderAndBill(opts: {
      paidAtIsoUtc: string | null;
      paymentDetails: Array<{ method: string; amount: number }>;
      items: Array<{
        productId: string;
        name: string;
        qty: number;
        unitPrice: number;
        discount?: number;
        tax?: number;
        status?: string;
      }>;
      orderDiscount?: number;
    }) {
      seq += 1;
      const createdAt = sqlTimestamp(opts.paidAtIsoUtc ?? '2026-09-10T06:00:00Z');
      const activeItems = opts.items.filter((i) => (i.status ?? 'ready') !== 'cancelled');
      const subtotal = activeItems.reduce(
        (s, i) => s + (i.qty * i.unitPrice - (i.discount ?? 0)),
        0,
      );
      const taxAmount = activeItems.reduce((s, i) => s + (i.tax ?? 0), 0);
      const orderDiscount = opts.orderDiscount ?? 0;
      const total = subtotal - orderDiscount + taxAmount;

      db.prepare(`
        INSERT INTO orders (order_number, user_id, type, status, subtotal, discount_amount, tax_amount, total, created_at, updated_at, completed_at)
        VALUES (?, 'owner-test-001', 'dine_in', 'completed', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `ORD-REP-${seq}`,
        subtotal,
        orderDiscount,
        taxAmount,
        total,
        createdAt,
        createdAt,
        createdAt,
      );
      const orderId = Number(
        db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`ORD-REP-${seq}`).id,
      );

      const itemIds: number[] = [];
      for (const item of opts.items) {
        const lineSubtotal = item.qty * item.unitPrice - (item.discount ?? 0);
        const lineTax = item.tax ?? 0;
        const lineTotal = lineSubtotal + lineTax;
        const res = db
          .prepare(`
          INSERT INTO order_items (order_id, product_id, product_name, product_sku, quantity, unit_price, discount_amount, subtotal, tax_amount, total, status, created_at, updated_at)
          VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
          .run(
            orderId,
            item.productId,
            item.name,
            item.qty,
            item.unitPrice,
            item.discount ?? 0,
            lineSubtotal,
            lineTax,
            lineTotal,
            item.status ?? 'ready',
            createdAt,
            createdAt,
          );
        itemIds.push(Number(res.lastInsertRowid));
      }

      const paidAmount = opts.paidAtIsoUtc
        ? opts.paymentDetails.reduce((s, p) => s + p.amount, 0)
        : 0;
      const billRes = db
        .prepare(`
        INSERT INTO bills (bill_number, order_id, subtotal, discount_amount, tax_amount, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          `BILL-REP-${seq}`,
          orderId,
          subtotal,
          orderDiscount,
          taxAmount,
          total,
          paidAmount,
          opts.paidAtIsoUtc ? 0 : total,
          opts.paidAtIsoUtc ? 'paid' : 'unpaid',
          opts.paidAtIsoUtc
            ? JSON.stringify(
                opts.paymentDetails.map((p) => ({
                  method: p.method,
                  amount: p.amount,
                  timestamp: createdAt,
                })),
              )
            : null,
          opts.paidAtIsoUtc ? createdAt : null,
          createdAt,
          createdAt,
        );
      return { orderId, billId: Number(billRes.lastInsertRowid), itemIds };
    }

    // 2026-09-10 02:30 IST = 2026-09-09T21:00:00Z -> BEFORE 04:00 cutoff -> business date 2026-09-09!
    const prevDayLateNight = seedOrderAndBill({
      paidAtIsoUtc: '2026-09-09T21:00:00Z',
      paymentDetails: [{ method: 'card', amount: 300 }],
      items: [{ productId: 'prod-cake', name: 'Carrot Cake', qty: 2, unitPrice: 150 }],
    });

    // 2026-09-10 04:30 IST = 2026-09-09T23:00:00Z -> AFTER 04:00 cutoff -> business date 2026-09-10 (hour 04:00)
    const day10Early = seedOrderAndBill({
      paidAtIsoUtc: '2026-09-09T23:00:00Z',
      paymentDetails: [{ method: 'cash', amount: 210 }],
      items: [
        { productId: 'prod-latte', name: 'Latte', qty: 2, unitPrice: 100, tax: 10 },
        {
          productId: 'prod-water',
          name: 'Sparkling Water',
          qty: 5,
          unitPrice: 40,
          status: 'cancelled',
        },
      ],
    });

    // 2026-09-10 14:45 IST = 2026-09-10T09:15:00Z -> business date 2026-09-10 (hour 14:00)
    seedOrderAndBill({
      paidAtIsoUtc: '2026-09-10T09:15:00Z',
      paymentDetails: [
        { method: 'cash', amount: 90 },
        { method: 'card', amount: 50 },
      ],
      items: [{ productId: 'prod-tea', name: 'Masala Chai', qty: 5, unitPrice: 30, discount: 10 }],
    });

    // 2026-09-11 02:30 IST = 2026-09-10T21:00:00Z -> STILL business date 2026-09-10 (hour 02:00)!
    seedOrderAndBill({
      paidAtIsoUtc: '2026-09-10T21:00:00Z',
      paymentDetails: [{ method: 'upi', amount: 150 }],
      items: [{ productId: 'prod-mocha', name: 'Mocha', qty: 1, unitPrice: 150 }],
    });

    // Split order on 2026-09-10 18:20 IST = 2026-09-10T12:50:00Z (hour 18:00):
    // 4 Oat Cookies @ 50 = 200 total across 3 split bills: split A (qty 2, paid cash 100),
    // split B (qty 1, paid cash 50), split C (qty 1, UNPAID -> excluded).
    {
      const splitPaidAt = sqlTimestamp('2026-09-10T12:50:00Z');
      db.prepare(`
        INSERT INTO orders (order_number, user_id, type, status, subtotal, discount_amount, tax_amount, total, created_at, updated_at)
        VALUES ('ORD-SPLIT-1', 'owner-test-001', 'dine_in', 'ready', 200, 0, 0, 200, ?, ?)
      `).run(splitPaidAt, splitPaidAt);
      const splitOrderId = Number(
        db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-SPLIT-1'").get().id,
      );
      const oiRes = db
        .prepare(`
        INSERT INTO order_items (order_id, product_id, product_name, product_sku, quantity, unit_price, discount_amount, subtotal, tax_amount, total, status, created_at, updated_at)
        VALUES (?, 'prod-cookie', 'Oat Cookie', NULL, 4, 50, 0, 200, 0, 200, 'ready', ?, ?)
      `)
        .run(splitOrderId, splitPaidAt, splitPaidAt);
      const cookieOiId = Number(oiRes.lastInsertRowid);

      const bA = db
        .prepare(`
        INSERT INTO bills (bill_number, order_id, split_group_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
        VALUES ('BILL-SPLIT-A', ?, 'sg-1', 100, 100, 100, 0, 'paid', ?, ?, ?, ?)
      `)
        .run(
          splitOrderId,
          JSON.stringify([{ method: 'cash', amount: 100, timestamp: splitPaidAt }]),
          splitPaidAt,
          splitPaidAt,
          splitPaidAt,
        );
      db.prepare('INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (?, ?, 2)').run(
        Number(bA.lastInsertRowid),
        cookieOiId,
      );

      const bB = db
        .prepare(`
        INSERT INTO bills (bill_number, order_id, split_group_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
        VALUES ('BILL-SPLIT-B', ?, 'sg-1', 50, 50, 50, 0, 'paid', ?, ?, ?, ?)
      `)
        .run(
          splitOrderId,
          JSON.stringify([{ method: 'cash', amount: 50, timestamp: splitPaidAt }]),
          splitPaidAt,
          splitPaidAt,
          splitPaidAt,
        );
      db.prepare('INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (?, ?, 1)').run(
        Number(bB.lastInsertRowid),
        cookieOiId,
      );

      const bC = db
        .prepare(`
        INSERT INTO bills (bill_number, order_id, split_group_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
        VALUES ('BILL-SPLIT-C', ?, 'sg-1', 50, 50, 0, 50, 'unpaid', NULL, NULL, ?, ?)
      `)
        .run(splitOrderId, splitPaidAt, splitPaidAt);
      db.prepare('INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (?, ?, 1)').run(
        Number(bC.lastInsertRowid),
        cookieOiId,
      );
    }

    // Refunds issued inside business date 2026-09-10:
    // 1) Cash refund of 40 INR (4000 paise) at 2026-09-10 15:10 IST = 2026-09-10T09:40:00Z (hour 15:00, no bills in hour 15 -> negative hour sales -40)
    db.prepare(`
      INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, reason, shift_id, approved_by, created_by, created_at)
      VALUES (?, NULL, 4000, 'cash', 'adjustment', NULL, 'owner-test-001', 'owner-test-001', ?)
    `).run(day10Early.billId, sqlTimestamp('2026-09-10T09:40:00Z'));

    // 2) Card refund of 120 INR (12000 paise) at 2026-09-10 16:00 IST = 2026-09-10T10:30:00Z against prevDayLateNight bill!
    // Card collected on 2026-09-10 is 50, minus 120 refund = -70 signed net on card!
    db.prepare(`
      INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, reason, shift_id, approved_by, created_by, created_at)
      VALUES (?, NULL, 12000, 'card', 'prior bill return', NULL, 'owner-test-001', 'owner-test-001', ?)
    `).run(prevDayLateNight.billId, sqlTimestamp('2026-09-10T10:30:00Z'));

    // Reference oracle from Daily Sales Export for 2026-09-10 and 2026-09-09
    const dseSept10 = buildDailySalesExportDataset('2026-09-10', db);
    const dseSept09 = buildDailySalesExportDataset('2026-09-09', db);
    assertEqualOrThrow(dseSept09.summary.paid_bill_count, 1, '2026-09-09 has 1 late-night bill');
    assertEqualOrThrow(dseSept09.summary.net_collected, 300, '2026-09-09 net_collected is 300');

    // Gross on 2026-09-10: 210 + 140 + 150 + 100 + 50 = 650 (5 paid bills)
    // Refunds on 2026-09-10: 40 + 120 = 160 -> net_collected = 490
    assertEqualOrThrow(dseSept10.summary.paid_bill_count, 5, 'DSE Sept 10 paid_bill_count = 5');
    assertEqualOrThrow(dseSept10.summary.net_collected, 490, 'DSE Sept 10 net_collected = 490');

    // Verify 2026-09-09 dashboard isolates the 02:30 IST bill
    const dashSept09 = validateReportResponse(invokeReport('dashboard', { date: '2026-09-09' }), {
      view: 'dashboard',
      date: '2026-09-09',
    });
    assertEqualOrThrow(dashSept09.total_sales, 300, 'Sept 09 dashboard total_sales = 300');
    assertEqualOrThrow(dashSept09.bill_count, 1, 'Sept 09 dashboard bill_count = 1');

    // Verify 2026-09-10 dashboard matches DSE summary & items
    const dashSept10 = validateReportResponse(invokeReport('dashboard', { date: '2026-09-10' }), {
      view: 'dashboard',
      date: '2026-09-10',
    });
    assertEqualOrThrow(
      dashSept10.total_sales,
      dseSept10.summary.net_collected,
      'Sept 10 dashboard total_sales matches DSE net_collected (490)',
    );
    assertEqualOrThrow(
      dashSept10.bill_count,
      dseSept10.summary.paid_bill_count,
      'Sept 10 dashboard bill_count matches DSE paid_bill_count (5)',
    );
    assertEqualOrThrow(dashSept10.avg_order_value, 98, 'Sept 10 avg_order_value = 490 / 5 = 98');
    assertEqualOrThrow(
      dashSept10.total_tax,
      dseSept10.summary.tax_total,
      'Sept 10 total_tax matches DSE tax_total (10)',
    );
    assertEqualOrThrow(
      dashSept10.total_discount,
      dseSept10.summary.discount_total,
      'Sept 10 total_discount matches DSE discount_total (10)',
    );
    assertEqualOrThrow(dashSept10.payment_breakdown.cash, 410, 'Sept 10 cash net = 450 - 40 = 410');
    assertEqualOrThrow(dashSept10.payment_breakdown.upi, 150, 'Sept 10 upi net = 150');
    assertEqualOrThrow(
      dashSept10.payment_breakdown.card,
      -70,
      'Sept 10 card signed net = 50 - 120 = -70',
    );
    // Top items on Sept 10: Latte (200), Mocha (150), Oat Cookie (150, qty 3 from paid splits), Masala Chai (140, qty 5); cancelled Sparkling Water excluded!
    assertEqualOrThrow(dashSept10.top_items.length, 4, 'Sept 10 top_items excludes cancelled item');
    assertEqualOrThrow(dashSept10.top_items[0].name, 'Latte', 'Top item #1 is Latte');
    assertEqualOrThrow(dashSept10.top_items[0].revenue, 200, 'Latte net_item_sales = 200');
    const cookieTop = dashSept10.top_items.find((i: any) => i.name === 'Oat Cookie');
    assertOrThrow(Boolean(cookieTop), 'Oat Cookie present in top_items');
    assertEqualOrThrow(
      cookieTop.qty,
      3,
      'Paid split bills contribute qty 3 (unpaid split excluded)',
    );
    assertEqualOrThrow(cookieTop.revenue, 150, 'Paid split bills contribute net_item_sales 150');

    // Verify 2026-09-10 hourly report buckets by store-local IST hour and reconciles to net_collected & paid_bill_count
    const hourlySept10 = validateReportResponse(invokeReport('hourly', { date: '2026-09-10' }), {
      view: 'hourly',
      date: '2026-09-10',
    });
    const byHour = Object.fromEntries(hourlySept10.hours.map((h: any) => [h.hour, h]));
    assertEqualOrThrow(byHour['02:00'].sales, 150, '02:00 IST (next calendar morning) in Sept 10');
    assertEqualOrThrow(byHour['02:00'].bills, 1, '02:00 IST bills = 1');
    assertEqualOrThrow(byHour['04:00'].sales, 210, '04:00 IST sales = 210');
    assertEqualOrThrow(byHour['04:00'].bills, 1, '04:00 IST bills = 1');
    assertEqualOrThrow(byHour['14:00'].sales, 140, '14:00 IST sales = 140');
    assertEqualOrThrow(byHour['14:00'].bills, 1, '14:00 IST bills = 1');
    assertEqualOrThrow(byHour['15:00'].sales, -40, '15:00 IST refund-only slot is -40');
    assertEqualOrThrow(byHour['15:00'].bills, 0, '15:00 IST refund-only slot bills = 0');
    assertEqualOrThrow(byHour['16:00'].sales, -120, '16:00 IST card refund slot is -120');
    assertEqualOrThrow(byHour['18:00'].sales, 150, '18:00 IST 2 paid split bills sales = 150');
    assertEqualOrThrow(byHour['18:00'].bills, 2, '18:00 IST 2 paid split bills count = 2');
    const hourlySalesSum = hourlySept10.hours.reduce((s: number, h: any) => s + h.sales, 0);
    const hourlyBillsSum = hourlySept10.hours.reduce((s: number, h: any) => s + h.bills, 0);
    assertEqualOrThrow(hourlySalesSum, dseSept10.summary.net_collected, '24h sales sum == DSE net');
    assertEqualOrThrow(
      hourlyBillsSum,
      dseSept10.summary.paid_bill_count,
      '24h bills sum == DSE paid_bill_count',
    );

    // ── 3. Payments report signed net breakdown & zero-total percent ─────────
    console.log('\n─── 3. Payments report signed breakdown & zero-total handling ───');
    const paymentsSept10 = validateReportResponse(
      invokeReport('payments', { from: '2026-09-10', to: '2026-09-10' }),
      { view: 'payments', from: '2026-09-10', to: '2026-09-10' },
    );
    assertEqualOrThrow(paymentsSept10.total, 490, 'payments total == 490');
    const pmMap = Object.fromEntries(paymentsSept10.breakdown.map((b: any) => [b.method, b]));
    assertEqualOrThrow(pmMap.cash.amount, 410, 'payments cash signed net = 410');
    assertEqualOrThrow(pmMap.upi.amount, 150, 'payments upi net = 150');
    assertEqualOrThrow(pmMap.card.amount, -70, 'payments card signed net = -70');

    // Add a day (2026-09-12) where a 100 cash sale + 100 card refund yields net total === 0
    seedOrderAndBill({
      paidAtIsoUtc: '2026-09-12T06:00:00Z',
      paymentDetails: [{ method: 'cash', amount: 100 }],
      items: [{ productId: 'prod-latte', name: 'Latte', qty: 1, unitPrice: 100 }],
    });
    db.prepare(`
      INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, reason, shift_id, approved_by, created_by, created_at)
      VALUES (?, NULL, 10000, 'card', 'offsetting refund', NULL, 'owner-test-001', 'owner-test-001', ?)
    `).run(prevDayLateNight.billId, sqlTimestamp('2026-09-12T07:00:00Z'));

    const paymentsZeroNet = validateReportResponse(
      invokeReport('payments', { from: '2026-09-12', to: '2026-09-12' }),
      { view: 'payments', from: '2026-09-12', to: '2026-09-12' },
    );
    assertEqualOrThrow(paymentsZeroNet.total, 0, 'offsetting day total === 0');
    assertOrThrow(
      paymentsZeroNet.breakdown.every((b: any) => b.percent === 0),
      'percent is 0 (finite) when total === 0',
    );

    // ── 4. Items report sort_by ('revenue' vs 'qty') & limit ─────────────────
    console.log('\n─── 4. Items report sort_by (revenue vs qty), tie-break, limit ───');
    const itemsByRev = validateReportResponse(
      invokeReport('items', {
        from: '2026-09-10',
        to: '2026-09-10',
        sort_by: 'revenue',
        limit: 3,
      }),
      { view: 'items', from: '2026-09-10', to: '2026-09-10', sort_by: 'revenue', limit: 3 },
    );
    assertEqualOrThrow(itemsByRev.items.length, 3, 'items sliced to limit=3');
    // Sept 10 revenues: Latte (200, qty 2), Oat Cookie (150, qty 3), Mocha (150, qty 1), Masala Chai (140, qty 5)
    // Notice tie-break on revenue=150: Oat Cookie (qty 3) > Mocha (qty 1)!
    assert.deepEqual(
      itemsByRev.items.map((i: any) => ({
        name: i.name,
        qty_sold: i.qty_sold,
        revenue: i.revenue,
      })),
      [
        { name: 'Latte', qty_sold: 2, revenue: 200 },
        { name: 'Oat Cookie', qty_sold: 3, revenue: 150 },
        { name: 'Mocha', qty_sold: 1, revenue: 150 },
      ],
    );

    const itemsByQty = validateReportResponse(
      invokeReport('items', {
        from: '2026-09-10',
        to: '2026-09-10',
        sort_by: 'qty',
        limit: 2,
      }),
      { view: 'items', from: '2026-09-10', to: '2026-09-10', sort_by: 'qty', limit: 2 },
    );
    // Sept 10 quantities: Masala Chai (qty 5, rev 140), Oat Cookie (qty 3, rev 150)
    assert.deepEqual(
      itemsByQty.items.map((i: any) => ({
        name: i.name,
        qty_sold: i.qty_sold,
        revenue: i.revenue,
      })),
      [
        { name: 'Masala Chai', qty_sold: 5, revenue: 140 },
        { name: 'Oat Cookie', qty_sold: 3, revenue: 150 },
      ],
    );

    // ── 5. Sales report group_by ('day', 'week', 'month') period clamping ────
    console.log('\n─── 5. Sales report group_by day/week/month & period clamping ───');
    // Seed an October bill so range 2026-09-10 (Thu) .. 2026-10-05 (Mon) spans mid-week & mid-month
    seedOrderAndBill({
      paidAtIsoUtc: '2026-10-03T08:00:00Z',
      paymentDetails: [{ method: 'cash', amount: 250 }],
      items: [{ productId: 'prod-cake', name: 'Carrot Cake', qty: 1, unitPrice: 250 }],
    });

    const salesDay = validateReportResponse(
      invokeReport('sales', { from: '2026-09-10', to: '2026-10-05', group_by: 'day' }),
      { view: 'sales', from: '2026-09-10', to: '2026-10-05', group_by: 'day' },
    );
    assertEqualOrThrow(salesDay.data.length, 26, '26 daily rows in 2026-09-10..2026-10-05');
    assertEqualOrThrow(salesDay.data[0].period, '2026-09-10', 'first day period');
    assertEqualOrThrow(salesDay.data[0].total, 490, 'Sept 10 net total = 490');
    assertEqualOrThrow(salesDay.data[0].bill_count, 5, 'Sept 10 bill_count = 5');

    const salesWeek = validateReportResponse(
      invokeReport('sales', { from: '2026-09-10', to: '2026-10-05', group_by: 'week' }),
      { view: 'sales', from: '2026-09-10', to: '2026-10-05', group_by: 'week' },
    );
    // 2026-09-10 is Thursday -> Monday was 2026-09-07, MUST clamp to meta.from = 2026-09-10!
    assertEqualOrThrow(
      salesWeek.data[0].period,
      '2026-09-10',
      'first partial week period clamped to meta.from (2026-09-10)',
    );
    assertEqualOrThrow(salesWeek.data[1].period, '2026-09-14', 'second week starts Monday');
    assertEqualOrThrow(
      salesWeek.data.reduce((s: number, r: any) => s + r.total, 0),
      490 + 0 + 250,
      'weekly bucket totals reconcile to range net_collected (740)',
    );

    const salesMonth = validateReportResponse(
      invokeReport('sales', { from: '2026-09-10', to: '2026-10-05', group_by: 'month' }),
      { view: 'sales', from: '2026-09-10', to: '2026-10-05', group_by: 'month' },
    );
    assertEqualOrThrow(salesMonth.data.length, 2, '2 monthly buckets');
    assertEqualOrThrow(
      salesMonth.data[0].period,
      '2026-09-10',
      'September bucket clamped to meta.from (2026-09-10, not 2026-09-01)',
    );
    assertEqualOrThrow(salesMonth.data[0].total, 490, 'September net = 490');
    assertEqualOrThrow(salesMonth.data[1].period, '2026-10-01', 'October bucket = 2026-10-01');
    assertEqualOrThrow(salesMonth.data[1].total, 250, 'October net = 250');

    // ── 6. Relative ranges & 370-day explicit span vs 93-day DSE file limit ──
    console.log('\n─── 6. Relative ranges (today/yesterday/last7/last30) & 370-day limit ───');
    validateReportResponse(invokeReport('dashboard', { range: 'today' }), {
      view: 'dashboard',
      range: 'today',
    });
    validateReportResponse(invokeReport('hourly', { range: 'yesterday' }), {
      view: 'hourly',
      range: 'yesterday',
    });
    for (const preset of ['today', 'yesterday', 'last7', 'last30'] as const) {
      validateReportResponse(invokeReport('sales', { range: preset }), {
        view: 'sales',
        range: preset,
      });
      validateReportResponse(invokeReport('items', { range: preset }), {
        view: 'items',
        range: preset,
      });
      validateReportResponse(invokeReport('payments', { range: preset }), {
        view: 'payments',
        range: preset,
      });
    }

    // 370 inclusive days: 2025-10-01 .. 2026-10-05 (370 days: 31+30+31+31+28+31+30+31+30+31+31+30+5 = 370)
    assertEqualOrThrow(
      inclusiveDayCount('2025-10-01', '2026-10-05'),
      370,
      'test span is exactly 370 inclusive days',
    );
    const sales370 = validateReportResponse(
      invokeReport('sales', { from: '2025-10-01', to: '2026-10-05' }),
      { view: 'sales', from: '2025-10-01', to: '2026-10-05' },
    );
    assertEqualOrThrow(sales370.data.length, 370, '370-day sales report returns 370 daily rows');

    // Confirm Daily Sales Export default 93-day limit is completely preserved!
    assertEqualOrThrow(DAILY_SALES_EXPORT_MAX_RANGE_DAYS, 93, 'DSE max range constant remains 93');
    assert.throws(
      () => resolveDailySalesExportRange({ from: '2026-01-01', to: '2026-04-05' }),
      /93 days/,
      'resolveDailySalesExportRange still rejects > 93 days by default',
    );
    assert.throws(
      () => buildDailySalesExportDataset({ from: '2026-01-01', to: '2026-04-05' }, db),
      /93 days/,
      'buildDailySalesExportDataset still rejects > 93 days by default',
    );

    // ── 7. Multi-currency fraction_digits & US DST boundary clock consistency ─
    console.log('\n─── 7. Currency fraction_digits (BHD=3, JPY=0) & DST boundaries ───');
    setSetting('country', 'BH');
    setSetting('currency', 'BHD');
    setSetting('timezone', 'America/New_York');
    setSetting('business_day_start_time', '05:00');

    const bhdDash = validateReportResponse(invokeReport('dashboard', { date: '2026-03-08' }), {
      view: 'dashboard',
      date: '2026-03-08',
    });
    assertEqualOrThrow(bhdDash.meta.currency, 'BHD', 'BHD currency');
    assertEqualOrThrow(bhdDash.meta.fraction_digits, 3, 'BHD fraction_digits = 3');
    assertEqualOrThrow(bhdDash.meta.timezone, 'America/New_York', 'America/New_York timezone');
    assertEqualOrThrow(bhdDash.meta.business_day_start, '05:00', '05:00 cutoff');

    setSetting('country', 'JP');
    setSetting('currency', 'JPY');
    const jpyDash = validateReportResponse(invokeReport('dashboard', { date: '2026-11-01' }), {
      view: 'dashboard',
      date: '2026-11-01',
    });
    assertEqualOrThrow(jpyDash.meta.currency, 'JPY', 'JPY currency');
    assertEqualOrThrow(jpyDash.meta.fraction_digits, 0, 'JPY fraction_digits = 0');

    // Exact cutoff millisecond & DST transition clock snapshots (generated_at <= current_business_day_ends_at)
    setSetting('country', 'US');
    setSetting('currency', 'USD');
    setSetting('timezone', 'America/New_York');
    setSetting('business_day_start_time', '05:00');
    // Spring-forward day 2026-03-08: 05:00 EDT = 09:00:00Z (23h business day from 2026-03-07 10:00Z to 2026-03-08 09:00Z)
    const beforeSpringCutoff = validateReportResponse(
      { result: (service as any).dashboardReport({}, new Date('2026-03-08T08:59:59.999Z')) },
      { view: 'dashboard' },
    );
    assertEqualOrThrow(
      beforeSpringCutoff.meta.current_business_date,
      '2026-03-07',
      '1ms before spring-forward 05:00 EDT cutoff stays on 2026-03-07',
    );
    assertEqualOrThrow(
      Date.parse(beforeSpringCutoff.meta.current_business_day_ends_at),
      Date.parse('2026-03-08T09:00:00.000Z'),
      'spring-forward ends_at is 2026-03-08T09:00:00Z',
    );
    const atSpringCutoff = validateReportResponse(
      { result: (service as any).dashboardReport({}, new Date('2026-03-08T09:00:00.000Z')) },
      { view: 'dashboard' },
    );
    assertEqualOrThrow(
      atSpringCutoff.meta.current_business_date,
      '2026-03-08',
      'exact 05:00 EDT cutoff rolls over to 2026-03-08',
    );
    // Fall-back day 2026-11-01 with 01:30 cutoff (repeated hour): first 01:15 EDT vs second 01:15 EST
    setSetting('business_day_start_time', '01:30');
    const fallBackBefore = validateReportResponse(
      { result: (service as any).hourlyReport({}, new Date('2026-11-01T05:15:00.000Z')) },
      { view: 'hourly' },
    );
    assertEqualOrThrow(
      fallBackBefore.meta.current_business_date,
      '2026-10-31',
      '01:15 EDT before 01:30 cutoff stays 2026-10-31',
    );
    const fallBackAfter = validateReportResponse(
      { result: (service as any).hourlyReport({}, new Date('2026-11-01T06:15:00.000Z')) },
      { view: 'hourly' },
    );
    assertEqualOrThrow(
      fallBackAfter.meta.current_business_date,
      '2026-11-01',
      'second 01:15 EST after 01:30 EDT cutoff is 2026-11-01',
    );

    // ── 8. Selector & parameter validation rejections ────────────────────────
    console.log('\n─── 8. Selector & parameter validation rejections ───');
    validateReportResponse(
      invokeReport('dashboard', {
        view: null,
        date: '2026-09-10',
        range: '',
        from: null,
        to: '',
        group_by: null,
        sort_by: '',
        limit: null,
      }),
      { view: 'dashboard', date: '2026-09-10' },
    );
    validateReportResponse(
      invokeReport('hourly', {
        view: '',
        date: '2026-09-10',
        range: null,
        from: '',
        to: null,
        group_by: '',
        sort_by: null,
        limit: '',
      }),
      { view: 'hourly', date: '2026-09-10' },
    );
    validateReportResponse(
      invokeReport('sales', {
        view: null,
        range: 'last7',
        date: '',
        from: null,
        to: null,
        group_by: '',
        sort_by: null,
        limit: '',
      }),
      { view: 'sales', range: 'last7' },
    );
    validateReportResponse(
      invokeReport('sales', {
        from: '',
        to: '',
        group_by: null,
      }),
      { view: 'sales', range: 'last7' },
    );
    validateReportResponse(
      invokeReport('items', {
        view: '',
        range: 'today',
        date: null,
        from: '',
        to: null,
        group_by: null,
        sort_by: '',
        limit: null,
      }),
      { view: 'items', range: 'today' },
    );
    validateReportResponse(
      invokeReport('payments', {
        view: null,
        range: 'yesterday',
        date: '',
        from: null,
        to: '',
        group_by: '',
        sort_by: null,
        limit: '',
      }),
      { view: 'payments', range: 'yesterday' },
    );

    const badCalls: Array<[string, () => unknown]> = [
      ['371-day range', () => invokeReport('sales', { from: '2025-09-30', to: '2026-10-05' })],
      ['from > to', () => invokeReport('sales', { from: '2026-09-12', to: '2026-09-10' })],
      ['from without to', () => invokeReport('items', { from: '2026-09-10' })],
      ['from with null to', () => invokeReport('items', { from: '2026-09-10', to: null })],
      ['empty from with to', () => invokeReport('payments', { from: '', to: '2026-09-10' })],
      ['to without from', () => invokeReport('payments', { to: '2026-09-10' })],
      ['invalid calendar date Feb 30', () => invokeReport('dashboard', { date: '2026-02-30' })],
      ['malformed date', () => invokeReport('hourly', { date: '10-09-2026' })],
      [
        'range combined with from/to',
        () => invokeReport('sales', { range: 'last7', from: '2026-09-01', to: '2026-09-07' }),
      ],
      [
        'range combined with date',
        () => invokeReport('dashboard', { range: 'today', date: '2026-09-10' }),
      ],
      [
        'from/to on single-day dashboard',
        () => invokeReport('dashboard', { from: '2026-09-01', to: '2026-09-02' }),
      ],
      [
        'from/to on single-day hourly',
        () => invokeReport('hourly', { from: '2026-09-01', to: '2026-09-01' }),
      ],
      ['last7 on single-day dashboard', () => invokeReport('dashboard', { range: 'last7' })],
      ['date on range sales', () => invokeReport('sales', { date: '2026-09-10' })],
      ['unknown range preset', () => invokeReport('sales', { range: 'last90' })],
      ['invalid group_by', () => invokeReport('sales', { group_by: 'quarter' })],
      ['invalid sort_by', () => invokeReport('items', { sort_by: 'margin' })],
      ['items limit 0', () => invokeReport('items', { limit: 0 })],
      ['items limit 101', () => invokeReport('items', { limit: 101 })],
      ['items limit non-integer', () => invokeReport('items', { limit: 12.5 })],
      ['items limit non-numeric', () => invokeReport('items', { limit: 'abc' })],
    ];
    for (const [label, fn] of badCalls) {
      let threw = false;
      try {
        fn();
      } catch {
        threw = true;
      }
      assertOrThrow(threw, `rejects invalid selector: ${label}`);
    }

    // ── 9. Regional resolution parity with Daily Sales Export ───────────────
    console.log('\n─── 9. Regional resolution parity & unconfigured country rejection ───');
    setSetting('country', 'IN');
    setSetting('currency', 'INR');
    setSetting('timezone', 'Invalid/Zone');
    setSetting('business_day_start_time', '04:00');
    const fallbackCountryTz = validateReportResponse(
      invokeReport('dashboard', { date: '2026-09-10' }),
      {
        view: 'dashboard',
        date: '2026-09-10',
      },
    );
    assertEqualOrThrow(
      fallbackCountryTz.meta.timezone,
      'Asia/Kolkata',
      'invalid timezone setting falls back to country timezone (matching resolveExportTimezone)',
    );

    db.prepare("DELETE FROM settings WHERE key = 'country'").run();
    assert.throws(
      () => invokeReport('dashboard', { date: '2026-09-10' }),
      /Regional settings are not configured/,
      'unconfigured country throws RegionalNotConfiguredError without UTC fallback',
    );

    console.log('\nAll Cloud live-reports v1 tests passed!');
  } finally {
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});

/**
 * FloDesktop DB Integrity Audit
 *
 * Walks the SQLite file(s) and reports:
 *   - SQLite built-in integrity_check + foreign_key_check
 *   - Orphaned foreign keys on every relation we care about
 *   - Missing/empty/NULL ids on every table with a PRIMARY KEY
 *   - Duplicate ids (shouldn't happen under PK, but verify)
 *   - Missing seed rows (default owner, settings, schema_version)
 *
 * Usage:
 *   npm run test:db-audit
 *   FLO_DB=/path/to/flo.db npm run test:db-audit
 */

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

type Database = InstanceType<typeof DatabaseSync>;

const candidatePaths = [
  process.env.FLO_DB,
  path.join(os.homedir(), 'Sites/flo.db'),
  path.join(os.homedir(), 'Library/Application Support/Flo/flo.db'),
  path.join(process.cwd(), 'flo.db'),
  path.join(process.cwd(), '..', 'flo.db'),
].filter(Boolean) as string[];

console.log('🔍 FloDesktop DB Integrity Audit');
console.log('='.repeat(60));

const targets: string[] = [];
for (const p of candidatePaths) {
  try {
    const stat = fs.statSync(p);
    if (stat.isFile() && stat.size > 0 && !targets.includes(p)) targets.push(p);
  } catch {}
}

if (targets.length === 0) {
  console.log('\n⚠️  No non-empty flo.db file found — skipping audit.');
  console.log('   Checked:');
  for (const p of candidatePaths) console.log('     - ' + p);
  console.log('\n   This is expected in CI or fresh installs.');
  process.exit(0); // Not a failure — just nothing to audit
}

let totalIssues = 0;

for (const dbPath of targets) {
  console.log('\n📂 Auditing: ' + dbPath);
  const size = fs.statSync(dbPath).size;
  console.log('   Size: ' + (size / 1024).toFixed(1) + ' KB');

  const db: Database = new DatabaseSync(dbPath, { open: true, readOnly: true });
  let issues = 0;

  const section = (name: string) => console.log('\n── ' + name + ' ──');
  const ok = (msg: string) => console.log('   ✓ ' + msg);
  const warn = (msg: string) => { console.log('   ⚠ ' + msg); issues++; };
  const fail = (msg: string) => { console.log('   ✗ ' + msg); issues++; };

  const tableExists = (name: string): boolean => {
    const row = db.prepare(`SELECT 1 as x FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
    return !!row;
  };

  const columns = (table: string): string[] => {
    try {
      return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
    } catch {
      return [];
    }
  };

  const count = (sql: string, params: any[] = []): number => {
    try {
      const row = db.prepare(sql).get(...params) as any;
      return row ? Object.values(row)[0] as number : 0;
    } catch (err: any) {
      warn('query failed: ' + sql + ' — ' + err.message);
      return 0;
    }
  };

  const tables = (db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as any[]).map((r) => r.name);

  section('Schema');
  console.log('   Tables found: ' + tables.length);
  console.log('   ' + tables.join(', '));

  const schemaVersionRow = tableExists('settings')
    ? db.prepare(`SELECT value FROM settings WHERE key='schema_version'`).get() as any
    : null;
  if (schemaVersionRow) ok('schema_version = ' + schemaVersionRow.value);
  else fail('settings.schema_version missing');

  section('SQLite built-in integrity_check');
  const integrity = db.prepare('PRAGMA integrity_check').all() as any[];
  const integrityResults = integrity.map((r) => r.integrity_check);
  if (integrityResults.length === 1 && integrityResults[0] === 'ok') {
    ok('integrity_check: ok');
  } else {
    for (const r of integrityResults) fail('integrity: ' + r);
  }

  section('SQLite built-in foreign_key_check');
  const fkCheck = db.prepare('PRAGMA foreign_key_check').all() as any[];
  if (fkCheck.length === 0) {
    ok('no declared-FK violations');
  } else {
    for (const r of fkCheck) fail(`FK violation in ${r.table} rowid=${r.rowid} → ${r.parent}.${r.fkid}`);
  }

  section('NULL / empty ids');
  const pkTables: { table: string; pk: string }[] = [
    { table: 'categories', pk: 'id' },
    { table: 'products', pk: 'id' },
    { table: 'addon_groups', pk: 'id' },
    { table: 'addons', pk: 'id' },
    { table: 'tables', pk: 'id' },
    { table: 'customers', pk: 'id' },
    { table: 'users', pk: 'id' },
    { table: 'orders', pk: 'id' },
    { table: 'order_items', pk: 'id' },
    { table: 'bills', pk: 'id' },
    { table: 'printers', pk: 'id' },
    { table: 'kitchen_stations', pk: 'id' },
    { table: 'kds_pairing_tokens', pk: 'id' },
    { table: 'loyalty_ledger', pk: 'id' },
  ];
  for (const { table, pk } of pkTables) {
    if (!tableExists(table)) { warn(table + ' — table missing'); continue; }
    const nulls = count(`SELECT COUNT(*) FROM ${table} WHERE ${pk} IS NULL`);
    const empties = count(`SELECT COUNT(*) FROM ${table} WHERE CAST(${pk} AS TEXT) = ''`);
    const total = count(`SELECT COUNT(*) FROM ${table}`);
    const dupes = count(`
      SELECT COUNT(*) FROM (SELECT ${pk} FROM ${table} GROUP BY ${pk} HAVING COUNT(*) > 1)
    `);
    const label = `${table} (${total} rows)`;
    if (nulls === 0 && empties === 0 && dupes === 0) {
      ok(label + ': all ids present and unique');
    } else {
      if (nulls) fail(label + ': ' + nulls + ' NULL ids');
      if (empties) fail(label + ': ' + empties + ' empty-string ids');
      if (dupes) fail(label + ': ' + dupes + ' duplicate ids');
    }
  }

  section('Orphaned foreign keys');
  const relations: { child: string; childCol: string; parent: string; parentCol?: string; label?: string }[] = [
    { child: 'products', childCol: 'category_id', parent: 'categories' },
    { child: 'addons', childCol: 'addon_group_id', parent: 'addon_groups' },
    { child: 'addon_group_product', childCol: 'product_id', parent: 'products' },
    { child: 'addon_group_product', childCol: 'addon_group_id', parent: 'addon_groups' },
    { child: 'orders', childCol: 'table_id', parent: 'tables' },
    { child: 'orders', childCol: 'customer_id', parent: 'customers' },
    { child: 'orders', childCol: 'user_id', parent: 'users' },
    { child: 'order_items', childCol: 'order_id', parent: 'orders' },
    { child: 'order_items', childCol: 'product_id', parent: 'products' },
    { child: 'bills', childCol: 'order_id', parent: 'orders' },
    { child: 'bills', childCol: 'customer_id', parent: 'customers' },
    { child: 'loyalty_ledger', childCol: 'customer_id', parent: 'customers' },
    { child: 'loyalty_ledger', childCol: 'bill_id', parent: 'bills' },
    { child: 'tables', childCol: 'kitchen_station_id', parent: 'kitchen_stations' },
  ];

  for (const rel of relations) {
    const parentCol = rel.parentCol || 'id';
    if (!tableExists(rel.child) || !tableExists(rel.parent)) continue;
    if (!columns(rel.child).includes(rel.childCol)) continue;
    const orphans = count(`
      SELECT COUNT(*) FROM ${rel.child} c
      WHERE c.${rel.childCol} IS NOT NULL
        AND c.${rel.childCol} NOT IN (SELECT ${parentCol} FROM ${rel.parent})
    `);
    const label = `${rel.child}.${rel.childCol} → ${rel.parent}.${parentCol}`;
    if (orphans === 0) ok(label + ': clean');
    else fail(label + ': ' + orphans + ' orphaned row(s)');
  }

  section('Seed data sanity');
  if (tableExists('users')) {
    const owners = count(`SELECT COUNT(*) FROM users WHERE role = 'owner' AND is_active = 1`);
    if (owners === 0) fail('no active owner user — login will be impossible');
    else ok(owners + ' active owner user(s)');

    const noEmail = count(`SELECT COUNT(*) FROM users WHERE email IS NULL OR email = ''`);
    if (noEmail > 0) warn(noEmail + ' user(s) without email');

    const noPassword = count(`SELECT COUNT(*) FROM users WHERE password IS NULL OR password = ''`);
    if (noPassword > 0) fail(noPassword + ' user(s) without password hash');
  }

  if (tableExists('printers')) {
    const defaults = count(`SELECT COUNT(*) FROM printers WHERE is_default = 1`);
    if (defaults === 0) warn('no default printer configured');
    else if (defaults > 1) fail(defaults + ' printers marked as default (expect exactly 1)');
    else ok('exactly 1 default printer');
  }

  if (tableExists('settings')) {
    const required = ['business_name', 'currency', 'timezone', 'schema_version'];
    for (const key of required) {
      const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any;
      if (!r || r.value === null || r.value === '') warn('settings missing required key: ' + key);
    }
  }

  section('Orders / bills consistency');
  if (tableExists('bills') && tableExists('orders')) {
    const billsNoOrder = count(`
      SELECT COUNT(*) FROM bills b
      WHERE b.order_id NOT IN (SELECT id FROM orders)
    `);
    if (billsNoOrder > 0) fail(billsNoOrder + ' bills reference a non-existent order');
    else ok('all bills point to a real order');

    const multiBill = count(`
      SELECT COUNT(*) FROM (
        SELECT order_id FROM bills GROUP BY order_id HAVING COUNT(*) > 1
      )
    `);
    if (multiBill > 0) warn(multiBill + ' order(s) have multiple bills');
    else ok('each order has at most one bill');
  }

  if (tableExists('orders') && tableExists('order_items')) {
    const ordersNoItems = count(`
      SELECT COUNT(*) FROM orders o
      WHERE o.id NOT IN (SELECT order_id FROM order_items)
    `);
    if (ordersNoItems > 0) warn(ordersNoItems + ' order(s) have no order_items');
    else ok('every order has at least one item');
  }

  if (tableExists('bills')) {
    const badTotals = count(`
      SELECT COUNT(*) FROM bills
      WHERE ABS(COALESCE(total,0) - (COALESCE(subtotal,0) + COALESCE(tax_amount,0) + COALESCE(packaging_charge,0) + COALESCE(delivery_charge,0) - COALESCE(discount_amount,0) + COALESCE(round_off,0))) > 0.02
    `);
    if (badTotals > 0) warn(badTotals + ' bills where total ≠ subtotal+tax+charges-discount+round_off');
    else ok('bill totals match component sums');

    const balanceMismatch = count(`
      SELECT COUNT(*) FROM bills
      WHERE ABS(COALESCE(balance,0) - (COALESCE(total,0) - COALESCE(paid_amount,0))) > 0.02
    `);
    if (balanceMismatch > 0) warn(balanceMismatch + ' bills where balance ≠ total - paid_amount');
    else ok('bill balances match total - paid');

    const paidNoDetails = count(`
      SELECT COUNT(*) FROM bills
      WHERE payment_status = 'paid' AND (payment_details IS NULL OR payment_details = '' OR payment_details = '[]')
    `);
    if (paidNoDetails > 0) warn(paidNoDetails + ' paid bills with no payment_details');
  }

  section('JSON field sanity (order_items)');
  if (tableExists('order_items')) {
    const rows = db.prepare(`
      SELECT id, addons, variant_selection, modifier_selection, tax_breakdown
      FROM order_items
    `).all() as any[];
    let badJson = 0;
    for (const r of rows) {
      for (const col of ['addons', 'variant_selection', 'modifier_selection', 'tax_breakdown']) {
        const val = r[col];
        if (val == null || val === '') continue;
        try { JSON.parse(val); } catch { badJson++; fail(`order_items.${r.id}.${col}: invalid JSON`); }
      }
    }
    if (badJson === 0) ok('all JSON fields parse cleanly');
  }

  section('KDS pairing tokens');
  if (tableExists('kds_pairing_tokens')) {
    const expired = count(`
      SELECT COUNT(*) FROM kds_pairing_tokens
      WHERE expires_at IS NOT NULL AND expires_at < datetime('now')
    `);
    const total = count(`SELECT COUNT(*) FROM kds_pairing_tokens`);
    if (total === 0) ok('no tokens (clean)');
    else if (expired > 0) warn(expired + '/' + total + ' pairing tokens expired (consider pruning)');
    else ok(total + ' active pairing token(s)');
  }

  db.close();
  console.log('\n' + '─'.repeat(60));
  console.log(issues === 0 ? '   ✅ Clean — no cracks found.' : '   ⚠ ' + issues + ' issue(s) in this DB.');
  totalIssues += issues;
}

console.log('\n' + '='.repeat(60));
console.log(totalIssues === 0 ? '🏁 All databases clean.' : '🏁 ' + totalIssues + ' total issue(s) across ' + targets.length + ' database(s).');
process.exit(totalIssues === 0 ? 0 : 1);

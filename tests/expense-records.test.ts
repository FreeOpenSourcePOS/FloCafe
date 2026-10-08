/**
 * Expense records: schema shape, upgrade path, and ledger constraints.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/expense-records.test.ts
 *
 * Covers the schema half of the expense boundary: a fresh install reaches the
 * registered expense migration, a populated prior-version database upgrades
 * without touching orders/supplies/cash rows, and the native CHECK/UNIQUE/FK
 * constraints that make the expense ledger immutable actually reject bad
 * writes.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-expense-records-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initDatabase, getDatabase, closeDatabase, getCurrentSchemaVersion,
  buildIdealSchemaDb, MIGRATIONS, now,
} = require('../main/db');
const {
  assertOrThrow, assertEqualOrThrow, assertIncludesOrThrow, assertGreaterThanOrThrow, getResults, resetCounters,
} = require('./helpers/test-setup');

const EXPENSE_TABLES = ['expense_categories', 'expenses', 'expense_payments', 'expense_mutations'];

function tableNames(db: any): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
    .map((row) => row.name);
}

function indexNames(db: any, table: string): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`).all(table) as { name: string }[])
    .map((row) => row.name);
}

function columns(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
}

function throwsSqlite(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/** Deep-equal row snapshots; JSON of ordered selects is enough for row fidelity. */
function snapshot(db: any, selects: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [label, sql] of Object.entries(selects)) out[label] = JSON.stringify(db.prepare(sql).all());
  return out;
}

function backupFiles(): string[] {
  const dir = path.join(testDir, 'backups');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.db')).sort();
}

const PRISTINE_MIGRATIONS = MIGRATIONS.slice();
const LATEST_VERSION = PRISTINE_MIGRATIONS[PRISTINE_MIGRATIONS.length - 1].version;
const PRIOR_VERSION = LATEST_VERSION - 1;

function seedPopulatedPriorDatabase(db: any): void {
  const ts = now();
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('exp-owner', 'Owner', 'exp-owner@test.local', 'x', 'owner', 1, ?, ?)`).run(ts, ts);
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('exp-cat', 'Expense Fixture Category', 1)`).run();
  db.prepare(`INSERT INTO products (id, name, price, category_id, is_active, created_at, updated_at)
    VALUES ('exp-product', 'Fixture Coffee', 60, 'exp-cat', 1, ?, ?)`).run(ts, ts);
  db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, tax_amount, total, created_at, updated_at)
    VALUES ('EXP-ORD-1', 'dine_in', 'completed', 60, 0, 60, ?, ?)`).run(ts, ts);
  const orderId = Number(db.prepare(`SELECT id FROM orders WHERE order_number = 'EXP-ORD-1'`).get().id);
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, total, status, created_at, updated_at)
    VALUES (?, 'exp-product', 'Fixture Coffee', 1, 60, 60, 60, 'served', ?, ?)`).run(orderId, ts, ts);
  db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, total, payment_status, paid_amount, balance, created_at, updated_at)
    VALUES ('EXP-INV-1', ?, 60, 0, 60, 'paid', 60, 0, ?, ?)`).run(orderId, ts, ts);
  db.prepare(`INSERT INTO supplies (id, name, base_unit, stock_quantity, low_stock_threshold, is_active, created_at, updated_at)
    VALUES ('exp-supply', 'Fixture Beans', 'kg', 4, 1, 1, ?, ?)`).run(ts, ts);
  db.prepare(`INSERT INTO supply_movements (supply_id, quantity_delta, movement_type, unit, stock_after, reason, actor_user_id, created_at)
    VALUES ('exp-supply', 4, 'receive', 'kg', 4, 'Fixture delivery', 'exp-owner', ?)`).run(ts);
  db.prepare(`INSERT INTO cash_sessions (opened_by, opened_at, opening_float_cents, status)
    VALUES ('exp-owner', ?, 20000, 'open')`).run(ts);
  db.prepare(`INSERT INTO cash_drawer_movements (business_date, movement_type, amount_cents, reason, created_by, created_at)
    VALUES (?, 'opening_float', 20000, 'Fixture float', 'exp-owner', ?)`).run(ts.slice(0, 10), ts);
}

function main(): void {
  resetCounters();
  console.log('Expense records schema and upgrade test');
  console.log('='.repeat(50));

  // The literal is the version this migration was registered with, which never
  // changes; the fixture below stays dynamic, so a later migration does not
  // stale this suite.
  const expenseMigration = PRISTINE_MIGRATIONS.find((migration: any) => migration.name === 'add_expense_records');
  assertOrThrow(expenseMigration, 'the expense records migration is registered');
  assertEqualOrThrow(expenseMigration.version, 108, 'the expense records migration keeps its registered version');

  // ── Upgrade: a populated v107 database reaches v108 without losing rows ──
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...PRISTINE_MIGRATIONS.filter((migration: any) => migration.version <= PRIOR_VERSION));
  initDatabase();
  let db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), PRIOR_VERSION, 'fixture database starts one version behind');
  seedPopulatedPriorDatabase(db);

  const preservedSelections = {
    users: `SELECT id, name, email, role FROM users ORDER BY id`,
    orders: `SELECT * FROM orders ORDER BY id`,
    order_items: `SELECT * FROM order_items ORDER BY id`,
    bills: `SELECT * FROM bills ORDER BY id`,
    supplies: `SELECT * FROM supplies ORDER BY id`,
    supply_movements: `SELECT * FROM supply_movements ORDER BY id`,
    cash_sessions: `SELECT * FROM cash_sessions ORDER BY id`,
    cash_drawer_movements: `SELECT * FROM cash_drawer_movements ORDER BY id`,
  };
  const before = snapshot(db, preservedSelections);
  const backupsBefore = backupFiles().length;
  closeDatabase();

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...PRISTINE_MIGRATIONS);
  initDatabase();
  db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), LATEST_VERSION, 'populated prior database upgrades to the registry tail');

  const after = snapshot(db, preservedSelections);
  for (const label of Object.keys(preservedSelections)) {
    assertEqualOrThrow(after[label], before[label], `migration leaves ${label} unchanged`);
  }

  for (const table of EXPENSE_TABLES) {
    assertOrThrow(tableNames(db).includes(table), `${table} exists after the upgrade`);
    assertEqualOrThrow(
      (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
      0,
      `${table} is created empty by the migration`,
    );
  }

  const backupNames = backupFiles();
  assertGreaterThanOrThrow(backupNames.length, backupsBefore, 'the upgrade writes a pre-migration backup');
  assertOrThrow(
    backupNames.some((name) => name.includes(`pre-v${PRIOR_VERSION}-to-v${LATEST_VERSION}`)),
    'the pre-migration backup names the exact version jump',
  );
  const backupPath = path.join(testDir, 'backups', backupNames[backupNames.length - 1]);
  const FixtureDatabase = require('better-sqlite3');
  const backupDb = new FixtureDatabase(backupPath, { readonly: true });
  try {
    assertEqualOrThrow(backupDb.pragma('user_version', { simple: true }), PRIOR_VERSION, 'the backup snapshot records the pre-migration version');
    assertEqualOrThrow(
      (backupDb.prepare(`SELECT COUNT(*) AS count FROM orders`).get() as { count: number }).count,
      1,
      'the backup snapshot carries the pre-migration rows',
    );
  } finally {
    backupDb.close();
  }
  assertEqualOrThrow(db.pragma('foreign_keys', { simple: true }), 1, 'foreign keys are enforced after migrations');
  assertEqualOrThrow((db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length, 0, 'the upgraded database has no foreign-key violations');

  // ── Repeated initialization: idempotent, no extra migration or backup ──
  const backupsAfterUpgrade = backupFiles().length;
  closeDatabase();
  initDatabase();
  db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), LATEST_VERSION, 're-opening a current database stays on the registry tail');
  assertEqualOrThrow(backupFiles().length, backupsAfterUpgrade, 'a second open of a current database writes no extra backup');
  for (const table of EXPENSE_TABLES) {
    assertOrThrow(tableNames(db).includes(table), `${table} survives repeated initialization`);
  }

  // ── Ideal schema tracks the same registry ──
  const idealDb = buildIdealSchemaDb();
  try {
    assertEqualOrThrow(idealDb.pragma('user_version', { simple: true }), LATEST_VERSION, 'the ideal schema reaches the same version');
    for (const table of EXPENSE_TABLES) {
      assertOrThrow(tableNames(idealDb).includes(table), `${table} exists in the ideal schema`);
    }
  } finally {
    idealDb.close();
  }

  // ── Columns and indexes that later expense reads and writes depend on ──
  const expectedColumns: Record<string, string[]> = {
    expense_categories: ['id', 'name', 'name_key', 'is_active', 'created_by', 'updated_by', 'created_at', 'updated_at'],
    expenses: [
      'id', 'category_id', 'category_name', 'description', 'payee', 'notes', 'amount_minor',
      'currency_code', 'incurred_on', 'created_by', 'created_at', 'replaces_expense_id',
      'voided_at', 'voided_by', 'void_reason',
    ],
    expense_payments: [
      'id', 'expense_id', 'amount_minor', 'method', 'business_date', 'reversal_of', 'reason',
      'cash_movement_id', 'created_by', 'created_at',
    ],
    expense_mutations: ['actor_user_id', 'idempotency_key', 'operation', 'resource_id', 'request_hash', 'response_json', 'created_at'],
  };
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const actual = columns(db, table);
    for (const column of expected) assertIncludesOrThrow(actual, column, `${table}.${column} exists`);
  }
  assertIncludesOrThrow(indexNames(db, 'expense_categories'), 'idx_expense_categories_name_key', 'category names have a unique index');
  assertIncludesOrThrow(indexNames(db, 'expenses'), 'idx_expenses_replaces_unique', 'expenses have a one-replacement-per-source index');
  assertIncludesOrThrow(indexNames(db, 'expenses'), 'idx_expenses_incurred', 'expenses have an incurred-date list index');
  assertIncludesOrThrow(indexNames(db, 'expenses'), 'idx_expenses_category', 'expenses have a category list index');
  assertIncludesOrThrow(indexNames(db, 'expense_payments'), 'idx_expense_payments_reversal_unique', 'a payment cannot be reversed twice');
  assertIncludesOrThrow(indexNames(db, 'expense_payments'), 'idx_expense_payments_cash_movement', 'a cash movement cannot back two payment entries');
  assertIncludesOrThrow(indexNames(db, 'expense_payments'), 'idx_expense_payments_expense', 'payments have an expense-ledger index');

  // ── Native constraints reject malformed ledger rows ──
  const ts = now();
  db.prepare(`INSERT INTO expense_categories (id, name, name_key, is_active, created_by, updated_by, created_at, updated_at)
    VALUES ('schema-cat', 'Utilities', 'utilities', 1, 'exp-owner', 'exp-owner', ?, ?)`).run(ts, ts);
  assertOrThrow(throwsSqlite(() => db.prepare(`INSERT INTO expense_categories (id, name, name_key, is_active, created_by, updated_by, created_at, updated_at)
    VALUES ('schema-cat-dup', 'UTILITIES', 'utilities', 1, 'exp-owner', 'exp-owner', ?, ?)`).run(ts, ts)),
    'a second category with the same normalized name is rejected');
  assertOrThrow(throwsSqlite(() => db.prepare(`INSERT INTO expense_categories (id, name, name_key, is_active, created_by, updated_by, created_at, updated_at)
    VALUES ('schema-cat-fk', 'Ghost', 'ghost', 1, 'missing-user', 'missing-user', ?, ?)`).run(ts, ts)),
    'a category cannot reference an unknown actor');

  const insertExpense = (id: string, amountMinor: number, extra: { currency?: string; replaces?: string | null } = {}) =>
    db.prepare(`INSERT INTO expenses (
      id, category_id, category_name, description, amount_minor, currency_code, incurred_on,
      created_by, created_at, replaces_expense_id
    ) VALUES (?, 'schema-cat', 'Utilities', 'Fixture expense', ?, ?, '2026-10-01', 'exp-owner', ?, ?)`)
      .run(id, amountMinor, extra.currency ?? 'THB', ts, extra.replaces ?? null);

  insertExpense('schema-exp-1', 1500);
  assertOrThrow(throwsSqlite(() => insertExpense('schema-exp-zero', 0)), 'a zero expense amount is rejected');
  assertOrThrow(throwsSqlite(() => insertExpense('schema-exp-neg', -5)), 'a negative expense amount is rejected');
  assertOrThrow(throwsSqlite(() => insertExpense('schema-exp-currency', 100, { currency: 'TH' })), 'a short currency code is rejected');
  assertOrThrow(throwsSqlite(() => db.prepare(`INSERT INTO expenses (
      id, category_id, category_name, description, amount_minor, currency_code, incurred_on, created_by, created_at
    ) VALUES ('schema-exp-bad-date', 'schema-cat', 'Utilities', 'x', 100, 'THB', '01-10-2026', 'exp-owner', ?)`).run(ts)),
    'a non-ISO incurred date is rejected');
  insertExpense('schema-exp-2', 700, { replaces: 'schema-exp-1' });
  assertOrThrow(throwsSqlite(() => insertExpense('schema-exp-3', 700, { replaces: 'schema-exp-1' })),
    'two expenses cannot replace the same source expense');

  const insertPayment = (
    id: string,
    extra: { reversalOf?: string | null; reason?: string | null; cashMovementId?: number | null; method?: string } = {},
  ) => db.prepare(`INSERT INTO expense_payments (
      id, expense_id, amount_minor, method, business_date, reversal_of, reason, cash_movement_id, created_by, created_at
    ) VALUES (?, 'schema-exp-1', 500, ?, '2026-10-01', ?, ?, ?, 'exp-owner', ?)`)
    .run(id, extra.method ?? 'cash', extra.reversalOf ?? null, extra.reason ?? null, extra.cashMovementId ?? null, ts);

  insertPayment('schema-pay-1');
  assertOrThrow(throwsSqlite(() => insertPayment('schema-pay-bad-method', { method: 'loyalty' })), 'an unsupported payment method is rejected');
  assertOrThrow(throwsSqlite(() => insertPayment('schema-pay-no-reason', { reversalOf: 'schema-pay-1' })),
    'a reversal without a reason is rejected');
  assertOrThrow(throwsSqlite(() => insertPayment('schema-pay-orphan-reason', { reason: 'not a reversal' })),
    'a payment carrying a reversal reason without a reversal reference is rejected');
  insertPayment('schema-pay-rev-1', { reversalOf: 'schema-pay-1', reason: 'Recorded in error' });
  assertOrThrow(throwsSqlite(() => insertPayment('schema-pay-rev-2', { reversalOf: 'schema-pay-1', reason: 'Again' })),
    'a payment cannot be reversed twice');
  const movementId = Number(db.prepare(`SELECT id FROM cash_drawer_movements LIMIT 1`).get().id);
  insertPayment('schema-pay-cash-linked', { cashMovementId: movementId });
  assertOrThrow(throwsSqlite(() => insertPayment('schema-pay-cash-dup', { cashMovementId: movementId })),
    'one cash movement cannot back two payment entries');

  db.prepare(`INSERT INTO expense_mutations (actor_user_id, idempotency_key, operation, resource_id, request_hash, response_json, created_at)
    VALUES ('exp-owner', 'schema-key-1', 'create_expense', 'schema-exp-1', 'hash', '{}', ?)`).run(ts);
  assertOrThrow(throwsSqlite(() => db.prepare(`INSERT INTO expense_mutations (actor_user_id, idempotency_key, operation, resource_id, request_hash, response_json, created_at)
    VALUES ('exp-owner', 'schema-key-1', 'void_expense', 'schema-exp-1', 'hash2', '{}', ?)`).run(ts)),
    'a mutation receipt is unique per actor and idempotency key');

  runServiceChecks(db);

  const results = getResults();
  console.log(`\nExpense records: ${results.passed}/${results.total} checks passed`);
  if (results.failed > 0) {
    console.error(`   ${results.failed} failing check(s)`);
    process.exitCode = 1;
  }
}

try {
  main();
  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('✅ Expense records schema test passed');
} catch (error) {
  try { closeDatabase(); } catch { }
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...PRISTINE_MIGRATIONS);
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
}

/** Rows in the tables an expense workflow must never touch. */
function countRows(db: any): Record<string, number> {
  const tables = ['orders', 'order_items', 'bills', 'supplies', 'supply_movements', 'cash_sessions', 'cash_drawer_movements'];
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  return counts;
}

/** Service-level behavior: validation, categories, writes, void/replace, paging, summaries. */
function runServiceChecks(db: any): void {
  const service = require('../main/services/expenses');
  const actor = 'exp-owner';
  const setSetting = (key: string, value: string) =>
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, now());
  setSetting('country', 'TH');
  setSetting('currency', 'THB');
  setSetting('timezone', 'Asia/Bangkok');

  const today = service.currentBusinessDate();
  const ledgerBefore = countRows(db);

  // Drop the raw-constraint fixtures so service counts start from zero.
  db.prepare('DELETE FROM expense_mutations').run();
  db.prepare('DELETE FROM expense_payments').run();
  db.prepare('DELETE FROM expenses').run();
  db.prepare('DELETE FROM expense_categories').run();

  const expectError = (fn: () => unknown, statusCode: number, label: string, code: string | null = null) => {
    try {
      fn();
      assertOrThrow(false, `${label} (expected status ${statusCode}, nothing was thrown)`);
    } catch (error: any) {
      assertEqualOrThrow(error?.statusCode, statusCode, label);
      if (code) assertEqualOrThrow(error?.code, code, `${label} carries code ${code}`);
    }
  };

  // ── Categories: unique trimmed names, explicit activity, no expense reclassification ──
  const rent = service.createExpenseCategory(db, { name: '  Rent  ', actorUserId: actor, idempotencyKey: 'cat-rent' });
  assertEqualOrThrow(rent.status, 201, 'category create returns 201');
  assertEqualOrThrow(rent.body.category.name, 'Rent', 'category names are stored trimmed');
  assertEqualOrThrow(rent.body.category.is_active, 1, 'a new category is active');
  assertEqualOrThrow(rent.body.category.created_by, actor, 'category creation attributes the authenticated actor');
  assertOrThrow(rent.body.category.id.startsWith('expcat_'), 'category ids use the repo UUID convention');
  const rentId = rent.body.category.id;

  const rentReplay = service.createExpenseCategory(db, { name: 'Rent', actorUserId: actor, idempotencyKey: 'cat-rent' });
  assertEqualOrThrow(rentReplay.replayed, true, 'the same category key and payload replays the committed result');
  assertEqualOrThrow(rentReplay.body.category.id, rentId, 'the replay returns the original category id');
  assertEqualOrThrow(
    (db.prepare('SELECT COUNT(*) AS count FROM expense_categories').get() as { count: number }).count,
    1,
    'a replayed category mutation writes nothing new',
  );
  expectError(() => service.createExpenseCategory(db, { name: 'Rent renamed', actorUserId: actor, idempotencyKey: 'cat-rent' }), 409, 'a reused key with a different payload conflicts', 'idempotency_conflict');
  expectError(() => service.createExpenseCategory(db, { name: ' rent ', actorUserId: actor, idempotencyKey: 'cat-rent-2' }), 409, 'category names are unique case-insensitively after trimming', 'category_name_taken');
  expectError(() => service.createExpenseCategory(db, { name: '   ', actorUserId: actor, idempotencyKey: 'cat-blank' }), 400, 'a blank category name is rejected');
  expectError(() => service.createExpenseCategory(db, { name: 'x'.repeat(81), actorUserId: actor, idempotencyKey: 'cat-long' }), 400, 'an over-long category name is rejected');

  const utilities = service.createExpenseCategory(db, { name: 'Utilities', actorUserId: actor, idempotencyKey: 'cat-utilities' });
  const utilitiesId = utilities.body.category.id;
  const deactivated = service.updateExpenseCategory(db, utilitiesId, { is_active: false, actorUserId: actor, idempotencyKey: 'cat-utilities-off' });
  assertEqualOrThrow(deactivated.body.category.is_active, 0, 'a category can be deactivated explicitly');
  assertEqualOrThrow(deactivated.body.category.updated_by, actor, 'category updates attribute the authenticated actor');
  assertOrThrow(
    !service.listExpenseCategories(db).categories.some((row: any) => row.id === utilitiesId),
    'the default category list hides inactive categories',
  );
  assertOrThrow(
    service.listExpenseCategories(db, { includeInactive: true }).categories.some((row: any) => row.id === utilitiesId),
    'include_inactive keeps deactivated categories visible for history',
  );
  expectError(() => service.updateExpenseCategory(db, rentId, { actorUserId: actor, idempotencyKey: 'cat-noop' }), 400, 'a category patch without name or is_active is rejected');
  expectError(() => service.updateExpenseCategory(db, 'missing-category', { name: 'Ghost', actorUserId: actor, idempotencyKey: 'cat-missing' }), 404, 'patching an unknown category is a 404');
  expectError(() => service.updateExpenseCategory(db, rentId, { name: 'Utilities', actorUserId: actor, idempotencyKey: 'cat-collide' }), 409, 'renaming onto an existing category name conflicts', 'category_name_taken');

  const renamed = service.updateExpenseCategory(db, rentId, { name: 'Rent & Lease', actorUserId: actor, idempotencyKey: 'cat-rent-rename' });
  assertEqualOrThrow(renamed.body.category.name, 'Rent & Lease', 'the category rename is stored');

  // ── Expense creation ──
  const createInput = (overrides: Record<string, unknown> = {}) => ({
    category_id: rentId,
    description: 'October rent',
    amount_minor: 1500000,
    incurred_on: today,
    payee: 'Landlord',
    notes: 'Q4 payment',
    actorUserId: actor,
    idempotencyKey: 'exp-rent-oct',
    ...overrides,
  });

  const created = service.createExpense(db, createInput());
  assertEqualOrThrow(created.status, 201, 'expense create returns 201');
  assertEqualOrThrow(created.body.expense.paid_minor, 0, 'a new expense never starts paid');
  assertEqualOrThrow(created.body.expense.due_minor, 1500000, 'the full amount is due on a new expense');
  assertEqualOrThrow(created.body.expense.amount_minor, 1500000, 'minor units round-trip unchanged');
  assertEqualOrThrow(created.body.expense.currency_code, 'THB', 'the expense snapshots the store currency');
  assertEqualOrThrow(created.body.expense.status, 'active', 'a new expense is active');
  assertEqualOrThrow(created.body.expense.category_name, 'Rent & Lease', 'the category label is snapshotted onto the expense');
  assertEqualOrThrow(created.body.expense.created_by, actor, 'expense creation attributes the authenticated actor');
  assertOrThrow(created.body.expense.id.startsWith('exp_'), 'expense ids use the repo UUID convention');
  const rentExpenseId = created.body.expense.id;

  const createReplay = service.createExpense(db, createInput());
  assertEqualOrThrow(createReplay.replayed, true, 'the same expense key and payload replays the committed result');
  assertEqualOrThrow(createReplay.body.expense.id, rentExpenseId, 'the replay returns the original expense id');
  expectError(() => service.createExpense(db, createInput({ amount_minor: 999 })), 409, 'a reused expense key with a changed amount conflicts', 'idempotency_conflict');
  expectError(() => service.createExpense(db, createInput({ idempotencyKey: 'exp-rent-other', replaces_expense_id: rentExpenseId })), 400, 'replace linkage cannot be set through create');

  service.updateExpenseCategory(db, rentId, { name: 'Rent 2026', actorUserId: actor, idempotencyKey: 'cat-rent-2026' });
  assertEqualOrThrow(
    service.getExpense(db, rentExpenseId).category_name,
    'Rent & Lease',
    'renaming a category never rewrites an existing expense label',
  );
  expectError(
    () => service.createExpense(db, createInput({ idempotencyKey: 'exp-inactive', category_id: utilitiesId })),
    409,
    'a deactivated category cannot receive a new expense',
    'category_inactive',
  );
  expectError(() => service.createExpense(db, createInput({ idempotencyKey: 'exp-unknown-cat', category_id: 'missing-category' })), 404, 'an unknown category is a 404');

  // ── Amount, date, and text validation ──
  const validationKey = (label: string) => `exp-invalid-${label}`;
  expectError(() => service.createExpense(db, createInput({ amount_minor: 0, idempotencyKey: validationKey('zero') })), 400, 'a zero amount is rejected');
  expectError(() => service.createExpense(db, createInput({ amount_minor: -1, idempotencyKey: validationKey('negative') })), 400, 'a negative amount is rejected');
  expectError(() => service.createExpense(db, createInput({ amount_minor: 12.5, idempotencyKey: validationKey('fractional') })), 400, 'a fractional minor-unit amount is rejected');
  expectError(() => service.createExpense(db, createInput({ amount_minor: '1500000', idempotencyKey: validationKey('string') })), 400, 'a string amount is rejected instead of coerced');
  expectError(() => service.createExpense(db, createInput({ amount_minor: Number.MAX_SAFE_INTEGER + 1, idempotencyKey: validationKey('unsafe') })), 400, 'an unsafe integer amount is rejected');
  expectError(() => service.createExpense(db, createInput({ description: '   ', idempotencyKey: validationKey('blank-desc') })), 400, 'a blank description is rejected');
  expectError(() => service.createExpense(db, createInput({ description: 'x'.repeat(201), idempotencyKey: validationKey('long-desc') })), 400, 'an over-long description is rejected');
  expectError(() => service.createExpense(db, createInput({ payee: 'x'.repeat(201), idempotencyKey: validationKey('long-payee') })), 400, 'an over-long payee is rejected');
  expectError(() => service.createExpense(db, createInput({ notes: 'x'.repeat(501), idempotencyKey: validationKey('long-notes') })), 400, 'over-long notes are rejected');
  assertEqualOrThrow(service.isValidBusinessDate('2024-02-29'), true, 'a real leap day is a valid business date');
  assertEqualOrThrow(service.isValidBusinessDate('2025-02-29'), false, 'a non-leap 29 February is rejected');
  assertEqualOrThrow(service.isValidBusinessDate('2026-04-31'), false, 'an impossible day of month is rejected');
  for (const bad of ['2026-02-30', '2026-13-01', '01-02-2026', '2026-1-1', '', 'today']) {
    expectError(
      () => service.createExpense(db, createInput({ incurred_on: bad, idempotencyKey: validationKey(`date-${bad || 'empty'}`) })),
      400,
      `the date ${JSON.stringify(bad)} is rejected`,
    );
  }
  assertEqualOrThrow(
    (db.prepare('SELECT COUNT(*) AS count FROM expense_mutations').get() as { count: number }).count,
    db.prepare('SELECT COUNT(DISTINCT idempotency_key) AS count FROM expense_mutations').get().count,
    'no failed mutation is recorded as a committed receipt',
  );
  const future = new Date(`${today}T00:00:00Z`);
  future.setUTCDate(future.getUTCDate() + 1);
  expectError(
    () => service.createExpense(db, createInput({ incurred_on: future.toISOString().slice(0, 10), idempotencyKey: validationKey('future') })),
    400,
    'a future expense date is rejected',
  );
  // The ceiling is the store's business date, not the host clock: a store far
  // ahead of UTC is allowed to record its own (later) date but not the next one.
  const { localDateInTimezone, tenantBusinessDayStartTime } = require('../main/db');
  setSetting('timezone', 'Pacific/Kiritimati');
  const storeDate = localDateInTimezone(new Date(), 'Pacific/Kiritimati', tenantBusinessDayStartTime());
  assertEqualOrThrow(service.currentBusinessDate(), storeDate, 'the business date follows the store timezone, not the host clock');
  const atStoreDate = service.createExpense(db, createInput({ incurred_on: storeDate, amount_minor: 500, idempotencyKey: validationKey('store-date') }));
  assertEqualOrThrow(atStoreDate.body.expense.incurred_on, storeDate, 'an expense dated to the store business date is accepted');
  const pastStoreDate = new Date(`${storeDate}T00:00:00Z`);
  pastStoreDate.setUTCDate(pastStoreDate.getUTCDate() + 1);
  expectError(
    () => service.createExpense(db, createInput({ incurred_on: pastStoreDate.toISOString().slice(0, 10), idempotencyKey: validationKey('store-date-next') })),
    400,
    'the day after the store business date is still future',
  );
  setSetting('timezone', 'Asia/Bangkok');
  const historical = new Date(`${today}T00:00:00Z`);
  historical.setUTCDate(historical.getUTCDate() - 45);
  const historicalDate = historical.toISOString().slice(0, 10);
  const backdated = service.createExpense(db, createInput({ incurred_on: historicalDate, amount_minor: 250000, idempotencyKey: validationKey('historical') }));
  assertEqualOrThrow(backdated.body.expense.incurred_on, historicalDate, 'an expense may be dated to an earlier, already-closed business day');
  assertEqualOrThrow(backdated.body.expense.paid_minor, 0, 'a backdated expense is not assumed paid');
  assertEqualOrThrow(
    backdated.body.expense.created_at.slice(0, 10),
    new Date().toISOString().slice(0, 10),
    'the audit timestamp is the real creation time, not the incurred date',
  );

  // ── Currency snapshot: no factor-of-100 assumption anywhere ──
  const originalCurrency = service.getExpense(db, rentExpenseId).currency_code;
  for (const currency of ['JPY', 'KWD', 'THB']) {
    setSetting('currency', currency);
    const row = service.createExpense(db, createInput({ amount_minor: 1500, idempotencyKey: `exp-currency-${currency}` }));
    assertEqualOrThrow(row.body.expense.currency_code, currency, `an expense created under ${currency} snapshots ${currency}`);
    assertEqualOrThrow(row.body.expense.amount_minor, 1500, `${currency} minor units round-trip without scaling`);
    assertEqualOrThrow(
      service.getExpense(db, rentExpenseId).currency_code,
      originalCurrency,
      `switching the store to ${currency} leaves earlier expenses in their original currency`,
    );
  }
  expectError(
    () => service.createExpense(db, createInput({ currency_code: 'USD', idempotencyKey: validationKey('foreign-currency') })),
    400,
    'an expense in a currency other than the store currency is rejected',
  );
  expectError(() => service.createExpense(db, createInput({ currency_code: 'TH', idempotencyKey: validationKey('short-currency') })), 400, 'a malformed currency code is rejected');

  // ── Unconfigured regional settings fail loudly instead of guessing ──
  const savedRegion = {
    country: db.prepare(`SELECT value FROM settings WHERE key = 'country'`).get()?.value,
    currency: db.prepare(`SELECT value FROM settings WHERE key = 'currency'`).get()?.value,
    timezone: db.prepare(`SELECT value FROM settings WHERE key = 'timezone'`).get()?.value,
  };
  for (const key of ['country', 'currency', 'timezone']) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  expectError(() => service.createExpense(db, createInput({ idempotencyKey: validationKey('unconfigured') })), 409, 'an unconfigured store cannot record an expense');
  expectError(() => service.getExpenseContext(db), 409, 'context refuses to invent a currency before setup');
  setSetting('country', savedRegion.country);
  setSetting('currency', savedRegion.currency);
  setSetting('timezone', savedRegion.timezone);
  assertEqualOrThrow(service.getExpenseContext(db).currency_code, savedRegion.currency, 'context reports the configured store currency');
  assertEqualOrThrow(service.getExpenseContext(db).business_date, today, 'context reports the store business date, not the host date');
  assertEqualOrThrow(service.getExpenseContext(db).cash_session_open, true, 'context reports the fixture open cash session');
  assertEqualOrThrow(Object.keys(service.getExpenseContext(db)).sort().join(','), 'business_date,cash_session_open,currency_code', 'context exposes only currency, business date, and drawer state');

  // ── Payment ledger reads: seeded rows only — this work order exposes no payment writes ──
  const insertSeedPayment = (id: string, amountMinor: number, method: string, createdAt: string, extra: { reversalOf?: string; reason?: string; expenseId?: string } = {}) =>
    db.prepare(`INSERT INTO expense_payments (id, expense_id, amount_minor, method, business_date, reversal_of, reason, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, extra.expenseId ?? rentExpenseId, amountMinor, method, today, extra.reversalOf ?? null, extra.reason ?? null, actor, createdAt);
  insertSeedPayment('seed-pay-1', 400000, 'cash', `${today} 09:00:00`);
  insertSeedPayment('seed-pay-2', 350000, 'card', `${today} 10:00:00`);
  insertSeedPayment('seed-pay-rev', 400000, 'cash', `${today} 11:00:00`, { reversalOf: 'seed-pay-1', reason: 'Cash returned to the drawer' });
  const ledgerDetail = service.getExpense(db, rentExpenseId);
  assertEqualOrThrow(ledgerDetail.paid_minor, 350000, 'net paid is payments minus reversals');
  assertEqualOrThrow(ledgerDetail.due_minor, 1500000 - 350000, 'due reconciles against net paid');
  assertEqualOrThrow(ledgerDetail.amount_minor, 1500000, 'the original amount survives payment history');
  const history = service.listExpensePayments(db, rentExpenseId);
  assertEqualOrThrow(history.payments.length, 3, 'the ledger keeps reversals alongside their payments');
  assertEqualOrThrow(history.payments[0].id, 'seed-pay-rev', 'payment history is newest first');
  assertEqualOrThrow(history.payments[0].reversal_of, 'seed-pay-1', 'a reversal names the payment it reverses');
  const historyPage = service.listExpensePayments(db, rentExpenseId, { limit: 2 });
  assertEqualOrThrow(historyPage.payments.length, 2, 'payment history pages');
  assertEqualOrThrow(typeof historyPage.nextCursor, 'string', 'a truncated payment history exposes a cursor');
  const historyPage2 = service.listExpensePayments(db, rentExpenseId, { limit: 2, cursor: historyPage.nextCursor as string });
  assertEqualOrThrow(historyPage2.payments.length, 1, 'the payment-history cursor returns the remaining row');
  assertEqualOrThrow(
    new Set([...historyPage.payments, ...historyPage2.payments].map((row: any) => row.id)).size,
    3,
    'payment paging neither duplicates nor drops rows',
  );

  // ── Paging over the expense list ──
  for (let index = 0; index < 5; index++) {
    service.createExpense(db, createInput({ description: `Paged expense ${index}`, amount_minor: 1000 + index, idempotencyKey: `exp-page-${index}` }));
  }
  const inRangeCount = Number((db.prepare('SELECT COUNT(*) AS count FROM expenses WHERE category_id = ? AND voided_at IS NULL').get(rentId) as { count: number }).count);
  const collected: string[] = [];
  const pageSizes: number[] = [];
  let cursor: string | null = null;
  do {
    const page = service.listExpenses(db, { limit: 2, categoryId: rentId, cursor });
    collected.push(...page.expenses.map((row: any) => row.id));
    pageSizes.push(page.expenses.length);
    cursor = page.nextCursor;
  } while (cursor);
  assertEqualOrThrow(collected.length, inRangeCount, 'paging returns every matching expense');
  assertEqualOrThrow(new Set(collected).size, collected.length, 'paging never repeats an expense');
  assertEqualOrThrow(Math.max(...pageSizes), 2, 'no page exceeds the requested size');
  assertEqualOrThrow(service.normalizeExpenseLimit(500), 100, 'the list limit is capped at 100');
  const ordered = service.listExpenses(db, { limit: 100, categoryId: rentId }).expenses;
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    assertOrThrow(
      previous.incurred_on > current.incurred_on
      || (previous.incurred_on === current.incurred_on && previous.id > current.id),
      `list order is stable at position ${index}`,
    );
  }
  expectError(() => service.listExpenses(db, { limit: 0 }), 400, 'a non-positive limit is rejected');
  expectError(() => service.listExpenses(db, { cursor: 'not-a-cursor' }), 400, 'a malformed cursor is rejected');
  expectError(() => service.listExpenses(db, { from: '2026-04-31' }), 400, 'a malformed range start is rejected');
  expectError(() => service.listExpenses(db, { from: today, to: '2026-01-01' }), 400, 'an inverted range is rejected');
  expectError(() => service.listExpenses(db, { status: 'paid' }), 400, 'an unknown status filter is rejected');
  const thbInCategory = Number((db.prepare(`SELECT COUNT(*) AS count FROM expenses WHERE category_id = ? AND voided_at IS NULL AND currency_code = 'THB'`).get(rentId) as { count: number }).count);
  assertEqualOrThrow(
    service.listExpenses(db, { currencyCode: 'thb', categoryId: rentId }).expenses.length,
    thbInCategory,
    'a lowercase currency filter is normalized to the stored code',
  );

  // ── Summary: SQL aggregation over every matching expense, not just the fetched page ──
  const rangeFrom = historicalDate;
  const summary = service.summarizeExpenses(db, { from: rangeFrom, to: today, categoryId: rentId });
  assertEqualOrThrow(summary.basis, 'active_expenses_incurred_in_range_paid_to_date', 'the summary labels its paid-to-date basis');
  assertEqualOrThrow(summary.filters.status, 'active', 'the summary always reports its active-expense basis');
  assertEqualOrThrow(summary.groups.length, 3, 'the summary groups by currency and category');
  const summaryGroup = summary.groups.find((row: any) => row.currency_code === 'THB');
  assertOrThrow(summaryGroup, 'THB expenses form their own summary group');
  assertEqualOrThrow(summaryGroup.category_id, rentId, 'the summary group names the category');
  assertEqualOrThrow(summaryGroup.category_name, 'Rent 2026', 'the summary labels a group with the current category name');
  assertEqualOrThrow(summaryGroup.expense_count, thbInCategory, 'the summary counts every matching expense, not just one page');
  assertEqualOrThrow(summaryGroup.net_paid_minor, 350000, 'the summary reports current net paid');
  assertEqualOrThrow(summaryGroup.incurred_minor - summaryGroup.net_paid_minor, summaryGroup.due_minor, 'each group reconciles incurred = net paid + due');
  const summaryTotals = summary.totals.find((row: any) => row.currency_code === 'THB');
  assertEqualOrThrow(summaryTotals.incurred_minor, summaryGroup.incurred_minor, 'THB totals reconcile with the grouped amounts');
  assertEqualOrThrow(summary.totals.length, 3, 'the summary keeps each currency separate');
  const otherCurrencyTotals = summary.totals.find((row: any) => row.currency_code !== 'THB');
  assertOrThrow(otherCurrencyTotals.expense_count > 0, 'expenses in another currency are grouped separately, never added together');

  // A payment recorded after the selected range still counts as paid-to-date.
  const boundsFrom = new Date(`${today}T00:00:00Z`);
  boundsFrom.setUTCDate(boundsFrom.getUTCDate() - 7);
  const payLaterExpense = service.createExpense(db, createInput({
    incurred_on: boundsFrom.toISOString().slice(0, 10),
    amount_minor: 90000,
    idempotencyKey: 'exp-paid-later',
  })).body.expense;
  insertSeedPayment('seed-pay-later', 90000, 'other', `${today} 23:00:00`, { expenseId: payLaterExpense.id });
  const narrowRange = service.summarizeExpenses(db, { from: boundsFrom.toISOString().slice(0, 10), to: boundsFrom.toISOString().slice(0, 10), categoryId: rentId });
  assertEqualOrThrow(narrowRange.groups.length, 1, 'the narrow range covers only the expenses incurred on that day');
  const narrowGroup = narrowRange.groups[0];
  assertEqualOrThrow(narrowGroup.expense_count, 1, 'the narrow range reconciles to the single in-range expense');
  assertEqualOrThrow(narrowGroup.net_paid_minor, 90000, 'a payment after the range still counts as paid to date');
  assertEqualOrThrow(narrowGroup.due_minor, narrowGroup.incurred_minor - 90000, 'the narrow-range due reconciles');
  assertEqualOrThrow(
    service.getExpense(db, payLaterExpense.id).paid_minor,
    90000,
    'the ledger records the payment against the original expense',
  );
  expectError(() => service.summarizeExpenses(db, { from: '2026-02-30' }), 400, 'the summary validates its range');
  const emptyRange = service.summarizeExpenses(db, { from: '2000-01-01', to: '2000-01-02' });
  assertEqualOrThrow(emptyRange.groups.length, 0, 'a range with no expenses aggregates to no groups');
  assertEqualOrThrow(emptyRange.totals.length, 0, 'a range with no expenses aggregates to no totals');

  // ── Void: reasoned, unpaid only, original financial fields preserved ──
  const voidTarget = service.createExpense(db, createInput({ description: 'Duplicate invoice', amount_minor: 70000, idempotencyKey: 'exp-void-target' })).body.expense;
  expectError(() => service.voidExpense(db, voidTarget.id, { actorUserId: actor, idempotencyKey: 'void-no-reason' }), 400, 'a void without a reason is rejected');
  expectError(() => service.voidExpense(db, voidTarget.id, { reason: ' '.repeat(3), actorUserId: actor, idempotencyKey: 'void-blank-reason' }), 400, 'a blank void reason is rejected');
  expectError(() => service.voidExpense(db, voidTarget.id, { reason: 'x'.repeat(501), actorUserId: actor, idempotencyKey: 'void-long-reason' }), 400, 'an over-long void reason is rejected');
  expectError(() => service.voidExpense(db, 'missing-expense', { reason: 'Nope', actorUserId: actor, idempotencyKey: 'void-missing' }), 404, 'voiding an unknown expense is a 404');
  expectError(() => service.voidExpense(db, rentExpenseId, { reason: 'Has payments', actorUserId: actor, idempotencyKey: 'void-paid' }), 409, 'an expense with unreversed payments cannot be voided', 'expense_has_payments');

  const voided = service.voidExpense(db, voidTarget.id, { reason: 'Duplicate invoice', actorUserId: actor, idempotencyKey: 'void-target' });
  assertEqualOrThrow(voided.status, 200, 'void returns the expense');
  assertEqualOrThrow(voided.body.expense.status, 'voided', 'void marks the expense voided');
  assertEqualOrThrow(voided.body.expense.void_reason, 'Duplicate invoice', 'void stores the reason');
  assertEqualOrThrow(voided.body.expense.voided_by, actor, 'void attributes the authenticated actor');
  assertEqualOrThrow(voided.body.expense.amount_minor, 70000, 'void preserves the original amount');
  assertEqualOrThrow(voided.body.expense.created_by, voidTarget.created_by, 'void preserves the original creator and timestamp');
  assertEqualOrThrow(voided.body.expense.paid_minor, 0, 'void leaves the payment ledger untouched');
  const voidReplay = service.voidExpense(db, voidTarget.id, { reason: 'Duplicate invoice', actorUserId: actor, idempotencyKey: 'void-target' });
  assertEqualOrThrow(voidReplay.replayed, true, 'a replayed void returns the committed result');
  expectError(() => service.voidExpense(db, voidTarget.id, { reason: 'Different reason', actorUserId: actor, idempotencyKey: 'void-target' }), 409, 'a reused void key with a different reason conflicts', 'idempotency_conflict');
  expectError(() => service.voidExpense(db, voidTarget.id, { reason: 'Again', actorUserId: actor, idempotencyKey: 'void-twice' }), 409, 'an already voided expense cannot be voided again', 'expense_voided');
  assertOrThrow(
    !service.listExpenses(db, { categoryId: rentId }).expenses.some((row: any) => row.id === voidTarget.id),
    'voided expenses drop out of the default list',
  );
  assertOrThrow(
    service.listExpenses(db, { categoryId: rentId, status: 'voided' }).expenses.some((row: any) => row.id === voidTarget.id),
    'voided expenses stay readable through the history filter',
  );
  const activeThbAfterVoid = Number((db.prepare(`SELECT COUNT(*) AS count FROM expenses WHERE category_id = ? AND voided_at IS NULL AND currency_code = 'THB'`).get(rentId) as { count: number }).count);
  const afterVoidThbGroup = service.summarizeExpenses(db, { from: historicalDate, to: today, categoryId: rentId }).groups.find((row: any) => row.currency_code === 'THB');
  assertEqualOrThrow(afterVoidThbGroup.expense_count, activeThbAfterVoid, 'voided expenses leave the headline totals');

  // ── Replace: one atomic void-and-create, linked both ways ──
  const replaceSource = service.createExpense(db, createInput({ description: 'Wrong amount', amount_minor: 50000, idempotencyKey: 'exp-replace-source' })).body.expense;
  const replaceFields = { category_id: rentId, description: 'Corrected amount', amount_minor: 75000, incurred_on: today, reason: 'Original amount was wrong' };
  expectError(() => service.replaceExpense(db, replaceSource.id, { ...replaceFields, reason: ' '.repeat(2), actorUserId: actor, idempotencyKey: 'replace-no-reason' }), 400, 'a replacement without a reason is rejected');
  expectError(() => service.replaceExpense(db, rentExpenseId, { ...replaceFields, actorUserId: actor, idempotencyKey: 'replace-paid' }), 409, 'an expense with unreversed payments cannot be replaced', 'expense_has_payments');

  const replaced = service.replaceExpense(db, replaceSource.id, { ...replaceFields, actorUserId: actor, idempotencyKey: 'replace-source' });
  assertEqualOrThrow(replaced.status, 201, 'replace returns the new expense');
  assertEqualOrThrow(replaced.body.replaced_expense_id, replaceSource.id, 'replace names the voided source');
  assertEqualOrThrow(replaced.body.expense.replaces_expense_id, replaceSource.id, 'the replacement links back to its source');
  assertEqualOrThrow(replaced.body.expense.amount_minor, 75000, 'the replacement carries the corrected fields');
  assertEqualOrThrow(replaced.body.expense.created_by, actor, 'the replacement attributes the authenticated actor');
  const voidedSource = service.getExpense(db, replaceSource.id);
  assertEqualOrThrow(voidedSource.status, 'replaced', 'the source is reported as replaced');
  assertEqualOrThrow(voidedSource.void_reason, 'Original amount was wrong', 'the source records the replacement reason');
  assertEqualOrThrow(voidedSource.voided_by, actor, 'the source records who replaced it');
  assertEqualOrThrow(voidedSource.amount_minor, 50000, 'the source keeps its original amount');
  assertEqualOrThrow(voidedSource.category_name, replaceSource.category_name, 'the source keeps its original category label');
  assertEqualOrThrow(
    Number((db.prepare(`SELECT COUNT(*) AS count FROM expense_mutations WHERE idempotency_key = 'replace-source'`).get() as { count: number }).count),
    1,
    'a replacement writes exactly one receipt',
  );
  const replaceReplay = service.replaceExpense(db, replaceSource.id, { ...replaceFields, actorUserId: actor, idempotencyKey: 'replace-source' });
  assertEqualOrThrow(replaceReplay.replayed, true, 'a replayed replacement returns the committed result');
  assertEqualOrThrow(replaceReplay.body.expense.id, replaced.body.expense.id, 'a replayed replacement never creates a second record');
  expectError(() => service.replaceExpense(db, replaceSource.id, { ...replaceFields, reason: 'Again', actorUserId: actor, idempotencyKey: 'replace-again' }), 409, 'a replaced source cannot be replaced twice', 'expense_replaced');
  expectError(() => service.replaceExpense(db, voidTarget.id, { ...replaceFields, reason: 'Voided', actorUserId: actor, idempotencyKey: 'replace-voided' }), 409, 'a voided expense cannot be replaced', 'expense_voided');
  expectError(() => service.replaceExpense(db, 'missing-expense', { ...replaceFields, actorUserId: actor, idempotencyKey: 'replace-missing' }), 404, 'replacing an unknown expense is a 404');

  // A failed replacement must roll back the whole pair: no new record, source still active.
  const rollbackSource = service.createExpense(db, createInput({ description: 'Rollback source', amount_minor: 10000, idempotencyKey: 'exp-rollback-source' })).body.expense;
  const expenseCountBeforeRollback = Number((db.prepare('SELECT COUNT(*) AS count FROM expenses').get() as { count: number }).count);
  expectError(
    () => service.replaceExpense(db, rollbackSource.id, { ...replaceFields, amount_minor: 0, actorUserId: actor, idempotencyKey: 'replace-rollback' }),
    400,
    'a replacement with an invalid amount is rejected',
  );
  assertEqualOrThrow(
    Number((db.prepare('SELECT COUNT(*) AS count FROM expenses').get() as { count: number }).count),
    expenseCountBeforeRollback,
    'a failed replacement rolls back the new record',
  );
  assertEqualOrThrow(service.getExpense(db, rollbackSource.id).status, 'active', 'a failed replacement leaves its source active');
  assertEqualOrThrow(
    Number((db.prepare(`SELECT COUNT(*) AS count FROM expense_mutations WHERE idempotency_key = 'replace-rollback'`).get() as { count: number }).count),
    0,
    'a rolled-back replacement records no receipt',
  );

  // ── Expense workflows leave sales, stock, and drawer rows untouched ──
  assertEqualOrThrow(JSON.stringify(countRows(db)), JSON.stringify(ledgerBefore), 'recording expenses never changes sales, stock, or drawer tables');
}

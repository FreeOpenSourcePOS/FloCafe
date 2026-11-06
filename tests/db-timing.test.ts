/**
 * SQL timing for slow-request reporting: what is counted, what is not, and what still works
 * through the wrapper.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/db-timing.test.ts
 */
import Database from 'better-sqlite3';
import {
  getRequestStats,
  instrumentDatabase,
  normalizeSql,
  runWithRequestStats,
  slowRequestEventGate,
  SLOW_REQUEST_EVENT_WINDOW_MS,
  SLOW_SQL_MS,
  type SlowRequestRouteState,
} from '../main/services/db-timing';

const {
  assertEqualOrThrow,
  assertGreaterThanOrThrow,
  assertIncludesOrThrow,
  assertOrThrow,
} = require('./helpers/test-setup');

// Far slower than the statements below it, so the slowest statement is the same on every machine.
const SLOW_SQL =
  'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 20000) SELECT count(*) AS n FROM c';

function seed(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
  const insert = db.prepare('INSERT INTO items (name) VALUES (?)');
  insert.run('a');
  insert.run('b');
  return db;
}

function assertThrows(fn: () => unknown, needle: string, label: string): void {
  try {
    fn();
  } catch (error: any) {
    assertIncludesOrThrow(String(error?.message), needle, label);
    return;
  }
  throw new Error(`${label} - expected a throw`);
}

function main(): void {
  const plain = seed();
  const db = seed();
  instrumentDatabase(db);

  // Nothing is counted outside a request.
  assertEqualOrThrow(getRequestStats(), undefined, 'no stats outside a request');
  db.prepare('SELECT name FROM items WHERE id = ?').get(1);
  db.prepare('SELECT name FROM items').all();
  db.exec('SELECT 1');

  // A method replaced on a statement after it was read is the one that runs.
  const patched = db.prepare('SELECT name FROM items');
  const realAll = patched.all.bind(patched);
  let patchCalls = 0;
  patched.all = ((...params: unknown[]) => {
    patchCalls++;
    return realAll(...params);
  }) as typeof patched.all;
  patched.all();
  assertEqualOrThrow(patchCalls, 1, 'a replaced statement method is called');

  // A later patch of Database.prototype.prepare still applies to an instrumented handle.
  const protoPrepare = Database.prototype.prepare;
  let protoCalls = 0;
  Database.prototype.prepare = function (this: Database.Database, source: string) {
    protoCalls++;
    return protoPrepare.call(this, source);
  } as typeof protoPrepare;
  try {
    db.prepare('SELECT 1').get();
  } finally {
    Database.prototype.prepare = protoPrepare;
  }
  assertEqualOrThrow(protoCalls, 1, 'a patched prototype prepare is used');

  // Queries inside a request are counted, with the slowest normalized SQL kept.
  const stats = runWithRequestStats(() => {
    const inner = getRequestStats();
    assertOrThrow(!!inner, 'stats exist inside a request');
    db.prepare('SELECT name FROM items WHERE id = 1').get();
    db.prepare("SELECT name FROM items WHERE name = 'abc'").all();
    db.prepare('INSERT INTO items (name) VALUES (?)').run('c');
    const rows = db.prepare('SELECT name FROM items').iterate();
    rows.next();
    rows.return?.();
    db.prepare(SLOW_SQL).get();
    assertEqualOrThrow(inner.queries, 5, 'five statements counted');
    assertGreaterThanOrThrow(inner.dbMs, 0, 'db time accumulated');
    assertEqualOrThrow(inner.slowestSql, normalizeSql(SLOW_SQL), 'slowest SQL is kept normalized');
    assertOrThrow(!inner.slowestSql.includes('20000'), 'slowest SQL carries no literal');
    return inner;
  });
  assertEqualOrThrow(stats.queries, 5, 'the request store is the one that was read');

  // The wrappers answer and throw exactly as the plain handle does.
  const where = 'SELECT name FROM items WHERE id = ?';
  assertEqualOrThrow(
    JSON.stringify(db.prepare(where).get(1)),
    JSON.stringify(plain.prepare(where).get(1)),
    'get returns the same row',
  );
  assertEqualOrThrow(
    JSON.stringify(db.prepare(where).all(1)),
    JSON.stringify(plain.prepare(where).all(1)),
    'all returns the same rows',
  );
  assertEqualOrThrow(
    JSON.stringify(db.prepare(where).pluck().get(1)),
    JSON.stringify(plain.prepare(where).pluck().get(1)),
    'pluck still returns a scalar through the wrapper',
  );
  assertEqualOrThrow(
    JSON.stringify(db.prepare('SELECT id, name FROM items WHERE id = ?').raw().get(1)),
    JSON.stringify(plain.prepare('SELECT id, name FROM items WHERE id = ?').raw().get(1)),
    'raw still returns an array through the wrapper',
  );

  const total = db.transaction((name: string) => {
    db.prepare('INSERT INTO items (name) VALUES (?)').run(name);
    return db.prepare('SELECT COUNT(*) AS total FROM items').get() as { total: number };
  })('d');
  assertEqualOrThrow(total.total, 4, 'transaction commits through the wrapper');

  assertThrows(
    () => db.prepare('SELECT missing FROM items').get(),
    'no such column',
    'an SQL error still throws',
  );

  assertEqualOrThrow(
    normalizeSql("SELECT  *  FROM items\nWHERE name = 'abc' AND id = 42 LIMIT 1"),
    'SELECT * FROM items WHERE name = ? AND id = ? LIMIT ?',
    'normalizeSql collapses white space and hides literals',
  );
  const longSql = `SELECT ${'name, '.repeat(80)}name FROM items`;
  assertEqualOrThrow(normalizeSql(longSql).length, 400, 'normalizeSql cuts to 400 characters');
  assertEqualOrThrow(
    normalizeSql('SELECT * FROM items -- Juan Perez\nWHERE id = 1'),
    'SELECT * FROM items WHERE id = ?',
    'normalizeSql drops a line comment',
  );
  assertEqualOrThrow(
    normalizeSql('SELECT * FROM items /* Juan Perez */ WHERE name = "OMELETTE"'),
    'SELECT * FROM items WHERE name = ?',
    'normalizeSql drops a block comment and a double-quoted literal',
  );
  assertEqualOrThrow(
    normalizeSql('SELECT * FROM items WHERE x = 1 /* Juan Perez'),
    'SELECT * FROM items WHERE x = ?',
    'normalizeSql drops an unterminated block comment',
  );

  // Slow-request events: SQL must be the slow part, and one route sends once a window.
  const routes = new Map<string, SlowRequestRouteState>();
  const t0 = 1_000_000;
  const orders = 'GET /api/orders/:id';
  assertEqualOrThrow(
    slowRequestEventGate(routes, orders, SLOW_SQL_MS - 1, t0).send,
    false,
    'a request slow outside SQL sends no event',
  );
  assertEqualOrThrow(
    slowRequestEventGate(routes, orders, SLOW_SQL_MS, t0).occurrences,
    1,
    'the first slow-SQL request sends one event',
  );
  assertEqualOrThrow(
    slowRequestEventGate(routes, orders, SLOW_SQL_MS, t0 + 1000).send,
    false,
    'a second request in the window sends nothing',
  );
  assertEqualOrThrow(
    slowRequestEventGate(routes, 'POST /api/bills', SLOW_SQL_MS, t0 + 2000).occurrences,
    1,
    'a different route sends its own event',
  );
  assertEqualOrThrow(
    slowRequestEventGate(routes, orders, SLOW_SQL_MS, t0 + SLOW_REQUEST_EVENT_WINDOW_MS - 1).send,
    false,
    'the window holds until it is over',
  );
  assertEqualOrThrow(
    slowRequestEventGate(routes, orders, SLOW_SQL_MS, t0 + SLOW_REQUEST_EVENT_WINDOW_MS)
      .occurrences,
    3,
    'the next event counts the two suppressed requests',
  );

  db.close();
  plain.close();
  console.log('\nAll assertions passed');
}

try {
  main();
  process.exit(0);
} catch (error: any) {
  console.error('FAILED:', error?.message ?? error);
  process.exit(1);
}

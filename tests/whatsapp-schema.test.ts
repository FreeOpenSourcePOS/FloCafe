/**
 * whatsapp-schema.test.ts
 *
 * Verifies that the v25 WhatsApp migration produces the expected tables,
 * columns, indexes, and settings keys. Uses buildIdealSchemaDb() to run the
 * full migration pipeline in-memory so we don't depend on an Electron
 * runtime or a real on-disk DB.
 */

// Stub the electron module before importing db.ts (which imports `electron`
// for `app.getPath('userData')`). This lets the test run in plain Node when
// the Electron binary is not installed (e.g. CI, fresh dev env).
import Module from 'node:module';
const realResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...rest: any[]) {
  if (request === 'electron') return require.resolve('./_electron-stub.cjs');
  return realResolve.call(this, request, ...rest);
};

const { buildIdealSchemaDb } = require('../main/db');

type Database = ReturnType<typeof buildIdealSchemaDb>;

function tableColumns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function tableIndexes(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((i) => i.name);
}

function getSetting(db: Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

async function main() {
  console.log('Testing WhatsApp schema (v25)...');
  const failures: string[] = [];
  const assert = (cond: boolean, msg: string) => {
    if (!cond) failures.push(msg);
    console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`);
  };

  const db = buildIdealSchemaDb();
  try {
    const v = db.pragma('user_version', { simple: true }) as number;
    assert(v >= 25, `schema version >= 25 (got ${v})`);

    const cols = tableColumns(db, 'whatsapp_messages');
    for (const c of [
      'id', 'bill_id', 'customer_id', 'phone_e164', 'direction', 'kind',
      'status', 'body', 'external_message_id', 'error',
      'queued_at', 'seen_at', 'typing_at', 'sent_at', 'delivered_at', 'read_at', 'failed_at',
      'created_by_user_id',
    ]) {
      assert(cols.includes(c), `whatsapp_messages has column ${c}`);
    }

    let threw = false;
    try {
      db.prepare(`INSERT INTO whatsapp_messages (phone_e164, direction, body) VALUES (?, ?, ?)`).run('+15555550100', 'sideways', 'x');
    } catch { threw = true; }
    assert(threw, 'whatsapp_messages direction CHECK rejects bad values');

    threw = false;
    try {
      db.prepare(`INSERT INTO whatsapp_messages (phone_e164, direction, body) VALUES (?, ?, ?)`).run('+15555550110', 'outbound', 'bill_receipt');
    } catch { threw = true; }
    assert(!threw, 'whatsapp_messages accepts kind=bill_receipt');

    threw = false;
    try {
      db.prepare(`INSERT INTO whatsapp_messages (phone_e164, direction, kind, body) VALUES (?, ?, ?, ?)`).run('+15555550111', 'outbound', 'marketing', 'x');
    } catch { threw = true; }
    assert(threw, 'whatsapp_messages kind CHECK rejects bad values');

    threw = false;
    try {
      db.prepare(`INSERT INTO whatsapp_blocklist (phone_e164) VALUES (?)`).run('+15555550200');
    } catch { threw = true; }
    assert(!threw, 'whatsapp_blocklist accepts first insert');
    threw = false;
    try {
      db.prepare(`INSERT INTO whatsapp_blocklist (phone_e164) VALUES (?)`).run('+15555550200');
    } catch { threw = true; }
    assert(threw, 'whatsapp_blocklist PK rejects duplicate');

    const allIndexes = new Set<string>();
    for (const t of ['whatsapp_messages', 'whatsapp_blocklist']) {
      for (const i of tableIndexes(db, t)) allIndexes.add(i);
    }
    assert(allIndexes.has('idx_whatsapp_messages_phone'), 'index idx_whatsapp_messages_phone exists');
    assert(allIndexes.has('idx_whatsapp_messages_status'), 'index idx_whatsapp_messages_status exists');
    assert(allIndexes.has('idx_whatsapp_messages_bill'), 'index idx_whatsapp_messages_bill exists');

    assert(getSetting(db, 'whatsapp_enabled') === 'false', 'whatsapp_enabled defaults to false');
    assert(getSetting(db, 'whatsapp_activated_by_user_id') === '', 'whatsapp_activated_by_user_id defaults to empty');
    assert(getSetting(db, 'whatsapp_activated_at') === '', 'whatsapp_activated_at defaults to empty');
    assert(getSetting(db, 'whatsapp_disclosure_version_acknowledged') === '', 'whatsapp_disclosure_version_acknowledged defaults to empty');
    assert(getSetting(db, 'whatsapp_connected_phone') === '', 'whatsapp_connected_phone defaults to empty');
    assert(getSetting(db, 'whatsapp_disclosure_version') === '1', 'whatsapp_disclosure_version = 1');
  } finally {
    db.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertions failed.`);
    process.exit(1);
  } else {
    console.log('\nAll WhatsApp schema assertions passed.');
  }
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});

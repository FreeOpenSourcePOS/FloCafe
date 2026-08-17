/**
 * Migration v71 repair coverage.
 *
 * v55 ("durable_token_revocations", main/db.ts) and the v55 GSTIN-rename
 * migration that shipped in release 2.9.0 briefly claimed the same version
 * number during a branch merge (b909b69 vs. 9cfb5f6). Any database that ran
 * 2.9.0 reached user_version 55 via the old GSTIN-rename body and never ran
 * the real v55 body, so it permanently skipped creating `revoked_tokens` —
 * runMigrations() only applies migrations with version > current, and later
 * migrations kept advancing user_version past 55 regardless. Every
 * authenticated request then fails closed (main/middleware/security.ts
 * isTokenRevoked) because the lookup table doesn't exist.
 *
 * v71 ("repair_durable_token_revocations") re-runs the idempotent
 * CREATE TABLE IF NOT EXISTS so affected installs self-heal on their next
 * upgrade. This test simulates that desynced state directly — drop the
 * table, rewind user_version to 55 — and asserts a fresh initDatabase()
 * restores it without disturbing anything else.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v71-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, closeDatabase, getCurrentSchemaVersion } = require('../main/db');

function main() {
  console.log('Migration v71: repair databases desynced by the v55 numbering collision');
  initDatabase();
  try {
    const db = getDatabase();

    const before = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'revoked_tokens'`).get();
    if (!before) throw new Error('sanity check failed: fresh install did not create revoked_tokens via v55');

    db.prepare('DROP TABLE revoked_tokens').run();
    db.pragma('user_version = 55');
    closeDatabase();

    initDatabase();
    const upgraded = getDatabase();

    const version = getCurrentSchemaVersion();
    if (version < 71) throw new Error(`expected schema to reach at least v71, landed on v${version}`);

    const table = upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'revoked_tokens'`).get();
    if (!table) throw new Error('v71 did not restore the revoked_tokens table for a database desynced at v55');

    const indexed = upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_revoked_tokens_expires_at'`).get();
    if (!indexed) throw new Error('v71 did not restore the revoked_tokens expires_at index');

    upgraded.prepare(`INSERT INTO revoked_tokens (token_hash, expires_at, revoked_at) VALUES ('deadbeef', 9999999999999, '2026-01-01T00:00:00.000Z')`).run();
    const roundtrip = upgraded.prepare(`SELECT token_hash FROM revoked_tokens WHERE token_hash = 'deadbeef'`).get() as any;
    if (roundtrip?.token_hash !== 'deadbeef') throw new Error('revoked_tokens table is not writable after repair');

    console.log('  ✓ a database desynced at v55 has revoked_tokens restored by v71');
    console.log('  ✓ the restored table is indexed and writable');
    console.log('1/1 passed');
  } finally {
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }
}

try {
  main();
} catch (error: any) {
  try { closeDatabase(); } catch {}
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  console.error(error);
  process.exit(1);
}

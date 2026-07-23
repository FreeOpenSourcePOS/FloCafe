/**
 * Google Drive backup integration tests (#129).
 *
 * Covers the parts of main/services/google-drive.ts that don't require a
 * live Google account: config detection, the pure retention/scheduling
 * math, settings persistence, and the encrypted-token file lifecycle. The
 * OAuth loopback flow and real Drive API calls (connect()/backupNow()'s
 * upload path) need a real Google Cloud OAuth client and are out of reach
 * for an automated test — see docs/google-drive-setup.md for manual
 * verification steps.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/google-drive.test.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-google-drive-'));

const mockApp = {
  isPackaged: true,
  getPath: (_name: string) => testDir,
  getVersion: () => 'test',
};

// Identity "encryption" stand-in, same approach as tests/master-pin.test.ts —
// real safeStorage isn't available under ELECTRON_RUN_AS_NODE.
let encryptionAvailable = true;
const mockSafeStorage = {
  isEncryptionAvailable: () => encryptionAvailable,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
};

let openedUrls: string[] = [];
const mockShell = {
  openExternal: async (url: string) => { openedUrls.push(url); },
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp, safeStorage: mockSafeStorage, shell: mockShell };
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, closeDatabase } = require('../main/db');

function main() {
  console.log('🧪 FloCafe Google Drive Tests');
  console.log('='.repeat(60));

  // ── isGoogleDriveConfigured() ────────────────────────────────────────
  delete process.env.GOOGLE_DRIVE_CLIENT_ID;
  delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  // Fresh require per env-var scenario isn't needed — the module reads
  // process.env on every call, never caches.
  const gd = require('../main/services/google-drive');

  assert.equal(gd.isGoogleDriveConfigured(), false, 'not configured when env vars are unset');
  console.log('   ✓ isGoogleDriveConfigured() is false with no env vars');

  process.env.GOOGLE_DRIVE_CLIENT_ID = 'test-client-id';
  assert.equal(gd.isGoogleDriveConfigured(), false, 'still not configured with only client id set');

  process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'test-client-secret';
  assert.equal(gd.isGoogleDriveConfigured(), true, 'configured once both env vars are set');
  console.log('   ✓ isGoogleDriveConfigured() requires both client id and secret');

  // ── pure retention math ──────────────────────────────────────────────
  const files = [
    { id: 'f1', createdTime: '2026-01-01T00:00:00.000Z' },
    { id: 'f2', createdTime: '2026-01-03T00:00:00.000Z' },
    { id: 'f3', createdTime: '2026-01-02T00:00:00.000Z' },
  ];
  assert.deepEqual(gd.computeFilesToDelete(files, 5), [], 'nothing to delete when under the limit');
  assert.deepEqual(gd.computeFilesToDelete(files, 3), [], 'nothing to delete when exactly at the limit');
  assert.deepEqual(gd.computeFilesToDelete(files, 2), ['f1'], 'deletes exactly the oldest file beyond the limit');
  assert.deepEqual(gd.computeFilesToDelete(files, 1), ['f1', 'f3'], 'deletes oldest-first regardless of input order');
  console.log('   ✓ computeFilesToDelete() keeps the newest N, oldest-first eviction');

  // ── pure scheduling math ─────────────────────────────────────────────
  assert.equal(gd.isBackupDue(null, 'daily'), true, 'never backed up = due immediately');
  assert.equal(gd.isBackupDue('not-a-date', 'daily'), true, 'unparseable timestamp = due immediately');
  const now = Date.now();
  const twoHoursAgo = new Date(now - 2 * 60 * 60_000).toISOString();
  const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60_000).toISOString();
  const twoWeeksAgo = new Date(now - 2 * 7 * 24 * 60 * 60_000).toISOString();
  assert.equal(gd.isBackupDue(twoHoursAgo, 'daily', now), false, 'daily: not due 2h after last backup');
  assert.equal(gd.isBackupDue(twoDaysAgo, 'daily', now), true, 'daily: due 2 days after last backup');
  assert.equal(gd.isBackupDue(twoDaysAgo, 'weekly', now), false, 'weekly: not due 2 days after last backup');
  assert.equal(gd.isBackupDue(twoWeeksAgo, 'weekly', now), true, 'weekly: due 2 weeks after last backup');
  console.log('   ✓ isBackupDue() respects the daily/weekly interval');

  // ── status shape + settings persistence (needs a real settings table) ─
  initDatabase();

  let status = gd.googleDrive.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.connected, false, 'not connected before any token exists');
  assert.equal(status.frequency, 'daily', 'defaults to daily');
  assert.equal(status.retention_count, 10, 'defaults to keeping the last 10 backups');
  assert.equal(status.last_backup_at, null);
  console.log('   ✓ getStatus() default shape: unconnected, daily, retain 10');

  status = gd.googleDrive.updatePreferences({ frequency: 'weekly', retention_count: 25 });
  assert.equal(status.frequency, 'weekly');
  assert.equal(status.retention_count, 25);
  status = gd.googleDrive.getStatus();
  assert.equal(status.frequency, 'weekly', 'frequency persists across getStatus() calls');
  assert.equal(status.retention_count, 25, 'retention persists across getStatus() calls');
  console.log('   ✓ updatePreferences() persists frequency + retention_count');

  assert.throws(() => gd.googleDrive.updatePreferences({ frequency: 'monthly' as any }), /daily.*weekly/i, 'rejects an invalid frequency');
  assert.throws(() => gd.googleDrive.updatePreferences({ retention_count: 0 }), /between/i, 'rejects a retention_count below the minimum');
  assert.throws(() => gd.googleDrive.updatePreferences({ retention_count: 1.5 }), /between/i, 'rejects a non-integer retention_count');
  assert.throws(() => gd.googleDrive.updatePreferences({ retention_count: 999 }), /between/i, 'rejects a retention_count above the maximum');
  console.log('   ✓ updatePreferences() validates frequency and retention_count');

  // ── encrypted token file lifecycle (no network — no token yet) ────────
  const tokenPath = path.join(testDir, 'google-drive-token.enc');
  assert.equal(fs.existsSync(tokenPath), false, 'no token file before ever connecting');

  // Simulate a connected state the way connect() would have left it,
  // without touching the network: write the same shape connect() would.
  const fakeTokens = { access_token: 'fake-access-token', refresh_token: 'fake-refresh-token', expiry_date: Date.now() + 3600_000 };
  fs.writeFileSync(tokenPath, mockSafeStorage.encryptString(JSON.stringify(fakeTokens)), { mode: 0o600 });

  status = gd.googleDrive.getStatus();
  assert.equal(status.connected, true, 'connected once a token file is present');
  console.log('   ✓ getStatus() reports connected once a token file exists');

  const rawTokenFile = fs.readFileSync(tokenPath, 'utf8');
  assert.ok(!rawTokenFile.includes('flo-backup'), 'sanity: file is the token blob, not something else');
  assert.ok(rawTokenFile.includes('fake-refresh-token'), 'mock encryption is identity — real safeStorage would actually encrypt this in production');
  console.log('   ✓ token file round-trips through the same safeStorage pattern as master-pin.ts');

  // disconnect() always attempts Google's revoke endpoint but must swallow
  // any failure (offline, bogus token, etc.) and still clear local state —
  // that's the whole point of "disconnecting must work even if Google is
  // unreachable, but must still try to revoke when it is."
  return gd.googleDrive.disconnect().then((disconnectedStatus: any) => {
    assert.equal(disconnectedStatus.connected, false, 'disconnected after disconnect()');
    assert.equal(fs.existsSync(tokenPath), false, 'token file deleted on disconnect');
    assert.equal(disconnectedStatus.account_email, null, 'account email cleared on disconnect');
    console.log('   ✓ disconnect() clears the token file and local status even without a reachable Google endpoint');

    // ── secure storage unavailable ────────────────────────────────────
    encryptionAvailable = false;
    const s = gd.googleDrive.getStatus();
    assert.equal(s.secure_storage_available, false, 'surfaces unavailable secure storage in status');
    encryptionAvailable = true;
    console.log('   ✓ getStatus() surfaces secure_storage_available for the "can\'t store tokens safely" UI state');
  });
}

main()
  .then(() => {
    Module._load = originalLoad;
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
    console.log('\n✅ Google Drive tests passed');
  })
  .catch((error) => {
    Module._load = originalLoad;
    try { closeDatabase(); } catch { /* already closed / never opened */ }
    fs.rmSync(testDir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });

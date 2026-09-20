/**
 * Google Drive backup integration tests (#129).
 *
 * Covers the parts of main/services/google-drive.ts that don't require a
 * live Google account: config detection, scheduling math, settings
 * persistence, and the encrypted-token file lifecycle. The
 * OAuth loopback flow and real Drive API calls (connect()/backupNow()'s
 * upload path) need a real Google Cloud OAuth client and are out of reach
 * for an automated test — see docs/google-drive-setup.md for manual
 * verification steps.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/google-drive.test.ts
 */

import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const nativeFs = require('node:fs') as typeof import('node:fs');

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
let decryptFails = false;
const mockSafeStorage = {
  isEncryptionAvailable: () => encryptionAvailable,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => {
    if (decryptFails) throw new Error('temporary safeStorage failure');
    return b.toString('utf8');
  },
};

let openedUrls: string[] = [];
const mockShell = {
  openExternal: async (url: string) => { openedUrls.push(url); },
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp, safeStorage: mockSafeStorage, shell: mockShell };
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, closeDatabase, getDatabase, now, createBackup, listBackups } = require('../main/db');
const { runShutdownSteps } = require('../main/shutdown');

async function main(): Promise<void> {
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

  // ── scoped Drive package runtime contract ────────────────────────────
  const driveApi = require('@googleapis/drive');
  assert.equal(typeof driveApi.auth.OAuth2, 'function', '@googleapis/drive exposes the OAuth2 constructor used by the service');
  const packageAuthClient = new driveApi.auth.OAuth2('test-client-id', 'test-client-secret', 'http://127.0.0.1/callback');
  const packageDriveClient = driveApi.drive({ version: 'v3', auth: packageAuthClient });
  for (const method of ['get', 'list', 'create', 'update'] as const) {
    assert.equal(typeof packageDriveClient.files[method], 'function', `Drive v3 exposes files.${method}()`);
  }
  console.log('   ✓ @googleapis/drive exposes OAuth2 and every Drive v3 method used by backup/retention');

  // ── pure scheduling math ─────────────────────────────────────────────
  assert.equal(gd.isBackupDue(null, 'daily'), true, 'never backed up = due immediately');
  assert.equal(gd.isBackupDue('not-a-date', 'daily'), true, 'unparseable timestamp = due immediately');
  const nowMs = Date.now();
  const twoHoursAgo = new Date(nowMs - 2 * 60 * 60_000).toISOString();
  const twoDaysAgo = new Date(nowMs - 2 * 24 * 60 * 60_000).toISOString();
  const twoWeeksAgo = new Date(nowMs - 2 * 7 * 24 * 60 * 60_000).toISOString();
  assert.equal(gd.isBackupDue(twoHoursAgo, 'daily', nowMs), false, 'daily: not due 2h after last backup');
  assert.equal(gd.isBackupDue(twoDaysAgo, 'daily', nowMs), true, 'daily: due 2 days after last backup');
  assert.equal(gd.isBackupDue(twoDaysAgo, 'weekly', nowMs), false, 'weekly: not due 2 days after last backup');
  assert.equal(gd.isBackupDue(twoWeeksAgo, 'weekly', nowMs), true, 'weekly: due 2 weeks after last backup');
  console.log('   ✓ isBackupDue() respects the daily/weekly interval');

  const pkce = gd.createPkcePair();
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]+$/, 'PKCE verifier uses URL-safe characters');
  assert.equal(pkce.challenge, crypto.createHash('sha256').update(pkce.verifier).digest('base64url'), 'PKCE challenge is the S256 verifier digest');
  assert.equal(gd.getGoogleDriveErrorCode({ response: { status: 401 } }), 'reauth_required');
  assert.equal(gd.getGoogleDriveErrorCode({ response: { status: 403, data: { error: { errors: [{ reason: 'storageQuotaExceeded' }] } } } }), 'quota_exceeded');
  assert.equal(gd.getGoogleDriveErrorCode({ response: { status: 429 } }), 'rate_limited');
  assert.equal(gd.getGoogleDriveErrorCode({ code: 'ECONNRESET' }), 'offline');
  console.log('   ✓ PKCE uses S256 and provider failures map to safe allowlisted categories');

  // ── status shape + settings persistence (needs a real settings table) ─
  initDatabase();

  let status = gd.googleDrive.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.connected, false, 'not connected before any token exists');
  assert.equal(status.frequency, 'daily', 'defaults to daily');
  assert.equal(status.retention_count, 7, 'defaults to keeping the last 7 automatic backups');
  assert.equal(status.last_backup_at, null);
  console.log('   ✓ getStatus() default shape: unconnected, daily, retain 7');

  const driveStagingPath = path.join(testDir, 'google-drive-staging', 'upload-test.db');
  const backupNamesBeforeDriveSnapshot = new Set(fs.readdirSync(path.join(testDir, 'backups')));
  fs.mkdirSync(path.dirname(driveStagingPath), { recursive: true });
  const driveSnapshot = await createBackup(driveStagingPath, undefined, { stagingDirectory: path.dirname(driveStagingPath) });
  assert.equal(driveSnapshot.path, driveStagingPath, 'Drive staging uses the requested persistent target');
  assert.equal(listBackups().some((backup: { path: string }) => backup.path === driveStagingPath), false, 'Drive staging snapshots stay out of managed local backup history');
  assert.equal(fs.readdirSync(path.join(testDir, 'backups')).some((fileName: string) => fileName.startsWith('flo-backup-') && !backupNamesBeforeDriveSnapshot.has(fileName)), false, 'Drive staging does not leave temporary copies in managed local backups');
  console.log('   ✓ Drive staging targets remain outside managed local backup listing');

  status = gd.googleDrive.updatePreferences({ frequency: 'weekly', retention_count: 25 });
  assert.equal(status.frequency, 'weekly');
  assert.equal(status.retention_count, 25);
  status = gd.googleDrive.getStatus();
  assert.equal(status.frequency, 'weekly', 'frequency persists across getStatus() calls');
  assert.equal(status.retention_count, 25, 'retention persists across getStatus() calls');
  console.log('   ✓ updatePreferences() persists frequency + retention_count');

  const invalidPreferences = (error: unknown): boolean => error instanceof Error && (error as Error & { code?: string }).code === 'preferences_invalid';
  assert.throws(() => gd.googleDrive.updatePreferences({ frequency: 'monthly' as any }), invalidPreferences, 'rejects an invalid frequency with a stable validation code');
  assert.throws(() => gd.googleDrive.updatePreferences({ retention_count: 0 }), invalidPreferences, 'rejects a retention_count below the minimum with a stable validation code');
  assert.throws(() => gd.googleDrive.updatePreferences({ retention_count: 1.5 }), invalidPreferences, 'rejects a non-integer retention_count with a stable validation code');
  assert.throws(() => gd.googleDrive.updatePreferences({ retention_count: 999 }), invalidPreferences, 'rejects a retention_count above the maximum with a stable validation code');
  console.log('   ✓ updatePreferences() validates frequency and retention_count');

  await assert.rejects(
    gd.googleDrive.setDestination('not a Drive id'),
    (error: any) => error?.code === 'destination_invalid',
    'rejects an untrusted destination ID before contacting Drive',
  );
  console.log('   ✓ destination selection validates known-safe IDs before the Drive call');

  // ── encrypted token file lifecycle (no network — no token yet) ────────
  const tokenPath = path.join(testDir, 'google-drive-token.enc');
  const restoreIntentPath = path.join(testDir, 'google-drive-restore.pending');
  assert.equal(fs.existsSync(tokenPath), false, 'no token file before ever connecting');

  // Simulate a connected state the way connect() would have left it,
  // without touching the network: write the same shape connect() would.
  const fakeTokens = { access_token: 'fake-access-token', refresh_token: 'fake-refresh-token', expiry_date: Date.now() + 3600_000 };
  fs.writeFileSync(tokenPath, mockSafeStorage.encryptString(JSON.stringify(fakeTokens)), { mode: 0o600 });

  status = gd.googleDrive.getStatus();
  assert.equal(status.connected, false, 'legacy token without account binding is not treated as connected');
  assert.equal(status.auth_state, 'reauth_required', 'legacy token without account binding requires reauthentication');
  fs.writeFileSync(restoreIntentPath, 'prepared', { mode: 0o600 });
  assert.throws(
    () => gd.googleDrive.clearDatabaseRestoreInvalidation(),
    /ambiguous/,
    'legacy unbound tokens retain an unresolved restore boundary',
  );
  assert.equal(fs.existsSync(restoreIntentPath), true, 'legacy restore intent is retained until its outcome is proven');
  fs.unlinkSync(restoreIntentPath);
  console.log('   ✓ getStatus() requires account binding before unattended Drive use');

  // The auth library emits refreshed access tokens synchronously. Verify the
  // service persists the new access token while retaining the refresh token
  // needed for unattended scheduled backups.
  await assert.rejects(
    gd.googleDrive.getAuthorizedClient(),
    (error: any) => error?.code === 'reauth_required',
    'legacy token cannot authorize Google Drive access',
  );
  const marker = fs.readFileSync(path.join(testDir, 'google-drive-installation.marker'), 'utf8').trim();
  const markerPath = path.join(testDir, 'google-drive-installation.marker');
  const markerMutableFs = nativeFs as unknown as { renameSync: typeof fs.renameSync };
  const originalMarkerRenameSync = markerMutableFs.renameSync;
  fs.unlinkSync(markerPath);
  markerMutableFs.renameSync = ((source, target) => {
    if (String(target) === markerPath) throw new Error('injected installation marker rename failure');
    return originalMarkerRenameSync(source, target);
  }) as typeof fs.renameSync;
  assert.throws(() => (gd.googleDrive as any).ensureInstallationMarker(), /injected installation marker rename failure/, 'installation marker persistence failures stop Drive setup');
  assert.equal(fs.existsSync(markerPath), false, 'failed installation marker persistence does not leave an active marker');
  assert.equal(fs.readdirSync(testDir).some((name) => name.startsWith('google-drive-installation.marker.tmp-')), false, 'failed installation marker persistence removes its temporary file');
  markerMutableFs.renameSync = originalMarkerRenameSync;
  fs.writeFileSync(markerPath, marker, { mode: 0o600 });
  const clientIdFingerprint = crypto.createHash('sha256').update('test-client-id').digest('hex').slice(0, 16);
  getDatabase().prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run('google_drive_account_subject', 'subject-a', now());
  fs.writeFileSync(tokenPath, mockSafeStorage.encryptString(JSON.stringify({ ...fakeTokens, version: 2, installation_id: marker, account_subject: 'subject-a', client_id_fingerprint: clientIdFingerprint })), { mode: 0o600 });
  const authorizedClient = await gd.googleDrive.getAuthorizedClient();
  authorizedClient.emit('tokens', { access_token: 'refreshed-access-token', expiry_date: Date.now() + 7200_000 });
  const persistedTokens = JSON.parse(mockSafeStorage.decryptString(fs.readFileSync(tokenPath))) as Record<string, unknown>;
  assert.equal(persistedTokens.access_token, 'refreshed-access-token', 'refreshed access token is persisted');
  assert.equal(persistedTokens.refresh_token, 'fake-refresh-token', 'refresh token survives access-token persistence');

  const tokenMutableFs = nativeFs as unknown as { fsyncSync: typeof fs.fsyncSync; renameSync: typeof fs.renameSync };
  const originalTokenContents = nativeFs.readFileSync(tokenPath);
  const originalTokenFsyncSync = nativeFs.fsyncSync;
  tokenMutableFs.fsyncSync = () => { throw new Error('injected token fsync failure'); };
  assert.throws(
    () => (gd.googleDrive as any).writeTokens({ ...fakeTokens, refresh_token: 'replacement-refresh-token' }),
    /injected token fsync failure/,
    'token fsync failures propagate without replacing the existing credential',
  );
  tokenMutableFs.fsyncSync = originalTokenFsyncSync;
  assert.deepEqual(nativeFs.readFileSync(tokenPath), originalTokenContents, 'token fsync failures preserve the existing credential');
  assert.equal(fs.readdirSync(testDir).some((name) => name.startsWith('google-drive-token.enc.tmp-')), false, 'token fsync failures remove temporary files');

  const originalTokenOpenSync = nativeFs.openSync;
  const originalDirectoryTokenFsyncSync = nativeFs.fsyncSync;
  const tokenMutableDirectoryFs = nativeFs as unknown as { openSync: typeof fs.openSync; fsyncSync: typeof fs.fsyncSync };
  let directoryTokenSync = false;
  tokenMutableDirectoryFs.openSync = ((filePath, flags, mode) => {
    directoryTokenSync = String(filePath) === testDir;
    return originalTokenOpenSync(filePath, flags, mode as any);
  }) as typeof fs.openSync;
  tokenMutableDirectoryFs.fsyncSync = (fd) => {
    if (directoryTokenSync) throw new Error('injected token directory sync failure');
    return originalDirectoryTokenFsyncSync(fd);
  };
  if (process.platform !== 'win32') {
    assert.throws(
      () => (gd.googleDrive as any).writeTokens({ ...fakeTokens, refresh_token: 'replacement-refresh-token' }),
      /injected token directory sync failure|Token persistence is ambiguous/,
      'token directory sync failures propagate after replacement',
    );
    assert.deepEqual(nativeFs.readFileSync(tokenPath), originalTokenContents, 'token directory sync failures restore the existing credential');
    for (const name of fs.readdirSync(testDir).filter((entry) => entry.startsWith('google-drive-token.enc.restore-'))) nativeFs.unlinkSync(path.join(testDir, name));
    (gd.googleDrive as any).tokenReadIssue = null;
  }
  tokenMutableDirectoryFs.openSync = originalTokenOpenSync;
  tokenMutableDirectoryFs.fsyncSync = originalDirectoryTokenFsyncSync;

  const originalTokenRenameSync = nativeFs.renameSync;
  tokenMutableFs.renameSync = ((source, target) => {
    if (String(target) === tokenPath) throw new Error('injected token rename failure');
    return originalTokenRenameSync(source, target);
  }) as typeof fs.renameSync;
  assert.throws(
    () => (gd.googleDrive as any).writeTokens({ ...fakeTokens, refresh_token: 'replacement-refresh-token' }),
    /injected token rename failure/,
    'token rename failures propagate without deleting the existing credential',
  );
  tokenMutableFs.renameSync = originalTokenRenameSync;
  assert.deepEqual(nativeFs.readFileSync(tokenPath), originalTokenContents, 'token rename failures preserve the existing credential');
  assert.equal(fs.readdirSync(testDir).some((name) => name.startsWith('google-drive-token.enc.tmp-')), false, 'token rename failures remove temporary files');

  const startupRestorePath = path.join(testDir, 'google-drive-token.enc.restore-startup');
  const boundTokens = JSON.parse(mockSafeStorage.decryptString(originalTokenContents));
  const startupPreviousToken = mockSafeStorage.encryptString(JSON.stringify({ ...boundTokens, refresh_token: 'startup-previous-token' }));
  nativeFs.writeFileSync(tokenPath, mockSafeStorage.encryptString(JSON.stringify({ ...boundTokens, refresh_token: 'startup-replacement-token' })));
  nativeFs.writeFileSync(startupRestorePath, startupPreviousToken, { mode: 0o600 });
  const recoveredEnvelope = (gd.googleDrive as any).readTokenEnvelope();
  assert.equal(recoveredEnvelope.refresh_token, 'startup-previous-token', 'startup consumes a retained token rollback artifact');
  assert.equal(fs.existsSync(startupRestorePath), false, 'startup removes consumed token rollback evidence');
  nativeFs.writeFileSync(tokenPath, originalTokenContents);
  console.log('   ✓ refreshed access tokens are persisted without losing the refresh token');

  fs.writeFileSync(restoreIntentPath, JSON.stringify({ phase: 'prepared', database_account_subject: 'subject-a' }), { mode: 0o600 });
  decryptFails = true;
  assert.throws(
    () => gd.googleDrive.clearDatabaseRestoreInvalidation(),
    /ambiguous/,
    'temporary safeStorage failures retain the restore boundary',
  );
  assert.equal(fs.existsSync(tokenPath), true, 'temporary safeStorage failures retain the token file');
  assert.equal(fs.existsSync(restoreIntentPath), true, 'temporary safeStorage failures retain the restore intent');
  decryptFails = false;
  gd.googleDrive.clearDatabaseRestoreInvalidation();
  assert.equal(fs.existsSync(tokenPath), true, 'a recovered pre-journal restore preserves the token file');
  assert.equal(fs.existsSync(restoreIntentPath), false, 'a recovered pre-journal restore clears its intent');
  console.log('   ✓ restore recovery distinguishes legacy, unreadable, and recovered token states');

  getDatabase().prepare("DELETE FROM settings WHERE key = 'google_drive_account_subject'").run();
  fs.writeFileSync(restoreIntentPath, JSON.stringify({ phase: 'prepared', database_account_subject: null }), { mode: 0o600 });
  assert.throws(
    () => gd.googleDrive.clearDatabaseRestoreInvalidation(),
    /ambiguous/,
    'a partial binding with a null baseline retains an unresolved restore boundary',
  );
  assert.equal(fs.existsSync(tokenPath), true, 'partial binding recovery retains the token file');
  assert.equal(fs.existsSync(restoreIntentPath), true, 'partial binding recovery retains the restore intent');
  await assert.rejects(
    gd.googleDrive.backupNow(),
    (error: any) => error?.code === 'conflict',
    'ambiguous recovery continues blocking ordinary Drive work',
  );
  getDatabase().prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run('google_drive_account_subject', 'subject-a', now());
  status = gd.googleDrive.getStatus();
  assert.equal(status.connected, false, 'cleanup-pending recovery does not report a connected account');
  assert.equal(status.auth_state, 'reauth_required', 'cleanup-pending recovery exposes reauthentication');
  fs.unlinkSync(restoreIntentPath);
  gd.googleDrive.clearDatabaseRestoreInvalidation();
  console.log('   ✓ partial account bindings do not infer a completed replacement');

  const mutableFs = nativeFs as unknown as { fsyncSync: typeof fs.fsyncSync; unlinkSync: typeof fs.unlinkSync };
  const originalFsyncSync = nativeFs.fsyncSync;
  if (process.platform !== 'win32') {
    let fsyncCalls = 0;
    mutableFs.fsyncSync = (fd) => {
      fsyncCalls += 1;
      if (fsyncCalls === 2) throw new Error('directory sync unavailable');
      return originalFsyncSync(fd);
    };
    await assert.rejects(
      gd.googleDrive.beginDatabaseRestoreInvalidation(),
      /durably record/,
      'intent persistence failures retain a recovery boundary',
    );
    mutableFs.fsyncSync = originalFsyncSync;
    status = gd.googleDrive.getStatus();
    assert.equal(status.connected, false, 'intent persistence failure does not report connected');
    assert.equal(status.auth_state, 'reauth_required', 'intent persistence failure exposes reauthentication');
    gd.googleDrive.clearDatabaseRestoreInvalidation();
  }

  fs.writeFileSync(restoreIntentPath, JSON.stringify({ phase: 'prepared', database_account_subject: 'subject-a' }), { mode: 0o600 });
  const originalUnlinkSync = nativeFs.unlinkSync;
  mutableFs.unlinkSync = (target) => {
    if (String(target) === restoreIntentPath) throw new Error('intent cleanup unavailable');
    return originalUnlinkSync(target);
  };
  assert.throws(
    () => gd.googleDrive.clearDatabaseRestoreInvalidation(),
    /intent cleanup unavailable/,
    'intent cleanup failures retain a recovery boundary',
  );
  mutableFs.unlinkSync = originalUnlinkSync;
  status = gd.googleDrive.getStatus();
  assert.equal(status.connected, false, 'intent cleanup failure does not report connected');
  assert.equal(status.auth_state, 'reauth_required', 'intent cleanup failure exposes reauthentication');
  gd.googleDrive.clearDatabaseRestoreInvalidation();

  if (process.platform !== 'win32') {
    fs.writeFileSync(restoreIntentPath, JSON.stringify({ phase: 'prepared', database_account_subject: 'subject-a' }), { mode: 0o600 });
    mutableFs.fsyncSync = () => { throw new Error('directory sync unavailable'); };
    assert.throws(
      () => gd.googleDrive.clearDatabaseRestoreInvalidation(),
      /durably clear/,
      'directory cleanup failures retain recovery state after unlinking the intent',
    );
    assert.equal(fs.existsSync(restoreIntentPath), false, 'directory cleanup failure leaves the intent unlinked');
    mutableFs.fsyncSync = originalFsyncSync;
    (gd.googleDrive as any).terminalCleanup = false;
    gd.googleDrive.start();
    status = gd.googleDrive.getStatus();
    assert.equal(status.connected, true, 'retrying directory cleanup releases recovery state');
  }

  await gd.googleDrive.stop();
  const originalMaybeRunScheduled = (gd.googleDrive as any).maybeRunScheduled;
  let startupChecks = 0;
  (gd.googleDrive as any).maybeRunScheduled = async () => { startupChecks += 1; };
  gd.googleDrive.start();
  assert.ok((gd.googleDrive as any).scheduleTimer, 'normal startup arms scheduled backups');
  (gd.googleDrive as any).restoreInvalidationCleanupPending = true;
  (gd.googleDrive as any).databaseRestorePending = true;
  decryptFails = true;
  (gd.googleDrive as any).tokenReadIssue = 'corrupt';
  gd.googleDrive.start();
  assert.equal((gd.googleDrive as any).scheduleTimer, null, 'ambiguous startup recovery keeps scheduling blocked');
  decryptFails = false;
  (gd.googleDrive as any).tokenReadIssue = null;
  gd.googleDrive.clearDatabaseRestoreInvalidation();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(startupChecks, 1, 'successful recovery rearms the startup backup check');
  assert.ok((gd.googleDrive as any).scheduleTimer, 'successful recovery rearms scheduled backups');
  (gd.googleDrive as any).maybeRunScheduled = originalMaybeRunScheduled;

  const requestAbort = new AbortController();
  requestAbort.abort();
  await assert.rejects(
    gd.googleDrive.backupNow(requestAbort.signal),
    (error: any) => error?.code === 'ERR_SHUTDOWN_ABORTED',
    'backupNow observes an already-aborted request signal',
  );

  const originalRunBackup = (gd.googleDrive as any).runBackup;
  const expectedShutdown = Object.assign(new Error('backup cancelled'), { code: 'ERR_SHUTDOWN_ABORTED' });
  (gd.googleDrive as any).runBackup = () => Promise.reject(expectedShutdown);
  const aggregateChild = Promise.reject(expectedShutdown);
  const activeDriveOperations = (gd.googleDrive as any).activeDriveOperations as Set<Promise<unknown>>;
  activeDriveOperations.add(aggregateChild);
  void aggregateChild.finally(() => activeDriveOperations.delete(aggregateChild)).catch(() => {});
  const aggregateBackup = gd.googleDrive.backupNow();
  void aggregateBackup.catch(() => {});
  await gd.googleDrive.stop();
  await assert.rejects(aggregateBackup, (error: any) => error?.code === 'ERR_SHUTDOWN_ABORTED');
  gd.googleDrive.start();
  console.log('   ✓ normal shutdown accepts nested cancellation failures from tracked Drive work');

  let releaseActiveDriveOperation!: () => void;
  let driveCancelCalled = false;
  const activeDriveOperation = Object.assign(new Promise<void>((resolve) => {
    releaseActiveDriveOperation = resolve;
  }), {
    cancel: () => {
      driveCancelCalled = true;
      releaseActiveDriveOperation();
    },
  });
  activeDriveOperations.add(activeDriveOperation);
  void activeDriveOperation.finally(() => activeDriveOperations.delete(activeDriveOperation)).catch(() => {});

  let rejectBackup!: (error: Error & { code: string }) => void;
  (gd.googleDrive as any).runBackup = () => new Promise((_resolve: unknown, reject: typeof rejectBackup) => {
    rejectBackup = reject;
  });
  const activeBackup = gd.googleDrive.backupNow();
  await new Promise((resolve) => setImmediate(resolve));
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, delay?: number, ...args: any[]) =>
    originalSetTimeout(handler, delay === 10_000 ? 1 : delay, ...args)) as typeof setTimeout;
  const stopPromise = gd.googleDrive.stop();
  let databaseClosed = false;
  let fatalTimeoutObserved = false;
  try {
    await assert.rejects(
      runShutdownSteps([
        { name: 'Google Drive', blocksDatabase: true, run: () => stopPromise },
        { name: 'database', databaseClose: true, run: () => { databaseClosed = true; } },
      ], { onFatalTimeout: () => { fatalTimeoutObserved = true; } }),
      (error: any) => error?.code === 'ERR_SHUTDOWN_TIMEOUT',
      'shutdown reports a bounded timeout when backup ownership will not settle',
    );
    assert.equal(databaseClosed, false, 'a bounded Drive timeout blocks database closure');
    assert.equal(fatalTimeoutObserved, true, 'a bounded Drive timeout invokes fatal termination');
    assert.equal(driveCancelCalled, true, 'stop() cancels tracked Drive work before reporting timeout');
  } finally {
    (globalThis as any).setTimeout = originalSetTimeout;
  }
  const shutdownCancellation = Object.assign(new Error('backup cancelled'), { code: 'ERR_SHUTDOWN_ABORTED' });
  rejectBackup(shutdownCancellation);
  await assert.rejects(activeBackup, (error: any) => error?.code === 'ERR_SHUTDOWN_ABORTED');
  (gd.googleDrive as any).runBackup = originalRunBackup;
  console.log('   ✓ stop() bounds non-cooperative backup cleanup and guards late completion');

  let releaseQueuedOperation!: () => void;
  (gd.googleDrive as any).operationTail = new Promise<void>((resolve) => { releaseQueuedOperation = resolve; });
  const queuedJobStatus = gd.googleDrive.startBackupJob('manual', true);
  assert.equal(queuedJobStatus.job?.state, 'queued', 'backup job starts in the queued state');
  const cancelledQueuedJob = gd.googleDrive.cancelJob(queuedJobStatus.job!.id);
  assert.equal(cancelledQueuedJob.job?.state, 'cancelled', 'cancelling a queued job persists cancelled state');
  releaseQueuedOperation();
  await new Promise((resolve) => setImmediate(resolve));
  console.log('   ✓ queued job cancellation finalizes before its operation starts');

  let releaseRestoreBoundaryQueue!: () => void;
  (gd.googleDrive as any).operationTail = new Promise<void>((resolve) => { releaseRestoreBoundaryQueue = resolve; });
  const restoreBoundaryJobStatus = gd.googleDrive.startBackupJob('manual', true);
  await gd.googleDrive.beginDatabaseRestoreInvalidation();
  releaseRestoreBoundaryQueue();
  await new Promise((resolve) => setImmediate(resolve));
  const restoreBoundaryJob = gd.googleDrive.getJob(restoreBoundaryJobStatus.job!.id);
  assert.equal(restoreBoundaryJob?.state, 'failed', 'restore invalidation finalizes a queued job rejected before it starts');
  assert.equal(restoreBoundaryJob?.error_code, 'conflict', 'pre-start restore invalidation records the conflict outcome');
  gd.googleDrive.clearDatabaseRestoreInvalidation();
  console.log('   ✓ restore invalidation finalizes queued jobs rejected before execution');

  const rawTokenFile = fs.readFileSync(tokenPath, 'utf8');
  assert.ok(!rawTokenFile.includes('flo-backup'), 'sanity: file is the token blob, not something else');
  assert.ok(rawTokenFile.includes('fake-refresh-token'), 'mock encryption is identity — real safeStorage would actually encrypt this in production');
  console.log('   ✓ token file round-trips through the same safeStorage pattern as master-pin.ts');

  (gd.googleDrive as any).terminalCleanup = false;
  gd.googleDrive.start();
  const settingsStatement = getDatabase().prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
  const pendingUploadPath = driveStagingPath;
  settingsStatement.run('google_drive_pending_upload', JSON.stringify({
    run_id: 'pending-run',
    kind: 'manual',
    local_path: pendingUploadPath,
    sha256: 'a'.repeat(64),
    byte_count: 1,
    schema_version: 1,
    app_version: 'test',
    backup_created_at: new Date().toISOString(),
    destination_folder_id: 'folder-a',
    attempt_count: 1,
    next_retry_at: null,
  }), now());
  settingsStatement.run('google_drive_job', JSON.stringify({ id: 'stale-backup', operation: 'backup', kind: 'manual', state: 'uploading', updated_at: now() }), now());
  const originalArmScheduling = (gd.googleDrive as any).armScheduling;
  (gd.googleDrive as any).armScheduling = () => {};
  await gd.googleDrive.stop();
  gd.googleDrive.start();
  assert.equal(gd.googleDrive.getJob('stale-backup')?.state, 'offline_pending', 'startup reconciles a stale backup job using its pending snapshot');
  settingsStatement.run('google_drive_job', JSON.stringify({ id: 'stale-restore', operation: 'restore', state: 'restoring', updated_at: now() }), now());
  gd.googleDrive.start();
  assert.equal(gd.googleDrive.getJob('stale-restore')?.state, 'failed', 'startup clears a stale restore job without recovery evidence');
  assert.equal(gd.googleDrive.getJob('stale-restore')?.error_code, 'restore_failed', 'stale restore reports a bounded failure');
  settingsStatement.run('google_drive_pending_upload', JSON.stringify({
    run_id: 'automatic-pending-run',
    kind: 'automatic',
    local_path: pendingUploadPath,
    sha256: 'a'.repeat(64),
    byte_count: 1,
    schema_version: 1,
    app_version: 'test',
    backup_created_at: new Date().toISOString(),
    destination_folder_id: 'folder-a',
    attempt_count: 1,
    next_retry_at: null,
  }), now());
  settingsStatement.run('google_drive_job', JSON.stringify({ id: 'stale-backup', operation: 'backup', kind: 'automatic', state: 'offline_pending', updated_at: now() }), now());
  assert.throws(
    () => gd.googleDrive.startBackupJob('manual', true),
    (error: any) => error?.code === 'conflict',
    'manual backups cannot replace a pending automatic upload',
  );
  assert.equal(gd.googleDrive.getJob('stale-backup')?.state, 'offline_pending', 'pending automatic job identity is preserved');
  settingsStatement.run('google_drive_pending_upload', JSON.stringify({
    run_id: 'pending-run',
    kind: 'manual',
    local_path: pendingUploadPath,
    sha256: 'a'.repeat(64),
    byte_count: 1,
    schema_version: 1,
    app_version: 'test',
    backup_created_at: new Date().toISOString(),
    destination_folder_id: 'folder-a',
    attempt_count: 1,
    next_retry_at: null,
  }), now());
  settingsStatement.run('google_drive_job', JSON.stringify({ id: 'stale-backup', operation: 'backup', kind: 'manual', state: 'offline_pending', updated_at: now() }), now());
  (gd.googleDrive as any).armScheduling = originalArmScheduling;
  console.log('   ✓ startup reconciles persisted Drive jobs before scheduling new work');
  for (const [key, value] of [
    ['google_drive_account_subject', 'subject-a'],
    ['google_drive_destination_folder_id', 'folder-a'],
    ['google_drive_destination_folder_name', 'FloCafe Backups'],
    ['google_drive_folder_id', 'folder-a'],
    ['google_drive_owned_destinations', '["folder-a","folder-b"]'],
  ]) settingsStatement.run(key, value, now());

  const originalListFilesInDestination = (gd.googleDrive as any).listFilesInDestination;
  try {
    for (const [statusCode, expectedCode] of [[401, 'reauth_required'], [403, 'permission_denied']] as const) {
      (gd.googleDrive as any).listFilesInDestination = async () => { throw { response: { status: statusCode } }; };
      await assert.rejects(
        (gd.googleDrive as any).applyRetention({}, new AbortController().signal),
        (error: any) => error?.code === expectedCode && error?.retryable === false,
        `retention ${statusCode} is surfaced as ${expectedCode}`,
      );
    }
  } finally {
    (gd.googleDrive as any).listFilesInDestination = originalListFilesInDestination;
  }
  gd.googleDrive.updatePreferences({ retention_count: 1 });
  const originalRetentionListing = (gd.googleDrive as any).listFilesInDestination;
  try {
    for (const [statusCode, expectedCode] of [[401, 'reauth_required'], [403, 'permission_denied']] as const) {
      (gd.googleDrive as any).listFilesInDestination = async (_client: unknown, _folderId: string, _signal: AbortSignal, options: { onFile: (file: unknown) => Promise<void> }) => {
        await options.onFile({ id: 'remote-new', createdTime: '2024-01-02T00:00:00.000Z', appProperties: { flo_installation_id: (gd.googleDrive as any).ensureInstallationMarker(), flo_backup_kind: 'automatic', flo_destination_folder_id: 'folder-a' } });
        await options.onFile({ id: 'remote-old', createdTime: '2024-01-01T00:00:00.000Z', appProperties: { flo_installation_id: (gd.googleDrive as any).ensureInstallationMarker(), flo_backup_kind: 'automatic', flo_destination_folder_id: 'folder-a' } });
      };
      const updateDriveClient = { files: { update: async () => { throw { response: { status: statusCode } }; } } };
      await assert.rejects(
        (gd.googleDrive as any).applyRetention(updateDriveClient, new AbortController().signal),
        (error: any) => error?.code === expectedCode && error?.retryable === false,
        `trashing an old automatic backup surfaces ${expectedCode} for retention ${statusCode}`,
      );
    }
  } finally {
    (gd.googleDrive as any).listFilesInDestination = originalRetentionListing;
  }
  gd.googleDrive.updatePreferences({ retention_count: 25 });
  console.log('   ✓ retention authorization failures stop retry loops with owner-visible errors');

  settingsStatement.run('google_drive_last_error_code', 'destination_invalid', now());
  settingsStatement.run('google_drive_next_retry_at', new Date(0).toISOString(), now());
  settingsStatement.run('google_drive_pending_upload', JSON.stringify({
    run_id: 'invalid-destination-run',
    kind: 'manual',
    local_path: pendingUploadPath,
    sha256: 'a'.repeat(64),
    byte_count: 1,
    schema_version: 1,
    app_version: 'test',
    backup_created_at: new Date().toISOString(),
    destination_folder_id: 'folder-a',
    attempt_count: 1,
    next_retry_at: new Date(0).toISOString(),
  }), now());
  settingsStatement.run('google_drive_job', JSON.stringify({ id: 'invalid-destination-job', operation: 'backup', kind: 'manual', state: 'uploading', updated_at: now() }), now());
  (gd.googleDrive as any).reconcilePersistedJob();
  assert.equal(gd.googleDrive.getJob('invalid-destination-job')?.state, 'failed', 'invalid destinations pause persisted jobs');
  assert.equal(JSON.parse((getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get('google_drive_pending_upload') as { value?: string } | undefined)?.value || '{}').next_retry_at, null, 'invalid destinations do not schedule another retry');
  settingsStatement.run('google_drive_last_error_code', '', now());
  console.log('   ✓ invalid destinations pause persisted retries until corrected');

  settingsStatement.run('google_drive_retention_status', 'pending', now());
  settingsStatement.run('google_drive_next_retry_at', '', now());
  settingsStatement.run('google_drive_last_error_code', 'retention_pending', now());
  settingsStatement.run('google_drive_pending_upload', '', now());
  settingsStatement.run('google_drive_job', JSON.stringify({ id: 'retention-recovery-job', operation: 'backup', kind: 'automatic', state: 'retention_pending', updated_at: now() }), now());
  (gd.googleDrive as any).reconcilePersistedJob();
  assert.equal(gd.googleDrive.getJob('retention-recovery-job')?.state, 'retention_pending', 'startup preserves a persisted retention boundary');
  assert.equal(gd.googleDrive.getStatus().retention_status, 'pending', 'startup keeps retention visibly pending');
  settingsStatement.run('google_drive_retention_status', '', now());
  settingsStatement.run('google_drive_last_error_code', '', now());
  settingsStatement.run('google_drive_job', '', now());
  console.log('   ✓ startup recovers retention-pending state without reporting success');

  const originalSnapshotFromPending = (gd.googleDrive as any).snapshotFromPending;
  const originalCancelAuthorizedClient = (gd.googleDrive as any).getAuthorizedClient;
  const originalCancelResolveDestination = (gd.googleDrive as any).resolveDestinationForUpload;
  const originalCancelUploadSnapshot = (gd.googleDrive as any).uploadSnapshot;
  let releaseCancelledUpload!: () => void;
  (gd.googleDrive as any).getAuthorizedClient = async () => ({});
  (gd.googleDrive as any).resolveDestinationForUpload = async () => 'folder-a';
  (gd.googleDrive as any).snapshotFromPending = async () => ({ path: pendingUploadPath, fileName: 'upload-test.db', sha256: 'a'.repeat(64), byteCount: 1, schemaVersion: 1, appVersion: 'test', backupCreatedAt: new Date().toISOString() });
  (gd.googleDrive as any).uploadSnapshot = async () => new Promise((resolve) => {
    releaseCancelledUpload = () => resolve({ id: 'remote-cancelled', createdTime: new Date().toISOString() });
  });
  const waitForUploading = async (jobId: string): Promise<void> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (gd.googleDrive.getJob(jobId)?.state === 'uploading') return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Drive job ${jobId} never reached the upload phase`);
  };
  const settleActiveJobs = async (): Promise<void> => {
    for (let attempt = 0; attempt < 400 && (gd.googleDrive as any).activeJobs.size > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setImmediate(resolve));
  };

  const cancelledEmptyJob = gd.googleDrive.startBackupJob('manual', true);
  await waitForUploading(cancelledEmptyJob.job!.id);
  getDatabase().prepare('UPDATE settings SET value = ? WHERE key = ?').run('', 'google_drive_pending_upload');
  const cancelledEmptyStatus = gd.googleDrive.cancelJob(cancelledEmptyJob.job!.id);
  assert.equal(cancelledEmptyStatus.job?.state, 'cancelled', 'cancelling without a retained snapshot ends the job instead of leaving it in flight');
  releaseCancelledUpload();
  await settleActiveJobs();

  settingsStatement.run('google_drive_pending_upload', JSON.stringify({
    run_id: 'cancel-retry-run',
    kind: 'manual',
    local_path: pendingUploadPath,
    sha256: 'a'.repeat(64),
    byte_count: 1,
    schema_version: 1,
    app_version: 'test',
    backup_created_at: new Date().toISOString(),
    destination_folder_id: 'folder-a',
    attempt_count: 1,
    next_retry_at: new Date().toISOString(),
  }), now());
  const cancelledPendingJob = gd.googleDrive.startBackupJob('manual', true);
  await waitForUploading(cancelledPendingJob.job!.id);
  const cancelledPendingStatus = gd.googleDrive.cancelJob(cancelledPendingJob.job!.id);
  assert.equal(cancelledPendingStatus.job?.state, 'offline_pending', 'cancelling an active upload with a pending snapshot queues an automatic retry');
  releaseCancelledUpload();
  await settleActiveJobs();
  const retainedPendingJob = gd.googleDrive.getJob(cancelledPendingJob.job!.id);
  assert.equal(retainedPendingJob?.state, 'offline_pending', 'cancelled upload remains visibly pending for retry');
  const pendingAfterCancellation = JSON.parse((getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get('google_drive_pending_upload') as { value?: string } | undefined)?.value || '{}') as { next_retry_at?: string };
  assert.ok(pendingAfterCancellation.next_retry_at, 'cancelled upload retains a retry timestamp');

  (gd.googleDrive as any).getAuthorizedClient = originalCancelAuthorizedClient;
  (gd.googleDrive as any).resolveDestinationForUpload = originalCancelResolveDestination;
  (gd.googleDrive as any).uploadSnapshot = originalCancelUploadSnapshot;
  console.log('   ✓ cancelling an active Drive upload retains the snapshot for automatic retry');

  const originalRetryGetAuthorizedClient = (gd.googleDrive as any).getAuthorizedClient;
  const originalRetryResolveDestination = (gd.googleDrive as any).resolveDestinationForUpload;
  const originalRetryUploadSnapshot = (gd.googleDrive as any).uploadSnapshot;
  const originalRetryApplyRetention = (gd.googleDrive as any).applyRetention;
  (gd.googleDrive as any).getAuthorizedClient = async () => ({});
  (gd.googleDrive as any).resolveDestinationForUpload = async () => 'folder-a';
  (gd.googleDrive as any).snapshotFromPending = async () => ({ path: pendingUploadPath, fileName: 'upload-test.db', sha256: 'a'.repeat(64), byteCount: 1, schemaVersion: 1, appVersion: 'test', backupCreatedAt: new Date().toISOString() });
  (gd.googleDrive as any).uploadSnapshot = async () => ({ id: 'remote-retry-success' });
  (gd.googleDrive as any).applyRetention = async () => {};
  await gd.googleDrive.backupNow(undefined, 'manual');
  assert.equal(gd.googleDrive.getJob(cancelledPendingJob.job!.id)?.state, 'succeeded', 'scheduled pending retry finalizes its persisted backup job');
  assert.equal((getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get('google_drive_pending_upload') as { value?: string } | undefined)?.value || '', '', 'successful pending retry clears the retained snapshot');
  assert.equal(gd.googleDrive.getStatus().retention_status, 'ok', 'successful retention cleanup clears the pending boundary');
  (gd.googleDrive as any).getAuthorizedClient = originalRetryGetAuthorizedClient;
  (gd.googleDrive as any).resolveDestinationForUpload = originalRetryResolveDestination;
  (gd.googleDrive as any).uploadSnapshot = originalRetryUploadSnapshot;
  (gd.googleDrive as any).applyRetention = originalRetryApplyRetention;
  (gd.googleDrive as any).snapshotFromPending = originalSnapshotFromPending;
  console.log('   ✓ scheduled pending retries finalize their persisted job state');

  await createBackup(driveStagingPath, undefined, { stagingDirectory: path.dirname(driveStagingPath) });
  settingsStatement.run('google_drive_pending_upload', JSON.stringify({
    run_id: 'duplicate-run',
    kind: 'manual',
    local_path: pendingUploadPath,
    sha256: 'a'.repeat(64),
    byte_count: 1,
    schema_version: 1,
    app_version: 'test',
    backup_created_at: new Date().toISOString(),
    destination_folder_id: 'folder-a',
    attempt_count: 1,
    next_retry_at: new Date().toISOString(),
  }), now());
  settingsStatement.run('google_drive_job', JSON.stringify({ id: 'duplicate-job', operation: 'backup', kind: 'manual', state: 'offline_pending', updated_at: now() }), now());
  const duplicateUploadError = Object.assign(new Error('duplicate upload'), { code: 'duplicate_upload' });
  (gd.googleDrive as any).getAuthorizedClient = async () => ({});
  (gd.googleDrive as any).resolveDestinationForUpload = async () => 'folder-a';
  (gd.googleDrive as any).snapshotFromPending = async () => ({ path: pendingUploadPath, fileName: 'upload-test.db', sha256: 'a'.repeat(64), byteCount: 1, schemaVersion: 1, appVersion: 'test', backupCreatedAt: new Date().toISOString() });
  (gd.googleDrive as any).uploadSnapshot = async () => { throw duplicateUploadError; };
  const duplicateStatus = await gd.googleDrive.backupNow(undefined, 'manual');
  assert.equal(duplicateStatus.last_error, 'duplicate_upload', 'duplicate upload is surfaced as a conflict');
  assert.equal(gd.googleDrive.getJob('duplicate-job')?.state, 'failed', 'duplicate upload pauses the persisted job');
  assert.equal(gd.googleDrive.getJob('duplicate-job')?.error_code, 'duplicate_upload', 'duplicate upload preserves its conflict code');
  const duplicatePending = JSON.parse((getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get('google_drive_pending_upload') as { value?: string } | undefined)?.value || '{}') as { next_retry_at?: string };
  assert.equal(duplicatePending.next_retry_at, null, 'duplicate upload retains the snapshot without automatic retry');
  assert.equal(fs.existsSync(pendingUploadPath), true, 'duplicate upload retains the local snapshot');
  (gd.googleDrive as any).getAuthorizedClient = originalRetryGetAuthorizedClient;
  (gd.googleDrive as any).resolveDestinationForUpload = originalRetryResolveDestination;
  (gd.googleDrive as any).snapshotFromPending = originalSnapshotFromPending;
  (gd.googleDrive as any).uploadSnapshot = originalRetryUploadSnapshot;
  console.log('   ✓ duplicate uploads retain the snapshot and pause for conflict resolution');

  const originalGetAuthorizedClient = (gd.googleDrive as any).getAuthorizedClient;
  const originalResolveDestination = (gd.googleDrive as any).resolveDestinationForUpload;
  const originalUploadSnapshot = (gd.googleDrive as any).uploadSnapshot;
  let releaseCompletedUpload!: (result: { id: string }) => void;
  (gd.googleDrive as any).getAuthorizedClient = async () => ({ });
  (gd.googleDrive as any).resolveDestinationForUpload = async () => 'folder-a';
  (gd.googleDrive as any).snapshotFromPending = async () => ({ path: pendingUploadPath, fileName: 'upload-test.db', sha256: 'a'.repeat(64), byteCount: 1, schemaVersion: 1, appVersion: 'test', backupCreatedAt: new Date().toISOString() });
  (gd.googleDrive as any).uploadSnapshot = async () => new Promise((resolve) => { releaseCompletedUpload = resolve; });
  const racedCancellationJob = gd.googleDrive.startBackupJob('manual', true);
  for (let attempt = 0; attempt < 400 && typeof releaseCompletedUpload !== 'function'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(typeof releaseCompletedUpload, 'function', 'upload reaches the cancellable completion boundary');
  releaseCompletedUpload({ id: 'remote-after-cancel' });
  const racedCancellationStatus = gd.googleDrive.cancelJob(racedCancellationJob.job!.id);
  assert.equal(racedCancellationStatus.job?.state, 'offline_pending', 'cancellation wins after the remote upload promise resolves');
  await settleActiveJobs();
  assert.equal(gd.googleDrive.getJob(racedCancellationJob.job!.id)?.state, 'offline_pending', 'late upload completion cannot clear the retry state');
  (gd.googleDrive as any).getAuthorizedClient = originalGetAuthorizedClient;
  (gd.googleDrive as any).resolveDestinationForUpload = originalResolveDestination;
  (gd.googleDrive as any).uploadSnapshot = originalUploadSnapshot;
  (gd.googleDrive as any).snapshotFromPending = originalSnapshotFromPending;
  console.log('   ✓ cancellation recheck preserves retry state after a late upload completion');

  const originalRetentionClient = (gd.googleDrive as any).getAuthorizedClient;
  (gd.googleDrive as any).getAuthorizedClient = async () => { throw Object.assign(new Error('reauthentication required'), { code: 'reauth_required' }); };
  settingsStatement.run('google_drive_retention_status', 'pending', now());
  settingsStatement.run('google_drive_next_retry_at', new Date(0).toISOString(), now());
  settingsStatement.run('google_drive_job', JSON.stringify({ id: 'retention-job', operation: 'backup', kind: 'manual', state: 'retention_pending', updated_at: now() }), now());
  await (gd.googleDrive as any).retryPendingRetention();
  assert.equal(gd.googleDrive.getJob('retention-job')?.state, 'failed', 'non-retryable retention failure stops the pending job');
  assert.equal(gd.googleDrive.getJob('retention-job')?.error_code, 'reauth_required', 'retention failure preserves the reauthentication error');
  const retentionSettings = getDatabase().prepare('SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?) ORDER BY key').all(
    'google_drive_retention_status', 'google_drive_retention_retry_count', 'google_drive_next_retry_at', 'google_drive_last_error_code',
  ) as { key: string; value: string }[];
  assert.deepEqual(Object.fromEntries(retentionSettings.map((setting) => [setting.key, setting.value])), {
    google_drive_last_error_code: 'reauth_required',
    google_drive_next_retry_at: '',
    google_drive_retention_retry_count: '',
    google_drive_retention_status: 'error',
  }, 'non-retryable retention failure pauses automatic retry');
  assert.equal(gd.googleDrive.getStatus().retention_status, 'error', 'non-retryable retention failure remains visibly non-ok');
  (gd.googleDrive as any).getAuthorizedClient = originalRetentionClient;
  console.log('   ✓ non-retryable retention failures pause and preserve their error');

  const originalFetch = globalThis.fetch;
  try {
    let revokeRequestUrl = '';
    let revokeRequestBody = '';
    globalThis.fetch = (async (input, init) => {
      revokeRequestUrl = String(input);
      revokeRequestBody = String(init?.body || '');
      return { ok: false };
    }) as typeof fetch;
    const failedDisconnectStatus = await gd.googleDrive.disconnect();
    assert.equal(failedDisconnectStatus.connected, false, 'failed revocation leaves Drive disconnected');
    assert.equal(failedDisconnectStatus.revoke_status, 'unconfirmed', 'failed revocation is surfaced as unconfirmed');
    assert.equal(revokeRequestUrl, 'https://oauth2.googleapis.com/revoke', 'revocation keeps the bearer token out of the request URL');
    assert.equal(revokeRequestBody, 'token=fake-refresh-token', 'revocation sends the bearer token in the POST body');
    assert.equal(fs.existsSync(tokenPath), true, 'token file is retained while revocation is unconfirmed');
    assert.equal(fs.existsSync(pendingUploadPath), true, 'pending upload is retained while revocation is unconfirmed');
    await assert.rejects(
      gd.googleDrive.getAuthorizedClient(),
      (error: any) => error?.code === 'not_connected',
      'Drive operations are blocked while revocation is unconfirmed',
    );
    await assert.rejects(
      gd.googleDrive.connect(undefined, true, true),
      (error: any) => error?.code === 'not_connected',
      'reconnect cannot bypass an unconfirmed revocation',
    );

    decryptFails = true;
    await assert.rejects(
      gd.googleDrive.disconnect(),
      (error: any) => error?.code === 'reauth_required',
      'token decryption failure blocks disconnect rather than clearing the credential',
    );
    assert.equal(fs.existsSync(tokenPath), true, 'unreadable token remains available for recovery');
    decryptFails = false;

    let confirmedRevokeCalls = 0;
    globalThis.fetch = (async () => { confirmedRevokeCalls += 1; return { ok: true }; }) as typeof fetch;
    const tokenMutableFs = nativeFs as unknown as { unlinkSync: typeof fs.unlinkSync };
    const originalUnlinkSync = tokenMutableFs.unlinkSync;
    tokenMutableFs.unlinkSync = ((target) => {
      if (String(target) === tokenPath) throw new Error('injected token cleanup failure');
      return originalUnlinkSync(target);
    }) as typeof fs.unlinkSync;
    await assert.rejects(
      gd.googleDrive.disconnect(),
      /injected token cleanup failure/,
      'confirmed revocation blocks until local token cleanup completes',
    );
    const cleanupPendingSetting = getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get('google_drive_revoke_cleanup_pending') as { value?: string } | undefined;
    assert.equal(cleanupPendingSetting?.value, 'true', 'local cleanup retry state is durable');
    assert.equal(gd.googleDrive.getStatus().connected, false, 'local cleanup retry state blocks Drive access');
    tokenMutableFs.unlinkSync = originalUnlinkSync;
    const disconnectedStatus = await gd.googleDrive.disconnect();
    assert.equal(confirmedRevokeCalls, 1, 'cleanup retry does not send a second revoke request');
    assert.equal(disconnectedStatus.connected, false, 'disconnected after successful revoke retry');
    assert.equal(disconnectedStatus.revoke_status, 'confirmed', 'successful retry confirms revocation');
    assert.equal(fs.existsSync(tokenPath), false, 'token file deleted after confirmed revocation');
    assert.equal(fs.existsSync(pendingUploadPath), false, 'pending upload is cleared after confirmed revocation');
    assert.equal(disconnectedStatus.account_email, null, 'account email cleared after confirmed revocation');
    const retainedSettings = getDatabase().prepare('SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?, ?) ORDER BY key').all(
      'google_drive_account_subject',
      'google_drive_destination_folder_id',
      'google_drive_destination_folder_name',
      'google_drive_folder_id',
      'google_drive_owned_destinations',
    ) as { key: string; value: string }[];
    assert.deepEqual(Object.fromEntries(retainedSettings.map((setting) => [setting.key, setting.value])), {
      google_drive_account_subject: 'subject-a',
      google_drive_destination_folder_id: 'folder-a',
      google_drive_destination_folder_name: 'FloCafe Backups',
      google_drive_folder_id: 'folder-a',
      google_drive_owned_destinations: '["folder-a","folder-b"]',
    }, 'disconnect preserves the account binding and owned destination history');
    console.log('   ✓ disconnect retains tokens after failed revoke and deletes them after a successful retry');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ── secure storage unavailable ────────────────────────────────────
  encryptionAvailable = false;
  const s = gd.googleDrive.getStatus();
  assert.equal(s.secure_storage_available, false, 'surfaces unavailable secure storage in status');
  encryptionAvailable = true;
  console.log('   ✓ getStatus() surfaces secure_storage_available for the "can\'t store tokens safely" UI state');
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

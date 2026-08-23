/**
 * Unit tests for the app self-updater state machine (#467).
 *
 * Covers the pure module main/update-state.ts:
 *  - error class -> state classification (channel-404 / manifest-missing,
 *    network-offline, download-failed, generic), including the invariant
 *    that an error is NEVER classified as up-to-date;
 *  - IPC derivation table (stored state -> get-update-status payload);
 *  - one-shot startup seeding (store-managed / linux-managed / dev-mode).
 *
 * Run: npm run test:update-state
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UPDATE_STATES,
  classifyUpdateError,
  initialUpdateState,
  isInstallReady,
  isUpdateCheckInFlight,
  isOneShotUpdateState,
  missingUpdateConfigState,
  oneShotUpdateState,
  toIpcUpdateStatus,
  type StoredUpdateStatus,
} from '../main/update-state';

function updaterError(codeOrMessage: string, message?: string): Error & { code?: string } {
  // electron-updater errors carry a `code` property alongside `message`.
  const err: Error & { code?: string } = new Error(message ?? codeOrMessage);
  if (message !== undefined) err.code = codeOrMessage;
  return err;
}

test('UPDATE_STATES contains exactly the approved enum members', () => {
  assert.deepEqual([...UPDATE_STATES].sort(), [
    'available',
    'check-failed',
    'checking',
    'dev-mode',
    'downloading',
    'linux-managed',
    'not-checked-yet',
    'offline',
    'ready-to-install',
    'store-managed',
    'up-to-date',
  ].sort());
});

// ── Error classification ────────────────────────────────────────────────────

test('classifyUpdateError: channel file not found -> check-failed/manifest-missing', () => {
  const err = updaterError('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'Cannot find latest.yml in the latest release');
  assert.deepEqual(classifyUpdateError(err, 'check'), {
    state: 'check-failed',
    reason: 'manifest-missing',
    detail: 'Cannot find latest.yml in the latest release',
  });
});

test('classifyUpdateError: HTTP 404 message (no code) -> check-failed/manifest-missing', () => {
  const err = new Error('Request failed: 404 Not Found');
  const out = classifyUpdateError(err);
  assert.equal(out.state, 'check-failed');
  assert.equal(out.reason, 'manifest-missing');
});

test('classifyUpdateError: legacy masked messages now classify as failures, not up-to-date', () => {
  // These are exactly the substrings the old code masked as "up to date".
  for (const message of ['HTTP status 404', 'Cannot find latest-linux.yml', 'ENOENT: no such file app-update.yml']) {
    const out = classifyUpdateError(new Error(message));
    assert.equal(out.state, 'check-failed', message);
    assert.equal(out.reason, 'manifest-missing', message);
  }
});

test('classifyUpdateError: unreadable app-update.yml -> check-failed/unknown', () => {
  const err = updaterError('EACCES', 'EACCES: permission denied, open app-update.yml');
  assert.deepEqual(classifyUpdateError(err, 'check'), {
    state: 'check-failed',
    reason: 'unknown',
    detail: 'EACCES: permission denied, open app-update.yml',
  });
});

test('classifyUpdateError: DNS failure code ENOTFOUND -> offline', () => {
  const err = updaterError('ENOTFOUND', 'getaddrinfo EAI_AGAIN releases.github.com');
  const out = classifyUpdateError(err);
  assert.equal(out.state, 'offline');
});

test('classifyUpdateError: other network codes -> offline', () => {
  for (const code of ['EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH']) {
    const err = updaterError(code, `request to https://updates.example.com failed (${code})`);
    const out = classifyUpdateError(err);
    assert.equal(out.state, 'offline', code);
  }
});

test('classifyUpdateError: Electron network codes -> offline', () => {
  for (const code of [
    'ERR_NETWORK_IO_SUSPENDED',
    'ERR_NETWORK_CHANGED',
    'ERR_INTERNET_DISCONNECTED',
    'ERR_CONNECTION_REFUSED',
    'ERR_CONNECTION_RESET',
    'ERR_NAME_NOT_RESOLVED',
    'ERR_TIMED_OUT',
    'ERR_ADDRESS_UNREACHABLE',
  ]) {
    const err = updaterError(code, `request failed while reading app-update.yml (${code})`);
    const out = classifyUpdateError(err);
    assert.equal(out.state, 'offline', code);
  }
});

test('classifyUpdateError: network failure during download still -> offline', () => {
  const err = updaterError('ECONNRESET', 'socket hang up');
  const out = classifyUpdateError(err, 'download');
  assert.equal(out.state, 'offline');
});

test('classifyUpdateError: manifest-looking download failures -> download-failed', () => {
  for (const err of [
    updaterError('ENOENT', 'ENOENT: package file missing'),
    new Error('Request failed: 404 Not Found'),
    new Error('Cannot find latest-linux.yml'),
  ]) {
    const out = classifyUpdateError(err, 'download');
    assert.equal(out.state, 'check-failed');
    assert.equal(out.reason, 'download-failed');
  }
});

test('classifyUpdateError: generic error during download phase -> check-failed/download-failed', () => {
  const err = new Error('Checksum mismatch');
  const out = classifyUpdateError(err, 'download');
  assert.deepEqual(out, { state: 'check-failed', reason: 'download-failed', detail: 'Checksum mismatch' });
});

test('classifyUpdateError: generic error during check phase -> check-failed/unknown', () => {
  const err = new Error('Something exploded');
  const out = classifyUpdateError(err, 'check');
  assert.deepEqual(out, { state: 'check-failed', reason: 'unknown', detail: 'Something exploded' });
});

test('classifyUpdateError: non-Error values are stringified safely', () => {
  const out = classifyUpdateError('404 not found');
  assert.equal(out.state, 'check-failed');
  assert.equal(out.detail, '404 not found');

  const nullish = classifyUpdateError(undefined);
  assert.equal(nullish.state, 'check-failed');
  assert.match(nullish.detail, /undefined/);
});

test('classifyUpdateError: no input ever classifies as up-to-date', () => {
  // The #467 invariant: an error path must NEVER produce a positive state.
  const samples: unknown[] = [
    new Error('404'),
    new Error('Cannot find latest'),
    new Error('ENOENT'),
    updaterError('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'missing yml'),
    updaterError('ENOTFOUND', 'dns'),
    new Error('boom'),
    null,
    undefined,
    42,
  ];
  for (const sample of samples) {
    for (const phase of ['check', 'download'] as const) {
      const out = classifyUpdateError(sample, phase);
      assert.notEqual(out.state, 'up-to-date');
      assert.ok(out.state === 'check-failed' || out.state === 'offline');
    }
  }
});

// ── Initial state and seeding ───────────────────────────────────────────────

test('initialUpdateState: never-checked starts as not-checked-yet', () => {
  assert.deepEqual(initialUpdateState(), { status: 'not-checked-yet' });
});

test('oneShotUpdateState seeds each one-shot startup state cleanly', () => {
  for (const state of ['store-managed', 'linux-managed', 'dev-mode'] as const) {
    assert.deepEqual(oneShotUpdateState(state), { status: state });
  }
});

test('missingUpdateConfigState distinguishes development and packaged artifacts', () => {
  const detail = 'app-update.yml not found at /resources/app-update.yml';
  assert.deepEqual(missingUpdateConfigState(true, detail), { status: 'dev-mode' });
  assert.deepEqual(missingUpdateConfigState(false, detail), {
    status: 'check-failed',
    reason: 'manifest-missing',
    error: detail,
  });
});

test('isInstallReady protects both persisted and separately staged updates', () => {
  assert.equal(isInstallReady({ status: 'ready-to-install' }, false), true);
  assert.equal(isInstallReady({ status: 'offline' }, true), true);
  assert.equal(isInstallReady({ status: 'downloading' }, false), false);
});

test('isUpdateCheckInFlight blocks checking and download phases', () => {
  assert.equal(isUpdateCheckInFlight({ status: 'checking' }, 'check'), true);
  assert.equal(isUpdateCheckInFlight({ status: 'not-checked-yet' }, 'download'), true);
  assert.equal(isUpdateCheckInFlight({ status: 'available' }, 'download'), true);
  assert.equal(isUpdateCheckInFlight({ status: 'up-to-date' }, 'check'), false);
});

test('isOneShotUpdateState discriminates one-shot states from runtime states', () => {
  assert.ok(isOneShotUpdateState('store-managed'));
  assert.ok(isOneShotUpdateState('linux-managed'));
  assert.ok(isOneShotUpdateState('dev-mode'));
  for (const state of ['not-checked-yet', 'checking', 'up-to-date', 'available', 'downloading', 'ready-to-install', 'check-failed', 'offline'] as const) {
    assert.equal(isOneShotUpdateState(state), false, state);
  }
});

// ── IPC derivation table ────────────────────────────────────────────────────

const APP_VERSION = '3.3.0';

function ipcRow(stored: StoredUpdateStatus): ReturnType<typeof toIpcUpdateStatus> {
  return toIpcUpdateStatus(stored, APP_VERSION);
}

test('toIpcUpdateStatus derivation table covers every persisted state', () => {
  const table: Array<[StoredUpdateStatus, string]> = [
    [{ status: 'not-checked-yet' }, 'not-checked-yet'],
    [{ status: 'checking' }, 'checking'],
    [{ status: 'up-to-date' }, 'up-to-date'],
    [{ status: 'available', version: '3.4.0' }, 'available'],
    [{ status: 'downloading', percent: 42 }, 'downloading'],
    [{ status: 'ready-to-install', version: '3.4.0' }, 'ready-to-install'],
    [{ status: 'check-failed', reason: 'manifest-missing', error: '404' }, 'check-failed'],
    [{ status: 'offline', error: 'ENOTFOUND' }, 'offline'],
    [{ status: 'store-managed' }, 'store-managed'],
    [{ status: 'linux-managed' }, 'linux-managed'],
    [{ status: 'dev-mode' }, 'dev-mode'],
  ];
  for (const [stored, expected] of table) {
    assert.equal(ipcRow(stored).status, expected, JSON.stringify(stored));
    assert.deepEqual(ipcRow(stored).info, { version: APP_VERSION });
  }
});

test('toIpcUpdateStatus preserves failure details and progress fields', () => {
  const payload = ipcRow({ status: 'check-failed', reason: 'download-failed', error: 'disk full' });
  assert.equal(payload.reason, 'download-failed');
  assert.equal(payload.error, 'disk full');

  const downloading = ipcRow({ status: 'downloading', percent: 87.5, version: '9.9.9' });
  assert.equal(downloading.percent, 87.5);
  assert.equal(downloading.version, '9.9.9');
});

test('toIpcUpdateStatus omits optional fields when absent', () => {
  const payload = ipcRow({ status: 'up-to-date' });
  assert.equal(payload.version, undefined);
  assert.equal(payload.percent, undefined);
  assert.equal(payload.reason, undefined);
  assert.equal(payload.error, undefined);
});

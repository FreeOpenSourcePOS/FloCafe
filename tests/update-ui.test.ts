/**
 * Unit tests for the in-app update UX guard logic (#463, child of epic #463).
 *
 * Covers the pure renderer modules:
 *  - frontend/src/lib/updates/restart-install.ts — normalization of the
 *    guarded `restart-and-install` IPC result and the renderer-side
 *    preconditions (valid PIN format, no accidental submit);
 *  - frontend/src/lib/updates/beta-channel.ts — feature detection of the
 *    sibling-owned `updates:get/set-beta-channel` contract, tri-state value
 *    normalization, and optimistic-update decisions for the Settings toggle.
 *
 * Run: npm run test:update-ui
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canSubmitRestartInstall,
  isValidManagerPinInput,
  normalizeRestartInstallResult,
} from '../frontend/src/lib/updates/restart-install';
import {
  betaChannelApiSupported,
  normalizeBetaChannelValue,
  normalizeBetaChannelWriteResult,
  readBetaChannelState,
  writeBetaChannelState,
} from '../frontend/src/lib/updates/beta-channel';

// ── Restart-to-install result normalization ─────────────────────────────────

test('normalizeRestartInstallResult: guarded success payload resolves ok', () => {
  assert.deepEqual(normalizeRestartInstallResult({ success: true }), { ok: true });
});

test('normalizeRestartInstallResult: denial keeps the dialog open with the error', () => {
  const result = normalizeRestartInstallResult({ success: false, error: 'Invalid Master PIN' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Invalid Master PIN');
});

test('normalizeRestartInstallResult: legacy void resolution still counts as accepted', () => {
  assert.deepEqual(normalizeRestartInstallResult(undefined), { ok: true });
  assert.deepEqual(normalizeRestartInstallResult(null), { ok: true });
});

test('normalizeRestartInstallResult: malformed payloads never count as success', () => {
  assert.equal(normalizeRestartInstallResult({ success: false }).ok, false);
  assert.equal(normalizeRestartInstallResult('boom').ok, false);
  assert.equal(normalizeRestartInstallResult(42).ok, false);
  assert.equal(normalizeRestartInstallResult({}).ok, false);
});

// ── Renderer-side preconditions (the main process re-verifies the PIN) ──────

test('isValidManagerPinInput accepts exactly four digits', () => {
  assert.equal(isValidManagerPinInput('1234'), true);
  assert.equal(isValidManagerPinInput('123'), false);
  assert.equal(isValidManagerPinInput('12345'), false);
  assert.equal(isValidManagerPinInput('12a4'), false);
  assert.equal(isValidManagerPinInput(''), false);
});

test('canSubmitRestartInstall requires an explicit valid confirmation', () => {
  // No PIN -> cannot confirm; dismissing can never restart.
  assert.equal(canSubmitRestartInstall('', false), false);
  assert.equal(canSubmitRestartInstall('12', false), false);
  assert.equal(canSubmitRestartInstall('1234', false), true);
  // A submission already in flight blocks a second one.
  assert.equal(canSubmitRestartInstall('1234', true), false);
});

// ── Beta channel feature detection (#503 IPC contract) ──────────────────────

test('betaChannelApiSupported is false when the sibling preload API is absent', () => {
  assert.equal(betaChannelApiSupported(undefined), false);
  assert.equal(betaChannelApiSupported(null), false);
  assert.equal(betaChannelApiSupported({}), false);
  assert.equal(betaChannelApiSupported({ getBetaChannel: () => Promise.resolve(true) }), false);
  assert.equal(betaChannelApiSupported({ setBetaChannel: () => Promise.resolve() }), false);
});

test('betaChannelApiSupported is true only when both contract methods exist', () => {
  assert.equal(betaChannelApiSupported({
    getBetaChannel: () => Promise.resolve(false),
    setBetaChannel: () => Promise.resolve(),
  }), true);
});

// ── Beta channel value normalization ────────────────────────────────────────

test('normalizeBetaChannelValue passes booleans through and rejects junk', () => {
  assert.equal(normalizeBetaChannelValue(true), true);
  assert.equal(normalizeBetaChannelValue(false), false);
  assert.equal(normalizeBetaChannelValue(undefined), null);
  assert.equal(normalizeBetaChannelValue(null), null);
  assert.equal(normalizeBetaChannelValue('yes'), null);
  assert.equal(normalizeBetaChannelValue(1), null);
});

test('normalizeBetaChannelValue unwraps { enabled } envelopes', () => {
  assert.equal(normalizeBetaChannelValue({ enabled: true }), true);
  assert.equal(normalizeBetaChannelValue({ enabled: false }), false);
  assert.equal(normalizeBetaChannelValue({ enabled: undefined }), null);
});

test('normalizeBetaChannelValue treats error envelopes as unknown state', () => {
  assert.equal(normalizeBetaChannelValue({ success: false, error: 'nope' }), null);
  assert.equal(normalizeBetaChannelValue({ error: 'nope' }), null);
});

// ── Beta channel write results (optimistic update decisions) ────────────────

test('normalizeBetaChannelWriteResult: confirmed success adopts reported state', () => {
  assert.deepEqual(normalizeBetaChannelWriteResult({ success: true, enabled: true }, false), { ok: true, enabled: true });
  assert.deepEqual(normalizeBetaChannelWriteResult({ success: true }, true), { ok: true, enabled: true });
  assert.deepEqual(normalizeBetaChannelWriteResult({ success: true }, false), { ok: true, enabled: false });
});

test('normalizeBetaChannelWriteResult: legacy void assumes the requested value landed', () => {
  assert.deepEqual(normalizeBetaChannelWriteResult(undefined, true), { ok: true, enabled: true });
  assert.deepEqual(normalizeBetaChannelWriteResult(undefined, false), { ok: true, enabled: false });
});

test('normalizeBetaChannelWriteResult: failure keeps the previously rendered value', () => {
  const result = normalizeBetaChannelWriteResult({ success: false, error: 'denied' }, true);
  assert.equal(result.ok, false);
  assert.equal(result.enabled, null);
  assert.equal(result.error, 'denied');
});

// ── Read/write orchestration against the feature-detected API ───────────────

test('readBetaChannelState reports unsupported when the contract is missing', async () => {
  assert.deepEqual(await readBetaChannelState(undefined), { supported: false, enabled: null });
  assert.deepEqual(await readBetaChannelState({}), { supported: false, enabled: null });
});

test('readBetaChannelState round-trips the persisted boolean when present', async () => {
  const api = { getBetaChannel: () => Promise.resolve(true), setBetaChannel: () => Promise.resolve() };
  assert.deepEqual(await readBetaChannelState(api), { supported: true, enabled: true });
});

test('readBetaChannelState degrades to unsupported on a rejected get', async () => {
  const api = {
    getBetaChannel: () => Promise.reject(new Error('gone')),
    setBetaChannel: () => Promise.resolve(),
  };
  assert.deepEqual(await readBetaChannelState(api), { supported: false, enabled: null });
});

test('writeBetaChannelState refuses to call a missing setBetaChannel', async () => {
  let called = false;
  const api = { getBetaChannel: () => { called = true; return Promise.resolve(false); } };
  const result = await writeBetaChannelState(api as never, true);
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test('writeBetaChannelState returns the new state after a successful set', async () => {
  let stored = false;
  const api = {
    getBetaChannel: () => Promise.resolve(stored),
    setBetaChannel: (enabled: boolean) => { stored = enabled; return Promise.resolve({ success: true, enabled }); },
  };
  const before = await readBetaChannelState(api);
  assert.deepEqual(before, { supported: true, enabled: false });
  const result = await writeBetaChannelState(api, true);
  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.deepEqual(await readBetaChannelState(api), { supported: true, enabled: true });
});

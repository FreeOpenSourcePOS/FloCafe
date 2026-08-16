/**
 * Regression tests for the js/polynomial-redos hardening:
 *  - bounded email validation (auth.ts isValidEmail)
 *  - linear tax-id slugify (tax-packs.ts slugifyTaxId)
 *
 * Usage: node tests/run-electron-node-test.cjs tests/redos-hardening.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert').strict;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-redos-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const { isValidEmail, MAX_EMAIL_LENGTH } = require('../main/routes/auth');
const { slugifyTaxId } = require('../main/routes/tax-packs');

function run() {
  console.log('Testing ReDoS hardening...');

  // ── Email validation length bound ─────────────────────────────────
  assert.equal(isValidEmail('owner@example.com'), true, 'normal email is valid');
  assert.equal(isValidEmail('not-an-email'), false, 'malformed email is invalid');
  assert.equal(
    isValidEmail('a'.repeat(MAX_EMAIL_LENGTH + 1) + '@example.com'),
    false,
    'over-long email is rejected by the length bound before the regex runs',
  );
  // A ReDoS-shaped string is rejected purely by the length bound, so it never
  // reaches the backtracking regex.
  assert.equal(
    isValidEmail('!@!.' + '!.'.repeat(1000)),
    false,
    'pathological ReDoS input is rejected without regex backtracking',
  );

  // ── Tax id slugify is linear and deterministic ────────────────────
  assert.equal(slugifyTaxId('  Beverage  ', new Set(), 'fallback'), 'beverage', 'trims and lowercases');
  assert.equal(slugifyTaxId('___', new Set(), 'fallback'), 'fallback', 'all-underscore falls back');
  assert.equal(slugifyTaxId('a_b', new Set(), 'fallback'), 'a_b', 'keeps an internal separator');
  // The super-linear input shape (`a` + "_"*N + `b`) collapses to one separator
  // before the trim, and must complete without quadratic backtracking.
  assert.equal(
    slugifyTaxId('a' + '_'.repeat(5000) + 'b', new Set(), 'fallback'),
    'a_b',
    'a long underscore run collapses linearly',
  );

  const used = new Set(['tax']);
  assert.equal(slugifyTaxId('tax', used, 'fallback'), 'tax_2', 'collision gets a numeric suffix');

  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('✅ ReDoS hardening tests passed');
}

run();

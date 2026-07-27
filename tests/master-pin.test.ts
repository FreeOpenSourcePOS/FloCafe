/**
 * Master PIN Tests
 *
 * Usage: node tests/run-electron-node-test.cjs tests/master-pin.test.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-master-pin-'));

const mockApp = {
  isPackaged: true,
  getPath: (_name: string) => testDir,
  getVersion: () => 'test',
};

// Identity "encryption" stand-in — real Electron safeStorage isn't available
// under ELECTRON_RUN_AS_NODE, so this only needs to exercise our bcrypt +
// file-read/write logic, not the OS keychain itself.
let encryptionAvailable = true;
const mockSafeStorage = {
  isEncryptionAvailable: () => encryptionAvailable,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp, safeStorage: mockSafeStorage };
  return originalLoad.apply(this, arguments as any);
};

const {
  isMasterPinAvailable, isMasterPinSet, setMasterPin, resetMasterPin, verifyMasterPin,
  checkMasterPinRateLimit, authorizeMasterPin,
} = require('../main/services/master-pin');

function main() {
  console.log('🧪 FloDesktop Master PIN Tests');
  console.log('='.repeat(60));

  assert.equal(isMasterPinAvailable(), true, 'encryption is available in this mock');
  assert.equal(isMasterPinSet(), false, 'no PIN is set initially');
  console.log('   ✓ starts unset with encryption available');

  setMasterPin('1234');
  assert.equal(isMasterPinSet(), true, 'PIN is set after setMasterPin');
  assert.equal(verifyMasterPin('1234'), true, 'correct PIN verifies');
  assert.equal(verifyMasterPin('9999'), false, 'wrong PIN does not verify');
  console.log('   ✓ setMasterPin() + verifyMasterPin() round-trip correctly');

  const rawFile = fs.readFileSync(path.join(testDir, 'master-pin.enc'), 'utf8');
  assert.ok(!rawFile.includes('1234'), 'the raw PIN is never stored in plaintext, even under the mock encryptor');
  console.log('   ✓ the stored blob never contains the plaintext PIN');

  resetMasterPin('5678');
  assert.equal(verifyMasterPin('1234'), false, 'old PIN is invalidated after reset');
  assert.equal(verifyMasterPin('5678'), true, 'new PIN verifies after reset');
  console.log('   ✓ resetMasterPin() overwrites the old PIN without requiring it');

  // ── rate limiting ─────────────────────────────────────────────────────
  const key = 'test:rate-limit';
  let allowed = 0;
  for (let i = 0; i < 10; i++) {
    if (checkMasterPinRateLimit(key)) allowed++;
  }
  assert.equal(allowed, 5, 'rate limiter allows exactly 5 attempts per window');
  console.log('   ✓ checkMasterPinRateLimit() locks out after 5 attempts');

  // ── authorizeMasterPin: single entry point ───────────────────────────
  resetMasterPin('4321'); // fresh blob, unrelated rate-limit key below
  let result = authorizeMasterPin('4321', 'test:auth-ok');
  assert.equal(result.ok, true, 'correct PIN authorizes');

  result = authorizeMasterPin('0000', 'test:auth-bad');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 403, 'wrong PIN returns 403');
  console.log('   ✓ authorizeMasterPin() authorizes correct PIN, rejects wrong PIN with 403');

  // Missing and malformed PINs must NOT consume rate limit attempts
  const missingKey = 'test:missing-pin';
  for (let i = 0; i < 10; i++) {
    const r = authorizeMasterPin(undefined, missingKey);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 403, 'missing PIN returns 403');
  }
  // Now 1 valid PIN attempt on the same key should succeed
  const validRes = authorizeMasterPin('4321', missingKey);
  assert.equal(validRes.ok, true, 'missing PIN calls did not consume rate limit attempts');
  console.log('   ✓ missing/malformed PIN does not consume rate limit attempts');

  // 5 wrong attempts lock out key with 429
  const lockoutKey = 'test:lockout';
  for (let i = 0; i < 4; i++) {
    const r = authorizeMasterPin('0000', lockoutKey);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 403, 'wrong PIN attempt 1-4 returns 403');
  }
  const r5 = authorizeMasterPin('0000', lockoutKey);
  assert.equal(r5.ok, false);
  if (!r5.ok) assert.equal(r5.status, 429, '5th wrong PIN attempt returns 429 lockout');
  console.log('   ✓ 5th wrong attempt triggers 429 lockout');

  // ── fallback when encryption is unavailable ──────────────────────────
  encryptionAvailable = false;
  result = authorizeMasterPin('anything-or-nothing', 'test:no-encryption');
  assert.equal(result.ok, false, 'gate hard-blocks (ok: false) when safeStorage is unavailable — vuln-0002');
  if (!result.ok) assert.equal(result.status, 503, 'unavailable encryption returns 503');
  console.log('   ✓ authorizeMasterPin() hard-blocks with 503 when encryption is unavailable (vuln-0002 regression)');
  encryptionAvailable = true;
}

try {
  main();
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('\n✅ Master PIN tests passed');
} catch (error) {
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
}

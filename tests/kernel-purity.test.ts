/**
 * Print kernel consumer-boundary checks (#441, epic #438).
 *
 * This test exercises the public shared kernel through the same root-relative
 * import used by backend and test consumers. Purity remains an architectural
 * boundary enforced by the module layout and build configurations; behavior
 * is verified through the executable kernel test suite.
 *
 * Run: npm run test:print-kernel
 */

import assert from 'node:assert/strict';

import {
  defaultPrintLanguagePolicy,
  resolveDirectionSpec,
  resolveReceiptLanguages,
} from '../shared/print';

const policy = defaultPrintLanguagePolicy();

assert.deepEqual(resolveReceiptLanguages(policy, 'en'), ['en']);
assert.deepEqual(resolveDirectionSpec('rtl'), {
  base: 'rtl',
  document: 'rtl',
  block: 'rtl',
  value: 'rtl',
});

console.log('Print kernel consumer boundary passed.');

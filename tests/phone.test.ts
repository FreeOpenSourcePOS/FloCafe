import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePhone, dialCodeFor } from '../frontend/src/lib/phone';

test('parsePhone: Indian local number parses with +91', () => {
  const r = parsePhone('9876543210', 'IN');
  assert.deepEqual(r, { e164: '+919876543210', countryCode: '+91' });
});

test('parsePhone: AR local number parses with +54 when tenant is AR', () => {
  const r = parsePhone('1122334455', 'AR');
  assert.deepEqual(r, { e164: '+541122334455', countryCode: '+54' });
});

test('parsePhone: international number keeps its own country code (regression for PR #108)', () => {
  const r = parsePhone('+1 650 253 0000', 'IN');
  assert.deepEqual(r, { e164: '+16502530000', countryCode: '+1' });
});

test('parsePhone: UK number from IN-default tenant stays +44', () => {
  const r = parsePhone('+44 20 7946 0958', 'IN');
  assert.deepEqual(r, { e164: '+442079460958', countryCode: '+44' });
});

test('parsePhone: AR number from AR-default tenant stays +54', () => {
  const r = parsePhone('+54 11 4321 0000', 'AR');
  assert.deepEqual(r, { e164: '+541143210000', countryCode: '+54' });
});

test('parsePhone: invalid input returns null', () => {
  assert.equal(parsePhone('not-a-phone', 'IN'), null);
  assert.equal(parsePhone('', 'IN'), null);
  assert.equal(parsePhone('123', 'IN'), null);
});

test('parsePhone: too few digits returns null', () => {
  assert.equal(parsePhone('+1 555', 'IN'), null);
});

test('dialCodeFor: known ISO maps to dial code', () => {
  assert.equal(dialCodeFor('IN'), '+91');
  assert.equal(dialCodeFor('US'), '+1');
  assert.equal(dialCodeFor('AR'), '+54');
});

test('dialCodeFor: unknown code returns empty string (not throw)', () => {
  assert.equal(dialCodeFor('XX'), '');
  assert.equal(dialCodeFor(''), '');
});
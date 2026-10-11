import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePhone, dialCodeFor, normalizeOptionalPhone, formatPhoneDisplay } from '../frontend/src/lib/phone';
import { disambiguateCustomerInput } from '../frontend/src/lib/customer-disambiguation';

test('parsePhone: Indian local number parses with +91', () => {
  const r = parsePhone('9876543210', 'IN');
  assert.deepEqual(r, { e164: '+919876543210', countryCode: '+91', digits: '9876543210' });
});

test('parsePhone: AR local number parses with +54 when tenant is AR', () => {
  const r = parsePhone('1122334455', 'AR');
  assert.deepEqual(r, { e164: '+541122334455', countryCode: '+54', digits: '1122334455' });
});

test('parsePhone: international number keeps its own country code (regression for PR #108)', () => {
  const r = parsePhone('+1 650 253 0000', 'IN');
  assert.deepEqual(r, { e164: '+16502530000', countryCode: '+1', digits: '6502530000' });
});

test('parsePhone: UK number from IN-default tenant stays +44', () => {
  const r = parsePhone('+44 20 7946 0958', 'IN');
  assert.deepEqual(r, { e164: '+442079460958', countryCode: '+44', digits: '2079460958' });
});

test('parsePhone: AR number from AR-default tenant stays +54', () => {
  const r = parsePhone('+54 11 4321 0000', 'AR');
  assert.deepEqual(r, { e164: '+541143210000', countryCode: '+54', digits: '1143210000' });
});

test('parsePhone: invalid input returns null', () => {
  assert.equal(parsePhone('not-a-phone', 'IN'), null);
  assert.equal(parsePhone('', 'IN'), null);
  assert.equal(parsePhone('123', 'IN'), null);
});

test('parsePhone: too few digits returns null', () => {
  assert.equal(parsePhone('+1 555', 'IN'), null);
});

test('normalizeOptionalPhone handles empty, valid, and invalid inputs', () => {
  assert.deepEqual(normalizeOptionalPhone('', 'IN'), {
    valid: true,
    e164: null,
    digits: null,
    countryCode: null,
  });
  assert.deepEqual(normalizeOptionalPhone(null, 'IN'), {
    valid: true,
    e164: null,
    digits: null,
    countryCode: null,
  });
  assert.deepEqual(normalizeOptionalPhone('  9876543210  ', 'IN'), {
    valid: true,
    e164: '+919876543210',
    digits: '9876543210',
    countryCode: '+91',
  });
  const invalid = normalizeOptionalPhone('not-a-phone', 'IN');
  assert.equal(invalid.valid, false);
  assert.ok(invalid.error);
});

test('formatPhoneDisplay formats or falls back cleanly', () => {
  assert.equal(formatPhoneDisplay('+919876543210', 'IN'), '+919876543210');
  assert.equal(formatPhoneDisplay('9876543210', 'IN'), '+919876543210');
  assert.equal(formatPhoneDisplay('', 'IN'), '');
  assert.equal(formatPhoneDisplay(null, 'IN'), '');
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

test('disambiguateCustomerInput: phone number detection', () => {
  const r1 = disambiguateCustomerInput('9876543210', 'IN');
  assert.equal(r1.category, 'phone');
  assert.equal(r1.suggestedField, 'phone');
  assert.equal(r1.canDefaultToPhone, true);
  assert.equal(r1.canDefaultToName, false);

  const r2 = disambiguateCustomerInput('+1 (555) 234-5678', 'US');
  assert.equal(r2.category, 'phone');
  assert.equal(r2.suggestedField, 'phone');
  assert.equal(r2.canDefaultToPhone, true);

  const r3 = disambiguateCustomerInput('+91 98765 43210', 'IN');
  assert.equal(r3.category, 'phone');
  assert.equal(r3.canDefaultToPhone, true);
});

test('disambiguateCustomerInput: name detection (alpha and alphanumeric entities)', () => {
  const r1 = disambiguateCustomerInput('Anita Sharma', 'IN');
  assert.equal(r1.category, 'name');
  assert.equal(r1.suggestedField, 'name');
  assert.equal(r1.canDefaultToName, true);
  assert.equal(r1.canDefaultToPhone, false);

  // Alphanumeric entity with digits and letters (e.g. Studio 54)
  const r2 = disambiguateCustomerInput('Studio 54', 'US');
  assert.equal(r2.category, 'name');
  assert.equal(r2.suggestedField, 'name');
  assert.equal(r2.canDefaultToName, true);

  const r3 = disambiguateCustomerInput('Apartment 2B', 'US');
  assert.equal(r3.category, 'name');
  assert.equal(r3.canDefaultToName, true);
});

test('disambiguateCustomerInput: short digits are marked ambiguous without forcing invalid phone save', () => {
  const r1 = disambiguateCustomerInput('123', 'IN');
  assert.equal(r1.category, 'ambiguous');
  assert.equal(r1.suggestedField, null);
  assert.equal(r1.canDefaultToPhone, false);
  assert.equal(r1.canDefaultToName, false);
  assert.equal(r1.isPartialPhone, true);

  const r2 = disambiguateCustomerInput('12', 'IN');
  assert.equal(r2.category, 'ambiguous');
  assert.equal(r2.isPartialPhone, true);
});

test('disambiguateCustomerInput: email format detection', () => {
  const r = disambiguateCustomerInput('user@example.com', 'US');
  assert.equal(r.category, 'email');
  assert.equal(r.suggestedField, 'email');
  assert.equal(r.canDefaultToPhone, false);
  assert.equal(r.canDefaultToName, false);
});
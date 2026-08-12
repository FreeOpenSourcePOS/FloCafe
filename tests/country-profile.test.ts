import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCountryByCode } from '../main/countries';

test('IR country profile properties', () => {
  const ir = getCountryByCode('IR');
  assert.ok(ir, 'IR country profile should exist');
  assert.equal(ir.code, 'IR');
  assert.equal(ir.locale, 'fa-IR');
  assert.equal(ir.currency, 'IRR');
  assert.equal(ir.timezone, 'Asia/Tehran');
  assert.equal(ir.dialCode, '+98');
  assert.equal(ir.taxIdLabel, 'Economic Code');
  assert.equal(ir.taxName, 'VAT');
  assert.equal(ir.taxIdFormat, undefined, 'No tax ID format should be enforced for IR');
});

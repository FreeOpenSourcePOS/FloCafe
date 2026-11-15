import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCurrency,
  formatCurrencyForTenant,
  formatMoney,
  getCurrencyFractionDigits,
  getCurrencyMinorUnitFactor,
  getCurrencySymbol,
  resolveIntlCurrencyDisplay,
  resolveRegionalSnapshot,
} from '../main/countries';

test('formatCurrency: en-US / USD', () => {
  assert.equal(formatCurrency(1234.5, 'USD', 'en-US'), '$1,234.50');
});

test('formatCurrency: en-IN / INR has rupees symbol and grouping', () => {
  const out = formatCurrency(1234.5, 'INR', 'en-IN');
  assert.match(out, /1,234\.50/);
  assert.match(out, /₹/);
});

test('formatCurrency: es-AR / ARS uses comma decimal', () => {
  const out = formatCurrency(1234.5, 'ARS', 'es-AR');
  assert.match(out, /1\.234,50/);
});

test('formatCurrency: zero amount still formats', () => {
  assert.equal(formatCurrency(0, 'USD', 'en-US'), '$0.00');
});

test('formatCurrency: empty currency falls back to fixed', () => {
  assert.equal(formatCurrency(1234.5, '', 'en-US'), '1234.50');
});

test('formatCurrencyForTenant: IN tenant uses en-IN locale', () => {
  const out = formatCurrencyForTenant(1234.5, 'IN', 'INR');
  assert.match(out, /1,234\.50/);
  assert.match(out, /₹/);
});

test('formatCurrencyForTenant: AR tenant uses es-AR locale', () => {
  const out = formatCurrencyForTenant(1234.5, 'AR', 'ARS');
  assert.match(out, /1\.234,50/);
});

test('formatCurrencyForTenant: US tenant uses en-US locale', () => {
  assert.equal(formatCurrencyForTenant(1234.5, 'US', 'USD'), '$1,234.50');
});

test('formatCurrencyForTenant: COP uses zero fraction digits', () => {
  const out = formatCurrencyForTenant(11000, 'CO', 'COP');
  assert.match(out, /11\.000/);
  assert.doesNotMatch(out, /[,.]00(?:\D|$)/);
});

test('formatCurrencyForTenant: KWD uses three fraction digits', () => {
  const out = formatCurrencyForTenant(1.25, 'KW', 'KWD');
  assert.match(out, /١٫٢٥٠/);
});

test('formatCurrencyForTenant: unknown country falls back to en-US', () => {
  assert.equal(formatCurrencyForTenant(7, 'ZZ', 'USD'), '$7.00');
});

test('formatCurrencyForTenant: missing country defaults to IN', () => {
  const out = formatCurrencyForTenant(7, undefined, 'INR');
  assert.match(out, /7\.00/);
  assert.match(out, /₹/);
});

test('formatCurrencyForTenant: arbitrary currency code avoids Intl placeholder', () => {
  const out = formatCurrencyForTenant(100, 'US', 'XXX');
  assert.match(out, /XXX/);
  assert.doesNotMatch(out, /¤/);
});

test('getCurrencyFractionDigits: resolves ISO 4217 standard precision', () => {
  const { getCurrencyFractionDigits, getCurrencyMinorUnitFactor } = require('../main/countries');
  assert.equal(getCurrencyFractionDigits('JPY'), 0);
  assert.equal(getCurrencyMinorUnitFactor('JPY'), 1);

  assert.equal(getCurrencyFractionDigits('KRW'), 0);
  assert.equal(getCurrencyMinorUnitFactor('KRW'), 1);

  assert.equal(getCurrencyFractionDigits('VND'), 0);
  assert.equal(getCurrencyMinorUnitFactor('VND'), 1);

  assert.equal(getCurrencyFractionDigits('COP'), 0);
  assert.equal(getCurrencyMinorUnitFactor('COP'), 1);

  assert.equal(getCurrencyFractionDigits('USD'), 2);
  assert.equal(getCurrencyMinorUnitFactor('USD'), 100);

  assert.equal(getCurrencyFractionDigits('EUR'), 2);
  assert.equal(getCurrencyMinorUnitFactor('EUR'), 100);

  assert.equal(getCurrencyFractionDigits('INR'), 2);
  assert.equal(getCurrencyMinorUnitFactor('INR'), 100);

  assert.equal(getCurrencyFractionDigits('IRR'), 2);
  assert.equal(getCurrencyMinorUnitFactor('IRR'), 100);

  assert.equal(getCurrencyFractionDigits('KWD'), 3);
  assert.equal(getCurrencyMinorUnitFactor('KWD'), 1000);

  assert.equal(getCurrencyFractionDigits('BHD'), 3);
  assert.equal(getCurrencyMinorUnitFactor('BHD'), 1000);

  // Fallback for unknown / empty / non-string
  assert.equal(getCurrencyFractionDigits(''), 2);
  assert.equal(getCurrencyFractionDigits(null as any), 2);
  assert.equal(getCurrencyFractionDigits('INVALID'), 2);
});

test('getCurrencyUnitAdapter: zero-decimal currencies use whole integer steps', () => {
  const { getCurrencyUnitAdapter } = require('../main/countries');
  const jpyAdapter = getCurrencyUnitAdapter('JPY', 'JP');
  assert.equal(jpyAdapter.scale, 1);
  assert.equal(jpyAdapter.label, 'JPY');
  assert.equal(jpyAdapter.step, '1');
  assert.equal(jpyAdapter.maxDecimals, 0);
  assert.equal(jpyAdapter.toDisplay(1234.5), 1235);
  assert.equal(jpyAdapter.toStored(1235), 1235);
  assert.equal(jpyAdapter.formatInput(1235), '1235');

  const krwAdapter = getCurrencyUnitAdapter('KRW', 'KR');
  assert.equal(krwAdapter.step, '1');
  assert.equal(krwAdapter.maxDecimals, 0);

  const clfAdapter = getCurrencyUnitAdapter('CLF', 'CL');
  assert.equal(clfAdapter.step, '0.0001');
  assert.equal(clfAdapter.maxDecimals, 4);

  const usdAdapter = getCurrencyUnitAdapter('USD', 'US');
  assert.equal(usdAdapter.scale, 1);
  assert.equal(usdAdapter.label, 'USD');
  assert.equal(usdAdapter.step, '0.01');
  assert.equal(usdAdapter.maxDecimals, 2);
  assert.equal(usdAdapter.toDisplay(12.34), 12.34);
  assert.equal(usdAdapter.toStored(12.34), 12.34);
  assert.equal(usdAdapter.formatInput(12.34), '12.34');
});

test('SYP displays ل.س. in Arabic locales and SYP in non-Arabic locales instead of £', () => {
  assert.equal(resolveIntlCurrencyDisplay('SYP', 'ar-SY'), 'symbol');
  assert.equal(resolveIntlCurrencyDisplay('SYP', 'en-US'), 'symbol');

  assert.equal(getCurrencySymbol('SYP', 'ar-SY'), 'ل.س.');
  assert.equal(getCurrencySymbol('SYP', 'ar'), 'ل.س.');
  assert.equal(getCurrencySymbol('SYP', 'en-US'), 'SYP');
  assert.equal(getCurrencySymbol('SYP', 'fr-FR'), 'SYP');

  assert.equal(getCurrencyFractionDigits('SYP'), 0);
  assert.equal(getCurrencyMinorUnitFactor('SYP'), 1);

  const arFormatted = formatCurrency(1500, 'SYP', 'ar-SY');
  assert.match(arFormatted, /ل\.س\./);
  assert.doesNotMatch(arFormatted, /£/);

  const enFormatted = formatCurrency(1500, 'SYP', 'en-US');
  assert.match(enFormatted, /SYP/);
  assert.doesNotMatch(enFormatted, /£/);

  const arMoney = formatMoney(1500, 'SYP', 'ar-SY');
  assert.match(arMoney, /ل\.س\./);
  assert.doesNotMatch(arMoney, /£/);

  const enMoney = formatMoney(1500, 'SYP', 'en-US');
  assert.match(enMoney, /SYP/);
  assert.match(enMoney, /1,500/);
  assert.doesNotMatch(enMoney, /\.00/);
  assert.doesNotMatch(enMoney, /£/);

  const tenantFormatted = formatCurrencyForTenant(1500, 'SY', 'SYP');
  assert.match(tenantFormatted, /ل\.س\./);
  assert.doesNotMatch(tenantFormatted, /£/);

  const snap = resolveRegionalSnapshot({ country: 'SY', currency: 'SYP' });
  assert.equal(snap.country, 'SY');
  assert.equal(snap.locale, 'ar-SY');
  assert.equal(snap.currency, 'SYP');
  assert.equal(snap.currencySymbol, 'ل.س.');
  assert.equal(snap.currencyFractionDigits, 0);
  assert.equal(snap.timezone, 'Asia/Damascus');

  const expectedParts = new Intl.NumberFormat('ar-SY', {
    style: 'currency',
    currency: 'SYP',
    currencyDisplay: 'symbol',
  }).formatToParts(1);
  const expectedPos =
    expectedParts.findIndex((p) => p.type === 'currency') <
    expectedParts.findIndex((p) => p.type === 'integer')
      ? 'prefix'
      : 'suffix';
  assert.equal(snap.currencyPosition, expectedPos);
});

test('SSP renders SSP in en-US and ar-SY instead of £', () => {
  assert.notEqual(resolveIntlCurrencyDisplay('SSP', 'en-US'), 'narrowSymbol');
  assert.notEqual(resolveIntlCurrencyDisplay('SSP', 'ar-SY'), 'narrowSymbol');

  assert.equal(getCurrencySymbol('SSP', 'en-US'), 'SSP');
  assert.equal(getCurrencySymbol('SSP', 'ar-SY'), 'SSP');

  const enFormatted = formatCurrency(250, 'SSP', 'en-US');
  assert.match(enFormatted, /SSP/);
  assert.doesNotMatch(enFormatted, /£/);

  const arMoney = formatMoney(250, 'SSP', 'ar-SY');
  assert.match(arMoney, /SSP/);
  assert.doesNotMatch(arMoney, /£/);

  const snap = resolveRegionalSnapshot({ country: 'SY', currency: 'SSP' });
  assert.equal(snap.currencySymbol, 'SSP');
});

test('standard narrow symbols are preserved for USD/CAD/AUD, Sterling-pegged, and other currencies', () => {
  for (const code of ['USD', 'CAD', 'AUD']) {
    assert.equal(resolveIntlCurrencyDisplay(code, 'en-US'), 'narrowSymbol');
    assert.equal(getCurrencySymbol(code, 'en-US'), '$');
    assert.match(formatMoney(10, code, 'en-US'), /^\$10\.00$/);
  }
  for (const code of ['GBP', 'FKP', 'GIP', 'SHP']) {
    assert.equal(resolveIntlCurrencyDisplay(code, 'en-US'), 'narrowSymbol');
    assert.equal(getCurrencySymbol(code, 'en-US'), '£');
    assert.match(formatMoney(10, code, 'en-US'), /^£10\.00$/);
  }
  assert.equal(resolveIntlCurrencyDisplay('EGP', 'en-US'), 'narrowSymbol');
  assert.equal(getCurrencySymbol('EGP', 'en-US'), 'E£');
  assert.equal(resolveIntlCurrencyDisplay('LBP', 'en-US'), 'narrowSymbol');
  assert.equal(getCurrencySymbol('LBP', 'en-US'), 'L£');
  assert.equal(resolveIntlCurrencyDisplay('EUR', 'de-DE'), 'narrowSymbol');
  assert.equal(getCurrencySymbol('EUR', 'de-DE'), '€');
  assert.equal(resolveIntlCurrencyDisplay('INR', 'en-IN'), 'narrowSymbol');
  assert.equal(getCurrencySymbol('INR', 'en-IN'), '₹');
  assert.equal(resolveIntlCurrencyDisplay('JPY', 'ja-JP'), 'narrowSymbol');
});

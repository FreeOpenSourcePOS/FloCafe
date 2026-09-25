/**
 * Contract tests for resolveRegionalSnapshot() (docs/architecture/regional-settings.md).
 * Pure module — no Electron/DB dependency, matches currency.test.ts style.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRegionalSnapshot, RegionalNotConfiguredError } from '../main/countries';

test('USD/2: en-US prefix, comma group, dot decimal', () => {
  const snap = resolveRegionalSnapshot({ country: 'US', currency: 'USD' });
  assert.equal(snap.country, 'US');
  assert.equal(snap.locale, 'en-US');
  assert.equal(snap.currency, 'USD');
  assert.equal(snap.currencySymbol, '$');
  assert.equal(snap.currencyPosition, 'prefix');
  assert.equal(snap.currencyFractionDigits, 2);
  assert.equal(snap.decimalSeparator, '.');
  assert.equal(snap.groupSeparator, ',');
  assert.equal(snap.timezone, 'America/New_York');
});

test('COP/0: es-CO prefix, dot group, comma decimal, zero fraction digits', () => {
  const snap = resolveRegionalSnapshot({ country: 'CO', currency: 'COP' });
  assert.equal(snap.currencySymbol, '$');
  assert.equal(snap.currencyPosition, 'prefix');
  assert.equal(snap.currencyFractionDigits, 0);
  assert.equal(snap.decimalSeparator, ',');
  assert.equal(snap.groupSeparator, '.');
  // Assert the required formatted parts rather than the exact joined string —
  // the literal separator character between symbol and amount is CLDR/ICU
  // data, not a contract this resolver makes (the project floats on Node 22).
  const parts = new Intl.NumberFormat(snap.locale, {
    style: 'currency', currency: snap.currency, currencyDisplay: 'narrowSymbol',
  }).formatToParts(11000);
  const currencyIndex = parts.findIndex((p) => p.type === 'currency');
  const integerIndex = parts.findIndex((p) => p.type === 'integer');
  assert.ok(currencyIndex >= 0 && currencyIndex < integerIndex, 'symbol renders before the amount, matching currencyPosition');
  assert.equal(parts[currencyIndex].value, '$');
  assert.equal(parts.filter((p) => p.type === 'integer' || p.type === 'group').map((p) => p.value).join(''), '11.000');
  assert.equal(parts.find((p) => p.type === 'fraction'), undefined, '0 fraction digits means no fraction part');
});

test('EUR with comma input: de-DE suffix, dot group, comma decimal', () => {
  const snap = resolveRegionalSnapshot({ country: 'DE', currency: 'EUR' });
  assert.equal(snap.currencySymbol, '€');
  assert.equal(snap.currencyPosition, 'suffix');
  assert.equal(snap.currencyFractionDigits, 2);
  assert.equal(snap.decimalSeparator, ',');
  assert.equal(snap.groupSeparator, '.');
  const parsed = Number('1.234,50'.split(snap.groupSeparator).join('').replace(snap.decimalSeparator, '.'));
  assert.equal(parsed, 1234.5);
});

test('KWD/3: three fraction digits round-trip without loss', () => {
  const snap = resolveRegionalSnapshot({ country: 'KW', currency: 'KWD' });
  assert.equal(snap.currencyFractionDigits, 3);
  assert.equal(Number((1.25).toFixed(snap.currencyFractionDigits)), 1.25);
});

test('Persian RTL / Toman: preferences pass through, fa-IR locale', () => {
  const snap = resolveRegionalSnapshot({ country: 'IR', currency: 'IRR', currency_display: 'toman' });
  assert.equal(snap.locale, 'fa-IR');
  assert.equal(snap.currencyFractionDigits, 2);
  assert.equal(snap.preferences.currencyDisplay, 'toman');
  assert.equal(snap.preferences.digits, 'locale');
  assert.equal(snap.preferences.calendar, 'locale');
});

test('INR: reached the same way as every other country, no special-casing', () => {
  const snap = resolveRegionalSnapshot({ country: 'IN', currency: 'INR' });
  assert.equal(snap.currencySymbol, '₹');
  assert.equal(snap.currencyPosition, 'prefix');
  assert.equal(snap.currencyFractionDigits, 2);
  assert.equal(snap.decimalSeparator, '.');
  assert.equal(snap.groupSeparator, ',');
});

test('missing country: throws RegionalNotConfiguredError, nothing formatted', () => {
  assert.throws(() => resolveRegionalSnapshot({}), RegionalNotConfiguredError);
});

test('unknown country: throws RegionalNotConfiguredError', () => {
  assert.throws(() => resolveRegionalSnapshot({ country: 'ZZ' }), RegionalNotConfiguredError);
});

test('unknown country with an explicit syntactically-valid currency still throws (Ito QA bug-fail-1)', () => {
  // A syntactically-valid-but-bogus currency (three letters) must not mask an
  // unresolvable country — otherwise the currency check short-circuits before
  // the country is ever validated, and a bill can be created under garbage
  // regional settings.
  assert.throws(() => resolveRegionalSnapshot({ country: 'ZZ', currency: 'ZZZ' }), RegionalNotConfiguredError);
});
test('valid stored timezone is kept as-is', () => {
  const snap = resolveRegionalSnapshot({ country: 'US', currency: 'USD', timezone: 'America/Los_Angeles' });
  assert.equal(snap.timezone, 'America/Los_Angeles');
});

test('invalid stored timezone falls back to the country profile timezone', () => {
  const snap = resolveRegionalSnapshot({ country: 'CO', currency: 'COP', timezone: 'Not/AZone' });
  assert.equal(snap.timezone, 'America/Bogota');
});

test('missing stored timezone falls back to the country profile timezone', () => {
  const snap = resolveRegionalSnapshot({ country: 'US', currency: 'USD' });
  assert.equal(snap.timezone, 'America/New_York');
  // Sanity: the resolved zone genuinely observes DST (day-boundary math itself
  // is covered by main/db.ts's own timezone suites, not duplicated here).
  const janOffset = new Intl.DateTimeFormat('en-US', { timeZone: snap.timezone, timeZoneName: 'shortOffset' })
    .formatToParts(new Date('2026-01-15T12:00:00Z')).find((p) => p.type === 'timeZoneName')?.value;
  const julOffset = new Intl.DateTimeFormat('en-US', { timeZone: snap.timezone, timeZoneName: 'shortOffset' })
    .formatToParts(new Date('2026-07-15T12:00:00Z')).find((p) => p.type === 'timeZoneName')?.value;
  assert.notEqual(janOffset, julOffset);
});

test('currency without a matching country still derives currency-side fields', () => {
  // Currency stored can diverge from the country's default (e.g. a merchant
  // priced in a foreign currency); country selection still gates the throw.
  const snap = resolveRegionalSnapshot({ country: 'US', currency: 'JPY' });
  assert.equal(snap.currency, 'JPY');
  assert.equal(snap.currencyFractionDigits, 0);
});

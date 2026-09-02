/**
 * Backend print-language policy settings glue (#441, epic #438).
 *
 * Covers main/lib/print-language-settings.ts, which bridges the neutral
 * shared kernel to the tenant settings store:
 *   - valid policies (JSON string or object) normalize to canonical JSON;
 *   - invalid payloads are rejected with a reason (unknown language,
 *     duplicate additional entry, >1 additional entry, bad JSON);
 *   - stored values parse leniently and fall back to inherit/none defaults;
 *   - the two settings keys are exposed for the wildcard allowlist.
 *
 * Run: npm run test:print-kernel
 */

import assert from 'node:assert/strict';

import {
  BILL_LANGUAGE_POLICY_KEY,
  KOT_LANGUAGE_POLICY_KEY,
  LANGUAGE_POLICY_SETTING_KEYS,
  defaultLanguagePolicySettingJson,
  parseStoredLanguagePolicy,
  validateLanguagePolicySetting,
} from '../main/lib/print-language-settings';

console.log('Testing language-policy settings keys...');
assert.deepEqual(
  [...LANGUAGE_POLICY_SETTING_KEYS].sort(),
  ['bill_language_policy', 'kot_language_policy'],
);

console.log('✓ keys registered');

console.log('Testing default policy payload...');
const defaultValue = JSON.parse(defaultLanguagePolicySettingJson());
assert.deepEqual(defaultValue, { primary: { mode: 'inherit' }, additional: [] });
// Defaults must resolve to exactly the store language (pre-#441 behavior).
const parsed = parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY, undefined);
assert.deepEqual(parsed, { primary: { mode: 'inherit' }, additional: [] });

console.log('✓ inherit/none default preserves current behavior');

console.log('Testing valid payloads normalize to canonical JSON...');

const objectPayload = validateLanguagePolicySetting(BILL_LANGUAGE_POLICY_KEY, {
  primary: { mode: 'inherit' },
  additional: [],
});
assert.ok(objectPayload.ok);
if (objectPayload.ok) {
  assert.equal(objectPayload.stored, '{"primary":{"mode":"inherit"},"additional":[]}');
}

const stringPayload = validateLanguagePolicySetting(BILL_LANGUAGE_POLICY_KEY,
  '{"primary":{"mode":"fixed","language":"fa"},"additional":["es"]}');
assert.ok(stringPayload.ok);
if (stringPayload.ok) {
  const stored = JSON.parse(stringPayload.stored);
  assert.deepEqual(stored.primary, { mode: 'fixed', language: 'fa' });
  assert.deepEqual(stored.additional, ['es']);
}

const kotFixed = validateLanguagePolicySetting(KOT_LANGUAGE_POLICY_KEY,
  '{"primary":{"mode":"fixed","language":"pt"},"additional":[]}');
assert.ok(kotFixed.ok);

console.log('✓ canonical storage');

console.log('Testing invalid payloads are rejected...');
const rejections: Array<[string, unknown]> = [
  [BILL_LANGUAGE_POLICY_KEY, 'not json'],
  [BILL_LANGUAGE_POLICY_KEY, '{"primary":{"mode":"fixed","language":"xx"}}'],
  [BILL_LANGUAGE_POLICY_KEY, '{"primary":{"mode":"auto"}}'],
  [BILL_LANGUAGE_POLICY_KEY, '{"primary":{"mode":"inherit"},"additional":["fa","es"]}'],
  [BILL_LANGUAGE_POLICY_KEY, '{"primary":{"mode":"inherit"},"additional":["fa","fa"]}'],
  [BILL_LANGUAGE_POLICY_KEY, '{"primary":{"mode":"inherit"},"bogus":1}'],
  // KOT is single-primary in v1.
  [KOT_LANGUAGE_POLICY_KEY, '{"primary":{"mode":"inherit"},"additional":["fa"]}'],
];
for (const [key, value] of rejections) {
  const result = validateLanguagePolicySetting(key, value);
  assert.ok(!result.ok, `expected rejection: ${key} = ${JSON.stringify(value)}`);
  if (!result.ok) assert.ok(result.error.length > 0);
}
// Non-policy key is rejected outright.
assert.ok(!validateLanguagePolicySetting('timezone', {}).ok);

console.log('✓ strict writer validation');

console.log('Testing lenient reader fallbacks...');
// Malformed or invalid stored rows fall back to defaults; printing never
// breaks because of one bad settings row.
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY, '{broken'),
  { primary: { mode: 'inherit' }, additional: [] },
);
assert.deepEqual(
  parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY, '{"primary":{"mode":"fixed","language":"xx"}}'),
  { primary: { mode: 'inherit' }, additional: [] },
);
const okStored = parseStoredLanguagePolicy(BILL_LANGUAGE_POLICY_KEY,
  '{"primary":{"mode":"fixed","language":"fa"},"additional":["en"]}');
assert.ok('primary' in okStored && okStored.primary.mode === 'fixed');

console.log('✓ lenient reader with safe fallback');
console.log('\nAll print-language settings tests passed.');

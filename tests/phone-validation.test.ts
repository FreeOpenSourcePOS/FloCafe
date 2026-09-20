const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => '/tmp', getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments);
};

const { parsePhoneE164, stripPhoneDigits } = require('../main/lib/phone');

try {
  // E.164
  let parsed = parsePhoneE164('+919876543210', 'IN');
  if (parsed.e164 !== '+919876543210') throw new Error('Failed E164 parsing');

  // Local
  parsed = parsePhoneE164('9876543210', 'IN');
  if (parsed.e164 !== '+919876543210') throw new Error('Failed Local IN parsing');

  // Formatted
  parsed = parsePhoneE164('+91 987-654-3210', 'IN');
  if (parsed.e164 !== '+919876543210') throw new Error('Failed formatted parsing');

  // US
  parsed = parsePhoneE164('(408) 996-1010', 'US');
  if (!parsed || parsed.e164 !== '+14089961010') throw new Error('Failed US parsing');

  // Strip digits
  const stripped = stripPhoneDigits('+91 987-654-3210');
  if (stripped !== '919876543210') throw new Error('Failed stripPhoneDigits');

  // A full E.164 number needs no defaultCountry — libphonenumber-js ignores
  // it anyway for '+'-prefixed input (CodeRabbit review on #780: the
  // pre-login support-ticket route has no resolvable country).
  parsed = parsePhoneE164('+919876543210', '');
  if (!parsed || parsed.e164 !== '+919876543210') throw new Error('Failed E164 parsing with no defaultCountry');

  // National-format input still requires defaultCountry to be resolvable.
  parsed = parsePhoneE164('9876543210', '');
  if (parsed !== null) throw new Error('National-format input without defaultCountry should be rejected');

  console.log('All phone validation tests passed');
  process.exit(0);
} catch (err) {
  console.error('FAILED:', err.message);
  process.exit(1);
}

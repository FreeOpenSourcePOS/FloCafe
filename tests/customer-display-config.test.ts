import { strict as assert } from 'node:assert';
import {
  CUSTOMER_DISPLAY_DEFAULTS,
  parseCustomerDisplayConfig,
  readStoredCustomerDisplayConfig,
} from '../main/services/customer-display-config';

const valid = { statuses: ['ready', 'pending'], refresh_seconds: 5, show_updated: false };

assert.deepEqual(
  parseCustomerDisplayConfig(valid),
  {
    statuses: ['pending', 'ready'],
    refresh_seconds: 5,
    show_updated: false,
  },
  'valid config is accepted and statuses are normalized to canonical order',
);

const invalid: Array<[string, unknown]> = [
  ['null', null],
  ['array', []],
  ['empty statuses', { ...valid, statuses: [] }],
  ['unknown status', { ...valid, statuses: ['pending', 'cancelled'] }],
  ['statuses not an array', { ...valid, statuses: 'ready' }],
  ['refresh too low', { ...valid, refresh_seconds: 1 }],
  ['refresh too high', { ...valid, refresh_seconds: 61 }],
  ['refresh fractional', { ...valid, refresh_seconds: 2.5 }],
  ['refresh string', { ...valid, refresh_seconds: '5' }],
  ['show_updated string', { ...valid, show_updated: 'true' }],
  ['show_updated missing', { statuses: ['ready'], refresh_seconds: 5 }],
];
for (const [name, value] of invalid) {
  assert.equal(parseCustomerDisplayConfig(value), null, `rejects ${name}`);
}

assert.deepEqual(
  readStoredCustomerDisplayConfig(undefined),
  CUSTOMER_DISPLAY_DEFAULTS,
  'absent row yields defaults',
);
assert.deepEqual(
  readStoredCustomerDisplayConfig('not json'),
  CUSTOMER_DISPLAY_DEFAULTS,
  'corrupt row yields defaults',
);
assert.deepEqual(
  readStoredCustomerDisplayConfig('{"statuses":[]}'),
  CUSTOMER_DISPLAY_DEFAULTS,
  'invalid row yields defaults',
);
assert.deepEqual(readStoredCustomerDisplayConfig(JSON.stringify(valid)).statuses, [
  'pending',
  'ready',
]);

console.log('customer-display-config: all assertions passed');

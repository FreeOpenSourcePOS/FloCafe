import { strict as assert } from 'node:assert';
import {
  CUSTOMER_DISPLAY_DEFAULTS,
  CUSTOMER_DISPLAY_ORDER_TYPES,
  parseCustomerDisplayConfig,
  readStoredCustomerDisplayConfig,
} from '../main/services/customer-display-config';
import { isCustomerDisplayConfig } from '../frontend/src/lib/customer-display';
import { getOrderEffectivePrepStatus } from '../shared/order-item-status';

const valid = {
  statuses: ['ready', 'pending'],
  order_types: ['delivery', 'takeaway', 'delivery'],
  refresh_seconds: 5,
  show_updated: false,
};

assert.deepEqual(
  CUSTOMER_DISPLAY_ORDER_TYPES,
  ['takeaway', 'dine_in', 'online', 'delivery'],
  'CUSTOMER_DISPLAY_ORDER_TYPES defines canonical order types',
);

assert.deepEqual(
  parseCustomerDisplayConfig(valid),
  {
    statuses: ['pending', 'ready'],
    order_types: ['takeaway', 'delivery'],
    refresh_seconds: 5,
    show_updated: false,
  },
  'valid config is accepted and statuses + order_types are normalized to canonical order',
);

// Legacy stored configs without order_types default to ['takeaway'].
const legacyValid = { statuses: ['ready', 'pending'], refresh_seconds: 5, show_updated: false };
assert.deepEqual(
  parseCustomerDisplayConfig(legacyValid),
  {
    statuses: ['pending', 'ready'],
    order_types: ['takeaway'],
    refresh_seconds: 5,
    show_updated: false,
  },
  'legacy config without order_types defaults order_types to takeaway',
);

const invalid: Array<[string, unknown]> = [
  ['null', null],
  ['array', []],
  ['empty statuses', { ...valid, statuses: [] }],
  ['unknown status', { ...valid, statuses: ['pending', 'cancelled'] }],
  ['statuses not an array', { ...valid, statuses: 'ready' }],
  ['empty order_types', { ...valid, order_types: [] }],
  ['unknown order_type', { ...valid, order_types: ['takeaway', 'catering'] }],
  ['order_types not an array', { ...valid, order_types: 'takeaway' }],
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

const frontendLegacy: Record<string, unknown> = {
  statuses: ['pending', 'ready'],
  refresh_seconds: 3,
  show_updated: true,
};
assert.equal(
  isCustomerDisplayConfig(frontendLegacy),
  true,
  'frontend isCustomerDisplayConfig accepts legacy config without order_types',
);
assert.deepEqual(
  frontendLegacy.order_types,
  ['takeaway'],
  'frontend isCustomerDisplayConfig populates default order_types',
);
assert.equal(
  isCustomerDisplayConfig({ ...frontendLegacy, order_types: [] }),
  false,
  'frontend isCustomerDisplayConfig rejects empty order_types',
);
assert.equal(
  isCustomerDisplayConfig({ ...frontendLegacy, order_types: ['catering'] }),
  false,
  'frontend isCustomerDisplayConfig rejects unknown order_types',
);

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
assert.deepEqual(readStoredCustomerDisplayConfig(JSON.stringify(legacyValid)).order_types, [
  'takeaway',
]);

// Effective preparation status for POS Orders page Mark Ready / Picked Up controls
assert.equal(
  getOrderEffectivePrepStatus({ status: 'pending', items: [] as any }),
  'pending',
  'active pending order returns pending',
);
assert.equal(
  getOrderEffectivePrepStatus({ status: 'preparing', items: [] as any }),
  'preparing',
  'active preparing order returns preparing',
);
assert.equal(
  getOrderEffectivePrepStatus({ status: 'ready', items: [] as any }),
  'ready',
  'active ready order returns ready',
);
assert.equal(
  getOrderEffectivePrepStatus({ status: 'served', items: [] as any }),
  null,
  'served order returns null',
);
assert.equal(
  getOrderEffectivePrepStatus({
    status: 'pending',
    release_status: 'scheduled',
    items: [] as any,
  }),
  null,
  'unreleased scheduled order returns null',
);
assert.equal(
  getOrderEffectivePrepStatus({
    status: 'completed',
    items: [{ status: 'preparing', quantity: 1 }] as any,
  }),
  'preparing',
  'completed order with preparing item projects preparing',
);
assert.equal(
  getOrderEffectivePrepStatus({
    status: 'completed',
    items: [{ status: 'ready', quantity: 1 }] as any,
  }),
  'ready',
  'completed order with ready item projects ready',
);
assert.equal(
  getOrderEffectivePrepStatus({
    status: 'completed',
    items: [{ status: 'served', quantity: 1 }] as any,
  }),
  null,
  'completed order with all served items projects null',
);
assert.equal(
  getOrderEffectivePrepStatus({
    status: 'ready',
    items: [
      { status: 'ready', quantity: 1 },
      { status: 'pending', quantity: 1 },
    ] as any,
  }),
  'preparing',
  'ready order with newly appended pending item projects preparing so Mark Ready is shown',
);
assert.equal(
  getOrderEffectivePrepStatus({
    status: 'served',
    items: [
      { status: 'served', quantity: 1 },
      { status: 'pending', quantity: 1 },
    ] as any,
  }),
  'preparing',
  'served order with newly appended pending item projects preparing so Mark Ready is shown',
);
assert.equal(
  getOrderEffectivePrepStatus({
    status: 'served',
    items: [
      { status: 'served', quantity: 1 },
      { status: 'ready', quantity: 1 },
    ] as any,
  }),
  'ready',
  'served order with ready item projects ready so Picked Up is shown',
);

console.log('customer-display-config: all assertions passed');

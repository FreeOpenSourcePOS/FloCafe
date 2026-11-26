/**
 * The phone number on a pizza delivery order: when the POS asks for one, what counts as a number,
 * and the requests it sends to attach a known customer or make a new one.
 *
 * Run: npm run test:pizza-delivery-phone
 */
const { assertOrThrow, loadFrontend, runCases } = require('./helpers/pizza-print-harness');
const { isDeepStrictEqual } = require('node:util');

loadFrontend();
const {
  deliveryCustomer,
  deliveryPhone,
  phoneRequired,
  sameNumber,
} = require('../frontend/src/lib/pizza/delivery-phone');

const same = (actual: unknown, expected: unknown, message: string) =>
  assertOrThrow(
    isDeepStrictEqual(actual, expected),
    `${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
  );

const COUNTER = ['takeaway', 'delivery'];

/** A stand-in for the API client that records what is sent and answers from a list. */
function fakeApi(found: unknown) {
  const sent: Array<[string, string, unknown]> = [];
  return {
    sent,
    client: {
      get: async (url: string, config: unknown) => {
        sent.push(['GET', url, config]);
        return {
          data: found ? { found: true, customer: found } : { found: false, customer: null },
        };
      },
      post: async (url: string, body: { name: string; phone: string }) => {
        sent.push(['POST', url, body]);
        return { data: { customer: { id: 'cust-new', name: body.name, phone: body.phone } } };
      },
    },
  };
}

runCases('pizza-delivery-phone', {
  'Case 1: a number is asked for on a new delivery order of the pizza setup only': () => {
    same(phoneRequired(COUNTER, 'delivery', false), true, 'a new delivery order');
    same(phoneRequired(COUNTER, 'takeaway', false), false, 'a takeaway order');
    same(phoneRequired(COUNTER, 'delivery', true), false, 'items added to a placed order');
    same(phoneRequired([], 'delivery', false), false, 'a store without the pizza setup');
  },

  'Case 2: a number is one the store country reads as a phone number': () => {
    same(deliveryPhone('', 'TH'), null, 'an empty box');
    same(deliveryPhone('   ', 'TH'), null, 'spaces');
    same(deliveryPhone('pizza', 'TH'), null, 'words');
    same(deliveryPhone('555', 'TH'), null, 'too short');
    same(
      deliveryPhone('082 555 0142', 'TH'),
      { e164: '+66825550142', countryCode: '+66', digits: '825550142' },
      'a local number takes the store country code',
    );
    same(
      deliveryPhone('+66 82 555 0142', 'TH')?.e164,
      '+66825550142',
      'a number with its country code',
    );
    same(deliveryPhone('082 555 0142', ''), null, 'no store country, no local number');
  },

  'Case 3: the box matches a customer by number, however it was typed': () => {
    const pat = { id: 'c1', name: 'Pat Example', phone: '+66825550142' };
    same(sameNumber(pat, deliveryPhone('082-555-0142', 'TH')), true, 'the same number');
    same(sameNumber(pat, deliveryPhone('082 555 0143', 'TH')), false, 'another number');
    same(sameNumber(pat, null), false, 'no number');
    same(sameNumber(null, deliveryPhone('082 555 0142', 'TH')), false, 'no customer');
  },

  'Case 4: a known number attaches that customer and makes nobody new': async () => {
    const pat = { id: 'c1', name: 'Pat Example', phone: '+66825550142', is_active: 1 };
    const { sent, client } = fakeApi(pat);
    const customer = await deliveryCustomer(client, deliveryPhone('082 555 0142', 'TH'), 'Other');
    same(customer, pat, 'the customer found');
    same(
      sent,
      [['GET', '/crm/lookup', { params: { phone: '+66825550142' } }]],
      'one look-up by number',
    );
  },

  'Case 5: a new number makes a customer from the number and the name typed': async () => {
    const { sent, client } = fakeApi(null);
    const customer = await deliveryCustomer(
      client,
      deliveryPhone('082 555 0177', 'TH'),
      '  Sam Sample ',
    );
    same(customer.id, 'cust-new', 'the customer made');
    same(
      sent[1],
      ['POST', '/customers', { name: 'Sam Sample', phone: '+66825550177', country_code: '+66' }],
      'the create request',
    );
  },

  'Case 6: with no name typed the new customer is named by the number': async () => {
    const { sent, client } = fakeApi(null);
    await deliveryCustomer(client, deliveryPhone('082 555 0178', 'TH'), '');
    same(
      sent[1],
      ['POST', '/customers', { name: '+66825550178', phone: '+66825550178', country_code: '+66' }],
      'the create request',
    );
  },

  'Case 7: a deactivated customer with the number is made active again, not attached': async () => {
    const gone = { id: 'c9', name: 'Old Example', phone: '+66825550179', is_active: 0 };
    const { sent, client } = fakeApi(gone);
    await deliveryCustomer(client, deliveryPhone('082 555 0179', 'TH'), '');
    same(sent[1]?.[0], 'POST', 'the create route, which reactivates by number');
  },
});

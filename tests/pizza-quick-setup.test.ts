/**
 * Pizza fork: the one-screen setup. The request it builds from the form is the one the
 * `pizza` setup profile is tested with for British Columbia, and the setup route accepts it.
 *
 * Run: npm run test:pizza-quick-setup
 */
const {
  assertOrThrow,
  assertEqualOrThrow,
  runCases,
  createApp,
  startServer,
  api,
} = require('./helpers/pizza-print-harness');
const { isDeepStrictEqual } = require('node:util');
const { initDatabase, getSettingValue } = require('../main/db');
const { registerRoutes } = require('../main/routes/index');
const {
  FIRST_RUN_SETUP_PATH,
  quickSetupBody,
  quickSetupProblems,
  refusedField,
} = require('../frontend/src/lib/pizza/quick-setup');

const same = (actual: unknown, expected: unknown, message: string) =>
  assertOrThrow(isDeepStrictEqual(actual, expected), `${message} (got ${JSON.stringify(actual)})`);

const form = {
  shopName: ' Sample Pizza Shop ',
  name: ' Pizza Owner ',
  email: ' owner@example.com ',
  password: 'TestPass123',
  pin: '5678',
  pinConfirm: '5678',
  termsAccepted: true,
};

// What tests/pizza-setup-profile.test.ts sends for British Columbia, with counter service asked
// for outright and the choices the one screen makes for the owner.
const BC_BODY = {
  name: 'Pizza Owner',
  email: 'owner@example.com',
  password: 'TestPass123',
  business_type: 'restaurant',
  business_name: 'Sample Pizza Shop',
  setup_profile: 'pizza',
  service_model: 'qsr',
  terms_accepted: true,
  owner_approval_pin: '5678',
  owner_approval_pin_confirmation: '5678',
  country: 'CA',
  state_code: 'BC',
  currency: 'CAD',
  timezone: 'America/Vancouver',
  language: 'en',
  product_analytics_level: 'off',
  email_product_updates: false,
  email_marketing: false,
};

async function main() {
  const app = createApp({});
  registerRoutes(app);
  const { baseUrl } = await startServer(app);
  initDatabase();

  await runCases('The one-screen pizza setup', {
    '1. The form becomes the British Columbia pizza request': () => {
      same(quickSetupBody(form, false), BC_BODY, 'the body is the BC pizza body');
      same(
        quickSetupBody(form, true),
        { ...BC_BODY, master_pin: '5678' },
        'where the computer keeps a recovery PIN, the same PIN is sent for it',
      );
      assertEqualOrThrow(FIRST_RUN_SETUP_PATH, '/setup/pizza', 'a fresh install opens here');
    },
    '2. A form that would be refused is stopped at the field': () => {
      same(quickSetupProblems(form), {}, 'a complete form has no problems');
      same(
        quickSetupProblems({
          shopName: ' ',
          name: '',
          email: 'owner-at-example',
          password: 'abc',
          pin: '12',
          pinConfirm: '',
          termsAccepted: false,
        }),
        {
          shopName: 'quickSetupNeedShopName',
          name: 'quickSetupNeedName',
          email: 'quickSetupNeedEmail',
          password: 'quickSetupNeedPassword',
          pin: 'quickSetupNeedPin',
          termsAccepted: 'quickSetupNeedTerms',
        },
        'each empty or short field is named',
      );
      same(
        quickSetupProblems({ ...form, pinConfirm: '5679' }),
        { pinConfirm: 'quickSetupPinMismatch' },
        'PINs that differ are marked at the second one',
      );
      same(
        quickSetupProblems({ ...form, pin: '56789', pinConfirm: '56789' }),
        { pin: 'quickSetupNeedPin' },
        'the PIN is four digits',
      );
    },
    "3. The server's refusal is placed beside the field it is about": () => {
      const cases: Array<[string, string | null]> = [
        ['Password must be at least 4 characters long.', 'password'],
        ['A valid email is required', 'email'],
        ['User with this email already exists', 'email'],
        ['Owner Approval PINs do not match', 'pinConfirm'],
        ['A 4-6 digit owner Approval PIN is required to complete setup', 'pin'],
        ['A 4-digit Master PIN is required to complete setup', 'pin'],
        [
          'You must accept the Terms and Conditions, Privacy Policy, and No Warranty Disclaimer to continue.',
          'termsAccepted',
        ],
        ['Name, email, and password are required', null],
        ['Setup failed', null],
      ];
      for (const [message, field] of cases) {
        assertEqualOrThrow(refusedField(message), field, `"${message}" goes to ${field}`);
      }
    },
    '4. The setup route refuses a short password in words the screen can place': async () => {
      const refused = await api(baseUrl, '/api/auth/setup/initialize', {
        method: 'POST',
        body: quickSetupBody({ ...form, password: 'abc' }, false),
      });
      assertEqualOrThrow(refused.status, 400, 'a short password is refused');
      assertEqualOrThrow(refusedField(refused.data.error), 'password', 'at the password field');
    },
    '5. The setup route accepts the request and the store is a BC pizza shop': async () => {
      const setup = await api(baseUrl, '/api/auth/setup/initialize', {
        method: 'POST',
        body: quickSetupBody(form, false),
      });
      assertEqualOrThrow(setup.status, 200, 'the setup route accepts the body');
      assertOrThrow(Boolean(setup.data.access_token), 'the owner is given a session');
      const expected: Record<string, string> = {
        business_name: 'Sample Pizza Shop',
        setup_profile: 'pizza',
        service_model: 'qsr',
        country: 'CA',
        state_code: 'BC',
        currency: 'CAD',
        timezone: 'America/Vancouver',
        language: 'en',
        taxes_enabled: 'true',
        offline_mode: 'true',
        cloud_sync_enabled: '0',
        telemetry_enabled: 'false',
      };
      for (const [key, value] of Object.entries(expected)) {
        assertEqualOrThrow(getSettingValue(key), value, `${key} is ${value}`);
      }
    },
  });
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});

/**
 * Permission matrix self-access copy contract.
 *
 * The visible half of the owner self-lockout fix: before a save that would take
 * one of the four administrative capabilities away from the person making it,
 * the matrix names the loss on the row; and when the server refuses a write
 * with `administration_unreachable` (400) or
 * `self_privilege_change_requires_factor` (428), the matrix renders its own
 * translated copy rather than the server's English error string.
 *
 * Two contracts are guarded here, both derived rather than hand-listed:
 *
 *   1. The component's own ADMINISTRATIVE_PERMISSION_IDS /
 *      ADMINISTRATIVE_SURFACE_KEYS pair stays in step — every administrative
 *      capability names a distinct message key, and every key it names is
 *      real. The companion backend PR owns the same four-id list
 *      (ADMINISTRATIVE_PERMISSION_IDS in main/services/authorization.ts); a
 *      divergence here means the warning no longer names what the server
 *      protects.
 *
 *   2. Every message key the matrix uses for these paths exists in every locale
 *      in the language registry. The locale list is read from
 *      `frontend/src/lib/i18n/languages.ts` — the same source the translation
 *      suite derives coverage from — so a newly approved language inherits the
 *      check instead of needing this file edited.
 *
 * The rendered result (the warning text in the row, the refusal banner, the PIN
 * prompt re-submitting exactly once) is covered by
 * `frontend/e2e/staff-permission-editor.spec.ts`, which drives the real page.
 *
 * Run: npm run test:authorization-permissions
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const { assertOrThrow, assertEqualOrThrow, assertGreaterThanOrThrow } = require('./helpers/test-setup');

const ROOT = path.resolve(__dirname, '..');
const MATRIX = path.join(ROOT, 'frontend/src/components/settings/PermissionMatrix.tsx');

/** Locales the matrix surfaces the refusal copy in, beyond the row warnings. */
const REFUSAL_KEYS = ['administrationUnreachable', 'selfPrivilegeChangeTitle', 'selfPrivilegeChangePrompt', 'selfPrivilegeNotConfirmed'] as const;

function readLocaleNames(): string[] {
  const source = fs.readFileSync(path.join(ROOT, 'frontend/src/lib/i18n/languages.ts'), 'utf8');
  return [...source.matchAll(/^\s{2}'?([\w-]+)'?:\s*\{\s*$/gm)].map(([, locale]) => locale);
}

function readMatrixSource(): string {
  return fs.readFileSync(MATRIX, 'utf8');
}

function selfAccessKeys(source: string): string[] {
  const block = source.slice(source.indexOf('const ADMINISTRATIVE_SURFACE_KEYS'));
  return [...block.slice(0, block.indexOf('};')).matchAll(/'(selfAccessWarning\w+)'/g)].map(([, key]) => key);
}

function administrativeIds(source: string): string[] {
  const block = source.slice(source.indexOf('const ADMINISTRATIVE_PERMISSION_IDS'));
  return [...block.slice(0, block.indexOf(']')).matchAll(/'([\w.]+)'/g)].map(([, id]) => id);
}

function run(): void {
  console.log('Permission matrix self-access copy:');
  const source = readMatrixSource();
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/src/lib/i18n/messages/en.json'), 'utf8'));
  const matrixMessages = en.permissionMatrix as Record<string, string>;

  // 1. The four administrative capabilities each name a distinct message key.
  const ids = administrativeIds(source);
  assertEqualOrThrow(ids.length, 4, 'the matrix warns on four administrative capabilities');
  assertOrThrow(
    ['authorization.manage', 'staff.privileged.manage', 'staff.operational.manage', 'settings.manage']
      .every((id) => ids.includes(id)),
    `the matrix warns on the backend floor's capabilities, got ${ids.join(', ')}`,
  );

  const keys = selfAccessKeys(source);
  assertEqualOrThrow(new Set(keys).size, keys.length, 'each administrative capability names a distinct warning');
  assertEqualOrThrow(keys.length, 4, 'each of the four capabilities carries its own warning copy');

  // 2. Every key the matrix uses for these paths is a real, non-empty message.
  const required = [...keys, ...REFUSAL_KEYS];
  for (const key of required) {
    assertOrThrow(typeof matrixMessages[key] === 'string' && matrixMessages[key].length > 0, `en.json defines permissionMatrix.${key}`);
  }
  assertOrThrow(typeof en.settings.viewOnlyNotice === 'string' && en.settings.viewOnlyNotice.length > 0, 'en.json defines settings.viewOnlyNotice');

  // 3. Coverage is derived from the language registry, not a list kept here.
  const locales = readLocaleNames();
  assertGreaterThanOrThrow(locales.length, 1, 'the language registry lists the supported locales');
  for (const locale of locales) {
    const file = path.join(ROOT, `frontend/src/lib/i18n/messages/${locale}.json`);
    assertOrThrow(fs.existsSync(file), `${locale} has a message bundle`);
    const messages = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of required) {
      const value = messages.permissionMatrix?.[key];
      assertOrThrow(typeof value === 'string' && value.trim().length > 0, `${locale}.json carries permissionMatrix.${key}`);
    }
    assertOrThrow(
      typeof messages.settings?.viewOnlyNotice === 'string' && messages.settings.viewOnlyNotice.trim().length > 0,
      `${locale}.json carries settings.viewOnlyNotice`,
    );
  }
  console.log(`  ✓ ${required.length} permission-matrix keys + settings.viewOnlyNotice resolve in all ${locales.length} locales`);

  // 4. A refusal renders localized copy, never the server's English error text.
  for (const code of ['administration_unreachable', 'self_privilege_change_requires_factor']) {
    assertOrThrow(source.includes(`'${code}'`), `the matrix handles the ${code} refusal`);
  }
  assertOrThrow(
    /administration_unreachable' && status === 400\) \{\s*const message = t\('administrationUnreachable'\)/.test(source),
    'the 400 refusal renders the translated remedy rather than the server error string',
  );
  assertOrThrow(
    /requires === 'pin' && !pinRetried\.current && actorHasPin/.test(source),
    'the 428 path prompts for the PIN once and only when one is set',
  );
  assertOrThrow(
    /pinRetried\.current = Boolean\(pin\)/.test(source),
    'the PIN latch records whether this attempt presented a PIN, so a mistyped PIN stays correctable',
  );
  assertOrThrow(
    (source.match(/useRef\(/g) || []).length === 1,
    'the matrix declares exactly one latch, so there is no second attempt-scoped guard to drift',
  );

  // 5. The PIN re-submission must use the request field this repository
  // actually reads. A staff PIN authorising a privileged write is
  // `override_pin` (bills, orders, refunds); `master_pin` is the device
  // break-glass factor. A third spelling would 428 forever with no way out.
  assertOrThrow(
    /override_pin: pin/.test(source),
    'the 428 re-submission carries the staff PIN in the repository\'s override_pin field',
  );
  assertOrThrow(
    !/\{\s*pin\s*\}\s*\}/.test(source) && !/\bpin:\s*pin\b/.test(source),
    'the matrix never invents a bare `pin` request field',
  );
  for (const file of ['main/routes/orders.ts', 'main/routes/bills.ts', 'main/routes/refunds.ts']) {
    assertOrThrow(
      fs.readFileSync(path.join(ROOT, file), 'utf8').includes('override_pin'),
      `${file} reads override_pin, so that is the name the client must send`,
    );
  }
  assertOrThrow(
    !/status === 400[\s\S]{0,200}\.data\?\.error/.test(source),
    'the 400 refusal never falls through to the server-supplied error text',
  );

  console.log('Permission matrix self-access copy passed.');
}

run();

/**
 * Permission label coverage contract.
 *
 * `npm run i18n:check` cannot see this class of defect. Before this file existed,
 * `permissionLabel` de-slugified the raw permission id and every one of the 69
 * matrix rows printed `orders · status · update` on every locale, while the
 * finished `permissionMatrix.capabilities` / `.areas` translations sat unread in
 * all 24 bundles. Key parity was green the whole time, because nothing was
 * missing — nothing was being looked up.
 *
 * Two contracts are guarded here:
 *
 *   1. Every id in PERMISSION_DEFINITIONS and every PermissionArea resolves
 *      through the maps in `frontend/src/lib/i18n/enums.ts` to a real message key.
 *      The maps are `satisfies Record<PermissionId, …>`, so a new permission
 *      already fails `tsc`; this test pins the runtime half, and also pins that the
 *      maps cover the catalog rather than drifting behind it.
 *
 *   2. Every key those maps name is present and non-blank in every locale, with
 *      the locale list derived from `frontend/src/lib/i18n/languages.ts` — the
 *      source the translation suite derives coverage from — so a language added
 *      later inherits the check instead of needing this file edited.
 *
 * Run: npm run test:authorization-permissions
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const { assertOrThrow, assertEqualOrThrow, assertGreaterThanOrThrow } = require('./helpers/test-setup');
import type { PermissionArea, PermissionId } from '../shared/permissions';

const ROOT = path.resolve(__dirname, '..');
const ENUMS = path.join(ROOT, 'frontend/src/lib/i18n/enums.ts');
const PERMISSIONS = path.join(ROOT, 'shared/permissions.ts');

/** Locales the registry ships, read from the single source of truth. */
function readLocaleNames(): string[] {
  const source = fs.readFileSync(path.join(ROOT, 'frontend/src/lib/i18n/languages.ts'), 'utf8');
  return [...source.matchAll(/^\s{2}'?([\w-]+)'?:\s*\{\s*$/gm)].map(([, locale]) => locale);
}

/** Permission ids straight from the catalog, so the test follows the catalog. */
function readPermissionIds(): string[] {
  const source = fs.readFileSync(PERMISSIONS, 'utf8');
  const body = source.slice(source.indexOf('export const PERMISSION_DEFINITIONS'), source.indexOf('] as const satisfies readonly PermissionDefinitionShape[]'));
  return [...body.matchAll(/\{ id: '([^']+)'/g)].map(([, id]) => id);
}

function readPermissionAreas(): string[] {
  const source = fs.readFileSync(PERMISSIONS, 'utf8');
  const block = source.slice(source.indexOf('export type PermissionArea'), source.indexOf('export type PermissionRisk'));
  return [...block.matchAll(/'([\w-]+)'/g)].map(([, area]) => area);
}

/**
 * Entries of an `as const satisfies` map, keyed by the source key. Handles both
 * key styles: a permission id contains a dot and must be quoted, a PermissionArea
 * is a bare identifier.
 */
function readPermissionMap(mapName: string, quoted: boolean): Map<string, string> {
  const source = fs.readFileSync(ENUMS, 'utf8');
  const start = source.indexOf(`export const ${mapName} = {`);
  if (start === -1) throw new Error(`frontend/src/lib/i18n/enums.ts has no ${mapName}`);
  const end = source.indexOf('} as const satisfies', start);
  if (end === -1) throw new Error(`${mapName} has no "as const satisfies" clause, so it is not exhaustive`);
  const body = source.slice(start, end);
  const pattern = quoted
    ? /'([^']+)':\s*'([^']+)'/g
    : /(?:^|[,{]\s*)\s*([A-Za-z][\w]*):\s*'([^']+)'/gm;
  const entries = new Map<string, string>();
  for (const match of body.matchAll(pattern)) {
    const [, key, value] = match;
    entries.set(key, value);
  }
  if (!entries.size) throw new Error(`${mapName} parsed as empty`);
  return entries;
}

function run(): void {
  console.log('Permission label coverage:');
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/src/lib/i18n/messages/en.json'), 'utf8'));
  const capabilities = en.permissionMatrix?.capabilities as Record<string, string>;
  const areas = en.permissionMatrix?.areas as Record<string, string>;
  assertOrThrow(capabilities && typeof capabilities === 'object', 'en.json defines permissionMatrix.capabilities');
  assertOrThrow(areas && typeof areas === 'object', 'en.json defines permissionMatrix.areas');

  // 1. Every capability the catalog defines is named, and every name is real.
  const labelKeys = readPermissionMap('PERMISSION_LABEL_KEYS', true);
  const ids = readPermissionIds();
  assertGreaterThanOrThrow(ids.length, 60, 'the permission catalog is the full set, not a subset');

  const unmapped = ids.filter((id) => !labelKeys.has(id));
  assertEqualOrThrow(unmapped.length, 0, `every permission id is labelled, unmapped: ${unmapped.join(', ')}`);

  const stale = [...labelKeys.keys()].filter((id) => !ids.includes(id));
  assertEqualOrThrow(stale.length, 0, `no label points at a retired permission id: ${stale.join(', ')}`);

  for (const [id, key] of labelKeys) {
    assertOrThrow(
      typeof capabilities[key] === 'string' && capabilities[key].trim().length > 0,
      `permissionMatrix.capabilities.${key} exists for ${id}`,
    );
  }

  // 2. Every area is named, and every area name is real.
  const areaKeys = readPermissionMap('PERMISSION_AREA_KEYS', false);
  const areaNames = readPermissionAreas();
  assertGreaterThanOrThrow(areaNames.length, 15, 'the PermissionArea union is the full set');

  const unnamedAreas = areaNames.filter((area) => !areaKeys.has(area));
  assertEqualOrThrow(unnamedAreas.length, 0, `every permission area is named, unnamed: ${unnamedAreas.join(', ')}`);

  const staleAreas = [...areaKeys.keys()].filter((area) => !areaNames.includes(area));
  assertEqualOrThrow(staleAreas.length, 0, `no area name points at a retired area: ${staleAreas.join(', ')}`);

  for (const [area, key] of areaKeys) {
    assertOrThrow(
      typeof areas[key] === 'string' && areas[key].trim().length > 0,
      `permissionMatrix.areas.${key} exists for ${area}`,
    );
  }

  // 3. Coverage is derived from the language registry, not a list kept here.
  const referenced = [
    ...[...labelKeys.values()].map((key) => `permissionMatrix.capabilities.${key}`),
    ...[...areaKeys.values()].map((key) => `permissionMatrix.areas.${key}`),
  ];
  const locales = readLocaleNames();
  assertGreaterThanOrThrow(locales.length, 1, 'the language registry lists the supported locales');
  for (const locale of locales) {
    const file = path.join(ROOT, `frontend/src/lib/i18n/messages/${locale}.json`);
    assertOrThrow(fs.existsSync(file), `${locale} has a message bundle`);
    const messages = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of referenced) {
      const value = key.split('.').reduce<any>((node, part) => node?.[part], messages);
      assertOrThrow(
        typeof value === 'string' && value.trim().length > 0,
        `${locale}.json carries ${key}`,
      );
    }
  }
  console.log(
    `  ✓ ${ids.length} permissions + ${areaNames.length} areas resolve to `
    + `${labelKeys.size} + ${areaKeys.size} keys in all ${locales.length} locales`,
  );

  // 4. The renderer must not fall back to de-slugifying the id. This is asserted by
  //    calling the real functions with a stub translator, not by grepping the
  //    component: a `permissionLabel` that accepts a translator and ignores it used
  //    to satisfy the previous source-regex version of this check, which is the exact
  //    defect this file was written to prevent.
  const { permissionLabel, permissionAreaLabel } = require('../frontend/src/lib/i18n/permission-labels');
  // A `useTranslations('permissionMatrix')` translator receives namespace-relative
  // keys, so the stub does too.
  const enMessages = new Map<string, string>([
    ...Object.entries(capabilities).map(([key, value]) => [`capabilities.${key}`, value]),
    ...Object.entries(areas).map(([key, value]) => [`areas.${key}`, value]),
  ]);
  const translator = (key: string): string => enMessages.get(key) ?? `UNMAPPED:${key}`;

  for (const id of ids) {
    const label = permissionLabel(id as PermissionId, translator as never);
    assertOrThrow(
      typeof label === 'string' && label.length > 0,
      `permissionLabel returns text for ${id}`,
    );
    assertOrThrow(
      !label.startsWith('UNMAPPED:'),
      `permissionLabel resolves ${id} to a real translated key`,
    );
    // The old defect printed the de-slugified id, e.g. "orders · status · update".
    assertOrThrow(
      label !== id.split('.').join(' · '),
      `permissionLabel does not de-slugify ${id}`,
    );
  }
  for (const area of areaNames) {
    const heading = permissionAreaLabel(area as PermissionArea, translator as never);
    assertOrThrow(!heading.startsWith('UNMAPPED:'), `permissionAreaLabel resolves ${area} to a real key`);
    assertOrThrow(heading !== area.replace(/-/g, ' '), `permissionAreaLabel does not de-slugify ${area}`);
  }

  // 5. The fallback is retained, deliberately: a bad catalog response must not crash a row.
  assertOrThrow(
    permissionLabel('not.a.real.permission' as PermissionId, translator as never).includes('·'),
    'permissionLabel keeps the id-splitting fallback for an unmapped id',
  );
  assertOrThrow(
    permissionAreaLabel('not-a-real-area' as PermissionArea, translator as never) === 'not a real area',
    'permissionAreaLabel keeps the id-splitting fallback for an unmapped area',
  );

  console.log('Permission label coverage passed.');
}

run();

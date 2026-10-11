/**
 * Regression: the desktop build sets `trailingSlash: true` (static export),
 * so `usePathname()` returns "/pos/" there but "/pos" in dev. Any strict
 * `pathname === '/x'` comparison silently breaks only in the built app:
 *
 *  - (dashboard)/layout.tsx: isPos/isSettings miss, so POS falls back to the
 *    generic overflow-auto wrapper instead of its own flex-column scroll
 *    panel — the whole page scrolls instead of just the product grid/cart.
 *  - AuthGuard.tsx: the /staff and /settings permission gate never fires,
 *    so ANY authenticated user can open those pages in the built app
 *    regardless of their actual permissions (the backend still blocks real
 *    mutations, but the page shell renders unguarded).
 *
 * normalizePathname() is the fix: every pathname comparison in these files
 * normalizes through it first. This test proves the helper itself is
 * correct and that the exact AuthGuard/layout gate expressions behave
 * identically whether or not the trailing slash is present.
 */

const { normalizePathname } = require('../frontend/src/lib/utils');

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

console.log('='.repeat(70));
console.log('Desktop build trailing-slash routing regression');
console.log('='.repeat(70));

console.log('\n─── normalizePathname ───');
check('strips a single trailing slash', normalizePathname('/pos/') === '/pos');
check('leaves a path with no trailing slash alone', normalizePathname('/pos') === '/pos');
check('leaves root "/" alone, not emptied', normalizePathname('/') === '/');
check('strips the trailing slash on a nested path', normalizePathname('/settings/billing/') === '/settings/billing');
check('null is handled without throwing', normalizePathname(null) === '');
check('undefined is handled without throwing', normalizePathname(undefined) === '');

console.log('\n─── (dashboard)/layout.tsx: isPos / isSettings parity ───');
for (const [rawPos, rawKds, rawSettings] of [
  ['/pos', '/kds', '/settings'],       // dev / cloud build
  ['/pos/', '/kds/', '/settings/'],    // desktop build (trailingSlash: true)
] as const) {
  const pos = normalizePathname(rawPos);
  const isPos = pos === '/pos' || pos === '/kds';
  const kds = normalizePathname(rawKds);
  const isKds = kds === '/pos' || kds === '/kds';
  const settings = normalizePathname(rawSettings);
  const isSettings = settings === '/settings';
  check(`isPos is true for "${rawPos}"`, isPos);
  check(`isPos is true for "${rawKds}"`, isKds);
  check(`isSettings is true for "${rawSettings}"`, isSettings);
}

console.log('\n─── AuthGuard.tsx: /staff and /settings permission gate parity ───');
// Mirrors AuthGuard's exact expressions (lines ~120-135) with tenantCan
// results fixed as true/false, so only the pathname comparison varies.
function staffGateFires(rawPathname: string, canOpenStaff: boolean): boolean {
  const pathname = normalizePathname(rawPathname);
  return pathname === '/staff' && !canOpenStaff;
}
function settingsGateFires(rawPathname: string, canOpenSettings: boolean): boolean {
  const pathname = normalizePathname(rawPathname);
  return pathname === '/settings' && !canOpenSettings;
}

for (const rawStaff of ['/staff', '/staff/'] as const) {
  check(
    `an unauthorized user on "${rawStaff}" is redirected (gate fires)`,
    staffGateFires(rawStaff, false) === true,
  );
  check(
    `an authorized user on "${rawStaff}" is not redirected (gate silent)`,
    staffGateFires(rawStaff, true) === false,
  );
}
for (const rawSettings of ['/settings', '/settings/'] as const) {
  check(
    `an unauthorized user on "${rawSettings}" is redirected (gate fires)`,
    settingsGateFires(rawSettings, false) === true,
  );
  check(
    `an authorized user on "${rawSettings}" is not redirected (gate silent)`,
    settingsGateFires(rawSettings, true) === false,
  );
}

console.log(`\n${'='.repeat(70)}`);
console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
if (failed > 0) process.exit(1);

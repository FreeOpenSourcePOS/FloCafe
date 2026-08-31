/**
 * FOUC script precedence matrix + ThemeSync fix guards (gh-513 review F3).
 *
 * The inline `<head>` script in `frontend/src/app/layout.tsx` is a load-bearing
 * string that runs before first paint; an accidental edit that breaks its
 * precedence chain causes a visible theme flash on every window load. This
 * suite:
 *
 *   1. Extracts the script body straight from the layout source so any
 *      accidental structural change to the JSX literal fails LOUDLY here
 *      (the extraction failure IS the regression signal).
 *
 *   2. Runs it in a node:vm context with stubbed globals for every row of
 *      the precedence matrix: ?theme= param → localStorage mirror → OS
 *      matchMedia → default light, plus the throwing-localStorage and
 *      matchMedia-undefined edges.
 *
 *   3. Source-level asserts on ThemeSync.tsx that the F1/F2/F6/F7 fix
 *      machinery (`hydrated` gate, `authoritative` gate, POS-token gate,
 *      single-shape parse) is still in place, plus the PR review P1-1
 *      (userSelected race guard) and P1-2 (DB-before-mirror follower
 *      chain) invariants. Coarse but catches accidental removal without
 *      bringing in a DOM runner.
 *
 * Run: npm run test:theme-fouc-script
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const ROOT = path.join(__dirname, '..');
const LAYOUT_PATH = path.join(ROOT, 'frontend/src/app/layout.tsx');
const THEME_SYNC_PATH = path.join(ROOT, 'frontend/src/components/layout/ThemeSync.tsx');

// ---------------------------------------------------------------------------
// Script extraction — tolerant, loud-fail-on-shape-change.
// ---------------------------------------------------------------------------

/**
 * Pulls the JSX dangerouslySetInnerHTML __html body out of layout.tsx.
 *
 * The JSX is built from a string concatenation:
 *
 *   __html:
 *     "frag1" +
 *     "frag2" +
 *     'frag3',
 *
 * Returns the final concatenated JS string. Throws if the expected shape is
 * not found — that failure is the regression signal that the load-bearing
 * string was edited.
 */
function extractFoucScript(layoutSource: string): string {
  const idx = layoutSource.indexOf('__html:');
  if (idx === -1) {
    throw new Error('FOUC script extractor: __html: marker not found in layout.tsx');
  }
  // Take the slice after __html: and strip the JSX object literal's
  // closing braces. The naive `indexOf('}}')` matches `}}` inside the
  // string body (e.g. `}}catch(e){}})();`), so locate the script tag's
  // self-closing '/>' and back up from there — the closing '}}' sits
  // between the last string fragment's trailing `,` and that '/>'.
  const rest = layoutSource.slice(idx + '__html:'.length);
  const selfClose = rest.indexOf('/>');
  if (selfClose === -1) {
    throw new Error('FOUC script extractor: script tag self-close not found');
  }
  // Find the LAST '}}' before the self-close (the JSX object close).
  const beforeSelfClose = rest.slice(0, selfClose);
  const closeObj = beforeSelfClose.lastIndexOf('}}');
  if (closeObj === -1) {
    throw new Error('FOUC script extractor: closing }} of dangerouslySetInnerHTML not found');
  }
  let block = rest.slice(0, closeObj).trim();
  // Strip trailing comma so the concatenation expression is valid JS.
  if (block.endsWith(',')) {
    block = block.slice(0, -1).trimEnd();
  }

  // Concatenate all string-literal fragments in order. Escape handling:
  //   - backtick / double-quote / single-quote literals
  //   - standard JS escapes (\\, \', \", \n, \r, \t, \`)
  // We accept fragments that contain at most one terminating quote.
  // Simpler & proven-correct: the JSX block is a valid JS expression
  // (`"a" + "b" + "c"`). Evaluate it in a tiny vm context to get the final
  // concatenated string verbatim. Failures (syntax errors in the block)
  // mean the load-bearing string was edited and this suite is the regression
  // signal.
  const evalCtx: Record<string, unknown> = {};
  vm.createContext(evalCtx);
  let result = '';
  try {
    result = vm.runInContext(`(${block})`, evalCtx, { filename: 'fouc-extract.js' });
  } catch (e) {
    throw new Error(
      `FOUC script extractor: failed to evaluate __html block: ${(e as Error).message}`,
    );
  }
  if (typeof result !== 'string' || result.length === 0) {
    throw new Error(
      `FOUC script extractor: __html block did not yield a string (got ${typeof result})`,
    );
  }
  if (!/\(function\(\)\{try/.test(result) || !/classList\.add/.test(result)) {
    throw new Error(
      `FOUC script extractor: extracted body does not look like the guard (len=${result.length}, got ${JSON.stringify(result)})`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// VM harness for the FOUC script.
// ---------------------------------------------------------------------------

interface HarnessGlobals {
  search: string;
  localStorage: Record<string, string> | { getItem(): never };
  matchMediaMatches?: boolean;
  matchMediaMissing?: boolean;
  localStorageThrows?: boolean;
}

interface RunResult {
  threw: boolean;
  darkClass: boolean;
}

function runScript(script: string, g: HarnessGlobals): RunResult {
  const mirror: Record<string, string> = {};
  // Seed the in-memory mirror from the harness's localStorage fixture
  // (Record<string, string>). Throwing runs ignore the seed.
  if (!g.localStorageThrows && typeof g.localStorage === 'object') {
    for (const [k, v] of Object.entries(g.localStorage)) {
      if (typeof v === 'string') mirror[k] = v;
    }
  }
  const ls = g.localStorageThrows
    ? {
        getItem: () => {
          throw new Error('storage quota');
        },
      }
    : {
        getItem: (k: string) => (k in mirror ? mirror[k] : null),
      };
  // Track class additions with a Set so .contains works.
  const classes = new Set<string>();
  const matchMedia = g.matchMediaMissing
    ? undefined
    : (_query: string) => ({ matches: Boolean(g.matchMediaMatches) });

  const ctx: Record<string, unknown> = {
    location: { search: g.search },
    localStorage: ls,
    window: { matchMedia },
    document: {
      documentElement: {
        classList: {
          add: (c: string) => {
            classes.add(c);
          },
        },
      },
    },
    URLSearchParams,
  };
  // Mirror getItem / setItem in the vm by exposing the in-memory mirror for
  // non-throwing runs.
  if (!g.localStorageThrows) {
    ctx.localStorage = {
      getItem: (k: string) => (k in mirror ? mirror[k] : null),
    };
  }

  vm.createContext(ctx);
  let threw = false;
  try {
    vm.runInContext(script, ctx, { filename: 'fouc-script.js' });
  } catch {
    threw = true;
  }
  return { threw, darkClass: classes.has('dark') };
}

// ---------------------------------------------------------------------------
// Matrix tests.
// ---------------------------------------------------------------------------

const layoutSrc = fs.readFileSync(LAYOUT_PATH, 'utf8');
const script = extractFoucScript(layoutSrc);

const cases: Array<{
  name: string;
  g: HarnessGlobals;
  expectDark: boolean;
}> = [
  {
    name: 'param dark → dark (even without mirror/matchMedia)',
    g: { search: '?theme=dark', localStorage: {} },
    expectDark: true,
  },
  {
    name: 'param light overrides dark mirror',
    g: { search: '?theme=light', localStorage: { 'flo-theme-resolved': 'dark' } },
    expectDark: false,
  },
  {
    name: 'mirror dark, no param, OS light → dark',
    g: { search: '', localStorage: { 'flo-theme-resolved': 'dark' }, matchMediaMatches: false },
    expectDark: true,
  },
  {
    name: 'mirror light, no param, OS dark → light',
    g: { search: '', localStorage: { 'flo-theme-resolved': 'light' }, matchMediaMatches: true },
    expectDark: false,
  },
  {
    name: 'no param, no mirror, OS dark → dark',
    g: { search: '', localStorage: {}, matchMediaMatches: true },
    expectDark: true,
  },
  {
    name: 'no param, no mirror, OS light → light',
    g: { search: '', localStorage: {}, matchMediaMatches: false },
    expectDark: false,
  },
  {
    name: 'matchMedia missing, no param, no mirror → light (safe default)',
    g: { search: '', localStorage: {}, matchMediaMissing: true },
    expectDark: false,
  },
  {
    name: 'garbage param + garbage mirror + OS dark → dark',
    g: {
      search: '?theme=banana',
      localStorage: { 'flo-theme-resolved': 'wat' },
      matchMediaMatches: true,
    },
    expectDark: true,
  },
  {
    name: 'throwing localStorage + param dark → dark, no crash',
    g: { search: '?theme=dark', localStorageThrows: true },
    expectDark: true,
  },
  {
    name: 'throwing localStorage + param garbage + OS light → light, no crash',
    g: {
      search: '?theme=banana',
      localStorageThrows: true,
      matchMediaMatches: false,
    },
    expectDark: false,
  },
];

let passed = 0;
let failed = 0;
for (const c of cases) {
  const r = runScript(script, c.g);
  if (r.threw) {
    console.error(`FAIL ${c.name}: script threw`);
    failed++;
    continue;
  }
  if (r.darkClass !== c.expectDark) {
    console.error(
      `FAIL ${c.name}: expected dark=${c.expectDark}, got dark=${r.darkClass}`,
    );
    failed++;
    continue;
  }
  console.log(`ok   ${c.name} (dark=${r.darkClass})`);
  passed++;
}

// Hard guarantees the script must never violate regardless of matrix case:
assert.equal(failed, 0, `FOUC precedence matrix has ${failed} failures (${passed} passed)`);
assert.ok(
  script.includes("try{") && script.includes("}catch(e){}"),
  'FOUC script must wrap its body in try/catch and swallow errors',
);
console.log(`ok   FOUC script body is try/catch wrapped (${script.length} chars)`);

// ---------------------------------------------------------------------------
// ThemeSync.tsx source-level guards (catches accidental removal of the F1/F2 fix).
// The behavioral path is exercised by Wave 3 e2e; these are coarse tripwires.
// ---------------------------------------------------------------------------

const themeSyncSrc = fs.readFileSync(THEME_SYNC_PATH, 'utf8');
assert.ok(
  /useState\s*\(\s*false\s*\)/.test(themeSyncSrc),
  'ThemeSync must guard apply behind a hydrated flag (F1 fix)',
);
assert.ok(
  /hydrated/.test(themeSyncSrc) && /if\s*\(\s*!hydrated/.test(themeSyncSrc),
  'ThemeSync must short-circuit the apply effect when not hydrated (F1 fix)',
);
console.log('ok   ThemeSync has hydrated guard (F1 fix)');

assert.ok(
  /authoritative\s*=\s*useRef/.test(themeSyncSrc),
  'ThemeSync must use an authoritative ref for the follower gate (F2 fix)',
);
assert.ok(
  /authoritative\.current/.test(themeSyncSrc),
  'ThemeSync must read authoritative.current to decide mirror writes (F2 fix)',
);
// The mirror write must be inside the apply effect AND gated on
// `window.electronAPI || authoritative.current` — accept either parens or
// spacing variants.
assert.ok(
  /window\.electronAPI\s*\|\|\s*authoritative\.current/.test(themeSyncSrc),
  'ThemeSync mirror write must be gated on owner OR authoritative follower (F2 fix)',
);
console.log('ok   ThemeSync has authoritative gate (F2 fix)');

assert.ok(
  /window\.electronAPI/.test(themeSyncSrc) && /getSettings/.test(themeSyncSrc),
  'ThemeSync must hydrate from electronAPI.getSettings() when present (F1 fix)',
);
console.log('ok   ThemeSync hydrates from getSettings() when owner (F1 fix)');

// F6 / F7 tripwires — gate the follower DB fetch on the POS token so the
// api.ts 401 interceptor cannot redirect bespoke-auth routes to /auth/login.
assert.ok(
  /localStorage\.getItem\(\s*['"]token['"]\s*\)/.test(themeSyncSrc),
  'ThemeSync must read the POS token from localStorage before the DB fetch (F6 fix)',
);
assert.ok(
  /hasPosToken/.test(themeSyncSrc),
  'ThemeSync must gate the api.get call on the POS token presence (F6 fix)',
);
assert.ok(
  /api\.get\(\s*['"]\/settings\/theme_mode['"]\s*\)/.test(themeSyncSrc),
  'ThemeSync must still call api.get for the persisted setting (regression guard)',
);
// Single-shape parse: settings endpoint returns `{ setting: { value } }`.
assert.ok(
  /\.data\?\.setting\?\.value/.test(themeSyncSrc),
  'ThemeSync must parse the single-shape setting.value response (F7 fix)',
);
console.log('ok   ThemeSync gates DB fetch on POS token (F6 fix) + single-shape parse (F7 fix)');

console.log(`\nFOUC matrix: ${passed} passed, ${failed} failed`);

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const STORE_PATH = path.join(ROOT, 'frontend/src/store/theme.ts');
const storeSrc = fs.readFileSync(STORE_PATH, 'utf8');
assert.ok(
  /userSelected/.test(storeSrc),
  'theme store must declare userSelected state (PR review P1-1)',
);
assert.ok(
  /markUserSelected/.test(storeSrc),
  'theme store must expose markUserSelected action (PR review P1-1)',
);
assert.ok(
  /userSelected:\s*false/.test(storeSrc),
  'theme store must default userSelected to false (PR review P1-1)',
);
console.log('ok   theme store has userSelected + markUserSelected (PR review P1-1)');

assert.ok(
  /useThemeMode\.getState\(\)\.userSelected/.test(themeSyncSrc),
  'ThemeSync boot effect must consult useThemeMode.getState().userSelected before setMode (PR review P1-1)',
);
assert.ok(
  /userHasChosen\(\)/.test(themeSyncSrc),
  'ThemeSync must define a userHasChosen() helper that reads the store flag (PR review P1-1)',
);
// The owner branch AND the follower branch both reference the helper —
// confirm the helper appears inside the boot effect, before any setMode.
// Capture the entire first useEffect body (the boot effect) up to its
// dependency-array close. setMode calls live inside the async boot()
// arrow, so a naive `boot();` anchor cuts them off.
const bootBody = (themeSyncSrc.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[setMode\]\)/) ?? [''])[0];
assert.ok(
  bootBody.includes('userHasChosen()') && /setMode\(/.test(bootBody),
  'ThemeSync boot effect must gate every setMode behind the userHasChosen() check (PR review P1-1)',
);
console.log('ok   ThemeSync gates every boot setMode on userHasChosen() (PR review P1-1)');

// Settings saveThemeMode must call markUserSelected BEFORE the optimistic
// setThemeMode — a one-line placement that's the whole point of the guard.
const settingsSrc = fs.readFileSync(
  path.join(ROOT, 'frontend/src/app/(dashboard)/settings/page.tsx'),
  'utf8',
);
const saveBody = (settingsSrc.match(/saveThemeMode = async[\s\S]*?\n\s{2}\};/) ?? [''])[0];
assert.ok(
  saveBody.includes('markUserSelectedTheme()') || saveBody.includes('markUserSelected()'),
  'Settings saveThemeMode must call markUserSelected (PR review P1-1)',
);
const markIdx = saveBody.indexOf('markUserSelectedTheme()') === -1
  ? saveBody.indexOf('markUserSelected()')
  : saveBody.indexOf('markUserSelectedTheme()');
const flipIdx = saveBody.indexOf('setThemeMode(next)');
assert.ok(
  markIdx !== -1 && flipIdx !== -1 && markIdx < flipIdx,
  'Settings saveThemeMode must call markUserSelected BEFORE the optimistic setThemeMode (PR review P1-1)',
);
console.log('ok   Settings saveThemeMode flags userSelected before optimistic flip (PR review P1-1)');

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const dbFetchIdx = themeSyncSrc.indexOf("api.get('/settings/theme_mode')");
const mirrorReadIdx = themeSyncSrc.indexOf(`localStorage.getItem(THEME_MIRROR_KEY)`);
assert.ok(
  dbFetchIdx !== -1 && mirrorReadIdx !== -1,
  'ThemeSync must contain both the DB fetch and the mirror read for the P1-2 tripwire (PR review P1-2)',
);
assert.ok(
  dbFetchIdx < mirrorReadIdx,
  'ThemeSync follower chain must attempt the DB fetch BEFORE reading the mirror (PR review P1-2)',
);
console.log('ok   ThemeSync reads DB before mirror in follower chain (PR review P1-2)');

// The follower resolution precedence is documented as DB > param > mirror —
// assert the order of the branches that call setMode.
const dbSetModeIdx = themeSyncSrc.indexOf('setMode(dbMode)');
const paramSetModeIdx = themeSyncSrc.lastIndexOf('setMode(paramResolved)');
const mirrorSetModeIdx = themeSyncSrc.indexOf('setMode(mirrorResolved)');
assert.ok(
  dbSetModeIdx !== -1 && paramSetModeIdx !== -1 && mirrorSetModeIdx !== -1,
  'ThemeSync must contain all three resolution branches (DB / param / mirror)',
);
assert.ok(
  dbSetModeIdx < paramSetModeIdx && paramSetModeIdx < mirrorSetModeIdx,
  'ThemeSync follower resolution order must be DB > param > mirror (PR review P1-2)',
);
console.log('ok   ThemeSync follower resolution order DB > param > mirror (PR review P1-2)');

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

assert.ok(
  /RETRY_DELAY_MS/.test(themeSyncSrc),
  'ThemeSync must declare a retry delay constant for the DB fetch (PR review P1-4)',
);
assert.ok(
  /attempt\s*<=\s*2/.test(themeSyncSrc),
  'ThemeSync must bound the DB fetch retry to two attempts (PR review P1-4)',
);
assert.ok(
  /cancellableSleep\(RETRY_DELAY_MS,\s*isCancelled\)/.test(themeSyncSrc),
  'ThemeSync retry delay must use the declared constant via cancellableSleep (PR review P1-4)',
);
assert.ok(
  /setTimeout\(resolve,\s*ms\)/.test(themeSyncSrc),
  'cancellableSleep must wait the given delay before resolving (PR review P1-4)',
);
assert.ok(
  /clearTimeout\(t\)/.test(themeSyncSrc),
  'ThemeSync retry delay must clear its setTimeout on cancel (PR review P1-4)',
);
console.log('ok   ThemeSync DB fetch is bounded-retry (PR review P1-4)');

// Count authoritative.current = true occurrences in the follower branch
// and assert the mirror seed has it ONLY inside the no-fetch-attempted
// gate (the fetch-FAILED mirror path must skip it). Extract the follower
// block as the content between the owner-vs-follower `} else {` and the
// unique tail `void dbAttempted;` (the last statement in the follower
// before its closing `}`).
const followerElseIdx = themeSyncSrc.indexOf('} else {', themeSyncSrc.indexOf('window.electronAPI'));
// The follower block in `boot()` ends at the one-shot recheck guard
// (unique to this PR — `hasPosToken && dbAttempted && !dbMode`). Everything
// up to that line lives inside the follower branch.
const followerTailIdx = themeSyncSrc.indexOf(
  'hasPosToken && dbAttempted && !dbMode',
  followerElseIdx,
);
assert.ok(
  followerElseIdx !== -1 && followerTailIdx !== -1,
  'ThemeSync follower block boundaries must be locatable for the P1-4 tripwire (regression guard)',
);
const followerBlock = themeSyncSrc.slice(followerElseIdx, followerTailIdx);
// Inside the follower block, authoritative.current = true must appear at
// least three times (dbMode, param, mirror-on-no-fetch) and NOT inside
// the fetch-failed mirror seed (the !dbAttempted gate must precede it).
const authTrueMatches = followerBlock.match(/authoritative\.current\s*=\s*true/g) ?? [];
assert.ok(
  authTrueMatches.length >= 3,
  `ThemeSync follower block must mark authoritative at least 3 times (dbMode + param + mirror-no-fetch), got ${authTrueMatches.length} (PR review P1-4)`,
);
const mirrorSeedBody = (followerBlock.match(
  /else\s+if\s*\(isThemeModeValue\(mirrorResolved\)\)\s*\{([\s\S]*?)\n\s{10}\}/,
) ?? ['', ''])[1];
assert.ok(
  mirrorSeedBody.length > 0,
  'ThemeSync mirror seed block must be locatable for the P1-4 tripwire',
);
// Inside the mirror seed, authoritative.current = true must appear
// EXACTLY once and that one occurrence must be inside `if (!dbAttempted)`.
const mirrorAuthTrueCount = (mirrorSeedBody.match(/authoritative\.current\s*=\s*true/g) ?? []).length;
assert.ok(
  mirrorAuthTrueCount === 1,
  `ThemeSync mirror seed must flip authoritative exactly once (inside !dbAttempted), got ${mirrorAuthTrueCount} (PR review P1-4)`,
);
assert.ok(
  /!\s*dbAttempted\)/.test(mirrorSeedBody),
  'ThemeSync mirror seed must gate authoritative on !dbAttempted (PR review P1-4)',
);
console.log('ok   ThemeSync mirror seed marks authoritative only on no-fetch (PR review P1-4)');

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

assert.ok(
  /saveSeq\s*=\s*useRef/.test(settingsSrc),
  'Settings must declare a saveSeq ref to guard the hydration race (PR review P1-3)',
);
assert.ok(
  /\+\+saveSeq\.current/.test(settingsSrc),
  'Settings saveThemeMode must increment saveSeq.current at entry (PR review P1-3)',
);
assert.ok(
  /seqAtFetch\s*=\s*saveSeq\.current/.test(settingsSrc),
  'Settings hydration effect must snapshot saveSeq at fetch start (PR review P1-3)',
);
assert.ok(
  /saveSeq\.current\s*===\s*seqAtFetch/.test(settingsSrc),
  'Settings hydration must only update lastCommitted when no save raced the fetch (PR review P1-3)',
);
// The saveThemeMode catch path must do a server-truth restore:
//   api.get('/settings/theme_mode') AND setMode + lastCommitted update.
assert.ok(
  /api\.get\(\s*['"]\/settings\/theme_mode['"]\s*\)/.test(saveBody),
  'Settings saveThemeMode catch must re-fetch the persisted setting (PR review P1-3)',
);
assert.ok(
  /lastCommitted\.current\s*=\s*serverValue/.test(saveBody) ||
    /lastCommitted\.current\s*=\s*\w+/.test(saveBody),
  'Settings saveThemeMode catch must update lastCommitted from the server-truth restore (PR review P1-3)',
);
// Restore must be gated on saveSeq.current === seq so a newer save's
// baseline is not clobbered by an older save's stale response.
assert.ok(
  /saveSeq\.current\s*===\s*seq/.test(saveBody),
  'Settings saveThemeMode catch must gate the server-truth restore on saveSeq unchanged (PR review P1-3)',
);
console.log('ok   Settings saveThemeMode restores from server truth on PUT failure (PR review P1-3)');

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

assert.ok(
  /RECHECK_DELAY_MS/.test(themeSyncSrc),
  'ThemeSync must declare RECHECK_DELAY_MS for the one-shot delayed re-check (PR review P1-A)',
);
assert.ok(
  /const\s+RECHECK_DELAY_MS\s*=\s*[\d_]+/.test(themeSyncSrc),
  'RECHECK_DELAY_MS must be a numeric constant declaration (PR review P1-A)',
);
// Exactly one setTimeout call whose delay arg is RECHECK_DELAY_MS (the
// recheck). RETRY_DELAY_MS uses may appear zero-or-more times. The
// callback is a multiline async arrow that contains commas (loop
// expressions, array literal syntax in the body), so we cannot pin the
// first arg with a comma-non-token class — match `setTimeout(...,
// RECHECK_DELAY_MS)` by anchoring the closing arg + delay + paren.
const recheckTimeoutCalls = themeSyncSrc.match(
  /setTimeout\([\s\S]*?,\s*RECHECK_DELAY_MS\s*\)/g,
) ?? [];
assert.ok(
  recheckTimeoutCalls.length === 1,
  `ThemeSync must schedule exactly ONE delayed re-check (setTimeout(..., RECHECK_DELAY_MS)), found ${recheckTimeoutCalls.length} (PR review P1-A)`,
);
// The recheck must be cancellation-safe: a clearTimeout call should be
// reachable on cancel (either via the explicit cancel closure or via
// recheckHandle clearing). We accept either pattern — the tripwire is
// coarse but catches "scheduled but never cancellable".
assert.ok(
  /clearTimeout\(/.test(themeSyncSrc) &&
    (/(?:handle|cancelled|cancelRecheck)/.test(themeSyncSrc)),
  'ThemeSync delayed re-check must clear its timer on unmount/cancel (PR review P1-A)',
);
console.log('ok   ThemeSync has one-shot delayed re-check (PR review P1-A)');

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

assert.ok(
  /needsServerTruth\s*=\s*useRef/.test(settingsSrc),
  'Settings must declare needsServerTruth as a useRef flag (PR review P1-B)',
);
assert.ok(
  /needsServerTruth\.current\s*=\s*true/.test(saveBody),
  'Settings saveThemeMode catch must arm needsServerTruth.current = true on the recovery-GET failure path (PR review P1-B)',
);
assert.ok(
  /needsServerTruth\.current/.test(saveBody) || /needsServerTruth\.current\s*=\s*false/.test(saveBody),
  'Settings saveThemeMode must clear the needsServerTruth arm after consuming it (PR review P1-B)',
);
// The hydration effect must consult the flag and apply server truth
// when armed — look for the arm check inside the hydration useEffect.
const settingsHydrationEffect = (settingsSrc.match(
  /useEffect\(\(\) => \{[\s\S]*?api\.get\(\s*['"]\/settings\/theme_mode['"]\s*\)[\s\S]*?\}, \[setThemeMode\]\)/,
) ?? [''])[0];
assert.ok(
  settingsHydrationEffect.length > 0,
  'Settings hydration useEffect must be locatable for the P1-B tripwire',
);
assert.ok(
  /needsServerTruth\.current/.test(settingsHydrationEffect),
  'Settings hydration response handler must consult needsServerTruth.current (PR review P1-B)',
);
assert.ok(
  /setThemeMode\(raw\)/.test(settingsHydrationEffect) ||
    /setThemeMode\(\s*serverValue\s*\)/.test(settingsHydrationEffect),
  'Settings hydration handler must apply the server-truth value when the arm is set (PR review P1-B)',
);
console.log('ok   Settings has armed server-truth hydration (PR review P1-B)');

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

// --- retry sleep ---

// 1a. The broken sync-resolve pattern must be GONE. The buggy shape
// was `if (isCancelled()) clearTimeout(t); resolve();` on adjacent
// lines (no braces on the `if` → the resolve ran synchronously every
// time, not just on cancellation). Any remaining bare `if (isCancelled())`
// directly followed by `clearTimeout(t);` without braces is the bug.
const buggySyncResolve = /\bif\s*\(\s*isCancelled\(\)\s*\)\s*clearTimeout\(t\)\s*;\s*\n\s*resolve\(\)\s*;/m.test(themeSyncSrc);
assert.ok(
  !buggySyncResolve,
  'ThemeSync retry sleep must NOT use the no-brace `if (isCancelled()) clearTimeout(t); resolve();` Bug 1 shape — resolve must be inside a `{ }` block',
);

// 1b. The retry must go through cancellableSleep with the declared constant.
const retrySleepMatches = themeSyncSrc.match(/cancellableSleep\(RETRY_DELAY_MS,\s*isCancelled\)/g) ?? [];
assert.ok(
  retrySleepMatches.length >= 1,
  `ThemeSync must route the retry backoff through cancellableSleep(RETRY_DELAY_MS), found ${retrySleepMatches.length}`,
);

// 1c. The resolve() call must appear INSIDE a setTimeout(... RETRY_DELAY_MS)
// callback — count all bare `resolve();` statements OUTSIDE any
// setTimeout callback in the fetch helper region (between the two
// setTimeout strings). We approximate by counting `resolve()` in the
// fetchThemeMode function body.
const fetchHelperBody = (themeSyncSrc.match(
  /const fetchThemeMode = async[\s\S]*?Promise<ThemeMode \| null> => \{[\s\S]*?return null;\n\s*\};/,
) ?? [''])[0];
assert.ok(
  fetchHelperBody.length > 0,
  'ThemeSync must declare fetchThemeMode as an async helper',
);
// The sleep now lives in the module-scope cancellableSleep helper; its
// resolve() must sit inside the setTimeout callback (the Bug 1 invariant).
const sleepHelperBody = (themeSyncSrc.match(/const cancellableSleep[\s\S]*?\n\s*\}\);/m) ?? [''])[0];
const resolveCallsInSleepHelper = (sleepHelperBody.match(/\bresolve\(\)\s*;/g) ?? []).length;
assert.ok(
  resolveCallsInSleepHelper >= 1,
  `cancellableSleep must contain a resolve() call inside the setTimeout, found ${resolveCallsInSleepHelper}`,
);

// --- auth-changed dispatch + listener ---

const authSrc = fs.readFileSync(
  path.join(ROOT, 'frontend/src/store/auth.ts'),
  'utf8',
);
// 2a. The persistSession helper must dispatch the event after the
// token is persisted.
assert.ok(
  /new\s+Event\(\s*THEME_REHYDRATION_EVENT\s*\)/.test(authSrc),
  'auth.ts must dispatch a `flo:auth-changed` window event after persisting the token',
);
// 2b. The dispatch must be inside persistSession (same helper that calls
// localStorage.setItem('token', ...)) so KDS pairing + every login flow
// triggers it. Matches to the function's final line-start brace — inner
// try/catch closes are indented, so they don't end the match early.
const persistSessionBody = (authSrc.match(
  /function persistSession\([^)]*\): void \{[\s\S]*?\n\}/m,
) ?? [''])[0];
assert.ok(
  /new\s+Event\(\s*THEME_REHYDRATION_EVENT\s*\)/.test(persistSessionBody),
  'persistSession must dispatch flo:auth-changed',
);

// 2c. ThemeSync must listen for flo:auth-changed.
assert.ok(
  /addEventListener\(\s*THEME_REHYDRATION_EVENT/.test(themeSyncSrc),
  'ThemeSync must addEventListener for the theme rehydration event',
);
// 2d. ThemeSync must remove the listener in cleanup (no leak across
// effect re-runs / unmounts). The remove call must be inside the same
// effect cleanup that sets `cancelled = true`.
assert.ok(
  /removeEventListener\(\s*THEME_REHYDRATION_EVENT/.test(themeSyncSrc),
  'ThemeSync must removeEventListener for the theme rehydration event in cleanup',
);
// 2e. add/remove listener count must match — mismatched counts indicate
// either a leaked listener or an unbalanced cleanup. Both calls should
// appear exactly once (no fan-out / fan-in).
const addCount = (themeSyncSrc.match(/addEventListener\(\s*THEME_REHYDRATION_EVENT/g) ?? []).length;
const removeCount = (themeSyncSrc.match(/removeEventListener\(\s*THEME_REHYDRATION_EVENT/g) ?? []).length;
assert.ok(
  addCount === 1 && removeCount === 1,
  `ThemeSync must add/remove flo:auth-changed listener exactly once each, got add=${addCount} remove=${removeCount}`,
);
console.log('ok   Rehydrate-fix invariants: retry sleeps and auth-changed listener (gh-513)');

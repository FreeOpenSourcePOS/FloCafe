#!/usr/bin/env bash
# Runs the checks of .github/workflows/ci.yml on this machine, because GitHub
# Actions is not enabled on the fork. Every step runs even if an earlier one
# fails; results go to <reportDir>/steps.tsv, one log per step.
#
# Usage: scripts/pizza/local-ci.sh <reportDir> [baseRef] [part]
# part: all (default), or a and b to split one check across two machines:
#   a = static checks, builds, core suite, release regressions, browser tests 1/2
#   b = builds, browser tests 2/2, the tier set, the native Electron suite
# Run from the repository root after `npm ci` in the root (its postinstall
# rebuilds the native modules) and `npm ci` in frontend/.
#
# Differences from CI:
# - The core suite is a superset: it runs every suite in "pretest" and "test",
#   so the release regression suites run twice (once here with the evidence
#   flag, as CI does).
# - The native Electron suite runs on Linux only, under Xvfb with shown
#   windows, as CI runs it. On macOS it is recorded as "skipped": with a
#   throwaway HOME the app asks macOS for a keychain that is not there, and a
#   system dialog offers to reset the user's keychain.
# - Not run anywhere: dependency review and the Windows jobs.
set -u
OUT=${1:?usage: local-ci.sh <reportDir> [baseRef] [part]}
BASE=${2:-origin/main}
PART=${3:-all}
case "$PART" in all | a | b) ;; *) echo "part must be all, a or b" >&2; exit 2 ;; esac
ROOT=$(pwd)
TOOLS="$ROOT/scripts/pizza"
mkdir -p "$OUT" "$OUT/home"
OUT=$(cd "$OUT" && pwd)
rm -f "$OUT/steps.tsv" "$OUT/DONE"

# Browsers live outside the throwaway home so they are downloaded once.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/pizza-pos/ms-playwright}"
export NEXT_TELEMETRY_DISABLED=1
FAKE_HOME="$OUT/home"
OS=$(uname -s)

# CI wraps the core suite and the Electron suite in xvfb-run on Linux.
XVFB=()
if [ "$OS" = "Linux" ]; then
  XVFB=(xvfb-run -a --server-args='-screen 0 1280x800x24')
fi

FAILED=0
step() {
  local name=$1
  shift
  local t
  t=$(date +%s)
  "$@" > "$OUT/$name.log" 2>&1
  local rc=$?
  [ "$rc" -eq 0 ] || FAILED=1
  printf '%s\trc=%s\t%ss\n' "$name" "$rc" "$(($(date +%s) - t))" >> "$OUT/steps.tsv"
}
finish() {
  if [ "$FAILED" -eq 0 ]; then echo "pass" > "$OUT/DONE"; else echo "fail" > "$OUT/DONE"; fi
  exit "$FAILED"
}

{
  date
  uname -srm
  echo "node $(node -v)"
  echo "npm $(npm -v)"
  echo "head $(git rev-parse HEAD)"
  echo "base $(git rev-parse "$BASE")"
  echo "part $PART"
} > "$OUT/env.txt" 2>&1

SHARD=()
case "$PART" in a) SHARD=(--shard=1/2) ;; b) SHARD=(--shard=2/2) ;; esac

if [ "$PART" != "b" ]; then
  step script-coverage npm run test:script-coverage
  step lint-backend npm run lint:backend
  step tsc npx tsc --noEmit
  step lint-frontend npm --prefix frontend run lint
  step format-changed node scripts/ci/check-changed-format.cjs --base "$BASE"
  step lint-budget npm run lint:budget
  step docs npm run docs:check
fi
step build npm run build
step build-frontend npm run build:frontend
if [ "$PART" != "b" ]; then
  step core-suite ${XVFB[@]+"${XVFB[@]}"} env HOME="$FAKE_HOME" node "$TOOLS/run-suite-report.cjs" "$ROOT" "$OUT"
fi
step playwright-install npm --prefix frontend exec -- playwright install chromium
if [ "$PART" != "b" ]; then
  step release-regressions env HOME="$FAKE_HOME" CI=true REQUIRE_VISUAL_EVIDENCE=1 EVIDENCE_DIR="$OUT/evidence" npm run test:release-regressions
fi

GREP_INVERT='FINDING:|a paid order offers a refund, and issuing it settles against the recorded sale'
cd "$ROOT/frontend" || { FAILED=1; finish; }
step playwright-standard env HOME="$FAKE_HOME" CI=true PLAYWRIGHT_HTML_OUTPUT_DIR="$OUT/playwright-report/standard" \
  npx playwright test --config=playwright.config.ts --project=chromium --output="$OUT/test-results/standard" \
  --grep-invert="$GREP_INVERT|@ci-tier1|@ci-tier2" ${SHARD[@]+"${SHARD[@]}"}
if [ "$PART" != "a" ]; then
  step playwright-tier env HOME="$FAKE_HOME" CI=true PLAYWRIGHT_HTML_OUTPUT_DIR="$OUT/playwright-report/tier" \
    npx playwright test --config=playwright.config.ts --project=chromium --retries=0 --output="$OUT/test-results/tier" \
    --grep='@ci-tier1|@ci-tier2' --grep-invert="$GREP_INVERT"
fi
if [ "$PART" = "a" ]; then
  printf 'electron-e2e\tskipped (part a: runs in part b)\t0s\n' >> "$OUT/steps.tsv"
elif [ "$OS" = "Linux" ]; then
  step electron-e2e "${XVFB[@]}" env HOME="$FAKE_HOME" CI=true FLO_E2E_SHOW_WINDOW=1 \
    PLAYWRIGHT_HTML_OUTPUT_DIR="$OUT/playwright-report/electron" \
    npx playwright test --config=playwright.electron.config.ts --project=electron-desktop \
    --output="$OUT/test-results/electron"
else
  printf 'electron-e2e\tskipped (%s: runs on Linux only)\t0s\n' "$OS" >> "$OUT/steps.tsv"
fi

finish

#!/usr/bin/env bash
# Install, build and run the full suite of a checkout, recording each step.
# Usage: baseline.sh <worktree> <outDir> <toolsDir>
set -u
WT=$1; OUT=$2; TOOLS=$3
# Absolute before the cd, so relative arguments keep their meaning.
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd); TOOLS=$(cd "$TOOLS" && pwd) || exit 2
cd "$WT" || exit 2
rm -f "$OUT/DONE" "$OUT/steps.tsv"
step() {
  local name=$1; shift
  local t; t=$(date +%s)
  "$@" > "$OUT/$name.log" 2>&1
  local rc=$?
  printf '%s\trc=%s\t%ss\n' "$name" "$rc" "$(( $(date +%s) - t ))" >> "$OUT/steps.tsv"
  return $rc
}
finish() { echo "$1" > "$OUT/DONE"; exit 0; }
{ date; uname -srm; echo "node $(node -v)"; echo "npm $(npm -v)"; git rev-parse HEAD; } > "$OUT/env.txt" 2>&1
step install npm ci || finish "stopped: install failed"
step rebuild npx @electron/rebuild -f -w better-sqlite3 || finish "stopped: native rebuild failed"
step install-frontend npm --prefix frontend ci || finish "stopped: frontend install failed"
step tsc npx tsc --noEmit
step lint npm run lint
step lint-budget npm run lint:budget
step build npm run build
step build-frontend npm run build:frontend
mkdir -p "$OUT/home"
# CI wraps the suite in xvfb-run on Linux.
XVFB=()
if [ "$(uname -s)" = "Linux" ]; then
  XVFB=(xvfb-run -a --server-args='-screen 0 1280x800x24')
fi
step suite python3 "$TOOLS/with-suite-lock.py" ${XVFB[@]+"${XVFB[@]}"} env HOME="$OUT/home" node "$TOOLS/run-suite-report.cjs" "$WT" "$OUT"
finish "complete"

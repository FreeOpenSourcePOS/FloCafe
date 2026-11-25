# Brief: offline by default

Implements decision D13 in [../decisions.md](../decisions.md). Read that entry and [../README.md](../README.md) first.

## Problem

A fresh install contacts outside services without the owner asking. Finishing setup turns cloud sync on unconditionally and registers the install with `blue.flopos.com`, sending the business name, owner name, email, phone and address. The desktop app also sends a telemetry event on every launch, checks GitHub for updates and fetches a tax catalogue.

## Outcome

On this fork nothing contacts the internet unless the owner switches it on.

1. A fresh install has FloCafe's own `offline_mode` setting on.
2. Finishing setup does not turn cloud sync on while offline mode is on, and does not register the install.
3. When the owner later turns offline mode off, the only features that start are ones the owner enabled. Turning offline mode off must not by itself start cloud registration or telemetry.
4. An existing database that already has these settings keeps its values. Use the existing "insert if missing" seeding; do not overwrite.

## Where to look

| What | Location |
| :--- | :--- |
| Install defaults | `seedInstallDefaults`, `main/db.ts:11211`; cloud keys at `11187-11189`; telemetry default near `11256` |
| Setup forces cloud sync on | `main/routes/auth.ts:1787`, written at `1875`, reload and registration at `1896-1906` |
| Offline mode | `main/services/offline-mode.ts`; settings route `main/routes/settings.ts:1879-1910` |
| What offline mode gates | `docs/architecture/cloud-integrations.md` |
| Existing tests to learn from | `tests/offline-mode.test.ts`, `tests/first-run-setup.test.ts`, the `cloud-*` tests |

## Tests to write first

One new file, `tests/pizza-offline-default.test.ts`, with a `test:pizza-offline-default` script chained into `"test"` in `package.json` (the `test:script-coverage` gate fails otherwise). Use the `assert*OrThrow` helpers. Each case must fail before your change and pass after.

1. A fresh database has `offline_mode` on.
2. Completing setup through the real setup route leaves cloud sync off, and no outbound request is attempted during install and setup. Record attempts by replacing `globalThis.fetch` and whatever socket client cloud sync uses, the way the existing cloud tests do. The registration endpoint must not be called.
3. After setup, switching offline mode off through the settings route still triggers no cloud registration and no telemetry send.
4. A database that already has `offline_mode`, `cloud_sync_enabled` and `telemetry_enabled` set keeps those values when the new code opens it.

## Constraints

- Smallest diff to upstream files. If an upstream test asserts the old defaults, change only the asserted value and list every such edit in your report.
- Update `docs/architecture/cloud-integrations.md` (and any other `docs/` page that states the old defaults) in the same change. Upstream's docs rules apply there: describe the present, no history, no plans.
- No new settings unless outcome 3 cannot be met without one. If you think one is needed, stop and report.
- Do not touch anything under `pizza/` except this brief.

## Verify before pushing

```sh
HOME=$(mktemp -d) npm run test:pizza-offline-default
HOME=$(mktemp -d) npm run test:offline-mode
npm run test:script-coverage
npx tsc --noEmit && npm run lint && npm run lint:budget
node scripts/ci/check-changed-format.cjs --base origin/main
npm run docs:check
python3 scripts/pizza/with-suite-lock.py env HOME=$(mktemp -d) node scripts/pizza/run-suite-report.cjs . <report folder outside the checkout>
```

The last command is the full core suite under the machine lock. Run it once at the end; another agent may hold the lock, in which case it waits. Do not run Playwright or `scripts/pizza/local-ci.sh`.

## Report

Branch and commit, the red-then-green output of the new test, the full-suite totals, every upstream test or doc you edited and why, and anything that still makes an outbound call with offline mode on.

# Baseline

Upstream's own install, build and test results at commit `b5928ec`, taken on our machines before any product change, so that a later failure can be told apart from one that was already there.

Reproduce the first two tables with `scripts/pizza/baseline.sh <checkout of that commit> <report folder> <tools folder>`. The tools folder is a copy of `scripts/pizza/` outside the checkout, because that commit does not contain it.

## MacBook Pro

macOS (Darwin 27.2.0, arm64), Node 22.23.1, npm 10.9.8. Run on 2026-11-25.

| Step | Command | Result | Time |
| :--- | :--- | :--- | :--- |
| Install | `npm ci` | pass | 12 s |
| Native rebuild | `npx @electron/rebuild -f -w better-sqlite3` | pass | 1 s |
| Frontend install | `npm --prefix frontend ci` | pass | 3 s |
| Typecheck | `npx tsc --noEmit` | pass | 1 s |
| Lint | `npm run lint` | pass (warnings only) | 1 s |
| Lint budget | `npm run lint:budget` | pass | 2 s |
| Build | `npm run build` | pass | under 1 s |
| Frontend build | `npm run build:frontend` | pass | 17 s |
| Full suite | every `test:*` suite named in `pretest` and `test`, one after another, with a throwaway `HOME` | **257 suites, 0 failed, 0 skipped** | 463 s |

Slowest suites: `test:dev-tooling` 44 s, `test:sequence` 24 s, `test:orders-search` 20 s, `test:diagnostics` 18 s, `test:phase7-setup-i18n` 14 s.

Install times are with a warm npm cache.

## Fedora

Fedora 45 (Linux 7.3.4, x86_64), Node 22.23.5 (nvm), npm 10.9.9. Run on 2026-11-25. Needs the system packages `gcc-c++`, `make` and `xorg-x11-server-Xvfb`; without `make`, `npm ci` fails while installing `better-sqlite3`.

| Step | Result | Time |
| :--- | :--- | :--- |
| Install | pass | 6 s |
| Native rebuild | pass | under 1 s |
| Frontend install | pass | 4 s |
| Typecheck | pass | 1 s |
| Lint | pass | 2 s |
| Lint budget | pass | 1 s |
| Build | pass | 1 s |
| Frontend build | pass | 27 s |
| Full suite (same command as the Mac) | **257 suites, 0 failed, 0 skipped** | 534 s |

## Browser suites

Run on the Mac on 2026-11-25 with `scripts/pizza/local-ci.sh`, on the first fork commit, which adds documents and tools to `b5928ec` and no product code.

| Suite | Result | Time |
| :--- | :--- | :--- |
| Release regression suites (`npm run test:release-regressions`) | pass | 30 s |
| Playwright, standard set | 405 passed, 1 flaky | 11.7 min |
| Playwright, tier 1 and tier 2 set | 71 passed | 2.9 min |

The flaky test passed on its retry: `e2e/server-app-ordering.spec.ts:364`, "double Send in the same tick creates only one order mutation".

## Native Electron suite

Run on Fedora on 2026-11-25 under Xvfb with `scripts/pizza/local-ci.sh`, on the first fork commit: 8 passed, 3 skipped, 36 s. The three skips are upstream's own in `title-bar.electron.spec.ts`: native maximize and minimize are not observable under Xvfb, and one geometry test is always skipped. The same run passed the core suite (257 suites) and both Playwright sets (405 passed and the same flaky test, 71 passed) on Fedora.

It does not run on the Mac: with a throwaway `HOME` the app asks macOS for a keychain that is not there.

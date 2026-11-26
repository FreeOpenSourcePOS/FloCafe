# Pizza fork

This repository is a fork of [FloCafe](https://github.com/FreeOpenSourcePOS/FloCafe) that adds a pizza-shop layer: a shared pizza core and a pizza mode for the POS. The shop's customer site is a separate project.

Everything specific to the fork's process lives in this folder. Upstream's `docs/` tree describes the running system and its checker rejects plans and decision notes, so they stay out of it.

| Page | What it holds |
| :--- | :--- |
| [plan.md](plan.md) | What is being built, the tests, the pull requests, how the work is run, the open questions |
| [contract.md](contract.md) | The menu format, function signatures, tables, and which lane owns which files |
| [decisions.md](decisions.md) | Design decisions and the spike evidence behind each |
| [gap-analysis.md](gap-analysis.md) | Every required feature marked as existing, needing a setting, partly there, or to build |
| [headless.md](headless.md) | Running the POS as a service on a Linux PC without Electron: install, health, backups, restore |
| [baseline.md](baseline.md) | Upstream's install, build and test results on our machines before any change |

## Where pizza code goes

| Code | Location |
| :--- | :--- |
| Pizza core (pure TypeScript) | `shared/pizza/` |
| Backend pizza code | `main/pizza/` |
| POS pizza screens | `frontend/src/components/pos/pizza/` |
| Pizza screen text (English only) | `frontend/src/lib/i18n/messages-pizza/en.json` |
| Tests | `tests/pizza-*.test.ts`, each with a `test:pizza-*` script chained into `npm test` |
| Fork tools | `scripts/pizza/` |

Upstream files get one-line hooks, not rewrites. A change to `main/db.ts`, `main/routes/orders.ts` or `frontend/src/app/(dashboard)/pos/page.tsx` that is longer than a few lines belongs in a new file.

## Rules for anyone working here, human or agent

1. Work in your own git worktree. Push a branch; the integration lane opens the pull request.
2. Write the failing test first.
3. Run tests and servers with a throwaway home directory: put `HOME=$(mktemp -d)` in front of the command.
4. **Do not finish the setup wizard on a build that does not have offline mode on.** Upstream's setup turns cloud sync on and sends the business name, owner name, email, phone and address to `blue.flopos.com`. See decision D13.
5. Never push to the `upstream` remote.
6. Database tests run through `node tests/run-electron-node-test.cjs tests/<file>.test.ts`; pure tests through `npx tsx --tsconfig tests/tsconfig.json -r ./tests/register-tsx.cjs tests/<file>.test.ts`.
7. Run the full suite only under the machine lock, and only when a gate calls for it:
   `python3 scripts/pizza/with-suite-lock.py node scripts/pizza/run-suite-report.cjs . <report folder>`.
   Unlike `npm test`, it does not stop at the first failure and it writes one result line and one log per suite.
8. GitHub Actions is not enabled on this fork. The checks of `.github/workflows/ci.yml` run on
   developer machines instead: `python3 scripts/pizza/with-suite-lock.py scripts/pizza/local-ci.sh <report folder> origin/main a`
   on the Mac and the same with `b` on Fedora (`all`, the default, runs everything on one machine).
9. Do not launch the Electron app or the native Electron tests on macOS with a throwaway home. The app
   asks macOS for a keychain that is not there, and a system dialog offers to reset the user's keychain.
   Those tests run on Linux under Xvfb; `local-ci.sh` skips them on macOS.
10. No real shop's name, address, phone number, items or prices in this repository. Tests and examples use
    `tests/fixtures/pizza-sample-menu.json`.
11. On Linux, run tests that start Electron or a browser with `DBUS_SESSION_BUS_ADDRESS=disabled:` and a
    private `XDG_RUNTIME_DIR`. Otherwise every launch registers a scope with the service manager of whoever
    is logged in. `local-ci.sh` and `baseline.sh` do this themselves.
12. Do not install the headless kit into a session someone is using. It was rehearsed twice on a developer's
    live session and both times that session's service manager stopped starting jobs. See
    [headless.md](headless.md).
13. If something fails, stop and report it with the output. No workarounds.

## Running the backend without Electron

```sh
npm run build && npm run build:frontend
HOME=$(mktemp -d) FLO_DEV_USER_DATA=<data folder> PORT=4311 KDS_PORT=4312 SERVER_APP_PORT=4313 node dev-server.js
curl http://127.0.0.1:4311/api/health
```

If a port is taken the server moves to the next one without failing, so read the bound port from its log. Daily backups, LAN HTTPS and mDNS do not start in this mode. To run it for a shop, use the headless kit in [headless.md](headless.md).

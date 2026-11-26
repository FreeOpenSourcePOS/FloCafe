# Brief: headless kit

Implements the headless kit named in decision D15 in [../decisions.md](../decisions.md). Read that entry and [../README.md](../README.md) first. The result is [../headless.md](../headless.md).

You are a coding agent on the Fedora machine. Do the work yourself; do not start subagents and do not open a pull request. This brief is complete: you cannot read files on any other machine.

## Repository

`Anmolnoor/pizza-pos` on GitHub, a fork of the open-source POS FloCafe (Electron + Express + better-sqlite3 backend in `main/`, Next.js frontend in `frontend/`, tests in `tests/`). A clone exists at `~/Developer/pizza-pos`. Do NOT work in that clone. Create your own worktree:

```sh
cd ~/Developer/pizza-pos && git fetch origin
git worktree add ../pizza-pos.worktrees/headless-kit -b feat/headless-kit origin/main
cd ../pizza-pos.worktrees/headless-kit
```

Node: use Node 22 through nvm (`source ~/.nvm/nvm.sh && nvm use 22`). Then `npm ci` and `npm --prefix frontend ci`.

Read first, in the worktree: `pizza/README.md` (the fork's rules; they bind you), decision D15 in `pizza/decisions.md`, `AGENTS.md`, `dev-server.js`, `main/standalone-startup.ts`, `docs/architecture/runtime-and-lifecycle.md`.

## Problem

The shop will run this POS headless on a small Linux PC next to the router: no monitor, no Electron, tablets on the LAN open it in a browser. The supported way to run the backend without Electron is `node dev-server.js` with the environment variables `PORT`, `KDS_PORT`, `SERVER_APP_PORT` and `FLO_DEV_USER_DATA` (after `npm run build` and `npm run build:frontend`). In that mode several things the desktop app does are missing: daily backups do not run, restoring a backup over HTTP needs a token from a native file dialog, and if a port is taken the server silently binds the next one. Nothing starts it at boot.

## Outcome

A "headless kit" in `scripts/pizza/headless/` plus an operator page `pizza/headless.md`, so that a Linux machine can run the POS as a service, back it up on a schedule, restore it, and prove it is healthy. No sudo anywhere: use `systemctl --user` units.

1. **Service.** A systemd user unit template that runs the server with fixed ports and a data folder, restarts on failure, and starts at boot (document `loginctl enable-linger`, do not run it). An install script that builds, writes the unit and an environment file, and enables it; an uninstall script that reverses it.
2. **Fixed-port check.** A health script that fails loudly when the API, KDS or Server App is not answering on its configured port (the server's silent move to the next port must be caught).
3. **Backups.** A script that takes a consistent copy of the SQLite database while the server is running (the database is in WAL mode: use SQLite's online backup, for example better-sqlite3's `backup()` from a small Node script, not a file copy), keeps the newest N copies, and a systemd user timer that runs it daily. The copy must pass the app's own health predicate for database files (find it in `main/db.ts`: `isHealthyDatabaseFile`).
4. **Restore.** A script and documented steps to restore a chosen backup with the service stopped, taking a safety copy of the current database first.
5. **Printing.** Prove whether plain network ESC/POS printing works in headless mode: with the server running headless, send a kitchen ticket to a loopback TCP socket that stands in for a network printer and check bytes arrive. If it does not work headless, do not fix it: report exactly where it fails.

## Tests to write first

Follow the repository's test pattern: files `tests/pizza-headless-*.test.ts`, each with a `test:pizza-headless-*` script in `package.json` chained into the `"test"` script (the `test:script-coverage` gate fails otherwise). Use the `assert*OrThrow` helpers from `tests/helpers/test-setup.ts`. Each case must fail before your change and pass after. Tests must use a temporary data folder, a throwaway `HOME`, and ports other than 3001–3003 that they choose free at run time; they must stop every process they start.

- Health check: passes against a running headless server; fails when one configured port is not the bound one (occupy the port first so the server moves on).
- Backup: taken while the server is running and writing; the copy opens, passes the health predicate, and contains a row written just before the backup; retention keeps N.
- Restore: after restoring an older backup, the row written after it is gone and the safety copy exists.
- Unit files: the generated unit and timer contain the configured ports, data folder and absolute Node path (text-level test; do not call systemctl in tests).
- Printing: the loopback printer receives a kitchen ticket from the headless server (or the test documents the failure you found, clearly marked, and you report it).

If the suite needs `dist/` built to start the server, look at how upstream tests that start a server do it (for example `tests/e2e-server.cjs`) and follow the same approach.

## Rehearsal on this machine

After the tests pass, rehearse for real once, as a user service, on ports 4311–4313 with a data folder under `~/.local/share/pizza-pos-rehearsal`: install, check health, take a backup, restore it, uninstall. Then remove the unit, the timer and the rehearsal data folder. Leave nothing running and nothing enabled. Paste the commands and their output into your report.

## Rules

- Tests first. Smallest change that works; no options nobody asked for.
- New code in new files. Do not edit upstream files except `package.json` (scripts) unless you must; if you must, keep it to a few lines and say why in the report.
- Run every test and server with a throwaway home: `HOME=$(mktemp -d)` in front of the command (keep PATH; for the systemd rehearsal use your real user session but a dedicated data folder).
- Never launch the Electron app or `npm run dev`. Do not run Playwright or `scripts/pizza/local-ci.sh`.
- The full core suite may be run once at the end, under the machine lock: `python3 scripts/pizza/with-suite-lock.py xvfb-run -a env HOME=$(mktemp -d) node scripts/pizza/run-suite-report.cjs . <report folder outside the checkout>`. Another run may hold the lock; it waits.
- No workarounds: if something cannot be done as written, stop and report what failed, with output.
- Commit in Conventional Commits style, ending each message with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Save this brief as `pizza/briefs/headless-kit.md` and commit it with the work.
- Before pushing: `npm run test:script-coverage`, `npx tsc --noEmit`, `npm run lint`, `npm run lint:budget`, `node scripts/ci/check-changed-format.cjs --base origin/main`, `npm run docs:check`.
- When done: `git push -u origin feat/headless-kit`. Never push to the `upstream` remote.

## Final message

Branch and commit SHA; red-then-green output of each new test; full-suite totals; the rehearsal transcript; what you found about headless printing; every upstream file you edited and why; anything not verified, stated as such.

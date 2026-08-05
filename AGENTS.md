# FloCafe agent guide

FloCafe is an Electron desktop POS. `main/` contains the Electron process, Express API, SQLite access, printing, and services. `frontend/` is a statically exported Next.js and React application. `tests/` contains backend, integration, and release checks.

## Runtime and layout

- Electron 43 runs the desktop application.
- The main API and WebSocket server use port 3001 by default.
- The standalone kitchen-display server uses port 3002 by default (`KDS_PORT` can change it).
- SQLite uses better-sqlite3 in WAL mode. Schema versioning uses `PRAGMA user_version`.
- The renderer uses Next.js 16, React 19, Zustand, Tailwind CSS, and shadcn/ui.
- `frontend/` is part of this repository, not a submodule.

## Commands

Node.js 22 or later is required.

```sh
npm run dev              # full Electron app
node dev-server.js       # backend only
npm run dev:frontend     # frontend browser server
npm run lint             # backend and frontend lint
npm run build            # compile main/ to dist/
npm run build:frontend   # static frontend export
npm test                 # default test suite
npm run test:product-images
npm run test:url-allowlist
npm run audit:db
```

`npm run build:linux` produces AppImage, `.deb`, `.rpm`, and Snap packages. `npm run build:appx` produces the Windows Store AppX package; it passes `--config.npmRebuild=false` to skip native recompilation because `better-sqlite3` uses N-API (ABI-stable) and does not need to be rebuilt per Electron version. If a non-N-API native module is ever added, remove that flag and ensure a Visual Studio C++ toolchain is available in the build environment. `npm run dev:restart` and `npm run dev:reset` are Unix development recovery commands; reset requires confirmation.

## Data safety

Customer data must survive upgrades. Add a new migration version for schema changes, preserve existing data, and test both fresh and upgraded databases. Destructive schema work requires a data-preservation plan, an upgrade-path test, and maintainer review.

Do not add the private `specs` repository as a submodule, build dependency, CI dependency, or runtime dependency. Never commit credentials, API keys, internal URLs, customer data, backups, or `.env` files.

## Working conventions

Inspect the existing implementation before changing it. Reuse established patterns and keep the diff focused. Use `fix/`, `feat/`, `docs/`, `test/`, `refactor/`, or `chore/` branch prefixes when creating a branch. Do not commit, tag, release, or push unless asked.

For database, import/export, authentication, printing, or release changes, identify the affected tests before implementation. Do not bypass platform security checks to make a local development binary run.

## Verification

Choose checks that cover the change:

| Change | Minimum verification |
| --- | --- |
| Documentation | Link check and `git diff --check` |
| Frontend | `npm run lint` and `npm run build:frontend` |
| Main process or API | `npm run lint`, `npm run build`, and focused tests |
| Database migration | Fresh and upgrade-path tests; verify backup and restore when relevant |
| Release or cross-platform packaging | Full test suite and target platform builds |

Run `npm test` for a full validation request, before a release, or when the change crosses several subsystems. Add focused suites not included by `npm test` when they cover the changed behavior.

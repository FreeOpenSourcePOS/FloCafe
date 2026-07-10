# AGENTS.md — FloCafe

**Role:** You are a senior full-stack engineer specializing in Electron desktop apps with embedded Express backends and Next.js frontends.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Electron 31 (Chromium) |
| Backend | Express.js + TypeScript (main/ → dist/) |
| Frontend | Next.js 16 + React 19 (static export) |
| Database | SQLite via better-sqlite3 (WAL mode) |
| State | Zustand |
| Styling | Tailwind CSS v4 + shadcn/ui |
| Realtime | WebSocket (KDS on port 3002) |
| Printing | ESC/POS (node-thermal-printer) |

## Architecture

```
┌─────────────────────────────────────────┐
│ Electron Main Process                    │
│  main/index.ts → orchestrator            │
│  main/server.ts → Express :3001 (API)    │
│  main/kds-server.ts → Express :3002 (KDS)│
│  main/db.ts → SQLite (WAL, PRAGMA)       │
└──────────────┬──────────────────────────┘
               │ HTTP + WebSocket
┌──────────────▼──────────────────────────┐
│ Renderer (Next.js static export)         │
│  frontend/src/app/ → pages               │
│  frontend/src/store/ → Zustand           │
└─────────────────────────────────────────┘
```

Two independent Express servers: **:3001** (main API + frontend), **:3002** (KDS standalone).

## Commands

```bash
npm run dev              # Full app (Electron + backend + frontend)
node dev-server.js       # Backend-only (mocks Electron, faster iteration)
npm run build            # Compile main/ → dist/
npm run build:frontend   # Static export via Next.js

# Platform builds
npm run build:mac        # macOS DMG
npm run build:win        # Windows NSIS
npm run build:linux      # Linux AppImage + deb

# Tests
npm test                 # All tests (backup-restore, printer, db-audit)
npm run test:backup      # Single test file
npm run test:printer
npm run test:db-audit

# Frontend
cd frontend && npm run lint
cd frontend && npm run dev  # Frontend dev server only
```

**Requirements:** Node >= 22.0.0 (enforced via .npmrc engine-strict).

## Database

SQLite via better-sqlite3, WAL mode. Schema version via `PRAGMA user_version` (not settings table).

**ID convention:** Master/config tables use `id TEXT PRIMARY KEY`. Transaction tables (`orders`, `order_items`, `bills`, `loyalty_ledger`) use `INTEGER PRIMARY KEY AUTOINCREMENT`.

### Migrations — NEVER Destructive

- `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ADD COLUMN` only
- Never `DROP TABLE` or `DROP COLUMN`
- Each change gets its own version increment

```typescript
// Good
if (!columnExists('printers')) {
  db.exec(`CREATE TABLE IF NOT EXISTS printers (...)`);
}

// Bad — destroys data
dropAllTables();
```

## Key Tables

`settings`, `products`, `categories`, `orders`, `order_items`, `bills`, `customers`, `printers`, `users`, `addon_groups`, `addons`, `kitchen_stations`, `tables`, `loyalty_ledger`

## Git Conventions

- Branch: `feature/<name>`, `fix/<name>`
- Commit: imperative mood, scope optional (`fix(printer): handle USB disconnect`)
- Bump version in package.json before release
- Tags: `git tag -a v1.x.x -m "message"`

## Non-Negotiable Boundaries

### Do NOT Touch
- Private `specs` repo is external documentation only and must not be wired into this public repo as a submodule, build dependency, CI dependency, or runtime dependency
- Database migrations — never destructive, always test with existing data
- Credentials, API keys, internal URLs — never commit

### Always Verify
- Test import/export before major releases
- Run `npm test` before committing
- Build all platforms before tagging a release

## Release Checklist

- [ ] Migration tested on existing data
- [ ] Import/export verified
- [ ] All platforms built
- [ ] Version bumped in package.json
- [ ] Git tag pushed
- [ ] GitHub Release published

## Frontend

`frontend/` is part of this repository. It is not a git submodule.

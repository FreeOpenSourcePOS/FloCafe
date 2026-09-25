# FloCafe agent guide

FloCafe is an open-source, offline-first Electron desktop POS.

## Orientation & layout

- **Main process (`main/`):** Electron lifecycle and IPC (`main/index.ts`), Express API on `:3001` (`main/server.ts`), standalone KDS server on `:3002` (`main/kds.ts`), Server App on `:3003` (`main/server-app.ts`), SQLite database access via `better-sqlite3`, ESC/POS printing, and background services.
- **Frontend (`frontend/src/`):** Next.js 16 and React 19 application (statically exported via `output: 'export'` when `NEXT_BUILD_MODE=desktop`, or standard server runtime when unset), Zustand state, UI components, and translations.
- **Tests (`tests/`):** Backend unit, integration, and release test suites.
- **Documentation (`docs/`):** Current-system architecture, contracts, and developer/maintainer procedures (see [docs/README.md](docs/README.md)).
- **Workflows (`.github/`):** Issue/PR templates, CODEOWNERS, and CI/CD workflows.

## Documentation

`docs/` describes the current supported system: architecture, contracts, invariants, developer
workflows, and maintainer workflows. It does not preserve development history. Plans, research
notes, audits, PR handoffs, verification transcripts, and future proposals belong in issues, specs,
or PRs.

- Update the existing canonical page. Create a new page only when no current page owns the subject.
- Replace stale text; do not append corrections, date sections, or phase notes. Remove superseded
  material in the same change.
- Verify every behavioral claim against current code, tests, or configuration before writing it.
  When code and documentation disagree, investigate and fix the documentation.
- Keep the detailed documentation-authoring rules in [DOCUMENTATION.md](DOCUMENTATION.md). They
  apply to agents and human contributors alike.

Source-of-truth order: current runtime code; current tests and executable contracts; explicit
product decisions ([`docs/reference/product-invariants.md`](docs/reference/product-invariants.md));
repository configuration and workflows; existing documentation, as research material only.

**Conflict precedence:** the approved task defines the intended change; current code and tests
define existing behavior; the core invariants below and
[`docs/reference/product-invariants.md`](docs/reference/product-invariants.md) define boundaries the
implementation must not violate.

## Core invariants

1. **Offline-first operation:** Core POS operation (orders, billing, KDS, printing) must function without internet connectivity. Optional network features (Google Drive, WhatsApp, cloud reporting) run only when explicitly configured and must fail gracefully when offline.
2. **Data safety:** Existing customer data must survive upgrades. Never reset, truncate, or drop user databases as a shortcut for migration design.
3. **Architecture boundaries:** UI language, tenant regional settings, and tax/compliance behavior are separate, decoupled domains.
4. **Business timestamps:** Persisted timestamps follow FloCafe's canonical storage conventions; configured store timezone applies to business-local presentation, day/shift boundaries, and reporting intervals.
5. **Backend authority:** Security-critical, payment, and tax calculations remain backend-authoritative.
6. **Orders are never ownership-gated:** FloCafe is an open system for order visibility — any staff role with order access can see and act on any order, regardless of who created it. Authorization is restricted by role (page/feature access) and by specific action (e.g. KDS stage transitions are chef/manager/owner-only, narrowed further by station/category assignment), never by comparing `order.user_id`/item creator against the current user. Accountability comes from audit attribution (every write is recorded against the authenticated actor), not from hiding orders between staff. Do not add or reintroduce a `role === 'server' && order.user_id !== user.userId`-style check anywhere in the backend; see `docs/reference/product-invariants.md` and [`docs/reference/roles-and-permissions.md`](docs/reference/roles-and-permissions.md).
7. **Reuse before adding:** Reuse existing helpers, utilities, and dependencies before introducing new packages.
8. **Scope discipline:** Implement only the approved task. Do not make opportunistic refactors across unrelated files.

## Sharp edges & operational rules

- **Desktop static export boundary:** When building for desktop (`NEXT_BUILD_MODE=desktop`), `frontend/` is exported as static HTML/CSS/JS (`output: 'export'`). In desktop mode, there is no runtime Next.js server-side execution, Next.js API routes, or server cookies; all dynamic backend logic belongs in Express (`:3001`) or Electron IPC. Standard Next.js server runtime (`next start`) applies only when `NEXT_BUILD_MODE` is unset (cloud mode).
- **Port contention on dev/test:** Daemons hold ports `:3001` (API), `:3002` (KDS), and `:3003` (Server App). If commands fail with `EADDRINUSE`, run `npm run clean` (`node kill-ports.js 3001 3002 3003`) to clear them before proceeding.
- **Playwright configuration context:** End-to-end tests live inside `frontend/`. Running `npx playwright test` directly from root fails because `playwright.config.ts` is in `frontend/`. Use `npm run test:e2e:browser` from root or run Playwright from within `frontend/`.
- **Match compatibility effort to demonstrated migration risk:** Do not add multi-layer compatibility state solely to preserve minor legacy behavior without evidence that users depend on it. Prefer simple, reconfigurable defaults when the migration impact is small. If compatibility requires substantial state or branching, stop and confirm the tradeoff first.
- **Review quota & push batching:** CodeRabbit and Greptile have hourly review limits. Batch all outstanding review fixes into a single verified push rather than pushing once per finding. After a second automated-review finding on code you just patched, stop and reconsider the design before patching a third time.
- **No unapproved mutations:** Do not create, edit, close, label, or assign GitHub issues or PRs unless explicitly instructed. Do not commit, tag, push, merge, or enable auto-merge without explicit instruction. Ambiguous future-state wording such as "once green it will merge" is not authorization to perform the action.
- **Secrets & data protection:** Never commit credentials, API keys, `.env` files, customer data, backups, internal URLs, or private tokens.
- **Private specs boundary:** Never add the private `specs` repository as a submodule, build dependency, CI dependency, or runtime dependency.
- **Security checks:** Do not bypass platform or OS security checks merely to make a local development binary run.
- **Legacy code check:** Before modifying legacy-looking files, verify they are part of the active build, import, or packaging path (search imports, routes, and `package.json`).
- **Discovered issues:** Note adjacent bugs or potential improvements in your report rather than expanding implementation scope.
- **Changelog & commit governance:** Use Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `ci:`). Release notes and `CHANGELOG.md` are automated via `git-cliff` (`npm run changelog`) and CI; do not manually draft changelogs.
- **Code comments:** Code should be self-explanatory; write comments only when strictly necessary to explain non-obvious intent or rationale. Keep comments concise (1-2 lines maximum), and avoid historical tags (PR/issue numbers, phases) or redundant descriptions of what the code is doing.
- **Dependencies:** Evaluate built-in Node/Electron/browser APIs and existing project packages before proposing new dependencies.

## Commands

FloCafe requires **Node.js 22 or later**.

```sh
npm run clean            # Kill processes holding ports 3001, 3002, 3003
npm run dev              # Full Electron app (cleans ports, builds frontend & backend)
node dev-server.js       # Backend only (Express API on :3001, KDS on :3002, Server App on :3003)
npm run dev:frontend     # Frontend browser development server
npm run lint             # Lint backend (main/) and frontend (frontend/)
npm run build            # Compile TypeScript backend to dist/
npm run build:frontend   # Build and export static Next.js frontend
npm test                 # Run standard test suite
npm run test:url-allowlist
npm run audit:db
npm run i18n:check
npm run docs:check      # Markdown lint, relative links, index completeness, doc policy
npm run test:e2e:browser # E2E tests (runs Playwright from frontend/)
npm run i18n:add -- de   # scaffold an approved new language locally
```

## Verification

Before reporting completion, run every applicable minimum check below for implementation work and executable code reviews. Do not substitute manual inspection, transpilation, or a narrower check for a listed command; if a check cannot run, report it as not run and disclose why.

| Change type | Minimum verification |
| --- | --- |
| Documentation / templates | `npm run docs:check` and `git diff --check` |
| Frontend | `npm run lint` and `npm run build:frontend` |
| Translations / i18n | `npm run i18n:check` |
| Backend / API | `npm run lint`, `npm run build`, and focused test suites |
| Database migrations | Fresh database test and upgrade-path migration test |
| E2E / Browser flows | `npm run test:e2e:browser` |
| Tax / Auth / Security | Relevant focused test suite plus broader integration tests |
| Packaging / Releases | Target platform build commands and release checks |

Run `npm test` when a full validation pass is requested, before releases, or when changes touch multiple core subsystems.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

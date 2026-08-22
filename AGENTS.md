# FloCafe agent guide

FloCafe is an open-source, offline-first Electron desktop POS. `main/` contains the Electron main process, Express API (`:3001`), standalone KDS server (`:3002`), SQLite database, printing, and background services. `frontend/` is a statically exported Next.js 16 and React 19 application. `tests/` contains backend, integration, and release test suites.

## Progressive disclosure

Before starting non-trivial work:

1. **Understand task scope:** Read the task and any linked issue/PR, then identify scope and acceptance criteria.
2. **Consult documentation index:** Check [docs/README.md](docs/README.md) to locate relevant `CURRENT` or `ACTIVE DESIGN` documents.
3. **Inspect current code:** Verify active runtime paths and existing patterns.
4. **Identify tests:** Locate existing test coverage in `tests/`.
5. **Plan and execute:** Keep changes focused on the approved task.

For minor typos or isolated one-line edits, formal planning is not required.

## Source of truth

- **Current runtime behavior:** Current code and automated tests define what FloCafe does today.
- **Intended change:** The approved task description, issue, or PR defines what the specific change must achieve.
- **Project invariants:** This document (`AGENTS.md`) and documentation marked `CURRENT` define project-wide boundaries.
- **Active design:** Documents marked `ACTIVE DESIGN` or `FORWARD-LOOKING` in `docs/` describe target architecture and may be ahead of current code.
- **Historical records:** Docs marked `HISTORICAL` provide context only.

If a task or design doc contradicts current code or references files that no longer exist, investigate and report the discrepancy rather than inventing unapproved architecture.

## Repository layout

```text
main/           Electron main process, Express API, SQLite access, ESC/POS printing, and services
shared/         Neutral pure kernel code (shared/print: print language policy, direction, bilingual labels). No IO, no imports from main/ or frontend/ — see shared/print/README.md
frontend/src/   Next.js/React renderer, Zustand state, UI components, and translations
tests/          Backend unit, integration, and release test suites
docs/           Documentation, design specifications, and audits (see docs/README.md)
.github/        Issue/PR templates, CODEOWNERS, and CI/CD workflows
```

## Core invariants

1. **Offline-first operation:** Core POS operation (orders, billing, KDS, printing) must function without internet connectivity. Optional network features (Google Drive, WhatsApp, cloud reporting) run only when explicitly configured and must fail gracefully when offline.
2. **Data safety:** Existing customer data must survive upgrades. Never reset, truncate, or drop user databases as a shortcut for migration design.
3. **Architecture boundaries:** UI language, tenant regional settings, and tax/compliance behavior are separate, decoupled domains.
4. **Business timestamps:** Persisted timestamps follow FloCafe's canonical storage conventions; configured store timezone applies to business-local presentation, day/shift boundaries, and reporting intervals.
5. **Backend authority:** Security-critical, payment, and tax calculations remain backend-authoritative.
6. **Reuse before adding:** Reuse existing helpers, utilities, and dependencies before introducing new packages.
7. **Scope discipline:** Implement only the approved task. Do not make opportunistic refactors across unrelated files.

## Working conventions & safety rules

- **Secrets & data protection:** Never commit credentials, API keys, `.env` files, customer data, backups, internal URLs, or private tokens.
- **Private specs boundary:** Never add the private `specs` repository as a submodule, build dependency, CI dependency, or runtime dependency.
- **Security checks:** Do not bypass platform or OS security checks merely to make a local development binary run.
- **Legacy code check:** Before modifying legacy-looking files, verify they are part of the active build, import, or packaging path (search imports, routes, and `package.json`).
- **Discovered issues:** If you encounter an adjacent bug or potential improvement during a task, note it in your report rather than expanding implementation scope.
- **No unapproved mutations:** Do not create, edit, close, label, or assign GitHub issues or pull requests unless the task specifically instructs issue maintenance. Do not commit, tag, or push without instruction.
- **Dependencies:** Evaluate built-in Node/Electron/browser APIs and existing project packages before proposing new dependencies.

## Commands

FloCafe requires **Node.js 22 or later**.

```sh
npm run dev              # Full Electron app (cleans ports, builds frontend & backend)
node dev-server.js       # Backend only (Express API on :3001, KDS on :3002)
npm run dev:frontend     # Frontend browser development server
npm run lint             # Lint backend (main/) and frontend (frontend/)
npm run build            # Compile TypeScript backend to dist/
npm run build:frontend   # Build and export static Next.js frontend
npm test                 # Run standard test suite
npm run test:url-allowlist
npm run audit:db
npm run i18n:check
npm run i18n:add -- de   # scaffold an approved new language locally
```

## Verification

Select checks that cover the changed subsystem:

| Change type | Minimum verification |
| --- | --- |
| Documentation / templates | `git diff --check` and relative markdown link verification |
| Frontend | `npm run lint` and `npm run build:frontend` |
| Translations / i18n | `npm run i18n:check` |
| Backend / API | `npm run lint`, `npm run build`, and focused test suites |
| Database migrations | Fresh database test and upgrade-path migration test |
| Tax / Auth / Security | Relevant focused test suite plus broader integration tests |
| Packaging / Releases | Target platform build commands and release checks |

Run `npm test` when a full validation pass is requested, before releases, or when changes touch multiple core subsystems.

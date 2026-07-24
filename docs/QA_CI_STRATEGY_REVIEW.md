# FloCafe Whole-App CI/CD and QA Strategy
*Date: July 2026*
*Context: Transitioning from a KDS-focused regression response to a whole-app tiered safety net.*

---

## 1. The Core Philosophy: Tiered Safety Net
Instead of running every test on every platform for every PR, we build a tiered safety net for every product boundary. KDS is just one representative contract area alongside primary API, SQLite migrations, realtime events, frontend workflows, Electron lifecycle, printing, and release packaging.

**Every PR gets:** A reliable Linux baseline + tests selected by changed area.
**Every Merge/Nightly gets:** Full cross-platform validation and broader browser coverage.

---

## 2. Required PR Gate
Every PR must pass the following Linux baseline:
- Dependency install
- TypeScript compilation check (`tsc --noEmit`)
- Backend & Frontend linting
- Production frontend build
- Linux full existing test suite (`npm test`)
- **Application Smoke Test**: Starts a fresh SQLite instance along with both real services (`:3001` main API and `:3002` standalone KDS). It verifies health, auth, route registration, and critical read/write paths using production middleware.

### Change-to-Suite Map (Path Filtering)
We use `dorny/paths-filter` to dynamically run specific suites:
- `main/db.ts`, migrations → **Database Contracts** (fresh-schema + upgrade-snapshot)
- `main/routes/**` → **Main API Contracts** + Smoke
- `main/kds-server.ts`, KDS services → **KDS/Realtime Contracts**
- `frontend/**` → **Playwright E2E** & Layout-integrity checks

---

## 3. Contract Coverage by Subsystem

### A. Database
Verify a clean database and historical upgrade fixtures produce required tables, columns, defaults, indexes, and invariants. Exercise changed SQL through real endpoints (no brittle regex SQL parsing).

### B. Main API
Maintain endpoint-level contracts for auth, roles, product reads, order lifecycle, payments, settings, customers, and backups.

### C. KDS & Realtime
Boot the real KDS service. Validate login/session restore, role denial, WebSocket authentication, item status broadcasts, and order mutation broadcasts. *This explicitly catches regressions like the PR #118 failure.*

### D. Frontend (Playwright)
Playwright tests run against static frontend output plus real test servers.
Initial journeys: Setup/login, POS order-to-payment, table updates, KDS workflow, settings persistence, and backup/restore.

### E. Layout Integrity
Test stable usability properties rather than visual snapshots during rapid UI iteration.
Examples: Visible interactive controls, panel overflow, modal reachability, and **44px POS touch targets**.

### F. Electron & Packaging
- PRs: Fast Linux checks.
- Merges/Nightly/Releases: macOS/Windows packaging matrix + Linux Electron startup smoke under Xvfb to verify packaged main-process initialization.

---

## 4. Workflow Design and Security
- **Concurrency**: Automatically cancel stale PR runs.
- **Security**: Apply least-privilege permissions, full-SHA action pins, and job timeouts.
- **Dependency Review**: Gated on PRs to block newly introduced high/critical vulnerabilities.
- **Skip Expensive Work**: Docs-only PRs skip expensive CI runs.

---

## 5. Rollout and Acceptance
1. Establish baseline timing/flakiness for the Linux test suite.
2. Add process-level dual-server smoke (`tests/smoke-test.test.ts`) + database upgrade contracts.
3. Add subsystem contracts for KDS (`tests/kds-integration.test.ts`).
4. Add Playwright critical journeys (`e2e/kds-login.spec.ts`, `e2e/layout-integrity.spec.ts`).
5. Move full platform/browser checks to scheduled and pre-release gates (`.github/workflows/nightly-release.yml`).

# FloCafe Code Review Rules

See [AGENTS.md](../AGENTS.md) and [docs/reference/product-invariants.md](../docs/reference/product-invariants.md) for canonical invariants and architectural definitions.

## 1. Orders Are Never Ownership-Gated

FloCafe is an open system for order visibility. Any staff role with order access can view and act on any order, regardless of who created it.

- **Never gate orders by creator:** Do not check `order.user_id !== user.userId` or `role === 'server' && order.user_id !== ...`.
- Order attribution (`user_id`, `created_by`) is solely for audit logging, never for access control.
- Access restrictions must only come from role page access and specific action permissions (e.g. KDS stage transitions require `kitchen.status.update`).

## 2. Configurable Permissions, No Hardcoded Roles

Staff permissions are owner-configurable via permission overrides.

- Use `requirePermission` or `requireAnyPermission` middleware for feature and endpoint access.
- **Do not introduce `requireRole(...)` runtime gates.** Check the specific permission capability instead of matching against a role string.

## 3. Offline-First Operation

Core POS operations (order placement, billing, payments, KDS dispatch, receipt printing) must work completely offline without internet connectivity.

- Optional external network integrations (Google Drive, WhatsApp, cloud reporting) must degrade gracefully when offline without throwing unhandled exceptions or blocking core POS workflows.

## 4. Desktop Static Export Boundary

When running in desktop mode (`NEXT_BUILD_MODE=desktop`), the Next.js frontend is built as a static export (`output: 'export'`).

- `frontend/` cannot rely on runtime Next.js server-side execution, Next.js server API routes, or server cookies.
- All dynamic backend logic, database queries, and hardware communication belong in Express API (`main/server.ts`, `:3001`), standalone KDS server (`:3002`), Server App (`:3003`), or Electron IPC (`main/index.ts`).

## 5. Data Safety & Migrations

FloCafe stores customer business data in SQLite via `better-sqlite3`.

- Upgrades must never lose customer data. Never drop, truncate, or reset SQLite database tables in migrations or runtime code.
- Migrations must be forward-compatible, safe, and testable on upgrade paths.

## 6. Backend Authority

Financial calculations, discounts, payment records, taxes, and security decisions must always be backend-authoritative.

- Never trust client-submitted calculations without backend verification.

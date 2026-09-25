# Configurable roles and user permissions

**Status: IMPLEMENTED DESIGN RECORD**

This document records the scope, architecture, rollout, and verification plan used to replace FloCafe's fixed role gates with owner-configurable permissions. For the concise current runtime contract, see [`roles-and-permissions.md`](roles-and-permissions.md); the application code and automated tests remain authoritative.

## 1. Objective

An owner must be able to:

1. Change the default permissions attached to each existing staff role.
2. Grant or deny individual permissions for a specific user without changing that user's role.
3. See the user's effective permissions and whether each permission comes from the role template or a user override.
4. Restore either a role permission or a user permission to the shipped default.
5. Review an audit trail of permission changes.

The backend must remain the authority. Hiding a navigation item or button is only a usability feature; every protected API, KDS action, Server App action, and WebSocket mutation must check the effective permission at execution time.

The migration must preserve every existing installation's effective access. Immediately after upgrade, before an owner changes anything, every role must be able to do exactly what it can do today.

## 2. Recommended product boundary

### 2.1 First release

Keep the five role identities (`owner`, `manager`, `cashier`, `server`, and `chef`) and make their permission templates editable. Add per-user overrides on top of those templates.

This gives owners both useful levels of control:

- Edit a role template when every cashier or every server should gain or lose a capability.
- Edit one user's overrides for exceptions such as a senior cashier who may view reports.

The effective decision for an ordinary permission is:

```text
protected product rule, if any
  otherwise explicit user allow/deny override, if present
  otherwise configured role allow/deny override, if present
  otherwise shipped default for that role
```

An explicit user deny wins over a role allow, and an explicit user allow wins over a role deny. Deleting the user override returns the user to the role template. Deleting the role override returns that role to the shipped default.

### 2.2 Deferred scope

Do not add custom role creation, role deletion, role renaming, multiple roles per user, permission expiry, schedules, branch-level scope, remote/cloud IAM, or field-level data masking in the first release.

The current role names are also policy identities, not merely permission bundles:

- `owner` participates in last-owner protection, initial setup, recovery, Master PIN operations, and late-refund approval.
- `manager` participates in the current refund approval policy.
- `chef` activates kitchen station/category scoping.
- `server` and `chef` identify purpose-built Server App and KDS workflows.

Custom roles should be a later design that first separates those policy attributes from the role string. Treating arbitrary custom names as equivalent today would make those workflows ambiguous.

### 2.3 Terminology

- **Role:** one of the five existing staff identities.
- **Permission:** a stable, code-defined capability ID such as `reports.view`.
- **Shipped default:** the current allowed-role matrix encoded in source control.
- **Role override:** a store-local change to a shipped role default.
- **User override:** an explicit `allow` or `deny` for one user.
- **Effective permissions:** the final set after defaults, overrides, and protected rules are applied.
- **Context policy:** a non-IAM condition such as KDS station scope, feature enablement, order state, approval PIN, business-day cutoff, or Master PIN.

## 3. Non-negotiable security and business rules

Configurable permissions do not replace the following rules.

1. **Orders remain open across staff.** A user with the relevant order permission can act on every order; authorization must never compare `order.user_id` with the current user. Attribution stays in the audit log.
2. **The backend decides.** All clients may use permissions to shape the UI, but API and WebSocket checks are mandatory.
3. **Permission administration is owner-only and non-delegable in v1.** Every active owner always has `authorization.manage`; no non-owner may receive it, and it cannot be denied from an owner. This prevents an owner from accidentally leaving the store with nobody able to repair access.
4. **Owner account lifecycle remains protected.** Only an owner may create, promote, demote, deactivate, or reactivate an owner. The last active owner cannot be demoted or deactivated.
5. **Managing operational accounts and managing privileged accounts are different permissions.** `staff.operational.manage` covers cashier/server/chef accounts. `staff.privileged.manage` is a protected owner capability for owner/manager accounts.
6. **A permission never bypasses a second factor.** Master PIN and Staff Approval PIN checks still apply after the permission check.
7. **Refund approval policy remains distinct.** `refunds.initiate` controls who may start a refund, but the selected approver, one-hour owner/manager tier, same-business-day owner-only tier, and cutoff remain as documented in [`business-decisions.md`](business-decisions.md). Changing approver eligibility requires a separate product decision.
8. **KDS scope remains an additional restriction.** `kitchen.use` or `kitchen.status.update` does not bypass station/category assignments. The existing fail-closed behavior when station scope cannot be loaded remains.
9. **Feature flags remain additional restrictions.** A grant does not enable KDS, tables, WhatsApp, loyalty, cloud, or another disabled feature.
10. **Inactive users remain denied.** Permission grants do not make a deactivated account usable.
11. **Unknown permission IDs fail closed.** They are rejected by management APIs and never authorize runtime actions.
12. **Offline-first behavior is preserved.** Permission resolution uses the local SQLite database and never depends on FloAdmin or another network service.

Before implementation, add a new entry to [`business-decisions.md`](business-decisions.md) recording these boundaries and amend the refunds entry that currently says per-role grants do not exist.

## 4. Current-state inventory

The existing implementation is centralized enough to provide a starting catalog, but not centralized enough to make permissions configurable by changing one file.

- [`../shared/role-permissions.ts`](../shared/role-permissions.ts) defines five roles, named role groups, and 46 display capabilities.
- Backend routes currently contain 223 `requireRole(...)` call sites across 29 files.
- [`../main/middleware/security.ts`](../main/middleware/security.ts) refreshes the user's active state and current role, then `requireRole` compares the role string.
- [`../main/server.ts`](../main/server.ts), [`../main/kds-server.ts`](../main/kds-server.ts), and [`../main/server-app.ts`](../main/server-app.ts) have separate authentication/enforcement paths.
- KDS REST, KDS WebSockets, station/category filtering, and Server App login contain direct role decisions outside ordinary Express route middleware.
- [`../main/routes/staff.ts`](../main/routes/staff.ts) has target-account rules, PIN rules, role changes, and last-owner protection that must not be reduced to a generic permission check.
- Refund eligibility and approval include role-specific policy in [`../main/services/refund.ts`](../main/services/refund.ts), [`../main/routes/refunds.ts`](../main/routes/refunds.ts), and the refund UI.
- Frontend navigation and actions use both `ROLE_ACCESS`/`hasRole` and direct comparisons. The current matrix is read-only.
- The tenant snapshot in [`../main/routes/auth.ts`](../main/routes/auth.ts) carries a role but no effective permission set. The Zustand auth store persists that snapshot in local storage.
- Some authenticated read routes have no local `requireRole` because global authentication is their only current gate. These routes still need an explicit permission decision during the migration.
- Existing tests such as [`../tests/authz-matrix-phase3.test.ts`](../tests/authz-matrix-phase3.test.ts), [`../tests/staff-authz.test.ts`](../tests/staff-authz.test.ts), KDS tests, Server App tests, refund tests, and order authorization tests encode current role behavior.

The implementation must inventory direct role comparisons as well as `requireRole`. A search for only middleware calls will miss security decisions.

## 5. Permission model

### 5.1 Code-defined catalog

Permission identity and metadata should remain code-defined in a new shared module, for example `shared/permissions.ts`. The database stores only store-local overrides and audit history.

Each catalog entry should include:

```ts
type PermissionDefinition = {
  id: PermissionId;
  area: PermissionArea;
  labelKey: string;
  descriptionKey: string;
  defaultRoles: readonly Role[];
  configurable: boolean;
  risk: 'standard' | 'sensitive' | 'destructive';
};
```

Requirements for the registry:

- Permission IDs are stable persistence keys and must never be silently repurposed.
- Labels and descriptions are translated presentation metadata, not authorization inputs.
- Shipped defaults reproduce current behavior.
- `configurable: false` identifies the small protected set such as `authorization.manage` and `staff.privileged.manage`.
- Removed IDs need an explicit migration/cleanup decision; they must not be reused for a different meaning.
- The shared module must be browser-safe. Database resolution belongs in `main/services/authorization.ts`, not in shared code.

### 5.2 Proposed v1 catalog

The exact route-to-permission manifest must be reviewed during implementation. The following catalog is the proposed product surface. It deliberately exposes business capabilities rather than one toggle per endpoint.

| Area | Permission ID | Meaning | Shipped default | Notes |
| --- | --- | --- | --- | --- |
| Orders | `pos.use` | Open and use the main POS terminal | owner, manager, cashier | UI/workflow access; APIs also check their operation permissions |
| Orders | `orders.read` | List and view all orders | owner, manager, cashier, server | Never ownership-gated |
| Orders | `orders.create` | Create orders and append items | owner, manager, cashier, server | Includes required catalog reads |
| Orders | `orders.status.update` | Perform permitted order status transitions | all roles | State/PIN rules still apply |
| Orders | `orders.customer.update` | Attach/change an order customer | owner, manager | |
| Orders | `orders.discount.apply` | Apply order and item discounts | owner, manager, cashier | Existing approval behavior remains |
| Orders | `orders.item.cancel` | Cancel pending items | owner, manager | State rules remain |
| Orders | `orders.item.void` | Request or perform prepared/in-progress item voids | owner, manager, cashier, server | Approval PIN remains required; only PIN-bearing eligible approvers can approve |
| Orders | `orders.item.restore` | Restore cancelled items | owner, manager | |
| Orders | `held-orders.manage` | Create, view, and delete held orders | owner, manager, cashier, server | |
| Tables | `tables.view` | View floors and tables | roles that need POS/Server App table data | Feature flag still applies |
| Tables | `tables.manage` | Create, edit, position, and deactivate tables/floors | owner, manager | |
| Tables | `tables.orders.move` | Move an order between tables | owner, manager, cashier, server | |
| Payments | `bills.read` | View bills and print history | owner, manager, cashier | |
| Payments | `bills.generate` | Generate/split bills | owner, manager, cashier | |
| Payments | `payments.take` | Record bill payments | owner, manager, cashier | Payment validation remains backend-authoritative |
| Payments | `bills.discount.apply` | Apply bill discounts and mark printed | owner, manager | Existing PIN/approval rules remain |
| Payments | `refunds.initiate` | Initiate and view refunds | initiate: owner/manager; view: current allowed roles | Consider splitting read/initiate if UI needs it |
| Payments | `payment-methods.view` | View payment methods | all roles | |
| Payments | `payment-methods.manage` | Create, edit, merge, and deactivate payment methods | owner, manager | |
| Payments | `printing.execute` | Print bills and kitchen tickets | owner, manager, cashier | Server printing setting remains an extra condition |
| Customers | `customers.view` | View/search customers, alerts, and wallet | owner, manager, cashier, server | |
| Customers | `customers.create` | Create customers | owner, manager, cashier, server | |
| Customers | `customers.edit` | Edit customers | owner, manager, cashier | |
| Customers | `customers.maintenance` | Repair customer phone records | owner, manager | Sensitive bulk operation |
| Customers | `customers.cleanup` | Run destructive customer cleanup | owner | Destructive confirmation remains |
| Menu | `catalog.view` | Read products, categories, and addons | all workflows that currently consume them | Explicitly gate formerly auth-only reads |
| Menu | `catalog.manage` | Manage products, categories, addons, and global loyalty rate | owner, manager | |
| Menu | `catalog.import-export` | Import/export menu CSV files | owner, manager | |
| Inventory | `inventory.view` | View stock and movement history | owner, manager | |
| Inventory | `inventory.manage` | Adjust product stock | owner, manager | Ledger rules remain |
| Inventory | `supplies.manage` | Manage supplies, movements, and recipes | owner, manager | May split read/write later if demanded |
| Kitchen | `kitchen.use` | View KDS orders/categories | owner, manager, chef | Station/category scope remains |
| Kitchen | `kitchen.status.update` | Change KDS item stages | owner, manager, chef | Station/category scope remains |
| Kitchen | `kitchen.pair` | Create KDS pairing sessions | owner, manager | KDS-enabled condition remains |
| Kitchen | `kitchen.stations.manage` | Manage stations and station assignments | owner, manager | |
| Reports | `reports.view` | View operational and sales reports, X/Z reports | owner, manager | |
| Reports | `reports.financial.view` | View owner financial summary | owner | Sensitive |
| Reports | `reports.daily-sales.export` | Export accounting-oriented daily sales files | owner | Sensitive data export |
| Cash | `cash.movements.manage` | View and create drawer movements | owner, manager, cashier | |
| Cash | `cash.movements.void` | Void drawer movements | owner, manager | |
| Cash | `cash.close` | Create and print cash closures | owner | |
| Staff | `staff.view` | View staff accounts and performance | owner, manager | Responses still exclude credentials |
| Staff | `staff.operational.manage` | Create/edit/deactivate cashier, server, and chef accounts | owner, manager | Target-type policy remains |
| Staff | `staff.privileged.manage` | Manage owner and manager accounts and roles | owner | Protected; not configurable in v1 |
| Authorization | `authorization.manage` | Edit role templates and user overrides, view IAM audit | owner | Protected; always granted to active owners only |
| Settings | `settings.view` | View non-secret operational settings | all roles | Endpoint response must remain safe for all granted users |
| Settings | `settings.manage` | Change ordinary store/operational settings | owner, manager | Currency reset stays separate |
| Tax | `tax-packs.view-test` | View/audit/test installed tax packs | owner, manager | |
| Tax | `tax-packs.manage` | Install, activate, configure, override, and roll back packs | owner | Tax calculations remain backend-authoritative |
| Printing | `print-templates.view` | View print templates | owner, manager | |
| Printing | `print-templates.manage` | Create/import/export/activate/archive templates | owner | |
| Printing | `printers.manage` | Discover, create, configure, test, and remove printers | owner, manager | Consider separating discovery if needed |
| Integrations | `whatsapp.use` | View status/messages and send messages | owner, manager, cashier | Refine inbox vs send during endpoint mapping |
| Integrations | `whatsapp.manage` | Configure, connect, block, and disconnect WhatsApp | owner, manager | |
| Integrations | `cloud.manage` | Configure/test ordinary cloud coordination | owner, manager | Offline failures remain graceful |
| Integrations | `cloud.account.manage` | Manage cloud account verification and data controls | owner | Master PIN remains for deletion |
| Integrations | `google-drive.manage` | Configure Drive, run backups, and restore | owner | Master PIN remains for restore |
| System | `database.manage` | Export/import/back up/repair/reset the local database | owner | Master PIN remains where currently required |
| System | `mobile-access.manage` | Pair, rotate, and inspect mobile devices | owner | |
| Apps | `server-app.use` | Log into and use the standalone Server App | owner, manager, server | Main API still checks operation permissions |
| Support | `support.use` | Contact support and view diagnostics | all roles | Pre-login support remains separately rate-limited |

During route mapping, split a permission if one toggle would combine materially different risk levels. In particular, refund read/initiate, WhatsApp read/send/inbox administration, database read/destructive operations, and printer discovery/management deserve explicit review.

### 5.3 Context policy versus permission checks

Every handler should follow this order:

1. Authenticate the live, active user.
2. Check the required effective permission.
3. Apply feature availability and object/state policy.
4. Apply station/category or similar scope.
5. Require an approval PIN or Master PIN when the operation calls for it.
6. Perform the transaction and write the domain/audit records.

A permission answers “may this person attempt this class of operation?” It must not encode order state machines, ownership, station membership, business-day math, or approval secrets.

## 6. Persistence and migration design

### 6.1 Tables

Use sparse override tables so an upgrade with zero rows automatically preserves code-defined defaults and a newly introduced permission receives its reviewed shipped default.

```sql
CREATE TABLE role_permission_overrides (
  role TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (role, permission_id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE TABLE user_permission_overrides (
  user_id TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, permission_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE TABLE authorization_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('role', 'user')),
  target_id TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  previous_effect TEXT,
  next_effect TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);
```

Add indexes on `user_permission_overrides(user_id)`, `role_permission_overrides(role)`, and `authorization_audit_log(created_at, id)`. The audit log should preserve the actor even if a user is later deactivated; users are already soft-deleted.

Do not persist a second copy of labels, descriptions, areas, or shipped defaults. SQLite cannot enforce that a permission ID exists in the TypeScript registry, so management APIs and the resolver must validate it. A schema-health test should reject malformed effects, orphaned user references, invalid roles, and unknown IDs.

### 6.2 Migration behavior

The schema migration adds the three empty tables. It does not need to write one row per current role/capability because absence means “use shipped default.” Verify:

- Fresh database creation includes the tables and indexes.
- Upgrade from the immediately previous schema version adds empty tables without rebuilding or modifying `users`.
- Existing users keep identical effective permission sets for all five roles.
- Full SQLite backup/restore retains the tables.
- JSON export/import explicitly handles the new tables and does not allow imported rows to reference unknown permissions or escalate the importing actor accidentally.
- Currency-reset/database-reinitialization flows make an explicit choice about preserving or resetting local IAM. Recommended: a destructive currency reset preserves user security state only to the same extent it already preserves users; do not introduce inconsistent partial preservation.
- Database audit and ideal-schema tests include the new tables.

### 6.3 Atomic writes and concurrency

Role/user override updates and their audit rows must be written in one SQLite transaction. Bulk APIs should accept the complete desired override map, validate every entry before writing, then calculate and return the new effective result.

Return a revision (for example a hash of sorted override rows or an integer revision stored in metadata) and require the caller's last-seen revision on update. A stale editor receives `409 Conflict` instead of overwriting another owner's change. Do not use timestamps alone as a concurrency token.

## 7. Backend architecture

### 7.1 Resolver

Create `main/services/authorization.ts` with a small, testable API:

```ts
resolveEffectivePermissions(userId: string): EffectivePermissionSet
hasPermission(userId: string, permission: PermissionId): boolean
requirePermission(permission: PermissionId): RequestHandler
requireAnyPermission(...permissions: PermissionId[]): RequestHandler
```

The resolver reads the user's current active state and role from SQLite, loads role and user overrides, applies protected invariants, and returns both a `Set<PermissionId>` and optional provenance for management responses.

Do not trust a permission list or role claim in a JWT. The JWT identifies the session; current database state authorizes the request. Permission revocations therefore take effect on the next protected backend action without forcing a logout.

Start without a long-lived permission cache. Local SQLite reads are cheap and correctness is more important than speculative optimization. If profiling later justifies a cache, it must be keyed by user plus an authorization revision, invalidated on every role/user override or role/account change, and independently correct in the main API, KDS server, and Server App processes.

### 7.2 Request context

Extend the authenticated request context with a typed user ID and current role. Permission middleware calls the resolver; handlers that need context policy can call a shared authorization helper rather than reimplementing precedence.

Keep `requireRole` temporarily only as a migration compatibility layer. It must not power any route once the configurable UI ships. A static test should eventually allow direct role decisions only in an explicit list of policy modules (owner lifecycle, refund approver policy, role-template validation, and chef/station behavior).

### 7.3 Complete enforcement surfaces

Migrate all of the following:

- Main Express routes on `:3001`, including authenticated routes that currently have no route-local role gate.
- KDS REST login/read/update routes on `:3002`.
- KDS WebSocket authentication, refresh, broadcast filtering, and item mutation authorization.
- Server App login on `:3003` plus forwarded operations. `server-app.use` authorizes entry, while the main API independently authorizes each forwarded operation.
- Background or Electron IPC actions that currently infer authority from role.
- Dynamic checks inside handlers, including print restrictions, order state transitions, staff target rules, and refund selection.

For each route, record one permission ID in a reviewed route-permission manifest. Where a handler has branches with different risk, split the route or perform an additional branch-specific permission check.

### 7.4 Management API

Add an owner-only router such as `/api/authorization`:

- `GET /catalog` returns code-defined metadata and shipped defaults.
- `GET /roles` returns each role's configured and effective template.
- `PUT /roles/:role` atomically replaces that role's override map using a revision.
- `GET /users/:userId` returns role values, user overrides, effective values, provenance, and revision.
- `PUT /users/:userId` atomically replaces user overrides using a revision.
- `DELETE /users/:userId/overrides` restores complete role inheritance.
- `GET /audit` returns paginated permission-change history.

API validation must:

- Reject unknown roles, users, permission IDs, effects, duplicate IDs, oversized payloads, and stale revisions.
- Reject changes to protected permissions.
- Reject non-owner callers even if a forged database row claims `authorization.manage` for them.
- Never return password, PIN, token, secret, or recovery material.
- Return a stable machine-readable error code as well as a safe message.
- Audit role bulk changes as individual permission changes sharing a batch ID, or as one batch record with complete before/after JSON. The chosen representation must make every changed permission queryable.

### 7.5 Authentication responses and live updates

Include effective permission IDs and an authorization revision in login, tenant selection, `/api/auth/me`, KDS auth/me, and Server App auth/me responses. Keep `role` for labels and policy context.

The API remains secure even when a client has stale UI state. For usability:

- Refresh `/api/auth/me` at application bootstrap and when the window regains focus.
- Refresh on a bounded interval while signed in, or add an existing local socket event if it can be reused cleanly.
- On `403 permission_denied`, refresh auth context before showing the final message.
- KDS and Server App must re-check the database for mutations; a revoked entry permission should end or disable the specialized session promptly.
- Do not store permission decisions only in local storage. Stored auth context is a display cache and is replaced by `/auth/me`.

## 8. Frontend design

### 8.1 Shared helpers

Replace frontend `hasRole(role, ROLE_ACCESS.*)` gates with `can(permissionId)` against the current effective permission set. Navigation definitions should carry a permission ID, not a role list. Page components and action buttons use the same IDs as their backend operations.

Add route-level client guards for clear UX, including a useful “You no longer have access” state and redirection to the first available surface. Do not always redirect to `/pos`: a chef or a narrowly configured user may not have `pos.use`. Landing-page selection should be deterministic from effective permissions.

### 8.2 Staff and permissions UI

Replace the read-only matrix with two editing views available only to owners:

1. **Role templates:** roles remain columns or selectable tabs; toggles show shipped default, configured value, and reset-to-default action. Saving warns how many active users inherit the role.
2. **User permissions:** opened from a staff row. Each capability shows effective state and source: shipped role default, role override, user allow, user deny, or protected rule. Controls offer Inherit / Allow / Deny.

Managers with `staff.view` or `staff.operational.manage` can continue to use the staff screen within target-account policy, but never see editable authorization controls unless they are an owner.

UX requirements:

- Group permissions by area with search/filter and expandable descriptions.
- Use text plus icons, not color alone.
- Clearly label sensitive/destructive permissions and preserved PIN requirements.
- Show unsaved changes, support cancel, and use one atomic save.
- Show a stale-edit conflict without discarding the owner's unsaved selection.
- Confirm broad role-template changes and sensitive grants.
- Provide “reset role to FloCafe defaults” and “clear user overrides” actions.
- Do not allow interaction with protected permissions; explain why they are fixed.
- Maintain keyboard operation, semantic labels, focus management, narrow-window overflow, RTL, and all supported translations.

### 8.3 Avoid misleading partial access

Navigation permissions and operation permissions are related but not identical. A user may see Orders with `orders.read` while lacking discount or void actions. The page should hide or disable only those actions and handle a backend denial cleanly.

If a useful page requires several read permissions, either define a coherent workflow permission or fetch independent panels defensively. Do not issue a burst of predictable 403s on every page load.

## 9. Delivery phases

The feature should be developed behind an internal code path and exposed only after all enforcement surfaces use it. Do not ship an editor whose changes affect only some routes.

### Phase 0: approve semantics and build the inventory

- Confirm the v1 boundary: fixed roles, editable role templates, per-user overrides, and the protected permission set.
- Add the business-decision entry.
- Produce a checked route/action manifest covering HTTP, WebSocket, specialized servers, frontend navigation, and direct role checks.
- Decide the few catalog splits called out in section 5.2.
- Capture the current five-role effective matrix as a golden fixture.

Exit criterion: every protected operation is mapped to a permission or explicitly documented as authentication-only/context-policy-only.

### Phase 1: authorization domain and schema

- Add the shared permission registry and compile-time ID type.
- Add override/audit tables and migrations.
- Implement the resolver and provenance output.
- Add focused unit, migration, schema, and default-parity tests.
- Do not change current route behavior yet.

Exit criterion: the resolver exactly reproduces the golden current matrix with empty override tables.

### Phase 2: backend enforcement migration

- Add permission middleware.
- Convert route groups in reviewable batches.
- Convert KDS, WebSocket, Server App, and inline/dynamic checks.
- Retain context policy and approval checks separately.
- Add a static enforcement audit and endpoint matrix tests.

Exit criterion: no ordinary feature authorization depends on a role group, and every route/action in the manifest has coverage.

### Phase 3: management API and audit

- Implement catalog, role-template, user-override, reset, and audit endpoints.
- Add concurrency control, transactions, validation, and authorization audit records.
- Extend auth responses with effective permissions and revision.

Exit criterion: an owner can change and reset permissions through API tests, changes take effect immediately, and non-owners cannot mutate IAM.

### Phase 4: frontend integration

- Add `can(permission)` and permission-aware landing/navigation/page/action gates.
- Build role-template and per-user editors.
- Add stale-session refresh behavior and denial UX.
- Add translations and accessibility coverage.

Exit criterion: UI state agrees with backend decisions across each role and representative overrides.

### Phase 5: compatibility, documentation, and release hardening

- Update [`roles-and-permissions.md`](roles-and-permissions.md) from fixed/current behavior to the configurable model.
- Update [`API.md`](API.md), business decisions, database documentation, and backup/import contracts.
- Remove obsolete role-group runtime gates while retaining role definitions needed for policy identity.
- Run full regression, upgrade, offline, packaging-relevant, and browser suites.

Exit criterion: all required checks pass and an upgraded real-world fixture preserves its pre-upgrade access until explicitly changed.

## 10. Test plan

### 10.1 Registry and resolver unit tests

- Permission IDs are unique and metadata is complete.
- Every shipped default references a valid fixed role.
- Empty override tables reproduce the current golden matrix exactly.
- Role allow and role deny each override shipped defaults.
- User allow and user deny each override the resolved role value.
- Removing a user override restores role inheritance.
- Removing a role override restores the shipped default.
- User override precedence is deterministic for all four role/user combinations.
- Unknown IDs never authorize and are rejected on writes.
- Inactive/missing users resolve to no usable permissions.
- Protected permissions cannot be denied from an owner or granted to a non-owner.
- A role change immediately causes effective permissions to inherit from the new role while explicit user overrides remain. Confirm this retention behavior as a product choice before coding; recommended behavior is to retain and visibly review overrides.
- Malformed database rows fail closed and produce a diagnostic without leaking secrets.

### 10.2 Migration and data-safety tests

- Fresh database creates all tables, constraints, indexes, and foreign keys.
- Previous-version fixture upgrades successfully with no user/order/settings loss.
- All five roles have exact before/after permission parity after upgrade.
- Migration is idempotent through the existing migration runner expectations.
- Ideal schema and upgraded schema match.
- Full backup/restore round-trips role overrides, user overrides, and IAM audit.
- JSON export redaction/import validation handles IAM tables as designed.
- Import rejects unknown permission IDs, invalid effects, invalid users/roles, and attempted protected-permission escalation.
- Database health/audit detects malformed or orphaned IAM records.
- Deactivating a user preserves audit history and makes all grants unusable.

### 10.3 Management API tests

- Unauthenticated requests return 401.
- Manager/cashier/server/chef requests return 403 for every mutation endpoint.
- A forged non-owner `authorization.manage` row still cannot administer IAM.
- Owners can read catalog, role templates, user effective permissions, and paginated audit.
- Owners can bulk save valid role and user overrides atomically.
- Any invalid element rejects the whole bulk request with no partial writes or audit entries.
- Stale revisions return 409 and preserve both writers' data.
- Protected-permission edits return a stable error.
- Reset endpoints remove only the intended override rows.
- Audit records actor, target, permission, before/after, batch, and timestamp.
- Responses never expose password/PIN hashes, tokens, secrets, or recovery data.
- Payload size, duplicate ID, and rate-limit behavior are covered.

### 10.4 Main API authorization matrix

Build a table-driven suite from the reviewed route-permission manifest. For every protected operation, test at least:

- No token: 401.
- Active user without permission: 403 with `permission_denied`.
- Active user with permission through shipped role default: passes authorization.
- Same user after role-level deny: 403.
- Same user after user-level allow: passes authorization.
- Default-allowed user after user-level deny: 403.
- Deactivated user with a valid token: 401.
- Role/permission change while token remains valid: next request uses new database state.

“Passes authorization” means the response is not 401/403; endpoint-specific validation may still return another status. Retain focused domain tests for successful business behavior.

Add regression assertions for authenticated read routes that previously lacked `requireRole`, including catalog, tables, printers, kitchen stations, and settings paths.

### 10.5 Policy composition tests

- Users with order permissions can see and act on other staff members' orders; no ownership gate is introduced.
- A user without the order permission is denied regardless of order creator.
- KDS grant plus allowed station/category succeeds.
- KDS grant plus disallowed station/category is denied or filtered exactly as today.
- KDS grant cannot operate when KDS is disabled.
- Refund initiation permission does not make a cashier/server/chef an eligible approval-PIN owner.
- Refund time tiers and business-day cutoff are unchanged.
- Database/cloud destructive permission still requires Master PIN where currently required.
- Order cancel/void/discount permission still respects state and approval rules.
- Payment permission does not bypass amount, currency, or bill-state validation.
- Feature-disabled WhatsApp/tables/loyalty/cloud behavior remains disabled even when granted.
- Last-owner demotion/deactivation remains impossible.

### 10.6 KDS, WebSocket, and Server App tests

- Specialized login requires `kitchen.use` or `server-app.use` respectively.
- A role that did not historically have access can enter after a valid grant, except where an explicit policy identity remains required and documented.
- Revocation blocks the next mutation and promptly refreshes/disconnects the specialized session.
- KDS WebSocket payloads remain station/category filtered.
- WebSocket mutations re-check live authorization rather than trusting connection-time state.
- Server App entry permission alone does not bypass main API operation permissions.
- Forwarded customer/order/print calls are independently denied when their operation permission is absent.

### 10.7 Frontend component and integration tests

- `can(permission)` handles loading, missing, granted, denied, and refreshed contexts.
- Sidebar items follow permissions plus business type/feature flags.
- Landing-page selection chooses the first allowed workflow and handles a user with no interactive page permissions.
- Direct navigation to a denied page renders the access-denied flow and does not expose protected data.
- Action controls independently track their operation permissions.
- Role template editor shows shipped/configured/effective state and protected explanations.
- User editor shows Inherit/Allow/Deny and correct provenance.
- Save, cancel, reset, conflict, retry, and failed-save states preserve user intent.
- A backend 403 triggers an auth-context refresh and a clear message.
- Keyboard navigation, focus restoration, screen-reader labels, non-color indicators, narrow desktop layout, and RTL are covered.
- Every supported locale contains the new labels; `npm run i18n:check` passes.

### 10.8 End-to-end scenarios

1. Owner denies `reports.view` from manager role; an existing signed-in manager loses the nav item and API access.
2. Owner grants `reports.view` to one cashier; that cashier gains reports while other cashiers do not.
3. Owner explicitly denies one manager `catalog.manage`; the manager can still use unrelated permissions but cannot mutate menu data.
4. Owner grants `kitchen.use` to a cashier assigned to a station; only permitted station/category data is visible and status updates require their separate grant.
5. Owner grants Server App entry plus orders/customer permissions to a cashier; only those operations work.
6. Owner resets a user's overrides, then resets the role template; effective behavior returns to shipped defaults.
7. Two owner sessions edit the same role; the stale save receives a conflict and cannot overwrite the newer change.
8. Upgrade an existing database, log in as every role, and prove no access changes before configuration.
9. Run the app disconnected from the internet and complete permission administration plus authorized POS/KDS flows.

### 10.9 Static and regression checks

Add tests or lint-like scripts that fail when:

- `requireRole` is introduced outside an explicit temporary migration allowlist.
- `ROLE_ACCESS` or `hasRole` is used as a runtime feature gate after migration.
- Direct `role ===`/`role !==` authorization appears outside approved policy modules.
- A permission exists without translation metadata or a shipped default.
- A route/action in the manifest lacks an assigned permission decision.
- Frontend navigation references an unknown permission.
- The forbidden order-ownership pattern returns (`user_id !== current user` for authorization).

### 10.10 Required verification commands

At minimum, implementation work must run:

```sh
npm run lint
npm run build
npm run build:frontend
npm run i18n:check
npm run test:e2e:browser
npm test
```

Also add and run focused scripts for permission resolver/API/matrix tests, migration fresh/upgrade tests, staff authorization, order authorization/audit, refunds, KDS integration/WebSockets, Server App access, database tools/import/backup, and security hardening. If ports `3001`, `3002`, or `3003` conflict, run `npm run clean` before browser/integration suites as documented in `AGENTS.md`.

## 11. Acceptance criteria

The feature is complete only when all of the following are true:

- An owner can edit fixed-role templates and individual user overrides from the Staff UI.
- The effective source of every displayed permission is understandable and resettable.
- Empty configuration is behaviorally identical to the current fixed matrix.
- Permission changes affect the main API, KDS, WebSockets, Server App, navigation, pages, and actions.
- Backend changes take effect on the next protected action without requiring a new JWT.
- Protected owner/IAM, last-owner, PIN, refund, KDS-scope, feature-flag, and order-visibility rules are preserved.
- Every permission mutation is atomic and audited.
- Upgrade, backup/restore, and offline operation are proven.
- No password, PIN, secret, or customer data is newly exposed.
- Documentation and translations describe the configurable behavior accurately.
- All required and focused tests pass.

## 12. Explicit decisions to confirm before implementation

This plan recommends the following. Confirm them at Phase 0 rather than discovering disagreement in code review:

1. Keep five fixed role identities in v1; defer custom role names and multiple-role membership.
2. Support both editable role templates and per-user allow/deny overrides.
3. Make `authorization.manage` and privileged owner-account administration permanently owner-only in v1.
4. Permit other sensitive permissions to be delegated, while preserving Master PIN/approval/context checks.
5. Retain a user's explicit overrides when their role changes, but show a warning and the resulting effective diff.
6. Use sparse overrides over shipped defaults so upgrades are safe and reset is well-defined.
7. Split permissions when read/write or ordinary/destructive operations have meaningfully different risk.

If any of these decisions changes, update this document and [`business-decisions.md`](business-decisions.md) before implementation so the security model, UI, migrations, and tests remain aligned.

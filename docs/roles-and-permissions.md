# Roles and permissions

**Status: CURRENT**

FloCafe keeps five staff identities—owner, manager, cashier, server, and chef—but access is now resolved from configurable permissions. Owners edit role defaults and individual staff exceptions from **Staff > Role permissions**. The backend remains authoritative; frontend visibility is only a convenience.

## Resolution model

For each permission, FloCafe evaluates these layers in order:

1. Protected owner rule.
2. Explicit user override (`allow` or `deny`).
3. Explicit role override (`allow` or `deny`).
4. The shipped role default in [`shared/permissions.ts`](../shared/permissions.ts).

An override is sparse. “Inherit” deletes the override rather than copying the current value, so new permissions introduced by upgrades receive their reviewed shipped default. Changes are read from local SQLite on every protected action and take effect without signing out.

`authorization.manage` and `staff.privileged.manage` are protected: active owners always have them and no other role can receive them. This prevents an override from removing the last administration path or granting owner/manager account control to another role.

## Management API and storage

The owner-only `/api/authorization` API exposes:

- `GET /catalog` — stable permission definitions and role identities.
- `GET /roles` and `PUT /roles/:role` — effective role templates and sparse overrides.
- `GET /users/:userId`, `PUT /users/:userId`, and `DELETE /users/:userId/overrides` — per-user effective values and exceptions.
- `GET /audit` — permission change history.

Writes replace the complete desired override set in one SQLite transaction, require a last-seen revision, and return `409` for stale editors. Tables `role_permission_overrides`, `user_permission_overrides`, and `authorization_audit_log` were added in schema migration v92. Permission IDs are code-defined persistence keys and are never accepted from outside the registry.

## Shipped defaults

The complete, executable default matrix lives in [`shared/permissions.ts`](../shared/permissions.ts). With no override rows, it preserves the previous behavior:

- Owner: all permissions, including protected authorization and privileged staff management.
- Manager: operational administration, catalog, reports, KDS, settings, and ordinary integrations; no protected owner controls.
- Cashier: POS, orders, payments, customers, cash-shift operations, printing, and WhatsApp use.
- Server: order/table/customer workflows, held orders, printing where the Server App setting permits it, and Server App access.
- Chef: KDS access and kitchen stage updates.

The Staff editor shows the effective value and lets an owner choose Inherit, Allow, or Deny for every configurable permission. Role changes retain user exceptions; the editor makes their source visible so they can be reviewed or cleared. Below the editor, **Staff > Permission change history** lists every role and user override change from `GET /audit` (actor, target, permission, before/after), newest first.

## Context policies that are not permissions

Permissions answer whether a staff member may attempt an operation. These independent rules still apply afterward:

- Orders are never ownership-gated. Anyone with the relevant order permission can act on every order; audit attribution records the actor.
- KDS category and station assignments continue to narrow kitchen access. KDS enablement is also required.
- Refund approver identity, approval PIN tiers, one-hour window, and business-day cutoff remain role-based business policy as documented in [`business-decisions.md`](business-decisions.md).
- Approval PINs, the device Master PIN, order/payment state machines, cash-session ownership, feature settings, and the last-active-owner rule remain enforced.
- Managers can manage operational accounts by default. Only the protected owner permission can modify owner/manager accounts or change roles.

## Runtime boundaries

The same resolver protects the main Express API, the KDS HTTP and WebSocket servers, and the standalone Server App. Auth responses include `permission_ids` and an `authorization_revision`; the frontend refreshes this snapshot on focus, periodically, after an owner saves changes, and following a permission denial. The server always resolves current database state again before an action.

## Verification

Run:

```sh
npm run test:authorization-permissions
npm run test:staff-authz
npm run test:orders-authz
npm run test:kds-integration
npm run test:server-app-server-role
```

The static authorization audit rejects new `requireRole(...)` runtime gates. Direct role checks are allowed only in reviewed context-policy files such as refund approval, last-owner/staff target policy, and KDS station/category scope.

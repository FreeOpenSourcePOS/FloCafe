# Roles and permissions

FloCafe has five fixed staff identities: owner, manager, cashier, server, and chef. This page is
the in-app **permission editor and UI capability matrix**: what each role can reach in the
interface, and how an owner changes that.

It is not the full authorization reference. The backend enforces authorization by resolving an
effective permission set from SQLite for every protected action, across roughly 245
`requirePermission`/`requireAnyPermission` call sites plus a handful of reviewed context-policy
role checks that no middleware sees; that surface is described in
[the authentication and authorization page](../architecture/authentication-and-authorization.md).
Read this page to understand what a role sees today and how to change it, and that page to
understand the resolution model and what stays role-based on purpose.

Unlike the identities themselves, **access is configurable.** An owner edits role defaults and
per-user exceptions from **Staff > Role permissions**; there is no separate IAM product, but there
is no fixed, uneditable permission grant either.

## Source of truth

The runtime source of truth is
[`shared/permissions.ts`](../../shared/permissions.ts): `PERMISSION_DEFINITIONS` is the complete,
executable catalog — every permission id, its area, its shipped default roles, whether it is
owner-configurable, and its risk tier. `authorization.manage` and `staff.privileged.manage` are
marked `configurable: false`; they are protected and always resolve to the active owner (see
[Resolution model](#resolution-model)).

For each permission, the effective value for a request resolves in this order:

1. The protected owner rule, for the two protected permissions above.
2. An explicit user override (`allow` or `deny`), if one exists for that user and permission.
3. An explicit role override (`allow` or `deny`), if one exists for that role and permission.
4. The shipped default in `PERMISSION_DEFINITIONS`.

An override is sparse: choosing **Inherit** in the editor deletes the override row rather than
copying the current resolved value, so a permission introduced by a later upgrade receives its
reviewed shipped default rather than silently freezing at whatever it resolved to before the
upgrade. [`main/services/authorization.ts`](../../main/services/authorization.ts) implements this
resolution and is read from current database state on every protected action — nothing is cached
in the JWT, and a change takes effect on the requesting user's next request without a sign-out.

## Resolution model

`authorization.manage` (who can reach this editor) and `staff.privileged.manage` (who can modify
an owner or manager account) are protected: an active owner always has them, and no override, role
change, or upgrade can grant either to another role. This guarantees the product always has a
recoverable administration path and that account control over owner/manager users cannot be
delegated away.

The owner-only `/api/authorization` API backs this page:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/authorization/catalog` | The stable permission catalog and the role identities. |
| `GET` | `/api/authorization/roles` | Every role's effective permissions, overrides, and revision. |
| `PUT` | `/api/authorization/roles/:role` | Atomically replace one role's override set. |
| `GET` | `/api/authorization/users` | The staff list this editor's per-user picker uses. |
| `GET` | `/api/authorization/users/:userId` | One user's effective permissions, overrides, and revision. |
| `PUT` | `/api/authorization/users/:userId` | Atomically replace one user's override set. |
| `DELETE` | `/api/authorization/users/:userId/overrides` | Clear every override for a user, restoring inheritance. |
| `GET` | `/api/authorization/audit` | Newest-first change history: actor, target, permission, before/after effect. |

Every `PUT`/`DELETE` body must carry the last-seen `revision` string; a stale revision — another
owner saved first — returns `409` with the current state, rather than silently overwriting it.
Override entries are `{ "permission_id": "...", "effect": "allow" | "deny" }`; an unknown,
duplicate, or protected permission id rejects the whole request. Writes are one SQLite
transaction and append rows to `authorization_audit_log`, which **Staff > Permission change
history** renders below the editor.

`role_permission_overrides`, `user_permission_overrides`, and `authorization_audit_log` were added
in schema migration v93.

## Permission matrix

The table below is the **shipped default** — what each role can reach with zero overrides applied,
which is also exactly what every existing installation resolves to immediately after upgrading to
this feature. A check means the role reaches the capability by default. A dash means it does not.
An owner can flip any configurable cell for a role, or for one user, from the in-app editor.

| Area | Capability | Owner | Manager | Cashier | Server | Chef |
| --- | --- | :---: | :---: | :---: | :---: | :---: |
| Orders | Use the POS terminal | ✓ | ✓ | ✓ | — | — |
| Reports | View the owner dashboard | ✓ | — | — | — | — |
| Orders | View and create orders | ✓ | ✓ | ✓ | ✓ | — |
| Orders | Update order status | ✓ | ✓ | ✓ | ✓ | ✓ |
| Orders | Change order customers and discounts | ✓ | ✓ | — | — | — |
| Orders | Cancel pending order items | ✓ | ✓ | — | — | — |
| Orders | Void in-progress order items (manager PIN may be required) | ✓ | ✓ | — | — | — |
| Orders | Restore cancelled order items | ✓ | ✓ | — | — | — |
| Orders | Create and manage held orders | ✓ | ✓ | ✓ | ✓ | — |
| Payments | View bills, take payments, and print receipts | ✓ | ✓ | ✓ | — | — |
| Payments | Apply bill discounts and mark bills printed | ✓ | ✓ | — | — | — |
| Payments | View payment methods | ✓ | ✓ | ✓ | ✓ | ✓ |
| Payments | Manage payment methods | ✓ | ✓ | — | — | — |
| Payments | Print bills and kitchen tickets | ✓ | ✓ | ✓ | — | — |
| Payments | Open a cash shift | ✓ | ✓ | ✓ | — | — |
| Payments | Close own cash shift (owner/manager can close any) | ✓ | ✓ | ✓ | — | — |
| Customers | View, search, and create customers | ✓ | ✓ | ✓ | ✓ | — |
| Customers | Edit customers | ✓ | ✓ | ✓ | — | — |
| Customers | Repair customer phone records | ✓ | ✓ | — | — | — |
| Customers | Clean up customer records | ✓ | — | — | — | — |
| Menu | Manage products, categories, and addons | ✓ | ✓ | — | — | — |
| Menu | Import and export menu data | ✓ | ✓ | — | — | — |
| Menu | Manage supplies and recipes | ✓ | ✓ | — | — | — |
| Orders | Manage tables | ✓ | ✓ | — | — | — |
| Orders | Move orders between tables | ✓ | ✓ | ✓ | ✓ | — |
| Kitchen | Use the kitchen display system | ✓ | ✓ | — | — | ✓ |
| Kitchen | Pair a kitchen display | ✓ | ✓ | — | — | — |
| Kitchen | Manage kitchen stations and assignments | ✓ | ✓ | — | — | — |
| Reports | View sales and operations reports | ✓ | ✓ | — | — | — |
| Reports | View financial figures (revenue, refunds, payment mix) | ✓ | — | — | — | — |
| Staff | View and manage staff accounts | ✓ | ✓ | — | — | — |
| Staff | Manage owner and manager accounts and roles | ✓ | — | — | — | — |
| Staff | Manage cashier, server, and chef accounts | ✓ | ✓ | — | — | — |
| Staff | Manage role and user permissions | ✓ | — | — | — | — |
| Settings | View store and operational settings | ✓ | ✓ | ✓ | ✓ | ✓ |
| Settings | Change store and operational settings | ✓ | ✓ | — | — | — |
| Settings | View and test tax packs | ✓ | ✓ | — | — | — |
| Settings | Install, activate, and manage tax packs | ✓ | — | — | — | — |
| Settings | Change tax configuration | ✓ | ✓ | — | — | — |
| Settings | View print templates | ✓ | ✓ | — | — | — |
| Settings | Manage print templates | ✓ | — | — | — | — |
| Settings | Manage printers | ✓ | ✓ | — | — | — |
| Integrations | Use WhatsApp messaging | ✓ | ✓ | ✓ | — | — |
| Integrations | Configure WhatsApp | ✓ | ✓ | — | — | — |
| Integrations | Manage cloud settings | ✓ | ✓ | — | — | — |
| Integrations | Manage Google Drive backups | ✓ | — | — | — | — |
| Integrations | Manage cloud account and data controls | ✓ | — | — | — | — |
| System | Use database tools and backups | ✓ | — | — | — | — |
| System | Manage mobile access (FloAdmin sync and device pairing) | ✓ | — | — | — | — |
| Orders | Use the standalone Server App | ✓ | ✓ | — | ✓ | — |
| Support | Contact support and view diagnostics | ✓ | ✓ | ✓ | ✓ | ✓ |

`authorization.manage` and `staff.privileged.manage` (the last two Staff rows a non-owner will
never see change) are protected and not shown as editable in the table above; every other row is
`configurable: true` in `shared/permissions.ts` and can be overridden per role or per user.

## Scope notes

**Editable, not read-only.** The in-app table lets an owner choose Inherit, Allow, or Deny for
every configurable permission, per role or for one staff member's exceptions. A role change
retains that user's exceptions; the editor shows their source (shipped default, role override, or
user override) so they can be reviewed or cleared. **Staff > Permission change history** lists
every save.

**Shift close.** Cashiers close only the shift they opened. An owner or manager can close any
session, and the closing actor is recorded on the closure row. The route is
`POST /api/cash-sessions/:id/close`; the own-session rule is enforced inside the close transaction,
where the stored session and the actor are read together. This is a context policy, not a
permission — see [the authentication and authorization page](../architecture/authentication-and-authorization.md).

**Order cancellation.** Cashiers can cancel a whole order while it is pending. If the order or any
item has advanced to `preparing` or later, an owner or manager approval PIN is required. The rule
turns on stored order and item status, not on whether a KDS screen is open; printing a kitchen
ticket does not advance the status.

**Owner visibility.** The permission editor itself is rendered only for an authenticated user
holding `authorization.manage` — an active owner, always. The API enforces this independently;
hiding a control in the interface is not a security boundary.

**KDS scope.** Chef access is narrowed further by the user's assigned `category_ids` and by
kitchen station assignment, on top of the `kitchen.use`/`kitchen.status.update` permissions. Owner
and manager KDS access is unrestricted by category, subject to the KDS being enabled. Station and
category narrowing is re-evaluated inside the transaction that applies a status change; see
[the authentication and authorization page](../architecture/authentication-and-authorization.md).

**Orders are never ownership-gated.** Anyone with the relevant order permission — the "View and
create orders" row above — can view and act on every order, including ones other staff created.
There is no per-order `user_id` check anywhere in the authorization model. Restriction is by
permission and, for kitchen operations, by KDS stage, station, and category. Accountability comes
from audit attribution, not from hiding orders between staff.

**Server App.** The standalone Server App is gated by `server-app.use`, shipped by default to
`server`, `manager`, and `owner`. When the feature is disabled its routes return 404 rather than
403, so the surface is not discoverable. It is separate from the dashboard navigation.

**Staff management.** Managers can manage operational staff by default (`staff.operational.manage`),
but cannot modify or deactivate owner or manager accounts: that needs the protected
`staff.privileged.manage`, which only an owner holds. Only an owner can change the role on an
existing account, and the last active owner cannot be demoted.

**Conditional surfaces.** Business type, feature settings such as KDS or WhatsApp, and account
state can hide or disable a surface independently of whether the permission is granted.

## Presentation

The in-app editor uses roles or one selected staff member as the subject, and permissions as rows,
grouped by area, with a semantic HTML table, an Effective column pairing check/dash icons with
explicit Allowed/Not allowed text, and an Override column offering Inherit/Allow/Deny per row. It
keeps horizontal overflow with a sticky capability column so cross-permission comparison stays fast
at narrow desktop widths. The pattern follows
[W3C table guidance](https://www.w3.org/WAI/tutorials/tables/),
[GOV.UK table guidance](https://design-system.service.gov.uk/components/table/), and
[WCAG guidance on non-color state indicators](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html).

## Verification

```sh
npm run test:authorization-permissions
npm run test:staff-authz
npm run test:orders-authz
npm run test:kds-integration
npm run test:server-app-server-role
```

A static audit test rejects any newly introduced `requireRole(...)` runtime gate in
`main/routes/`. Direct role checks remain only in reviewed context-policy files — refund approval,
last-owner/staff target policy, and KDS station/category scope — none of which decide whether a
request may attempt the operation at all.

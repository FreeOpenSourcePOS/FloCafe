# Roles and permissions

FloCafe has five fixed staff roles: owner, manager, cashier, server, and chef. This page is the
in-app **UI capability matrix**: what each role can reach in the interface.

It is not the authorization reference. The backend enforces authorization across roughly 225
route-level `requireRole` call sites plus per-endpoint checks that no middleware sees; that surface
is described in
[the authentication and authorization page](../architecture/authentication-and-authorization.md).
Read this page to understand what a role sees, and that page to understand what a role is allowed
to do.

This page is read-only. It does not configure access, and there is no configurable per-role
permission grant and no IAM layer in the product.

## Source of truth

The runtime source of truth is
[`shared/role-permissions.ts`](../../shared/role-permissions.ts). Backend route gates use its
`ROLE_ACCESS` groups, and the in-app table is generated from its `PERMISSION_CAPABILITIES` list.
The displayed matrix therefore stays aligned with the role groups that protect the runtime surfaces
when a route and its matching capability are updated together. It is not a separate database or
policy.

The same read-only matrix is available in-app on the Staff page, rendered for an authenticated
owner or manager. Capability labels come from
`frontend/src/lib/i18n/messages/en.json` under `permissionMatrix.capabilities`, and the table below
uses those strings.

## Permission matrix

A check means the role reaches the capability in the interface. A dash means it does not. Rows are
grouped by area, in the same order and with the same labels as Staff > Role permissions.

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
| Staff | View and manage staff accounts | ✓ | ✓ | — | — | — |
| Staff | Manage owner and manager accounts and roles | ✓ | — | — | — | — |
| Staff | Manage cashier, server, and chef accounts | ✓ | ✓ | — | — | — |
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
| Orders | Use the standalone Server App | ✓ | ✓ | — | ✓ | — |
| Support | Contact support and view diagnostics | ✓ | ✓ | ✓ | ✓ | ✓ |

The `inventoryManage` capability id renders to users as "Manage supplies and recipes". The id and
the label name different things; the label is what a merchant reads.

## Scope notes

**Read-only display.** The in-app table offers no role editing, no permission toggles, and no IAM
configuration. Permissions are fixed by role. This is a product boundary, not a missing feature in
this document.

**Shift close.** Cashiers close only the shift they opened. An owner or manager can close any
session, and the closing actor is recorded on the closure row. The route is
`POST /api/cash-sessions/:id/close`; the own-session rule is enforced inside the close transaction,
where the stored session and the actor are read together.

**Order cancellation.** Cashiers can cancel a whole order while it is pending. If the order or any
item has advanced to `preparing` or later, an owner or manager approval PIN is required. The rule
turns on stored order and item status, not on whether a KDS screen is open; printing a kitchen
ticket does not advance the status.

**Owner and manager visibility.** The matrix is rendered only for an authenticated owner or
manager. The API enforces authorization independently. Hiding a control in the interface is not a
security boundary.

**KDS scope.** Chef access is narrowed further by the user's assigned `category_ids` and by kitchen
station assignment. Owner and manager KDS access is unrestricted by category, subject to the KDS
being enabled. Station and category narrowing is re-evaluated inside the transaction that applies
a status change; see
[the authentication and authorization page](../architecture/authentication-and-authorization.md).

**Orders are never ownership-gated.** Any role with order access, which is the "View and create
orders" row above, can view and act on every order including ones other staff created. There is no
per-order `user_id` check in the authorization model. Restriction is by role and, for kitchen
operations, by KDS stage, station, and category. Accountability comes from audit attribution, not
from hiding orders between staff.

**Server App.** The standalone Server App is restricted to `server`, `manager`, and `owner`. When
the feature is disabled its routes return 404 rather than 403, so the surface is not discoverable.
It is separate from the dashboard navigation.

**Staff management.** Managers can manage operational staff, but cannot modify or deactivate owner
or manager accounts. Only owners can change the role on an existing account, and the last active
owner cannot be demoted.

**Conditional surfaces.** Business type, feature settings such as KDS or WhatsApp, and account
state can hide or disable a surface without changing the fixed role boundary.

## Presentation

The in-app version uses roles as columns and capabilities as rows, with grouped areas, a semantic
HTML table, explicit Allowed and Not allowed text paired with check and dash icons, and horizontal
overflow with a sticky capability column. This keeps cross-role comparison fast while preserving
table semantics and context at narrow desktop widths. The pattern follows
[W3C table guidance](https://www.w3.org/WAI/tutorials/tables/),
[GOV.UK table guidance](https://design-system.service.gov.uk/components/table/), and
[WCAG guidance on non-color state indicators](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html).

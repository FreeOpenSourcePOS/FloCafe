# Roles and permissions

**Status: CURRENT**

FloCafe currently has five fixed staff roles: owner, manager, cashier, server, and chef. This document describes the default role boundaries in the application. It is a read-only reference - it does not configure access.

The same read-only matrix is available in the Staff page for owners and managers. The runtime source of truth is [`shared/role-permissions.ts`](../shared/role-permissions.ts): backend route gates use its `ROLE_ACCESS` groups, and the in-app table is generated from its `PERMISSION_CAPABILITIES` list. This means the displayed matrix stays accurate when a route changes **if the route and capability are updated to use the shared constants**; it is not a separate database or IAM policy.

## Permission matrix

A check means the role is allowed to use the capability. A dash means it is not allowed. The table groups capabilities by area and uses the same capabilities shown in Staff > Role permissions.

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
| Customers | View, search, and create customers | ✓ | ✓ | ✓ | ✓ | — |
| Customers | Edit customers | ✓ | ✓ | ✓ | — | — |
| Customers | Repair customer phone records | ✓ | ✓ | — | — | — |
| Customers | Clean up customer records | ✓ | — | — | — | — |
| Menu | Manage products, categories, and addons | ✓ | ✓ | — | — | — |
| Menu | Import and export menu data | ✓ | ✓ | — | — | — |
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
| Integrations | Manage cloud and Google Drive settings | ✓ | ✓ | — | — | — |
| Integrations | Manage cloud account and data controls | ✓ | — | — | — | — |
| System | Use database tools and backups | ✓ | — | — | — | — |
| Orders | Use the standalone Server App | ✓ | ✓ | — | ✓ | — |
| Support | Contact support and view diagnostics | ✓ | ✓ | ✓ | ✓ | ✓ |

## Important scope notes

- **Read-only display:** The in-app table does not offer role editing, permission toggles, or IAM configuration. These permissions are currently fixed by role. Role configuration/IAM is not available yet.
- **Owner and manager visibility:** The matrix is rendered only for an authenticated owner or manager on the Staff page. The API continues to enforce authorization independently; hiding a UI control is not a security boundary.
- **KDS scope:** Chef access is further narrowed by assigned `category_ids` and kitchen stations. Owner and manager KDS access is unrestricted by category, subject to the KDS being enabled.
- **Server App:** The standalone Server App is intentionally restricted to `server`, `manager`, and `owner` roles. It is separate from the dashboard navigation.
- **Staff management:** Managers can manage operational staff, but cannot modify or deactivate owner/manager accounts. Only owners can change roles for an existing account, and the last active owner cannot be demoted.
- **Conditional surfaces:** Business type, feature settings (such as KDS or WhatsApp), and account state can hide or disable a surface without changing the fixed role boundary.

## Research-backed presentation choice

The in-app version uses roles as columns and capabilities as rows, with grouped areas, a semantic HTML table, explicit Allowed/Not allowed text paired with check/dash icons, and horizontal overflow with a sticky capability column. This keeps cross-role comparison fast while preserving table semantics and context at narrow desktop widths. The pattern follows [W3C table guidance](https://www.w3.org/WAI/tutorials/tables/), [GOV.UK table guidance](https://design-system.service.gov.uk/components/table/), and [WCAG guidance on non-color state indicators](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html).

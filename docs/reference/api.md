# API reference

This page is the endpoint and WebSocket contract for the three HTTP servers FloCafe runs. It
describes what each server exposes, which role each endpoint requires, and the parameters each
handler reads. It is the API surface only. Behaviour that belongs to another subject is linked
rather than restated, at the end of each section.

## How to read this page

Three servers run inside the POS process:

| Port | Server | What it serves | Source |
| --- | --- | --- | --- |
| `3001` | Main API | Every `/api/*` route, plus the static frontend export | [`main/server.ts`](../../main/server.ts) |
| `3002` | KDS | The standalone kitchen display: a small REST surface plus the static KDS bundle | [`main/kds-server.ts`](../../main/kds-server.ts) |
| `3003` | Server App | A filtered proxy onto a fixed list of `3001` routes, plus the static Server App bundle | [`main/server-app.ts`](../../main/server-app.ts) |

Each server walks its port upward from its base when the port is taken, so the bound port can
differ from the default. [System overview](../architecture/overview.md#processes-and-ports)
covers the retry ladder and how the running ports are reported to the UI.

The `/kds` WebSocket is upgraded on **both** `3001` and `3002`. A KDS display pointed at either
port gets the same frames from [`main/services/kds.ts`](../../main/services/kds.ts). Any other
upgrade path on either port is answered with `404`.

Base URLs:

- Main API: `http://flo.local:3001` or `http://<local-ip>:3001`
- KDS: `http://flo.local:3002`
- Server App: `http://flo.local:3003`

## Authentication

All three servers authenticate with a bearer JWT. Send it as `Authorization: Bearer <token>`. Each
server issues its own token through a `POST /api/auth/login` on its own port, using the same signing
secret, so a token from one server is accepted by the others. The scheme, token lifecycle, revocation, staleness handling, the
Master PIN second factor, and audit attribution are described in
[authentication and authorization](../architecture/authentication-and-authorization.md). That page
also explains why the three servers each write their own token-verification middleware and what
diverges between them.

Almost every protected endpoint is gated by `requirePermission(id)`, resolved live from SQLite —
see [Configurable permissions](../architecture/authentication-and-authorization.md#configurable-permissions).
For brevity, the **Authorization** column below names the endpoint's permission by its **shipped
default** role group instead of its permission id, using the same `ROLE_ACCESS` keys from
[`shared/role-permissions.ts`](../../shared/role-permissions.ts) that
[`shared/permissions.ts`](../../shared/permissions.ts) assigns as each permission's
`defaultRoles`:

| Group | Roles |
| --- | --- |
| `owner` | owner |
| `ownerManager` | owner, manager |
| `ownerManagerCashier` | owner, manager, cashier |
| `sales` | owner, manager, cashier, server |
| `cashierServer` | cashier, server |
| `kitchen` | owner, manager, chef |
| `orderStatus` | owner, manager, cashier, server, chef |
| `allStaff` | owner, manager, cashier, server, chef |
| `serverApp` | server, manager, owner |

**This is the default, not a fixed gate.** An owner can grant or deny any of these per role or per
user from **Staff > Role permissions**, without a code change, and the endpoint enforces whatever
is currently configured — not the table below. To find the exact permission id an endpoint checks,
read the route source or `shared/permissions.ts`; to see the current effective configuration for
an install, use `GET /api/authorization/roles`. `authorization.manage` and
`staff.privileged.manage` are the two permissions marked `configurable: false` in the catalog:
those two rows are not owner-configurable, unlike every other row in this reference.

The [roles and permissions](roles-and-permissions.md) page holds the in-app permission editor and
capability matrix — a UI view and its owner-only management API, not this backend gate list.

A row reading `any authenticated role` means the endpoint has no permission or role gate beyond
`requireAuth`. A row reading `+ KDS-enabled` also passes through `requireKdsEnabled`, which returns
`403` when `kds_enabled` is off. `+ Master PIN` adds `requireMasterPin`, which reads `master_pin`
from the body.

### Configurable authorization management

Router: `main/routes/authorization.ts`. Full path: `/api/authorization`. Every route below
requires `authorization.manage` — active owner only, protected, not configurable.

| Method | Path | Parameters | Response |
| --- | --- | --- | --- |
| `GET` | `/catalog` | none | `{ permissions: PERMISSION_DEFINITIONS, roles: ROLE_KEYS }` — the stable permission catalog and role identities. |
| `GET` | `/roles` | none | `{ roles: [{ role, revision, overrides, permissions }, ...] }` for every role. |
| `PUT` | `/roles/:role` | body: `revision`, `overrides: [{ permission_id, effect }]` | Atomically replaces that role's override set. `409` with the current role payload on a stale `revision`; `400` on an unknown, duplicate, or protected permission id. |
| `GET` | `/users` | none | `{ users: [...] }` — the safe staff list this editor's per-user picker uses. |
| `GET` | `/users/:userId` | path: `userId` | `{ user, revision, overrides, permissions }` — one user's effective values and exceptions. `404` if absent. |
| `PUT` | `/users/:userId` | body: `revision`, `overrides: [{ permission_id, effect }]` | Atomically replaces that user's override set. Same `409`/`400` behavior as the role route. |
| `DELETE` | `/users/:userId/overrides` | body: `revision` | Clears every override for that user, restoring inheritance. `409` on a stale `revision`. |
| `GET` | `/audit` | query: `?limit` (max 200), `?before_id` | `{ audit: [...] }`, newest first: actor, target type/id, permission id, previous/next effect, timestamp. |

Every write is one SQLite transaction and appends rows to `authorization_audit_log`, keyed under a
shared `batch_id` per save so a multi-permission change reads as one event.

## Rate limiting

`main/server.ts` applies a 100 requests per minute ceiling to all of `/api` on `3001`, skipping
loopback, RFC 1918, and Tailscale addresses. `3002` applies 100 per minute to its own `/api` through
the same LAN-exempt helper, and `3003` applies 150 per minute. `express-rate-limit` emits `RateLimit-*` headers; the in-repo
`rateLimit` helper in [`main/middleware/security.ts`](../../main/middleware/security.ts) does the
same.

`authRateLimit` is the one limiter that deliberately does **not** exempt private addresses. It
passes `bypassPrivateIp: false`, so LAN clients are counted. Five routes use it: the three
credential routes `POST /api/auth/login`, `POST /api/auth/password/change`, and
`POST /api/auth/recover-password` on `3001`, plus `POST /api/staff` and `PUT /api/staff/:id`, which
create and modify staff credentials. `POST /api/auth/login` on `3002` and `3003` uses it too. Its default ceiling is 10 attempts per 15 minutes, overridable
with `FLO_AUTH_RATE_LIMIT_MAX`.

Per-resource limiters named in the tables below (for example the order read and write limiters) are
`express-rate-limit` instances declared in their own route file. They apply to every caller
including LAN addresses.

## Main API (`:3001`)

`registerRoutes` in [`main/routes/index.ts`](../../main/routes/index.ts) mounts 36 routers under 37
paths. `staffRoutes` is the same router mounted at both `/api/staff` and `/api/users`, so the two
prefixes expose an identical surface. Nine further endpoints are registered inline on `app` in that
same file, outside any router, and are listed under
[Inline endpoints](#inline-endpoints-registered-outside-a-router). `GET /api/health` is registered
directly in `main/server.ts`.

A search for `router.` in the route files misses all ten of those, so a route inventory built on that
pattern alone is incomplete.

### Health

Router: `main/server.ts`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/api/health` | none | none | `{ status, db, service, version, timestamp }`. `503` when the database reports unhealthy. |

### Authentication

Router: `main/routes/auth.ts`. Full path: `/api/auth`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `POST` | `/login` | any authenticated role + auth limiter | body: `email`, `password`, `rememberMe` | `{ access_token, token_type: "bearer", expires_in, user: { id, name, email, role, category_ids }, tenants: [ ... ] }`. `401` on bad credentials; `429` after repeated failures from one IP. |
| `POST` | `/tenants/select` | any authenticated role | none | `{ access_token, token_type: "bearer", tenant }`. |
| `POST` | `/logout` | any authenticated role | none | `{ message }`. Revokes the presented token. |
| `POST` | `/refresh` | any authenticated role | none | `{ access_token, token_type: "bearer", expires_in }`. |
| `GET` | `/me` | any authenticated role | none | `{ user: { id, name, email, role }, tenants: [ ... ] }`. |
| `POST` | `/password/change` | any authenticated role + auth limiter | body: `current_password`, `password` | `{ message }`. A wrong current password returns `400` with `attempts_remaining`; the fifth consecutive failure locks that user out for 5 minutes, and attempts during the lockout return `429`. The new password must satisfy `validatePassword`. |
| `POST` | `/recover-password` | any authenticated role + auth limiter | body: `email`, `master_pin`, `new_password` | Local-setup recovery gated on `email`, `master_pin`, `new_password`. `409` before first-run setup finishes. |
| `GET` | `/setup/status` | any authenticated role | none | `{ needsSetup, userCount, initialRole, schemaVersion, masterPinAvailable, currencyReset }`. |
| `POST` | `/setup/initialize` | any authenticated role | body: `name`, `password`, `business_type`, `setup_profile`, `service_model`, `language`, `business_name`, `country`, `currency`, `currency_symbol`, `timezone`, `business_address`, `business_phone`, `tax_registration_number`, `state_code`, `tax_registered`, `billing_type`, `terms_accepted`, `master_pin`, `owner_approval_pin`, `owner_approval_pin_confirmation`, `cloud_server_url`, `email_product_updates`, `email_marketing` | Creates the first owner. Refuses once any user exists. |
| `POST` | `/setup/seed` | any authenticated role | none | Always `410`; directs the caller to `/api/auth/setup/initialize`. |

### Categories

Router: `main/routes/categories.ts`. Full path: `/api/categories`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | any authenticated role | query: `?active`, `?root`, `?parent_id` | Flat list, soft-deleted rows excluded. `?root=true` and `?parent_id` narrow to a tree level. |
| `GET` | `/:id` | any authenticated role | path: `id` | Single category; `404` when absent or soft-deleted. |
| `POST` | `/` | `ROLE_ACCESS.ownerManager` + category write limiter | body: `name`, `description`, `parent_id`, `sort_order`, `is_active`, `color`, `icon` | - |
| `PUT` | `/:id` | `ROLE_ACCESS.ownerManager` + category write limiter | path: `id`; body: `name`, `description`, `parent_id`, `sort_order`, `is_active`, `color`, `icon` | - |
| `DELETE` | `/:id` | `ROLE_ACCESS.ownerManager` + category write limiter | path: `id` | - |

### Addon groups

Router: `main/routes/addon-groups.ts`. Full path: `/api/addon-groups`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | any authenticated role + addon-group read limiter | none | `{ addon_groups: [ ... ] }` with add-ons attached. |
| `GET` | `/:id` | any authenticated role + addon-group read limiter | path: `id` | Single group with add-ons. |
| `POST` | `/` | `ROLE_ACCESS.ownerManager` + addon-group write limiter | body: `name`, `description`, `is_required`, `min_selection`, `max_selection`, `allow_multiple_quantities`, `sort_order`, `addons` | `201` with the created group. |
| `PUT` | `/:id` | `ROLE_ACCESS.ownerManager` + addon-group write limiter | path: `id`; body: `name`, `description`, `is_required`, `min_selection`, `max_selection`, `allow_multiple_quantities`, `sort_order`, `is_active`, `addons` | - |
| `DELETE` | `/:id` | `ROLE_ACCESS.ownerManager` + addon-group write limiter | path: `id` | - |
| `POST` | `/:groupId/addons` | `ROLE_ACCESS.ownerManager` + addon-group write limiter | path: `groupId`; body: `name`, `price`, `tax_category_id`, `tax_behavior`, `inherit_parent_tax_category`, `is_active`, `sort_order` | `201` with the created add-on. |
| `PUT` | `/:groupId/addons/:addonId` | `ROLE_ACCESS.ownerManager` + addon-group write limiter | path: `addonId`, `groupId`; body: `name`, `price`, `tax_category_id`, `tax_behavior`, `inherit_parent_tax_category`, `is_active`, `sort_order` | - |
| `DELETE` | `/:groupId/addons/:addonId` | `ROLE_ACCESS.ownerManager` + addon-group write limiter | path: `groupId`, `addonId` | - |

### Products

Router: `main/routes/products.ts`. Full path: `/api/products`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | any authenticated role | query: `?category_id`, `?active`, `?search`, `?barcode`, `?low_stock` | Menu list. `?low_stock` returns only items at or below their threshold. |
| `GET` | `/:id/image` | any authenticated role | path: `id` | Product image bytes. Unauthenticated by design so `<img>` tags work; subject to SSRF and path-containment checks on the stored URL. |
| `GET` | `/:id` | any authenticated role | path: `id` | Single product. |
| `POST` | `/fetch-url` | `ROLE_ACCESS.ownerManager` | body: `url` | Body `url` is fetched server-side and stored as the product image. Subject to the SSRF blocklist. |
| `POST` | `/` | `ROLE_ACCESS.ownerManager` | body: `category_id`, `name`, `sku`, `barcode`, `description`, `price`, `cost_price`, `sale_unit`, `allow_fractional_quantity`, `weight_precision`, `inventory_product_id`, `inventory_deduction_quantity`, `tax_category_id`, `tax_behavior`, `track_inventory`, `stock_quantity`, `low_stock_threshold`, `is_active`, `image_url`, `sort_order`, `cb_percent`, `tags`, `addon_group_ids`, `reason` | - |
| `PUT` | `/:id` | `ROLE_ACCESS.ownerManager` | path: `id`; body: `category_id`, `name`, `sku`, `barcode`, `description`, `price`, `cost_price`, `sale_unit`, `allow_fractional_quantity`, `weight_precision`, `inventory_product_id`, `inventory_deduction_quantity`, `tax_category_id`, `tax_behavior`, `track_inventory`, `stock_quantity`, `low_stock_threshold`, `is_active`, `image_url`, `sort_order`, `cb_percent`, `tags`, `addon_group_ids`, `reason` | - |
| `DELETE` | `/:id` | `ROLE_ACCESS.ownerManager` | path: `id` | - |
| `POST` | `/:id/stock` | `ROLE_ACCESS.ownerManager` | path: `id`; body: `action`, `quantity`, `reason` | - |
| `GET` | `/loyalty/global-rate-candidates` | `ROLE_ACCESS.ownerManager` | none | - |
| `POST` | `/loyalty/apply-global-rate` | `ROLE_ACCESS.ownerManager` | none | Applies one cashback rate across products. |

### Recipes

Router: `main/routes/recipes.ts`. Full path: `/api/recipes`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | `ROLE_ACCESS.ownerManager` | none | `{ recipes: [ ... ] }`. |
| `GET` | `/product/:productId` | `ROLE_ACCESS.ownerManager` | path: `productId` | Recipe snapshot for one product. |
| `PUT` | `/product/:productId` | `ROLE_ACCESS.ownerManager` | path: `productId`; body: `yield_quantity`, `is_active`, `items` | - |
| `DELETE` | `/product/:productId` | `ROLE_ACCESS.ownerManager` | path: `productId` | - |

### Supplies

Router: `main/routes/supplies.ts`. Full path: `/api/supplies`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | `ROLE_ACCESS.ownerManager` | query: `?include_inactive`, `?low_stock`, `?search` | Supply list. `?low_stock` and `?include_inactive` narrow it. |
| `POST` | `/` | `ROLE_ACCESS.ownerManager` | body: `name`, `base_unit`, `stock_quantity`, `low_stock_threshold`, `is_active` | - |
| `GET` | `/movements` | `ROLE_ACCESS.ownerManager` | query: `?supply_id`, `?movement_type`, `?before_id`, `?per_page` | Supply movement ledger, newest first; `?before_id` pages backwards. |
| `GET` | `/:id` | `ROLE_ACCESS.ownerManager` | path: `id` | - |
| `PUT` | `/:id` | `ROLE_ACCESS.ownerManager` | path: `id`; body: `name`, `is_active`, `low_stock_threshold` | - |
| `DELETE` | `/:id` | `ROLE_ACCESS.ownerManager` | path: `id` | - |
| `POST` | `/:id/movements` | `ROLE_ACCESS.ownerManager` | path: `id`; body: `movement_type`, `quantity`, `unit`, `reason` | Body `movement_type`, `quantity`, `unit`, `reason`. |

### Inventory movements

Router: `main/routes/inventory.ts`. Full path: `/api/inventory`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/movements` | `ROLE_ACCESS.ownerManager` | query: `?product_id`, `?reference_type`, `?reference_id`, `?movement_type`, `?before_id`, `?per_page` | - |

### Tables

Router: `main/routes/tables.ts`. Full path: `/api/tables`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | any authenticated role | query: `?status`, `?floor`, `?section`, `?kitchen_station_id`, `?active` | Table list; `?status`, `?floor`, `?section`, `?kitchen_station_id`, `?active`. |
| `GET` | `/:id` | any authenticated role | path: `id` | Single table. |
| `PATCH` | `/floors/:name` | `ROLE_ACCESS.ownerManager` | path: `name`; body: `newName` | - |
| `DELETE` | `/floors/:name` | `ROLE_ACCESS.ownerManager` | path: `name` | - |
| `POST` | `/` | `ROLE_ACCESS.ownerManager` | body: `number`, `name`, `capacity`, `floor`, `section`, `position_x`, `position_y`, `kitchen_station_id` | - |
| `PATCH` | `/positions` | `ROLE_ACCESS.ownerManager` | body: `positions` | Bulk floor-plan position update. |
| `PUT` | `/:id` | `ROLE_ACCESS.ownerManager` | path: `id`; body: `number`, `name`, `capacity`, `floor`, `section`, `position_x`, `position_y`, `kitchen_station_id` | - |
| `POST` | `/:id/deactivate` | `ROLE_ACCESS.ownerManager` | path: `id` | Soft-deactivates the table rather than deleting it. |
| `POST` | `/:id/reactivate` | `ROLE_ACCESS.ownerManager` | path: `id` | - |
| `POST` | `/:id/move-order` | `ROLE_ACCESS.sales` | path: `id`; body: `target_table_id`, `order_id` | - |
| `PATCH` | `/:id/status` | `ROLE_ACCESS.ownerManager` | path: `id`; body: `status`, `reservation_customer_id` | Body `status`, plus `reservation_customer_id` for reservation state. |

### Kitchen stations

Router: `main/routes/kitchen-stations.ts`. Full path: `/api/kitchen-stations`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | any authenticated role | none | `{ kitchen_stations: [ ... ] }`, active stations only. |
| `GET` | `/:id` | any authenticated role | path: `id` | Single station. |
| `POST` | `/` | `ROLE_ACCESS.ownerManager` | body: `name`, `description`, `category_ids`, `printer_id`, `printer_ip`, `printer_port`, `printer_name`, `sort_order` | - |
| `PUT` | `/:id` | `ROLE_ACCESS.ownerManager` | path: `id`; body: `name`, `description`, `category_ids`, `printer_id`, `printer_ip`, `printer_port`, `printer_name`, `sort_order`, `is_active` | - |
| `PUT` | `/:id/users` | `ROLE_ACCESS.ownerManager` | path: `id`; body: `user_ids` | Replaces the station's assigned `user_ids`. |
| `DELETE` | `/:id` | `ROLE_ACCESS.ownerManager` | path: `id` | - |

### Orders

Router: `main/routes/orders.ts`. Full path: `/api/orders`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | `ROLE_ACCESS.sales` + order read limiter | query: `?status`, `?type`, `?today`, `?start_date`, `?end_date`, `?table_id`, `?before_id`, `?per_page` | `{ orders, table }`, newest page first. `?before_id` pages backwards. |
| `GET` | `/:id` | `ROLE_ACCESS.sales` + order read limiter | path: `id` | `{ ...order, items, table }`. |
| `POST` | `/` | `ROLE_ACCESS.sales` + order write limiter | body: `items`, `table_id`, `customer_id`, `type`, `guest_count`, `special_instructions`, `packaging_charge`, `delivery_charge`, `service_charge`, `online_platform`, `external_order_id`; header: `Idempotency-Key` | `201` with the created order. Honours an `Idempotency-Key` header; reusing a key with a different body returns `409`. |
| `POST` | `/:id/items` | `ROLE_ACCESS.sales` + order write limiter | path: `id`; body: `items`, `special_instructions`; header: `Idempotency-Key` | Appends items and returns the recomputed order. Honours `Idempotency-Key`. |
| `PATCH` | `/:id/status` | `ROLE_ACCESS.orderStatus` + order write limiter | path: `id`; body: `status`, `reason`, `override_pin`, `free_table` | Order-level transition. Allowed targets: `pending` to `preparing`, `ready`, `served`, `completed`, `cancelled`; `preparing` to `ready`, `served`, `completed`, `cancelled`; `ready` to `served`, `completed`, `cancelled`; `served` to `completed`, `cancelled`. `completed` and `cancelled` are terminal. Repeating the current status is a no-op. |
| `PATCH` | `/:id/customer` | `ROLE_ACCESS.ownerManager` + order write limiter | path: `id`; body: `customer_id` | - |
| `PATCH` | `/:id/convert-to-takeaway` | `ROLE_ACCESS.sales` + order write limiter | path: `id` | - |
| `PATCH` | `/:id/discount` | `ROLE_ACCESS.ownerManagerCashier` + order write limiter | path: `id`; body: `discount_type`, `discount_value`, `discount_reason`, `override_pin` | - |
| `PATCH` | `/:id/items/:itemId/discount` | `ROLE_ACCESS.ownerManagerCashier` + order write limiter | path: `id`, `itemId`; body: `discount_type`, `discount_value`, `override_pin` | - |

### Order item status

Router: `main/routes/order-items.ts`. Full path: `/api/order-items`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `PATCH` | `/:id/status` | any authenticated role + KDS-enabled | path: `id`; body: `status`, `expected_status` | Body `status` in `pending`, `preparing`, `ready`, `served`, plus optional `expected_status`. The `ROLE_ACCESS.kitchen` check runs inside the handler, not in the registration chain. |

### Held orders

Router: `main/routes/held-orders.ts`. Full path: `/api/held-orders`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | `ROLE_ACCESS.sales` + held-order read limiter | none | - |
| `POST` | `/` | `ROLE_ACCESS.sales` + held-order write limiter | none | - |
| `DELETE` | `/:tableId` | `ROLE_ACCESS.sales` + held-order write limiter | path: `tableId`; query: `?heldOrderId` | `?heldOrderId` selects one of several holds on the table. |

### Bills

Router: `main/routes/bills.ts`. Full path: `/api/bills`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | `ROLE_ACCESS.ownerManagerCashier` | query: `?status`, `?order_id`, `?customer_id`, `?today`, `?per_page`, `?limit`, `?offset` | `{ bills, pagination }`. |
| `GET` | `/:id` | `ROLE_ACCESS.ownerManagerCashier` | path: `id` | - |
| `GET` | `/order/:orderId` | `ROLE_ACCESS.ownerManagerCashier` | path: `orderId` | - |
| `POST` | `/generate` | `ROLE_ACCESS.ownerManagerCashier` | body: `order_id` | Creates or returns the bill for `order_id`. |
| `POST` | `/:id/split-check` | `ROLE_ACCESS.ownerManagerCashier` | body: `checks` | Body `checks` must hold between 2 and 20 entries. `403` when `split_checks_enabled` is off. |
| `POST` | `/:id/payment` | `ROLE_ACCESS.ownerManagerCashier` | path: `id`; body: payment line object, `customer_id`; header: `Idempotency-Key` | Body is a single payment line; `customer_id` is read off it. Honours `Idempotency-Key`; a key reused for a different request returns `409`. |
| `POST` | `/:id/payments` | `ROLE_ACCESS.ownerManagerCashier` | path: `id`; body: `payments`, `customer_id`; header: `Idempotency-Key` | Body `payments` is an array applied in one transaction. Honours `Idempotency-Key`. |
| `POST` | `/:id/applyDiscount` | `ROLE_ACCESS.ownerManager` | path: `id`; body: `type`, `value`, `reason`, `override_pin`, `manager_id`, `user_id` | - |
| `POST` | `/:id/markPrinted` | `ROLE_ACCESS.ownerManager` | path: `id` | - |
| `POST` | `/:id/print` | `ROLE_ACCESS.ownerManagerCashier` | path: `id`; body: `print_type` | - |
| `GET` | `/:id/print-history` | `ROLE_ACCESS.ownerManagerCashier` | path: `id` | Print jobs recorded for the bill, newest first. |

### Refunds

Router: `main/routes/refunds.ts`. Full path: `/api/refunds`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `POST` | `/` | `ROLE_ACCESS.ownerManager` | body: `bill_id`, `order_item_id`, `amount`, `reason`, `approver_id`, `manager_id`, `method`, `shift_id`, `override_pin`; header: `Idempotency-Key` | Creates a refund against `bill_id`, or a single `order_item_id`. `approver_id` must resolve to an active owner or manager whose Staff Approval PIN matches `override_pin`. `409` once the business day is closed. Honours `Idempotency-Key`. |
| `GET` | `/` | `ROLE_ACCESS.ownerManagerCashier` | query: `?bill_id`, `?limit`, `?offset` | Refund rows, newest first. |

### Payment methods

Router: `main/routes/payment-methods.ts`. Full path: `/api/payment-methods`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/merge-history` | `ROLE_ACCESS.ownerManager` | none | Record of method merges. |
| `GET` | `/` | `ROLE_ACCESS.allStaff` | query: `?include_inactive` | `{ payment_methods: [ ... ] }`. |
| `POST` | `/` | `ROLE_ACCESS.ownerManager` | body: `name` | - |
| `PUT` | `/:id` | `ROLE_ACCESS.ownerManager` | path: `id`; body: `name`, `is_active`, `sort_order` | - |
| `DELETE` | `/:id` | `ROLE_ACCESS.ownerManager` | path: `id` | - |
| `POST` | `/:id/merge` | `ROLE_ACCESS.ownerManager` | path: `id`; body: `target_type`, `target_id` | Folds a method into another; paid history is rewritten. |

### Cash sessions

Router: `main/routes/cash-sessions.ts`. Full path: `/api/cash-sessions`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `POST` | `/open` | `ROLE_ACCESS.ownerManagerCashier` | body: `opening_float_cents` | Body `opening_float_cents` (integer minor units, defaults to 0). |
| `GET` | `/current` | `ROLE_ACCESS.ownerManagerCashier` | none | The open shift, or `null` when none is open. |
| `POST` | `/:id/close` | `ROLE_ACCESS.ownerManagerCashier` | path: `id`; body: `notes` | Closes the shift with optional `notes`. |

### Cash closures

Router: `main/routes/cash-closures.ts`. Full path: `/api/cash-closures`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/movements` | `ROLE_ACCESS.ownerManagerCashier` | query: `?business_date` | Append-only cash-drawer history, newest first, including soft-voided rows. |
| `POST` | `/movements` | `ROLE_ACCESS.ownerManagerCashier` | body: `business_date`, `movement_type`, `amount_cents`, `reason` | - |
| `POST` | `/movements/:id/void` | `ROLE_ACCESS.ownerManager` | path: `id`; body: `reason` | - |
| `POST` | `/` | `ROLE_ACCESS.owner` | body: `business_date`, `opening_float_cents`, `counted_cash_cents`, `notes` | Closes a business date. `counted_cash_cents` is the physical count; the response carries the variance and the next `z_number`. |
| `POST` | `/:id/print` | `ROLE_ACCESS.ownerManagerCashier` | path: `id`; body: `isReprint` | Prints the close receipt. |

### Customers

Router: `main/routes/customers.ts`. Full path: `/api/customers`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `DELETE` | `/admin/cleanup` | `ROLE_ACCESS.owner` + customer write limiter | none | Owner-only customer cleanup. |
| `POST` | `/admin/repair-phones` | `ROLE_ACCESS.ownerManager` + customer write limiter | none | Rewrites stored phone values into canonical E.164 form. |
| `GET` | `/alerts` | `ROLE_ACCESS.sales` + customer read limiter | none | Customers with phone or data-quality problems. |
| `GET` | `/` | `ROLE_ACCESS.sales` + customer read limiter | query: `?search`, `?filter`, `?sort`, `?order`, `?per_page` | Paginated list; `?search`, `?filter`, `?sort`, `?order`, `?per_page`. |
| `GET` | `/:id` | `ROLE_ACCESS.sales` + customer read limiter | path: `id` | - |
| `GET` | `/:id/wallet` | `ROLE_ACCESS.sales` + customer read limiter | path: `id` | Wallet balance and loyalty state for the customer. |
| `POST` | `/` | `ROLE_ACCESS.sales` + customer write limiter | body: `phone`, `name`, `email`, `address`, `notes`, `country_code` | - |
| `PUT` | `/:id` | `ROLE_ACCESS.ownerManagerCashier` + customer write limiter | path: `id`; body: `phone`, `name`, `email`, `address`, `notes`, `country_code` | - |

### Staff and users

Router: `main/routes/staff.ts`. Full path: `/api/staff`, also mounted at `/api/users`.
Mounted at both `/api/staff` and `/api/users` from one router, so a request to either prefix reaches the same handlers.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | `ROLE_ACCESS.ownerManager` | query: `?role`, `?active` | `{ users: [ ... ] }`. |
| `GET` | `/:id` | `ROLE_ACCESS.ownerManager` | path: `id` | - |
| `POST` | `/` | `ROLE_ACCESS.ownerManager` + auth limiter | body: `name`, `email`, `password`, `role`, `pin`, `station_ids` | `201` with the new user id. |
| `PUT` | `/:id` | `ROLE_ACCESS.ownerManager` + auth limiter | path: `id`; body: `name`, `email`, `password`, `role`, `pin`, `is_active` | - |
| `POST` | `/:id/deactivate` | `ROLE_ACCESS.ownerManager` | path: `id` | - |
| `POST` | `/:id/reactivate` | `ROLE_ACCESS.ownerManager` | path: `id` | - |

### Printers

Router: `main/routes/printers.ts`. Full path: `/api/printers`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | any authenticated role | none | `{ printers: [ ... ] }`, default first. |
| `GET` | `/detect` | any authenticated role | none | - |
| `GET` | `/supported` | any authenticated role | none | - |
| `GET` | `/:id` | any authenticated role | path: `id` | Single printer. |
| `POST` | `/` | `ROLE_ACCESS.ownerManager` | body: `connection_type`, `ip_address`, `port`, `paper_width`, `is_default`, `cash_drawer_pulse_enabled`, `name` | - |
| `PUT` | `/:id` | `ROLE_ACCESS.ownerManager` | path: `id`; body: `connection_type`, `ip_address`, `port`, `paper_width`, `is_default`, `cash_drawer_pulse_enabled`, `name` | - |
| `DELETE` | `/:id` | `ROLE_ACCESS.ownerManager` | path: `id` | - |
| `POST` | `/:id/set-default` | `ROLE_ACCESS.ownerManager` | path: `id` | - |
| `POST` | `/:id/test` | `ROLE_ACCESS.ownerManager` | path: `id`; body: `rasterProbe` | - |
| `POST` | `/print-bill` | `ROLE_ACCESS.sales` | body: `billId`, `orderId`, `isReprint`, `preview`, `useUnicode`, `arabicShaping` | Body `billId` or `orderId`, plus `isReprint`, `preview`, `useUnicode`, `arabicShaping`. `preview` returns the rendered payload without sending it to the device. |
| `POST` | `/print-kot` | `ROLE_ACCESS.sales` | body: `orderId`, `stationName`, `items`, `useUnicode`, `arabicShaping` | Body `orderId`, optional `stationName` and `items`, plus `useUnicode` and `arabicShaping`. |

### Merchant print templates

Router: `main/routes/print-templates.ts`. Full path: `/api/print-templates`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | `ROLE_ACCESS.ownerManager` | none | - |
| `POST` | `/` | `ROLE_ACCESS.owner` + template write limiter | body: `name`, `payload`, `origin`, `derivedFrom` | - |
| `PUT` | `/:id` | `ROLE_ACCESS.owner` + template write limiter | path: `id`; body: `name`, `payload` | - |
| `POST` | `/:id/activate` | `ROLE_ACCESS.owner` + template write limiter | path: `id` | - |
| `POST` | `/:id/archive` | `ROLE_ACCESS.owner` + template write limiter | path: `id` | - |
| `POST` | `/:id/rollback` | `ROLE_ACCESS.owner` + template write limiter | path: `id` | - |
| `GET` | `/:id/payload` | `ROLE_ACCESS.ownerManager` | path: `id` | - |
| `GET` | `/:id/export` | `ROLE_ACCESS.owner` + template write limiter | path: `id` | - |
| `POST` | `/import` | `ROLE_ACCESS.owner` + template write limiter | body: `file` | - |

### Menu CSV

Router: `main/routes/menu-csv.ts`. Full path: `/api/menu-csv`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/template/:type` | `ROLE_ACCESS.ownerManager` | path: `type` | CSV header template for `categories`, `products`, or `addons`. |
| `GET` | `/export/categories` | `ROLE_ACCESS.ownerManager` | none | `text/csv` attachment `categories-export.csv`. |
| `GET` | `/export/products` | `ROLE_ACCESS.ownerManager` | none | `text/csv` attachment `products-export.csv`. |
| `GET` | `/export/addons` | `ROLE_ACCESS.ownerManager` | none | `text/csv` attachment `addons-export.csv`. |
| `POST` | `/import/categories` | `ROLE_ACCESS.ownerManager` | body: `csv` | Body `csv` is the raw file text. Per-row validation errors are reported in the response. |
| `POST` | `/import/products` | `ROLE_ACCESS.ownerManager` | body: `csv` | - |
| `POST` | `/import/addons` | `ROLE_ACCESS.ownerManager` | body: `csv` | - |

### Settings

Router: `main/routes/settings.ts`. Full path: `/api/settings`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/business` | `ROLE_ACCESS.allStaff` | none | - |
| `PUT` | `/business` | `ROLE_ACCESS.ownerManager` | body: `business_name`, `timezone`, `business_day_start_time`, `currency`, `country`, `language`, `tax_registration_number`, `state_code`, `business_address`, `business_phone`, `instagram_handle`, `billing_type`, `tables_required`, `tax_registered`, `bill_show_name`, `bill_show_address`, `bill_show_phone`, `bill_show_tax_id`, `bill_show_tax_breakdown`, `bill_show_customer_name`, `bill_show_customer_phone`, `bill_show_table_number`, `currency_display`, `number_digits`, `calendar`, `country_selected` | A `currency` that differs from the stored value returns `409` with `error: "currency_change_requires_reset"` plus `current_currency` and `requested_currency`. Currency changes go through the reset flow, not this route. |
| `GET` | `/tax` | `ROLE_ACCESS.allStaff` | none | - |
| `PUT` | `/tax` | `ROLE_ACCESS.ownerManager` | body: `tax_registered`, `tax_registration_number`, `state_code`, `tax_scheme`, `country` | - |
| `GET` | `/loyalty` | `ROLE_ACCESS.allStaff` | none | - |
| `PUT` | `/loyalty` | `ROLE_ACCESS.ownerManager` | body: `loyalty_enabled`, `global_cashback_percent` | - |
| `GET` | `/discount` | `ROLE_ACCESS.allStaff` | none | - |
| `PUT` | `/discount` | `ROLE_ACCESS.ownerManager` | body: `discount_max_percentage`, `discount_max_amount`, `discount_mode`, `discount_requires_approval` | - |
| `GET` | `/kds` | any authenticated role | none | KDS settings for the pre-login and display surfaces. Readable by any authenticated role. |
| `PUT` | `/kds` | `ROLE_ACCESS.ownerManager` | body: `kds_default_view` | - |
| `GET` | `/order-numbering` | `ROLE_ACCESS.allStaff` | none | - |
| `PUT` | `/order-numbering` | `ROLE_ACCESS.ownerManager` | body: `order_number_prefix`, `order_number_include_date`, `order_number_reset_daily`, `invoice_number_prefix`, `invoice_number_include_period`, `invoice_number_reset_period`, `invoice_financial_year_start_month`, `invoice_financial_year_start_day` | - |
| `GET` | `/cloud` | `ROLE_ACCESS.ownerManager` | none | - |
| `PUT` | `/cloud` | `ROLE_ACCESS.ownerManager` | body: `cloud_server_url`, `cloud_api_key`, `cloud_store_id`, `cloud_sync_enabled`, `cloud_orders_enabled`, `cloud_reports_enabled`, `cloud_command_polling_enabled` | - |
| `POST` | `/cloud/register` | `ROLE_ACCESS.ownerManager` | body: `cloud_server_url` | - |
| `POST` | `/cloud/test` | `ROLE_ACCESS.ownerManager` | none | - |
| `GET` | `/cloud/account` | `ROLE_ACCESS.owner` | none | - |
| `PUT` | `/cloud/account/preferences` | `ROLE_ACCESS.owner` | body: `product_updates`, `email_marketing` | Body `product_updates` and `email_marketing`. `409` when no cloud account is linked. |
| `POST` | `/cloud/account/verification` | `ROLE_ACCESS.owner` | none | - |
| `GET` | `/cloud/delete-data/status` | `ROLE_ACCESS.owner` | none | - |
| `POST` | `/cloud/stop-all` | `ROLE_ACCESS.owner` | none | - |
| `POST` | `/cloud/delete-data` | `ROLE_ACCESS.owner` + Master PIN | body: `confirmation` | Body `confirmation` must equal `DELETE CLOUD DATA`. |
| `POST` | `/cloud/delete-data/cancel` | `ROLE_ACCESS.owner` + Master PIN | none | - |
| `GET` | `/google-drive` | `ROLE_ACCESS.owner` | none | - |
| `PUT` | `/google-drive` | `ROLE_ACCESS.owner` | body: `frequency`, `retention_count`, `destination_folder_id`, `warning_acknowledged` | - |
| `GET` | `/google-drive/destinations` | `ROLE_ACCESS.owner` | none | - |
| `POST` | `/google-drive/destinations` | `ROLE_ACCESS.owner` | none | - |
| `POST` | `/google-drive/connect` | `ROLE_ACCESS.owner` | body: `allow_switch`, `warning_acknowledged` | - |
| `POST` | `/google-drive/disconnect` | `ROLE_ACCESS.owner` | none | - |
| `POST` | `/google-drive/backup-now` | `ROLE_ACCESS.owner` | body: `warning_acknowledged` | - |
| `GET` | `/google-drive/jobs/:jobId` | `ROLE_ACCESS.owner` | path: `jobId` | - |
| `POST` | `/google-drive/jobs/:jobId/cancel` | `ROLE_ACCESS.owner` | path: `jobId` | - |
| `GET` | `/google-drive/backups` | `ROLE_ACCESS.owner` | none | - |
| `POST` | `/google-drive/restore` | `ROLE_ACCESS.owner` + Master PIN | body: `confirmation`, `file_id`, `expected_sha256` | Body `confirmation` must equal the drive restore confirmation phrase, plus `file_id` and optional `expected_sha256`. `202` with a job handle. |
| `GET` | `/` | `ROLE_ACCESS.allStaff` | none | All settings. |
| `GET` | `/bill-templates` | `ROLE_ACCESS.ownerManager` | none | - |
| `PUT` | `/printing` | `ROLE_ACCESS.ownerManager` + settings write limiter | none | Body is the whole printing settings object; rejected with `400` when it is not an object. |
| `GET` | `/:key` | `ROLE_ACCESS.allStaff` + settings read limiter | path: `key` | One setting. Registered after every named route, so a named key resolves to its named handler. |
| `PUT` | `/:key` | `ROLE_ACCESS.ownerManager` + settings write limiter | path: `key`; body: `value` | Body `value`. Only the allow-listed non-sensitive keys are accepted; sensitive keys need their named route. `key: currency` returns `409 currency_change_requires_reset` on any value change. |

### Tax packs

Router: `main/routes/tax-packs.ts`. Full path: `/api/tax-packs`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | `ROLE_ACCESS.ownerManager` | none | Installed tax packs. |
| `GET` | `/audit` | `ROLE_ACCESS.ownerManager` | query: `?limit` | Tax pack audit trail; `?limit` bounds the page. |
| `GET` | `/catalog` | `ROLE_ACCESS.ownerManager` | none | Available packs and versions. |
| `GET` | `/updates` | `ROLE_ACCESS.ownerManager` | none | Installed packs with newer upstream versions. |
| `POST` | `/ensure-country` | `ROLE_ACCESS.ownerManager` | body: `acknowledge_community_disclaimer` | Resolves the pack for the configured country. |
| `POST` | `/manual-config` | `ROLE_ACCESS.owner` | body: `override` | Owner-only manual tax configuration. |
| `POST` | `/catalog/install` | `ROLE_ACCESS.owner` | body: `pack_id`, `version` | - |
| `POST` | `/test-calculation` | `ROLE_ACCESS.ownerManager` | body: `category_id`, `amount`, `tax_behavior` | - |
| `POST` | `/overrides` | `ROLE_ACCESS.owner` | body: `entity_type`, `entity_id`, `category_id` | - |
| `PUT` | `/overrides/:overrideId` | `ROLE_ACCESS.owner` | path: `overrideId`; body: `entity_type`, `entity_id`, `category_id` | - |
| `DELETE` | `/overrides/:overrideId` | `ROLE_ACCESS.owner` | path: `overrideId` | - |
| `POST` | `/:packId/versions/:versionId/activate` | `ROLE_ACCESS.owner` | path: `packId`, `versionId`; body: `acknowledge_community_disclaimer` | - |
| `POST` | `/:packId/versions/:versionId/reinstall` | `ROLE_ACCESS.owner` | path: `packId`, `versionId` | - |
| `POST` | `/:packId/rollback` | `ROLE_ACCESS.owner` | path: `packId` | Rolls a pack back to an earlier version. |
| `GET` | `/:packId` | `ROLE_ACCESS.ownerManager` | path: `packId` | - |

### KDS

Router: `main/routes/kds.ts`. Full path: `/api/kds`.
The role gate is a `router.use` layer below the `/pairing` mount, so it also applies to the `/pairing` reads.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/orders` | `ROLE_ACCESS.kitchen` + KDS-enabled | query: `?station_id` | `{ orders, counts }`, same projection as the WebSocket `initial_data` frame. |
| `GET` | `/pairing` | `ROLE_ACCESS.kitchen` + KDS-enabled (404) | none | Paired display state for the caller's stations. |
| `POST` | `/pairing` | `ROLE_ACCESS.ownerManager` | body: `station_id` | Registers a display against `station_id`. |
| `GET` | `/display` | `ROLE_ACCESS.kitchen` + KDS-enabled | query: `?station_id` | Display-mode view of the same snapshot. |
| `PATCH` | `/items/:id/status` | `ROLE_ACCESS.kitchen` + KDS-enabled | path: `id`; body: `status`, `expected_status` | Body `status` in `pending`, `preparing`, `ready`, `served`, plus optional `expected_status` for a compare-and-set. Station and category scope are re-checked inside the write transaction. |

### Kitchen

Router: `main/routes/kitchen.ts`. Full path: `/api/kitchen`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/orders` | `ROLE_ACCESS.kitchen` + KDS-enabled | none | `{ orders, counts }`. The `:3001` REST equivalent of the KDS WebSocket snapshot. |

### KDS info

Router: `main/routes/kds-info.ts`. Full path: `/api/kds-info`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | any authenticated role | none | `{ mdns_url, ip_url, qr_url, qr_data_url, ips_data }`. URLs point at the KDS port with **no path suffix**. `ips_data` is one `{ ip, url, qr_data }` per local address. |

### POS info

Router: `main/routes/pos-info.ts`. Full path: `/api/pos-info`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | any authenticated role | none | `{ mdns_url, ip_url, qr_url, qr_data_url, ips_data }` for the main API port. |

### Server App info

Router: `main/routes/server-app-info.ts`. Full path: `/api/server-app-info`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | any authenticated role | none | - |

### More apps

Router: `main/routes/more-apps.ts`. Full path: `/api/more-apps`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/` | any authenticated role | none | - |
| `GET` | `/revflo` | any authenticated role | none | - |

### WhatsApp

Router: `main/routes/whatsapp.ts`. Full path: `/api/whatsapp`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/status` | `ROLE_ACCESS.ownerManagerCashier` | none | Connection state. Deliberately omits the raw QR string; `/qr` renders it. |
| `POST` | `/settings` | `ROLE_ACCESS.ownerManager` | none | - |
| `GET` | `/qr` | `ROLE_ACCESS.ownerManager` | none | Rendered QR image for pairing. |
| `GET` | `/pairing-code` | `ROLE_ACCESS.ownerManager` | none | - |
| `POST` | `/enable` | `ROLE_ACCESS.ownerManager` | none | - |
| `POST` | `/disable` | `ROLE_ACCESS.ownerManager` | none | - |
| `POST` | `/connect` | `ROLE_ACCESS.ownerManager` | body: `method`, `phone` | - |
| `POST` | `/disconnect` | `ROLE_ACCESS.ownerManager` | none | - |
| `POST` | `/send` | `ROLE_ACCESS.ownerManagerCashier` | body: `bill_id`, `phone_e164`, `body`, `kind` | Body `bill_id` or `phone_e164`, `body`, `kind`. |
| `GET` | `/messages` | `ROLE_ACCESS.ownerManagerCashier` | query: `?limit`, `?offset`, `?direction`, `?status`, `?phone`, `?bill_id` | - |
| `GET` | `/inbox` | `ROLE_ACCESS.ownerManager` | query: `?limit`, `?offset` | - |
| `POST` | `/inbox/:messageId/reply` | `ROLE_ACCESS.ownerManager` | path: `messageId`; body: `body` | Replies to an inbound message. |
| `GET` | `/blocklist` | `ROLE_ACCESS.ownerManager` | none | - |
| `POST` | `/blocklist` | `ROLE_ACCESS.ownerManager` | body: `phone_e164`, `reason` | Body `phone_e164` and `reason`. |
| `DELETE` | `/blocklist/:phone` | `ROLE_ACCESS.ownerManager` | path: `phone` | Removes a blocked number. |

### Support tickets

Router: `main/routes/support-ticket.ts`. Full path: `/api/support-ticket`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/profile` | `ROLE_ACCESS.allStaff` | none | - |
| `GET` | `/diagnostics-preview` | `ROLE_ACCESS.allStaff` | query: `?category` | - |
| `GET` | `/:clientTicketId/status` | `ROLE_ACCESS.allStaff` | path: `clientTicketId` | - |
| `POST` | `/` | `ROLE_ACCESS.allStaff` | none | - |
| `GET` | `/pre-login/profile` | any authenticated role + pre-login limiter | none | Unauthenticated tenant profile for the login-screen ticket form. Body limit 300kb on this subtree. |
| `GET` | `/pre-login/:clientTicketId/status` | any authenticated role + pre-login limiter | path: `clientTicketId` | Unauthenticated ticket status lookup; `clientTicketId` must be a UUID. |
| `POST` | `/pre-login` | any authenticated role + pre-login limiter | none | Unauthenticated ticket creation from the login screen. Body limit 300kb on this subtree. |

### Diagnostics

Router: `main/routes/diagnostics.ts`. Full path: `/api/diagnostics`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `POST` | `/event` | `ROLE_ACCESS.allStaff` + diagnostics write limiter | none | Consent-gated diagnostic event intake. |

### Database

Router: `main/routes/database.ts`. Full path: `/api/db`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/export` | `ROLE_ACCESS.owner` | none | Full database snapshot as a downloadable JSON attachment. |
| `POST` | `/import` | `ROLE_ACCESS.owner` + Master PIN when `overwrite` or a schema-version mismatch | body: `data`, `overwrite` | Body `data` plus `overwrite`. Master PIN is required when `overwrite` is set or the snapshot's `schema_version` differs from the local one. |
| `POST` | `/backup` | `ROLE_ACCESS.owner` + Master PIN | none | - |
| `GET` | `/download` | `ROLE_ACCESS.owner` + Master PIN | none | - |
| `GET` | `/tables` | `ROLE_ACCESS.owner` | none | `{ tables: [ ... ] }`, every non-internal SQLite table name. |

### Database tools

Router: `main/routes/database-tools.ts`. Full path: `/api/db-tools`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/health-check` | `ROLE_ACCESS.owner` | none | - |
| `POST` | `/apply-safe-fixes` | `ROLE_ACCESS.owner` | none | - |
| `GET` | `/backups` | `ROLE_ACCESS.owner` | none | - |
| `POST` | `/backups/:fileName/delete` | `ROLE_ACCESS.owner` + Master PIN | path: `fileName` | - |
| `GET` | `/master-pin/status` | `ROLE_ACCESS.owner` | none | - |
| `POST` | `/master-pin/reset` | `ROLE_ACCESS.owner` | body: `pin`, `confirm_pin` | - |
| `GET` | `/currency-reset-impact` | `ROLE_ACCESS.owner` | none | Active currency plus the invoice, order, refund, customer, product, and add-on counts the destructive warning uses. |
| `POST` | `/currency-reset` | `ROLE_ACCESS.owner` + Master PIN | body: `currency` | Also needs `current_currency` and `confirmation_phrase` of the form `CHANGE TO <CODE>`. Creates a recovery backup, recreates the local database, preserves the sanitized menu catalog with monetary fields zeroed, and returns the backup path. The active session becomes invalid. |
| `POST` | `/initialize` | `ROLE_ACCESS.owner` + Master PIN | body: `confirmation_phrase` | Master-PIN gated database initialization. |

### Reports

Router: `main/routes/reports.ts`. Full path: `/api/reports`.

Report date parameters are tenant business dates. Each `YYYY-MM-DD` value is interpreted in the
store's configured timezone and business-day start time, and omitted dates default to the tenant's
current business date. See [business time](../architecture/business-time.md) for the storage and
day-boundary rules.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/daily-stats` | `ROLE_ACCESS.ownerManager` | none | Today only; no date parameter. |
| `GET` | `/summary` | `ROLE_ACCESS.ownerManager` | query: `?date` | Summary for one business date. |
| `GET` | `/financial-summary` | `ROLE_ACCESS.owner` | query: `?start_date`, `?end_date` | Owner-only collection summary and refund audit for a range. Refunds are attributed to the original bill payment date, so gross, refund, net, and payment-method totals reconcile over the selected period. |
| `GET` | `/tax-components` | `ROLE_ACCESS.ownerManager` | query: `?start_date`, `?end_date` | - |
| `GET` | `/sales` | `ROLE_ACCESS.ownerManager` | query: `?start_date`, `?end_date` | - |
| `GET` | `/topProducts` | `ROLE_ACCESS.ownerManager` | query: `?start_date`, `?end_date`, `?limit` | - |
| `GET` | `/recentOrders` | `ROLE_ACCESS.ownerManager` | query: `?limit`, `?date`, `?start_date`, `?end_date` | - |
| `GET` | `/tables` | `ROLE_ACCESS.ownerManager` | none | Table-level utilisation for the current business date; no date parameter. |
| `GET` | `/insights` | `ROLE_ACCESS.ownerManager` | query: `?days` | - |
| `GET` | `/x-report` | `ROLE_ACCESS.ownerManager` | query: `?date` | Live day report. Recomputed on every read. `openingFloatCents` is reported for context and is excluded from `expectedCashCents`, which includes cash sales, Pay In, Pay Out, Safe Drop, and cash refunds by `refunds.created_at`. The stored Z adds the opening float at close, so same-day X and Z expected values differ by exactly `opening_float_cents`. |
| `GET` | `/z-report` | `ROLE_ACCESS.ownerManager` | query: `?date` | The immutable close snapshot for one business date. `404` with `{ error: "Day not closed", alreadyClosed: false, businessDate }` when no close row exists. The `zReport` object carries integer-minor-unit `*_cents` fields, `payment_methods`, `staff_sales`, `tax_components`, and `cash_movements` arrays, plus `z_number`, `closed_by`, `closed_by_name`, `notes`, `created_at`, `business_date`, `period_start`, and `period_end`. `variance_cents` is `counted_cash_cents - expected_cash_cents` and may be negative. |
| `GET` | `/daily-sales/export` | `ROLE_ACCESS.owner` | query: `?date`, `?format`, `?part` | See [GET `/api/reports/daily-sales/export`](#get-apireportsdaily-salesexport). |

### GET `/api/reports/daily-sales/export`

Owner-only daily sales export for one tenant business date. Returns either a single XLSX workbook
(`Summary` and `Items` sheets) or one half of a two-file CSV pair. Accounting and row grouping live
entirely in `buildDailySalesExportDataset`; the endpoint only serializes and sets headers. See
[daily sales export](daily-sales-export.md) for the full reconciliation contract, the summary metric
field order, and the Items columns.

| Param | Values | Notes |
| --- | --- | --- |
| `date` | `YYYY-MM-DD` | Tenant business date; defaults to the current business date. |
| `format` | `xlsx` or `csv` | Required. Any other value returns `400`. |
| `part` | `summary` or `items` | Required when `format=csv`; ignored for `xlsx`. Missing on CSV returns `400`. |

- `format=xlsx` returns `200` with `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and `Content-Disposition: attachment; filename="daily-sales-YYYY-MM-DD.xlsx"`. Money cells are numeric with a currency-fraction-digit number format; the workbook holds no formulas.
- `format=csv&part=summary` returns `text/csv` with header `metric,value`.
- `format=csv&part=items` returns `text/csv` with header `product_id,product_name,product_sku,quantity,gross_item_sales,item_discounts,net_item_sales,tax_amount`.

Errors: `400` for an invalid `format` or a CSV without `part`; `401` unauthenticated; `403` non-owner;
`409` for a concurrent-write conflict; `500` otherwise. CSV cells that would start with `=`, `+`,
`-`, or `@` and are not numeric are neutralized with a leading quote. The CSV decimal separator is
always ASCII `.`.

### Inline endpoints (registered outside a router)

These nine are declared on `app` inside `registerRoutes` in `main/routes/index.ts`, not on a
router. Every path below is absolute; there is no mount prefix.

Router: declared inline in `main/routes/index.ts`.

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `POST` | `/api/tax/preview` | any authenticated role | body: `items`, `customer_id`, `packaging_charge`, `delivery_charge`, `service_charge`, `discount_type`, `discount_value` | `400` when `items` is missing or empty. Returns the tax rollup for a hypothetical basket without persisting anything. This endpoint carries **no** `requireRole` gate: any authenticated role may price a basket. |
| `GET` | `/api/tax/categories` | `ROLE_ACCESS.ownerManager` | none | `{ pack_id, country, categories, default_category_id, configuration_ready, unclassified_category_id }`. `categories` is empty until the pack's configuration is complete. |
| `GET` | `/api/mobile/pairing-code` | `ROLE_ACCESS.owner` | none | `{ pairing_code, expires_at, qr_data_url }`. Returns the cached code when one is live, otherwise generates one. `409` when the store is not yet claimed in FloAdmin; `502` for any other cloud failure. |
| `POST` | `/api/mobile/rotate-code` | `ROLE_ACCESS.owner` | none | Same shape as the read, and every already paired RevFlo device is disconnected. |
| `GET` | `/api/mobile/devices` | `ROLE_ACCESS.owner` | none | `{ devices: [ ... ] }`. `502` when FloAdmin is unreachable. |
| `GET` | `/api/customers-search` | `ROLE_ACCESS.sales` | query: `q` | Flat array of at most 20 active customers, each with a `wallet_balance`. `q` shorter than 2 characters returns `[]`. A query with no letters is treated as phone-like and matched against stored phone digits. |
| `GET` | `/api/crm/lookup` | `ROLE_ACCESS.sales` | query: `phone`, `country_code` | `{ found, customer }`. `400` when `phone` is missing. The number is normalized to E.164 against the tenant country before lookup. |
| `PATCH` | `/api/orders/:orderId/items/:itemId/cancel` | any authenticated role, then an in-handler role check | path: `orderId`, `itemId`; body: `override_pin`, `reason`, `manager_id` | See the note below. Returns `{ order: { ...order, items } }`. |
| `PATCH` | `/api/orders/:orderId/items/:itemId/restore` | in-handler `ROLE_ACCESS.ownerManager` | path: `orderId`, `itemId` | Returns `{ order: { ...order, items } }`. `400` on a completed or cancelled order or a paid one. Re-deducts inventory and recipe components, and rescales an order-level percentage discount. |

Both item endpoints read the caller's role from the database inside an IMMEDIATE transaction rather
than from the JWT claim, and re-run every policy check there.

`PATCH .../cancel` is a policy switch, not a plain status write:

- `403` for a role outside `ownerManager` and `cashierServer`. `cashierServer` is accepted only when
  the item is in `preparing` or `ready`, and only with `override_pin`. An owner or manager can
  cancel a terminal item without a PIN, in which case the call is a no-op that returns the current
  state.
- `409` when any bill for the order is paid, partially paid, or carries payment details.
- `400` when the order is `completed` or `cancelled`.
- Voiding an item in preparation writes a mirrored negative `order_items` row with status
  `void_adjustment` and marks the original `voided`, so the bill total adjusts while the original
  line stays visible. Inventory is not restored on the void path. A plain cancel sets the item to
  `cancelled` and restores the recorded inventory deduction and recipe components.
- Cancelling the last active item cancels the order and frees its table.
- `override_pin` attempts are rate limited per client IP, not per item, to slow brute force.

## KDS server (`:3002`)

The KDS server reads the same database as the main API. Its whole surface:

| Method | Path | Authorization | Parameters | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/api/health` | none | none | `{ status, service, version, timestamp }` |
| `GET` | `/api/kds/info` | none | none | `{ language, country, kds_default_view }` for the pre-login display. `404` when KDS is disabled, so the surface is not advertised to the LAN. |
| `POST` | `/api/auth/login` | none, `authRateLimit` | body: `email`, `password` | `{ access_token, user: { id, name, email, role, category_ids, station_ids, station_assignments_configured } }`. 24-hour token. `403` for a role outside `kitchen`. |
| `POST` | `/api/auth/logout` | bearer token, not role-gated | none | `{ message }`. Revokes the token. |
| `GET` | `/api/auth/me` | `ROLE_ACCESS.kitchen` | none | `{ user: { id, name, email, role } }` |
| `GET` | `/api/kds/orders` | `ROLE_ACCESS.kitchen` | none | `{ orders, counts }`, the same projection and the same category and station narrowing as the WebSocket `initial_data` frame. `403` when KDS is disabled or the caller has no active station. |
| `PATCH` | `/api/kds/items/:id/status` | `ROLE_ACCESS.kitchen` | path: `id`; body: `status`, `expected_status` | `{ success: true }`. `400` for a terminal or voided item, `403` for a station or category the caller does not cover, `409` when the row changed before the write. |
| `GET` | `/api/categories` | `ROLE_ACCESS.kitchen` | none | `{ categories: [ ... ] }` narrowed to the caller's station and category scope. |

Plus three static handlers: `express.static` over the frontend export, `GET /` redirecting to
`/kds-standalone`, and a `GET /*splat` fallback that serves the standalone KDS page.

`PATCH /api/kds/items/:id/status` re-verifies the caller's active status, token revocation, and token
staleness **inside** its `IMMEDIATE` transaction, so a session revoked between the middleware and the
write cannot land a status change.

The KDS server's `requireAuth` reads the user row on every request and does not cache it, unlike the
main API's 30-second cache. See
[three separate token-verification middlewares](../architecture/authentication-and-authorization.md#three-separate-token-verification-middlewares).

## Server App (`:3003`)

The Server App implements no business logic. It authenticates the caller, checks the role against
`ROLE_ACCESS.serverApp` (server, manager, owner), and forwards an explicit allowlist to
`http://127.0.0.1:<main port>/api/...`. [System overview](../architecture/overview.md#the-server-app-is-a-filtered-proxy-not-a-second-api)
owns that boundary model; this section is the allowlist.

Nineteen routes in total, eleven of which forward:

| Method | Path | Forwards to |
| --- | --- | --- |
| `GET` | `/api/categories` | `GET /api/categories` |
| `GET` | `/api/products` | `GET /api/products` |
| `GET` | `/api/tables` | `GET /api/tables` |
| `GET` | `/api/orders` | `GET /api/orders` |
| `POST` | `/api/orders` | `POST /api/orders` |
| `POST` | `/api/orders/:id/items` | `POST /api/orders/:id/items` |
| `GET` | `/api/customers-search` | `GET /api/customers-search` |
| `GET` | `/api/crm/lookup` | `GET /api/crm/lookup` |
| `POST` | `/api/customers` | `POST /api/customers` |
| `POST` | `/api/printers/print-kot` | `POST /api/printers/print-kot` |
| `POST` | `/api/printers/print-bill` | `POST /api/printers/print-bill` |

Adding a route to `3001` does not expose it on `3003`. A path becomes reachable from the Server App
only when a forwarding route is added to `main/server-app.ts`.

The seven routes that are not forwards:

| Method | Path | Authorization | Response |
| --- | --- | --- | --- |
| `GET` | `/api/health` | none | `{ status, service, version, timestamp }` |
| `GET` | `/api/server-app/info` | none | `{ language, country, currency, currency_symbol, currency_position, currency_fraction_digits, kds_enabled }`. `404` when the feature is disabled; `409` with `error: "regional_not_configured"` when the regional snapshot cannot be resolved. |
| `POST` | `/api/auth/login` | none, `authRateLimit` | Body `email`, `password`, `remember_me`. `{ access_token, user: { id, name, email, role } }`; 24 hours, or 10 days with `remember_me`. `403` for a role outside `ROLE_ACCESS.serverApp`. |
| `GET` | `/api/auth/me` | `ROLE_ACCESS.serverApp` | `{ user: { id, name, email, role } }` |
| `POST` | `/api/auth/logout` | `ROLE_ACCESS.serverApp` | `{ success: true }`, revoking the token |
| `GET` | `/` | none | Redirect to `/server-standalone` |
| `GET` | `/*splat` | none | Static bundle, falling back to the `/server-standalone` page |

When the frontend export is missing, the `GET /` redirect is replaced by a placeholder page instead,
so `GET /` is two mutually exclusive registrations rather than two routes.

`requireServerAppAuth` is applied to every route except `/api/health` and `/api/server-app/info`, and
it runs the feature check **before** the token check. Behaviour by condition:

- Feature disabled: `404` with `{ error: "Not found" }`, so the surface is not advertised.
- Main API unreachable: `502` with `{ error: "Could not reach the local POS API" }` from the
  forwarding layer.
- Request aborted by shutdown: `503` with an empty body.

The forwarder relays the upstream status, content type, and body verbatim, and passes the method,
query string, `Authorization` header, `Idempotency-Key`, and JSON body upstream. Three limiters on
`3003` run **before** authentication: 150 requests per minute across `/api`, 150 per minute on
`POST /api/customers`, and 30 per minute shared by the two print forwarders. Each returns `429` when
exceeded.

## KDS WebSocket (`/kds`)

One connection contract, implemented once in
[`main/services/kds.ts`](../../main/services/kds.ts) and served on both `:3001` and `:3002`.

### Connecting

Open `ws://<host>:<port>/kds` on `3001` or `3002`. The upgrade handler answers before the upgrade
completes:

| Condition | Response |
| --- | --- |
| Path is not `/kds` | `404`, socket destroyed |
| Database maintenance in progress | `503`, socket destroyed |
| KDS disabled (`kds_enabled` off) | `404`, socket destroyed |
| Otherwise | upgraded, and a `connected` frame is sent immediately |

### Handshake

1. On connect the server sends `connected`.
2. The client sends `auth` with a bearer JWT. A display must authenticate within
   `KDS_AUTH_TIMEOUT_MS`, 5 seconds; otherwise the server sends `auth_error` and closes with code
   `1008`.
3. On success the server sends `auth_success`, then sends `initial_data` as a **separate frame**.

`auth_success` carries a `user` object and nothing else:

```json
{
  "type": "auth_success",
  "user": {
    "id": "chef-1",
    "name": "Chef One",
    "role": "chef",
    "categoryIds": ["cat-1", "cat-2"],
    "stationIds": ["station-1"]
  }
}
```

It does not carry `orders` or `counts`. A client that waits for the order list on this frame waits
forever.

### Frames the server sends

| Type | Carries | When |
| --- | --- | --- |
| `connected` | `message`, `timestamp` | Immediately on connect |
| `auth_success` | `user` (see above) | After a successful `auth` |
| `initial_data` | `orders`, `counts` | After `auth_success`, and on every subsequent broadcast |
| `status_updated` | `order_item_id`, `status` | After the requesting client's own `status_update` succeeds |
| `pong` | `timestamp` | In reply to a `ping` |
| `error` | `message` | A rejected client message or a rejected status update |
| `auth_error` | `message` | Before the server closes an unauthenticated or revoked session |

### Frames the server accepts

The message switch in `handleMessage` accepts exactly three types. Anything else gets
`{ "type": "error", "message": "Unknown message type" }`.

| Type | Fields | Notes |
| --- | --- | --- |
| `auth` | `token` | Only accepted before authentication. Any other type before auth closes the connection. |
| `status_update` | `order_item_id`, `status`, optional `expected_status` | `status` must be one of `pending`, `preparing`, `ready`, `served`. |
| `ping` | none | Answered with `pong`. |

`expected_status` turns the write into a compare-and-set. Without it the update excludes the
terminal statuses in its `WHERE` clause. With it, a row whose status has changed returns
`Item status changed; refresh and try again`.

### Every update is a full snapshot

There is no incremental order event. `notifyKdsUpdate` and `broadcastOrderUpdate` both call
`sendActiveOrders`, which recomputes the caller's visible orders and counts and sends the result as a
complete `initial_data`. A client must replace its board wholesale on every `initial_data` frame. The
`status_updated` frame is an acknowledgement for the requesting client only; other displays learn
about the change through their own `initial_data`.

Broadcasts are coalesced: a burst of `notifyKdsUpdate` calls within one microtask produces one
snapshot per client.

### Errors a display must handle

| `error` message | Cause |
| --- | --- |
| `Unknown message type` | A client frame the switch does not accept |
| `order_item_id and status required` | A `status_update` missing either field |
| `Invalid status. Use: pending, preparing, ready, served` | A `status_update` outside the allowed set |
| `Invalid expected status. Use: ...` | A malformed `expected_status` |
| `Item not found` | Unknown `order_item_id` |
| `This item has been voided and can no longer be updated` | The item was voided |
| `This bill adjustment cannot be updated from KDS` | The item is a `void_adjustment` row |
| `This terminal item cannot be updated from KDS` | `completed`, `cancelled`, or `refunded` |
| `Not authorized to update this station` | Outside the caller's station scope |
| `Not authorized to update this item` | Outside the caller's category scope |
| `Item status changed; refresh and try again` | The compare-and-set lost |
| `Could not update item status` | The write threw |

`auth_error` precedes a close on: `Authentication required` (no `auth` in time, or any non-`auth`
frame before authenticating), `Invalid or revoked token`, `User not found`, `Only kitchen staff can
access KDS`, `No active kitchen station is assigned to this user`, and `Could not load station
permissions`. The 30-second heartbeat also closes a session with `Session expired or revoked` when
the token or role stops being valid, and with `KDS is disabled` or `Database maintenance in progress`
when the store setting changes under a live connection.

### Connection limits

- 100 connected clients, and at most 25 of them unauthenticated. Over either cap the server closes
  with `1013`.
- A client whose `bufferedAmount` exceeds 1 MB at send time is closed with `1013` as too slow.
- The server sends a WebSocket ping every 30 seconds and terminates a client that misses one.
- A client is re-sent a fresh `initial_data` without any change of its own when its category or
  station assignment changes, or when the voided-item expiry marker moves.

## KDS category and station scoping

Two independent narrowing axes decide what a chef sees. Both are resolved at connect time and
re-resolved on every broadcast, and both are re-checked inside the write transaction for a
`status_update`.

**Categories.** `categoryIds` is the empty list for `owner` and `manager`, which means unrestricted,
and the parsed `users.category_ids` for everyone else. When the list is non-empty, an item is
visible only if its product's category is in the list.

**Stations.** `stationIds` comes from `getUserKdsStationIds`. When a user has station assignments
configured but none active, authentication is refused with `No active kitchen station is assigned to
this user` rather than silently showing an empty board. `getKdsStationRoutingScope` resolves each
assigned station into a set of categories, plus a separate set for orders on tables with no
`kitchen_station_id`, and reports whether any station is unrestricted.

An order is in scope when its table's `kitchen_station_id` is one of the caller's stations, or when
the table has no station and the order contains an item in a tableless routing category, or when the
caller has an unrestricted station. An item is then in scope when `isKdsStationItemAllowed` passes
for that station and category set, and the category filter above also passes. The `counts` map is
computed with the same scope, so it always matches the orders it accompanies.

Three statuses are hidden from every KDS surface: `void_adjustment` rows (the mirrored line a void
writes, which is a bill adjustment rather than a kitchen item), and `completed`, `cancelled`, and
`refunded` items. A `voided` item stays visible for `KDS_VOIDED_ITEM_VISIBILITY_MS` after its
`voided_at` timestamp and then ages off the board; the 30-second heartbeat notices the change and
pushes a fresh snapshot.

`projectKdsOrder` and `projectKdsItem` receive a `restrictedPayload` flag, true for `chef` and for
anyone with a non-empty category or station scope, false for an unrestricted `owner` or `manager`.
Unrestricted sessions receive the fuller row.

The same two axes are applied by `GET /api/kds/orders`, `GET /api/kitchen/orders`, and
`PATCH /api/kds/items/:id/status` on `:3002`. See
[KDS station and category narrowing](../architecture/authentication-and-authorization.md#kds-station-and-category-narrowing)
for the authorization framing.

## Refunds

Refund eligibility, approval tiers, the Staff Approval PIN rules, and how refund amounts are stored
belong to [product invariants](product-invariants.md#refunds-and-staff-approval-pins). This page
documents only the two routes.

## Cross-references

| Subject | Page |
| --- | --- |
| Which processes run, on which ports, and the port retry ladder | [System overview](../architecture/overview.md) |
| Token issuance, verification, revocation, staleness, Master PIN, audit attribution | [Authentication and authorization](../architecture/authentication-and-authorization.md) |
| What each role sees in the interface | [Roles and permissions](roles-and-permissions.md) |
| Refund approval rules and refund amount storage | [Product invariants](product-invariants.md) |
| Daily sales export accounting and reconciliation contract | [Daily sales export](daily-sales-export.md) |
| Merchant print template payload and offline transfer format | [Merchant print templates](merchant-print-templates.md) |
| Business dates, day boundaries, and timestamp storage | [Business time](../architecture/business-time.md) |
| Printer drivers, ESC/POS, and print routing | [Printing architecture](../architecture/printing.md) |
| Device Master PIN second factor | [`main/middleware/master-pin.ts`](../../main/middleware/master-pin.ts) |

## Coverage

This page lists 294 HTTP route registrations across 293 distinct rows, and one WebSocket contract:

- `267` on the main API: 257 router registrations, 9 inline registrations in `main/routes/index.ts`,
  and `GET /api/health` in `main/server.ts`.
- `8` REST routes on the KDS server, plus 3 static handlers.
- `19` route registrations on the Server App, of which 11 forward to the main API. Two of those 19
  are mutually exclusive `GET /` handlers under one path, which is why 19 registrations render as 18
  rows.

Every one of the 293 rows is listed with its method, path, authorization gate, and the parameters
its handler reads. The **Response** column carries a note for 157 of them: 131 main-API endpoints,
all 8 KDS-server routes, and the 18 Server App routes. The remaining 136 main-API endpoints are
listed with method, path, gate, and parameters only, and this page asserts nothing about what they
return. Those rows are complete as a route inventory and silent as a contract; the handler in
`main/routes/` is authoritative for them. A `-` in the Response column means that, not that the
endpoint does nothing.

The route inventory is maintained by hand against the route files, not generated. The role groups,
parameters, and rate limiters in the tables were read out of the route registrations themselves, but
a route added after this page was last checked will not appear until someone adds it here.

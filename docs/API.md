# Flo API Documentation

## Base URL

**Local:** `http://flo.local:3001` or `http://<local-ip>:3001`

The standalone Server App listens on `http://<local-ip>:3003` and forwards
these protected routes to the local API. Its customer-creation forwarder is
limited to 150 requests per minute per client IP, including LAN/private IPs.
The `POST /api/printers/print-kot` and `POST /api/printers/print-bill`
forwarders share a limit of 30 requests per minute per client IP. These limits
run before Server App authentication and return HTTP `429` when exceeded.

---

## Authentication

### POST `/api/auth/login`
Authenticate user and receive JWT token.

**Request:**
```json
{
  "email": "chef1@flo.local",
  "password": "chef123"
}
```

**Response (200):**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "user": {
    "id": "chef-1",
    "name": "Chef One",
    "email": "chef1@flo.local",
    "role": "chef",
    "category_ids": ["cat-1", "cat-2"]
  }
}
```

**Error (401):**
```json
{
  "error": "Invalid credentials"
}
```

### POST `/api/auth/password/change`
Change the authenticated user's password.

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "current_password": "chef123",
  "password": "NewChef123"
}
```

**Response (200):**
```json
{
  "message": "Password changed successfully"
}
```

Incorrect current-password attempts return `400` with `attempts_remaining`. After five incorrect attempts for the same user, password-change attempts for that user are locked for five minutes; the fifth response reports `attempts_remaining: 0` and `lockout_minutes: 5`. Further attempts during the lockout return `429`. A valid current password or an expired lockout resets the per-user failed-attempt counter. This endpoint also uses the LAN-aware authentication rate limiter.

---

## User Management

### GET `/api/users`
List all users (owner/manager only).

**Headers:** `Authorization: Bearer <token>`

**Response (200):**
```json
{
  "users": [
    {
      "id": "user-1",
      "name": "Owner",
      "email": "admin@flo.local",
      "role": "owner",
      "is_active": 1
    }
  ]
}
```

---

### POST `/api/users`
Create new user.

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "name": "Chef One",
  "email": "chef1@flo.local",
  "password": "chef123",
  "role": "chef",
  "category_ids": ["cat-1", "cat-2"]
}
```

**Response (201):**
```json
{
  "success": true,
  "id": "chef-1"
}
```

---

### PATCH `/api/users/:id`
Update user details.

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "name": "Updated Name",
  "role": "manager",
  "category_ids": ["cat-1", "cat-2", "cat-3"]
}
```

---

### DELETE `/api/users/:id`
Delete user.

**Headers:** `Authorization: Bearer <token>`

---

## Categories

### GET `/api/categories`
List all categories.

**Headers:** `Authorization: Bearer <token>`

**Response (200):**
```json
{
  "categories": [
    { "id": "cat-1", "name": "Food", "is_active": 1 },
    { "id": "cat-2", "name": "Beverages", "is_active": 1 },
    { "id": "cat-3", "name": "Desserts", "is_active": 1 }
  ]
}
```

---

### POST `/api/categories`
Create category.

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "name": "Appetizers"
}
```

---

### PATCH `/api/categories/:id`
Update category.

---

### DELETE `/api/categories/:id`
Delete category.

---

## Products

### GET `/api/products`
List all products.

**Headers:** `Authorization: Bearer <token>`

**Query params:** `?category_id=cat-1&is_active=1`

**Response (200):**
```json
{
  "products": [
    {
      "id": "prod-1",
      "name": "Cheeseburger",
      "price": 250.0,
      "category_id": "cat-1",
      "is_active": 1,
      "has_addons": true
    }
  ]
}
```

---

### POST `/api/products`
Create product.

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "name": "Veggie Wrap",
  "price": 180.0,
  "category_id": "cat-1",
  "has_addons": false
}
```

---

Product `stock_quantity` is the current stock cache. Every non-zero stock
change is committed atomically with an append-only row in the inventory
movement ledger. Supplying a non-zero `stock_quantity` when creating a product
records an `adjustment` movement with `reference_type: "opening_balance"`.
The optional `reason` field supplies the opening-balance reason.

### PUT `/api/products/:id`
Update product (owner or manager only). Supplying `stock_quantity` sets the
target stock through an audited `adjustment` movement instead of writing the
cache directly. The optional `reason` field is stored with that movement;
omitting `stock_quantity` leaves stock unchanged.

**Headers:** `Authorization: Bearer <token>`

### POST `/api/products/:id/stock`
Apply a manual stock adjustment (owner or manager only).

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "action": "increase",
  "quantity": 5,
  "reason": "Counted unopened cases"
}
```

`action` is one of `set`, `increase`, or `decrease`; `quantity` must be a
non-negative number. The response is the updated `product`. A zero net change
does not create a movement. Manual adjustments use movement type `adjustment`.

---

### GET `/api/inventory/movements`
List product inventory movements (owner or manager only), newest first.

**Headers:** `Authorization: Bearer <token>`

**Query params:**
- `?product_id=prod-1` - Filter by product
- `?movement_type=sale|cancel_restore|adjustment` - Filter by movement type
- `?reference_type=order_item&reference_id=123` - Filter by a local or imported source-reference pair
- `?before_id=42` - Continue before a movement ID returned by the previous page
- `?per_page=50` - Page size, capped at 500 (default 50)

**Response (200):**
```json
{
  "movements": [
    {
      "id": 42,
      "product_id": "prod-1",
      "product_name": "Cheeseburger",
      "quantity_delta": -2,
      "movement_type": "sale",
      "reference_type": "order_item",
      "reference_id": "123",
      "reason": null,
      "actor_user_id": "user-1",
      "actor_name": "Owner",
      "stock_after": 8,
      "created_at": "2025-03-31 12:00:00",
      "imported_by_user_id": null,
      "import_batch_id": null,
      "source_actor_user_id": null,
      "source_reference_type": null,
      "source_reference_id": null,
      "source_reason": null,
      "source_created_at": null
    }
  ],
  "nextCursor": 17
}
```

`nextCursor` is omitted when there are no more results. Movement types are
`sale`, `cancel_restore`, and `adjustment`; the latter includes opening
balances and manual adjustments. Sales reduce stock, while cancellation and
restoration flows record their stock delta and actor in the same transaction.
Imported movements use the authenticated importer as `actor_user_id`, set the
local reference to `import` plus the `import_batch_id`, and keep the supplied
actor, reference, reason, and timestamp in the `source_*` fields; source
metadata is not authenticated attribution.

---

### DELETE `/api/products/:id`
Delete (deactivate) product.

---

## Addon Groups

### GET `/api/addon-groups`
List addon groups.

**Headers:** `Authorization: Bearer <token>`

---

### POST `/api/addon-groups`
Create addon group.

**Request:**
```json
{
  "name": "Sauce Options",
  "addons": [
    { "name": "Extra Cheese", "price": 20 },
    { "name": "No Onions", "price": 0 }
  ]
}
```

---

## Tables

### GET `/api/tables`
List all tables.

**Headers:** `Authorization: Bearer <token>`

**Response (200):**
```json
{
  "tables": [
    { "id": "table-1", "name": "T1", "capacity": 4, "is_active": 1 }
  ]
}
```

---

### POST `/api/tables`
Create table.

---

### PATCH `/api/tables/:id`
Update table.

---

### DELETE `/api/tables/:id`
Delete table.

---

## Orders

### GET `/api/orders`
List orders.

**Headers:** `Authorization: Bearer <token>`

**Query params:**
- `?status=pending,preparing` - Filter by status
- `?date=2025-03-31` - Filter by date

**Response (200):**
```json
{
  "orders": [
    {
      "id": 1,
      "order_number": "ORD-001",
      "type": "dine_in",
      "status": "pending",
      "whatsapp_receipt_status": "sent",
      "table": { "id": "table-1", "name": "T1" },
      "items": [
        {
          "id": 1,
          "product_name": "Cheeseburger",
          "quantity": 2,
          "status": "pending",
          "addons": [{ "id": "addon-1", "name": "Extra Cheese", "price": 20, "quantity": 1 }],
          "special_instructions": "No onions"
        }
      ],
      "created_at": "2025-03-31T12:00:00Z"
    }
  ]
}
```

`whatsapp_receipt_status` summarizes the latest outbound `bill_receipt`
ledger row for each paid bill in the order; a paid bill with no row contributes
no positive status. It is `sent` when every paid bill's latest status is
`sent`, `delivered`, or `read`; `partial` when positive and non-positive
statuses are mixed; `pending` when no positive status exists but at least one
row is `queued` or `typing`; `failed` when no positive or pending status exists
but a row is `failed`; and `null` when no matching row exists. The `wa.me`
share fallback does not create a native ledger row and is not counted as sent.

---

### POST `/api/orders`
Create new order.

**Headers:** `Authorization: Bearer <token>`

Order item `addons` reference catalog add-ons by `id`. Each add-on must be active and linked to the product's add-on group. Add-on name and price are resolved from the catalog (client-supplied names and prices are ignored). Quantity defaults to `1` when omitted and must be a positive integer. `service_charge` is an optional explicit non-negative per-order amount validated and persisted by the server; omitted/null means `0`. Settings' service-charge category selects tax treatment only - it does not define an amount or rate, and no automatic service charge is applied.

**Request:**
```json
{
  "type": "dine_in",
  "table_id": "table-1",
  "customer_id": "cust-1",
  "service_charge": 0,
  "items": [
    {
      "product_id": "prod-1",
      "quantity": 2,
      "addons": [{ "id": "addon-1", "quantity": 1 }],
      "special_instructions": "No onions"
    }
  ]
}
```

**Response (201):**
```json
{
  "order": { ... },
  "bill": { ... }
}
```

---

### GET `/api/orders/:id`
Get order details.

The response uses the same hydrated order shape as the list endpoint,
including `whatsapp_receipt_status`.

---

### PATCH `/api/orders/:id/status`
Update order status.

**Request:**
```json
{
  "status": "cancelled",
  "reason": "Customer requested cancellation"
}
```

`reason` is optional and is stored with inventory movements when `status` is
`cancelled`.

**Valid transitions:**

| Current status | Allowed next statuses |
|----------------|-----------------------|
| `pending` | `preparing`, `ready`, `served`, `completed`, `cancelled` |
| `preparing` | `ready`, `served`, `completed`, `cancelled` |
| `ready` | `served`, `completed`, `cancelled` |
| `served` | `completed`, `cancelled` |
| `completed` | none (terminal) |
| `cancelled` | none (terminal) |

Cancelling a pending whole order does not require an override PIN unless one of
its items has already advanced to `preparing`, `ready`, `served`, or `completed`.
Once kitchen progress has started, an active owner or manager approval PIN is
required. Printing a kitchen ticket alone does not change an order or item
status.

Repeating a request for the order's current status is an idempotent no-op.
Cancelling an order requires a manager PIN when the order has progressed beyond
`pending` or any item is already in progress. Cancellation restores inventory
only for non-terminal items that recorded an inventory deduction; cancelled,
voided, and accounting-adjustment items are excluded.

---

## Held Orders

### GET `/api/held-orders`
List held orders. Requires an authenticated owner, manager, cashier, or server.

**Response (200):**
```json
{
  "orders": [
    {
      "id": "ho-abc12345",
      "tableId": "table-1",
      "items": [
        {
          "id": "line-1",
          "product": { "id": "prod-1", "name": "Cheeseburger", "price": 250 },
          "quantity": 1,
          "addons": [],
          "special_instructions": ""
        }
      ],
      "customerId": null,
      "guestCount": 1,
      "orderNotes": "",
      "heldAt": "2025-03-31T12:00:00Z"
    }
  ],
  "skippedCount": 0
}
```

### POST `/api/held-orders`
Create or replace the held order for a table. The response `id` identifies the
specific row returned to the client; replacing an existing held order creates a
new identity. Requires an authenticated owner, manager, cashier, or server.

**Request:**
```json
{
  "tableId": "table-1",
  "items": [
    {
      "id": "line-1",
      "product": { "id": "prod-1", "name": "Cheeseburger", "price": 250 },
      "quantity": 1,
      "addons": [],
      "special_instructions": ""
    }
  ],
  "customerId": null,
  "guestCount": 1,
  "orderNotes": ""
}
```

**Response (200):**
```json
{
  "success": true,
  "id": "ho-abc12345"
}
```

### DELETE `/api/held-orders/:tableId?heldOrderId=:id`
Consume the held order only when `heldOrderId` matches the current row. A
matching request deletes the row, releases the table, and returns
`{"success":true,"deleted":true}`. Requests without an identity, for an
already-consumed row, or for a replacement row return
`{"success":true,"deleted":false}` without deleting the current row or
releasing the table. Requires an authenticated owner, manager, cashier, or
server.

---

## Order Items

### PATCH `/api/orders/:orderId/items/:itemId/cancel`
Cancel an order item.

The optional request field `reason` is stored with the inventory movement when
the cancellation restores stock.

- A cancellable item outside `preparing` or `ready` becomes `cancelled` and
  restores its recorded inventory deduction.
- An item in `preparing` or `ready` becomes `voided`, adds a negative
  `void_adjustment` bill line, and does not restore inventory; a manager PIN is
  required for the void.
- A new cancellation on a completed, cancelled, paid, or partially paid order
  is rejected. Repeating cancellation of a terminal item is an idempotent
  no-op for an owner or manager.

### PATCH `/api/orders/:orderId/items/:itemId/restore`
Restore a cancelled item (owner or manager only). The item returns to `pending`
and its recorded inventory deduction is applied again. The request fails when
the order is terminal, the order is paid, or available stock is insufficient.

### POST `/api/orders/:id/items`
Append items to an existing order.

**Headers:** `Authorization: Bearer <token>`

For a retry-safe append, send an `Idempotency-Key` header containing 1–128 printable, non-whitespace ASCII characters. Reuse the same key only for the same authenticated user's identical append request (order, items, and order notes) until its response is confirmed. A matching retry returns the original `200` response without adding items again, including if the order has since become non-editable; reusing the key for different data returns `409`.

**Request:**
```json
{
  "items": [
    {
      "product_id": "prod-1",
      "quantity": 2,
      "addons": [{ "id": "addon-1", "quantity": 1 }],
      "special_instructions": "No onions"
    }
  ],
  "special_instructions": "Add drinks when ready"
}
```

**Response (200):**
```json
{
  "order": { "id": "order-1", "items": [ ... ] }
}
```

When an unpaid bill already exists for the order, appending items also
synchronizes its `subtotal` and recalculates its total, balance, tax, discount,
service-charge, and round-off fields.

---

### PATCH `/api/order-items/:id/status`
Update item status (KDS workflow).

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "status": "preparing"
}
```

**Valid statuses:** `pending` → `preparing` → `ready` → `served`

---

## Order Discounts

Both discount endpoints recalculate order totals from active order items,
including legacy items whose status is `NULL`; cancelled, voided,
`void_adjustment`, and refunded items are excluded.

### PATCH `/api/orders/:id/discount`
Apply order-level discount.

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "discount_type": "percentage",
  "discount_value": 10,
  "discount_reason": "Happy hour"
}
```

**Validations:**
- `discount_type`: must be `"percentage"` or `"amount"`
- `discount_value`: must be positive; cannot exceed store limits (`discount_max_percentage`, `discount_max_amount`)
- `discount_mode` setting is checked — if `'flat'`, percentage discounts are rejected; if `'percentage'`, flat discounts are rejected
- If `discount_requires_approval` is true, `override_pin` (manager/owner PIN) is required
- Order must exist and not be completed/cancelled

**Error (400):**
```json
{ "error": "Percentage discounts are disabled" }
```

**Error (403) — approval required:**
```json
{ "error": "Manager PIN required for discounts", "requiresApproval": true }
```

---

### PATCH `/api/orders/:id/items/:itemId/discount`
Apply item-level discount.

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "discount_type": "amount",
  "discount_value": 25,
  "discount_reason": "Comp item"
}
```

**Validations:** Same as order-level discount.

When an unpaid bill already exists for the order, applying an item-level
discount also synchronizes its `subtotal` and recalculates its total, balance,
tax, discount, service-charge, and round-off fields.

---

## Bills

### GET `/api/bills`
List bills.

**Headers:** `Authorization: Bearer <token>`

**Query params:** `?date=2025-03-31&payment_status=paid`

---

### POST `/api/bills`
Create bill (after order completion).

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "order_id": 1,
  "payment_method": "cash",
  "amount_tendered": 500
}
```

---

### PATCH `/api/bills/:id/pay`
Mark bill as paid.

**Request:**
```json
{
  "payment_method": "cash",
  "amount_tendered": 500
}
```

---

### POST `/api/bills/:id/applyDiscount`
Apply discount to a bill (owner/manager only).

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "type": "percentage",
  "value": 10,
  "reason": "Happy hour"
}
```

**Validations:**
- `type`: must be `"percentage"` or `"amount"`
- `value`: must be positive; cannot exceed store limits (`discount_max_percentage`, `discount_max_amount`)
- `discount_mode` setting is checked — restricts which discount types are allowed
- If `discount_requires_approval` is true, `override_pin` is required
- Recalculates tax on discounted subtotal
- Updates both bill and order in a transaction

**Error (400):**
```json
{ "error": "Discount exceeds maximum allowed" }
```

## Refunds

### POST `/api/refunds`
Issue a full, partial, or item refund for a paid bill. Requires an
authenticated owner or manager.

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "bill_id": 123,
  "amount": 25.00,
  "method": "cash",
  "reason": "Customer request",
  "approver_id": "owner-1",
  "override_pin": "1234"
}
```

Use `order_item_id` instead of `amount` for a whole-item refund. The request
must identify one selected approver with `approver_id`; `manager_id` is accepted
as a compatibility alias when `approver_id` is omitted. Missing or conflicting
approver IDs are rejected. The selected active owner's or manager's Staff
Approval PIN is verified; the device Master PIN is not used for refunds.

Refund timing and item eligibility rules are defined in
[`docs/business-decisions.md`](business-decisions.md).

---

## Kitchen Display (KDS)

### WebSocket `/kds`
Real-time KDS connection.

**Step 1:** Connect to WebSocket
```
ws://flo.local:3001/kds
```

**Step 2:** Authenticate
```json
{
  "type": "auth",
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Step 3:** Receive initial data
```json
{
  "type": "auth_success",
  "user": {
    "id": "chef-1",
    "name": "Chef One",
    "role": "chef",
    "categoryIds": ["cat-1", "cat-2"]
  },
  "orders": [...],
  "counts": {
    "pending": 5,
    "preparing": 3,
    "ready": 1,
    "served": 10
  }
}
```

**Step 4:** Receive real-time updates
```json
{
  "type": "new_order",
  "order": { ... }
}
```

```json
{
  "type": "order_updated",
  "order": { ... }
}
```

**Update item status (send):**
```json
{
  "type": "status_update",
  "order_item_id": 1,
  "status": "preparing"
}
```

**Error response:**
```json
{
  "type": "auth_error",
  "message": "Invalid token"
}
```

---

### REST (Fallback) `GET /api/kitchen/orders`
Fetch kitchen orders (REST fallback for cloud/web).

**Headers:** `Authorization: Bearer <token>`

**Query params:** `?status=pending,preparing,ready,served`

**Response (200):**
```json
{
  "orders": [...],
  "counts": {
    "pending": 5,
    "preparing": 3,
    "ready": 1,
    "served": 10
  }
}
```

---

## Customers

### GET `/api/customers-search`
Search active customers for POS order linking. Requires an authenticated owner,
manager, cashier, or server.

**Headers:** `Authorization: Bearer <token>`

**Query params:**
- `?q=John` - Search by name or email.
- Phone-like queries may include formatting characters; the digits are matched
  against stored phone numbers. Queries must contain at least 2 characters and
  return at most 20 customers as a flat array.

**Response (200):**
```json
[
  {
    "id": "cust-1",
    "name": "John Doe",
    "phone": "+919876543210",
    "email": "john@email.com"
  }
]
```

---

### GET `/api/customers`
List customers.

**Headers:** `Authorization: Bearer <token>`

**Query params:** `?search=John&phone=9876543210`

---

### POST `/api/customers`
Create customer.

**Request:**
```json
{
  "name": "John Doe",
  "phone": "+919876543210",
  "email": "john@email.com"
}
```

---

### GET `/api/customers/:id/loyalty`
Get loyalty points.

**Response:**
```json
{
  "points": 150,
  "last_activity": "2025-03-30"
}
```

---

### POST `/api/customers/:id/loyalty/earn`
Earn loyalty points.

**Request:**
```json
{
  "points": 10,
  "description": "Order #123"
}
```

---

## Refund amount storage

`refunds.amount_cents` stores integer minor units for all refunds:
- For zero-decimal currencies (e.g. JPY, KRW), `amount_cents` stores whole currency units (factor 1).
- For standard two-decimal currencies (e.g. USD, EUR, INR), `amount_cents` stores cents (factor 100).
- For three-decimal currencies (e.g. KWD, BHD, OMR), `amount_cents` stores integer minor units (factor 1000).

Historical FloCafe databases operated exclusively under two-decimal currencies, where stored cents identically represent integer minor units (factor 100). Tenant business currency is configured during setup and governs store-wide order, billing, and settlement records; currency changes must not occur on active stores with open or unclosed financial periods. No database schema migration is required.

## Reports

Report date parameters use tenant business dates: each `YYYY-MM-DD` value is
interpreted in the store's configured timezone and business-day start time.
The default start time is `00:00`; a later configured start time assigns the
post-midnight interval before that time to the previous business date. Omitted
dates default to the tenant's current business date. Period fields expose the
corresponding UTC bounds where an endpoint returns them.

### GET `/api/reports/sales`
Daily/monthly sales report. Date query parameters use the tenant's configured
store timezone and business-day start time; see the report date convention
above.

**Headers:** `Authorization: Bearer <token>`

**Query params:** `?date=2025-03-31`

**Response:**
```json
{
  "date": "2025-03-31",
  "total_revenue": 15000,
  "order_count": 45,
  "avg_order_value": 333.33
}
```

---

### GET `/api/reports/financial-summary`
Owner-only collection summary and refund audit for a date range. Refunds are attributed to the original bill payment date so gross, refund, net, and payment-method totals reconcile for the selected period.

`start_date` and `end_date` use tenant business dates and are converted to UTC
ranges using the store timezone and configured business-day start time; see the
report date convention above.

**Headers:** `Authorization: Bearer <owner-token>`

**Query params:** `?start_date=2025-03-01&end_date=2025-03-31`

The response includes gross and net collections, refund totals and count, bill count, average order value, payment-method totals, and up to 50 most recent refunds affecting bills collected in the range.

---

### GET `/api/reports/x-report`

Live day report (cierre de caja, issue #649). Recomputes the day's aggregates on every read using the same snapshot pipeline that backs the stored Z. `openingFloatCents` is reported for context but is **not** included in `expectedCashCents`; the X expected figure includes cash sales, Pay In, Pay Out, Safe Drop, and cash refunds by `refunds.created_at`. The stored Z adds the opening float at close, so X and Z expected values differ by exactly `opening_float_cents` for the same day.

**Role:** owner, manager

**Headers:** `Authorization: Bearer <owner-or-manager-token>`

**Query params:** `?date=YYYY-MM-DD` — tenant business date (defaults to the current business date; see the report date convention above)

**Response (200):**
```json
{
  "xReport": {
    "businessDate": "2025-03-31",
    "periodStart": "2025-03-30 18:30:00",
    "periodEnd": "2025-03-31 18:30:00",
    "grossCollected": 15000,
    "refunded": 250,
    "netCollected": 14750,
    "billCount": 45,
    "refundCount": 2,
    "paymentMethods": [
      { "method": "cash", "count": 30, "total": 9000 },
      { "method": "card", "count": 15, "total": 6000 }
    ],
    "staffSales": [
      { "user_id": "chef-1", "name": "Chef One", "role": "chef", "revenue": 8000, "orderCount": 22 }
    ],
    "taxComponents": [
      { "title": "CGST", "amount": 187.5, "rate": 0.025 }
    ],
    "openingFloatCents": 50000,
    "payInCents": 12500,
    "payOutCents": 5000,
    "safeDropCents": 10000,
    "cashMovements": [
      {
        "id": 101,
        "business_date": "2025-03-31",
        "movement_type": "pay_in",
        "amount_cents": 12500,
        "reason": "Petty cash returned",
        "created_by": "owner-1",
        "created_by_name": "Owner One",
        "created_at": "2025-03-31 20:15:00",
        "voided_at": null,
        "voided_by": null,
        "voided_by_name": null,
        "void_reason": null
      }
    ],
    "expectedCashCents": 875000,
    "alreadyClosed": false
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `grossCollected`, `refunded`, `netCollected`, `paymentMethods[].total`, `staffSales[].revenue`, `taxComponents[].amount` | number | **Display major units** (minor-factor-divided; matches `financial-summary` / tax-components). |
| `openingFloatCents` | integer \| null | Active opening-float movement for the day, or `null` when none is recorded. This is reported for context and is excluded from the X expected figure. |
| `payInCents`, `payOutCents`, `safeDropCents` | integer | **INTEGER cents.** Totals of active movements for the day. |
| `cashMovements` | array | Active movement records for the day. Voided movements are omitted from this X-report list; use the movement-history endpoint to see append-only records and soft-void metadata. |
| `expectedCashCents` | integer | **INTEGER cents.** `cash_sales + pay_ins − pay_outs − safe_drops − cash_refunds(created_at)`. Excludes the opening float. The consuming client must convert any counted-cash input to cents before comparing. |
| `businessDate` / `periodStart` / `periodEnd` | string | `businessDate` is a tenant business date (`YYYY-MM-DD`). `periodStart` and `periodEnd` are UTC bounds of that business date's configured 24-hour period, formatted `YYYY-MM-DD HH:MM:SS` (space-separated, no `T`, no `Z`, no millis — produced by `dayBoundsInTimezone()` and matching the SQLite `CURRENT_TIMESTAMP` family). |
| `alreadyClosed` | boolean | `true` when a `cash_closures` row exists for the day. |
| `priorClosedCashCents` | integer \| null | INTEGER cents counted-cash from the most recent prior `scope='day'` `cash_closures` row (used to default the next day's opening float). `null` when no prior day close exists. |
| `priorBusinessDate` | string \| null | `business_date` of that prior close (`YYYY-MM-DD`). `null` when no prior day close exists. |
| `zNumber` | integer \| absent | Field is **omitted from the JSON** while `alreadyClosed` is `false`; present and an integer once the day is closed. |

The per-method `count` is the row count in the UNION'd `paymentMethodBreakdown` view (paid payment lines **plus** refund lines as negative-amount rows — paymentMethodBreakdown UNION semantics, same as `financial-summary`). UI labels that derive "N payments" from these counts therefore include the day's refund lines in the total; use `refundCount` to subtract.

The canonical "cash" identity is the literal `method === 'cash'` filter — custom payment-method names are not joined into the cash-only expected figure.

**Convention — paid bills survive cancellation.** A paid bill counts toward the day's aggregates (`paymentMethods`, `taxComponents`, `grossCollected`, `staffSales`) even when its order is later cancelled: the cash left in the drawer is real, and the X uses the same aggregator the Z uses at close. Note this is **broader** than the live `/api/reports/tax-components` endpoint, which excludes cancelled orders (`main/routes/reports.ts:255-262`); the X intentionally follows the Z's drawer-reality convention so the live and stored views of the same day agree. Refunds recorded against a paid bill reverse the cash via the refunds UNION in `paymentMethodBreakdown`.

**Convention — staff and tax sections follow the paid day.** The X and Z key `staffSales` and `taxComponents` by `b.paid_at` (the day cash was collected) so every section of the immutable Z reconciles to the same window as `grossCollected`, `paymentMethods`, and `expectedCashCents`. On a cross-midnight day (order created Day 1, paid Day 2), staff revenue and tax components land in Day 2's snapshot. This **differs** from `/api/reports/insights` (`topStaff`, keyed by `orders.created_at`) and `/api/reports/tax-components` (keyed by `bills.created_at`) on cross-midnight days; the divergence is intentional — the Z must be internally reconcilable, while those live views prioritize the order's creation day. `staffSales[].orderCount` counts paid bills (not orders), so split checks multiply it; `/api/reports/insights` `topStaff.orderCount` counts orders instead.

---

### GET `/api/reports/z-report`

Stored day-close snapshot. Reads the immutable `cash_closures` row for the requested business date. The stored Z is the closed day's authoritative figure — late refunds against a closed day keep their existing live-report behaviour but never rewrite the row. No reopen endpoint exists in v1; corrections are operator notes, not mutations.

**Role:** owner, manager

**Headers:** `Authorization: Bearer <owner-or-manager-token>`

**Query params:** `?date=YYYY-MM-DD` — tenant business date (defaults to the current business date; see the report date convention above)

**Response (200):**
```json
{
  "zReport": {
    "id": 17,
    "scope": "day",
    "business_date": "2025-03-31",
    "period_start": "2025-03-30 18:30:00",
    "period_end": "2025-03-31 18:30:00",
    "opening_float_cents": 50000,
    "expected_cash_cents": 925000,
    "counted_cash_cents": 925000,
    "variance_cents": 0,
    "gross_collected_cents": 1500000,
    "refunded_cents": 25000,
    "net_collected_cents": 1475000,
    "bill_count": 45,
    "refund_count": 2,
    "payment_methods": [
      { "method": "cash", "count": 30, "total_cents": 900000 },
      { "method": "card", "count": 15, "total_cents": 600000 }
    ],
    "staff_sales": [
      { "user_id": "chef-1", "name": "Chef One", "role": "chef", "revenue_cents": 800000, "orderCount": 22 }
    ],
    "tax_components": [
      { "title": "CGST", "amount": 187.5, "rate": 0.025 }
    ],
    "pay_in_cents": 12500,
    "pay_out_cents": 5000,
    "safe_drop_cents": 10000,
    "cash_movements": [
      {
        "id": 101,
        "business_date": "2025-03-31",
        "movement_type": "pay_in",
        "amount_cents": 12500,
        "reason": "Petty cash returned",
        "created_by": "owner-1",
        "created_by_name": "Owner One",
        "created_at": "2025-03-31 20:15:00",
        "voided_at": null,
        "voided_by": null,
        "voided_by_name": null,
        "void_reason": null
      }
    ],
    "z_number": 17,
    "closed_by": "owner-1",
    "notes": null,
    "created_at": "2025-04-01 01:23:45"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| All `*_cents` fields | integer | **INTEGER cents.** `expected_cash_cents` includes the opening float and active movements: `expected = opening_float + cash_sales + pay_ins − pay_outs − safe_drops − cash_refunds(created_at)`. The same-day X and Z expected values therefore differ by exactly `opening_float_cents` — consumers must not compare them directly. |
| `cash_movements` | array | Active movement records captured in the immutable close snapshot, including opening float, Pay In, Pay Out, and Safe Drop entries. |
| `payment_methods[].total_cents`, `staff_sales[].revenue_cents` | integer | INTEGER cents (storage shape; converted to display major units at the X read edge). |
| `tax_components[].amount` | number | **Display major units** — identical to the X response's `taxComponents`, not cents. The Z stores the same `aggregateTaxComponents` output verbatim and serves it without conversion. |
| `variance_cents` | integer | `counted_cash_cents − expected_cash_cents`. May be negative. |
| `z_number` | integer | Monotonic, allocated from `nextZNumber()` at close time. |
| `closed_by` | string | `users.id` of the operator who closed. |
| `closed_by_name` | string | Display name of that operator (`users.name`), with `closed_by` used as fallback when the user row is missing. Resolved server-side on read for the Z JSON and on print for the receipt body. |
| `notes` | string \| null | Free-form operator notes from the close request, or `null` if none were provided. |
| `created_at` | string | UTC close timestamp, formatted `YYYY-MM-DD HH:MM:SS` (space-separated, no `T`, no `Z`, no millis — matches `db.now()` and SQLite `CURRENT_TIMESTAMP`). |
| `business_date` / `period_start` / `period_end` | string | `business_date` is a tenant business date (`YYYY-MM-DD`). `period_start` and `period_end` are UTC bounds of that business date's configured 24-hour period, formatted `YYYY-MM-DD HH:MM:SS` (space-separated, no `T`, no `Z`, no millis — produced by `dayBoundsInTimezone()` and matching the SQLite `CURRENT_TIMESTAMP` family). |

**Error (404):** the day is not yet closed.
```json
{ "error": "Day not closed", "alreadyClosed": false, "businessDate": "2025-03-31" }
```

---

### GET `/api/reports/daily-sales/export`

Owner-only daily sales export for one tenant business date. Returns either a single XLSX workbook (Summary + Items sheets) or one half of a two-file CSV pair (summary or items). Accounting and row grouping live entirely in `buildDailySalesExportDataset`; the endpoint only serializes and sets headers. See [daily-sales-export.md](daily-sales-export.md) for the full reconciliation contract.

**Role:** owner only

**Headers:** `Authorization: Bearer <owner-token>`

**Query params:**

| Param | Values | Notes |
|-------|--------|-------|
| `date` | `YYYY-MM-DD` | Tenant business date; defaults to the current business date (report date convention above). |
| `format` | `xlsx` \| `csv` | Required. Any other value → 400. |
| `part` | `summary` \| `items` | Required when `format=csv` (each CSV file is one part). Ignored for `xlsx`. Missing on CSV → 400. |

**Responses:**

- `format=xlsx` → `200`, `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `Content-Disposition: attachment; filename="daily-sales-YYYY-MM-DD.xlsx"`. Workbook has two sheets: `Summary` (metric/value rows) and `Items` (per-product rows). Money cells are numeric with a currency-fraction-digit number format; no formulas.
- `format=csv&part=summary` → `200`, `text/csv`, filename `daily-sales-YYYY-MM-DD-summary.csv`. Header `metric,value`.
- `format=csv&part=items` → `200`, `text/csv`, filename `daily-sales-YYYY-MM-DD-items.csv`. Header `product_id,product_name,product_sku,quantity,gross_item_sales,item_discounts,net_item_sales,tax_amount`.

CSV cells that would start with `=`, `+`, `-`, or `@` and are not numeric are neutralized with a leading quote (CWE-1236, shared `toCsvRow` in `main/lib/csv.ts`). Decimal separator in CSV is always ASCII `.`.

**Errors:** `400` invalid `format` or CSV without `part`; `401` unauthenticated; `403` non-owner; `409` concurrent-write passthrough as JSON; `500` otherwise.

**Summary metrics** (stable field order in `dailySalesSummaryMetricRows`): `business_date`, `timezone`, `business_day_start`, `currency`, `order_count`, `paid_bill_count`, `gross_collected`, `refunds_issued`, `net_collected`, `tax_total`, `discount_total`, `service_charge_total`, `packaging_charge_total`, `delivery_charge_total`, then one `payment_<method>` total per method (snake_case key via `dailySalesPaymentMetricKey`; no per-method `_count` — the underlying count covers payment+refund lines, not payments).

**Reconciliation identities:** `Σ net_item_sales = Σ bills.subtotal` over the paid window; `Σ gross_item_sales = Σ net_item_sales + Σ item_discounts`; `Σ payment_<method> totals = net_collected`; `Σ item tax_amount ≠ tax_total` is intentional (item tax is per-line, `tax_total` is the aggregated component total). Sale day is keyed on `bills.paid_at`; refunds on `refunds.created_at`; `net_collected = gross_collected - refunds_issued`. `discount_total` = order-level (`bills.discount_amount`) + item-level discounts.

---

## Cash Closures

### GET `/api/cash-closures/movements`

List the append-only cash-drawer movement history for a tenant business date. The response is ordered newest first and includes opening float, Pay In, Pay Out, and Safe Drop records, including soft-voided records with their audit metadata.

**Role:** owner, manager, cashier

**Headers:** `Authorization: Bearer <owner-manager-or-cashier-token>`

**Query params:** `?business_date=YYYY-MM-DD` — tenant business date.

**Response (200):**
```json
{
  "businessDate": "2025-03-31",
  "movements": [
    {
      "id": 101,
      "business_date": "2025-03-31",
      "movement_type": "pay_in",
      "amount_cents": 12500,
      "reason": "Petty cash returned",
      "created_by": "owner-1",
      "created_by_name": "Owner One",
      "created_at": "2025-03-31 20:15:00",
      "voided_at": null,
      "voided_by": null,
      "voided_by_name": null,
      "void_reason": null
    }
  ]
}
```

`movement_type` is one of `opening_float`, `pay_in`, `pay_out`, or `safe_drop`. All `amount_cents` values are non-negative integer cents.

### POST `/api/cash-closures/movements`

Append a cash-drawer movement to an open tenant business date. Movement rows are never updated or deleted by this endpoint. Only one active `opening_float` may exist for a business date.

**Role:** owner, manager, cashier

**Headers:** `Authorization: Bearer <owner-manager-or-cashier-token>`

**Request:**
```json
{
  "business_date": "2025-03-31",
  "movement_type": "pay_in",
  "amount_cents": 12500,
  "reason": "Petty cash returned"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `business_date` | string | Tenant business date (`YYYY-MM-DD`). Must be a real, non-future calendar date. |
| `movement_type` | string | `opening_float`, `pay_in`, `pay_out`, or `safe_drop`. |
| `amount_cents` | integer | Non-negative integer cents for `opening_float`; positive integer cents for other movement types. |
| `reason` | string \| optional | Optional for `opening_float`; required for other movement types. Maximum 500 characters. |

**Response (201):** `{ "movement": { ...movement fields... } }`

**Errors:** 400 for invalid input, 409 when the day is already closed or an active opening float already exists for the date.

### POST `/api/cash-closures/movements/:id/void`

Soft-void an existing cash movement. The original row remains in history with `voided_at`, `voided_by`, and `void_reason` populated, and no new movement row is created.

**Role:** owner, manager

**Headers:** `Authorization: Bearer <owner-or-manager-token>`

**Path params:** `:id` — positive integer movement ID.

**Request:**
```json
{ "reason": "Entered on the wrong business date" }
```

**Response (200):** `{ "movement": { ...movement fields with void metadata... } }`

**Errors:** 400 for an invalid ID or missing/overlong reason, 404 when the movement does not exist, or 409 when the movement is already voided or its business date is already closed.

### POST `/api/cash-closures`

Close the current tenant business day (cierre de caja, issue #649). One close per business date per store. The backend recomputes every aggregate server-side — it never trusts client totals — and stores one immutable row in `cash_closures` inside a single transaction. The stored Z is the closed day's authoritative figure; no reopen endpoint exists in v1.

**Role:** owner (manager / cashier / server → 403)

**Headers:** `Authorization: Bearer <owner-token>`

**Request:**
```json
{
  "business_date": "2025-03-31",
  "opening_float_cents": 50000,
  "counted_cash_cents": 925000,
  "notes": "Late drawer count"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `business_date` | string | Tenant business date (`YYYY-MM-DD`). Must be a real calendar date (regex match is not enough — `2026-02-30` is rejected). Not in the future relative to the current tenant business date. |
| `opening_float_cents` | integer | INTEGER cents, `>= 0`. Cash float the operator is starting the day with. |
| `counted_cash_cents` | integer | INTEGER cents, `>= 0`. Cash the operator counted in the drawer at close. |
| `notes` | string \| optional | Free-form notes, ≤ 500 characters. |

Snapshot math (verbatim from spec):
```
expected_cash_cents = opening_float_cents
                    + cash_sales_cents
                    + pay_in_cents
                    − pay_out_cents
                    − safe_drop_cents
                    − cash_refunds_by_created_at_cents
variance_cents      = counted_cash_cents − expected_cash_cents
```

The canonical "cash" identity is the literal `method === 'cash'` filter — custom payment-method names are not joined into the cash-only expected figure. Refunds are attributed by `refunds.created_at` for the drawer-reality split; display totals attribute refunds to the original bill's `paid_at` (matching `financial-summary`).

**Response (201):**
```json
{
  "zReport": {
    "id": 17,
    "scope": "day",
    "business_date": "2025-03-31",
    "period_start": "2025-03-30 18:30:00",
    "period_end": "2025-03-31 18:30:00",
    "opening_float_cents": 50000,
    "expected_cash_cents": 925000,
    "counted_cash_cents": 925000,
    "variance_cents": 0,
    "gross_collected_cents": 1500000,
    "refunded_cents": 25000,
    "net_collected_cents": 1475000,
    "bill_count": 45,
    "refund_count": 2,
    "payment_methods": [
      { "method": "cash", "count": 30, "total_cents": 900000 },
      { "method": "card", "count": 15, "total_cents": 600000 }
    ],
    "staff_sales": [
      { "user_id": "chef-1", "name": "Chef One", "role": "chef", "revenue_cents": 800000, "orderCount": 22 }
    ],
    "tax_components": [
      { "title": "CGST", "amount": 187.5, "rate": 0.025 }
    ],
    "pay_in_cents": 12500,
    "pay_out_cents": 5000,
    "safe_drop_cents": 10000,
    "cash_movements": [
      {
        "id": 101,
        "business_date": "2025-03-31",
        "movement_type": "pay_in",
        "amount_cents": 12500,
        "reason": "Petty cash returned",
        "created_by": "owner-1",
        "created_by_name": "Owner One",
        "created_at": "2025-03-31 20:15:00",
        "voided_at": null,
        "voided_by": null,
        "voided_by_name": null,
        "void_reason": null
      }
    ],
    "z_number": 17,
    "closed_by": "owner-1",
    "notes": "Late drawer count",
    "created_at": "2025-04-01 01:23:45"
  }
}
```

The response field shape matches `GET /api/reports/z-report` except it omits `closed_by_name`, which is resolved server-side on the Z read — the stored row is the source of truth for both reads.

**Error (400):** malformed body, non-integer / negative cents, future date, notes too long, or invalid calendar date. The `error` message names the offending field, e.g. `business_date is not a real calendar date`, `counted_cash_cents must be >= 0`, `notes is too long`.

**Error (409):** the day is already closed (duplicate `POST` against the same `business_date`).
```json
{ "error": "This day is already closed" }
```
A concurrent winner of a double-`POST` race still returns 409 — the partial unique index `cash_closures_one_day ... WHERE scope = 'day'` is the safety net behind the SELECT-then-INSERT.

---

### POST `/api/cash-closures/:id/print`

Dispatch the stored Z to the default receipt printer. The forced drawer pulse is appended server-side (bypassing bill-bound `shouldPulseForPayment`, which can never fire for a bill-less Z) and is **not** filtered through `cash_drawer_pulse_methods`: the Z is the document the merchant prints while counting the drawer. The stored row is never mutated by printing.

**Role:** owner (manager / cashier / server → 403)

**Headers:** `Authorization: Bearer <owner-token>`

**Path params:** `:id` — positive integer, the `cash_closures.id` returned by `POST /api/cash-closures` or `GET /api/reports/z-report`.

**Request:**
```json
{ "isReprint": false }
```

| Field | Type | Description |
|-------|------|-------------|
| `isReprint` | boolean \| optional | When `true`, the printed body shows a `REPRINT` marker next to the Z number. Defaults to `false`. |

The route resolves the default receipt printer server-side (the WebUSB branch is reachable end-to-end this way; helpers that exclude WebUSB would otherwise skip it). Labels use the independently configured `z_report_language_policy`, which defaults to the store language and supports one additional language.

**Response (200, WebUSB):** the renderer dispatches the bytes itself.
```json
{ "success": true, "webusb": true, "isReprint": false, "bytes": [27, 64, 27, 112, 0, 25, 250], "warnings": [] }
```

**Response (200, network / USB):**
```json
{ "success": true, "isReprint": false, "warnings": [] }
```

**Error (400):** invalid id.
```json
{ "error": "id must be a positive integer" }
```

**Error (404):** no row for that id.
```json
{ "error": "Cash closure not found" }
```

**Error (409):** no default printer is configured.
```json
{ "error": "No default printer configured" }
```

**Error (502):** the printer did not respond or the dispatch failed.
```json
{ "error": "<detail>", "detail": "<detail>", "warnings": [] }
```

Unsupported text in a financial Z-report unit fails closed before dispatch and
returns a financial warning in the 502 response. Non-financial skipped text is
reported in `warnings` without claiming that it printed.

Printed Z layout, in spec order: header (business name, address, tax id — **branch omitted: no branch data source exists in the schema**) → Z number + business date + period start/end → opening float → cash movements (Pay In, Pay Out, Safe Drop) → sales by payment method → refunds → tax breakdown → staff sales → expected / counted / variance (variance emphasized) → operator + signature line → footer. The forced drawer pulse is appended after the footer.

---

## Settings

### GET `/api/settings/business`
Get business settings. Locale display preferences (`currency_display`, `number_digits`, `calendar`) are resolved against the active country's declared `localeOptions`; stale or unsupported stored values are normalized to neutral defaults.

**Response:**
```json
{
  "business_name": "My Restaurant",
  "timezone": "Asia/Kolkata",
  "business_day_start_time": "00:00",
  "currency": "INR",
  "country": "IN",
  "tax_registration_number": "22AAAAA0000A1Z5",
  "currency_display": "rial",
  "number_digits": "locale",
  "calendar": "locale"
}
```

---

### PUT `/api/settings/business`
Update business settings.

`timezone` is validated as an IANA identifier; invalid values return HTTP 400 with `"Invalid timezone, currency, or country"`.

`business_day_start_time` configures the local start of the 24-hour business
period used by reports and cash closures. It is returned as `HH:mm`, defaults
to `00:00`, and is trimmed before persistence; invalid values return HTTP 400.

`currency` accepts any three-letter ASCII currency code. Leading/trailing
whitespace is trimmed and lowercase input is normalized to uppercase before
the value is persisted; invalid codes return the same HTTP 400 response.

When `tax_registration_number` is provided, the backend validates it against the active country pack's registration format. A mismatch returns HTTP 400:

```json
{
  "error": "Tax ID does not match the expected IN format: 15-digit GSTIN",
  "tax_id_format": { "pattern": "...", "description": "..." }
}
```

Locale display preferences (`currency_display`, `number_digits`, `calendar`) are validated against the effective country's `localeOptions`. Unsupported values return HTTP 400 with `"Invalid <key> for country <code>"`. Changing the country normalizes any previously stored preferences that are not supported by the new country to their neutral defaults (`rial`, `locale`, `locale`).

---

### GET `/api/settings/tax`
Get tax settings.

---

### PUT `/api/settings/tax`
Update tax settings (owner/manager only).

Validates `tax_registration_number` against the active country pack format, same as `PUT /api/settings/business`.

---

### GET `/api/settings/discount`
Get discount limits configuration.

**Headers:** `Authorization: Bearer <token>`

**Response (200):**
```json
{
  "discount_max_percentage": 50,
  "discount_max_amount": 100,
  "discount_mode": "both",
  "discount_requires_approval": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `discount_max_percentage` | number | Max % for percentage discounts (0 = no limit) |
| `discount_max_amount` | number | Max flat amount for discounts (0 = no limit) |
| `discount_mode` | string | `'percentage'`, `'flat'`, or `'both'` — which discount types are allowed |
| `discount_requires_approval` | boolean | Require manager PIN to apply discounts |

---

### PUT `/api/settings/discount`
Update discount limits (owner/manager only).

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "discount_max_percentage": 30,
  "discount_max_amount": 200,
  "discount_mode": "both",
  "discount_requires_approval": true
}
```

**Validation:**
- `discount_max_percentage`: float, range 0–100 (0 = no limit)
- `discount_max_amount`: float, range 0–999999 (0 = no limit)
- `discount_mode`: must be `'percentage'`, `'flat'`, or `'both'`
- `discount_requires_approval`: boolean

**Error (400):**
```json
{ "error": "discount_mode must be \"percentage\", \"flat\", or \"both\"" }
```

---

## Printers

Printer configuration is available to owners and managers. Receipt and KOT print endpoints also allow cashiers. See [Printer setup](printers.md) for the operational guide.

### GET `/api/printers`

List configured printers, with their resolved printer profile.

### GET `/api/printers/detect`

Detect available USB and network printers.

### GET `/api/printers/supported`

List FloCafe's known printer profiles.

### GET `/api/printers/:id`

Get one configured printer.

### POST `/api/printers`

Create a printer. `connection_type` must be `network`, `usb`, or `webusb`. Network printers require `ip_address`.

```json
{
  "name": "Kitchen Printer",
  "connection_type": "network",
  "ip_address": "192.168.1.100",
  "port": 9100,
  "paper_width": "80mm",
  "cash_drawer_pulse_enabled": false,
  "is_default": true
}
```

A WebUSB entry stores the paper-width preference; the browser selects the physical device.

### PUT `/api/printers/:id`

Update printer configuration. The request accepts the same fields as creation.

### DELETE `/api/printers/:id`

Delete a configured printer.

### POST `/api/printers/:id/set-default`

Make a printer the default for regular receipt printing.

### POST `/api/printers/:id/test`

Send a test page. The printed timestamp uses the tenant's configured store
timezone. Pass `{ "rasterProbe": true }` to request the capability-gated
raster diagnostic bands; profiles without enabled raster capability retain the
standard test page. For WebUSB, the response contains the ESC/POS bytes for the
browser to send.

### POST `/api/printers/print-bill`

Print the bill identified by `billId` or the bill associated with `orderId`.

```json
{
  "billId": 123,
  "useUnicode": false,
  "isReprint": false,
  "preview": false,
  "arabicShaping": false
}
```

Pass `preview: true` to generate receipt preview text, base64 ESC/POS payload, and column metrics without dispatching to a physical printer. If no hardware printer is configured, preview mode falls back to default 80 mm formatting.

Successful print responses include `{ "success": true, "warnings": [] }`. If
receipt preparation finds unsupported financial text, the endpoint returns HTTP
502 before transport with `stage: "prepare"`, `failure_class: "unsupported"`,
and the financial warnings in `warnings`; dispatch failures use
`stage: "dispatch"`. See [printing architecture warning semantics](printing-architecture.md#6-printer-capability-model--warning-semantics) for the warning contract.

### POST `/api/printers/print-kot`

Print a kitchen order ticket for `orderId`. A caller may provide `stationName` and `items`; otherwise FloCafe routes items to configured kitchen stations. The KOT status-filtering contract is defined in [printing architecture](printing-architecture.md#3-printdocument-v1-model). This endpoint returns `403` when KOT printing is disabled.

```json
{
  "orderId": 123,
  "useUnicode": false,
  "arabicShaping": false
}
```

---

## Merchant Print Templates

Owner-role CRUD for tenant-owned semantic receipt templates (#447). See
[Merchant print templates](merchant-print-templates.md) for the payload schema, validation policy,
provenance/trust model, and offline transfer contract. Payloads are validated
fail-closed on every write.

### GET `/api/print-templates`
List merchant templates (all statuses). Owner or manager.

### POST `/api/print-templates`
Create a template in `draft` status. Body: `{ name, payload, origin?, derivedFrom? }`.
`origin` is one of `created | imported | cloned`; `cloned` requires a
`derivedFrom` reference `{ type: 'compliance-pack-template' | 'merchant-template' | 'offline-import', templateId }`
(informational only — no compliance trust transfers).

### PUT `/api/print-templates/:id`
Update name and/or payload. Editing an ACTIVE template snapshots its current
payload into the single-step rollback point. Archived templates are immutable.

### POST `/api/print-templates/:id/activate`
Promote to `active`. Fails closed (409) if the stored checksum does not match
the payload.

### POST `/api/print-templates/:id/archive`
Terminal state; archived templates stop being selectable.

### POST `/api/print-templates/:id/rollback`
Restore `previous_payload_json` after verifying the current checksum; clears
the rollback point. 409 when there is nothing to roll back to, when the
restored payload fails current validation, or when the template is archived.

### GET `/api/print-templates/:id/payload`
Read the stored payload (owner or manager).

### GET `/api/print-templates/:id/export`
Download an active or archived template as a portable
`*.flocafe-template.json` envelope. Owner only. Drafts and rows with invalid
stored checksums are rejected; the response is JSON with an attachment
filename.

### POST `/api/print-templates/import`
Import a portable envelope as a new `draft`. Owner only. Body:
`{ file, name?, fileName? }`, where `file` is the raw envelope JSON text and
`fileName` is the optional source filename recorded in offline-import
provenance. The import path enforces the envelope and payload validators,
checksum verification, and the 256 KB raw-byte cap; it never activates or
overwrites an existing template.

---

## Mobile Pairing

### GET `/api/mobile/pairing-code`
Get current pairing code.

**Response:**
```json
{
  "pairing_code": "123456",
  "rotated_at": "2025-03-31T10:00:00Z"
}
```

---

### POST `/api/mobile/rotate-code`
Generate new pairing code.

---

## KDS Info

### GET `/api/kds-info`
Get KDS access URLs and QR code.

**Response:**
```json
{
  "mdns_url": "http://flo.local:3001/kds",
  "ip_url": "http://192.168.1.50:3001/kds",
  "qr_url": "http://192.168.1.50:3001/kds",
  "qr_data_url": "data:image/png;base64,..."
}
```

---

## WebSocket Events Summary

| Event | Direction | Description |
|-------|-----------|-------------|
| `auth` | → Server | Authenticate with JWT token |
| `auth_success` | ← Server | Authentication successful |
| `auth_error` | ← Server | Authentication failed |
| `initial_data` | ← Server | Initial orders and counts |
| `new_order` | ← Server | New order created |
| `order_updated` | ← Server | Order status changed |
| `status_update` | → Server | Update item status |
| `orders` | ← Server | Full orders list (periodic) |

---

## Order Status Flow

The order-level transition matrix is documented with
`PATCH /api/orders/:id/status` above. The KDS item progression is
`pending` → `preparing` → `ready` → `served`; cancellation and void statuses
are documented in the Order Items section.

Each item in an order has its own status, allowing:
- Multiple items in one order
- Different items at different stages
- KDS shows items filtered by status

---

## Role-Based Access

See [Roles and permissions](roles-and-permissions.md) for the complete current role matrix. The database accepts `owner`, `manager`, `cashier`, `server`, and `chef`; the historical `waiter` label is no longer a valid role.

---

## Category Filtering (KDS)

Users with `chef` role have `category_ids` array. When accessing KDS:
1. Server validates JWT token
2. Server checks role is `chef`, `manager`, or `owner`
3. Server filters order items to only show products in user's categories
4. One user can have multiple categories

Example: Chef1 (cat-1, cat-2) only sees Food and Beverages items.

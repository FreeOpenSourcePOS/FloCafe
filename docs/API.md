# Flo API Documentation

## Base URL

**Local:** `http://flo.local:3001` or `http://<local-ip>:3001`

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

### PATCH `/api/products/:id`
Update product.

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

---

### POST `/api/orders`
Create new order.

**Headers:** `Authorization: Bearer <token>`

Order item `addons` reference catalog add-ons by `id`. Each add-on must be active and linked to the product's add-on group. Add-on name and price are resolved from the catalog (client-supplied names and prices are ignored). Quantity defaults to `1` when omitted and must be a positive integer.

**Request:**
```json
{
  "type": "dine_in",
  "table_id": "table-1",
  "customer_id": "cust-1",
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

---

### PATCH `/api/orders/:id/status`
Update order status.

**Request:**
```json
{
  "status": "preparing"
}
```

**Valid transitions:**

| Current status | Allowed next statuses |
|----------------|-----------------------|
| `pending` | `preparing`, `ready`, `served`, `completed`, `cancelled` |
| `preparing` | `ready`, `served`, `completed`, `cancelled` |
| `ready` | `served`, `completed`, `cancelled` |
| `served` | `completed`, `cancelled` |
| `completed` | none (terminal) |
| `cancelled` | none (terminal) |

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

## Reports

### GET `/api/reports/sales`
Daily/monthly sales report.

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

**Headers:** `Authorization: Bearer <owner-token>`

**Query params:** `?start_date=2025-03-01&end_date=2025-03-31`

The response includes gross and net collections, refund totals and count, bill count, average order value, payment-method totals, and up to 50 most recent refunds affecting bills collected in the range.

---

### GET `/api/reports/x-report`
X Report (current shift).

---

### GET `/api/reports/z-report`
Z Report (close shift).

---

## Settings

### GET `/api/settings/business`
Get business settings. Locale display preferences (`currency_display`, `number_digits`, `calendar`) are resolved against the active country's declared `localeOptions`; stale or unsupported stored values are normalized to neutral defaults.

**Response:**
```json
{
  "business_name": "My Restaurant",
  "timezone": "Asia/Kolkata",
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

Send a test page. For WebUSB, the response contains the ESC/POS bytes for the browser to send.

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

### POST `/api/printers/print-kot`

Print a kitchen order ticket for `orderId`. A caller may provide `stationName` and `items`; otherwise FloCafe routes items to configured kitchen stations. This endpoint returns `403` when KOT printing is disabled.

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

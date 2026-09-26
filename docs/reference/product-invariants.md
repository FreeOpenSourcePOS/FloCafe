# Product invariants

These are deliberate product decisions that shape how FloCafe behaves and are not derivable from
reading the code. Each one names where it is enforced and how to check that the codebase still
complies, so an implementation that contradicts one is caught rather than assumed.

Read this before changing authorization, access control, defaults, or any behaviour listed here. If
a change appears to require deviating from an entry, confirm it rather than assuming the decision is
stale. If a decision genuinely changes, update this page in the same change that changes the
behaviour.

This page is a peer of the core invariants in [`AGENTS.md`](../../AGENTS.md), which carry the short
load-bearing list, not a replacement for it.

## How an entry is structured

**Rule** (what the system does) · **Reason** (why it is that way) · **Enforced by** (where a
violation would show up) · **How to verify** (a command that must return a specific result) ·
**Change policy** (what it takes to change the decision).

A decision without a checkable verification command is a decision that is easy to violate by
accident.

---

## Orders are never ownership-gated

**Rule:** Any staff role with order access (owner, manager, cashier, server; see
[roles and permissions](roles-and-permissions.md)) can view and act on **every** order, regardless
of who created it. No "this is my order" restriction exists anywhere in the system.

**Reason:** FloCafe is an open system by design. Restricting staff to the orders they personally
created adds friction without a security benefit for this product: a waiter covering a colleague's
table and a manager checking any order are both normal work. Accountability comes from knowing who
did what, not from hiding data between staff who already share a till and a kitchen.

**What restricts access instead:**

1. **Permission-based page and feature access.** Shipped defaults do not let a chef open the
   Orders page or a cashier reach owner/manager-only settings; an owner may reconfigure either
   (see [role templates and user permissions](#role-templates-and-user-permissions-are-owner-configurable)).
2. **Permission-based restriction on a specific action.** KDS stage transitions (marking an item
   preparing, ready, or served) require `kitchen.status.update`, shipped chef/manager/owner-only,
   narrowed further by the chef's assigned kitchen station and category. A server can place an
   order but cannot do the kitchen's work on it.
3. **Audit attribution.** Every order and every write is recorded against the authenticated actor
   (`user_id`, `created_by`). This serves the audit trail, not access gating.

**Enforced by:** `main/routes/orders.ts` (order list, `GET /:id`, item append, status update, item
cancel/void and restore), `main/routes/printers.ts` (`print-kot`). None of these compare
`order.user_id`, or an item's creator, against the requesting user.

**How to verify:** both commands must return nothing.

```sh
grep -rn "role === 'server'" main/routes/ | grep -i "user_id"
grep -rn "user_id !== " main/
```

A match is a reintroduction of the pattern. Treat it as a bug, not a feature, and confirm with the
user before keeping it.

**Change policy:** changing this needs an explicit product decision, because it is a deliberate
opening of the system rather than an oversight. Any new endpoint that filters a list by the
authenticated user is subject to the same review as a change to this entry.

---

## Role templates and user permissions are owner-configurable

**Rule:** FloCafe keeps its five fixed staff identities (owner, manager, cashier, server, chef),
but their ordinary feature permissions are configurable by an owner: role defaults can be
overridden, and a single user can additionally receive explicit allow/deny exceptions. For each
permission, the effective value resolves protected-owner rule, then user override, then role
override, then shipped default. `authorization.manage` (who can reach the permission editor) and
`staff.privileged.manage` (who can modify an owner or manager account) are the two exceptions:
both are protected, always resolve true for an active owner, and cannot be configured to anyone
else.

**Reason:** Stores need to delegate real operational responsibilities — letting a trusted cashier
take on a manager's reporting view, for example — without inventing more role identities, while an
offline-first, backend-authoritative install still needs a recoverable owner administration path
that no override can remove.

**Enforced by:** [`shared/permissions.ts`](../../shared/permissions.ts) (the permission catalog and
shipped defaults), [`main/services/authorization.ts`](../../main/services/authorization.ts) (the
resolver), schema migration v93 in `main/db.ts` (`role_permission_overrides`,
`user_permission_overrides`, `authorization_audit_log`), the owner-only `/api/authorization` API,
and `requirePermission`/`requireAnyPermission` middleware across the main API, KDS, and Server App.
See [authentication and authorization](../architecture/authentication-and-authorization.md#configurable-permissions)
for the resolution model and [roles and permissions](roles-and-permissions.md) for the editor and
the shipped-default matrix.

**How to verify:**

```sh
npm run test:authorization-permissions
```

A static audit test in the same suite rejects any newly introduced `requireRole(...)` runtime gate
under `main/routes/`; the remaining direct role checks in the codebase are reviewed context policy
(refund approver identity, the override-PIN holder for item cancel/void, the last-active-owner and
staff-target rule, and KDS station/category scope), each documented where it lives.

**Change policy:** the two protected permissions, and the precedence order overrides resolve in,
are structural — changing either needs an explicit product decision, because either one can create
an unrecoverable install (no owner able to manage authorization) or a privilege-escalation path
(a non-owner able to modify owner/manager accounts). Adding a new permission id to the catalog, or
changing a shipped default, does not need this entry updated, but does need
[roles and permissions](roles-and-permissions.md) updated in the same change.

---

## Refunds and Staff Approval PINs

**Rule:** The initial owner creates and confirms a separate 4 to 6 digit Staff Approval PIN during
first-run setup. It is stored as a bcrypt hash on the owner user record, independent of the device
Master PIN. Owners, and within the in-progress window also managers, can refund a bill that has
already been paid: in full, partially, or for a single item, without restocking inventory. The
refund can be paid back in a different method than the customer used, or issued as store credit.

1. **Selected approver.** Every refund identifies one approver through `approver_id`. `manager_id`
   remains a compatibility alias; a missing id, or an `approver_id` that conflicts with
   `manager_id`, is rejected. Only the selected active owner or manager is checked, and the
   submitted PIN must be that user's Staff Approval PIN. The device Master PIN never authorizes a
   refund.
2. **Ceiling.** A refund can never exceed `paid_amount` minus the sum of prior refunds for that
   bill, not the order's gross total, so a partly refunded bill cannot be refunded past what is
   outstanding. Enforced by `getRefundableBalance()` in `main/services/refund.ts`.
3. **Approval tiers**, keyed off the order's `created_at` and the store's business day. The
   in-progress window is `REFUND_WINDOW_MS`, one hour.
   - Within the window: the selected active owner's or manager's Staff Approval PIN.
   - After the window but inside the same business day, computed by `dayBoundsInTimezone()` in
     `main/db.ts` from the tenant's configured timezone and `business_day_start_time`: the selected
     active owner's PIN only. A manager PIN is rejected outright. Once an order is effectively
     closed there is no kitchen or service context left to sanity-check the request, so the bar is
     raised rather than reused.
   - After the business day ends: refused with HTTP 409, regardless of who approves. Reversing an
     older transaction happens outside the system.
4. **Item eligibility** for a single-item refund is `REFUND_ITEM_ELIGIBLE_STATUSES`: `preparing`,
   `ready`, `served`, `completed`.
5. **The refund payment method is independent of the original.** A card payment can be refunded in
   cash and the reverse. This is deliberate, not a missing validation.
6. **Store credit** (`method: 'wallet'`) requires loyalty to be enabled and a customer attached to
   the bill. It is recorded as a plain `credit` row in `loyalty_ledger`, the same mechanism cashback
   uses, so it is immediately spendable. It does not double-count as cashback on respend, because
   `calculateCashback()` in `main/routes/bills.ts` already excludes wallet-funded spend from the
   cashback base.
7. **Accepted limitation.** A refund does not claw back cashback already credited on that sale at
   payment time. Proportional cashback clawback was judged not worth the complexity at the product's
   install-base scale.
8. **Refund initiation is configurable; approval eligibility is not.** `refunds.initiate` (shipped
   owner/manager) controls who may start the workflow and is owner-editable per role or per user,
   see [role templates and user permissions](#role-templates-and-user-permissions-are-owner-configurable).
   The selected approver must still independently satisfy the owner/manager and time-tier rules
   above — those are fixed context policy, not a permission, regardless of the initiator's grant.
9. **Inventory is never restored by a refund**, item-level or whole-bill, matching how item voids
   and cancellations behave.

**Amount storage.** `refunds.amount_cents` stores integer minor units for every currency, using
the factor returned by `getCurrencyMinorUnitFactor()` in `main/countries.ts`, which is ten to the
power of the currency's fraction digits. A zero-decimal currency such as JPY or KRW uses a factor
of 1 and stores whole currency units; a two-decimal currency such as USD, EUR, or INR uses 100;
a three-decimal currency such as KWD, BHD, or OMR uses 1000. The column name is historical; the
rule is minor units, not cents.

The tenant's business currency is chosen at setup and governs store-wide order, billing, and
settlement records. It is not changed on an active store; see
[regional settings](#regional-settings-come-from-signup-never-from-a-fallback).

**Reason:** A controlled way to reverse completed sales without reopening the order-editing
surface, while keeping the two things most exposed to misuse deliberately tight: how far back a
refund reaches, and who can approve one.

**Enforced by:** `main/services/refund.ts` (`createRefund`, `resolveRefundApprover`,
`getRefundableBalance`, `REFUND_ITEM_ELIGIBLE_STATUSES`), `main/routes/refunds.ts`, and the
first-run setup path in `main/routes/auth.ts`. Every refund also writes a `refund_issued` row to
`order_audit_log`.

**How to verify:**

```sh
npm run test:refunds               # in-progress refund behaviour
npm run test:refund-completed-orders   # business-day tiers, item eligibility, store credit, audit row
```

**Change policy:** the tier boundaries, the approver model, and the accepted cashback limitation are
product decisions. Implementation changes that keep them are not. Any change to the ceiling, the
tier boundaries, or store-credit accounting needs explicit confirmation.

---

## Regional settings come from signup, never from a fallback

**Rule:** The country selected during first-run setup, and the ISO 4217 currency selected alongside
it, are the only source of a store's regional identity. The country's currency is recommended, but
the owner may choose another supported currency. Currency symbol, symbol position, fraction digits,
number separators, and the default timezone are **derived** from those two values through
international conventions (CLDR via `Intl`, ISO 4217, IANA time zones).

There is no default country, no hard-coded currency symbol, and no per-store override of a derived
value. When regional settings are missing, code fails loudly with `RegionalNotConfiguredError` and
HTTP 409 rather than rendering a fallback currency.

`settings.timezone` is the single legitimate stored override. It is not a per-store override of a
derived country value; it is a configured zone within the resolved country.

**Post-setup currency changes are destructive.** A configured store cannot reinterpret existing
amounts in a new currency. Only an owner may change currency, through the Master-PIN-gated reset
flow at `POST /api/db-tools/currency-reset`. The app takes a full recovery backup, recreates the
local database, and preserves only categories, products, add-on groups, add-ons, and their
relationships. Product prices, product costs, stock balances, tax assignments, cashback
percentages, and add-on prices reset to zero or defaults, all other local data is erased, and
first-run setup is required again. Changing country alone changes the recommendation, never the
active currency. Ordinary business and wildcard settings writes reject an actual currency change
with `currency_change_requires_reset`.

**Reason:** The install seed used to write `'IN'`, `'INR'`, `'₹'`, and `'Asia/Kolkata'` as silent
fallbacks in more than a dozen places before the owner had chosen anything, and surfaces disagreed
about which symbol to print, so a non-Indian store could see one currency on a receipt and another
on screen. The owner's instruction was that the user picks country and currency at signup, it stays
consistent throughout the application, and the app follows existing conventions rather than
inventing overrides.

**What this rules out:** merchant-editable currency symbols and merchant-selectable symbol
placement. If a locale's rendering is wrong, the fix is the country profile in `main/countries.ts`,
which corrects every store in that country.

**Enforced by:** `resolveRegionalSnapshot()` in `main/countries.ts`, the first-run wizard requiring
a country, setup rejecting a missing country, `seedInstallDefaults()` in `main/db.ts` not writing
regional keys, and `POST /api/db-tools/currency-reset` as the only post-setup currency-change path.

**How to verify:**

```sh
npm run test:currency
```

The compliance grep must return nothing except two annotated one-time migration exceptions:

```sh
grep -rn "|| 'IN'\|?? 'IN'\||| 'INR'\|?? 'INR'\||| '₹'\|?? '₹'\||| 'Asia/Kolkata'\|?? 'Asia/Kolkata'\|getCountryByCode('IN')" \
  main frontend/src shared --include='*.ts' --include='*.tsx'
```

The only permitted hits are `tenantCountryRow?.value || 'IN'` in migrations v23 and v24 in
`main/db.ts`, which normalize pre-existing customer phone numbers on an upgrading install. Both
carry a comment marking them as historical data cleanup, not a live store's regional identity. Any
other match is a reintroduced fallback and should be treated as a bug.

**Change policy:** the no-default-country rule and the derived-value model are structural. Adding a
per-store override or a fallback path requires a product decision, because it reintroduces the
silent disagreement the rule exists to prevent.

---

## Supplies stock and recipe depletion

**Rule:** Supplies, the ingredients and packaging tracked for recipe depletion, have their own
tables (`supplies`, `supply_movements`) with a signed ledger, separate from product
`inventory_movements`.

1. **Negative stock is allowed and never blocks order taking.** A rush of orders before a morning
   delivery is logged still goes through the POS. Negative balances are flagged in the UI for
   physical count reconciliation. There is no clamp and no 409.
2. **Depletion happens at order creation and at item append**, when `recipe_snapshot`, an immutable
   JSON copy of the scaled recipe components, is written to `order_items`.
3. **Restoration is keyed off the snapshot, never the current recipe.** Cancelling a pending item
   or an order restores exactly what the snapshot recorded, even if the recipe was edited since.
4. **Void after preparation is physical waste.** Items voided while in progress, ready, or
   completed restore neither supplies nor product stock. Only a `pending` cancel restores.
5. **Refunds never restore supplies**, matching product inventory behaviour.
6. **Product stock tracking and recipe depletion are independent** and may both be active on the
   same product.

**Reason:** POS availability during a stockout matters more than ledger neatness. A store that
cannot sell because flour has not been counted in yet is worse than a negative row to reconcile
later. Snapshots keep historical cancellations correct under recipe edits, mirroring the existing
`tax_snapshot` pattern.

**Enforced by:** `applySupplyStockChange()` in `main/services/supplies.ts`, which does not clamp;
`buildRecipeSnapshot()` and `applyRecipeSnapshot()` in `main/services/recipes.ts`; the order
creation, item append, item cancel and item restore paths in `main/routes/orders.ts`. Restore acts
only on a `cancelled` item, re-deducts its inventory and recipe components, and returns it to
`pending`; a `voided` item is never restored.

**How to verify:**

```sh
npm run test:recipe-order-lifecycle   # deplete, restore, void-no-restore, snapshot immutability
npm run test:supplies-service         # negative stock, ledger, pagination
```

**Change policy:** allowing negative stock and snapshot-keyed restoration are the load-bearing
parts. Clamping stock or restoring from the live recipe would break historical correctness, so
either needs explicit confirmation.

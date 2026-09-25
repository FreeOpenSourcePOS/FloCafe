# Business decisions

**Status: CURRENT**

This is the canonical log of explicit product/business decisions — rules chosen by the product owner that shape FloCafe's behavior and aren't derivable from reading the code alone. It exists so that anyone (human or AI agent) making a change can check whether their approach would silently contradict a decision that was already made deliberately, rather than rediscovering or re-litigating it.

**Before implementing a change that touches authorization, access control, defaults, or another area covered below, read this file.** If a task seems to require deviating from a decision here, stop and confirm with the user explicitly — do not assume the decision is stale or was a mistake just because it's inconvenient for the task at hand. If a decision genuinely no longer fits (the product has grown, a new constraint appeared), update this file in the same change that changes the behavior, with a note on what changed and why — never let code and this document drift apart silently.

This document is a peer of the `AGENTS.md` core invariants, not a replacement: invariants there are the small set of load-bearing rules every change must respect; this file is the fuller, growing log of specific decisions, including narrower ones that wouldn't belong in that short list.

## How entries are structured

Each decision states: the rule, why it exists, where it's enforced in code, how to verify the codebase still complies, and when it was decided. "How to verify" should be something an agent can actually run (a grep, a test suite) — a decision without a verifiable check is easy to violate by accident.

---

## Orders are never ownership-gated

**Rule:** Any staff role with order access (owner, manager, cashier, server — see `docs/reference/roles-and-permissions.md`) can view and act on **every** order, regardless of who created it. There is no "this is my order" restriction anywhere in the system.

**Why:** FloCafe is an open system by design. Restricting staff to only the orders they personally created adds friction (a waiter covering a colleague's table, a manager checking in on any order) without a real security benefit for this product — accountability comes from knowing who did what, not from hiding data between staff who already share a till and a kitchen.

**What restriction remains instead:**
1. **Role-based page/feature access** — e.g. chef cannot open the Orders page at all; cashier cannot access owner/manager-only settings.
2. **Role-based restriction on a specific action** — e.g. KDS stage transitions (marking an item "preparing"/"ready"/"served") are chef/manager/owner-only (`ROLE_ACCESS.kitchen`), further narrowed by the chef's assigned kitchen station and category (see `main/routes/order-items.ts`). A server can place an order but cannot do the kitchen's job on it.
3. **Audit attribution** — every order and write is still recorded against the authenticated actor (`user_id`, `created_by`, etc.). This is for the audit trail (who did what), not for gating access.

**Enforced by (i.e., where this would be violated if reintroduced):** `main/routes/orders.ts` (order list, `GET /:id`, `POST /:id/items`, `PATCH /:id/status`), `main/routes/index.ts` (item cancel/void), `main/routes/printers.ts` (`print-kot`). None of these compare `order.user_id` (or an item's creator) against the requesting user to decide access.

**How to verify:** `grep -rn "role === 'server'" main/routes/ | grep -i "user_id"` (or similarly, `grep -rn "user_id !== " main/`) should return **nothing**. If it returns a match, that's a reintroduction of this pattern and should be treated as a bug, not a feature — confirm with the user before keeping it.

**Decided:** 2026-09-12. Reverses a restriction that existed in the codebase and was at one point documented as fixing "vuln-0007: IDOR on Order List Endpoints" (see `tests/security-hardening.test.ts` history) — that framing was the prior, now-corrected understanding; this entry is the current one.

---

## Refunds and Staff Approval PINs

**Rule:** The initial owner must create and confirm a separate 4-6 digit Staff Approval PIN during first-run setup. It is stored as a bcrypt hash in the owner user record and is independent from the device Master PIN. Owners (and, within the first hour of an order, managers too) can refund a bill that has already been paid — in full, partially, or for a single item — without restocking inventory. The refund can be paid back in a different method than the customer originally used, or issued as store credit. Specifically:

1. **Selected approver:** every refund request must identify one approver with `approver_id`. `manager_id` remains a compatibility alias, but missing IDs and conflicting `approver_id`/`manager_id` values are rejected. Only the selected active owner or manager is checked, and the submitted PIN must be that user's Staff Approval PIN. The device Master PIN never authorizes a refund.
2. **Ceiling:** a refund can never exceed `paid_amount − sum(prior refunds)` for that bill (not the order's gross total), so a bill already partially refunded can't be refunded again past what's actually left outstanding. Enforced by `getRefundableBalance()` in `main/services/refund.ts`.
3. **Approval tiers, keyed off the order's `created_at`:**
   - Within 1 hour of order creation: the selected active owner's or manager's Staff Approval PIN (in-progress orders, unchanged).
   - After 1 hour but still the same business day (per the tenant's configured timezone and `business_day_start_time`, via `dayBoundsInTimezone()`): the selected active owner's Staff Approval PIN only - a manager PIN is rejected outright. There is no kitchen/service context left to sanity-check a request once the order is effectively closed, so the bar is raised rather than reused.
   - Once the order's business day has ended: refused entirely (409), regardless of who approves. A merchant needing to reverse an older transaction does so outside the system (e.g. a manual adjustment), not through this endpoint.
4. **Item eligibility** for a single-item refund now includes `served` and `completed`, not just `preparing`/`ready` — a served/completed item is exactly what "already-completed order" refunds are for.
5. **Refund payment method is independent of the original payment method(s)** — a card payment can be refunded in cash, or vice versa. This is deliberate (per the product decision behind this feature), not a validation gap.
6. **Store credit** (`method: 'wallet'`) requires loyalty to be enabled and the bill to have a customer attached. It's recorded as a plain `credit` row in `loyalty_ledger` (the same mechanism cashback uses), so it's immediately spendable — no separate "refund credit" ledger type exists. This does **not** double-count as cashback on respend: `calculateCashback()` in `main/routes/bills.ts` already excludes wallet-funded spend from the cashback base.
7. **Accepted limitation:** refunding an item/order does **not** claw back cashback that was already credited on that sale at payment time. Given FloCafe's current install-base scale (see `AGENTS.md` "Lessons from past mistakes"), building proportional cashback clawback was judged not worth the complexity for a v1. Revisit if this is observed to be abused.
8. **No per-role permission grant exists yet.** Refund initiation is gated the same way it already was (`ROLE_ACCESS.ownerManager` at the route), not by a configurable owner-editable grant — `docs/reference/roles-and-permissions.md` already documents that role configuration/IAM isn't available. Letting an owner grant refund access to other roles (e.g. cashier) is deferred to that future IAM work, not built here.
9. Inventory is never restored by a refund (item-level or whole-bill) — consistent with how item voids/cancellations already behave.

**Why:** Requested as a controlled way to reverse completed sales without reopening the order-editing surface, while keeping the two things most exposed to misuse — how far back a refund can reach, and who can approve one — deliberately tight (same-business-day cutoff, owner-only once the in-progress window has passed).

**Enforced by:** `main/routes/auth.ts` (`/setup/initialize`), `main/services/refund.ts` (`createRefund`, `resolveRefundApprover`, `REFUND_ITEM_ELIGIBLE_STATUSES`), `main/routes/refunds.ts`, and `frontend/src/components/orders/RefundModal.tsx`. Audit trail: every refund now also writes a `refund_issued` row to `order_audit_log` (previously refunds were only recorded in the `refunds` table).

**How to verify:** `npm run test:refunds` (original in-progress-refund behavior, budget-sensitive — see that file's header) and `npm run test:refund-completed-orders` (business-day tiers, expanded item eligibility, store credit, and the audit-log entry).

**Decided:** 2026-09-17.

---

## Regional settings come from signup, never from a fallback

**Rule:** The country the owner selects during first-run setup — and the ISO 4217 currency selected alongside it — are the only source of a store's regional identity. The country's currency is recommended, but the owner may select another supported currency. Currency symbol, symbol position, fraction digits, number separators, and the default timezone are **derived** from those two values using international conventions (CLDR via `Intl`, ISO 4217, IANA time zones). There is no default country, no hard-coded currency symbol, and no per-store override of a derived value anywhere in the codebase. If regional settings are missing, code fails loudly (`RegionalNotConfiguredError`, HTTP 409) rather than rendering India.

**Post-setup currency changes are destructive:** A configured store cannot reinterpret existing amounts in a new currency. Only an owner may change currency after setup, through the dedicated Master-PIN-gated currency-reset flow. FloCafe takes a full recovery backup, recreates the local database, and preserves only categories, products, add-on groups, add-ons, and their relationships. Product prices, product costs, stock balances, tax assignments, cashback percentages, and add-on prices reset to zero/defaults. All other local data is erased and first-run setup is required again. Changing country alone changes the recommendation, never the active currency.

**Why:** Before this decision the codebase carried `'IN'` / `'INR'` / `'₹'` / `'Asia/Kolkata'` as silent fallbacks in more than a dozen places, the install seed wrote them before the owner had chosen anything, and surfaces disagreed on which symbol to print. A non-Indian store could see rupees on one receipt and its own currency on another. The owner's instruction: the user picks country and currency at signup, it stays consistent throughout the application, and the app follows the conventions people already use rather than inventing overrides.

**What this rules out:** merchant-editable currency symbols and merchant-selectable prefix/suffix placement (both asked for in issue #693). If a locale's rendering is wrong, the fix is the country profile in `main/countries.ts`, which corrects every store in that country.

**Enforced by:** `docs/regional-snapshot.md` (ACTIVE DESIGN), `resolveRegionalSnapshot()` in `main/countries.ts`, the first-run wizard requiring a country, `POST /setup/initialize` rejecting a missing country, `seedInstallDefaults()` in `main/db.ts` no longer writing regional keys, and `POST /api/db-tools/currency-reset` as the only post-setup currency-change path. Ordinary business and wildcard settings writes reject an actual currency change with `currency_change_requires_reset`.

**How to verify:** `npm run test:currency`; additionally, `grep -rn "|| 'IN'\|?? 'IN'\||| 'INR'\|?? 'INR'\||| '₹'\|?? '₹'\||| 'Asia/Kolkata'\|?? 'Asia/Kolkata'\|getCountryByCode('IN')" main frontend/src shared --include='*.ts' --include='*.tsx'` should return nothing outside test files. A match is a reintroduced fallback and should be treated as a bug.

**Decided:** 2026-09-18. Currency recommendation and destructive post-setup change contract amended 2026-09-23.

---

## Supplies stock and recipe depletion

**Rule:** Supplies (ingredients/packaging) track stock in dedicated tables (`supplies`, `supply_movements`) with a signed ledger, separate from product `inventory_movements`. Depletion and restoration rules:

1. **Negative stock is allowed and must never block order taking.** A rush of orders before a morning delivery is logged still goes through at the POS; negative balances are flagged in the UI for physical count reconciliation. No clamp, no 409.
2. **Depletion happens at order creation** (and item append), when `recipe_snapshot` - an immutable JSON copy of the scaled recipe components - is written to `order_items`.
3. **Restoration is keyed off the snapshot, never the current recipe.** Cancelling a pending item or an order restores exactly what the snapshot recorded, even if the recipe was edited since.
4. **Void after preparation is physical waste.** Items voided while `in_progress`/`ready`/`completed` do NOT restore supplies (they do not restore product stock either); only `pending` cancels restore.
5. **Refunds never restore supplies** - same as product inventory behavior.
6. **Product stock tracking and recipe depletion are independent** and may both be active on the same product.

**Why:** POS availability during stockouts matters more than ledger neatness (a store that cannot sell because flour has not been counted in yet is worse than a negative row to reconcile later). Snapshots keep historical cancellations correct under recipe edits, mirroring the existing `tax_snapshot` pattern.

**Enforced by:** `main/services/supplies.ts` (`applySupplyStockChange` - no clamping), `main/services/recipes.ts` (`buildRecipeSnapshot`, `applyRecipeSnapshot`), `main/routes/orders.ts` (deplete on create/append, restore on order cancel), `main/routes/index.ts` (restore only on pending item cancel; re-deplete on item restore).

**How to verify:** `npm run test:recipe-order-lifecycle` (deplete, restore, void-no-restore, snapshot immutability) and `npm run test:supplies-service` (negative stock, ledger, pagination).

**Decided:** 2026-09-22.

---

*(Add new decisions above this line, most recent first is not required — organize by topic. Keep each entry self-contained: a future reader should not need this conversation's context to understand the rule, why it exists, or how to check it.)*

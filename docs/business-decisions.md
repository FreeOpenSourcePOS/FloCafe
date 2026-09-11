# Business decisions

**Status: CURRENT**

This is the canonical log of explicit product/business decisions — rules chosen by the product owner that shape FloCafe's behavior and aren't derivable from reading the code alone. It exists so that anyone (human or AI agent) making a change can check whether their approach would silently contradict a decision that was already made deliberately, rather than rediscovering or re-litigating it.

**Before implementing a change that touches authorization, access control, defaults, or another area covered below, read this file.** If a task seems to require deviating from a decision here, stop and confirm with the user explicitly — do not assume the decision is stale or was a mistake just because it's inconvenient for the task at hand. If a decision genuinely no longer fits (the product has grown, a new constraint appeared), update this file in the same change that changes the behavior, with a note on what changed and why — never let code and this document drift apart silently.

This document is a peer of the `AGENTS.md` core invariants, not a replacement: invariants there are the small set of load-bearing rules every change must respect; this file is the fuller, growing log of specific decisions, including narrower ones that wouldn't belong in that short list.

## How entries are structured

Each decision states: the rule, why it exists, where it's enforced in code, how to verify the codebase still complies, and when it was decided. "How to verify" should be something an agent can actually run (a grep, a test suite) — a decision without a verifiable check is easy to violate by accident.

---

## Orders are never ownership-gated

**Rule:** Any staff role with order access (owner, manager, cashier, server — see `docs/roles-and-permissions.md`) can view and act on **every** order, regardless of who created it. There is no "this is my order" restriction anywhere in the system.

**Why:** FloCafe is an open system by design. Restricting staff to only the orders they personally created adds friction (a waiter covering a colleague's table, a manager checking in on any order) without a real security benefit for this product — accountability comes from knowing who did what, not from hiding data between staff who already share a till and a kitchen.

**What restriction remains instead:**
1. **Role-based page/feature access** — e.g. chef cannot open the Orders page at all; cashier cannot access owner/manager-only settings.
2. **Role-based restriction on a specific action** — e.g. KDS stage transitions (marking an item "preparing"/"ready"/"served") are chef/manager/owner-only (`ROLE_ACCESS.kitchen`), further narrowed by the chef's assigned kitchen station and category (see `main/routes/order-items.ts`). A server can place an order but cannot do the kitchen's job on it.
3. **Audit attribution** — every order and write is still recorded against the authenticated actor (`user_id`, `created_by`, etc.). This is for the audit trail (who did what), not for gating access.

**Enforced by (i.e., where this would be violated if reintroduced):** `main/routes/orders.ts` (order list, `GET /:id`, `POST /:id/items`, `PATCH /:id/status`), `main/routes/index.ts` (item cancel/void), `main/routes/printers.ts` (`print-kot`). None of these compare `order.user_id` (or an item's creator) against the requesting user to decide access.

**How to verify:** `grep -rn "role === 'server'" main/routes/ | grep -i "user_id"` (or similarly, `grep -rn "user_id !== " main/`) should return **nothing**. If it returns a match, that's a reintroduction of this pattern and should be treated as a bug, not a feature — confirm with the user before keeping it.

**Decided:** 2026-09-12. Reverses a restriction that existed in the codebase and was at one point documented as fixing "vuln-0007: IDOR on Order List Endpoints" (see `tests/security-hardening.test.ts` history) — that framing was the prior, now-corrected understanding; this entry is the current one.

---

*(Add new decisions above this line, most recent first is not required — organize by topic. Keep each entry self-contained: a future reader should not need this conversation's context to understand the rule, why it exists, or how to check it.)*

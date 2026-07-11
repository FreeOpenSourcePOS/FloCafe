# Changelog

All notable changes to Flo Cafe are documented here. Dates are release dates, not commit dates. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [1.8.3] - 2026-07-12

### Added
- Zero-touch cloud registration on the POS side (register → pending → claim flow against FloAdmin).
- Reference/demo dashboard pages for a masonry-style KDS board and a settled-order history grid, for layout comparison against the live pages.

### Fixed
- KDS order cards no longer stretch to match the tallest card in their grid row — a 1-item ticket now sizes to its own content instead of a 6-item neighbor's height.
- `GET /tables` no longer queries the nonexistent `is_active` column; added back an `active` query param for frontend API compatibility.
- Category deletion now warns and offers reassign-or-bulk-delete when a category still has active products, instead of orphaning them.
- Table checkout modal edge case that could leave bad data in place if no matching branch applied.
- Table list now refreshes after holding or restoring an order in POS.

### Known issues
- **Orders page grid layout (WIP):** re-restored the 2-3 column grid on the Orders and Held Orders tabs after it was reverted to a vertical list with no explanation. Not yet re-verified visually as working correctly — treat as work in progress.

## [1.8.2] - 2026-07-11

### Added
- Cross-device held orders synchronization via the backend, complete with a resume button in POS.
- Dynamic IP detection and Tailscale/VPN/Mesh network support for Kitchen Display System (KDS) pairing.
- Bill-style order cards on the Orders page for a more intuitive layout.
- Dashboard insights and owner-restricted analytics.
- Cart quantity aggregation for product grid badges in POS.

### Fixed
- Reverted all order tabs (including held orders) to the standard vertical list layout.
- Corrected an invalid column reference (`t.name` to `t.number`) in the `recentOrders` SQL query.
- Linux restore from tray issues and implemented a singleton lock mechanism for graceful resource cleanup on force exit.
- Ensured a unique ID is assigned when creating a new category.
- Improved POS phone lookup to show the matched customer name before auto-selecting.

## [1.8.0] - 2026-07-09

### Added
- Classic receipt template redesigned: header now shows the store name in a large Font A, followed by the customer's name (Font B) and mobile number when the bill has a customer attached.
- Loyalty points on the printed bill: redeemed points shown above the subtotal, and a new "Points Earned" / "Points Balance" section sourced from the loyalty ledger.
- Footer now prints store address, phone, and Instagram handle (new `Settings → General → Instagram Handle` field) instead of a plain "Thank you!" line. Every optional line — customer info, discount, points, each footer field — is only printed when that data actually exists.
- Real ESC/POS Font A/Font B switching in the thermal printer driver.

### Fixed
- Amount columns on thermal receipts no longer wrap a trailing "00" onto the next line. The currency symbol is now resolved to its final printed form (unicode symbol or 2-letter ASCII code, e.g. `Rs`) *before* column padding is computed, instead of being swapped in afterwards and silently overflowing the line width.
- Business address and phone number were silently blank on every printed bill — the print route was reading them from settings keys that are never written. Fixed to read the keys the Settings page actually saves to.
- Inclusive tax was being double-counted against order totals and discounts (#66).

## [1.7.9] - 2026-07-07

### Added
- Split payments, discounts, and wallet (loyalty) redemption in cart checkout.

### Fixed
- Discount edits no longer clobber existing payment splits; hardened the discount PIN flow.
- Bill printing now actually attempts the print before reporting success; added a reprint banner.
- Stopped discount tax compounding and blocked restoring items on already-paid orders.
- Restored first-run restaurant onboarding flow.

### Changed
- Simplified the loyalty program to fixed cashback/redemption rates.

---

Older releases: see [GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases).

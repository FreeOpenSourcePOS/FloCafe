# Gap analysis

Every feature the product plan asks for, checked against FloCafe at `b5928ec` by reading the code. Nothing here was run.

| Class | Meaning | Count |
| :--- | :--- | :--- |
| EXISTS | Works today | 11 |
| SETTING | Needs configuration or seed data | 7 |
| PARTIAL | Something close exists | 11 |
| BUILD | Nothing usable | 5 |

## A. Menu and navigation

| # | Feature | Class | Evidence | Gap |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Large colour-coded category buttons | PARTIAL | `categories.color`, `icon` (`main/db.ts:10593-10594`); small name-only chips (`frontend/src/components/pos/ProductGrid.tsx:28-59`) | Large buttons and icons are not drawn. Colour must be a colour name; hex shows uncoloured (`ProductGrid.tsx:153-287`). |
| 2 | Nested categories on the POS | EXISTS | Two levels; a second chip row for sub-categories (`ProductGrid.tsx:391-397, 514-534`) | A top category shows only products assigned directly to it (`ProductGrid.tsx:399-409`). |
| 3 | Popup to add several small items | BUILD | Not found | — |
| 4 | Simplified sidebar | PARTIAL | `Sidebar.tsx:78-157, 196-226` | Tables, kitchen display and WhatsApp hide by settings. Dashboard, Inventory, Expenses and Staff hide only by permission overrides (`main/services/authorization.ts:59-90`). There are no "Printers" or "Reports" entries: printers are a settings tab and reports are the dashboard. |
| 5 | Favourites or quick-pick row | BUILD | No such field or feature | `CollapsiblePosChoices.tsx` is a reusable chip row only. |

## B. Customising items

| # | Feature | Class | Evidence | Gap |
| :--- | :--- | :--- | :--- | :--- |
| 6 | Variants as sizes | EXISTS | `product_variants` (`main/db.ts:9654-9673`); price replaces base (`main/services/product-variants.ts:79-86`) | Seed data only. |
| 7 | Add-on groups with min, max, required | EXISTS | `main/db.ts:10633-10668`; server check `main/routes/orders.ts:560-600` | Category links apply from the product's own category only, not its parent. |
| 8 | Edit one line; split `2x` | PARTIAL | Edit dialog (`pos/page.tsx:1970-1979`); identical lines merge (`frontend/src/store/cart.ts:130-154`) | No split. |
| 9 | Per-line notes | EXISTS | `special_instructions`; printed on the kitchen ticket (`main/printers/document-kot.ts:79`) | No preset note chips. |
| 10 | Combos and deals | BUILD | Not found | — |
| 11 | Half or whole placement, per-size topping price, removed default | BUILD | `addons.price` is one number (`main/db.ts:10651`) | — |

## C. Saved presets

| # | Feature | Class | Evidence | Gap |
| :--- | :--- | :--- | :--- | :--- |
| 12 | Save a configured item as a preset | BUILD | Not found | — |
| 13 | A customer's usual order | PARTIAL | `GET /api/customers/:id/top-items` (`main/routes/customers.ts:513-528`), shown once a customer is attached (`CustomerTopItems.tsx:24-54`) | Product level only; the earlier configuration is not replayed. |

## D. Orders and customers

| # | Feature | Class | Evidence | Gap |
| :--- | :--- | :--- | :--- | :--- |
| 14 | Pickup and delivery with address, note, charge | PARTIAL | Types `dine_in`, `takeaway`, `delivery`, `online` (`CartPanel.tsx:66, 274`); address and note sent (`pos/page.tsx:1728-1738`) | No "pickup" name (takeaway serves). Dine-in and online cannot be hidden by a setting. The POS never sends `delivery_charge`; a custom charge can carry a fee but is not taxed. |
| 15 | Phone lookup; country code | SETTING | `main/routes/index.ts:284-320`; dial code from the shop's country (`CreateCustomerModal.tsx:32-33`) | Country `CA` gives `+1`. The `+91` in the schema is only a column default. |
| 16 | Held orders | PARTIAL | Dine-in with a table on postpaid billing only (`CartPanel.tsx:394-399`, `main/routes/held-orders.ts:158-164`) | Parking a pickup order does not exist. |
| 16b | Scheduled orders | SETTING | `docs/architecture/order-lifecycle.md:72-134` | `scheduled_orders_enabled=true`. |
| 17 | Order number format | EXISTS | Prefix, date and daily reset settings (`main/db.ts:11281-11283, 11501-11520`) | Default `ORD-20261125-0001`; a daily reset forces the date in. |

## E. Printing

| # | Feature | Class | Evidence | Gap |
| :--- | :--- | :--- | :--- | :--- |
| 18 | Kitchen ticket header | PARTIAL | `shared/print/document.ts:1610-1698` | Prints station, order number, table, type, customer name, time, notes. No phone, no delivery address (those are on the separate delivery slip). |
| 19 | Large kitchen fonts | SETTING | Per-printer `text_size` (`shared/print/text-size.ts:1-24`) | Whole ticket, not per field. |
| 20 | Customer receipt | EXISTS | `buildBillDocument` (`document.ts:582`); cash tendered and change (`document.ts:387-401`) | `bill_show_tax_id` and `tax_registration_number` for a GST number. |
| 21 | Station routing, second printer | SETTING | `kitchen_stations` (`main/db.ts:10678-10692`), `main/routes/printers.ts:1324-1397` | Seed printers and stations; `auto_print_kot=true`. |
| 22 | Cash drawer pulse | SETTING | `main/printers/thermal.ts:1123-1160` | `cash_drawer_pulse_enabled=true`, methods `["cash"]`. Fires only when a receipt prints. |
| 23 | Tablet prints through the server | EXISTS | `frontend/src/hooks/usePrinter.ts:189-191, 434-445` | Bill auto-print is a per-browser setting and cannot be seeded. |

## F. Checkout and reports

| # | Feature | Class | Evidence | Gap |
| :--- | :--- | :--- | :--- | :--- |
| 24 | Cash with quick tender and change; record-only card | EXISTS | `CheckoutPaymentStation.tsx:17, 160-161`; `payment_methods` (`main/db.ts:8505-8513`) | Built-in names cash and card cannot be renamed. |
| 25 | Sales, cash against card, tax, order count, audit log | PARTIAL | `main/routes/reports.ts:372, 464, 516, 571` | No weekly preset (use a range). The audit log is written but has no list screen. |
| 26 | End-of-day report | EXISTS | `main/routes/cash-closures.ts:1422, 1699`; `reports.ts:1321-1817` | — |
| 27 | Backup, restore, automatic backups | PARTIAL | `main/routes/database.ts:103-930`; `main/services/local-backup.ts:1-26` | Automatic backups start only in the desktop app, not headless. |
| 28 | CSV and Excel export | EXISTS | `reports.ts:1973` | — |
| 29 | Staff PINs, roles, refunds, voids | EXISTS | `main/routes/auth.ts:709`; `shared/permissions.ts:92, 192` | — |

## G. Region and tax

| # | Feature | Class | Evidence | Gap |
| :--- | :--- | :--- | :--- | :--- |
| 30 | Canada, CAD, time zone | SETTING | `main/countries.ts:71-77` | Chosen in the setup request; a profile cannot set it. Default zone is Toronto. |
| 31 | GST on food plus PST on soda | PARTIAL | Engine model in `docs/architecture/taxation.md:31-53`; two-rule example `main/tax-packs/community-france.json:20-50` | The engine can express it. No Canada pack, and a pack file alone is not installable. Manual configuration works (`main/routes/tax-packs.ts:1262-1402`). `taxes_enabled` defaults to off. |
| 32 | Tax-exclusive prices | SETTING | `main/services/tax-engine.ts:273-279` | Manual configuration defaults to inclusive; send `inclusive: false`. |

## H. Setup and privacy

| # | Feature | Class | Evidence | Gap |
| :--- | :--- | :--- | :--- | :--- |
| 33 | Setup profiles | PARTIAL | `main/routes/auth.ts:116, 1666`; `main/setup/seed-data.ts:2421-2433` | Existing profiles seed categories and products only: no settings, variants, add-ons, printers or tax. |

### 34. What contacts the internet without the owner asking

| What | Setting | Default | When |
| :--- | :--- | :--- | :--- |
| Cloud registration and sync to `blue.flopos.com` | `cloud_sync_enabled` | On; setup forces it on (`main/routes/auth.ts:1787`) | Right after setup. Sends business name, owner name, email, phone, address, host name, locale, time zone (`main/services/cloud-sync.ts:1554-1580`). |
| Anonymous telemetry to `telemetry.flopos.com` | `telemetry_enabled` | On (`main/db.ts:11256`) | Every desktop app launch, including before setup. |
| Update check on GitHub | `updates.auto_check_enabled` | Unset counts as on | Five seconds after desktop app launch. |
| Tax catalogue fetch from GitHub | none | Always | Five seconds after desktop app launch. |
| PostHog | `posthog_project_token` | No token in a fork build | Sends nothing without a token. |
| Diagnostics | `diagnostics_transmission_enabled` | Off | — |
| WhatsApp, Google Drive | owner sign-in | Off | — |
| **`offline_mode`** | `offline_mode` | **Off** | Switching it on blocks every row above (`main/services/offline-mode.ts`). |

The first four happen in the desktop app. The headless server starts none of them, but completing setup still writes `cloud_sync_enabled` on.

## What the product plan assumed that is not true

1. Held orders work for the counter. They work only for dine-in tables.
2. The kitchen ticket shows phone and delivery address. It does not.
3. The POS is quiet by default. It registers the business with an outside service after setup.
4. A tax pack file is enough for BC. It is not installable; manual configuration is.
5. A setup profile can set the region. It cannot; the setup request must.
6. Identical items can be split. They only merge.
7. The delivery charge field is used. The POS screen never fills it.
8. Order numbers are short. They carry the date when they reset daily.
9. Automatic backups run headless. They run only in the desktop app.

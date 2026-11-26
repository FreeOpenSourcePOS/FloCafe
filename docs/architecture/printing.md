# Printing architecture

FloCafe prints through one semantic document model, several renderers, and several transports. This
page describes how those layers divide responsibility, so a change lands in the right one.

For the merchant-authored template wire contract see
[merchant print templates](../reference/merchant-print-templates.md). For the pack-signed
compliance template contract see
[compliance print templates](../reference/print-templates-compliance.md). For script and code-page
constraints that apply to translated label text, see the
[translation terminology reference](../reference/translation-terminology.md).

## The kernel

The print kernel is `shared/print/**`. It contains types and pure functions only: no Electron, no
DOM, no React, no Node built-ins, no database, no filesystem, no network, no transport IO. It
imports nothing outside `shared/print/`.

The kernel holds no knowledge of which languages exist. `PrintLanguageCode` is a structural
`string`, and callers inject the answer to "is this code a registered, selectable language?" as the
`LanguageRegistryFacts.isSelectableLanguage` predicate. The renderer injects its view of
`frontend/src/lib/i18n/languages.ts`; the backend injects its view derived from the generated print
label table in `main/print/print-labels.generated.ts`. This keeps the dependency direction strictly
one-way:

```text
registry  ->  call site  ->  kernel
```

**A limit worth knowing:** the static purity audit in `tests/print-document.test.ts` checks a
hard-coded list of five kernel modules, `document.ts`, `direction.ts`, `bilingual.ts`, `types.ts`,
and `policy.ts`. The other kernel modules are not covered by that audit, so an import of an IO
module in, for example, `raster.ts` or `width.ts` is not caught by it. `tests/kernel-purity.test.ts`
checks the consumer boundary from outside the kernel; it does not close this gap.

### Module map

| File | Contents |
| --- | --- |
| `types.ts` | `PrintLanguageCode`, `TextDirection`, `DirectionScope`, the policy shapes, and `LanguageRegistryFacts`. |
| `concepts.ts` | `PRINT_CONCEPT_IDS`, the typed concept-id catalog boundary. |
| `document.ts` | `PrintDocument` v1, `KotDocument` v1, and `DeliverySlipDocument` v1, the block types, and the pure `buildBillDocument` / `buildKotDocument` / `buildDeliverySlipDocument` builders. |
| `direction.ts` | Per-scope direction resolution and LTR-island classification. |
| `policy.ts` | `parsePrintLanguagePolicy`, `parseKotLanguagePolicy`, and the language resolvers. |
| `bilingual.ts` | `BilingualLabel` and width-fit strategies. |
| `width.ts` | Grapheme- and display-cell-aware measurement and truncation. |
| `detail-lines.ts` | `readDetailLines` and `detailLineRows`: the ready-formatted lines an order item prints under its heading, with their indent and wrap rule. |
| `kot-contact.ts` | `kotContactLines`: the customer phone, delivery address, and delivery note a kitchen ticket header prints when `kot_show_customer_contact` is on. |
| `thermal-capabilities.ts` | Capability shape, code pages, representability, and warning policy. |
| `merchant-template.ts` | Merchant template payload validation and canonical serialization. |
| `raster.ts`, `raster-canvas.ts`, `image-raster.ts` | Raster band construction, shared canvas painter (`paintRasterRequest`), ESC/POS raster encoding, and 1-bit logo trimming, contrast normalization, dithering, and packing. |
| `z-report.ts`, `layout.ts`, `currency.ts`, `warnings.ts` | Z-report assembly, column layout, currency tokens, and warning shapes. |
| `text-size.ts` | `PrinterTextSize`, column halving (`layoutColumnsForTextSize`), ESC/POS enlargement (`applyTextSizeToLines`), and encoder wrapping (`configureEncoderTextSize`). |

## Document models

`PrintDocument` v1 is a renderer-independent receipt: an ordered list of blocks, each carrying its
own resolved direction, plus the ordered languages the labels were resolved in. The block
vocabulary is `business-header`, `document-meta`, `customer`, `item-table`, `tax-breakdown`,
`totals`, `payments`, and `message`. An `item-table` row carries an optional `detailLines` list;
see [item detail lines](#item-detail-lines).

`KotDocument` v1 is the same shape for a kitchen ticket, with a reduced block vocabulary:
`kot-header` (carrying station and order metadata, an optional large bold order number callout banner,
optional [customer contact lines](#customer-contact-on-kitchen-tickets), plus an optional
order-level notes banner) and `kot-items`, whose rows carry the same optional `detailLines` list.

`DeliverySlipDocument` v1 is a courier handout: `delivery-slip-header`,
`delivery-slip-contact`, optional `delivery-slip-notes` and
`delivery-slip-payment`, then `delivery-slip-items`. The payment block shows the paid method(s) and
total with zero due, or the selected bill balance(s) as amount due. Refund status stays visible and
does not hide a refund-marked bill's positive stored balance; when no bill exists, the slip falls
back to the order total. An unpaid balance also names the order's `expected_payment_method`: Cash on
Delivery for cash, otherwise the method, Pending, or Unknown when none was recorded. It is an
expectation, never a payment, and a paid slip shows the captured method instead. When the order
carries an `expected_payment_method_id`, the stored name is the historical snapshot of a configured
method and prints literally instead of resolving through a builtin or sentinel label, so a configured
method named Pending or Unknown keeps its own meaning on the slip even when the method is later
renamed or deactivated. The notes block
carries the courier-only `delivery_note` beside the order note. The expected method is printed on
neither a kitchen ticket nor a receipt. The delivery note is never printed on a receipt, and reaches
a kitchen ticket only when
[customer contact on kitchen tickets](#customer-contact-on-kitchen-tickets) is on. It is a
**separate kind, not a receipt template**, and that is load-bearing. It carries the delivery address and the full customer number
when the caller's visibility rule permits it. The API route and browser/WebUSB hook include the
number when either `bill_delivery_show_customer_phone_always` or `bill_show_customer_phone` is on,
and omit it only when both are off; see [product invariants](../reference/product-invariants.md).
The contact block also records
`addressSource`, so a printed slip records whether the address came from the order or from the
customer's standing record.

### Labels are semantic

A label is a `SemanticLabel`: an optional `conceptId`, a `primary` string, and an optional
`secondary` string holding the same concept in the receipt's second language. The model never
pre-concatenates a bilingual pair. Renderers decide how the two variants share a line.

`print-labels.generated.ts` is derived, never hand-edited. Run `npm run generate:print-labels` to
regenerate it, and `npm run generate:print-labels -- --check` to assert it is not stale.

### The message block

`MessageBlock` carries five semantic entries:

| Entry | Type | Present when |
| --- | --- | --- |
| `reprintBanner` | `SemanticLabel \| null` | The receipt is a reprint. |
| `onlineOrderBanner` | object or `null` | The order carries a platform or external id. |
| `footerNote` | `DirectionalText \| null` | The merchant configured a footer note. |
| `thankYou` | `SemanticLabel \| null` | A thank-you line applies. |
| `taxIncluded` | `SemanticLabel` | Required; carries the tax-inclusive pricing note. |

## Language policy

Four language domains are stored and resolved independently, so a receipt, a kitchen ticket, and a
Z-report can each be in a different language from the same store:

| Setting key | Policy type | Languages |
| --- | --- | --- |
| `bill_language_policy` | `ReceiptLanguagePolicy` | 1 or 2. |
| `kot_language_policy` | `KotLanguagePolicy` | 1. |
| `z_report_language_policy` | Z-report policy | 1. |

A receipt's two-language maximum is enforced at the type level: `ReceiptLanguagePolicy` is
`PrintLanguagePolicy<readonly []> | PrintLanguagePolicy<readonly [PrintLanguageCode]>`, so a
three-language receipt is not representable.

`parsePrintLanguagePolicy` returns a result frozen only at the outer level. The outer `policy`
object is safe to persist verbatim, but its nested `primary` and `additional` values are not
runtime-frozen.

An invalid or missing policy does not fail. It falls back silently to the store language, so a
corrupt policy degrades to a single-language document rather than a blank receipt. Settings
normalization in `main/lib/print-language-settings.ts` and the renderer bootstrap in
`frontend/src/lib/print-policy-bootstrap.ts` both apply that fallback.

## Direction and LTR islands

A printed document carries one base direction. Blocks inherit it, and individual values inside an
RTL document may be LTR islands: an invoice number, a phone number, a SKU, a URL, an amount.

`isLtrIsland()` in `shared/print/direction.ts` classifies a value as a confident LTR island only
when all of the following hold:

- The trimmed value is between 1 and 64 characters. Longer than 64 is false.
- It contains no RTL-script character. Any Hebrew, Arabic, or extended Arabic-range letter is
  false.
- It matches a URL, an email, a phone with at least one digit, or an amount with at least one
  digit; or it matches the identifier pattern with at least one digit and at most three
  whitespace-separated tokens.

The token limit is what keeps ordinary prose out: a single word with a digit is an identifier, but
four whitespace-separated tokens read as a sentence.

## Renderers

| Renderer | Source | Consumes |
| --- | --- | --- |
| Classic | `main/printers/document-classic.ts` | `PrintDocument` |
| Compact | `main/printers/document-compact.ts` | `PrintDocument` |
| Kitchen ticket | `main/printers/document-kot.ts` | `KotDocument` |
| Delivery slip | `main/printers/document-delivery-slip.ts` | `DeliverySlipDocument` |
| Merchant | `main/printers/document-merchant.ts` | Wraps the classic renderer and applies a merchant template's block selection and order. |
| Compliance line template | `escposLineTemplateV1Lines` in `main/printers/thermal.ts` | A pack-signed `escpos-line-template-v1` payload, as a plugin inside the thermal pipeline. |
| Browser HTML | `frontend/src/lib/printer/web-print.ts` and `kot-web-print.ts` | A `PrintDocument` or `KotDocument`, rendered as HTML. |
| WebUSB | `frontend/src/lib/printer/PrinterService.ts` | Encoder output, sent over the browser's WebUSB API. |
| Delivery slip | `frontend/src/lib/printer/delivery-slip-encoder.ts` and `delivery-slip-web-print.ts` | A `DeliverySlipDocument`'s contact facts, rendered as bytes or HTML. |
| Tax bill | `frontend/src/lib/printer/tax-bill-encoder.ts` | A raw `Bill` and `Tenant`, not a document. |
| Payment ticket slip | `printPaymentTicket` in `main/printers/thermal.ts` | Order metadata, item lines, balance due, centered `FLOCAFE-TICKET:<order_number>` text, and (when `raster.enabled` is true) an ESC/POS QR code for multi-counter ordering. |

The tax bill encoder and payment ticket slip generator are exceptions to "renderers consume
documents": the tax bill encoder reads `Bill` directly for per-component tax detail, while
`printPaymentTicket` formats a compact payment ticket slip and optional QR code from order items
and totals.

### Browser HTML printing

`web-print.ts` is the full-Unicode path. It emits `direction` and `unicode-bidi: isolate` on
numeric and LTR spans, so an invoice number or amount inside an RTL receipt renders in the right
visual order.

**Every visible label resolves from a document slot first.** `documentLabel()` reads the
semantic label's `primary` and falls back to the print-label catalog only when the document does
not carry one. `surfaceLabel()` does the same for browser-specific wording: it takes the semantic
override only when the merchant document actually changed the text, otherwise it uses the
browser concept's own catalog entry. A browser-print label is not a string hardcoded in the
renderer.

### Receipt logos

The business settings `receipt_logo` and `receipt_logo_raster` carry the browser image and the
precomputed thermal data; `bill_show_logo` controls whether a bill renderer includes the logo.
`processReceiptLogoFile()` uses a browser canvas to composite transparency on white, trim
surrounding transparent or white margins with a 4 px pad (`findLogoContentBounds()`), scale the
cropped content to at most 576x240 dots (384x240 for 58 mm), normalize grayscale contrast
(`normalizeGrayscaleContrast()`), and generate Floyd-Steinberg dithered 1-bit raster variants for
384- and 576-dot printers. `receipt_logo` stores an adaptively compressed data URL (`<= 200 KB`
target, `250 KB` cap) while `receipt_logo_raster` stores only the packed variants (`originalDataUrl`
is left empty in new payloads, with `parseReceiptLogoData()` accepting both empty and populated
values). Browser bills center the image above the business header. When `rasterCapabilityEnabled()`
is true, the classic and compact ESC/POS renderers and frontend receipt encoders select a raster
variant for the paper width and emit it with `GS v 0` via `{RAW_BYTES:...}`, which the mixed-mode
text rasterizer skips so non-Latin headers never overwrite the logo bitmap. Profiles with
`raster.enabled: false` (such as `escpos-impact-76`) omit `{RAW_BYTES:...}` logo bitmaps. Kitchen
tickets do not use the bill logo setting.

### Order number banners

The business setting `bill_show_large_order_number` controls whether customer receipts and kitchen
tickets print a prominent, bold order number banner. On customer receipts (classic, compact,
merchant, browser HTML, and WebUSB/tax-bill paths), the banner renders centered, double-height, bold
`#<number>` below the invoice header, while preserving the underlying order number in
`DocumentMetaBlock.orderNumber` when `invoiceNumber` is an invoice sequence. On kitchen tickets
(`document-kot`, `kot-encoder`, and `kot-web-print`), it renders centered, double-height, bold
`#<number>` in the header block. When the formatted banner text exceeds the printable width of
narrow or enlarged paper profiles (such as 16-column extra-large KOT), the line layout wraps without
dropping sequence digits. Signed compliance pack receipts (`pluginReceiptLines`) intentionally omit
the callout banner.

### Item detail lines

An order item can carry `detailLines`: a list of ready-formatted text lines, such as the halves and
toppings of a pizza. `readDetailLines()` in `shared/print/detail-lines.ts` reads the list from a raw
item and keeps its non-blank strings. The backend data builders (`buildKotPrintData` and the
backend `buildBillPrintData`) copy it onto the document row. An item with no lines produces a row
without a `detailLines` field and prints nothing extra.

The browser paths build the lines themselves. `orderItemDetailLines(item, columns)` in
`frontend/src/lib/pizza/detail-lines.ts` reads the recipe in the item's `modifier_selection` and
formats it with `ticketLines()` against the pizza catalogue the browser holds, at the column count
of the ticket or receipt being printed. `buildFrontendKotDocument`, the frontend
`buildBillPrintData`, the browser kitchen-ticket encoder, and the HTML renderer all call it. The
HTML ticket has no column grid, so it wraps for `KotWebPrintOptions.columns`, or for the paper
size's own count when that is absent, reduced by `layoutColumnsForTextSize()` for the ticket's
text size as on the ESC/POS path. When no catalogue is loaded, or the item has no recipe, the
helper answers `readDetailLines(item)`, and the output is byte for byte what it is without pizza
logic. A recipe on the item takes the place of any `detailLines` it also carries; the two are
never both printed.

These paths print the lines under the item heading and before the add-ons:

| Document | Paths |
| --- | --- |
| Kitchen ticket | `main/printers/document-kot.ts` (also the target of the raster path, which sends the document built by `buildFrontendKotDocument`), `frontend/src/lib/printer/kot-encoder.ts`, and `frontend/src/lib/printer/kot-web-print.ts`. |
| Classic and compact receipts | `main/printers/document-classic.ts`, `main/printers/document-compact.ts`, and `buildClassicReceiptBytes` and `buildCompactReceiptBytes` in `frontend/src/lib/printer/receipt-encoder.ts`. |

`detailLineRows()` owns the layout on the ESC/POS paths. Every row starts with a three-space
indent. A line no wider than the columns left after the indent prints exactly as given, runs of
spaces included, so the caller that formats the lines controls their alignment. A wider line is
wrapped with `wrapToDisplayCells()`, which breaks on whitespace and rejoins words with single
spaces; no text is dropped or truncated. The backend renderers pass each line through
`safePrinterText()` first, so a line that spells an ESC/POS line token such as `{CUT}` prints as
text. The HTML ticket renders each line with `white-space: pre-wrap`.

On the backend ESC/POS paths, a pizza or deal line gets its detail lines from the recipe in its
`modifier_selection`. `renderKotViaDocument`, `renderClassicReceiptViaDocument`,
`renderCompactReceiptViaDocument`, and `renderMerchantReceiptViaDocument` pass the order's items
through `withRecipeDetailLines(items, columns)` in `main/pizza/order-recipe.ts` before they build
print data. It reads the catalogue from `pizza_menu` once per call and, for each item that holds a
recipe, sets `detailLines` to `ticketLines(catalog, recipe, columns).detailLines`
(`shared/pizza/ticket.ts`), replacing any lines the item carried. `columns` is the renderer's own layout width, the value `resolvePrinterContext()`
returns after [text size](#text-size) is applied, so an extra large printer gets lines wrapped for
half the paper's characters. `ticketLines` keeps every line within that width less the three-space
indent, so `detailLineRows()` prints each one as given and the nesting of halves and deal pizzas
survives. The item heading stays the product name and variant. An item with no recipe keeps the
`detailLines` it carried.

The recipe is not checked against the menu at print time, so an order sold before a menu change
still prints its lines: a pizza, drink, or deal the menu no longer has prints by its id, and a
removed ingredient prints under the name it was sold with.

A recipe that cannot be written out never prints as a bare item. The item's detail lines are the
single line `RECIPE NOT PRINTED - CHECK ORDER`, and the cause is logged with the order item id,
when the `pizza_menu` row is missing or unreadable, when `ticketLines` throws on the recipe, or when
the recipe has a shape `ticketLines` would print short: a pizza without exactly one of `whole` and
two `halves`, a part whose `removed` is not a list, or a deal whose `pops` is not an object. Only a
malformed recipe among the items a client sent to the print route can have such a shape; stored
recipes are normalised when the order is written.

The kitchen display shows the same lines on screen. `withKdsRecipeLines(items)` in
`main/pizza/order-recipe.ts` runs kitchen display items through the same code at a fixed 48 columns
and writes the result to `recipe_lines` on each pizza or deal line, the warning line included. An
item with no recipe gets no such field, and its payload is unchanged. It runs wherever items are
prepared for the display: `GET /api/kitchen/orders`, `GET /api/kds/orders`, `GET /api/kds/display`,
`PATCH /api/kds/items/:id/status`, and `PATCH /api/order-items/:id/status` on the main API,
`GET /api/kds/orders` on the kitchen display server, and the WebSocket snapshot from
`buildActiveOrdersSnapshot()`. `projectKdsItem()` keeps `recipe_lines` for a restricted station. A
display refreshes all day, so a recipe that cannot be written out is logged once per order item.
`RecipeLines` in `frontend/src/components/kds/pizza/RecipeLines.tsx` draws the lines under the item
name, before the add-ons and the note, in the tabs view, the kanban view, and the item window: in a
monospace face, leading spaces kept, a line wider than its card wrapped one cell inside its own
indent, and the warning line on a red band with a warning symbol. The display holds no catalogue.

The detailed receipt (`buildDetailedReceiptBytes`), the tax bill, compliance line templates, the
browser HTML receipt (`web-print.ts`), the delivery slip, and the payment ticket slip do not print
detail lines. `tests/pizza-print-detail-lines.test.ts` covers the paths that print detail lines,
`tests/pizza-order-print.test.ts` covers the lines the server writes from a recipe,
`tests/pizza-kot-browser.test.ts` covers the lines the browser paths build from one, and
`tests/pizza-kds-lines.test.ts` covers the lines on kitchen display items.

### Customer contact on kitchen tickets

The setting `kot_show_customer_contact` adds customer contact lines to the kitchen ticket header,
directly after the customer name. It is off unless its stored value is `true`. `kotContactLines()`
in `shared/print/kot-contact.ts` is the one rule every path applies:

- The customer's phone number as stored, when the order's customer has one.
- The order's `delivery_address` and `delivery_note`, only when the order type is `delivery`.
- A value that is empty prints no line.

The lines reuse the print concepts `print.numberShort`, `print.deliverySlip.address`, and
`print.deliverySlip.deliveryNote`. A line wider than the paper wraps; nothing is truncated.

The setting reaches the four kitchen ticket paths in two ways:

- **Backend ESC/POS.** `printKOT()` merges `kotCustomerContactFields()`
  (`main/pizza/kot-customer-contact.ts`) into the order. It reads the setting and loads the
  customer's phone, which the print routes do not select. `buildKotPrintData`
  turns the resulting `show_customer_contact` flag into `KotOrderSnapshot.contactLines`.
- **Browser ESC/POS, raster, and HTML.** `GET /api/settings/business` returns the flag,
  `hydrateReceiptSettings()` stores it as `kotShowCustomerContact`, and `printKot` in
  `frontend/src/hooks/usePrinter.ts` passes `showCustomerContact` to `buildKotBytes`,
  `buildFrontendKotDocument`, and `generateKotHtml`. These paths read the phone from the `customer`
  object on the order they are given. That route needs `settings.view` or a bill permission, so a
  role with neither keeps the flag off in the browser and its browser tickets omit the contact lines.

The number prints in full, and this setting alone decides it: `bill_show_customer_phone` and
`bill_delivery_show_customer_phone_always` govern receipts and delivery slips, not kitchen tickets.
No Settings screen exposes the setting; it is written with
`PUT /api/settings/kot_show_customer_contact`. `tests/pizza-kot-customer-contact.test.ts` covers
the rule and the route from the stored setting to the printed ticket.

## Transports

| Transport | Mechanism |
| --- | --- |
| Network | Raw socket (`printViaNetwork()` in `main/printers/thermal.ts`). Payloads over 4096 bytes (`NETWORK_PRINT_CHUNK_SIZE`) are sent in 4096-byte chunks with a 10 ms delay between chunks (`NETWORK_PRINT_CHUNK_DELAY_MS`), so a large receipt does not overrun the printer's buffer; smaller payloads are written in a single pass. After writing the payload, `printViaNetwork()` sends `DLE_EOT[1]` (`0x10 0x04 0x01`) and waits for a reply, peer close, or `NETWORK_PRINT_DRAIN_TIMEOUT_MS` (600 ms) before closing the socket so slower printer microcontrollers finish draining trailing commands without stalling silent printers. `validateNetworkPrinterTarget()` (enforced on `/api/printers` configuration, `/:id/status` probes, LAN discovery in `main/printers/lan-discovery.ts`, and `printViaNetwork()` dispatch) rejects cloud metadata endpoints, unspecified/broadcast addresses, and FloCafe's own local listening ports across canonical and non-canonical (shorthand, octal, hexadecimal, and integer) IPv4 forms while preserving hostnames, custom ports, LAN/Tailscale/IPv6 addresses, and link-local printers. |
| CUPS | `lp -d <printer> -o raw <tmpfile>`, using an exclusive (`wx`, `0600`) temporary file with a per-job UUID suffix that is unlinked only if created. |
| Windows | `OpenPrinterW` with `pDataType` set to `RAW`, reading an exclusive (`wx`, `0600`) temporary file with a per-job UUID suffix that is unlinked only if created. Before `StartDocPrinter`, the helper refuses a queue that is set to Use Printer Offline, offline, or not available. For those three refusals only, when the queue's port is a Standard TCP/IP port in RAW mode, `main/printers/windows-queue-bypass.ts` sends the same bytes once to that port with `printViaNetwork()`. No job exists in the spool at that point, so the bypass cannot print a ticket twice. When the port has SNMP status enabled, the failure detail says so and the POS shows how to turn it off. |
| macOS Mac App Store | IPP over the local CUPS UNIX domain socket `/private/var/run/cupsd` (with loopback HTTP fallback on `127.0.0.1:631`) using `main/printers/ipp-client.ts` and `document-format` `application/vnd.cups-raw`, because the macOS App Sandbox blocks shelling out to `lp` and blocks outbound TCP to `localhost:631` while permitting `/private/var/run/cupsd` under `com.apple.security.print`. |
| WebUSB | The browser WebUSB API through the frontend bridge. A browser terminal needs a secure origin, so it opens FloCafe over the [Secure Network](overview.md#secure-network-https-for-lan-devices) HTTPS address; the desktop app uses `localhost`, which is already secure. Permissions are per origin. |

Dispatch failures are classified by `classifyPrintFailure()` into a stable, privacy-safe set:
`not_configured`, `offline`, `needs_attention`, `queue_unavailable`, `spooler_error`, `driver_error`,
`permission_denied`, `timeout`, `write_error`, `unsupported`, and `unknown`. The classification is what fleet telemetry reports,
so it must not embed device names or user data.

### Printer status and discovery

`main/printers/escpos-status.ts` probes a network printer with `DLE EOT` (`0x10 0x04 n`) over one
socket and decodes the answer into online, cover open, paper out, paper near end, and error states.
The probe never throws, and it returns when the first query gets no answer, so a printer that does
not implement `DLE EOT` costs one timeout. `statusToFailureCause()` maps the result to one cause:
`paper_out`, `cover_open`, `printer_error`, `offline`, or `unreachable`. USB queues report
`queue_offline` or `queue_missing` from OS detection. After a test print to a network printer, the
route probes that printer and treats `paper_out`, `cover_open`, `printer_error`, and `offline` as
failures (preserving `failure_class` from dispatch when more specific, such as `timeout`), because a
raw socket can accept bytes that an offline or faulted printer drops. The frontend turns the cause,
or else the failure class and the operating system, into one fix step
(`frontend/src/lib/printer/print-failure-help.ts`).

`main/printers/lan-discovery.ts` finds printers when the Printers page opens. It scans port 9100 on
up to four private /24 networks of this machine, skipping virtual adapters and link-local
addresses, and browses mDNS for `_pdl-datastream._tcp`, `_ipp._tcp`, and `_printer._tcp`, within a
3 s budget. `probePort()`, `scanPort9100()`, and `discoverLanPrinters()` validate each target's
port (`1`-`65535`) and `validateNetworkPrinterTarget()` before acquiring the port lock, opening a
probe socket, or returning merged entries, so disallowed mDNS or scan targets are never probed or
listed. Both `probePort()` and `DLE EOT` status probes share the per-`host:port` FIFO mutex in
`main/printers/network-port-lock.ts` (`withNetworkPortLock()`) with `printViaNetwork()`, so discovery
and status checks serialize behind active print jobs on single-connection `:9100` printers. The macOS
builds declare those services in `NSBonjourServices`.

## Printer profiles

`main/printers/profiles.ts` ships five profiles:

| Id | Make and model | Paper | Font A columns |
| --- | --- | --- | --- |
| `xprinter-xp-v320m-v330m` | Xprinter XP-V320M / XP-V330M | 72 mm, `cols-48` | 48 |
| `escpos-impact-76` | Epson TM-U220 / 76mm Impact | 64 mm, `cols-32` | 32 |
| `epson-tm-series` | Epson TM Series ESC/POS | `cols-48` | 48 |
| `generic-escpos-80` | Generic ESC/POS 80 mm | `cols-42` | 42 |
| `generic-escpos-58` | Generic ESC/POS 58 mm | `cols-32` | 32 |

The four thermal profiles declare `raster.enabled: true` with modes `mixed` and `whole-receipt`, at
576 dots of width except the 58 mm profile, which declares 384. `escpos-impact-76` targets 76 mm
ribbon impact printers (`TM-U220`, `SRP-275`, `XP-76`) with `raster.enabled: false` (`widthDots: 0`,
`modes: []`), so bitmap logos (`GS v 0`), `GS ( k` QR codes, and text-to-bitmap raster bands are
never sent to an impact head.

`resolvePrinterProfile()` resolves in four steps: an explicit `profile_id` persisted on `printers`
(exposed as `configured_profile_id` alongside the resolved `profile_id` on `/api/printers`
responses) if it names a known profile, then a substring match against each profile's make, model,
and aliases, then a model match in `main/printers/escpos-printer-db.json` (a trimmed snapshot of
escpos-printer-db, CC BY 4.0, regenerated by `scripts/sync-escpos-printer-db.cjs`), then the paper
width, which selects `generic-escpos-58` for a width starting `58mm` and
`generic-escpos-80` otherwise. A name that matches nothing does not produce "generic for
everything": it produces one of the two generic profiles, chosen by paper width. OS printer
detection (`detectConnectedPrinters()`) also annotates each queue with
`compatibility: 'escpos_thermal' | 'escpos_impact' | 'driver_only'` via
`classifyDetectedPrinterCompatibility()`, keeping driver-only queues (such as Star `TSP100` /
`TSP143` / `SP700` / `mC-Print`, Epson `EcoTank` / `WorkForce` / `Stylus` inkjets, label printers,
and PDF queues) visible in Settings with a browser-print switch instead of misclassifying them as
raw ESC/POS thermal printers.

`capabilitiesForPrinter()` then caps the profile's raster width to the configured paper width when
that width is narrower than the profile's hardware, so a 42-column configuration on 80 mm hardware
does not raster at full width.

### Capabilities and refusal

`GENERIC_THERMAL_CAPABILITIES` is the conservative baseline: ASCII only, no shaping, representable
scripts limited to `ascii`, transliteration enabled, unsupported text on a non-financial row is
skipped, and unsupported text on a financial row refuses the print.

When a financial row contains text the printer cannot represent natively and raster rendering is
disabled or fails, FloCafe refuses the whole receipt rather than printing a total that is not the
real total. The refusal message names the affected row, explains whether raster rendering failed or
is unavailable, confirms that nothing was sent to the printer, and suggests retrying or using
system/browser printing:

```text
Receipt not printed: a financial row contains unsupported printer text: <text>. The printer cannot print these characters as text, and no image fallback is available on this print path. Nothing was printed, so no amount is missing. Try again, or use system/browser printing.
```

`arabicShaping` on a profile is a deprecated compatibility input. Read `capabilities.shaping.arabic`
instead; `getPrinterCapabilities()` merges the override into the capability set.

### Text size

`printers.text_size` (`normal`, `large`, `extra_large`; default `normal`) enlarges text per printer.
On the backend, `resolvePrinterContext()` reads it (`printerShape()` and `printerReadinessShape()`
also expose normalized `text_size`, and `printerShape()` sets `capabilities.textSize`, on
`/api/printers` responses) and returns two things:
`columns`, the layout width every document renderer targets, and `capabilities.textSize`, which
`buildEscPos()` and the raster path read. On the frontend, `usePrinterStore` resolves the active
printer's `text_size` (`resolveActivePrinterTextSize()` and `resolveWebUsbCapabilities()`) and passes
it to WebUSB encoders (`capabilities.textSize`, applied via `configureEncoderTextSize()` and
`layoutColumnsForTextSize()`), WebUSB main-process raster IPC (`rasterizePrintDocument` and
`rasterizeKotDocument`), and browser HTML renderers (`web-print.ts`, `kot-web-print.ts`,
`delivery-slip-web-print.ts`, and `order-slip-web-print.ts`). `shared/print/text-size.ts` owns the
ESC/POS and column rules:

- `normal` changes nothing; on the backend `resolvePrinterContext()` path the capability field is
  left unset so output is byte-identical to a printer with no setting.
- `large` wraps each text line in `{DOUBLE_HEIGHT}`. The column count is unchanged.
- `extra_large` also wraps lines in `{DOUBLE_WIDTH}` and halves the layout columns, so renderers
  wrap at half the paper's characters. `buildEscPos()` fits against the physical column count
  (layout columns doubled).
- `{FONT_B}` is dropped at both enlarged sizes, and blank, control, and raw-byte lines pass through.
  `{DOUBLE_WIDTH}` is removed only from a line whose text is wider than the halved layout width and
  still fits the physical width; that line prints at double height and single width. Text wider
  than the physical width keeps double width and is truncated.
- Tax-pack width profiles are selected against the physical column count, then laid out at the
  text-size-adjusted columns; when `extra_large` narrows the column count,
  `selectTemplateRenderProfile()` reflows the profile's `lineItems` and `taxSummary` column widths
  to fit the halved width. When formatted financial values (`quantity`, `rate`, `taxRate`, `amount`,
  addon prices, tax breakdown `@rate%` tokens, or summary amounts) across standard, compliance-pack,
  or raster receipt rows still cannot fit on a single row after borrowing spare column width, the
  renderer stacks the label and right-aligned financial continuation lines within the line budget
  instead of truncating or ellipsizing digits, and fails before sending bytes with an explicit
  overflow error if an unbreakable financial value is wider than the full line width.

The enlargement is idempotent. The raster path applies it to the lines and to each group's
`sourceControlLines` before `renderUnsupportedRasterLines()`, so rasterized rows render with the
same `double-height` and `double-width` styles as native rows. On the browser HTML path,
`web-print.ts`, `kot-web-print.ts`, `delivery-slip-web-print.ts`, and `order-slip-web-print.ts`
render thermal output in solid `#000` (so 203 DPI GDI thermal drivers do not halftone-dither text or
borders) with `@page` sizing (`58mm` or `80mm`), wrap 58 mm receipt item rows onto full-width item
lines above their numeric columns across all text sizes, and scale font sizes and weights
(`600`/`700`) for `normal`, `large`, and `extra_large`. `tests/printer-text-size.test.ts` and
`tests/browser-receipts.test.ts` cover these paths; the ESC/POS column math is also pinned by the
receipt column oracle.

## Cash drawer

The drawer pulse is the ESC/POS sequence `ESC p 0 0x19 0xFA`. It is emitted only when the global
`cash_drawer_pulse_enabled` setting is on and the bill's payments include a method in the
`cash_drawer_pulse_methods` allowlist. An unset or unparseable allowlist falls back to `cash` and
`card`.

## Measurement and truncation

`shared/print/width.ts` measures in grapheme clusters and display cells, not UTF-16 code units. A
combining mark attaches to its base, an Indic conjunct is never split at a virama
(U+094D, U+09CD, U+0A4D, U+0C4D), and a ZWNJ stays with the grapheme it follows. Measuring in code units silently
breaks every non-BMP and every combining-script receipt, which is why every renderer in the
pipeline uses this helper rather than `String.length`.

## Tax reconciliation

Tax components are resolved into the printed receipt by `resolveTaxComponents()`. This is
display-only reconciliation: it lines the recorded tax up against the components for printing.

It happens in the classic renderer and in the frontend browser normalizer. It deliberately does
**not** happen in the KOT normalizer: a kitchen ticket carries no tax breakdown, and adding one
would put monetary data on the kitchen display.

## KOT item eligibility

`isKotItemPending()` in `shared/print/document.ts` returns false for `served` and `ready`. Every
KOT path applies it, so an item that has left the kitchen does not reappear on a reprinted ticket:

- `shared/print/document.ts`, in `buildKotDocument`
- `main/routes/printers.ts`, the backend KOT print route
- `frontend/src/lib/printer/print-document.ts`, the browser KOT normalizer
- `frontend/src/lib/printer/kot-web-print.ts`, the browser KOT HTML path
- `frontend/src/lib/printer/kot-encoder.ts`, the browser KOT encoder

## Menu catalog printing

A product with active variants prints one sale row per active variant, in the catalog's variant
order, named `Parent (Variant)` at the variant's own price, so the menu never advertises the
parent's unsellable price. A product with no active variants keeps its single parent row. A
variant that links to a recipe ingredient is not gated by its own pool, and `includeOutOfStock`
decides whether a sold-out variant row is emitted; the printed item count counts emitted rows on
every destination.

Unless `includeHidden` is set, products in an inactive category or with a missing or inactive
ancestor category are omitted. Both renderers order root categories by sibling `sort_order, name`
and group each root's subcategories immediately beneath it in sibling `sort_order, name` order,
followed by uncategorized items. A root category with no direct visible products of its own emits
its root heading once before its first visible subcategory section, while flat catalogs without
subcategories emit only root headings.

Products and POS expose a filtered menu print dialog with optional descriptions and effective
add-on groups. The dialog can send ESC/POS to a selected receipt printer and roll width, open the
system print dialog for A4 or Letter paper, or save a structured PDF. In Electron, the PDF uses the
`save-html-as-pdf` IPC capability; in a browser it uses the system print dialog's Save as PDF
option. `main/printers/document-menu.ts` builds the thermal menu; `printMenuDocument` uses the
profile-owned raster path for unsupported text. A failed receipt print can fall back to
`frontend/src/lib/printer/menu-web-print.ts` with the selected A4 or Letter page size. Operator
steps are in the [printer setup guide](../printers.md#menu-printing).

## Raster printing

Raster is an additive, profile-owned capability, not a rendering mode a document selects. A
profile that declares `raster.enabled` may render text it cannot represent as bitmaps; a profile
that does not never takes that path. The two declared modes are `mixed`, which rasterizes only the
rows that need it (across core classic/compact, merchant, and `escpos-line-template-v1` compliance
pack receipts, Z-reports, kitchen tickets, delivery slips, payment tickets, menu prints, and printer
test pages on the backend, and via `paintRasterRequest` canvas fallback on browser/WebUSB encoders),
and `whole-receipt`, which rasterizes the entire receipt and must be opted into explicitly by the
caller.

### The diagnostic probe is not reachable from the UI

`buildRasterDiagnosticBands()` in `shared/print/raster.ts` builds a banded diagnostic pattern for
capability-gated printer testing. It is referenced from exactly one place, the
`rasterProbe` request-body flag on a printer route in `main/routes/printers.ts`.

**It has no user-interface caller and no test.** The flag is accepted by the route, and nothing in
the renderer sends it. Treat the band specification in the
[printer testing guide](../guides/testing-printers.md) as the design record for a diagnostic path,
not as a feature a merchant can reach today.

## Contributing: adding a print concept

To add a concept that a receipt or kitchen ticket can reference:

1. Add the concept id to `PRINT_CONCEPT_IDS` in `shared/print/concepts.ts`.
2. Add the matching key under the `print` namespace in
   `frontend/src/lib/i18n/messages/en.json`. `npm run i18n:check` fails on a concept id with no
   English text.
3. Run `npm run generate:print-labels` to regenerate `main/print/print-labels.generated.ts`.
4. Resolve the label through the document slot, not through a literal in a renderer.

**Order matters.** `scripts/generate-print-labels.cjs` builds its own ordered list, `ALL_CONCEPTS`,
from the print-namespace keys plus a list of borrowed keys read out of the messages file, and
asserts that the result is identical to the `PRINT_CONCEPT_IDS` array. The two must stay in the
same order, or the generator's drift check fails. Adding the id to only one of them, or adding it
in a different position, is what the check exists to catch.

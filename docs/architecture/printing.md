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
| `document.ts` | `PrintDocument` v1 and `KotDocument` v1, the block types, and the pure `buildBillDocument` / `buildKotDocument` builders. |
| `direction.ts` | Per-scope direction resolution and LTR-island classification. |
| `policy.ts` | `parsePrintLanguagePolicy`, `parseKotLanguagePolicy`, and the language resolvers. |
| `bilingual.ts` | `BilingualLabel` and width-fit strategies. |
| `width.ts` | Grapheme- and display-cell-aware measurement and truncation. |
| `thermal-capabilities.ts` | Capability shape, code pages, representability, and warning policy. |
| `merchant-template.ts` | Merchant template payload validation and canonical serialization. |
| `raster.ts` | Raster band construction and ESC/POS raster encoding. |
| `z-report.ts`, `layout.ts`, `currency.ts`, `warnings.ts` | Z-report assembly, column layout, currency tokens, and warning shapes. |

## Document models

`PrintDocument` v1 is a renderer-independent receipt: an ordered list of blocks, each carrying its
own resolved direction, plus the ordered languages the labels were resolved in. The block
vocabulary is `business-header`, `document-meta`, `customer`, `item-table`, `tax-breakdown`,
`totals`, `payments`, and `message`.

`KotDocument` v1 is the same shape for a kitchen ticket, with a reduced block vocabulary.

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
| Merchant | `main/printers/document-merchant.ts` | Wraps the classic renderer and applies a merchant template's block selection and order. |
| Compliance line template | `renderEscposLineTemplateV1` in `main/printers/thermal.ts` | A pack-signed `escpos-line-template-v1` payload, as a plugin inside the thermal pipeline. |
| Browser HTML | `frontend/src/lib/printer/web-print.ts` and `kot-web-print.ts` | A `PrintDocument` or `KotDocument`, rendered as HTML. |
| WebUSB | `frontend/src/lib/printer/PrinterService.ts` | Encoder output, sent over the browser's WebUSB API. |
| Tax bill | `frontend/src/lib/printer/tax-bill-encoder.ts` | A raw `Bill` and `Tenant`, not a document. |

The tax bill encoder is the single exception to "renderers consume documents". It targets the
detailed per-component tax receipt, a different receipt shape from `PrintDocument` v1, and reads
the bill directly.

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

## Transports

| Transport | Mechanism |
| --- | --- |
| Network | Raw socket. Data is sent in 4096-byte chunks (`NETWORK_PRINT_CHUNK_SIZE`) with a 10 ms delay between chunks (`NETWORK_PRINT_CHUNK_DELAY_MS`), so a large receipt does not overrun the printer's buffer. |
| CUPS | `lp -d <printer> -o raw <tmpfile>`. |
| Windows | `OpenPrinterW` with `pDataType` set to `RAW`. |
| macOS Mac App Store | IPP over loopback HTTP to CUPS on `127.0.0.1:631`, using the minimal client in `main/printers/ipp-client.ts`, because a sandboxed App Store build cannot shell out to `lp`. |
| WebUSB | The browser WebUSB API through the frontend bridge. |

Dispatch failures are classified by `classifyPrintFailure()` into a stable, privacy-safe set:
`not_configured`, `offline`, `queue_unavailable`, `spooler_error`, `driver_error`,
`permission_denied`, `timeout`, and `unknown`. The classification is what fleet telemetry reports,
so it must not embed device names or user data.

## Printer profiles

`main/printers/profiles.ts` ships four profiles:

| Id | Make and model | Paper | Font A columns |
| --- | --- | --- | --- |
| `xprinter-xp-v320m-v330m` | Xprinter XP-V320M / XP-V330M | 72 mm, `cols-42` | 42 |
| `epson-tm-series` | Epson TM Series ESC/POS | `cols-48` | 48 |
| `generic-escpos-80` | Generic ESC/POS 80 mm | `cols-42` | 42 |
| `generic-escpos-58` | Generic ESC/POS 58 mm | `cols-32` | 32 |

All four declare `raster.enabled: true` with modes `mixed` and `whole-receipt`, at 576 dots of
width except the 58 mm profile, which declares 384.

`resolvePrinterProfile()` resolves in three steps: an explicit `profile_id` if it names a known
profile, then a substring match against each profile's make, model, and aliases, then the paper
width, which selects `generic-escpos-58` for a width starting `58mm` and `generic-escpos-80`
otherwise. A name that matches nothing does not produce "generic for everything": it produces one
of the two generic profiles, chosen by paper width.

`capabilitiesForPrinter()` then caps the profile's raster width to the configured paper width when
that width is narrower than the profile's hardware, so a 42-column configuration on 80 mm hardware
does not raster at full width.

### Capabilities and refusal

`GENERIC_THERMAL_CAPABILITIES` is the conservative baseline: ASCII only, no shaping, representable
scripts limited to `ascii`, transliteration enabled, unsupported text on a non-financial row is
skipped, and unsupported text on a financial row refuses the print.

When a financial row contains text the printer cannot represent, FloCafe refuses the whole receipt
rather than printing a total that is not the real total. The refusal message is:

```text
Receipt not printed: a financial row contains unsupported printer text: <text>
```

Use a supported printer profile or system/browser printing.

`arabicShaping` on a profile is a deprecated compatibility input. Read `capabilities.shaping.arabic`
instead; `getPrinterCapabilities()` merges the override into the capability set.

## Cash drawer

The drawer pulse is the ESC/POS sequence `ESC p 0 0x19 0xFA`. It is emitted only when the global
`cash_drawer_pulse_enabled` setting is on and the bill's payments include a method in the
`cash_drawer_pulse_methods` allowlist. An unset or unparseable allowlist falls back to `cash` and
`card`.

## Measurement and truncation

`shared/print/width.ts` measures in grapheme clusters and display cells, not UTF-16 code units. A
combining mark attaches to its base, an Indic conjunct is never split at a virama
(U+094D, U+09CD), and a ZWNJ stays with the grapheme it follows. Measuring in code units silently
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

## Raster printing

Raster is an additive, profile-owned capability, not a rendering mode a document selects. A
profile that declares `raster.enabled` may render text it cannot represent as bitmaps; a profile
that does not never takes that path. The two declared modes are `mixed`, which rasterizes only the
rows that need it, and `whole-receipt`, which rasterizes the entire receipt and must be opted into
explicitly by the caller.

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

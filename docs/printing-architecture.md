# Printing architecture

Status: CURRENT (describes the multilingual print pipeline as shipped by [epic #438](https://github.com/FreeOpenSourcePOS/FloCafe/issues/438), issues [#439](https://github.com/FreeOpenSourcePOS/FloCafe/issues/439)–[#448](https://github.com/FreeOpenSourcePOS/FloCafe/issues/448))

This document is the map of FloCafe's printing stack for contributors: how a
bill becomes printed bytes, which layer owns what, and what each layer may
never do. It covers decisions and contracts — not tutorials that duplicate
code comments. Every architectural claim links to the code or test that
enforces it.

Companion documents:

- [printers.md](printers.md) — merchant-facing printer setup and troubleshooting.
- [merchant-print-templates.md](merchant-print-templates.md) — the merchant template payload/envelope contracts (cross-linked, not duplicated here).
- [i18n.md](i18n.md) — translation workflow and language registry.
- [tax-packs.md](tax-packs.md) — signed tax/country-pack lifecycle.
- [printing-nonlatin-capabilities.md](printing-nonlatin-capabilities.md) — capability study for non-Latin scripts and hardware-gated raster coverage.

---

## 1. Pipeline overview

```text
 raw bill / order / business rows  (main/ DB rows or frontend Bill objects)
        │
        │  normalization — the only document-driven step allowed to touch raw fields
        ▼
 PrintData snapshot + PrintContext          (shared/print/document.ts)
 (printed truth, no recomputation)          (columns, languages, direction,
        │                                    locale, currency, currency symbol,
        │                                    label resolver)
        ├── buildBillDocument() → PrintDocument v1
        │          │
        │          └── receipt-only optional transform:
        │              applyMerchantTemplate(document, payload)
        └── buildKotDocument() → KotDocument v1
        │
        ▼
        Renderer  — migrated paths walk BLOCKS;    main/printers/document-*.ts,
        │          see raw-path exceptions below   frontend receipt-encoder / web-print
        ▼
 Transport — bytes/HTML leave the app       network socket :9100, Windows
                                            spooler / CUPS queue, WebUSB,
                                            system print dialog
```

The pipeline boundaries are enforced by [`shared/print/document.ts`](../shared/print/document.ts),
[`shared/print/merchant-template.ts`](../shared/print/merchant-template.ts),
the migrated renderers under [`main/printers/`](../main/printers/) and
[`frontend/src/lib/printer/`](../frontend/src/lib/printer/), and the transport
dispatch in [`main/printers/thermal.ts`](../main/printers/thermal.ts).

Layer ownership:

| Layer | Lives in | May do | May never do |
| --- | --- | --- | --- |
| Normalization | [`main/printers/document-classic.ts`](../main/printers/document-classic.ts) (`buildBillPrintData`), [`main/printers/document-kot.ts`](../main/printers/document-kot.ts) (`buildKotPrintData`), [`frontend/src/lib/printer/print-document.ts`](../frontend/src/lib/printer/print-document.ts) | read raw rows once, coerce to typed snapshots, reconcile display-only tax components to the persisted tax total | recompute financial totals or persisted tax liability beyond legacy addon-line extension |
| Kernel ([`shared/print/`](../shared/print/)) | [`shared/print/`](../shared/print/) | types + pure functions over injected facts | any IO (Electron, DOM, Node built-ins, DB, filesystem, network); import from [`frontend/`](../frontend/) or [`main/`](../main/); hardcode language unions |
| Renderers | [`main/printers/`](../main/printers/), [`frontend/src/lib/printer/`](../frontend/src/lib/printer/) | choose physical layout from blocks + context | on migrated paths, read bill/order rows directly; invent catalog-backed labels outside the catalog; the documented literal and raw-path exceptions below are not a model boundary |
| Transports | [`main/printers/thermal.ts`](../main/printers/thermal.ts), browser APIs | move bytes/paper | change document semantics |

The document-block renderer rule has explicit active raw-path exceptions:

- Signed [#445](https://github.com/FreeOpenSourcePOS/FloCafe/issues/445) compliance packs use [`main/printers/thermal.ts`](../main/printers/thermal.ts) to render raw
  `Order`/`Bill`/business rows with the signed [`escpos-line-template-v1`](printers.md#country-pack-compliance-receipt-templates-escpos-line-template-v1)
  payload. This remains a separate compliance format, but all of its
  amount-bearing lines use the shared ESC/POS financial-warning guard before
  dispatch; see [the compliance template contract in printers.md](printers.md#country-pack-compliance-receipt-templates-escpos-line-template-v1).
- [`frontend/src/lib/printer/kot-web-print.ts`](../frontend/src/lib/printer/kot-web-print.ts) renders browser KOT HTML from a
  raw `Order`; it uses the shared catalog and direction helpers but is not a
  `KotDocument` v1 consumer.
- [`frontend/src/hooks/usePrinter.ts`](../frontend/src/hooks/usePrinter.ts) calls [`frontend/src/lib/printer/kot-encoder.ts`](../frontend/src/lib/printer/kot-encoder.ts) with raw
  `Order` data for native thermal KOT printing, and uses the typed `KotDocument`
  raster bridge when a validated raster profile is enabled. It also calls the
  [`frontend/src/lib/printer/tax-bill-encoder.ts`](../frontend/src/lib/printer/tax-bill-encoder.ts) raw `Bill`/`Tenant` diagnostic path for the
  print-test page. The native KOT layout remains legacy-frozen while its
  catalog labels follow the resolved language.

These paths retain their own raw-field and warning behavior outside the shared
document boundary. New document features must use the migrated paths below;
the exceptions must not be treated as evidence that their raw inputs are
`PrintDocument` v1 data.

Tax-component reconciliation is a separate display exception inside the
normalizers: both bill-data builders call `resolveTaxComponents` — the backend
[`main/printers/document-classic.ts`](../main/printers/document-classic.ts) and
frontend [`frontend/src/lib/printer/print-document.ts`](../frontend/src/lib/printer/print-document.ts)
paths. The KOT normalizer [`main/printers/document-kot.ts`](../main/printers/document-kot.ts)
does not perform tax reconciliation. The backend `reconcileTotal` and
equivalent frontend reconciliation logic may rescale or add display breakdown
lines so they reconcile to the persisted bill tax amount. It does not rewrite
persisted subtotal, tax, charge, or total fields
([`main/services/tax-components.ts`](../main/services/tax-components.ts),
[`frontend/src/lib/printer/tax-components.ts`](../frontend/src/lib/printer/tax-components.ts)).

The purity boundary of the kernel is binding: see
[shared/print/README.md](../shared/print/README.md). Public consumer behavior
is covered by the kernel test suite (`npm run test:print-kernel`, including the
consumer-boundary check in [`tests/kernel-purity.test.ts`](../tests/kernel-purity.test.ts));
the static forbidden-import audit is in [`tests/print-document.test.ts`](../tests/print-document.test.ts)
and runs via `npm run test:print-document`, alongside ESLint import
restrictions over [`shared/`](../shared/).

## 2. Shared print kernel layout

| Module | Contents | Introduced |
| --- | --- | --- |
| [`types.ts`](../shared/print/types.ts) | `PrintLanguageCode` (structural string), policy shapes, `DirectionScope`, registry-facts interface | [#441](https://github.com/FreeOpenSourcePOS/FloCafe/issues/441) |
| [`policy.ts`](../shared/print/policy.ts) | resolution + validation of receipt/KOT language policies; max-2 receipts enforced at type level | [#441](https://github.com/FreeOpenSourcePOS/FloCafe/issues/441) |
| [`direction.ts`](../shared/print/direction.ts) | per-scope direction spec, conservative LTR-island classification | [#441](https://github.com/FreeOpenSourcePOS/FloCafe/issues/441) |
| [`bilingual.ts`](../shared/print/bilingual.ts) | `BilingualLabel`, width-fit strategies (`inline` vs `stacked`) | [#441](https://github.com/FreeOpenSourcePOS/FloCafe/issues/441) |
| [`concepts.ts`](../shared/print/concepts.ts) | Typed `PrintConceptId` catalog boundary shared by semantic documents and generated locale views | Phase 10 |
| [`currency.ts`](../shared/print/currency.ts) | Shared ASCII currency fallback tokens and three-letter code validation | Phase 10 |
| [`document.ts`](../shared/print/document.ts) | `PrintDocument` v1 / `KotDocument` v1 models + pure builders, including typed currency context | [#442](https://github.com/FreeOpenSourcePOS/FloCafe/issues/442)/[#443](https://github.com/FreeOpenSourcePOS/FloCafe/issues/443) |
| [`merchant-template.ts`](../shared/print/merchant-template.ts) | semantic merchant template payload validation, offline transfer envelope, `applyMerchantTemplate` | [#447](https://github.com/FreeOpenSourcePOS/FloCafe/issues/447)/[#448](https://github.com/FreeOpenSourcePOS/FloCafe/issues/448) |
| [`thermal-capabilities.ts`](../shared/print/thermal-capabilities.ts) | capability-driven thermal normalization, representability, code-page selection, shaping, and warning policy | Phase 8 |

Dependency direction is one-way: registry → call site → kernel. The central
language registry ([frontend/src/lib/i18n/languages.ts](../frontend/src/lib/i18n/languages.ts))
is authoritative; the generator derives backend print-language data from its
entry order, and both consumers inject their own view of "registered and
selectable" via `LanguageRegistryFacts`:

- frontend validates stored policies against `selectable` in
  [`frontend/src/lib/print-language-policies.ts`](../frontend/src/lib/print-language-policies.ts),
  while the settings page builds the selectable print-language controls from
  the same registry ([`frontend/src/app/(dashboard)/settings/page.tsx`](<../frontend/src/app/(dashboard)/settings/page.tsx>));
- backend uses the generated print-label language table
  ([`main/print/print-labels.generated.ts`](../main/print/print-labels.generated.ts), wired in [`main/lib/print-language-settings.ts`](../main/lib/print-language-settings.ts)).

The kernel never imports either side.

## 3. PrintDocument v1 model

A `PrintDocument` ([#442](https://github.com/FreeOpenSourcePOS/FloCafe/issues/442)) is the authoritative *semantic* representation of a
receipt: an ordered list of frozen blocks plus per-scope direction and the
resolved language list. No transport tokens (`{CENTER}`, `{CUT}`, …) and no
HTML exist anywhere in the model.

Receipt block vocabulary v1 ([`shared/print/document.ts`](../shared/print/document.ts)):

| Block kind | Carries |
| --- | --- |
| `business-header` | name, address, phone (+label), instagram, conditional tax-ID line |
| `document-meta` | invoice title (tax vs plain), number, canonical timestamp, optional table |
| `customer` | customer name/phone with their labels |
| `item-table` | header labels, item rows (quantity, unit price, amount, add-ons with quantity and extended amount, special instructions) |
| `totals` | subtotal, discount, flat tax, optional server-persisted service charge, delivery/packaging charges, grand total, loyalty points lines |
| `tax-breakdown` | per-component lines when the merchant shows the breakdown |
| `payments` | captured payment lines (known methods resolve through concept ids, unknown stay literal) |
| `message` | reprint banner, footer note, thank-you |

Kitchen tickets use a separate smaller vocabulary, `KotDocument` v1
(`kot-header`, `kot-items`; [#443](https://github.com/FreeOpenSourcePOS/FloCafe/issues/443)). The KOT policy is single-primary in v1.
KOT normalizers, the browser HTML renderer, and the legacy WebUSB encoder omit
items whose status is `served` or `ready`, so completed kitchen work does not
reach the ticket.

Invariants every consumer may rely on:

- **Financial totals are not recomputed.** Builders copy persisted financial
  amounts verbatim from the `PrintData` snapshots; normalizers materialize
  add-on display amounts as `price × add-on quantity × item quantity`, while
  builders apply presence/show decisions and the display-only tax-component
  reconciliation documented above (`buildBillDocument` doc comment, asserted in
  [`tests/print-document.test.ts`](../tests/print-document.test.ts) and
  byte-compared against the frozen pre-migration oracle in
  [`tests/print-parity.test.ts`](../tests/print-parity.test.ts)).
- **Labels are never pre-concatenated** `"A / B"` strings. Catalog-backed
  label slots are `SemanticLabel` values with a concept reference plus
  already-resolved primary text and an optional secondary-language rendering
  of the same concept. Literal data labels — such as tax-ID text, tax
  component titles, and unknown payment methods — intentionally omit
  `conceptId`; renderers still decide how language variants share a line.
- **Currency is typed context, not a raster side channel.** `PrintContext.currency` carries the tenant's uppercase three-letter code and `currencySymbol` carries its display token. Tenant settings accept syntactically valid three-letter codes and persist them uppercase; codes absent from the country registry remain supported with `Intl`'s two-decimal fallback and print as the code when no symbol is available. ASCII thermal fallback tokens are defined once in [`shared/print/currency.ts`](../shared/print/currency.ts), so fallback changes never alter financial values or the native output of representable text.
- **Print concepts cross a shared typed boundary.** `PrintConceptId` and the catalog list live in [`shared/print/concepts.ts`](../shared/print/concepts.ts); the generated backend locale view imports that type rather than defining a second union.
- **Text fields represented as `DirectionalText` carry their resolved
  direction**; the browser HTML renderer uses it to isolate LTR islands.
  ESC/POS renderers do not currently consume those annotations. Quantities,
  amounts, rates, points, and payment amounts remain numeric model fields and
  do not carry direction metadata.
- The unmodified output of `buildBillDocument` appears in canonical block
  order; `getBlock()` gives typed access. Applying
  `applyMerchantTemplate` is an explicit semantic transform: a validated
  merchant payload may reorder or omit blocks before rendering
  ([`shared/print/merchant-template.ts`](../shared/print/merchant-template.ts)).

### Extension policy (adding a block)

The block-extension contract spans the `PrintDocumentBlock` union, the
builder, the merchant-template block and label-field/override registries, and
every renderer that consumes the document. See [Part II](#part-ii--contributor-recipes)
for the step-by-step recipe.

### Direction & bidi handling

[`shared/print/direction.ts`](../shared/print/direction.ts) defines three scopes: `document`, `block`, and
`value`. Document and block follow the base direction derived from the
primary print language (registry fact injected by the caller);
`resolveValueDirection(text, base)` classifies individual embedded values.

LTR-island classification (`isLtrIsland`) is deliberately conservative:
phone numbers, URLs/emails, identifiers (SKU/invoice/order/tax-ID-like tokens
carrying at least one digit and at most three whitespace-separated words),
and amounts resolve `'ltr'` even inside RTL documents; anything containing
RTL script letters stays in the base direction. Plain natural-language text
generally stays in the base direction, but the identifier heuristic can classify
short ASCII-ish, digit-bearing phrases with at most three whitespace-separated
words (for example, `SKU 0042` or `123 Main Street`) as LTR islands. Behavior
is covered by the direction tests in [`tests/print-kernel.test.ts`](../tests/print-kernel.test.ts).

The browser HTML path consumes `DirectionalText.direction` to mark elements
and isolate LTR islands (`directionalValue` in
[`frontend/src/lib/printer/web-print.ts`](../frontend/src/lib/printer/web-print.ts),
since [#444](https://github.com/FreeOpenSourcePOS/FloCafe/issues/444)). ESC/POS document renderers currently consume the text values and
use width-aware shaping/truncation helpers, but do not consume the kernel's
direction annotations or provide bidi/LTR-island handling
([`main/printers/thermal.ts`](../main/printers/thermal.ts)).

Bilingual presentation is implemented at the model/helper layer, not yet in
production renderer output. `selectBilingualFit(label, columns)` picks `inline`
(primary + 2 separator columns + secondary fits the paper width) or `stacked`
(one line each), and `bilingualLabelLines` returns the ordered lines
([`shared/print/bilingual.ts`](../shared/print/bilingual.ts); width behavior is tested in
[`tests/print-kernel.test.ts`](../tests/print-kernel.test.ts)). The `PrintDocument` model carries the optional
secondary label, but current production receipt renderers emit
`label.primary`; the browser HTML path also builds a single-language document
([`frontend/src/lib/printer/web-print.ts`](../frontend/src/lib/printer/web-print.ts)). Neither helper has a production
caller, so bilingual receipt output remains future renderer work rather than a
shipped capability.

## 4. Language behavior

Three decoupled domains (see also [i18n.md](i18n.md)):

- **UI language** drives the interface and is the `inherit` fallback for printing.
- **Receipt language policy** (`bill_language_policy`): `{ primary: inherit | fixed, additional?: [one] }`.
  Max 2 languages per receipt in v1, enforced at type level
  (`ReceiptLanguagePolicy` tuple) and by the
  `parsePrintLanguagePolicy`/`parsePolicyBody` validation rule in
  [`shared/print/policy.ts`](../shared/print/policy.ts).
- **Kitchen ticket policy** (`kot_language_policy`): single-primary, resolved
  independently of the receipt. The backend document path and browser HTML KOT
  path honor a fixed language — for example, an English kitchen keeps English
  tickets in a Persian storefront (asserted in the backend policy section of
  [`tests/print-parity.test.ts`](../tests/print-parity.test.ts) and the browser cold-start regression
  [`tests/kot-locale-cold-start.test.ts`](../tests/kot-locale-cold-start.test.ts)). The frontend WebUSB
  [`frontend/src/lib/printer/kot-encoder.ts`](../frontend/src/lib/printer/kot-encoder.ts) is a legacy exception for native output: its raw `buildKotBytes` path
  accepts the resolved KOT language for catalog labels while retaining its
  historical raw-data layout. Raster-enabled WebUSB KOT output uses the typed
  `KotDocument` bridge described in the renderer map below.

Thermal and browser receipt paths resolve the receipt policy before building the
document. Browser HTML remains a single-language surface, using the primary
language from the resolved list; a fixed receipt primary therefore changes
browser receipt labels as well as thermal labels. An additional receipt
language may still be loaded and carried by the document for the future
bilingual renderer work above.

Authenticated POS bootstrap applies the tenant's stored receipt and KOT
policies and warms every resolved print locale before releasing the dashboard.
For a selected tenant, this happens during single-tenant login, session
restore, and tenant selection, so the selected print language is available
before the first print without visiting Settings.
If a packaged locale bundle fails to load, bootstrap records the failed
language and surfaces an actionable operator error. A later print retry may
fall back to English only with an explicit print warning; the print-test HTML
download is withheld when its required locale cannot be loaded.

Policy payloads are untrusted input: `parsePrintLanguagePolicy` /
`parseKotLanguagePolicy` reject unknown top-level keys and validate the relevant
nested `primary`/`additional` values, but extra fields inside a primary
selection object are ignored. They require registered + selectable codes via
the injected registry facts, dedupe, reject duplicate primaries, and return
normalized policies with a frozen outer object and type-level readonly fields;
the parser's intermediate `additional` list is frozen, but returned
`additional` arrays and nested primary selections are not runtime-frozen.
Invalid or missing settings fall back to the store language; printing never
fails because of a malformed policy ([`main/lib/print-language-settings.ts`](../main/lib/print-language-settings.ts),
[`tests/print-language-settings.test.ts`](../tests/print-language-settings.test.ts)).

Settings are registry-driven: the frontend renders print-language options from
[`LANGUAGES`](../frontend/src/lib/i18n/languages.ts),
with controls filtered in [`settings/page.tsx`](<../frontend/src/app/(dashboard)/settings/page.tsx>)
and stored-policy checks in [`print-language-policies.ts`](../frontend/src/lib/print-language-policies.ts);
backend policy validation accepts only languages present in
[`PRINT_LABEL_LANGUAGES`](../main/print/print-labels.generated.ts), wired through
[`main/lib/print-language-settings.ts`](../main/lib/print-language-settings.ts)
and checked by [`shared/print/policy.ts`](../shared/print/policy.ts). The
generated backend view follows the frontend registry order; update the frontend
registry and locale messages, then regenerate the derived file.

### Canonical i18n label flow (kernel C, [#440](https://github.com/FreeOpenSourcePOS/FloCafe/issues/440))

Canonical locale messages are the single translation source:

```text
frontend/src/lib/i18n/messages/<lang>.json      (canonical, 100% parity with en.json)
        │  npm run generate:print-labels   (scripts/generate-print-labels.cjs reads LANGUAGES)
        ▼
main/print/print-labels.generated.ts            (committed derived view)
        │  printLabel(lang, conceptId)  — unknown language falls back to English;
        │                                  conceptId is the shared `PrintConceptId` union
        ▼
backend renderers + backend registry facts for policy validation
```

The canonical flow is enforced by [`frontend/src/lib/i18n/messages/`](../frontend/src/lib/i18n/messages/),
[`scripts/generate-print-labels.cjs`](../scripts/generate-print-labels.cjs),
[`main/print/print-labels.generated.ts`](../main/print/print-labels.generated.ts),
and [`main/lib/print-language-settings.ts`](../main/lib/print-language-settings.ts).

Browser receipt label implementation (legacy surface):
[`generateBillHtml` in `web-print.ts`](../frontend/src/lib/printer/web-print.ts) builds the document for business values, but its visible
receipt labels still come directly from that file's `t()` catalog lookups
for `receipt.*` and `pos.*` keys. For example, the browser uses
`receipt.billNumber` and `receipt.grandTotal` instead of the corresponding
document concepts used by the migrated renderers. The caller supplies the
policy-resolved primary language, so fixed receipt language settings apply to
these labels. This path remains on the canonical locale catalog but is not yet
aligned to the document label slots; future work should converge the browser
label surface without changing the merchant/compliance format boundaries.

Rules:

- Never edit [`main/print/print-labels.generated.ts`](../main/print/print-labels.generated.ts) by hand; edit messages, regenerate,
  commit. Drift between messages and the generated view fails
  `npm run i18n:check` and `npm run test:print-labels` (byte comparison after
  CRLF normalization).
- The generator extracts the audited `print.*` namespace plus a manifest of
  BORROWED keys (`receipt.*`, `pos.*`, …) listed explicitly in
  [`scripts/generate-print-labels.cjs`](../scripts/generate-print-labels.cjs). Concept ids keep full dotted keys so
  call sites stay unambiguous about where a label resolves.
- Deliberate non-translations (exemptions): branding constants
  ("Powered by FloPOS", URL — [`main/printers/thermal.ts`](../main/printers/thermal.ts),
  [`frontend/src/lib/printer/branding.ts`](../frontend/src/lib/printer/branding.ts)) and technical literals on the test
  page (protocol names, encodings/codepages, byte/hex output, addresses/ports,
  model and capability identifiers). These are intentionally absent from the
  concept catalog.
- KOT order references and known order-type values resolve through the shared
  catalog at the document boundary.
- Renderer-only layout lookups remain explicit exceptions: the migrated WebUSB
  [`frontend/src/lib/printer/receipt-encoder.ts`](../frontend/src/lib/printer/receipt-encoder.ts) resolves `receipt.rate` and `printTest.amt` through
  `printLabelResolver` for its 4-column layout. These labels live outside
  `PrintDocument`; literal tax-ID/tax-component labels are data labels created
  by `buildBillDocument`. These do not establish new catalog concepts.

## 5. Template systems, provenance & security

Four provenance classes exist and must stay distinct:

| Class | Storage | Trust | Format | Docs |
| --- | --- | --- | --- | --- |
| Core layouts | code | built-in | code + PrintDocument | [printers.md](printers.md) |
| Compliance pack templates ([#445](https://github.com/FreeOpenSourcePOS/FloCafe/issues/445)) | `installed_print_templates` | Ed25519-verified signed country-pack artifacts | `escpos-line-template-v1` | [printers.md § compliance templates](printers.md#country-pack-compliance-receipt-templates-escpos-line-template-v1), [tax-packs.md](tax-packs.md) |
| Merchant-created templates ([#447](https://github.com/FreeOpenSourcePOS/FloCafe/issues/447)) | `merchant_print_templates` | ordinary tenant data, no compliance trust | `flocafe-merchant-print-template` | [merchant-print-templates.md](merchant-print-templates.md) |
| Imported templates ([#448](https://github.com/FreeOpenSourcePOS/FloCafe/issues/448)) | `merchant_print_templates` (`origin: imported`) | same as merchant-created | transfer envelope around the same payload | [merchant-print-templates.md](merchant-print-templates.md) |

These formats are deliberately **not converged**: [#445](https://github.com/FreeOpenSourcePOS/FloCafe/issues/445)'s line templates are
the compliance contract; the merchant format is semantic-only. A
`derivedFrom` reference to a pack template is user information only — no
compliance trust ever transfers ([`shared/print/merchant-template.ts`](../shared/print/merchant-template.ts) header,
[merchant-print-templates.md § Provenance & trust](merchant-print-templates.md#provenance--trust)).

### Merchant template validation pipeline (fail-closed rules)

The shared payload rule set is enforced on every write/import path in the
kernel. Raw JSON payload writes use `validateMerchantTemplateText` for the
size, parse, and payload checks; offline imports use
`validateMerchantTemplateEnvelope` for the envelope and then
`validateMerchantTemplate` for its embedded payload. The golden and negative
fixtures under [`tests/fixtures/merchant-templates/`](../tests/fixtures/merchant-templates/) exercise these paths in
  [`tests/merchant-print-templates.test.ts`](../tests/merchant-print-templates.test.ts) and
  [`tests/merchant-template-import-export.test.ts`](../tests/merchant-template-import-export.test.ts):

1. Raw-size gate: 256 KB cap before parsing.
2. Single JSON object; unknown root/block/origin fields rejected (stricter
   than render-time tolerance, so typos cannot change meaning).
3. Fail-closed schema-major gate: only major version 1 is accepted, in both
   payload and envelope positions.
4. Block whitelist: kinds must come from `MERCHANT_TEMPLATE_BLOCK_KINDS`;
   duplicates rejected; `visible` must be boolean; `labels` keys must be in
   the per-block `MERCHANT_TEMPLATE_LABEL_FIELDS` whitelist and be literal
   strings free of control characters and printer tokens
   (`UNSAFE_LABEL_TEXT_PATTERN`).
5. Canonical serialization (`serializeMerchantTemplatePayload`: recursively
   sorted keys, array order untouched) defines the exact text persisted and
   hashed — sha256 checksums are verified on activation, rollback, export,
   and import.

Why imported templates cannot execute code: the payload grammar has no field
for commands, HTML, scripts, or renderer snippets — only block selection,
visibility, order, and literal label text applied to a previously validated
document (`applyMerchantTemplate` is a pure projection). Label literals with
ESC/POS control tokens or ASCII control characters are rejected during payload
validation (`UNSAFE_LABEL_TEXT_PATTERN`), not stripped at render time. The
render path re-validates fail-closed: a stored payload that no longer validates
falls back to the classic layout with an explicit warning — never garbage,
never silence ([`main/printers/document-merchant.ts`](../main/printers/document-merchant.ts),
`fellBackToClassic`).

### Offline transfer envelope

Templates travel as self-describing `.json` files
(`flocafe-merchant-template`, envelope schema version 1): structural
validation, ISO-8601 `exportedAt`, sha256-shaped `checksum`, then the same
payload validator, then checksum verification against the canonical payload
text. Imports always land as a NEW draft row (`origin: 'imported'`) — never
an activation, never an overwrite. The full public contract, including the
field list and provenance semantics, lives in
[merchant-print-templates.md § Offline transfer format](merchant-print-templates.md#offline-transfer-format-public-contract-448);
the normative validator is `validateMerchantTemplateEnvelope` in
[`shared/print/merchant-template.ts`](../shared/print/merchant-template.ts) with fixtures under
[`tests/fixtures/merchant-templates/transfer/`](../tests/fixtures/merchant-templates/transfer/).

## 6. Printer capability model & warning semantics

Capabilities are declared per profile in
[`main/printers/profiles.ts`](../main/printers/profiles.ts) and use the shared
pure policy in [`shared/print/thermal-capabilities.ts`](../shared/print/thermal-capabilities.ts).
In addition to paper geometry and command set, every profile owns the thermal
text boundary: ordered supported `encoding.codePages` plus a preferred page,
`shaping.arabic`, representable scripts, transliteration enablement, and the
unsupported/financial/order-type warning policies. The additive `raster` block
also owns whether mixed or whole-receipt raster is enabled, the profile-derived
width and band limits, and the bundled font data used by the isolated renderer.
Selection is deliberate:
`selectThermalCodePage` chooses the first declared page that represents the
normalized line, while the backend and WebUSB guards use the same policy.
Profile resolution remains explicit `profile_id` → name/make/model alias →
paper-width generic fallback (`resolvePrinterProfile`). The legacy
`arabicShaping` field is retained only as a compatibility input; new code reads
`capabilities.shaping.arabic`.

The durable boundary is printer capability, not UI or receipt locale. Thermal
normalization, representability, code-page selection, and the deferred
non-shaping order-type ASCII fallback are therefore shared pure decisions;
renderers only provide layout and transports only move bytes. Generic profiles
remain ASCII-only, transliterate the established German characters, skip
unsupported non-financial lines with warnings, and refuse unsupported
financial rows. This preserves safe generic-printer behavior while allowing a
profile with proven Latin code-page coverage or Arabic shaping to opt in.

Renderers consume capabilities, they never guess them:

- Desktop ESC/POS: unsupported non-financial lines are skipped with an explicit warning unless the selected profile capability represents the line or its shaping flag (or a request-level override) admits strict ASCII+Arabic lines (`buildEscPos` guard in [`main/printers/thermal.ts`](../main/printers/thermal.ts)). KOT header metadata uses an explicit ASCII-safe `[UNSUPPORTED]` placeholder when a generic printer cannot represent its localized text, while unsupported KOT item/instruction text remains subject to the warning path. On document-driven and signed country-pack receipt paths, unsupported item or financial rows are also warned, but the backend refuses the receipt before transport so no partial financial receipt is emitted.
- The migrated WebUSB receipt path uses `safePrinterText` for renderer-managed
  text and its warning behavior ([`frontend/src/lib/printer/receipt-encoder.ts`](../frontend/src/lib/printer/receipt-encoder.ts),
  [`frontend/src/lib/printer/warnings.ts`](../frontend/src/lib/printer/warnings.ts)). Unsupported item or financial rows are refused before `PrinterService` sends bytes; other unsupported lines retain the explicit skip warning. `buildClassicReceiptBytes` still
  writes the masked customer phone directly with `enc.text`, so that field is a
  documented warning-contract exception. The native raw WebUSB [`frontend/src/lib/printer/kot-encoder.ts`](../frontend/src/lib/printer/kot-encoder.ts) and legacy
  [`frontend/src/lib/printer/tax-bill-encoder.ts`](../frontend/src/lib/printer/tax-bill-encoder.ts) paths are broader exceptions with their own direct-write
  and warning behavior; both paths accept the resolved print language for
  their catalog labels. Raster-enabled WebUSB KOT output uses the typed
  document path and its shared raster warning/refusal contract.
- Browser HTML printing is the full-Unicode path: nothing is skipped for
  script reasons (asserted in [`tests/print-parity.test.ts`](../tests/print-parity.test.ts)).

Warning semantics on the migrated document-driven and signed country-pack
receipt paths are **no silent loss of unsupported content**: every skipped line
produces a `PrintWarning` naming the field, the skipped text, and the reason.
Warnings marked `financial` cause the thermal receipt path to refuse before
transport, with an explicit operator message; unsupported non-financial lines
may still be skipped with their warning. Unsupported configuration (for example a merchant template selected
on a print path that cannot honor it) produces a path-specific warning and a
documented fallback layout. The frontend
[`makeBillTemplateFallbackWarning`](../frontend/src/lib/printer/warnings.ts)
marks that warning `kind: 'configuration'`; desktop and frontend financial
warnings use `kind: 'financial'`. A valid merchant template may intentionally
reorder, hide, or omit blocks — including `totals` — through explicit block
selection and `visible` settings; that is merchant configuration, not a silent
renderer omission. The legacy raw WebUSB encoders described above retain their
own warning behavior and do not inherit the `PrintDocument` guarantees. The
tax-bill path still refuses before WebUSB transport when a financial row is
unsupported; its raw date uses the configured country locale and tenant
timezone when representable, with an ASCII-safe fallback otherwise. Receipt,
KOT, compliance, and print-test timestamps use the tenant timezone rather than
the host machine timezone.
Warnings surface to the user through print results and toast notifications
([`frontend/src/lib/printer/warnings-toast.ts`](../frontend/src/lib/printer/warnings-toast.ts)); financial refusal warnings are shown before transport. Dispatch results use
`classifyPrintFailure` in [`main/printers/thermal.ts`](../main/printers/thermal.ts) for stable, privacy-safe failure
classes for fleet telemetry. The end-state contract from [epic #438](https://github.com/FreeOpenSourcePOS/FloCafe/issues/438) for the
shared paths is native render, explicitly supported fallback, or an explicit
warning/error for unsupported content or configuration. Raster is now an
additive, profile-owned capability, but remains disabled for all shipped
profiles until the diagnostic probe and real-printer evidence are complete.
When enabled, the dedicated hidden Chromium surface accepts only typed
requests with bundled local font data URLs; the shared `GS v 0` encoder emits
bounded bands and preserves the semantic unit boundary. Mixed mode is the
primary path, while whole-receipt raster is an internal compatibility path that
requires a profile to opt into that mode and is not a default. Unsupported
financial units still refuse before any transport write. See [`shared/print/raster.ts`](../shared/print/raster.ts) and
[printing-nonlatin-capabilities.md](printing-nonlatin-capabilities.md).
Native code pages remain limited to declared text representability; no shipped
profile claims broad non-Latin support without hardware evidence.

## 7. Renderer/transport map

| Renderer | Surface | Consumes | Output | Transport |
| --- | --- | --- | --- | --- |
| [`main/printers/document-classic.ts`](../main/printers/document-classic.ts) (`renderClassicReceiptViaDocument`, [#442](https://github.com/FreeOpenSourcePOS/FloCafe/issues/442)) | desktop preview + printing, receipts | PrintDocument v1 | token lines → bytes | socket :9100 / OS queue |
| [`main/printers/document-compact.ts`](../main/printers/document-compact.ts) ([#443](https://github.com/FreeOpenSourcePOS/FloCafe/issues/443)) | desktop compact receipts | PrintDocument v1 | token lines → bytes | same |
| [`main/printers/document-kot.ts`](../main/printers/document-kot.ts) ([#443](https://github.com/FreeOpenSourcePOS/FloCafe/issues/443)) | desktop kitchen tickets | KotDocument v1 | token lines → bytes | same |
| [`main/printers/raster-renderer.ts`](../main/printers/raster-renderer.ts) + [`main/raster-preload.ts`](../main/raster-preload.ts) | hidden Chromium raster surface for validated core receipt/KOT paths | typed raster request with bundled local font data | semantic units → bounded `GS v 0` bands | mixed-mode assembly in [`main/printers/thermal.ts`](../main/printers/thermal.ts) |
| [`main/printers/document-merchant.ts`](../main/printers/document-merchant.ts) ([#447](https://github.com/FreeOpenSourcePOS/FloCafe/issues/447)/[#448](https://github.com/FreeOpenSourcePOS/FloCafe/issues/448)) | desktop receipts with active merchant template | applied PrintDocument | token lines → bytes (fail-closed fallback to classic) | same |
| [`main/printers/thermal.ts`](../main/printers/thermal.ts) compliance plugin ([#445](https://github.com/FreeOpenSourcePOS/FloCafe/issues/445)) | desktop receipt with signed country-pack template | raw `Order`/`Bill`/business rows + signed [`escpos-line-template-v1`](printers.md#country-pack-compliance-receipt-templates-escpos-line-template-v1) payload | ESC/POS bytes | desktop transport |
| [`frontend/src/lib/printer/receipt-encoder.ts`](../frontend/src/lib/printer/receipt-encoder.ts) ([#444](https://github.com/FreeOpenSourcePOS/FloCafe/issues/444)) | WebUSB thermal receipts | PrintDocument v1 via [`frontend/src/lib/printer/print-document.ts`](../frontend/src/lib/printer/print-document.ts) bridge | ESC/POS bytes | WebUSB device |
| [`frontend/src/lib/printer/kot-encoder.ts`](../frontend/src/lib/printer/kot-encoder.ts) + [`frontend/src/lib/printer/print-document.ts`](../frontend/src/lib/printer/print-document.ts) ([#444](https://github.com/FreeOpenSourcePOS/FloCafe/issues/444)) | WebUSB thermal KOT | raw `Order` data for native bytes; `KotDocument` v1 through the typed raster bridge when enabled | ESC/POS bytes | WebUSB device |
| [`frontend/src/lib/printer/tax-bill-encoder.ts`](../frontend/src/lib/printer/tax-bill-encoder.ts) ([#444](https://github.com/FreeOpenSourcePOS/FloCafe/issues/444), legacy diagnostic exception) | WebUSB print-test tax bill | raw `Bill`/`Tenant` data + resolved catalog language; no PrintDocument bridge | ESC/POS bytes | WebUSB device |
| [`frontend/src/lib/printer/web-print.ts`](../frontend/src/lib/printer/web-print.ts) ([#444](https://github.com/FreeOpenSourcePOS/FloCafe/issues/444), browser-label legacy exception) | system print dialog receipts | PrintDocument v1 for values + direct `receipt.*`/`pos.*` catalog labels | HTML | browser print |
| [`frontend/src/lib/printer/kot-web-print.ts`](../frontend/src/lib/printer/kot-web-print.ts) | system print dialog kitchen tickets | raw `Order` data; shared catalog/direction helpers, no KotDocument bridge | HTML | browser print |

Desktop byte-level transports (Windows spooler RAW datatype, CUPS, sockets) are
described in [printers.md](printers.md); desktop renderers never touch them
directly and [`main/printers/thermal.ts`](../main/printers/thermal.ts) owns that dispatch. Frontend WebUSB bytes are sent by
[`frontend/src/lib/printer/PrinterService.ts`](../frontend/src/lib/printer/PrinterService.ts) after the selected frontend encoder returns them.

## 8. Testing guide

| Suite | Command | What it locks down |
| --- | --- | --- |
| Kernel units | `npm run test:print-kernel` | policy resolution/validation, direction, bilingual fit, settings glue ([`tests/print-kernel.test.ts`](../tests/print-kernel.test.ts), [`tests/kernel-purity.test.ts`](../tests/kernel-purity.test.ts), [`tests/print-language-settings.test.ts`](../tests/print-language-settings.test.ts)) |
| Labels | `npm run test:print-labels` | generated-table selection, English fallback, all eight locale Phase 3 cross-path print regressions, generator drift (`--check`) ([`tests/print-labels.test.ts`](../tests/print-labels.test.ts), [`tests/phase3-print-regressions.test.ts`](../tests/phase3-print-regressions.test.ts), [`scripts/generate-print-labels.cjs`](../scripts/generate-print-labels.cjs)) |
| Locale loading | `npm run test:phase6-locale-loading` | bootstrap policy application plus browser and WebUSB receipt loading for every registered locale ([`tests/phase6-locale-loading.test.ts`](../tests/phase6-locale-loading.test.ts)) |
| Document model | `npm run test:print-document` | block construction, document builders, bilingual pairs, direction annotations, purity ([`tests/print-document.test.ts`](../tests/print-document.test.ts)) |
| Parity harness | `npm run test:print-parity` | cross-renderer semantic parity + byte-exact migration oracle ([`tests/print-parity.test.ts`](../tests/print-parity.test.ts)) |
| Thermal capabilities | `npm run test:thermal-capabilities` | profile-owned encoding/shaping/representability/transliteration policy, code-page choice, backend/WebUSB normalized fixtures, unsupported-text and order-type safety ([`tests/thermal-capabilities.test.ts`](../tests/thermal-capabilities.test.ts)) |
| Raster contract | `npm run test:raster` | deterministic GS v 0 packing, bounded profile geometry, typed Chromium IPC, bundled-font failure reporting, semantic grouping, complete-unit refusal, and feed/cut semantics ([`shared/print/raster.ts`](../shared/print/raster.ts), [`main/printers/raster-renderer.ts`](../main/printers/raster-renderer.ts)) |
| Merchant templates | `npm run test:merchant-print-templates` | kernel validation, apply semantics, CRUD lifecycle, render path ([`tests/merchant-print-templates.test.ts`](../tests/merchant-print-templates.test.ts)) |
| Transfer envelope | `npm run test:merchant-template-transfer` | import/export contract, tampered-checksum rejection ([`tests/merchant-template-import-export.test.ts`](../tests/merchant-template-import-export.test.ts)) |

Parity harness usage and fixture matrix ([`tests/print-parity.test.ts`](../tests/print-parity.test.ts)):

- **Semantic assertions** (content present / explicit warning recorded), not
  byte snapshots, for cross-renderer checks; amounts compared after stripping
  grouping separators so `en-IN` and `en-US` styles both pass.
- **Byte-exact oracle**: migrated backend receipt surfaces (classic and
  compact) must reproduce their frozen pre-migration output BYTE FOR BYTE at
  every tested width, including skip rules and reprint banners
  ([`tests/helpers/legacy-thermal-oracle.ts`](../tests/helpers/legacy-thermal-oracle.ts)).
  KOT parity is semantic because the current contract normalizes order
  metadata, add-on quantities, special-instruction markers, and served/ready
  filtering across its renderers.
- **Width coverage expectations**: backend ESC/POS at 32/42/48 columns;
  WebUSB at 58 mm and 80 mm; browser HTML at `thermal58`/`thermal80`;
  bilingual fit strategies evaluated across 32–48 columns
  ([`shared/print/bilingual.ts`](../shared/print/bilingual.ts)). New print features must state their width
  behavior at these widths.
- **Merchant-template mode**: the golden fixture
  ([`tests/fixtures/merchant-templates/golden-receipt-v1.json`](../tests/fixtures/merchant-templates/golden-receipt-v1.json), all blocks,
  canonical order) must be an identity transform on rendered bytes for the
  currently covered classic ESC/POS renderer at 32, 42, and 48 columns
  ([`tests/print-parity.test.ts`](../tests/print-parity.test.ts)); labeled variants
  live beside it with a negative fixture or focused executable test per
  rejection class.

## 9. Documented future work (not present tense)

The following remain future work and are described as such; do not promise
them as shipped:

- Visual merchant template editor ([#447](https://github.com/FreeOpenSourcePOS/FloCafe/issues/447) ships the model only).
- Broader hardware- and font-validated raster coverage for non-Latin scripts
  ([printing-nonlatin-capabilities.md](printing-nonlatin-capabilities.md)).
- Localized product/add-on *data* on receipts (labels are localized today;
  product names print as stored).
- Compact/KOT adoption of merchant documents (v1 renders merchant receipts
  through the classic pipeline; [`main/printers/document-merchant.ts`](../main/printers/document-merchant.ts)).

---

# Part II — Contributor recipes

Each recipe lists the files and checks that govern that contribution. Follow
all listed steps; the verification commands below cover the relationships they
name, but not every omitted update is automatically detected.

## Add a print label

1. Add the message to **all** locale files under
   [`frontend/src/lib/i18n/messages/`](../frontend/src/lib/i18n/messages/) (100% leaf parity with `en.json` is
   enforced; see [i18n.md](i18n.md)). Use a dotted key in the `print.`
   namespace for new receipt/KOT concepts.
2. Register the concept id in [`scripts/generate-print-labels.cjs`](../scripts/generate-print-labels.cjs):
   append to `PRINT_NAMESPACE_KEYS` (new `print.*` key) or `BORROWED_KEYS`
   (existing key reused verbatim — prefer this when the UI already has the
   string).
3. Run `npm run generate:print-labels` and commit the regenerated
   [`main/print/print-labels.generated.ts`](../main/print/print-labels.generated.ts) together with the message edits.
   Builds never regenerate tracked sources; drift fails `npm run i18n:check`.
4. Consume it through the kernel, never as a literal: backend code resolves
   via `printLabel(lang, id)`; document labels flow through
   `resolveSemanticLabel` into `SemanticLabel` pairs. Never pre-concatenate
   bilingual strings.
5. Do NOT route branding constants or technical test-page literals through
   the catalog — they are deliberate exemptions (§4).

Verification: `npm run test:print-labels && npm run i18n:check`, then
`npm run test:print-parity` for renderer-visible effects.

## Add a language with print coverage

Follow the six-step language workflow in [i18n.md](i18n.md) first (scaffold,
register in [`frontend/src/lib/i18n/languages.ts`](../frontend/src/lib/i18n/languages.ts) with correct `direction`, translate, validate).
Then close the print loop:

1. Add the language config to [`frontend/src/lib/i18n/languages.ts`](../frontend/src/lib/i18n/languages.ts) with the
   correct `direction` and `selectable` value. This registry drives the
   frontend print-language dropdowns; add the matching locale message file
   through the workflow in [i18n.md](i18n.md).
2. Regenerate and commit [`main/print/print-labels.generated.ts`](../main/print/print-labels.generated.ts) — the generator reads the
   frontend registry in canonical order, and this table is the
   backend's selectable-print-language registry view used by policy validation
   ([`main/lib/print-language-settings.ts`](../main/lib/print-language-settings.ts)).
3. Extend [`tests/print-labels.test.ts`](../tests/print-labels.test.ts) expectations if the suite enumerates
   languages, and add the language to the parity harness's localized-label
   sections if it introduces a new direction/script.

Verification: `npm run generate:print-labels -- --check && npm run i18n:check
&& npm run test:print-kernel && npm run test:print-parity`.

## Add a block type to PrintDocument v1

All five steps are required; the whitelist and fixtures are load-bearing:

1. Define the block interface and add it to the `PrintDocumentBlock` union in
   [`shared/print/document.ts`](../shared/print/document.ts); extend `buildBillDocument` to compose it.
   Follow the model rules: frozen nodes, `DirectionalText` values,
   `SemanticLabel` labels (catalog concept ids where a concept exists; literal
   labels only for the documented data and legacy exceptions), no layout
   widths, no byte tokens.
2. Add the kind to `MERCHANT_TEMPLATE_BLOCK_KINDS` in
   [`shared/print/merchant-template.ts`](../shared/print/merchant-template.ts); add a corresponding entry to
   `MERCHANT_TEMPLATE_LABEL_FIELDS` for every whitelisted kind, using `[]` when
   merchants have no labels to override, and wire overrideable slots into
   `applyLabelOverrides`.
3. Teach every renderer: the classic line renderer switch
   ([`main/printers/document-classic.ts`](../main/printers/document-classic.ts), `renderBillDocumentToClassicLines`),
   compact/KOT where relevant, and the frontend renderers
   ([`frontend/src/lib/printer/receipt-encoder.ts`](../frontend/src/lib/printer/receipt-encoder.ts), [`frontend/src/lib/printer/web-print.ts`](../frontend/src/lib/printer/web-print.ts)) — including the merchant fallback
   path in [`main/printers/document-merchant.ts`](../main/printers/document-merchant.ts).
4. Add fixtures: a golden positive fixture under
   [`tests/fixtures/merchant-templates/`](../tests/fixtures/merchant-templates/) exercising the new block, and a
   negative variant (unknown-kind/duplicate/invalid-label class) under
   [`tests/fixtures/merchant-templates/negative/`](../tests/fixtures/merchant-templates/negative/); keep [`tests/fixtures/merchant-templates/transfer/negative/`](../tests/fixtures/merchant-templates/transfer/negative/) consistent if the envelope is
   affected.
5. Extend tests: [`tests/print-document.test.ts`](../tests/print-document.test.ts) (construction + purity),
   [`tests/merchant-print-templates.test.ts`](../tests/merchant-print-templates.test.ts) (validation + apply), and the
   parity harness ([`tests/print-parity.test.ts`](../tests/print-parity.test.ts)) at all tested widths —
   including the golden-fixture identity assertion if you changed the
   all-blocks composition.

Verification: `npm run test:print-document && npm run test:print-kernel &&
npm run test:merchant-print-templates && npm run test:merchant-template-transfer
&& npm run test:print-parity`.

## Add a printer profile

Profiles live in [`main/printers/profiles.ts`](../main/printers/profiles.ts)
(`SUPPORTED_PRINTER_PROFILES`). One entry declares: unique `id`, make/model +
lowercase `aliases` (matched by substring after normalization), command set,
default paper width and port, Font A/B column counts, optional physical print
width, cut mode, profile-owned thermal capabilities, and notes. The capability
block declares supported code pages and preferred page, Arabic shaping,
representable scripts, transliteration, warning policies, and the additive
raster geometry/mode/font fields; use the generic ASCII-only, raster-disabled
capability block unless the profile has evidence for a narrower hardware
capability.

Rules:

- Set `capabilities.shaping.arabic: true` ONLY after a real print on that
  specific hardware proves shaped, correctly ordered Persian output; leave it
  false otherwise. Generic ESC/POS profiles ship with it false (§6).
- Keep `capabilities.raster.enabled: false` until the profile's bundled font,
  geometry, selected mode, and diagnostic probe are validated on real hardware;
  only an enabled mode may be listed in `capabilities.raster.modes`.
- Resolution is explicit-id → alias-match → paper-width generic fallback
  (`resolvePrinterProfile`); choose aliases so real-world USB/device names
  match (`matchSupportedPrinterProfile` normalizes case and underscores) in
  [`main/printers/profiles.ts`](../main/printers/profiles.ts).
- Verify with Settings → Printers → Test Print at the profile's declared
  widths; cover width-dependent rendering through the parity harness widths
  if the profile introduces a new column count.

## Author or contribute templates

- **Merchant template JSON**: author the `flocafe-merchant-print-template`
  payload (block selection, order, visibility, whitelisted label variants)
  and, for offline transfer, wrap it in the
  [`flocafe-merchant-template` envelope](merchant-print-templates.md#offline-transfer-format-public-contract-448).
  Validate locally against [`shared/print/merchant-template.ts`](../shared/print/merchant-template.ts) rules; every
  violation class must have either a fixture or a focused executable test in
  the merchant-template test suites. Fixtures cover serialized payload and
  envelope cases; size-cap, malformed-input, and printer-control-character
  boundaries may be constructed directly by focused tests.
- **Country compliance pack**: follow [tax-packs.md](tax-packs.md) for
  authoring/signing; if the pack needs receipt templates, author the
  [`escpos-line-template-v1`](printers.md#country-pack-compliance-receipt-templates-escpos-line-template-v1)
  payload and preserve its provenance: compliance templates travel only
  inside signed packs installed into `installed_print_templates` — never
  copy pack payloads into merchant storage or vice versa. When deriving a
  merchant template from a pack template, the clone records `derived_from`
  as user information only (no trust transfers).

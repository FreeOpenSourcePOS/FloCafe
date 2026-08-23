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
- [printing-nonlatin-capabilities.md](printing-nonlatin-capabilities.md) — capability study for non-Latin scripts (FORWARD-LOOKING; raster fallback not implemented).

---

## 1. Pipeline overview

```text
 raw bill / order / business rows  (main/ DB rows or frontend Bill objects)
        │
        │  normalization — the only document-driven step allowed to touch raw fields
        ▼
 PrintData snapshot + PrintContext          (shared/print/document.ts)
 (printed truth, no recomputation)          (columns, languages, direction,
        │                                    locale, label resolver)
        ▼
 buildBillDocument() / buildKotDocument()   pure builders → PrintDocument v1
        │
        │  optional semantic transform
        ▼
 applyMerchantTemplate(document, payload)   shared/print/merchant-template.ts
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
  payload. This remains a separate compliance format; see [the compliance
  template contract in printers.md](printers.md#country-pack-compliance-receipt-templates-escpos-line-template-v1).
- [`frontend/src/lib/printer/kot-web-print.ts`](../frontend/src/lib/printer/kot-web-print.ts) renders browser KOT HTML from a
  raw `Order`; it uses the shared catalog and direction helpers but is not a
  `KotDocument` v1 consumer.
- [`frontend/src/hooks/usePrinter.ts`](../frontend/src/hooks/usePrinter.ts) still calls [`frontend/src/lib/printer/kot-encoder.ts`](../frontend/src/lib/printer/kot-encoder.ts) with raw
  `Order` data for thermal KOT printing and calls the [`frontend/src/lib/printer/tax-bill-encoder.ts`](../frontend/src/lib/printer/tax-bill-encoder.ts) raw
  `Bill`/`Tenant` diagnostic path for the print-test page. The tax encoder is
  explicitly LEGACY-FROZEN.

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
[shared/print/README.md](../shared/print/README.md), enforced by the kernel
test suite (`npm run test:print-kernel`, includes the consumer-boundary check
in [`tests/kernel-purity.test.ts`](../tests/kernel-purity.test.ts)) and ESLint
import restrictions over [`shared/`](../shared/).

## 2. Shared print kernel layout

| Module | Contents | Introduced |
| --- | --- | --- |
| [`types.ts`](../shared/print/types.ts) | `PrintLanguageCode` (structural string), policy shapes, `DirectionScope`, registry-facts interface | [#441](https://github.com/FreeOpenSourcePOS/FloCafe/issues/441) |
| [`policy.ts`](../shared/print/policy.ts) | resolution + validation of receipt/KOT language policies; max-2 receipts enforced at type level | [#441](https://github.com/FreeOpenSourcePOS/FloCafe/issues/441) |
| [`direction.ts`](../shared/print/direction.ts) | per-scope direction spec, conservative LTR-island classification | [#441](https://github.com/FreeOpenSourcePOS/FloCafe/issues/441) |
| [`bilingual.ts`](../shared/print/bilingual.ts) | `BilingualLabel`, width-fit strategies (`inline` vs `stacked`) | [#441](https://github.com/FreeOpenSourcePOS/FloCafe/issues/441) |
| [`document.ts`](../shared/print/document.ts) | `PrintDocument` v1 / `KotDocument` v1 models + pure builders | [#442](https://github.com/FreeOpenSourcePOS/FloCafe/issues/442)/[#443](https://github.com/FreeOpenSourcePOS/FloCafe/issues/443) |
| [`merchant-template.ts`](../shared/print/merchant-template.ts) | semantic merchant template payload validation, offline transfer envelope, `applyMerchantTemplate` | [#447](https://github.com/FreeOpenSourcePOS/FloCafe/issues/447)/[#448](https://github.com/FreeOpenSourcePOS/FloCafe/issues/448) |

Dependency direction is one-way: registry → call site → kernel. The central
language registry ([frontend/src/lib/i18n/languages.ts](../frontend/src/lib/i18n/languages.ts))
is authoritative; both consumers inject their own view of "registered and
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
| `item-table` | header labels, item rows (quantity, unit price, amount, addons, special instructions) |
| `totals` | subtotal, discount, flat tax/service/delivery, grand total, loyalty points lines |
| `tax-breakdown` | per-component lines when the merchant shows the breakdown |
| `payments` | captured payment lines (known methods resolve through concept ids, unknown stay literal) |
| `message` | reprint banner, footer note, thank-you |

Kitchen tickets use a separate smaller vocabulary, `KotDocument` v1
(`kot-header`, `kot-items`; [#443](https://github.com/FreeOpenSourcePOS/FloCafe/issues/443)). The KOT policy is single-primary in v1.

Invariants every consumer may rely on:

- **Financial totals are not recomputed.** Builders copy persisted financial
  amounts verbatim from the `PrintData` snapshots; they apply presence/show
  decisions and the display-only tax-component reconciliation documented
  above (`buildBillDocument` doc comment, asserted in
  [`tests/print-document.test.ts`](../tests/print-document.test.ts) and
  byte-compared against the frozen pre-migration oracle in
  [`tests/print-parity.test.ts`](../tests/print-parity.test.ts)).
- **Labels are never pre-concatenated** `"A / B"` strings. Catalog-backed
  label slots are `SemanticLabel` values with a concept reference plus
  already-resolved primary text and an optional secondary-language rendering
  of the same concept. Literal data labels — such as tax-ID text, tax
  component titles, and unknown payment methods — intentionally omit
  `conceptId`; renderers still decide how language variants share a line.
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
RTL script letters or reading as natural language stays in the base
direction. Mixed natural-language text is never an island. Behavior is
covered by the direction tests in [`tests/print-kernel.test.ts`](../tests/print-kernel.test.ts).

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
  (`ReceiptLanguagePolicy` tuple) and by validation (`MAX_RECEIPT_LANGUAGES`)
  in [`shared/print/policy.ts`](../shared/print/policy.ts).
- **Kitchen ticket policy** (`kot_language_policy`): single-primary, resolved
  independently of the receipt. The backend document path and browser HTML KOT
  path honor a fixed language — for example, an English kitchen keeps English
  tickets in a Persian storefront (asserted in the backend policy section of
  [`tests/print-parity.test.ts`](../tests/print-parity.test.ts) and the browser cold-start regression
  [`tests/kot-locale-cold-start.test.ts`](../tests/kot-locale-cold-start.test.ts)). The frontend WebUSB
  [`frontend/src/lib/printer/kot-encoder.ts`](../frontend/src/lib/printer/kot-encoder.ts) is a legacy exception: its raw `buildKotBytes` path has no
  language input and emits its historical English labels.

Thermal receipt paths resolve the receipt policy before building the document.
The browser receipt path is an active exception: [`frontend/src/hooks/usePrinter.ts`](../frontend/src/hooks/usePrinter.ts) calls
`printWebBill` without a policy-derived `language`, and [`frontend/src/lib/printer/web-print.ts`](../frontend/src/lib/printer/web-print.ts) defaults
to the active UI language before building a single-language document. A fixed
receipt primary therefore does not currently change browser receipt labels;
this is separate from the model-only/future bilingual renderer work above.

Policy payloads are untrusted input: `parsePrintLanguagePolicy` /
`parseKotLanguagePolicy` reject unknown top-level keys and validate the relevant
nested `primary`/`additional` values, but extra fields inside a primary
selection object are ignored. They require registered + selectable codes via
the injected registry facts, dedupe, reject duplicate primaries, and return
shallow-frozen normalized policies safe to persist (the outer policy and
`additional` array are frozen; nested primary selections are not deep-frozen).
Invalid or missing settings fall back to the store language; printing never
fails because of a malformed policy ([`main/lib/print-language-settings.ts`](../main/lib/print-language-settings.ts),
[`tests/print-language-settings.test.ts`](../tests/print-language-settings.test.ts)).

Settings are registry-driven through two synchronized views: the frontend
renders print-language options from [`LANGUAGES`](../frontend/src/lib/i18n/languages.ts),
with controls filtered in [`settings/page.tsx`](<../frontend/src/app/(dashboard)/settings/page.tsx>)
and stored-policy checks in [`print-language-policies.ts`](../frontend/src/lib/print-language-policies.ts);
backend policy validation accepts only languages present in
[`PRINT_LABEL_LANGUAGES`](../main/print/print-labels.generated.ts), wired through
[`main/lib/print-language-settings.ts`](../main/lib/print-language-settings.ts)
and checked by [`shared/print/policy.ts`](../shared/print/policy.ts).
Both registries must be updated when a language gains print coverage.

### Canonical i18n label flow (kernel C, [#440](https://github.com/FreeOpenSourcePOS/FloCafe/issues/440))

Canonical locale messages are the single translation source:

```text
frontend/src/lib/i18n/messages/<lang>.json      (canonical, 100% parity with en.json)
        │  npm run generate:print-labels   (scripts/generate-print-labels.cjs)
        ▼
main/print/print-labels.generated.ts            (committed derived view)
        │  printLabel(lang, conceptId)  — unknown language falls back to English;
        │                                  conceptId is a generated union
        ▼
backend renderers + backend registry facts for policy validation
```

The canonical flow is enforced by [`frontend/src/lib/i18n/messages/`](../frontend/src/lib/i18n/messages/),
[`scripts/generate-print-labels.cjs`](../scripts/generate-print-labels.cjs),
[`main/print/print-labels.generated.ts`](../main/print/print-labels.generated.ts),
and [`main/lib/print-language-settings.ts`](../main/lib/print-language-settings.ts).

Browser receipt label exception (legacy, follow-up alignment):
[`generateBillHtml` in `web-print.ts`](../frontend/src/lib/printer/web-print.ts) builds the document for business values, but its visible
receipt labels still come directly from that file's `t()` catalog lookups
for `receipt.*` and `pos.*` keys. For example, the browser uses
`receipt.billNumber` and `receipt.grandTotal` instead of the corresponding
document concepts used by the migrated renderers. This path remains on the
canonical locale catalog but is not yet aligned to the document label slots;
future work should converge the browser label surface without changing the
merchant/compliance format boundaries.

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
- Known deliberate gap: the KOT `Order:` prefix has no assigned key yet;
  the KOT document carries only the value (`KotHeaderBlock.orderNumber`
  doc comment).
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
[`main/printers/profiles.ts`](../main/printers/profiles.ts):
paper-width/column geometry (`fontAColumns`, `defaultPaperWidth`), cut mode,
command set (`escpos` today), and `arabicShaping`. Profile resolution order:
explicit `profile_id` → name/make/model alias match → paper-width-based
generic fallback (`resolvePrinterProfile`). `arabicShaping` defaults to unset
(false) and may only be set true after a real print on that hardware proves
shaped Persian output — generic ESC/POS firmware neither shapes Arabic nor
reorders bidi (evidence in [printing-nonlatin-capabilities.md](printing-nonlatin-capabilities.md)).

Renderers consume capabilities, they never guess them:

- Desktop ESC/POS: lines whose content the target printer cannot render are
  skipped with an explicit warning unless the profile's shaping flag (or a
  request-level override) admits strict ASCII+Arabic lines
  (`buildEscPos` guard in [`main/printers/thermal.ts`](../main/printers/thermal.ts)).
- The migrated WebUSB receipt path uses `safePrinterText` for renderer-managed
  text and its warning behavior ([`frontend/src/lib/printer/receipt-encoder.ts`](../frontend/src/lib/printer/receipt-encoder.ts),
  [`frontend/src/lib/printer/warnings.ts`](../frontend/src/lib/printer/warnings.ts)). `buildClassicReceiptBytes` still
  writes the masked customer phone directly with `enc.text`, so that field is a
  documented warning-contract exception. The raw WebUSB [`frontend/src/lib/printer/kot-encoder.ts`](../frontend/src/lib/printer/kot-encoder.ts) and
  LEGACY-FROZEN [`frontend/src/lib/printer/tax-bill-encoder.ts`](../frontend/src/lib/printer/tax-bill-encoder.ts) paths are broader exceptions with their
  own direct-write and warning behavior.
- Browser HTML printing is the full-Unicode path: nothing is skipped for
  script reasons (asserted in [`tests/print-parity.test.ts`](../tests/print-parity.test.ts)).

Warning semantics on the shared document-driven paths are **no silent loss of
unsupported content**: every skipped line produces a `PrintWarning` naming the
field, the skipped text, and the reason; unsupported configuration (for example
a merchant template selected on a print path that cannot honor it) produces a
path-specific warning and a documented fallback layout. The frontend
[`makeBillTemplateFallbackWarning`](../frontend/src/lib/printer/warnings.ts)
marks that warning `kind: 'configuration'`; desktop
[`PrintWarning`](../main/printers/thermal.ts) carries `field`, `text`, and
`message` without a `kind` field. A valid merchant template may intentionally
reorder, hide, or omit blocks — including `totals` — through explicit block
selection and `visible` settings; that is merchant configuration, not a silent
renderer omission. The legacy raw WebUSB encoders described above retain their
own warning behavior and do not inherit the `PrintDocument` guarantees.
Warnings surface to the user after printing
([`frontend/src/lib/printer/warnings-toast.ts`](../frontend/src/lib/printer/warnings-toast.ts)) and in
dispatch results (`classifyPrintFailure` in [`main/printers/thermal.ts`](../main/printers/thermal.ts) gives stable, privacy-safe failure
classes for fleet telemetry). The end-state contract from [epic #438](https://github.com/FreeOpenSourcePOS/FloCafe/issues/438) for the
shared paths is native render, explicitly supported fallback, or an explicit
warning/error for unsupported content or configuration. The recommended
capability-tiered raster fallback for broader script coverage is future work
([printing-nonlatin-capabilities.md](printing-nonlatin-capabilities.md)).

## 7. Renderer/transport map

| Renderer | Surface | Consumes | Output | Transport |
| --- | --- | --- | --- | --- |
| [`main/printers/document-classic.ts`](../main/printers/document-classic.ts) (`renderClassicReceiptViaDocument`, [#442](https://github.com/FreeOpenSourcePOS/FloCafe/issues/442)) | desktop preview + printing, receipts | PrintDocument v1 | token lines → bytes | socket :9100 / OS queue |
| [`main/printers/document-compact.ts`](../main/printers/document-compact.ts) ([#443](https://github.com/FreeOpenSourcePOS/FloCafe/issues/443)) | desktop compact receipts | PrintDocument v1 | token lines → bytes | same |
| [`main/printers/document-kot.ts`](../main/printers/document-kot.ts) ([#443](https://github.com/FreeOpenSourcePOS/FloCafe/issues/443)) | desktop kitchen tickets | KotDocument v1 | token lines → bytes | same |
| [`main/printers/document-merchant.ts`](../main/printers/document-merchant.ts) ([#447](https://github.com/FreeOpenSourcePOS/FloCafe/issues/447)/[#448](https://github.com/FreeOpenSourcePOS/FloCafe/issues/448)) | desktop receipts with active merchant template | applied PrintDocument | token lines → bytes (fail-closed fallback to classic) | same |
| [`main/printers/thermal.ts`](../main/printers/thermal.ts) compliance plugin ([#445](https://github.com/FreeOpenSourcePOS/FloCafe/issues/445)) | desktop receipt with signed country-pack template | raw `Order`/`Bill`/business rows + signed [`escpos-line-template-v1`](printers.md#country-pack-compliance-receipt-templates-escpos-line-template-v1) payload | ESC/POS bytes | desktop transport |
| [`frontend/src/lib/printer/receipt-encoder.ts`](../frontend/src/lib/printer/receipt-encoder.ts) ([#444](https://github.com/FreeOpenSourcePOS/FloCafe/issues/444)) | WebUSB thermal receipts | PrintDocument v1 via [`frontend/src/lib/printer/print-document.ts`](../frontend/src/lib/printer/print-document.ts) bridge | ESC/POS bytes | WebUSB device |
| [`frontend/src/lib/printer/kot-encoder.ts`](../frontend/src/lib/printer/kot-encoder.ts) ([#444](https://github.com/FreeOpenSourcePOS/FloCafe/issues/444), legacy exception) | WebUSB thermal KOT | raw `Order` data; no PrintDocument bridge | ESC/POS bytes | WebUSB device |
| [`frontend/src/lib/printer/tax-bill-encoder.ts`](../frontend/src/lib/printer/tax-bill-encoder.ts) ([#444](https://github.com/FreeOpenSourcePOS/FloCafe/issues/444), LEGACY-FROZEN diagnostic exception) | WebUSB print-test tax bill | raw `Bill`/`Tenant` data; no PrintDocument bridge | ESC/POS bytes | WebUSB device |
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
| Labels | `npm run test:print-labels` | generated-table selection, English fallback, generator drift (`--check`) ([`tests/print-labels.test.ts`](../tests/print-labels.test.ts), [`scripts/generate-print-labels.cjs`](../scripts/generate-print-labels.cjs)) |
| Document model | `npm run test:print-document` | block construction, document builders, bilingual pairs, direction annotations, purity ([`tests/print-document.test.ts`](../tests/print-document.test.ts)) |
| Parity harness | `npm run test:print-parity` | cross-renderer semantic parity + byte-exact migration oracle ([`tests/print-parity.test.ts`](../tests/print-parity.test.ts)) |
| Merchant templates | `npm run test:merchant-print-templates` | kernel validation, apply semantics, CRUD lifecycle, render path ([`tests/merchant-print-templates.test.ts`](../tests/merchant-print-templates.test.ts)) |
| Transfer envelope | `npm run test:merchant-template-transfer` | import/export contract, tampered-checksum rejection ([`tests/merchant-template-import-export.test.ts`](../tests/merchant-template-import-export.test.ts)) |

Parity harness usage and fixture matrix ([`tests/print-parity.test.ts`](../tests/print-parity.test.ts)):

- **Semantic assertions** (content present / explicit warning recorded), not
  byte snapshots, for cross-renderer checks; amounts compared after stripping
  grouping separators so `en-IN` and `en-US` styles both pass.
- **Byte-exact oracle**: every migrated backend surface (classic, compact,
  KOT) must reproduce its frozen pre-migration output BYTE FOR BYTE at every
  tested width, including skip rules and reprint banners
  ([`tests/helpers/legacy-thermal-oracle.ts`](../tests/helpers/legacy-thermal-oracle.ts)).
- **Width coverage expectations**: backend ESC/POS at 32/42/48 columns;
  WebUSB at 58 mm and 80 mm; browser HTML at `thermal58`/`thermal80`;
  bilingual fit strategies evaluated across 32–48 columns
  ([`shared/print/bilingual.ts`](../shared/print/bilingual.ts)). New print features must state their width
  behavior at these widths.
- **Merchant-template mode**: the golden fixture
  ([`tests/fixtures/merchant-templates/golden-receipt-v1.json`](../tests/fixtures/merchant-templates/golden-receipt-v1.json), all blocks,
  canonical order) must be an identity transform on rendered bytes at every
  width; labeled variants live beside it with a negative fixture or focused
  executable test per rejection class.

## 9. Documented future work (not present tense)

The following remain future work and are described as such; do not promise
them as shipped:

- Visual merchant template editor ([#447](https://github.com/FreeOpenSourcePOS/FloCafe/issues/447) ships the model only).
- Capability-tiered raster fallback for non-Latin scripts
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
2. Add the language code to the separate `LANGUAGES` array in
   [`scripts/generate-print-labels.cjs`](../scripts/generate-print-labels.cjs) (stable generation order). This keeps
   the generated backend print-label registry in sync with the frontend
   registry; it does not populate the frontend dropdown.
3. Regenerate and commit [`main/print/print-labels.generated.ts`](../main/print/print-labels.generated.ts) — this table is the
   backend's selectable-print-language registry view used by policy validation
   ([`main/lib/print-language-settings.ts`](../main/lib/print-language-settings.ts)).
4. Extend [`tests/print-labels.test.ts`](../tests/print-labels.test.ts) expectations if the suite enumerates
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
width, cut mode, and notes.

Rules:

- Set `arabicShaping: true` ONLY after a real print on that specific hardware
  proves shaped, correctly ordered Persian output; leave it unset otherwise.
  Generic ESC/POS profiles ship with it unset (§6).
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

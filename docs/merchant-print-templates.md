# Merchant print templates

Status: CURRENT (model shipped in issue #447; file import/export UX is #448)

Merchant print templates are tenant-owned, versioned descriptions of receipt
SEMANTIC STRUCTURE. They let a merchant choose which PrintDocument v1 blocks
appear on their receipts, in which order, and with which label variants —
without ever touching renderer specifics.

## Relationship to other template systems

| System | Storage | Trust model | Format |
| --- | --- | --- | --- |
| Core layouts (`classic`, `compact`) | code | built-in | code + PrintDocument |
| Compliance templates (#445) | `installed_print_templates` | Ed25519-verified country-pack artifacts; rows are denormalized children of **signed** pack versions | `escpos-line-template-v1` (legacy/compliance-oriented line templates) |
| **Merchant templates (this doc)** | `merchant_print_templates` | ordinary tenant data — NO compliance trust | `flocafe-merchant-print-template` (semantic blocks) |

These formats are deliberately NOT converged. Issue #445's
`escpos-line-template-v1` payloads remain the compliance-pack contract;
`flocafe-merchant-print-template` is the merchant-facing semantic contract.
`installed_print_templates` must never become generic storage for tenant JSON:
its trust model depends on every row tracing to a verified pack version.

## Payload schema (v1)

```jsonc
{
  "format": "flocafe-merchant-print-template",  // discriminator, constant
  "documentType": "receipt",                    // v1 ships receipts only
  "schemaVersion": 1,                           // major-versioned, fail-closed
  "blocks": [
    { "kind": "business-header" },
    { "kind": "document-meta", "labels": { "title": "SALES RECEIPT" } },
    { "kind": "item-table", "labels": { "quantity": "Qty" }, "visible": true },
    { "kind": "totals", "labels": { "grandTotal": "AMOUNT DUE" } },
    { "kind": "tax-breakdown", "visible": false }
    // ... customer, payments, message
  ]
}
```

- `blocks` is the COMPLETE composition: render order follows array order,
  and a block absent from the list is not rendered. Allowed kinds mirror the
  PrintDocument v1 vocabulary exactly: `business-header`, `document-meta`,
  `customer`, `item-table`, `tax-breakdown`, `totals`, `payments`, `message`.
- `visible: false` hides an entry without removing it from the ordered list.
- `labels` maps STABLE semantic field identifiers of a block (e.g.
  `grandTotal`, `invoiceNumber`) to merchant literal text. The literal
  replaces the resolved label text for EVERY language variant. These keys are
  semantic field names — internal i18n translation keys are never exposed as
  template fields.
- No ESC/POS tokens, HTML, or renderer snippets may appear anywhere in a
  payload. One template feeds every renderer by being applied to a built
  PrintDocument before rendering (`applyMerchantTemplate`).

## Validation & compatibility policy

Enforced on EVERY write/import path (`validateMerchantTemplateText`,
shared kernel) — stricter than render-time tolerance:

- Unknown schema MAJOR versions fail closed (a payload written by a newer
  build cannot be activated or re-imported by an older build).
- Unknown root/block fields, unknown block kinds, unknown label fields,
  duplicate block kinds, wrong types, non-object roots, malformed JSON:
  rejected with actionable, pointer-carrying errors.
- Payload size cap: 256 KB.
- The render path re-validates fail-closed too: if a stored payload no longer
  validates, the classic layout renders instead and an explicit warning is
  recorded — never garbage, never silence.

Minor-version evolution policy: additive optional fields only; readers ignore
unknown MINOR revisions within a known major at RENDER time but writers still
reject them on write/import to keep stored payloads auditable.

## Storage & lifecycle

Table `merchant_print_templates` (migration v72):

- `id` uuid PK; `business_id` tenant scope (the embedded database is
  single-store, so rows are scoped to `'local'`).
- `origin`: `created | imported | cloned`; `derived_from` nullable structured
  reference `{ type, templateId }`.
- `document_type` (`receipt`), `schema_version`, canonical `payload_json`.
- `status`: `draft → active → archived`. Only ACTIVE rows are selectable as
  the bill template.
- `previous_payload_json`: single-step rollback point (captured when an
  active template's payload changes).
- `checksum`: sha256 of the exact persisted payload text; verified before
  activation and rollback so tampering is detected before any state change.

CRUD API (owner role): `/api/print-templates` — create draft, update draft /
active (active edits snapshot the previous payload), `activate`, `archive`,
`rollback`.

## Provenance & trust

Four provenance classes stay distinct: core / compliance-pack /
merchant-created / imported. Cloning from a compliance template records
`origin = 'cloned'` and `derived_from = { type: 'compliance-pack-template',
templateId }` for USER INFORMATION ONLY. No compliance trust transfers:
required legal blocks in compliance templates are enforced by the compliance
system itself, and a merchant copy is an ordinary editable document. The
settings picker shows this origin as an informational badge without any trust
claim.

## Selection identity

The `bill_template` setting persists a STRUCTURED selection:

```json
{ "source": "core" | "pack" | "merchant", "id": "..." }
```

- Legacy bare values (`classic`, `compact`, `<pack-template-id>`) keep
  resolving during the transition and upgrade transparently on the next save
  (migration v72 upgraded resolvable values once, idempotently).
- Pack ids happen to be globally unique today (`template_id` is the table
  PK), but persisted semantics deliberately do not rely on that accident.
- Resolution order for legacy strings: core names, then pack ids, then
  merchant ids.

## Renderers

Merchant receipt documents render through the PrintDocument pipeline
(`data → document → applyMerchantTemplate → renderer`). The parity harness
(print-parity.test.ts) runs a merchant-template mode asserting byte-equivalence
with the plain classic document pipeline. Compact/KOT rendering of merchant
documents belongs to their owning issues.

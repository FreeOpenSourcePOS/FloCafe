# Merchant print templates

Status: CURRENT (model shipped in issue #447; offline import/export shipped in issue #448; visual editor remains future work)

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
- The payload shape contains semantic block selections and literal label text
  only; it has no fields for ESC/POS tokens, HTML, or renderer snippets. The
  backend thermal receipt renderer consumes the applied document through
  `applyMerchantTemplate`; browser/WebUSB print paths currently use the
  built-in layout and show an explicit fallback warning for merchant
  selections.

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

This release exposes an integer `schemaVersion` and supports version `1` only;
there is no separate minor-version field yet. Any other version value fails
validation on write/import and at render time, keeping stored payloads
auditable until a future compatibility policy is explicitly introduced.

## Storage & lifecycle

Table `merchant_print_templates` (migration v72; stored payloads normalized by
migration v73):

- `id` uuid PK; `business_id` tenant scope (the embedded database is
  single-store, so rows are scoped to `'local'`).
- `origin`: `created | imported | cloned`; `derived_from` nullable structured
  reference (`{ type, templateId }`, plus optional `fileName` for
  offline-import sources).
- `document_type` (`receipt`), `schema_version`, canonical `payload_json`.
- `status`: `draft → active → archived`. Only ACTIVE rows are selectable as
  the bill template.
- `previous_payload_json`: single-step rollback point (captured when an
  active template's payload changes).
- `checksum`: sha256 of the exact persisted payload text; verified before
  activation and rollback so tampering is detected before any state change.
- Migration v73 rewrote rows written before the canonical serialization
  convention (client key order) into it once, idempotently, so envelope
  checksums equal row checksums across upgrades. Rows whose stored text no
  longer matches their checksum, or that no longer validate under the current
  schema, are left untouched for the fail-closed checks above.

CRUD API (owner role): `/api/print-templates` — create draft, update draft /
active (active edits snapshot the previous payload), `activate`, `archive`,
`rollback`.

## Offline transfer format (public contract, #448)

Templates travel as self-describing `.json` files (`*.flocafe-template.json`),
built by `GET /api/print-templates/:id/export` and consumed by
`POST /api/print-templates/import` (both owner-role only):

```jsonc
{
  "format": "flocafe-merchant-template",      // envelope discriminator, constant
  "schemaVersion": 1,                          // ENVELOPE version, fail-closed on unknown majors
  "exportedAt": "2026-02-14T09:00:00.000Z",    // ISO-8601
  "appVersion": "3.3.0",                       // optional, informational
  "origin": {                                  // optional, informational provenance of the export
    "sourceTemplateId": "<uuid>",
    "sourceName": "Front Counter Receipt",
    "sourceChecksum": "<sha256 hex>"
  },
  "checksum": "<sha256 hex>",                  // integrity of the embedded payload (see below)
  "template": { /* the #447 payload, exactly as stored */ }
}
```

Contract promises:

- Field names above are stable. Unknown root/origin fields are REJECTED on
  import (stricter than render tolerance) so typos cannot change meaning.
- The envelope major gate is independent of the payload's `schemaVersion`:
  unknown envelope majors fail closed before the payload is even inspected.
- `checksum` is the sha256 hex of the CANONICAL payload text: the validated
  payload serialized with recursively sorted object keys, unchanged array
  order, and no insignificant whitespace (`serializeMerchantTemplatePayload`
  in the shared print kernel). That exact text is also what the table's
  `payload_json` column stores, so the envelope `checksum` equals the row's
  `checksum` column. Whitespace/key-order reformatting of the file does not
  break verification; any semantic modification (including block order)
  does.
- Import treats every file as untrusted input: raw byte cap 256 KB, single
  JSON document, structural envelope validation, then the SAME shared
  payload validator used on every write path (#447), then checksum
  verification. No network access, registry lookup, or fetch happens anywhere
  in the import/export path.
- Imports ALWAYS land as a NEW draft row (`origin: 'imported'`, fresh uuid)
  — never auto-activated, never overwriting an existing identity. Duplicate
  names are allowed; `derived_from` records `{ type: 'offline-import',
  templateId: <sha256 of the exact source file text>, fileName?: <sanitized
  source file name> }` as provenance.
- Exportable states are `active` and `archived`; drafts are refused (they
  have never passed activation, the checksum-verified review point). A row
  whose stored checksum no longer matches its payload can never be exported,
  and the serialized envelope is held to the same 256 KB raw-byte cap import
  enforces, so an install never mints a file it would refuse to read back.
- Only minor-version forward migration would be introduced together with an
  explicit compatibility policy; today integer `schemaVersion` values other
  than `1` are rejected in both envelope and payload positions.

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

Merchant receipt documents render through the backend PrintDocument pipeline
(`data → document → applyMerchantTemplate → renderer`). The parity harness
(print-parity.test.ts) runs a merchant-template mode asserting byte-equivalence
with the plain classic document pipeline. Browser/WebUSB printing uses the
built-in classic/compact layout and warns when a merchant template is selected.
Compact/KOT rendering of merchant documents belongs to their owning issues.

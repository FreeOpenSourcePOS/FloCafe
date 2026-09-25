# Merchant print templates

Merchant print templates are tenant-owned, versioned descriptions of receipt semantic structure.
They let a merchant choose which PrintDocument v1 blocks appear on their receipts, in which order,
and with which label variants, without touching renderer specifics.

## Relationship to other template systems

| System | Storage | Trust model | Format |
| --- | --- | --- | --- |
| Core layouts (`classic`, `compact`) | code | built-in | code + PrintDocument |
| Compliance templates | `installed_print_templates` | rows are denormalized children of a tax pack version that passed the 26 activation checks | `escpos-line-template-v1` (line templates) |
| **Merchant templates (this page)** | `merchant_print_templates` | ordinary tenant data, with no compliance trust | `flocafe-merchant-print-template` (semantic blocks) |

These formats are deliberately not converged. `escpos-line-template-v1` payloads are the
compliance-pack contract, described in
[print-templates-compliance.md](print-templates-compliance.md);
`flocafe-merchant-print-template` is the merchant-facing semantic contract.
`installed_print_templates` must never become generic storage for tenant JSON: its trust model
depends on every row tracing to a verified pack version.

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

- `blocks` is the complete composition: render order follows array order, and a block absent from
  the list is not rendered. Allowed kinds mirror the PrintDocument v1 vocabulary exactly:
  `business-header`, `document-meta`, `customer`, `item-table`, `tax-breakdown`, `totals`,
  `payments`, `message`.
- `visible: false` hides an entry without removing it from the ordered list.
- `labels` maps stable semantic field identifiers of a block (for example `grandTotal` or
  `invoiceNumber`) to merchant literal text. The literal replaces the resolved label text for
  every language variant. These keys are semantic field names; internal i18n translation keys are
  never exposed as template fields.
- The payload shape contains semantic block selections and literal label text only. It has no
  fields for ESC/POS tokens, HTML, or renderer snippets. The backend thermal receipt renderer
  consumes the applied document through `applyMerchantTemplate`. Browser and WebUSB print paths
  build their labels from the shared `PrintDocument` bridge and the canonical catalog resolver,
  with registry-derived direction, and keep the built-in block layout. Those paths show an
  explicit fallback warning when a merchant selection cannot be applied, and the structural
  fallback does not use a browser-only translation table.

## Validation and compatibility policy

Enforced on every write and import path by `validateMerchantTemplateText` in the shared print
kernel, and stricter than render-time tolerance:

- Unknown schema major versions fail closed. A payload written by a newer build cannot be
  activated or re-imported by an older build.
- Unknown root or block fields, unknown block kinds, unknown label fields, duplicate block kinds,
  wrong types, non-object roots, and malformed JSON are rejected with actionable, pointer-carrying
  errors.
- Payload size cap: 256 KB.
- The render path re-validates fail-closed too. If a stored payload no longer validates, the
  classic layout renders instead and an explicit warning is recorded: never garbage, never
  silence.

`schemaVersion` is an integer and version `1` is the only supported value. Any other value fails
validation on write and import and at render time.

## Storage and lifecycle

Table `merchant_print_templates`, introduced by migration v72, with stored payloads normalized by
migration v73:

- `id` uuid primary key; `business_id` tenant scope. The embedded database is single-store, so
  rows are scoped to `'local'`.
- `origin`: `created`, `imported`, or `cloned`; `derived_from` is a nullable structured reference
  (`{ type, templateId }`), plus an optional `fileName` for offline-import sources.
- `document_type` (`receipt`), `schema_version`, and the canonical `payload_json`.
- `status`: `draft`, `active`, then `archived`. Only active rows are selectable as the bill
  template.
- `previous_payload_json`: a single-step rollback point, captured when an active template's payload
  changes.
- `checksum`: the SHA-256 of the exact persisted payload text, verified before activation and
  rollback so tampering is detected before any state change.
- Migration v73 rewrote rows written before the canonical serialization convention into it once,
  idempotently, so envelope checksums equal row checksums across upgrades. Rows whose stored text
  no longer matches their checksum, or that no longer validate under the current schema, are left
  untouched for the fail-closed checks above.

The API is under `/api/print-templates`. Owners have full access. Managers have read access to the
template list and to a template's payload; every other operation, including export, create,
update, activate, archive, rollback, and import, is owner-only. The write operations are create
draft, update draft or active, activate, archive, and rollback. An edit to an active template
snapshots the previous payload.

## Offline transfer format

Templates travel as self-describing `.json` files (`*.flocafe-template.json`), built by
`GET /api/print-templates/:id/export` and consumed by
`POST /api/print-templates/import`. Both are owner-only.

```jsonc
{
  "format": "flocafe-merchant-print-template",      // envelope discriminator, constant
  "schemaVersion": 1,                               // envelope version, fail-closed on unknown majors
  "exportedAt": "2026-02-14T09:00:00.000Z",         // ISO-8601
  "appVersion": "3.3.0",                           // optional, informational
  "origin": {                                      // optional, informational export provenance
    "sourceTemplateId": "<uuid>",
    "sourceName": "Front Counter Receipt",
    "sourceChecksum": "<sha256 hex>"
  },
  "checksum": "<sha256 hex>",                      // integrity of the embedded payload
  "template": { /* the stored payload, exactly as persisted */ }
}
```

The contract:

- The field names above are stable. Unknown root or `origin` fields are rejected on import, which
  is stricter than render tolerance, so a typo cannot change meaning.
- The envelope major gate is independent of the payload's `schemaVersion`. An unknown envelope
  major fails closed before the payload is inspected.
- `checksum` is the SHA-256 hex of the canonical payload text: the validated payload serialised
  with recursively sorted object keys, unchanged array order, and no insignificant whitespace, by
  `serializeMerchantTemplatePayload` in the shared print kernel. That exact text is also what the
  table's `payload_json` column stores, so the envelope `checksum` equals the row's `checksum`
  column. Whitespace and key-order reformatting of the file does not break verification; any
  semantic modification, including block order, does.
- Import treats every file as untrusted input: raw byte cap 256 KB, single JSON document,
  structural envelope validation, then the same shared payload validator used on every write path,
  then checksum verification. No network access, registry lookup, or fetch happens anywhere in the
  import or export path.
- Imports always land as a new draft row with `origin: 'imported'` and a fresh uuid. They are
  never auto-activated and never overwrite an existing identity. Duplicate names are allowed, and
  `derived_from` records `{ type: 'offline-import', templateId: <sha256 of the exact source file
  text>, fileName?: <sanitized source file name> }` as provenance.
- Exportable states are `active` and `archived`. Drafts are refused, because they have never passed
  activation, which is the checksum-verified review point. A row whose stored checksum no longer
  matches its payload can never be exported, and the serialised envelope is held to the same 256 KB
  raw-byte cap import enforces, so an install never mints a file it would refuse to read back.
- An integer `schemaVersion` other than `1` is rejected in both the envelope and the payload
  position.

## Provenance and trust

Four provenance classes stay distinct: core, compliance-pack, merchant-created, and imported.
Cloning from a compliance template records `origin = 'cloned'` and
`derived_from = { type: 'compliance-pack-template', templateId }` as user information only. No
compliance trust transfers: required legal blocks in compliance templates are enforced by the
compliance system itself, and a merchant copy is an ordinary editable document. The settings
picker shows this origin as an informational badge without any trust claim.

## Selection identity

The `bill_template` setting persists a structured selection:

```json
{ "source": "core" | "pack" | "merchant", "id": "..." }
```

- Legacy bare values (`classic`, `compact`, and a pack template id) keep resolving, and upgrade
  transparently to the structured form on the next save. Migration v72 upgraded resolvable values
  once, idempotently.
- Pack ids are globally unique in practice, because `template_id` is the table primary key, but the
  persisted semantics deliberately do not rely on that.
- The settings picker matches both `id` and `source`, so core and pack cards with the same bare id
  cannot both appear selected.
- Resolution order for legacy strings: core names, then pack ids, then merchant ids.

## Renderers

Merchant receipt documents render through the backend
[PrintDocument pipeline](../../shared/print/document.ts), on the path
`data → document → applyMerchantTemplate → renderer`. The
[parity harness](../../tests/print-parity.test.ts) runs a merchant-template mode asserting
byte-equivalence with the plain classic document pipeline. Browser and WebUSB printing use the
shared document labels and the built-in classic and compact block layouts, and warn when a merchant
template's structural selection or label overrides cannot be applied on that path. The fallback
is enforced by [`web-print.ts`](../../frontend/src/lib/printer/web-print.ts) and
[`print-document.ts`](../../frontend/src/lib/printer/print-document.ts) for label resolution, while
[`usePrinter.ts`](../../frontend/src/hooks/usePrinter.ts) owns the structural fallback and
delegates its warning to [`warnings.ts`](../../frontend/src/lib/printer/warnings.ts). Behavioural
coverage is in [`printer.test.ts`](../../tests/printer.test.ts),
[`browser-receipts.test.ts`](../../tests/browser-receipts.test.ts), and
[`print-parity.test.ts`](../../tests/print-parity.test.ts).

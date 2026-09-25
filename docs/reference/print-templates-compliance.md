# Compliance print templates (`escpos-line-template-v1`)

A signed country tax pack can ship a declarative receipt template that renders through FloCafe's
built-in ESC/POS line renderer, `renderEscposLineTemplateV1` in `main/printers/thermal.ts`, under
the renderer id `flocafe-thermal-receipt-template`. The template is data: FloCafe validates it,
selects a width profile, and renders it with its own code. Nothing in a pack is executed. See
[data-only tax packs](../decisions/0004-data-only-tax-packs.md) for why that boundary exists.

This is the contract for pack authors. If you are building a merchant-facing template, you want
[merchant print templates](merchant-print-templates.md), which is a different trust model over
different data. Do not model merchant features on this contract.

## Payload fields

| Field | Type | Required | Behaviour |
| --- | --- | --- | --- |
| `format` | `"escpos-line-template-v1"` | yes | Contract identifier. Must match exactly. |
| `widthProfiles` | array | yes | Per-width column layouts. Each profile's `columns` must be an integer from 32 to 48. At least one profile is required, and the set must cover each width a declaring pack names. |
| `header` | object | no | Author strings: `businessNameTransform` (`uppercase`), `taxTitleWhenTaxPresent`, `titleWhenTaxAbsent`. |
| `fields.taxRegistrationNumberLabel` | string | no | Author label for the tax registration line. |
| `totals.grandTotalLabel` | string | no | Author label for the bold grand-total row. |
| `totals.chargeRows` | array of `serviceCharge`, `deliveryCharge`, `packagingCharge` | no | Opts into persisted nonzero charge rows. Output stays in service, delivery, packaging order, and zero values stay absent. Duplicates and unknown ids are rejected. |
| `totals.showSubtotal`, `totals.showDiscount` | boolean | no | Toggle the subtotal and discount rows. Both default on. |
| `totals.showTaxRegistrationNumber` | string | no | `when_tax_present_or_enabled`, or the default visibility rule. |
| `footer.defaultMessage` | string | no | Author footer, used when no configured footer note applies. |
| `footer.useConfiguredFooterNote` | boolean | no | Prefer the merchant's configured footer note. Defaults on. |
| `footer.includePoweredByFloPOS` | boolean | no | Append the FloPOS branding footer. Defaults on. |
| `labels` | object | no | Optional map of semantic label id to override string. See below. |

Unknown fields are tolerated at render time, so a pack that carries a newer field still renders on
an app that does not know it.

## The optional `labels` map

A pack may ship a payload-root `labels` map to override the built-in fallback labels with
jurisdiction-specific copy:

```json
{
  "format": "escpos-line-template-v1",
  "widthProfiles": [{ "columns": 48, "layout": {} }],
  "labels": {
    "total": "SUMA TOTAL",
    "footerThanks": "¡Gracias por su visita!"
  }
}
```

### Label ids

These eleven ids are stable public identifiers. They are not internal i18n keys, and once shipped
an id never changes meaning.

| Id | Catalog concept | Used for |
| --- | --- | --- |
| `invoice` | `print.invoiceTitle` | Receipt title when no tax applies. |
| `taxInvoice` | `print.taxInvoiceTitle` | Receipt title when tax applies. |
| `subtotal` | `pos.subtotal` | Subtotal row. |
| `discount` | `pos.discount` | Discount row. |
| `tax` | `pos.tax` | Tax row. |
| `total` | `print.grandTotal` | Bold grand-total row. |
| `serviceCharge` | `receipt.serviceCharge` | Persisted service-charge row. |
| `deliveryCharge` | `pos.delivery` | Persisted delivery-charge row. |
| `packagingCharge` | `pos.packaging` | Persisted packaging-charge row. |
| `taxIncluded` | `receipt.taxIncluded` | Tax-inclusive pricing note. |
| `footerThanks` | `print.thankYouShort` | Default footer when no configured footer note applies. |

Each id maps to a concept in the generated print-label catalog, so an override replaces the
localized default for that concept rather than inventing a new string that nothing else can
translate.

### Resolution order

Each label resolves in three steps, first hit wins:

1. The pack's structural author string, for example `totals.grandTotalLabel`.
2. The matching entry in the payload's `labels` map.
3. The built-in default, localized through the print-label catalog in the receipt's language.

### Install-time validation

`validateTemplateLabelsMap()` in `main/print/template-labels.ts` fails closed. It rejects the pack
install when:

- `labels` is present and is not a plain object. An array is rejected.
- The map has more than `TEMPLATE_LABELS_MAX_ENTRIES`, which is 64, entries.
- A key is not one of the eleven ids above.
- A value is not a non-empty string, or is longer than `TEMPLATE_LABELS_MAX_VALUE_LENGTH`, which is
  120, characters.

`validateTemplateChargeRows()` applies the same fail-closed treatment to `totals.chargeRows`: a
non-array, an unknown id, or a duplicate id rejects the install.

### Render-time handling

The install-time caps do not replace render-time hardening, because a row stored before a cap
existed, or edited directly in a database, can still hold arbitrary text. At render time
`resolveTemplateLabel()` and `fitTemplateLabel()`:

- Strip reserved printer control tokens. `sanitizeTemplateLabelText()` removes anything matching
  `\{[A-Z_/]+\}`, which covers `{CUT}`, `{FEED}`, `{INIT}`, and the styling braces.
- Clamp to the selected width profile's column count. Below 4 columns the text is sliced to exactly
  that many characters; above that it keeps `columns - 2` characters and appends `..`, so the
  truncation is visible. Shipped profiles have column counts from 32 to 48.

The renderer version stays 1. The `labels` map is additive and optional, so a pack without it
renders identically on old and new app versions.

## Width profile selection

`collectTemplateWidthProfiles()` keeps only profiles whose `columns` is an integer from 32 to 48 and
sorts them ascending. `selectTemplateWidthProfile()` then picks, in order:

1. A profile whose `columns` exactly equals the printer's column count.
2. The largest profile narrower than the printer, so a template authored at 42 columns still
   renders on 48-column hardware without being stretched.
3. No profile match: render with the printer's own width and an empty layout, and push a
   `bill_template_width` warning naming the requested width. FloCafe does not squeeze a wider
   authored profile into a narrower printer.

## Renderer gate

`renderPluginReceipt()` refuses any installed template whose `renderer.id` is not
`flocafe-thermal-receipt-template`, whose `renderer.version` is not 1, or whose payload `format` is
not `escpos-line-template-v1`. Anything else throws rather than falling through to a different
renderer, so a malformed pack fails loudly instead of printing a receipt with a layout nobody
reviewed.

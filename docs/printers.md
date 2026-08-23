# Printer setup

FloCafe prints receipts and kitchen order tickets from the desktop app. Configure printers in **Settings → Printers**, then use **Test Print** before service.

## Connection types

| Type | Use it for | What you need |
| --- | --- | --- |
| Network | Receipt or kitchen printers on the local network | Printer IP address and port; most ESC/POS printers use port `9100` |
| USB / OS Queue | Direct USB printers and OS-managed printer queues | Direct USB connection or a configured OS print queue (Windows Spooler or CUPS) |
| WebUSB | A browser-connected printer | A compatible browser and a user-selected device; the browser sends the print bytes |

Set the paper width to match the printer: 58 mm or 80 mm. The first configured printer becomes the default; choose another default in Settings when a different printer should receive ordinary receipts. If no hardware printer is configured, FloCafe automatically falls back to system print when printing bills.

## Arabic and Persian text

In **Settings → Printers**, enable **Printer supports Arabic/Persian shaping** only for a thermal printer whose firmware performs Arabic/Persian contextual shaping and bidirectional ordering. With this setting enabled, receipt, tax-bill, and kitchen-ticket lines containing Arabic or Persian text are sent to the printer for it to shape; the setting is off by default for generic ESC/POS hardware. Without it, unsupported lines are skipped instead of being sent as garbled bytes, and FloCafe displays a warning after printing. Lines that also contain another unsupported script remain skipped.

## Receipt and kitchen-ticket languages

Receipt labels (invoice title, bill number, date, totals, payment methods) and kitchen-ticket labels are resolved from the tenant's language configuration at print time:

- **Receipts** follow the tenant **language** setting combined with the stored `bill_language_policy` (`inherit` follows the store language; `fixed` pins one configured language; an optional second `additional` language is carried on the document for future bilingual layouts). Tenants whose language is fa or es receive localized receipt labels end-to-end.
- **Kitchen tickets** resolve their label language independently through the stored `kot_language_policy`. A fixed kitchen language (for example English) keeps tickets in that language even when the storefront runs in another language.
- Invalid or missing policy values always fall back to the store language; printing never fails because of a malformed policy.

Lines the printer cannot render under the script rules above are skipped with an explicit warning — content is never silently dropped. The printed document itself carries every line plus its text direction, so direction-aware layouts (right-to-left base with left-to-right amounts and order numbers) can be expressed by any renderer without changing the underlying data.

## Kitchen printing

FloCafe can print kitchen order tickets to the default printer or route items to configured kitchen stations. A station needs an active printer and the product categories it handles. Items without a matching station fall back to the default kitchen route.

KOT printing can be disabled for the business. When it is disabled, neither automatic nor manual KOT print requests are sent.

## Troubleshooting

### Quick checks

1. Use **Settings → Printers → Test Print** to verify printer connectivity before live service.
2. Ensure FloCafe's local API and network printers are confined to your private business network.

### Network printers

- Confirm FloCafe's machine can reach the printer on the trusted/local business network.
- Verify the printer's IP address has not changed (check your router's DHCP lease table or configure a static IP / DHCP reservation).
- Verify the configured port (default ESC/POS port is usually `9100`).

### Windows USB & spooler printers

FloCafe sends raw ESC/POS byte streams directly to the Windows print queue, bypassing the printer driver. This requires the queue's *Print Processor* to be set to `winprint` with datatype `RAW`.

Manufacturer driver packages (such as Epson APD or Star) often install GDI graphics drivers that register proprietary print processors or reject raw byte streams. If prints fail or print garbled output:

1. Right-click the printer in Windows → **Printer Properties → Advanced tab → Print Processor** → confirm it is set to `winprint` with datatype `RAW`.
2. If issues persist, reinstall the printer using Windows' built-in **"Generic / Text Only"** driver (or the manufacturer's dedicated raw/ESC-POS mode).
3. Re-select the printer in FloCafe's printer settings, as renaming or reinstalling changes the stored queue identifier.

### macOS and Linux (CUPS) printers

- If a printer was unplugged, the CUPS print queue may be placed in a disabled/paused state. Re-enable the queue in your operating system printer settings; FloCafe will resume sending print jobs once the queue is active.
- For Linux USB permissions, ensure your user account is in the `lp` group (`sudo usermod -aG lp $USER`). See [Linux installation and support](linux.md#printing) for more details.

### Bluetooth & OS-paired printers

FloCafe does not manage standalone Bluetooth RFCOMM transport or discovery. To use a Bluetooth receipt printer, pair the device in your operating system so it registers as an active printer queue (via CUPS on macOS/Linux or Windows Print Spooler). FloCafe will then detect and dispatch print jobs through that OS-managed queue.

### WebUSB printers

WebUSB printers are paired through the POS toolbar in a supported browser. The saved printer entry retains formatting preferences, but browser permissions control physical device access.

### Diagnostic logs

If printing still fails:
1. Open **Help → Open Logs Folder** (or check `main.log`).
2. Search for lines starting with `[Printer]` around the time of the failure to find the exact error code or stage.
3. If opening an issue, include the `[Printer]` log snippet, your OS, printer make/model, connection type, and paper width.

## Country-pack compliance receipt templates (`escpos-line-template-v1`)

Signed country tax packs can ship compliance receipt templates that render through FloCafe's built-in ESC/POS line renderer (`renderEscposLineTemplateV1`, renderer id `flocafe-thermal-receipt-template`).

> **Status: legacy/compliance-oriented.** `escpos-line-template-v1` exists to keep signed, jurisdiction-specific compliance receipts working. It is **not** the future merchant/community template format — that is the semantic merchant model tracked in [#447](https://github.com/FreeOpenSourcePOS/FloCafe/issues/447). Do not build merchant-facing template features on this contract.

### Payload fields

| Field | Type | Required | Behavior |
| --- | --- | --- | --- |
| `format` | `"escpos-line-template-v1"` | yes | Contract identifier; must match exactly |
| `widthProfiles` | array | yes | Per-printer-width column layouts (32–48 columns); at least one profile must cover each declared `paperColumns` width |
| `header` | object | no | Optional author strings: `businessNameTransform` (`uppercase`), `taxTitleWhenTaxPresent`, `titleWhenTaxAbsent` |
| `fields.taxRegistrationNumberLabel` | string | no | Author label for the tax registration line |
| `totals.grandTotalLabel` | string | no | Author label for the bold grand-total row |
| `totals.showSubtotal`, `totals.showDiscount` | boolean | no | Toggle subtotal/discount rows (default on) |
| `totals.showTaxRegistrationNumber` | string | no | `when_tax_present_or_enabled` or default visibility rule |
| `footer.defaultMessage` | string | no | Author footer message used when no configured footer note applies |
| `footer.useConfiguredFooterNote` | boolean | no | Prefer the merchant's configured footer note (default on) |
| `footer.includePoweredByFloPOS` | boolean | no | Append the FloPOS branding footer (default on) |
| `labels` | object | no | Optional map of semantic label id → override string, see below (#445) |

Unknown fields are tolerated at render time so older app versions keep rendering newer signed packs.

### The optional `labels` map (#445)

Packs may ship a payload-root `labels` map to override built-in fallback labels with their own copy:

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

Supported semantic ids (stable public identifiers — never internal i18n keys): `invoice`, `taxInvoice`, `subtotal`, `discount`, `tax`, `total`, `taxIncluded`, `footerThanks`. Once shipped, an id never changes meaning.

Resolution order for each label: the pack's structural author string (for example `totals.grandTotalLabel`) wins first, then the matching `labels` entry, then the built-in default localized through the canonical print-labels catalog using the receipt language. English defaults are byte-identical to the pre-#445 hardcoded strings.

Validation at install time is **fail-closed**: the map must be an object, contain at most 64 entries of known semantic ids, and every value must be a non-empty string of at most 120 characters. Violations reject the pack install with a clear error. At render time, labels are sanitized (reserved printer control tokens such as `{CUT}`, `{FEED}`, `{INIT}` and styling braces are stripped) and clamped/truncated to fit the selected column width profile (32–48 columns). Renderer version stays 1 — this field is additive and optional; packs without it render identically on old and new versions.

## API

The printer endpoints are documented in [API.md](API.md#printers). They cover configured printers, detection, supported profiles, test printing, receipt printing, and kitchen tickets.

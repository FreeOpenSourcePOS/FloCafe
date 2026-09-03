# Printer setup

FloCafe prints receipts and kitchen order tickets from the desktop app. Configure printers in **Settings → Printers**, then use **Test Print** before service.

> Contributors: for the print pipeline architecture (shared kernel, PrintDocument model, renderer/transport map, language policy, testing guide) see [printing-architecture.md](printing-architecture.md).

## Connection types

| Type | Use it for | What you need |
| --- | --- | --- |
| Network | Receipt or kitchen printers on the local network | Printer IP address and port; most ESC/POS printers use port `9100` |
| USB / OS Queue | Direct USB printers and OS-managed printer queues | Direct USB connection or a configured OS print queue (Windows Spooler or CUPS) |
| WebUSB | A browser-connected printer | A compatible browser and a user-selected device; the browser sends the print bytes |

Set the paper width to match the printer: 58 mm or 80 mm. The first configured printer becomes the default; choose another default in Settings when a different printer should receive ordinary receipts. If no hardware printer is configured, FloCafe automatically falls back to system print when printing bills.

Enable **Open cash drawer on checkout** on a receipt printer only when a till is connected to that printer's drawer-kick port. When enabled, FloCafe appends the standard ESC/POS drawer pulse to printed receipt jobs for that printer.

## Arabic and Persian text

In **Settings → Printers**, enable **Printer supports Arabic/Persian shaping** only for a thermal printer whose firmware performs Arabic/Persian contextual shaping and bidirectional ordering. With this setting enabled, receipt, tax-bill, and kitchen-ticket lines containing Arabic or Persian text are sent to the printer for it to shape; the setting is off by default for generic ESC/POS hardware. On document-driven and signed country-pack ESC/POS receipt paths, guarded unsupported non-financial text is skipped with a warning, while an unsupported item or financial row refuses the receipt before transport with an explicit operator warning. See [printing-architecture.md](printing-architecture.md) for the exact warning contract, direct-write exceptions, and legacy WebUSB encoder behavior.

## Receipt and kitchen-ticket languages

On policy-aware paths, receipt labels (invoice title, bill number, date, totals, payment methods) and kitchen-ticket labels are resolved from the tenant's language configuration. During authenticated POS bootstrap, FloCafe loads the bundles selected by the receipt and kitchen-ticket policies before releasing the dashboard, so the first print does not depend on visiting Settings. If a bundle cannot load, the app surfaces an actionable error and the print warning reports any English fallback explicitly. The detailed language, fallback, and warning contracts live in [printing-architecture.md](printing-architecture.md).

- **Receipts** on the document-driven thermal and browser paths follow the tenant **language** setting combined with the stored `bill_language_policy`.
- **Kitchen tickets** resolve their label language independently through the stored `kot_language_policy` across backend, browser, and WebUSB paths.
- **Tax bills** on the legacy WebUSB print-test path use the resolved print language for labels.
- See [printing-architecture.md §4](printing-architecture.md#4-language-behavior) for policy resolution and [§6](printing-architecture.md#6-printer-capability-model--warning-semantics) for transport fallbacks, KOT metadata visibility, raw dates, and financial-row refusal.
- For policy-aware paths, invalid or missing policy values always fall back to the store language; printing never fails because of a malformed policy.

For shared document-driven behavior, including non-financial warnings, financial-row refusal, direction handling, language policy, and legacy exceptions, see [printing-architecture.md](printing-architecture.md). Current ESC/POS renderers do not consume `DirectionalText.direction` or implement bidi/LTR-island handling ([`main/printers/thermal.ts`](../main/printers/thermal.ts)), so direction-aware ESC/POS output remains unsupported/future.

For the full study of non-Latin script support on thermal printers — including the recommended raster fallback architecture, community hardware-test checklist, and open decisions — see [printing-nonlatin-capabilities.md](printing-nonlatin-capabilities.md).

## Kitchen printing

FloCafe can print kitchen order tickets to the default printer or route items to configured kitchen stations. A station needs an active printer and the product categories it handles. Items without a matching station fall back to the default kitchen route.

KOT printing can be disabled for the business. When it is disabled, neither automatic nor manual KOT print requests are sent.

## Troubleshooting

### Quick checks

1. Use **Settings → Printers → Test Print** to verify printer connectivity before live service.
2. Ensure FloCafe's local API and network printers are confined to your private business network.

### Adding a printer manually by name

FloCafe dispatches USB/OS-queue print jobs by sending the printer's exact name to the OS (`lp -d <name>` on macOS/Linux, `OpenPrinterW` on Windows) — there is no fuzzy matching. If a printer isn't found by **Settings → Printers → Detect**, use **Add Manually**, but the name must match the OS print queue identifier exactly, not just what appears to be the printer's name on your desktop:

- Prefer picking the name from the autocomplete list under the name field (sourced from the same detection FloCafe uses) over typing it by hand.
- On macOS/Linux, the CUPS queue name can differ from the display name shown in System Settings (for example, spaces are sometimes replaced with underscores). Check the exact queue name with `lpstat -p` in a terminal.
- On Windows, check **Settings → Printers & scanners** for the exact printer name, including any suffix like `(Copy 1)`.
- If you rename or reinstall the printer at the OS level later, its queue identifier can change — re-add or edit the printer in FloCafe with the new name.

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

WebUSB printers are paired through the POS toolbar's **Connect** button, in the desktop app or in a supported browser. The saved printer entry retains formatting preferences, but browser (or, in the desktop app, Electron) permissions control physical device access. If more than one matching USB device is connected at once, the desktop app connects to the first one it finds — using a single USB thermal printer per terminal is the supported configuration. The connection is re-established automatically on the next app start once granted; if the printer isn't detected after a fresh install or a permissions reset, click **Connect** again to re-grant access.

### Diagnostic logs

If printing still fails:
1. Open **Help → Open Logs Folder** (or check `main.log`).
2. Search for lines starting with `[Printer]` around the time of the failure to find the exact error code or stage.
3. If opening an issue, include the `[Printer]` log snippet, your OS, printer make/model, connection type, and paper width.

## Country-pack compliance receipt templates (`escpos-line-template-v1`)

Signed country tax packs can ship compliance receipt templates that render through FloCafe's built-in ESC/POS line renderer (`renderEscposLineTemplateV1`, renderer id `flocafe-thermal-receipt-template`).

> **Status: legacy/compliance-oriented.** `escpos-line-template-v1` exists to keep signed, jurisdiction-specific compliance receipts working. It is **not** the merchant-facing template format; see the current [merchant print template model](merchant-print-templates.md). Do not build merchant-facing template features on this contract.

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

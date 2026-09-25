# Printer setup

FloCafe prints receipts and kitchen order tickets from the desktop app. Configure printers in
**Settings > Printers**, then use **Test Print** before service.

> For how the print pipeline is put together, see
> [the printing architecture](architecture/printing.md). For validating a physical printer before
> you rely on it, see [testing printers](guides/testing-printers.md). For authoring compliance
> receipt templates that ship inside a signed tax pack, see
> [the compliance template contract](reference/print-templates-compliance.md).

## Connection types

| Type | Use it for | What you need |
| --- | --- | --- |
| Network | Receipt or kitchen printers on the local network | Printer IP address and port; most ESC/POS printers use port `9100` |
| USB / OS Queue | Direct USB printers and OS-managed print queues | A direct USB connection or a configured OS print queue (Windows Spooler or CUPS) |
| WebUSB | A browser-connected printer | A compatible browser and a user-selected device; the browser sends the print bytes |

Set the paper width to match the printer, either 58 mm or 80 mm. The first configured printer
becomes the default; choose a different default in Settings when another printer should receive
ordinary receipts. If no hardware printer is configured, FloCafe falls back to system print when
printing bills.

Enable **Open cash drawer on checkout** on a receipt printer only when a till is connected to that
printer's drawer-kick port. When enabled, FloCafe appends the standard ESC/POS drawer pulse to
printed receipt jobs for that printer, and only for payment methods on the drawer's allowlist.

## Printer profiles and paper width

FloCafe resolves a printer to a capability profile in three steps, in order:

1. An explicitly selected profile id on the configured printer, if one is set.
2. A match against the printer's name, make, or model. Matching is a case-insensitive substring
   test against each profile's make, model, and alias list, in profile order.
3. The paper width, which selects a generic profile: `58mm` selects the 58 mm generic, anything
   else selects the 80 mm generic.

Four profiles ship. Detection does **not** return the generic profile for everything: a name
containing an Xprinter XP-V320M or XP-V330M, or a string containing `v320m` or `v330m`, resolves
to the Xprinter profile. A name containing `epson tm`, `tm-t88`, `tm-t82`, `tm-t20`, or `tm-m30`
resolves to the Epson TM series profile. Only a name that matches nothing falls through to the
generic profile chosen by paper width.

The generic profiles are the conservative ones. They are ASCII-only, with no text shaping, and
they skip unsupported non-financial text with a warning but **refuse** a receipt whose financial
rows contain unsupported text, reporting `Receipt not printed: a financial row contains unsupported
printer text`. The Xprinter and Epson profiles add the Latin code pages and Latin script
representability on top of that. All four shipped profiles enable the capability-gated raster
path; what differs is encoding and script coverage.

If a receipt is refused because of unsupported text in a financial row, check the resolved profile
before changing anything else. A printer set to the generic profile when it should be an Xprinter
or Epson is the usual cause.

## Arabic-script text

In **Settings > Printers**, enable **Printer supports Arabic/Persian shaping** only for a thermal
printer whose firmware performs Arabic-script contextual shaping and bidirectional ordering for
Arabic, Persian, or Urdu text. With this setting enabled, receipt, tax-bill, and kitchen-ticket
lines containing those scripts are sent to the printer for it to shape. The setting is off by
default, which is correct for generic ESC/POS hardware.

A validated printer profile may also enable the capability-gated raster path, which uses an
isolated Chromium renderer and bundled local fonts for content the printer cannot shape itself.
Profile capability is what enables it; a locale never does.

On the document-driven thermal and browser paths, unsupported non-financial text is skipped with a
warning, while an unsupported item row or financial row refuses the receipt before transport with
an explicit operator warning. The exact warning contract and the direct-write exceptions are in
[the printing architecture](architecture/printing.md).

## Receipt and kitchen-ticket languages

Receipt labels (invoice title, bill number, date, totals, payment methods) and kitchen-ticket labels
are resolved from the tenant's language configuration. During authenticated POS bootstrap, FloCafe
loads the bundles selected by the receipt and kitchen-ticket policies before releasing the
dashboard, so the first print does not depend on visiting Settings. If a bundle cannot load, the
app surfaces an actionable error and the print warning reports any English fallback explicitly.

- **Receipts** on the document-driven thermal and browser paths follow the tenant **language**
  setting combined with the stored `bill_language_policy`.
- **Kitchen tickets** resolve their label language independently through the stored
  `kot_language_policy`, across the backend, browser, and WebUSB paths.
- **Tax bills** on the legacy WebUSB print-test path use the resolved print language for labels.
- On policy-aware paths, an invalid or missing policy value falls back to the store language.
  Printing never fails because of a malformed policy.

The language and fallback contracts are in [the printing architecture](architecture/printing.md).
Language-specific script and print constraints are in the
[translation terminology reference](reference/translation-terminology.md).

## Kitchen printing

FloCafe can print kitchen order tickets to the default printer or route items to configured kitchen
stations. Configure stations under **Settings > Operations > Kitchen Stations**, whether or not KDS
is enabled. Each category can belong to only one active station, and the station editor separates
categories selected for the current station, categories still available, and categories assigned
elsewhere. Selecting a category from another station moves it to the current station when saved.
Each station maps its categories to any configured FloCafe printer.

When KDS is enabled, a station can be assigned to multiple active chef accounts for shift coverage.
An assigned chef's KDS view is limited to their assigned stations and categories. A Chef account
can be linked to one or more stations from the Staff form. A chef created without a station remains
unrestricted by station.

Items in categories without a station use the read-only **DEFAULT > Printer Name** route shown with
the station list, and print on the default kitchen printer.

KOT printing can be disabled for the business. When it is disabled, neither automatic nor manual KOT
print requests are sent.

## Troubleshooting

### Quick checks

1. Use **Settings > Printers > Test Print** to verify printer connectivity before live service.
2. Keep FloCafe's local API and network printers confined to your private business network. The
   local API is unencrypted; see
   [authentication and authorization](architecture/authentication-and-authorization.md).

### Adding a printer manually by name

FloCafe dispatches USB and OS-queue print jobs by sending the printer's exact name to the OS
(`lp -d <name>` on macOS and Linux, `OpenPrinterW` on Windows). There is no fuzzy matching. If a
printer is not found by **Settings > Printers > Detect**, use **Add Manually**, but the name must
match the OS print queue identifier exactly, not just the printer's name on your desktop.

- Prefer picking the name from the autocomplete list under the name field, which is sourced from the
  same detection FloCafe uses, over typing it by hand.
- On macOS and Linux, the CUPS queue name can differ from the display name shown in system
  settings, because spaces are sometimes replaced with underscores. Check the exact queue name with
  `lpstat -p`.
- On Windows, check **Settings > Printers & scanners** for the exact printer name, including a
  suffix like `(Copy 1)`.
- If you rename or reinstall the printer at the OS level, its queue identifier can change. Re-add or
  edit the printer in FloCafe with the new name.

### Network printers

- Confirm the FloCafe machine can reach the printer on the trusted local business network.
- Verify the printer's IP address has not changed. Check your router's DHCP lease table, or configure
  a static IP or DHCP reservation.
- Verify the configured port. The default for ESC/POS printers is `9100`.

### Windows USB and spooler printers

FloCafe sends raw ESC/POS byte streams directly to the Windows print queue, bypassing the printer
driver. This requires the queue's print processor to be set to `winprint` with datatype `RAW`.

Manufacturer driver packages often install GDI graphics drivers that register proprietary print
processors or reject raw byte streams. If prints fail or come out garbled:

1. Right-click the printer in Windows, open **Printer Properties > Advanced**, and confirm the
   print processor is `winprint` with datatype `RAW`.
2. If issues persist, reinstall the printer using the Windows built-in **Generic / Text Only**
   driver, or the manufacturer's dedicated raw ESC/POS mode.
3. Re-select the printer in FloCafe's printer settings, because renaming or reinstalling changes
   the stored queue identifier.

### macOS and Linux CUPS printers

- If a printer was unplugged, the CUPS print queue may be in a disabled or paused state. Re-enable
  the queue in your operating system printer settings; FloCafe resumes sending print jobs once the
  queue is active.
- For Linux USB permissions, ensure your user account is in the `lp` group. See
  [Linux installation and support](linux.md#printing).

### Bluetooth and OS-paired printers

FloCafe does not manage standalone Bluetooth RFCOMM transport or discovery. To use a Bluetooth
receipt printer, pair the device in your operating system so it registers as an active printer queue
through CUPS on macOS and Linux, or the Windows Print Spooler. FloCafe detects and dispatches print
jobs through that OS-managed queue.

### WebUSB printers

WebUSB printers are paired through the POS toolbar's **Connect** button, in the desktop app or in a
supported browser. The saved printer entry retains formatting preferences, but browser permissions,
or Electron permissions in the desktop app, control physical device access. If more than one matching
USB device is connected at once, the desktop app connects to the first one it finds, so a single USB
thermal printer per terminal is the supported configuration. The connection is re-established
automatically on the next app start once granted. If the printer is not detected after a fresh
install or a permissions reset, click **Connect** again to re-grant access.

### Diagnostic logs

If printing still fails:

1. Open **Help > Open Logs Folder**, or check `main.log`.
2. Search for lines starting with `[Printer]` around the time of the failure to find the exact error
   code or stage.
3. If you are opening an issue, include the `[Printer]` log snippet, your OS, printer make and model,
   connection type, and paper width.

## API

The printer endpoints are in the [API reference](reference/api.md). They cover configured printers,
detection, supported profiles, test printing, receipt printing, and kitchen tickets.

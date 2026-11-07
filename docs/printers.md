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
| USB / OS Queue | Direct USB printers and OS-managed print queues | A configured OS print queue (Windows Spooler, or CUPS via **System Settings > Printers & Scanners** on macOS including Mac App Store builds) |
| WebUSB | A browser-connected printer | A compatible browser and a user-selected device; the browser sends the print bytes |

Set the paper width to match the printer, either 58 mm or 80 mm. The first configured printer
becomes the default; choose a different default in Settings when another printer should receive
ordinary receipts. Keep **Print Method** set to **ESCPOS (USB / Network Thermal Printer)** for
USB, Network, and WebUSB receipt printers; **Browser Print (any printer)** opens the browser print
dialog instead. If no hardware printer is configured, FloCafe falls back to system print when
printing bills.

Set **Text size** per printer to Normal, Large, or Extra large when printed text is hard to read.
It applies to the kitchen tickets, delivery slips, and bills sent to that printer across ESC/POS
(USB, Network, and WebUSB) and Browser Print. On ESC/POS, Large doubles the character height and
keeps the same number of characters per line, while Extra large doubles height and width so lines
hold half as many characters and wrap sooner; on Browser Print, Large and Extra large scale the
thermal receipt, kitchen-ticket, and delivery-slip font sizes and weights. Existing printers stay on
Normal, which prints as before.

Enable **Open cash drawer on checkout** on a receipt printer only when a till is connected to that
printer's drawer-kick port. When enabled, FloCafe appends the standard ESC/POS drawer pulse to
printed receipt jobs for that printer, and only for payment methods on the drawer's allowlist.

## Receipt logos

Upload a browser-supported image (PNG, JPEG, WebP, BMP, GIF, SVG, AVIF, or ICO, up to 5 MB) under
**Settings > General > Store Logo**. FloCafe trims surrounding margins, normalizes contrast, builds
a monochrome thermal preview alongside the uploaded logo, and enables **Store Logo** automatically
when you save. You can toggle **Store Logo** independently in **Settings > Printers > Bill Content**.
Browser bills center the logo above the business header. See the
[printing architecture](architecture/printing.md#receipt-logos) for the renderer details.

## Menu printing

From **Products** or **POS**, open **Print Menu** and choose a destination before printing:

- **Receipt printer** sends the menu to a configured printer. Choose the printer and its 58 mm or
  80 mm roll width.
- **Paper** opens the system print dialog for A4 or Letter paper.
- **PDF** saves a structured PDF through the desktop save dialog. In a browser, use **Save as PDF**
  in the system print dialog instead.
- **Publish to QR Menu** generates a customer-facing PDF and replaces the store's existing public
  Google Drive menu without changing its QR link.

Paper, PDF, and QR output support Mobile-First Cafe, Classic Bistro, and Standard templates plus an
optional product-photo toggle. The dialog also lets you filter which products and details appear.
The QR Menu tab in Settings can instead upload a custom PDF, pause or resume public sharing,
download a 1024 px QR PNG, and print an A5 tabletop card. See the
[printing architecture](architecture/printing.md#menu-catalog-printing) for how each destination is
rendered.

## Printer profiles and paper width

When adding or editing a printer in **Settings > Printers**, choose a **Printer Type / Profile** or
leave it on **Auto-detect from printer name**, and set the printable column width (`32`, `42`, or
`48` columns). Selecting a profile sets its default column width unless you override it manually.
The `76mm Impact / Dot-Matrix (Epson TM-U220, Bixolon SRP-275)` profile (`escpos-impact-76`) uses
32-column text mode and omits bitmap logos, QR graphics, and raster bands.

When **Settings > Printers** detects OS queues that do not accept raw ESC/POS commands (such as Star
`TSP100` / `TSP143` / `SP700` / `mC-Print`, Epson `EcoTank` / `WorkForce` / `Stylus` inkjets, label
printers, and PDF queues), it marks them **Driver / Browser print only** and offers a **Use Browser
Print** button instead of adding them as raw thermal printers.

For the shipped profile table, profile resolution order, native code-page vs.
[raster printing](architecture/printing.md#raster-printing) capabilities, and
[financial-row refusal](architecture/printing.md#capabilities-and-refusal), see
[printer profiles](architecture/printing.md#printer-profiles).

## Arabic-script text

In **Settings > Printers**, enable **Printer supports Arabic/Persian shaping** only for a thermal
printer whose firmware performs Arabic-script contextual shaping and bidirectional ordering for
Arabic, Persian, or Urdu text. With this setting enabled, receipt, tax-bill, and kitchen-ticket
lines containing those scripts are sent to the printer for it to shape. The setting is off by
default, which is correct for generic ESC/POS hardware.

A validated printer profile may also enable the capability-gated raster path, which uses an
isolated Chromium renderer and bundled local fonts for content the printer cannot shape itself.
Profile capability is what enables it; a locale never does.

When neither firmware shaping nor raster rendering is available, unsupported non-financial text is
skipped with a warning and an unsupported financial row refuses the receipt before transport; see
[capabilities and refusal](architecture/printing.md#capabilities-and-refusal).

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
elsewhere, with an **All categories (including new ones)** toggle (`category_ids: []`) when no
specific categories are selected. Selecting a category from another station moves it to the current
station when saved. Each station maps its categories to any configured FloCafe printer, and `routeItemsToStations` in
`main/routes/printers.ts` resolves each item's station in precedence order: first an active station
explicitly assigned to the item's category/subcategory, second an active station assigned to the
item's parent category, and third the first active unrestricted station (`category_ids: []`) with a
configured non-WebUSB printer.

When KDS is enabled, a station can be assigned to multiple active chef accounts for shift coverage,
and leaving a station's category selection empty makes that station unrestricted on KDS; see
[KDS category and station scoping](reference/api.md#kds-category-and-station-scoping). A Chef
account can be linked to one or more stations from the Staff form, and a chef created without a
station remains unrestricted by station.

Items that do not match an explicit category station, an inherited parent category station, or an
unrestricted station with a printer use the read-only **DEFAULT > Printer Name** route shown with
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

FloCafe dispatches USB and OS-queue print jobs by sending the printer's exact queue name to the OS
(CUPS on macOS and Linux, or the Windows Print Spooler; see
[Transports](architecture/printing.md#transports)). There is no fuzzy matching. If a
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

- On macOS (including the Mac App Store build), USB receipt printers must first be added in
  **System Settings > Printers & Scanners** before FloCafe can detect or print to them. Connect the
  USB printer, click **Add Printer, Scanner, or Fax...**, and select the manufacturer's driver or a
  generic queue (**Generic PostScript Printer** or **Generic PCL Printer**); FloCafe sends raw
  ESC/POS bytes through CUPS and bypasses macOS page filters (see
  [Transports](architecture/printing.md#transports)). Once the queue is added in macOS, click
  **Detect** in **Settings > Printers** and select the detected queue so the printer name in FloCafe
  matches the CUPS queue name.
- When no matching CUPS queue exists (for example, before the USB printer is added in **System
  Settings > Printers & Scanners** or when a manual name does not match the CUPS queue identifier),
  CUPS returns `client-error-not-found` (`0x0406`) and FloCafe reports `Printer queue "<name>" was
  not found in macOS Printers & Scanners` (`failureClass: not_configured`).
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
   code or stage (for example, `[Printer] IPP print queued for "<name>" (job <id>)` or
   `[Printer] IPP print failed for "<name>"`). On macOS and Linux, also check `/var/log/cups/error_log`
   and `/var/log/cups/access_log` for CUPS daemon diagnostics.
3. If you are opening an issue, include the `[Printer]` log snippet, your OS, printer make and model,
   connection type, and paper width.

## API

The printer endpoints are in the [API reference](reference/api.md). They cover configured printers,
detection, supported profiles, test printing, receipt printing, and kitchen tickets.

# Testing printers against hardware

The automated suites prove the print pipeline's logic: chunking, capability checks, document
building, template validation. They cannot prove that a particular printer on a particular counter
cuts the paper at the right place. That needs a person standing at the machine.

This guide is a procedure, not a report. Fill in the report template at the end with what you
observed.

Run the software suites before touching hardware, so a hardware failure is not actually a logic
failure:

```sh
npm run test:print-kernel
npm run test:print-parity
npm run test:print-labels
npm run test:thermal-capabilities
npm run test:merchant-print-templates
npm run test:raster
```

## Which profile applies to a printer

`main/printers/profiles.ts` ships four profiles: `xprinter-xp-v320m-v330m`, `epson-tm-series`,
`generic-escpos-80`, and `generic-escpos-58`. A printer with no matching profile is not
unsupported; it runs on one of the two generic profiles, chosen by paper width.

To determine which profile a printer actually resolves to:

1. In FloCafe, open **Settings -> Printers**, add the printer, and save it.
2. Read the resolved `profile_id` from the stored printer row, or call the profile listing endpoint
   that the printer settings page uses.
3. If it resolved to a generic profile but you expected a specific one, the name did not match any
   alias. `matchSupportedPrinterProfile()` substring-matches the lower-cased make, model, and alias
   list, so the stored name has to contain one of the profile's tokens. Recording the name string
   you entered is part of the report.

Every profile declares raster capability. The 58 mm profile declares 384 dots of width; the other
three declare 576.

## Test 1: chunked network printing

Network printing sends data in 4096-byte chunks with a 10 ms delay between them
(`NETWORK_PRINT_CHUNK_SIZE` and `NETWORK_PRINT_CHUNK_DELAY_MS` in `main/printers/thermal.ts`), and
a payload at or under the chunk size is sent in one write. What the chunking protects against is a
printer that drops bytes when a large receipt arrives faster than it can accept them.

### Procedure

1. Configure the printer with a network connection type and its host address.
2. Print a receipt with enough item lines to exceed 4096 bytes. Roughly 60 to 80 item lines
   produces a payload comfortably over that.
3. Print again with a short receipt of a few lines, to exercise the single-write path.
4. Repeat the large print three times, without closing the app between them.

### Pass criteria

- The large receipt prints completely: no truncated final line, no dropped middle lines, no garbled
  characters, and the paper cut lands after the last line.
- The short receipt prints completely.
- All four prints succeed with no error toast and no `[Printer]` error in the log.

### If it fails

Check the log for a socket error. A partial print on a large receipt with a clean small print is the
signature of a printer that cannot absorb the inter-chunk rate; note the printer's buffer size and
report it, do not raise the chunk delay as a workaround in the field.

## Test 2: spooler safety

The Windows path shells out to PowerShell and the CUPS path to `lp`. Their stderr can contain
device names, share paths, and user names. `sanitizePowerShellStderr()` strips the PowerShell CLIXML
wrapper and decodes `_xHHHH_` escapes, and `classifyPrintFailure()` reduces the remainder to a
stable class. What must never reach the merchant-facing error, the log, or telemetry is the raw
stderr.

### Procedure

1. Configure a printer that will fail, so the transport returns an error. A CUPS queue that is
   paused, or a Windows printer that is offline, is enough.
2. Trigger a print from the POS and from **Help -> Print test page**.
3. Read the error as the merchant sees it in the toast.
4. Read the same failure in the log and in the classified failure the dispatch returned.
5. Use a printer name that would identify a specific machine, for example `FRONTDESK-LASER-01`, so a
   leak would be obvious.

### Pass criteria

- The merchant-facing error names the failure in plain language and does not contain the printer
  name, the queue name, a file path, or a user name.
- The log entry and the reported failure class carry the classification, not the raw stderr.
- The failure class is the expected one: `offline` for a disconnected printer, `queue_unavailable`
  for a paused or unavailable queue, `spooler_error` for a spooler-level failure.

## Test 3: financial-row refusal

A receipt whose financial row contains text the printer cannot represent must be refused in full,
not printed with a substituted value. The refusal message is fixed.

### Procedure

1. Give the store a bill that renders an unrepresentable character on a financial row. The simplest
   case is an order or customer name in a script the profile cannot represent that reaches a total
   line, on a profile whose capabilities are ASCII only.
2. Attempt to print the receipt on the thermal printer.
3. Attempt the same receipt through system or browser printing.

### Pass criteria

- The thermal attempt fails and shows: `Receipt not printed: a financial row contains unsupported
  printer text:` followed by the offending text.
- No partial receipt reaches the paper. A total that does not match the real total is worse than no
  receipt.
- The non-financial variant of the same content, such as a note or an address line, prints with the
  unrepresentable text skipped, because the capability policy skips non-financial rows and refuses
  financial ones.
- System or browser printing still produces a receipt, so the merchant has a fallback.

## Test 4: kitchen ticket routing

A kitchen ticket carries no tax breakdown, and an item that has left the kitchen must not reappear
on a reprint. `isKotItemPending()` in `shared/print/document.ts` filters out `served` and `ready`.

### Procedure

1. Assign the printer's kitchen station and category scope in **Settings -> Printers**, and confirm
   the scope is narrower than the full menu.
2. Place an order containing items inside and outside the station's scope.
3. Print the kitchen ticket.
4. Mark one item `ready` and one `served`, then reprint the kitchen ticket.
5. Trigger a second kitchen ticket for the same order.

### Pass criteria

- The first ticket shows only the in-scope items.
- The reprint omits the `ready` and `served` items and still shows the untouched ones.
- The ticket shows no monetary totals and no tax breakdown.
- The second ticket contains only items still in a pre-ready state.

## The raster diagnostic probe

`buildRasterDiagnosticBands()` in `shared/print/raster.ts` builds a banded bit pattern for checking
a printer's raster path: an inset horizontal band with an 8-dot margin on each side, a checkerboard
on an 8-dot grid, and a solid 24-dot band. Each pattern is emitted as a sequence of bands no taller
than the profile's `raster.maxBandHeight`, so a receipt taller than one band is still printable.
Every emitted band is validated before it is returned.

**The probe is not reachable from the UI.** The `rasterProbe` request-body flag on a printer route
in `main/routes/printers.ts` is the only reference to it in the repository. No renderer sends it
and no test covers it. Record a result for it only if you invoke the route directly; do not report
it as a merchant-reachable feature.

## Report template

Copy this into an issue. Fill every field; an unfilled field is a reason the result cannot be
acted on.

```markdown
### Printer hardware test

- **Date:** YYYY-MM-DD
- **Tester:**
- **Platform and version:** e.g. Ubuntu 24.04, FloCafe 3.x.y
- **Printer make and model:**
- **Connection type:** network / CUPS / USB / Windows / WebUSB
- **Paper width:** e.g. 80mm, 42 columns
- **Resolved profile id:**
- **Name entered in FloCafe:**

| Test | Result | Notes |
| --- | --- | --- |
| Chunked network printing | pass / fail / not run | |
| Spooler safety | pass / fail / not run | |
| Financial-row refusal | pass / fail / not run | |
| KOT routing | pass / fail / not run | |
| Raster diagnostic probe | pass / fail / not run / not reachable | |

**Log excerpts:** the `[Printer]` lines around any failure.

**Observed behaviour:** what the paper actually showed, for every failure.
```

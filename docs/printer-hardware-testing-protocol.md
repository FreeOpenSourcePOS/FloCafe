# Printer hardware validation matrix & testing protocol

Status: CURRENT

This protocol defines the physical hardware testing matrix, operating procedures, and acceptance criteria for validating thermal and impact POS printers with FloCafe desktop across all supported platforms (Windows, macOS, Linux).

---

## 1. Scope & objectives

Physical validation ensures that real-world thermal printers reliably handle:
1. **Network transports (TCP Port 9100)** without socket buffer exhaustion or microcontroller buffer overruns on large raster or multilingual payloads.
2. **USB & OS Spooler transports** (Windows Spooler RAW jobs, macOS/Linux CUPS raw queues) without driver truncation or garbled CLIXML serialization.
3. **Multilingual and multi-script encoding** (Latin accents, Persian/Arabic RTL shaping, and CJK system rasterization).
4. **Financial row safety and operator clarity** (proper refusal of unencodable currency/items and clear toast error presentation).

---

## 2. Hardware test matrix

| Category | Representative models | Interfaces | Paper width | Tested scenarios |
|---|---|---|---|---|
| **Tier 1: Industry standard** | Epson TM-T88VI, TM-T20III, Star TSP143III | Network (TCP 9100), USB (Spooler / CUPS) | 80 mm | Baseline Latin text, drawer kick pulse, raster logos, network throttling |
| **Tier 2: High-volume budget** | Xprinter XP-N160I, XP-Q90EC, POS-58 / ZJ-58 clones | USB (Spooler / CUPS), Network | 58 mm / 80 mm | 4KB chunking buffer overrun verification, Chinese text, 42/48 col wrapping |
| **Tier 3: Specialized RTL / Regional** | Meva TP-UN, Sewoo WTP-100, Bixolon SRP-350 | Network, USB | 80 mm | Arabic/Persian shaping (`capabilities.shaping.arabic`), right-to-left layout |

---

## 3. Test execution protocol

### Test 1: Baseline connectivity & diagnostic test page
1. Navigate to **Settings → Printers**.
2. Add the target printer (via **Detect** or **Add Manually** with exact OS queue name or IP/Port).
3. Set appropriate paper width (`58 mm` or `80 mm`).
4. Click **Test Print**.
- **Pass criteria:**
  - Printer emits header, 32/42/48-column alignment rulers matching physical paper edges.
  - Receipt cuts cleanly (full or partial cut as configured).
  - Cash drawer behavior is not exercised by **Test Print**; validate drawer pulse during an actual checkout using a payment method configured to trigger it when **Open cash drawer on checkout** is enabled.

### Test 2: Large buffer network throttling (Raster / Multilingual)
1. Configure a network thermal printer (`<IP>:9100`).
2. Trigger a mixed-mode or large raster print job (>10KB payload, e.g. receipt with store logo or non-Latin items).
- **Pass criteria:**
  - Data streams in 4096-byte slices with 10ms pacing delay.
  - Microcontroller buffer does not overrun: no missing scanlines, no mid-receipt truncation, no garbled ASCII escape codes.

### Test 3: Windows PowerShell spooler error sanitization
1. On a Windows test machine, configure an invalid or offline printer queue name in Settings.
2. Trigger **Test Print** or order checkout receipt print.
- **Pass criteria:**
  - UI displays clean error message (e.g. `Receipt print failed (The printer name is invalid)` or `The RPC server is unavailable`).
  - No raw `#< CLIXML` tags or XML entities (`&quot;`, `_x000D__x000A_`) appear in the cashier toast notification.

### Test 4: Financial row safety & refusal
1. Configure a generic ASCII-only printer profile.
2. Create an order with an unrepresentable currency symbol or product name (e.g. `€` on an ASCII profile or unsupported Cyrillic/Persian on an unshaped profile).
3. Complete checkout.
- **Pass criteria:**
  - Print operation refuses before transport: `Receipt not printed: a financial row contains unsupported printer text`.
  - Exactly one descriptive error toast is presented (no duplicate popups).
  - Financial invariant preserved: the paid transaction record is recorded in the database, but no blank, partial, or corrupted paper receipt is emitted to the customer. Subsequent reprints from Orders also cleanly refuse until a capable printer/template is selected.

### Test 5: Kitchen order ticket (KOT) routing
1. Configure a Kitchen Station printer mapped to specific food categories. Ensure at least one category remains unassigned to any station.
2. Place an order containing mixed items: assigned station items (e.g., drinks for Bar, hot meals for Kitchen) and unassigned items (e.g., snacks or merchandise).
- **Pass criteria:**
  - Station printer emits only its assigned category items.
  - Unassigned category items route and print exactly once on the default kitchen printer route.
  - KOT title and metadata (table number, order number, timestamp) render cleanly in the configured `kot_language_policy`.

---

## 4. Hardware test report submission

When validating physical hardware, record results using this template and attach photographic evidence:

```markdown
### Hardware Test Report

- **Date:** YYYY-MM-DD
- **Tester:** @username
- **Printer Make / Model:** e.g., Xprinter XP-N160I
- **Firmware Version (if known):**
- **Connection Interface:** Network (TCP 9100) / USB Spooler / CUPS / WebUSB
- **Host OS & Architecture:** Windows 11 (x64) / macOS 15 (arm64) / Ubuntu 24.04 (x64)
- **Paper Width:** 58mm / 80mm
- **Configured Profile:** generic-escpos-58 / generic-escpos-80 / custom

#### Checkpoints
- [ ] 1. Test Print emits clean alignment ruler to paper margins
- [ ] 2. Cash drawer pulse triggers on checkout with configured payment method
- [ ] 3. Large raster / multi-language payload prints without dropped lines or stutter
- [ ] 4. Offline / disconnected printer yields actionable toast message (no CLIXML / raw stack)
- [ ] 5. Unsupported financial items safely refuse printing with clear operator toast
- [ ] 6. KOT station routing emits assigned categories to stations and unassigned items to default route
- [ ] 7. Photo(s) of physical receipts attached

#### Observations / Quirks
(Note any model-specific density offsets, cutter feed margins, or timing considerations here)
```

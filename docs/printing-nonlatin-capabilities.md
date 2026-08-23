# Non-Latin thermal receipt printing — capability study and decision record

**Refs:** #446 (research issue) · epic #438
**Status of this document:** Study and decision record. It describes a *recommended* target architecture that is **not yet implemented**; production renderers are unchanged. Any prototype or dependency adoption requires separate review (see Section 8, *Open decisions*).

---

## 1. Problem

Raw thermal printing of Persian/Arabic — and non-Latin scripts generally — currently degrades to a stopgap: a per-profile `arabicShaping` passthrough plus skip-with-warning behavior.

Current code (verified at the time of writing):

| Location | Behavior |
| --- | --- |
| `main/printers/profiles.ts` (`SupportedPrinterProfile.arabicShaping`) | Profile flag declaring firmware Arabic shaping; unset/false on all four shipped profiles. |
| `main/printers/thermal.ts` (`buildEscPos`) | Lines whose non-currency content is not ASCII are skipped with a warning, unless `arabicShaping` passes the strict Arabic-only rule. |
| `frontend/src/lib/printer/warnings.ts` (`safePrinterText`, `isArabicShapingSafeLine`) | Browser/WebUSB encoders mirror the same guard so both paths degrade identically. |
| `shared/print/direction.ts` | Direction model: per-document/block/value direction with conservative LTR-island classification (`isLtrIsland`, `containsRtlScript`). |

Why generic ESC/POS printers fail non-Latin text:

1. **Missing glyphs.** Cheap 58 mm / 80 mm clones carry small font ROMs covering CP437/CP850-class sets. Arabic, Hebrew, Devanagari, Thai, and CJK glyphs are absent, so bytes print as garbage or blank.
2. **No contextual shaping.** Arabic/Persian requires contextual letter forms; printer firmware renders isolated forms at best.
3. **No bidirectional reordering.** Printers emit left-to-right only; logical-order RTL text prints reversed.
4. **Code pages do not save us** (evidence below).

The end-state contract from epic #438 is **no silent data loss**: native render, explicitly supported fallback, or an explicit warning/error — never quiet omission of financial content.

## 2. Method

- Code paths above were read directly; line-level references reflect the state after #443/#473/#474/#472 landed.
- External evidence: Epson's official ESC/POS command reference, the ReceiptPrinterEncoder/escpos-php/python-escpos/node-thermal-printer issue trackers, Odoo's IoT printer driver source, and qzind/tray. Links inline.
- First-class user requirements come from real reports by @MaMaDTHUG82 (Iran, Meva TP-UN hardware): #437, #241, discussions #239/#326.

## 3. Approach comparison

### 3.1 Printer-native Arabic/Persian shaping (the `arabicShaping` profile flag)

The flag means: *this specific printer's firmware performs contextual shaping and bidi ordering*. It must stay default-off and be set true only after a real print on the specific hardware proves shaped output. Reality:

- Generic ESC/POS firmware does none of this. Even on models that accept Arabic bytes, output is isolated forms printed left-to-right unless the host pre-shapes and pre-reverses.
- The qzind/tray experience (Epson TM-T88VI + vendor utility + ICU mapping down to IBM864 with byte swapping) shows even best-case native support is model-specific and fragile ([ReceiptPrinterEncoder issue #26](https://github.com/NielsLeenheer/ReceiptPrinterEncoder/issues/26)).

**Verdict:** keep as an opt-in passthrough tier for proven hardware only. Not a general solution.

### 3.2 Printer-native code pages (CP1256 / CP720 / CP864 / kanji modes)

- Epson's reference states the `FS &` kanji mode *"can be used only for the Japanese, Simplified Chinese, Traditional Chinese models, and Korean models"* — regional firmware variants our users do not own ([Epson ESC/POS reference](https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/fs_ampersand.html)).
- Arabic code pages contain base/isolated glyph forms only → visibly broken letters for native readers; right-to-left ordering is still the host's problem.
- Table identity ≠ glyph layout across vendors; unmappable characters silently become `?` (iconv-lite translation in [node-thermal-printer PR #81](https://github.com/Klemen1337/node-thermal-printer/pull/81); [ReceiptPrinterEncoder #26](https://github.com/NielsLeenheer/ReceiptPrinterEncoder/issues/26)).

**Verdict:** dead end for quality; unmaintainable across clone vendors.

### 3.3 UTF-8 pass-through

Some modern firmware accepts raw multi-byte UTF-8 against internal fonts. Coverage and shaping vary per model and revision; there is no discovery mechanism, and cheap clones fail unpredictably. Useful as a *reported capability* on the hardware test matrix (Section 6), never as an assumed baseline.

### 3.4 Host-side shaping + bidi reordering before emission

Send pre-shaped presentation forms (Unicode Arabic Presentation Forms-B) in visual order as text bytes.

| Criterion | Assessment |
| --- | --- |
| Printer requirement | Printer must accept multi-byte UTF-8 **and** have glyphs for the shaped codepoints. Cheap clones fail both — shaped Arabic arrives as U+FE7x–U+FExx which their font ROMs lack. |
| Fidelity | Correct *when* glyphs exist; host must reverse visual order itself. |
| Mixed-script rows | Hard: visual-order strings break column math and truncation (cutting visual order cuts the logical start). The kernel's LTR-island model helps alignment, not truncation. |
| Dependency footprint | Lightweight tier exists: `bidi-js` (~20 kB pure JS) plus an Arabic reshaper covers Arabic/Hebrew receipts. Full HarfBuzz via WASM (`harfbuzzjs`, subset build ≈ 613 kB) is only needed for complex Indic/Khmer conjuncts. |

**Verdict:** a *necessary component* of any non-Latin pipeline (something must produce correctly shaped, ordered pixels), but **insufficient alone** — it does not reach printers without the glyphs.

### 3.5 Raster rendering (`GS v 0`)

Render the receipt (or parts) to a 1-bit bitmap and print it with `GS v 0 m xL xH yL yH`.

- `GS v 0` is the mechanism every printer uses for logos; it is implemented across the entire ESC/POS clone ecosystem, including the cheapest hardware. Density mode `m=0` (8 dots/mm both axes) matches standard 203 dpi receipt heads.
- Reference implementation scale test: Odoo's IoT box converts every receipt image to greyscale → 1-bit → `GS v 0` → cut ([odoo/odoo `PrinterDriver.print_receipt`](https://github.com/odoo/odoo/blob/master/addons/iot_drivers/iot_handlers/drivers/printer_driver.py)); their commit replacing the old ESC/POS text encoder states: *"We now transform the receipts to JPGs, transform these JPGs into ESCPOS commands and send them via Cups."* This runs across one of the largest heterogeneous open-source POS fleets in existence.

| Criterion | Assessment |
| --- | --- |
| Printer requirement | Effectively universal (logo path). |
| Fidelity | Pixel-exact for any script, digits, mixed-direction rows, logos. Shaping/bidi correctness becomes whatever the host canvas draws — the browser/canvas applies the Unicode bidi algorithm natively. |
| Mixed-script correctness | Trivial: no column math on RTL text; truncation becomes measured pixel width with ellipsis. |
| Performance | Payload grows from ~1–2 KB (text receipt) to ≈ 72 B × ~1150 dot rows ≈ 80 KB (80 mm) / ≈ 55 KB (58 mm). Transfer over TCP 9100 / USB bulk is sub-second; head time is unchanged because the same paper area prints either way. Slow MCUs on clones can stutter on very large single images — solved by banding (Section 5). |
| Paper width / density | Requires dots-per-line knowledge: 384 (58 mm) vs 576 (80 mm) at 203 dpi. Derivable from the existing paper-width profile data. |
| Transport support | Identical byte stream on TCP, USB RAW queues, and WebUSB — it is ordinary bytes after init. OS spooler RAW pass-through is proven by Odoo/CUPS. No WebUSB-specific work. |
| Package size impact | None at the protocol layer. Cost lives in the host rendering engine and bundled script fonts (a dependency question — see Section 8). |
| Maintenance burden | One renderer consuming the semantic print kernel; new scripts become font additions, not logic changes. |
| Failure/fallback mode | Falls back to today's exact behavior (native attempt + explicit warning). Never worse than status quo. |

**Verdict:** the only approach satisfying "universal system that supports ALL printers".

### 3.6 HTML/browser fallback

The browser print path already renders every script correctly (the browser does shaping and bidi). It remains a steering target when raw printing is unacceptable, but it cannot serve instant raw-cut workflows, KOT station routing, or spooler-free checkout speed. Out of scope for further comparison.

### 3.7 Criteria matrix summary

| Approach | Works on cheap clones | Correct Arabic/Persian | Mixed rows | Transport coverage | Extra deps | Failure mode |
| --- | --- | --- | --- | --- | --- | --- |
| Native shaping flag | ✗ rare | ✓ only on proven units | partial | all | none | garbled/skip |
| Native code pages | ✗ | ✗ isolated forms | ✗ | all | none | garbage, `?` |
| UTF-8 pass-through | varies | varies | varies | all | none | mojibake |
| Host shaping + bidi text | ✗ (glyph gap) | partial | hard | all | small | blank/garbage |
| **Raster `GS v 0`** | **✓** | **✓** | **✓** | **all raw transports** | rendering engine (Section 8) | falls back to skip+warn |

## 4. What other systems do

| System | Multilingual receipt strategy | Evidence |
| --- | --- | --- |
| Odoo POS (IoT box) | Whole-receipt raster for everything; old ESC/POS text encoder retired | [`PrinterDriver.print_receipt` source](https://github.com/odoo/odoo/blob/master/addons/iot_drivers/iot_handlers/drivers/printer_driver.py), [hw_escpos replacement commit](https://github.com/odoo/odoo/commit/03b2f7b77dc6189bb485e0b834dba5f6d3d4da2c) |
| escpos-php | Unicode→code-page auto-mapping; official Arabic example renders **images** instead of text lines | [Arabic example](https://github.com/mike42/escpos-php/blob/master/example/specific/6-arabic-epos-tep-220m.php) |
| python-escpos | Exposes charcode selection only; recurring Arabic mojibake issues resolved by users switching to raster | [#37](https://github.com/python-escpos/python-escpos/issues/37), [#633](https://github.com/python-escpos/python-escpos/issues/633) |
| node-thermal-printer | iconv-lite code-page translation; shaping/bidi unsupported; Arabic/Thai requests open for years | [PR #81](https://github.com/Klemen1337/node-thermal-printer/pull/81), [#180](https://github.com/Klemen1337/node-thermal-printer/issues/180) |
| ReceiptPrinterEncoder | Maintainer guidance: proper Arabic printing = draw a bitmap | [#26](https://github.com/NielsLeenheer/ReceiptPrinterEncoder/issues/26) |
| Loyverse | Prints through manufacturer SDKs, which render bitmaps internally on mobile | [supported printers](https://help.loyverse.com/help/supported-printers) |
| qzind/tray | ICU-based host shaping down to IBM864 + byte swap; author notes most projects give up and send rasters | [PR #339 discussion](https://github.com/qzind/tray/pull/339#issuecomment-404016953) |

Consensus: host-rendered bitmaps are the universal fallback; code pages are a dead end for Arabic/Persian.

## 5. Recommended architecture (decision record)

**Primary approach: capability-tiered hybrid with raster as the universal guarantee.**

```
PrintDocument ──► renderer decides per line/block:
   Tier 1  Pure Latin/ASCII            → native ESC/POS text (unchanged bytes, fastest)
   Tier 2  Non-Latin + profile proves
           firmware shaping            → existing arabicShaping passthrough (semantics unchanged)
   Tier 3  Everything else             → host-shaped, bidi-correct RASTER band(s) via GS v 0
                                         [mixed mode; default for non-Latin content]
   Tier 4  Whole-receipt raster        → opt-in compatibility toggle / fallback if mixed
                                         mode misbehaves on specific hardware
   Tier 5  Skip-with-warning           → retained last resort; never silent
```

Per transport: identical strategy everywhere — TCP 9100, USB RAW, and WebUSB all move the same byte stream. The browser HTML path needs nothing.

Migration implications for the legacy skip-with-warning path: once raster is proven on real hardware, tiers shift upward (skipped lines become raster bands); skip-with-warning remains the terminal fallback when raster is disabled or fails, preserving the no-silent-data-loss contract.

Integration notes for the future implementation crew (descriptive, no code changed by this document):

- A raster renderer is another consumer of the shared print kernel (`shared/print/document.ts`), like the existing classic/compact/KOT/merchant renderers; it receives semantic blocks, not business truth.
- The natural seam is the line-emission guard in the backend encoder and its frontend mirror (`safePrinterText`): doomed lines convert to raster bands instead of warnings.
- Capability flags belong on `SupportedPrinterProfile` alongside `arabicShaping` (for example a raster-support flag and dots-per-line derived from paper width), consistent with epic principle 8.
- Bundled open script fonts (Noto family subsets) satisfy offline-first principle 1 — no remote fonts.

Risks and mitigations:

| Risk | Mitigation |
| --- | --- |
| Print speed on slow MCU clones | Band images into ≤ ~200-dot-row strips; mixed mode keeps most of a typical Persian receipt native text. |
| Low-end printer memory | Same banding; Odoo ships whole-image raster across a huge fleet, so residual risk is low. |
| Density/DPI variance | Derive dots-per-line from paper width; verify visually via the test-page raster probe (Section 7). Avoid `m≠0` density modes until hardware-proven. |
| Cutter position | Existing feed-before-cut sequence retained (Odoo likewise uses feed + partial cut). |
| Baseline mismatch between native text lines and raster bands | Render bands at multiples of the 24-dot Font A line height; emulate double width/height by scaling pixels. |
| RTL truncation/column math | Disappears inside raster bands (pixel-measured ellipsis); kernel island logic continues to govern native-text alignment. |
| Regression risk for English receipts | Tier 1 keeps current byte streams; parity tests assert ASCII byte-identity (extends the #439 harness). |

## 6. Community hardware-test matrix checklist

Owners of real printers: run this checklist and report results (issue comment or discussion post) with a photo of each printout. One row per printer model.

```
Printer model:            Connection:      network / usb / webusb
Paper width:              58mm / 80mm      Firmware date (if known):

[ ] 1. ASCII text receipt prints cleanly (baseline)
[ ] 2. Test page prints; column ruler aligns to paper edges
[ ] 3. UTF-8 pass-through: paste of "فارسی Hello עברית ไทย हिन्दी"
       prints as…  correct / reversed / boxes / blank / garbage
[ ] 4. Code page probe (if the app exposes it): CP1256 result ___
[ ] 5. Firmware Arabic shaping probe: unshaped-but-reversed Persian
       looks connected?  yes / no
[ ] 6. Raster probe (test page band, Section 7): prints?  yes / no
[ ] 7. Raster width: solid bar spans full width except the small
       designed inset (~1mm/side)?  full / shrunk / clipped
[ ] 8. Banded raster (multi-strip image): continuous, no gaps/stutter?
[ ] 9. Mixed sample: Latin text lines + Persian raster lines interleave
       at consistent line height?
[ ] 10. Cut position correct after raster tail?  full / partial / failed
[ ] 11. Timing: text receipt ___ s ; raster receipt ___ s
[ ] 12. Photo(s) attached
```

Seed validators: @MaMaDTHUG82 (Meva TP-UN, Iran — reporter of #437), plus FloCafe customers in Morocco and India. Priority unknowns: whether budget clones handle banded `GS v 0` without stutter (expected yes), and which models mishandle non-default density modes.

## 7. Test-page raster probe specification

A future test-page enhancement (flag-gated; **not part of this change**) adds a diagnostic band so remote users can validate raster support with a single photo:

1. After the existing ruler/edge-probe section, emit a solid black rectangle: `widthDots - 16` dots wide, 48 dot rows tall, as one `GS v 0` band (`m=0`, xL/xH = `(widthBytes)` little-endian, yL/yH = 48 little-endian).
2. Follow with a second band containing inverted checkerboard (8×8 dot cells) to reveal dithering/density misconfiguration.
3. Emit a third band scaled to half height (24 rows) to expose vertical density mismatch (`m=0` assumes square dots at 203 dpi).
4. Close with the standard feed + cut sequence so cutter position is validated in the same printout.
5. Expected result on healthy hardware: crisp solid bar, uniform checkerboard, correct proportions, clean cut. Any band missing, skewed, or stretched indicates a raster/density defect to report in the checklist above.

Implementation note for that future change: reuse the profile-derived dots-per-line rather than hardcoding 384/576, and route through the same dispatch used by ordinary receipts so all transports are exercised.

## 8. Open decisions requiring a human call

- **Rendering-engine dependency** for the host side (needed by Tiers 3–4, evaluated separately per #446 rules; nothing was added to `package.json` in this change):
  - (a) canvas library in the Electron main process (full shaping + bidi via Skia; native binary weight);
  - (b) pure-JS stack: WASM-shaped HarfBuzz subset (~613 kB) + outline rasterization (zero native deps, most implementation effort);
  - (c) render in the renderer process over IPC (no new deps, coupling/latency cost).
- Whether Tier 4 whole-receipt raster should ship as a user-facing compatibility toggle from day one or remain internal fallback until telemetry justifies exposure.

## 9. References

- Epson ESC/POS command reference, `FS &`: <https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/fs_ampersand.html>
- ReceiptPrinterEncoder Arabic thread: <https://github.com/NielsLeenheer/ReceiptPrinterEncoder/issues/26>
- Odoo IoT printer driver: <https://github.com/odoo/odoo/blob/master/addons/iot_drivers/iot_handlers/drivers/printer_driver.py> · replacement rationale: <https://github.com/odoo/odoo/commit/03b2f7b77dc6189bb485e0b834dba5f6d3d4da2c>
- escpos-php Arabic example: <https://github.com/mike42/escpos-php/blob/master/example/specific/6-arabic-epos-tep-220m.php>
- node-thermal-printer code-page translation: <https://github.com/Klemen1337/node-thermal-printer/pull/81>
- python-escpos Arabic issues: <https://github.com/python-escpos/python-escpos/issues/37>, <https://github.com/python-escpos/python-escpos/issues/633>
- qzind/tray IBM864 approach: <https://github.com/qzind/tray/pull/339#issuecomment-404016953>
- Loyverse supported printers: <https://help.loyverse.com/help/supported-printers>
- FloCafe user cases: #437 (Persian items dropped from bills; Meva TP-UN), #241 (mixed-script bidi scramble example «برای شروع QR کد را اسکن کنید»; Persian digits/Toman/Shamsi preferences), discussions #239/#326.

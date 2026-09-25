# Thai language support: research, specification, and implementation record

Status: approved implementation record for `th` / `th-TH`.

## 1. Research report

### 1.1 Current localization architecture

FloCafe has 14 registered locales on the investigated base commit
`a42eb51d3ee660e259d713ad87b0ee3691feabed`. The addition follows that same
architecture rather than introducing a second localization system.

| Concern | Current owner and behavior |
| --- | --- |
| Canonical messages | `frontend/src/lib/i18n/messages/en.json` is the schema and translation source. It contains 2,639 non-empty string leaves. |
| Registry | `frontend/src/lib/i18n/languages.ts` owns language keys, BCP-47 tags, endonyms, direction, selectability, and lazy loaders. |
| Runtime loading | `frontend/src/lib/i18n/loader.ts` bundles English eagerly and code-splits every other locale behind deduplicated dynamic imports. |
| Fallback | English is the cold-boot and unknown-locale fallback. A failed active-locale load leaves the last successfully rendered locale active. |
| Browser detection | `getBrowserLanguage()` reduces `navigator.languages` with `Intl.Locale` and matches registered selectable primary language subtags. `th-TH` therefore resolves to `th` once registered. |
| Persistence | The active UI language is stored under the existing `pos-settings` Zustand persist key. The tenant copy is stored in the existing `settings.language` key. No schema change is needed. |
| Setup and runtime switching | Setup and General Settings derive their selectors from the central registry. Auth and tenant selection restore the stored language before the dashboard is released. |
| Standalone surfaces | KDS and Server App fetch the tenant language from their local public-info endpoint and pass it through the same registry and loader. Print locales selected by receipt/KOT policies are warmed during authenticated bootstrap. |
| Print labels | `scripts/generate-print-labels.cjs` reads the canonical registry and locale JSON files, then owns the committed derived file `main/print/print-labels.generated.ts`. Never edit the generated file directly. |
| Print policy validation | Frontend and backend policy parsers accept only registered, selectable codes. Regenerating the backend label table is what makes `th` a valid fixed print language. |
| Setup/demo data | `main/routes/auth.ts` maintains explicit seed catalogs. Every selectable non-Filipino language must localize Express and demo categories, products, customers, and staff names. |
| Validation | `npm run i18n:check` enforces registry/file consistency, exact leaf parity, valid ICU, variable/selector/tag parity, TypeScript key safety, Thai fallback safeguards, and generated-print drift. |
| Offline proof | A static export gives every non-English locale an independent packaged chunk. `npm run test:locale-chunks` requires that chunk to be unique, lazy, and free of external URLs. The service worker caches successful same-origin static assets after first use. |

Thai therefore does not imply Thailand as a store country. UI language,
tenant country/currency, tax rules, and business timezone remain independent.
Thailand already has a country profile (`TH`, `THB`, `Asia/Bangkok`), but
adding Thai must not select it or change any financial, tax, or phone behavior.

### 1.2 Thai script and locale findings

The smallest identifier consistent with the repository's ISO 639-style keys is
`th`. The matching BCP-47 locale is `th-TH`, the endonym is `ไทย`, and the
direction is `ltr`.

Thai is a left-to-right abugida. W3C's Thai requirements describe combining
vowel and tone signs, multipart vowels, and phrase rather than word spacing.
The important implementation consequences are:

- A visible Thai syllable can contain a base consonant plus combining marks,
  pre-base vowels, and decomposed vowel components. Code that slices arbitrary
  UTF-16 code units can detach marks or lose shaping.
- Browser UI and browser print should receive normal Unicode text plus a correct
  `lang` attribute. Chromium/Electron performs complex-script shaping and
  glyph fallback. Do not pre-shape or reorder Thai for browser output.
- FloCafe's isolated raster renderer already wraps by `Intl.Segmenter`
  grapheme clusters and measures the shaped canvas text. It must remain the
  measurement path for pixel output.
- The native display-cell helpers treat combining marks as zero-width and walk
  Unicode code points. That is adequate for conservative native capability
  decisions. Thai is not representable by the shipped ASCII/Latin ESC/POS code
  pages, so unsupported text is warned, skipped, or refused before native
  output rather than silently becoming broken Thai text.
- Thai wraps at browser-defined soft wrap opportunities. A visual smoke test
  is required for long setup, POS, receipt, and KOT strings; a locale addition
  does not justify adding a new line-breaking engine.
- CSS requires an accurate language declaration for language-specific
  typographic behavior. The existing `HtmlLangSync`, receipt HTML, and print
  locale paths already propagate the registry locale, so `lang="th-TH"` must
  appear during Thai rendering.

Relevant standards and references:

- W3C, *Requirements for Thai Script Layout and Features on the Web*:
  <https://www.w3.org/TR/thai-lreq/>. This is a draft Group Note and is used
  here as a research reference, not as a normative production contract.
- W3C, *CSS Text Module Level 3*:
  <https://www.w3.org/TR/css-text-3/>. It recommends accurate language tagging
  and defines grapheme-based typographic character units and normal wrapping.
- W3C, *Thai Script Layout Gap Analysis*:
  <https://www.w3.org/TR/thai-gap/>. It documents phrase spacing and remaining
  browser line-breaking edge cases.
- Google Fonts, *Noto Sans Thai*:
  <https://fonts.google.com/noto/specimen/Noto+Sans+Thai>. This confirms a
  purpose-built Thai family exists, but FloCafe will not add a font dependency
  or binary payload merely to register a locale.

### 1.3 Fonts, measurement, and wrapping decision

The application UI keeps the established `Geist, system-ui, sans-serif` model.
The browser and raster surfaces retain the existing Latin/CJK families and name
common installed Thai fallbacks (`Noto Sans Thai`, `Leelawadee UI`, and
`Thonburi`) without replacing an existing locale's primary font. This is a local
system-font fallback, not a remote font request.

No Thai font file is bundled because:

1. Recent CJK/Korean additions use platform fonts rather than adding large
   font packages.
2. Electron/Chromium already performs Thai glyph fallback and shaping.
3. A font binary would be a packaging, licensing, size, upgrade, and visual
   regression decision beyond locale registration.
4. Direct ESC/POS output cannot be made correct by a webfont. Its contract is
   printer capability plus explicit warning/refusal or a separately validated
   raster profile.

Raster rendering already uses `Intl.Segmenter` for grapheme-safe wrapping.
Browser receipt/KOT HTML already sets LTR direction, bounded width, and wrapping
CSS. Native Thai is not added to `ThermalScript`, no code page is claimed, and
`useUnicode` is not treated as proof of Thai glyph or shaping support.

### 1.4 Numbers, currency, dates, and terminology

Current Node/ICU behavior for `th-TH` is Latin digits, `,` grouping, `.`
decimal separator, and a `฿` prefix for THB. More importantly, FloCafe formats
monetary and plain numeric values from the tenant country locale, not from the
UI language. Thai UI therefore cannot alter THB, USD, INR, decimal grouping, or
stored values. A Thailand tenant continues to use the existing country profile.

Date presentation uses the tenant timezone and calendar, with the UI locale as
a language-name override. Thai month names are used where the existing locale
override applies; the calendar remains tenant-owned. No Thai-specific digit or
calendar setting is added.

The canonical POS glossary for this contribution is:

| English concept | Thai glossary term |
| --- | --- |
| POS / point of sale | ระบบ POS |
| order | คำสั่งซื้อ |
| bill / receipt | บิล / ใบเสร็จ |
| subtotal | ยอดรวมย่อย |
| grand total / amount due | ยอดรวมทั้งสิ้น / ยอดชำระ |
| payment | การชำระเงิน |
| cash | เงินสด |
| card | บัตร |
| customer | ลูกค้า |
| staff / employee | พนักงาน |
| owner / manager / cashier / server / chef | เจ้าของ / ผู้จัดการ / แคชเชียร์ / พนักงานเสิร์ฟ / พ่อครัว |
| product / category | สินค้า / หมวดหมู่ |
| add-on / modifier | ตัวเลือกเพิ่ม / ตัวปรับแต่งสินค้า |
| modifier group | กลุ่มตัวเลือกเพิ่ม |
| inventory | สินค้าคงคลัง |
| kitchen order ticket (KOT) | ใบสั่งอาหาร |
| kitchen / station | ครัว / สถานีครัว |
| dine in / takeaway / delivery / online | ทานที่ร้าน / กลับบ้าน / จัดส่ง / ออนไลน์ |
| discount / tax / service charge | ส่วนลด / ภาษี / ค่าบริการ |
| change | เงินทอน |
| refund / void | คืนเงิน / ยกเลิก |
| table / order type | โต๊ะ / ประเภทคำสั่งซื้อ |
| split bill | แยกบิล |
| vegetarian / non-vegetarian / vegan | มังสวิรัติ / ไม่มังสวิรัติ / วีกาน |
| save / cancel / delete / edit | บันทึก / ยกเลิก / ลบ / แก้ไข |
| username / password / PIN | ชื่อผู้ใช้ / รหัสผ่าน / PIN |

Brands and technical acronyms (`Flo`, `FloPOS`, `POS`, `KDS`, `SKU`, `PIN`,
`QR`, `API`, `CSV`, `XLSX`, `PDF`, `USB`, `ESC/POS`, `IP`, `URL`, `WhatsApp`)
remain unchanged. Thai translations must preserve every ICU argument, selector,
number sign, and tag from the canonical English leaf.

### 1.5 Printing boundary

Thai support is honest only when UI/browser and direct-print claims are kept
separate:

- **UI renderer:** Chromium shapes Thai using local system font fallback.
- **Browser/system print:** Full-Unicode HTML renders Thai. `th-TH` is emitted
  as the document locale, and common Thai font names are included as local
  fallbacks.
- **Raster ESC/POS:** The existing profile-owned mixed/whole-receipt path can
  shape via the isolated Chromium renderer, uses grapheme-safe measurement, and
  remains gated by printer profile and real hardware evidence. No new profile
  capability or printer claim is introduced.
- **Native text ESC/POS/WebUSB:** No shipped code page is declared to represent
  Thai. Unsupported non-financial text follows the warning path; unsupported
  financial content is refused before transport. `printerUseUnicode` is not a
  language capability.

This follows the current non-Latin printing decision record. Thai is an
abugida and requires glyph positioning, but it has no bidi reordering like
Arabic. Passing raw UTF-8 to an arbitrary clone is not a safe substitute for
font-backed raster output.

### 1.6 Security and privacy

The change introduces no network service, translation API, telemetry field,
credential, customer-data migration, or remote font dependency. The locale is a
static packaged JSON chunk. Existing owner/manager authorization continues to
protect language and print-policy writes. Setup/demo strings are newly created
sample data only.

### 1.7 Recent-addition evidence

Recent merged language work establishes the expected implementation inventory:

- Simplified Chinese added registry, message, seed, print-label generation,
  browser-print font fallbacks, docs, and maintained-language tests.
- Japanese followed with platform font fallbacks and complete print/test/docs
  inventory.
- Korean and Bahasa Indonesia added a language-specific fallback guard and
  explicit allowlist, then expanded every locale enumeration.
- Follow-up fixes corrected narrow terminology and high-impact wording:
  Chinese KOT wording, Korean modifier-group terminology, Italian Server App
  wording, Indonesian print labels, and Arabic receipt/seed terminology.

Therefore this change must update explicit test matrices and translation
safeguards, not only add JSON and a registry entry.

## 2. Concrete specification

### 2.1 Locale contract

- Registry key: `th`.
- Message file: `frontend/src/lib/i18n/messages/th.json`.
- BCP-47 presentation locale: `th-TH`.
- Endonym: `ไทย`.
- Direction: `ltr`.
- Selectable: `true`.
- Loader: `import('./messages/th.json')`.
- Exact leaf parity: 2,639 keys, with no missing or extra leaves.
- ICU contract: every variable, plural/select selector, number sign, and rich
  text tag matches English.
- No Thai values may be left as `[TH]`, `[TODO]`, or silently English-identical
  unless a narrow, documented brand/acronym/format allowlist entry exists.

### 2.2 Seed contract

Thai is not on `ENGLISH_IDENTICAL_SEED_LANGUAGES`. Express and demo fixtures
must include Thai labels for:

- food, beverages, meal, tea, coffee, and snack;
- starter/main/beverage/dessert categories;
- localized menu products;
- localized customer names;
- localized manager, cashier, and chef names.

Country-selected customer phone codes remain country-driven, not Thai-UI-driven.

### 2.3 Print contract

- `npm run generate:print-labels` creates the Thai backend derived table.
- Receipt, KOT, Z-report, and test-page labels resolve from the canonical Thai
  messages.
- Browser receipt/KOT paths render Thai with `th-TH`, LTR direction, installed
  Thai fallbacks, and grapheme-safe browser wrapping.
- Raster fallback includes Thai system font names and continues to use
  `Intl.Segmenter`.
- Direct ESC/POS tests assert Thai labels, explicit unsupported-line warnings, and
  native fallback behavior; they do not claim native Thai glyph support.

### 2.4 Data, regional, and compatibility contract

- No SQLite migration or destructive data operation.
- `settings.language = 'th'` and `pos-settings.language = 'th'` are accepted by
  existing persistence.
- No automatic country, currency, timezone, tax-pack, phone, calendar, or digit
  change.
- Existing installations remain valid; English remains the fallback.
- No package or API changes.

## 3. Implementation plan

1. Scaffold `th.json` with `npm run i18n:add -- th`, then translate every
   canonical leaf with the glossary above.
2. Register `th` in `frontend/src/lib/i18n/languages.ts`.
3. Extend the maintained-language fallback/placeholder validator and its
   negative fixtures in `tests/translations.test.ts`.
4. Add Thai Express/demo seed branches in `main/routes/auth.ts`.
5. Extend explicit locale matrices covering browser receipts, KOT/print
   regression, LTR direction, KDS/Server App, SSR date locale, setup/settings,
   print labels, and Phase 7 browser labels.
6. Add Thai system-font fallbacks to browser receipt/KOT and raster surfaces;
   preserve the existing grapheme segmenter.
7. Regenerate `main/print/print-labels.generated.ts` through its owner script.
8. Update the supported-language documentation in `README.md`,
   `CONTRIBUTING.md`, and `docs/i18n.md`.
9. Run focused localization, print, setup, and locale-loading suites; then run
   the repository minimums: `npm run lint`, `npm run build`,
   `npm run build:frontend`, and `npm run i18n:check`.
10. Run full `npm test` and browser E2E because this touches frontend,
    backend-generated print data, setup seeds, KDS/server surfaces, and print
    boundaries. Inspect the final diff and status before committing.

## 4. Challenge reviews

### 4.1 Product challenge

**Challenge:** Registering `th-TH` might accidentally turn Thai UI into a
Thailand tax/currency preset.

**Resolution:** Rejected. The approved product contract keeps UI language,
country, currency, calendar, digits, tax, and timezone independent. No country
profile or tax behavior is changed.

### 4.2 Engineering challenge

**Challenge:** A locale file and registry entry alone can look complete while
backend print policy validation, setup seeds, and explicit test matrices remain
English-only.

**Resolution:** The specification requires the complete owner-regenerated print
table, localized seed branch, fallback guard, and every relevant maintained
locale matrix. This follows recent merged additions and their follow-up fixes.

### 4.3 Thai typography challenge

**Challenge:** Counting Thai code units can split combining sequences, and
Thai has phrase spacing rather than spaces between every word.

**Resolution:** No Thai-specific line-breaking engine is added. The existing
`lang=th-TH` path delegates shaping/wrapping to Chromium. Raster measurement
remains grapheme-based through `Intl.Segmenter`. Long-string visual checks are
part of QA.

### 4.4 Printing challenge

**Challenge:** Calling UTF-8 ESC/POS "Thai support" would produce missing
glyphs, broken marks, or silent financial loss on common printers.

**Resolution:** Rejected. No native Thai capability is claimed. Browser output
is full Unicode; raster remains profile/hardware gated; native unsupported text
keeps the existing warning/refusal contract.

### 4.5 Font/offline challenge

**Challenge:** A remote webfont would violate offline operation, while bundling
a new Thai font would introduce a large packaging and licensing change.

**Resolution:** Use installed local font fallbacks and the existing Chromium
renderer. Do not fetch or bundle a new font in this locale task. The PR reports
the residual need for hardware/font evidence before claiming direct Thai
thermal support.

### 4.6 QA challenge

**Challenge:** Structural parity does not prove idiomatic Thai or absence of
wrong POS terms.

**Resolution:** Use a consistent domain glossary, review all high-impact
receipt/KOT/setup/roles/payment strings in context, exercise representative ICU
messages, visually inspect long Thai text, and run automated parity. Mechanical
validation cannot replace future native-speaker linguistic review; that residual
risk is explicit rather than hidden.

### 4.7 Security/privacy challenge

**Challenge:** A translation workflow could send product strings or introduce
runtime network dependencies.

**Resolution:** Use only repository-local static JSON and existing build tools.
No external translation service, remote font, credential, or customer data is
involved.

### 4.8 Release-risk challenge

**Challenge:** A new lazy chunk, generated backend table, and cross-cutting test
lists create a larger diff than a simple locale entry.

**Resolution:** Accept the complete maintained-language pattern because partial
registration would leave setup, print policies, and offline behavior
inconsistent. Keep the diff locale-specific, run full regression checks, and do
not change printer profiles, country/tax behavior, or persistence schemas.

## 5. Implementation and verification record

The implementation is present on `fm/flocafe-thai-language-support-r1`, rebased onto
`09f20937264ceb0158f34fd87ee76d0df5cf26e6` (22 pre-existing registered locales). The
research snapshot in section 1 remains the originally investigated commit
`a42eb51d3ee660e259d713ad87b0ee3691feabed`; the eight locale additions merged since then
changed no architectural surface this work depends on, and their shared fixes
(grapheme-safe print-width owner in `shared/print/width.ts`, generic
`Intl.Locale`-based `getBrowserLanguage()`, generated print labels) are reused rather
than reimplemented.

- `frontend/src/lib/i18n/messages/th.json` contains the complete 2,639-leaf Thai catalog.
- `frontend/src/lib/i18n/languages.ts` registers selectable `th` / `th-TH` / `ไทย` as LTR.
- `main/routes/auth.ts` localizes Express and demo seed data while preserving country-driven phone and regional behavior. Demo customer phones use E.164 `+66` numbers, matching the format every other seeded language uses.
- `main/print/print-labels.generated.ts` was regenerated with `node scripts/generate-print-labels.cjs`; it was not hand-edited, and `--check` reports no drift.
- Browser receipt, KOT, order-slip, raster, and `PrinterService` print-window font fallbacks include local Thai font families without adding a font file or network dependency. `PrinterService` needs its own list because `printViaBrowser` imports only `parsed.body.childNodes`, discarding the caller's `<head>` styles.
- Locale matrices, fallback guards, browser-visible print labels, SSR, KDS/Server App, raster, and Phase 7 setup coverage include Thai.

Validation completed against the rebased branch:

- `npm run i18n:check` - passed, including parity, ICU, key safety, Thai fallback, TypeScript, and print-label drift checks.
- `npm run lint` - passed with 0 errors; existing repository warnings remain.
- `npm run build` and `npm run build:frontend` - passed.
- `npm test` - passed, 0 failed.
- `CI=1 npx playwright test --project=chromium` (76 Chromium tests) - passed.
- `npm run test:print-labels`, `test:print-kernel`, `test:print-parity`, `test:print-document`, `test:receipt-printing`, `test:thermal-capabilities`, `test:raster`, `test:phase7-setup-i18n`, `test:locale-chunks`, `test:browser-receipts`, `test:decoupled-ui-locale`, `test:i18n-audit-remediations`, `test:issue-241-localized-errors`, `test:translations`, `test:rtl-foundation`, `test:rtl-setup-auth-settings`, `test:rtl-dashboard-pos-common`, `test:rtl-kds-server-whatsapp` - passed.
- Native ESC/POS and WebUSB fail-closed coverage for Thai is asserted in `tests/phase3-print-regressions.test.ts`: unsupported Thai lines raise a `line` warning and emit no Thai glyphs on either path.
- `git diff --check` and relative Markdown-link verification - passed.

Residual risks are intentional and explicit: native-speaker linguistic review is
still appropriate for POS terminology, local Thai font availability varies by
platform, and direct ESC/POS Thai glyph support remains hardware/font-evidence
gated. No printer profile, database schema, country, currency, timezone, tax,
or digit behavior is claimed to have changed.

Known unrelated pre-existing failure, not introduced by this branch and not wired
into any `package.json` script: `tests/issue-263-phone-normalization.test.ts` fails
three HTTP API tests (`business_phone`, `customers`, `whatsapp/send` return 400
where 201/503 are expected). Its `seedDemoRestaurant` cases, including the Thai
`+66` seeds, pass.

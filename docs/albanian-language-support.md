# Albanian language support research and delivery plan

Status: implemented research and delivery record for `fm/flocafe-albanian-language-support-r1`
Base reviewed: `c26fbf11bfa20bc6665ad68d1e07baea419590c1` (`origin/main`)
Locale identifier: `sq`
Locale tag: `sq-AL`
Native name: `Shqip`
Direction: LTR

## Research report

### Current localization architecture

FloCafe's active i18n path is repository-native and offline-first:

1. `frontend/src/lib/i18n/messages/en.json` is the canonical schema. At the reviewed base it contains 2,639 string leaves across 30 top-level namespaces, including 16 ICU plural messages.
2. `frontend/src/lib/i18n/languages.ts` is the single registry. Each entry owns the BCP-47 tag, native display name, direction, selectability, and dynamic import loader.
3. `frontend/src/lib/i18n/loader.ts` eagerly packages English and lazily loads, deduplicates, and caches every other locale. The frontend build emits each non-English message file as an independent local chunk. No runtime translation service is involved.
4. `frontend/src/lib/i18n/browser-language.ts` canonicalizes browser preferences with `Intl.Locale` and matches them against selectable registry entries. Registering `sq-AL` covers `sq-AL` and same-script regional `sq-*` preferences without an Albanian-specific branch.
5. `frontend/src/components/providers/I18nProvider.tsx` resolves a persisted language first, then the browser language, then English. A failed non-English load keeps the previous language and reports the error rather than silently rendering a partial locale.
6. `frontend/src/store/pos-settings.ts` persists the selected language in the local `pos-settings` Zustand store. The tenant `settings.language` value is the server-side source used by login, standalone KDS, and Server App synchronization.
7. `frontend/src/lib/i18n/server-language.ts` synchronizes standalone surfaces through the public server metadata endpoint. Registry membership is the acceptance boundary.
8. `scripts/i18n-add.cjs` atomically scaffolds a lowercase two- or three-letter registry identifier from English and refuses to overwrite an existing file. `sq` is valid under its lowercase ISO-style validation and `new Intl.Locale('sq').language === 'sq'`.
9. `npm run i18n:check` runs translation parity/ICU/tag/fallback checks, generated print-label drift checking, and the frontend TypeScript check. It is entirely offline.

### Locale decision

`sq` is the smallest identifier consistent with the repository's registry and scaffolding rules. The canonical tag `sq-AL` is valid and canonical in Node's `Intl.Locale` implementation. `Shqip` is the Albanian endonym. Albanian is left-to-right, so it gets `direction: 'ltr'` and requires no RTL CSS or mirroring changes.

Albania is already represented in the tenant country registry as `AL: { locale: 'sq-AL', currency: 'ALL', tz: 'Europe/Tirane' }`. UI language and country remain separate domains. This task does not change country selection, tax rules, currency storage, or destructive currency-reset behavior.

### Offline loading and persistence inventory

Adding the registry entry and `sq.json` automatically covers:

- Setup and Settings selectors, which derive their options from `LANGUAGES` and filter `selectable`.
- Browser-language detection for `sq-*` preferences.
- Local persisted language state and rollback on chunk-load failure.
- Authenticated dashboard, POS, setup, KDS, and Server App rendering.
- Standalone KDS and Server App language synchronization.
- Receipt, KOT, Z-report, and print-test language selectors, which use the same selectable registry.
- Frontend print-policy warming through `ensurePrintLanguagesLoaded` and bootstrap.

No new endpoint, cookie, database column, migration, or network request is required. The existing English fallback remains the only fallback for an unknown language or a failed locale load; a valid Albanian bundle is never allowed to leak raw keys.

### Seed and setup boundary

`main/routes/auth.ts` contains the existing `SeedLanguage` union and `resolveSeedLanguage` function. They control localized Express and demo seed data independently from the selected tenant country. Albanian adds a branch in that union/resolver plus localized seed labels for categories, products, customers, and staff names. Synthetic Albanian customers use full `+355` E.164 numbers, so country-independent phone normalization remains testable even when the selected store country is different. The country argument remains the source of regional settings.

`ENGLISH_IDENTICAL_SEED_LANGUAGES` remains `fil` only. Albanian seed data will be reviewed and non-identical for the demo/express paths, so it must not be added to that exception list.

### Backend, renderer, and print boundaries

The backend cannot import frontend loaders. The existing derived path is:

`frontend/src/lib/i18n/messages/*.json` -> `npm run generate:print-labels` -> `main/print/print-labels.generated.ts`.

The generator extracts the `print.*` namespace plus its audited borrowed-key manifest for every registry language. The generated list is also the backend's accepted fixed print-language set. Therefore the required print work is registry/message work plus regeneration, not a second Albanian print dictionary.

Frontend print rendering loads the locale bundle and resolves labels through the shared catalog. Backend thermal and document renderers use the generated catalog and their existing policy/direction/capability paths. Z-report and KOT policies are registry-derived, so Albanian becomes selectable for those surfaces without a policy redesign.

### Albanian text and measurement findings

Albanian uses the Latin script. The letters `Ë/ë` (U+00CB/U+00EB) and `Ç/ç` (U+00C7/U+00E7) are precomposed characters in the translations and remain in NFC form. The shared thermal width path now measures and wraps complete Unicode grapheme clusters through `Intl.Segmenter` with a combining-mark-aware fallback, so Albanian letters consume one display cell and are never split by code unit. Focused assertions cover measurement, truncation, and wrapping of `Ëmbëlsirë`; the existing shared tests also protect Arabic/Persian and CJK behavior.

The shipped Latin thermal fallback preserves established German transliteration and now maps Albanian `Ë -> E`, `ë -> e`, `Ç -> C`, and `ç -> c`. On a generic ASCII-only printer this keeps the established KOT fallback usable without claiming that every printer has Albanian glyphs. Unicode-capable, browser, and validated raster paths retain the original text where supported.

Thermal printers remain capability-driven. Albanian support does not turn on raster rendering, change printer profiles, or guarantee hardware glyph coverage. A real 58 mm/80 mm printer test remains an operational verification item. Unsupported native text must continue to warn or refuse according to the existing policy rather than silently disappearing.

### Numbers, currency, and dates

Node's CLDR-backed `sq-AL` behavior is:

- decimal separator: comma;
- grouping separator: a non-breaking or narrow space depending on runtime;
- native currency name: Albanian Lek;
- `ALL` narrow symbol in current Node: `Lekë`, normally after the amount;
- default currency precision: two fraction digits;
- cardinal plural categories: `one` and `other`, where `one` is `n = 1`;
- date and time presentation: Albanian month/day names.

The locale tag controls UI date/number presentation only. The store's country profile continues to control money and regional defaults. No hard-coded `Lekë`, `ALL`, decimal separator, or currency position is introduced into translations. Tests verify `Intl.NumberFormat('sq-AL')`, Albanian date names, and the existing `AL -> sq-AL / ALL / Europe/Tirane` country profile without changing backend currency logic.

### Terminology and POS glossary

The translation uses one Albanian glossary across UI, seed data, and print labels:

| English concept | Albanian term | Notes |
| --- | --- | --- |
| Albanian | Shqip | Endonym and registry name |
| invoice | Faturë | Document label; avoid claiming fiscal compliance |
| tax invoice | Faturë tatimore | UI label only |
| receipt / bill | Dëftesë | Use consistently for the customer document |
| order | Porosi | Standard hospitality term |
| kitchen | Kuzhina | POS/KDS term |
| kitchen ticket | Porosi kuzhine | Keeps KOT meaning clear |
| table | Tavolinë | POS table, not UI table only |
| customer | Klient | |
| staff/personnel | Staf | |
| owner | Pronar | |
| manager | Menaxher | |
| cashier | Arkëtar | |
| server/waiter | Shërbyes | Server App remains the product surface name |
| chef | Shef | |
| product | Produkt | |
| snack | Ushqim i lehtë | Standard expression for a light food/snack |
| item | Artikull | |
| category | Kategori | |
| addon | Shtesë | Consistent with `shtesë`/`shtesa` in product configuration |
| price | Çmim | |
| quantity | Sasi | |
| subtotal | Nëntotali | |
| total | Totali | |
| tax | Taksa | |
| discount | Zbritje | |
| payment | Pagesë | |
| cash | Cash | Common Albanian POS loanword |
| card | Kartë | |
| wallet | Portofel | |
| refund | Kthim i pagesës | UI action can use `Rimburso` |
| delivery | Dorëzim | |
| takeaway | Me vete | Short pickup label; use `porosi me vete` in phrases |
| dine in | Në lokal | |
| ready | Gati | |
| preparing | Po përgatitet | |
| served | Shërbyer | |
| settings | Cilësimet | |
| dashboard | Paneli | |
| report | Raport | |
| stock | Stok | |
| sales | Shitje | |
| currency | Monedhë | |
| country | Vend | |
| language | Gjuha / Gjuhë | Use `Gjuhë` for the language setting, `Gjuha` in prose |
| printer | Printer | Common technical loanword |
| receipt printer | Printeri i dëftesës | |
| tax ID | NID/NIPT | Use the product's existing generic label unless a country pack supplies one |

Official Albanian tax guidance uses `faturë`, `porosi`, and `përmbledhëse` in hospitality contexts. The UI will not make legal or fiscal claims beyond the canonical strings.

### Security and privacy review

Locale files are static, repository-committed UI text. Albanian introduces no new data flow, credential, secret, telemetry field, customer-data field, or network dependency. Translation authors must not translate or alter:

- API keys, tokens, URLs, email addresses, IP examples, ports, file extensions, or protocol names;
- currency codes, tax-pack identifiers, product IDs, or machine-readable enum values;
- placeholders, ICU selectors, or markup.

The existing telemetry and support strings must continue to describe the same privacy behavior. No customer data is added to seed data beyond the already synthetic demo names/phones.

### Complete language-addition inventory

Production and generated files:

- `frontend/src/lib/i18n/messages/sq.json` - new canonical Albanian leaf bundle.
- `frontend/src/lib/i18n/languages.ts` - `sq` registry entry and dynamic loader.
- `main/routes/auth.ts` - Albanian seed-language union, resolver, and localized seed branches.
- `main/print/print-labels.generated.ts` - generated only; never hand-edited.
- `shared/print/thermal-capabilities.ts` - targeted Albanian ASCII fallback map through the existing capability-owned transliteration path.

Tests and documentation:

- `tests/translations.test.ts` - Albanian parity/ICU/tag/English-fallback safeguards and negative fixtures.
- `tests/print-labels.test.ts` - explicit Albanian catalog/runtime assertions and derived-registry check remains authoritative.
- `tests/phase3-print-regressions.test.ts` - Albanian in the browser/backend/WebUSB KOT matrix, with only expected label assertions adjusted.
- `tests/phase6-locale-loading.test.ts` - registry-derived coverage includes Albanian without a new hard-coded list.
- `tests/phase7-setup-i18n.test.ts` - registry-derived seed coverage plus explicit Albanian terminology and `+355` E.164 assertions.
- `tests/browser-receipts.test.ts`, `tests/i18n-audit-remediations.test.ts`, `tests/rtl-dashboard-pos-common.test.ts`, `tests/rtl-kds-server-whatsapp.test.ts`, `tests/rtl-setup-auth-settings.test.ts`, `tests/decoupled-ui-locale.test.ts`, and `tests/issue-241-localized-errors.test.ts` - add Albanian where tests intentionally exercise locales, browser detection, number/date behavior, or order-slip direction.
- `frontend/e2e/phase7-setup-print-i18n.spec.ts` - add Albanian expected setup/print labels.
- `docs/i18n.md`, `docs/README.md`, `CONTRIBUTING.md`, and `README.md` - list Albanian and link its message file or this record.
- This document - research, specification, plan, and challenge record.

No changes are planned for `main/db.ts`, migrations, tax packs, `main/countries.ts`, authentication, authorization, network services, printer profiles, or generated frontend build output committed to Git.

## Concrete specification

### Functional requirements

1. A user can select Albanian from Setup and Settings, and the selection survives reload through the existing local/server persistence paths.
2. Albanian is selectable for UI, receipt, KOT, Z-report, and print-test language policies.
3. Albanian uses `sq-AL`, `Shqip`, LTR, and a locally packaged lazy chunk.
4. Every English leaf has exactly one Albanian leaf. ICU arguments, plural/select selectors, and any future tags remain unchanged.
5. Albanian seed data is localized, uses synthetic `+355` E.164 customer numbers, and remains independent of the selected country.
6. Backend print labels are generated from the Albanian JSON and pass drift/parity checks.
7. Albanian `Ë/ë` and `Ç/ç` have an explicit generic-printer ASCII fallback; printer capability warnings remain intact.
8. Albanian numbers and dates use the existing `sq-AL` Intl behavior. No currency or tax behavior is changed.
9. Browser detection resolves `sq` and `sq-AL`, and tableside order slips preserve `lang="sq-AL" dir="ltr"`.

### Acceptance checks

- `npm run i18n:check` passes.
- `npm run test:locale-chunks` passes after `npm run build:frontend` and proves the Albanian chunk is lazy, local, distinct, and free of external URLs.
- Focused setup, print-label, print-regression, locale-loading, translation, RTL, browser-receipt, and order-slip tests pass.
- Shared print-kernel and raster-renderer tests pass for the merged grapheme, Arabic/Persian, and CJK behavior without locale-driven capability changes.
- `npm run lint` and `npm run build:frontend` pass.
- `npm run build` passes for the seed and print-capability boundary.
- A manual browser smoke pass verifies Albanian print-test labels, `<html lang="sq-AL" dir="ltr">`, and the visible print controls with no raw keys; focused KDS/Server App and setup tests cover the remaining surfaces.
- `git diff --check` passes and the final diff contains no unrelated files.

## Implementation plan

1. Scaffold `sq.json` with `npm run i18n:add -- sq`.
2. Translate every canonical leaf from `en.json` using the glossary above, preserving ICU and technical literals, and add an Albanian fallback guard rather than silently accepting English prose.
3. Register `sq` in `languages.ts` and extend the existing setup seed resolver/data branches with localized terminology and `+355` E.164 values.
4. Run the repository generator for `main/print/print-labels.generated.ts`.
5. Extend the existing English-to-ASCII thermal map only for the four Albanian letters and add focused measurement, order-slip, browser-detection, and runtime assertions.
6. Update registry-driven tests and documentation, preserving the merged Dutch, Taiwan Chinese, Hindi, and Bengali shared fixes.
7. Run translation, print, setup, type, lint, build, offline-chunk, and browser/manual checks; inspect generated drift, automated-review findings, and the final diff.
8. Commit one focused Conventional Commit, force-push the rebased task branch safely, update the existing PR, and verify the forge reports `isDraft: false`.

## Verification record

The rebased implementation was verified with the repository-native checks and focused runtime coverage:

- `npm run i18n:check` passed for 19 locales, including exact 2,639-leaf parity, ICU/placeholder/tag parity, Albanian English-fallback safeguards, generated print drift, and frontend TypeScript.
- `npm run test:print-labels` passed with 111 assertions and covered 18 browser/backend/WebUSB KOT locales. Albanian receipt/KOT labels, ASCII fallback, and grapheme-safe measurement/truncation/wrapping for `Ë/ë/Ç/ç` passed.
- `npm run test:phase7-setup-i18n` passed for all 19 locales, including explicit Albanian terminology and `+355` E.164 seed values; `npm run test:phase6-locale-loading` passed all 19 browser and WebUSB paths.
- `npm run test:print-kernel` and `npm run test:raster` passed, preserving shared grapheme, Arabic/Persian, CJK, thermal, and Electron raster behavior.
- `npm run test:rtl-setup-auth-settings`, `npm run test:rtl-dashboard-pos-common`, and `npm run test:rtl-kds-server-whatsapp` passed. Browser detection resolves both `sq` and `sq-AL`; standalone layouts retain `dir="ltr"`.
- `npm run test:browser-receipts` passed 67 checks, including the Albanian receipt and tableside order slip; `npm run test:i18n-audit-remediations` passed 53 checks, `npm run test:issue-241-localized-errors` passed, and `npm run test:decoupled-ui-locale` passed with `sq-AL` decimal, grouping, `Lekë`, date, and Albania-profile assertions.
- `npm run test:locale-chunks` passed after `npm run build:frontend`. Albanian is a distinct 154 KB lazy chunk, is not eager on any page, and has no external references.
- `npm run lint`, `npm run build`, and `npm run build:frontend` passed. Lint reports only the repository's pre-existing warnings and no errors.
- `npm run test:e2e:browser` passed all 76 Chromium tests, including the multi-locale visible print-control spec with Albanian. The phone-unification spec also passed twice against the same fixture; it now waits for business hydration and uses a unique customer row so retries cannot select stale rows.
- `npm test` passed the complete repository suite.
- Post-review repair corrected the distinct cash labels to `Depozitë`/`Tërheqje`, unified takeaway labels to `Me vete`, regenerated the derived print catalog, and added translation assertions for those semantics. The CI failure was reproduced from the run log as a pre-hydration settings save followed by a retry duplicate; the focused and full browser suites pass after the test synchronization fix.
- `chrome-devtools-axi` manual smoke verification against the isolated E2E fixture confirmed persisted `language: "sq"`, `<html lang="sq-AL" dir="ltr">`, `Cilësimet`, `Dëftesë bazë (termike)`, `Printim në web (shfletues)`, and `Ndarje përmes WhatsApp`, with no raw translation keys and no console errors. Screenshot evidence was written outside Git at `/tmp/flocafe-albanian-print-test.png`.
- Physical 58 mm/80 mm printer coverage remains an honest release limitation: capability-gated software paths passed, but no hardware printer was available in this environment.

## Challenge reviews

### Product challenge review

- **Concern:** Albanian can be used outside Albania, so UI language must not imply Albanian tax or currency rules.
  - **Resolution:** Keep `sq-AL` as a presentation locale only. Reuse tenant country/currency settings; do not add Albania-specific tax behavior.
- **Concern:** A literal translation of `bill` could obscure whether FloCafe means an invoice, receipt, or open check.
  - **Resolution:** Use `Dëftesë` consistently for the customer document and preserve existing bill/check distinctions in surrounding action text where the English distinction matters.
- **Concern:** Broad POS terminology can produce misleading fiscal claims.
  - **Resolution:** Translate labels, not legal assertions. Keep technical identifiers and country-pack labels owned by their existing domains.

### Engineering challenge review

- **Concern:** A registry-only change would leave backend policies and generated print labels unaware of Albanian.
  - **Resolution:** Register the locale, add the complete message file, and regenerate the derived print view. Do not hand-edit generated code.
- **Concern:** Adding a locale can accidentally create a network dependency.
  - **Resolution:** Use a static JSON dynamic import only. Verify the built chunk has no external URL and that English remains the eager fallback.
- **Concern:** Albanian `Ë/ë` is absent from common ESC/POS code pages.
  - **Resolution:** Extend the existing transliteration map for `Ë/ë/Ç/ç`; retain capability gating and explicit warnings. Do not add a font, dependency, or printer redesign.
- **Concern:** A hard-coded language union in seed code could silently fall back to English or store invalid phones.
  - **Resolution:** Extend `SeedLanguage` and `resolveSeedLanguage`, use full `+355` E.164 numbers, and cover both terminology and phone normalization in the registry-derived setup test.
- **Concern:** Rebase conflicts could overwrite grapheme, browser, order-slip, or recent-locale fixes merged through Dutch, Taiwan Chinese, Hindi, and Bengali.
  - **Resolution:** Resolve from the current-main side, reapply only Albanian deltas, regenerate print labels, and verify all 19 locales plus the shared print, RTL, order-slip, and CJK regression suites.

### QA/release challenge review

- **Concern:** Parity alone can pass with English fallback values.
  - **Resolution:** Add Albanian-specific English-identical/placeholder safeguards, with a narrow allowlist for brands, formats, examples, units, and technical identifiers.
- **Concern:** A long Albanian label can wrap or truncate differently from English.
  - **Resolution:** Include Albanian in the existing print regression matrix and test the representative `Ë/ë/Ç/ç` strings through native, browser, and WebUSB paths. Do not change width semantics without a demonstrated defect.
- **Concern:** Printer support varies by firmware and code page.
  - **Resolution:** State the hardware limitation in the PR, preserve warning/refusal behavior, and request physical printer evidence separately rather than claiming universal native glyph support.
- **Concern:** The locale can increase static bundle size and startup work.
  - **Resolution:** Keep Albanian in its own lazy chunk, preserve English eager loading, and run the chunk-splitting test after the frontend build.
- **Concern:** Translation review may expose terminology errors after merge.
  - **Resolution:** Apply the glossary consistently (`Dëftesë` for customer bills/receipts, `Faturë` for invoices), use a minimal intentional-identical guard, and keep focused print/browser assertions so corrections do not change architecture.

## Evidence sources

- Repository architecture and workflow: [`docs/i18n.md`](i18n.md), [`docs/printing-architecture.md`](printing-architecture.md), [`docs/printing-nonlatin-capabilities.md`](printing-nonlatin-capabilities.md), and the current source files listed above.
- Unicode CLDR Albanian plural rules: <https://www.unicode.org/cldr/charts/47/verify/numbers/sq.html>
- Unicode CLDR Albanian locale summary: <https://unicode.org/cldr/charts/43/summary/sq.html>
- W3C international number formatting guidance: <https://www.w3.org/International/questions/qa-number-format>
- Albanian tax authority hospitality invoice notice: <https://www.tatime.gov.al/d/8/45/45/1531/njoftim-per-faturat-porosi-dhe-permbledhese-ne-sektorin-e-hoteleri-turizem>
- Albanian locale terms cross-checked against public Albanian software translations, including Mozilla `sq` resources and CLDR data.

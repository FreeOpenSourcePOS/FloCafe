# Bengali language support: research, specification, and release plan

**Status:** implementation record
**Language key:** `bn`
**Locale:** `bn-BD`
**Native name:** বাংলা
**Direction:** left-to-right

This document records the investigation and implementation contract for adding Bengali (Bangla) to FloCafe. It is intentionally a locale addition, not a localization, printing, font, currency, or tax-pack redesign.

## 1. Current localization architecture

### Registry and canonical source

- `frontend/src/lib/i18n/languages.ts` is the registry and single source of truth for the language key, BCP-47 locale, native name, direction, selectability, and dynamic loader.
- `frontend/src/lib/i18n/messages/en.json` is the canonical message schema. Every committed locale must have exact leaf parity with it.
- Repository keys are lowercase ISO 639-style primary language identifiers, not region-qualified identifiers. `bn` is the canonical ISO 639-1 identifier for Bengali; region metadata belongs in the registry's `locale` field.
- The scaffolder, `scripts/i18n-add.cjs`, accepts `bn`, atomically creates `frontend/src/lib/i18n/messages/bn.json` from English, and refuses to overwrite an existing file.

### Offline loading and runtime fallback

- English is bundled eagerly as the cold-boot fallback.
- Every other registry entry is loaded through a dynamic `import()` and cached by `frontend/src/lib/i18n/loader.ts`. A static desktop build therefore ships Bengali as a local lazy chunk, with no runtime translation-service dependency.
- `I18nProvider` switches messages atomically, reverts a failed load to the last active locale, and never renders a partially loaded catalog.
- Setup, Settings, and print-language controls derive their options from the same registry and `selectable` flag.
- Browser-language detection uses `Intl.Locale(candidate).language`, so `bn-BD`, `bn-IN`, and other valid Bengali preference tags resolve to the `bn` key.
- Local storage preserves the selected frontend language; the settings key/value store persists the tenant language. Standalone KDS and Server App surfaces consume the tenant language through their existing synchronization paths. No database migration or enum change is required.

### Print and backend boundary

- Frontend receipt and KOT HTML paths use the shared lazy message cache.
- `scripts/generate-print-labels.cjs` reads the canonical messages and the frontend registry, then regenerates `main/print/print-labels.generated.ts`. The generated file is the backend's label view and selectable-print-language registry. It must never be edited manually.
- Receipt, KOT, tax-bill, test-page, and Z-report policies validate against the registry on the frontend and against the generated table on the backend.
- The pure print kernel has no hard-coded language union. The registry and generated table are injected as facts.
- The existing profile-owned thermal capability model remains authoritative. Enabling a locale must not enable a printer font, shaping mode, code page, or raster path.
- Generic ESC/POS profiles may skip unsupported non-financial content with an explicit warning and refuse unsupported financial content before transport. Browser HTML is the full-Unicode path. This fail-closed behavior is the required Bengali thermal behavior until a printer profile has Bengali font, shaping, and real-hardware evidence.

### Setup and demo data

`main/routes/auth.ts` owns language-aware Express and demo seed data. A new selectable language must be added to the `SeedLanguage` union and receive localized category, product, customer, and staff sample values. Seed country selection remains independent of UI language. Filipino remains the only reviewed English-identical seed-data exception.

### Validation inventory

Current repository-native checks cover the addition through these paths:

- `npm run i18n:check`: registry/file consistency, exact key parity, valid non-empty leaves, ICU variables/selectors, rich-text tag parity, generated print-label drift, and frontend TypeScript key safety.
- `npm run test:locale-chunks`: static export contains one lazy, local Bengali chunk and no eager page reference or external URL.
- `npm run test:phase6-locale-loading`: dynamic loading, browser receipt, and WebUSB path for every registered locale.
- `npm run test:phase7-setup-i18n`: localized setup/demo seeds and print-test labels for every registered locale.
- `npm run test:print-labels`: generated label selection, all-locale receipt matrix, and generator drift.
- `npm run test:print-parity`: print-kernel, policy, renderer, and fallback semantics.
- `npm run test:i18n-ssr-timezone`: SSR rendering and date/time behavior for every registered locale.
- Focused translation safeguard: rejects `[BN]`/`[TODO]` placeholders and unapproved English-identical values.
- Browser E2E: verifies visible print-test labels in Bengali after a real language switch.

## 2. Bengali script and locale findings

### Script shaping and text direction

Bengali is a left-to-right abugida. It is not an RTL language, so the registry direction is `ltr`. The W3C Bengali Layout Requirements describe consonant clusters, stacked/conjoined conjunct forms, ligatures, and special RA forms. Rendering text as individually encoded consonants is therefore insufficient: a real text engine and a font with Bengali OpenType shaping data must select and position the correct glyphs.

FloCafe's browser UI is rendered by Chromium/Electron, which performs script shaping. The application font stack is Latin-first (`Geist`, then `system-ui`), so Bengali relies on platform fallback fonts. No remote font is acceptable in an offline-first app, and enabling a locale must not silently download one. Bengali rendering therefore requires manual visual verification on supported macOS, Windows, and Linux environments. If an OS lacks a Bengali fallback font, the issue is a missing platform font, not a JSON-loader problem.

### Grapheme-safe measurement and wrapping

- Browser layout, CSS truncation, and print HTML wrapping operate on shaped/rendered text. The KOT and order-slip browser styles include bounded widths and `overflow-wrap: anywhere` / `word-break: break-word` for unbroken content.
- The existing raster renderer uses `Intl.Segmenter` with grapheme granularity before fitting text. It must not be changed to split Bengali by JavaScript code unit.
- Native thermal helpers use bounded column strings and are not a Bengali shaping engine. Bengali text must remain behind the profile capability gate. Splitting a Bengali cluster merely to satisfy a native ESC/POS column count would be incorrect and would also imply unsupported printer glyph coverage.
- UI controls should continue to use CSS/layout measurement. A locale addition must not introduce a new JavaScript width heuristic.

### Numbers, dates, and currency

`bn-BD` is a valid CLDR locale. The runtime resolves native Bengali digits (`০`–`৯`), Bengali month names, and Bangladeshi formatting conventions. The UI locale is presentation only: it does not change the store's selected country, currency, timezone, tax rules, phone normalization, or persisted financial values. The tenant regional settings remain authoritative, as required by `docs/business-decisions.md`.

The locale tag `bn-BD` gives Bangladeshi defaults while keeping the registry key portable to Bengali speakers elsewhere. This is consistent with recent regional tags such as `id-ID` and does not create a tax pack or alter country profiles.

### Printing limitation

JSON support makes Bengali labels available to renderers; it does not make a thermal printer capable of shaping Bengali. ESC/POS devices commonly have no Bengali glyphs or OpenType shaping. The existing no-silent-loss contract is therefore mandatory:

- browser receipt/KOT output may render Bengali;
- a profile with proven Bengali native or raster support may opt in only after font, geometry, and real-printer evidence exist;
- generic thermal output uses an explicit ASCII-safe or `[UNSUPPORTED]` fallback where the current renderer already provides one;
- unsupported financial Bengali content refuses before transport rather than printing a partial receipt.

No shipped printer profile is enabled for Bengali by this change, and no generic profile is modified.

## 3. Terminology contract

Use one Bangladeshi POS vocabulary consistently:

| Concept | Bengali term |
| --- | --- |
| POS | পজ (POS) |
| order | অর্ডার |
| bill / receipt | বিল / রসিদ |
| invoice | ইনভয়েস |
| payment | পেমেন্ট |
| cash | নগদ |
| card | কার্ড |
| mobile payment | মোবাইল পেমেন্ট |
| customer | গ্রাহক |
| staff | কর্মী |
| owner | মালিক |
| manager | ম্যানেজার |
| cashier | ক্যাশিয়ার |
| chef | শেফ |
| table | টেবিল |
| product | পণ্য |
| category | ক্যাটাগরি |
| add-on | অ্যাড-অন |
| quantity | পরিমাণ |
| price / rate | দাম / হার |
| amount | পরিমাণ |
| subtotal | সাবটোটাল |
| discount | ছাড় |
| tax | কর |
| total | মোট |
| change | ফেরত |
| kitchen | রান্নাঘর |
| KOT | কিচেন অর্ডার টিকিট |
| takeaway | টেকঅ্যাভে |
| delivery | ডেলিভারি |
| dine in | রেস্টুরেন্টে |
| online order | অনলাইন অর্ডার |
| saved | সংরক্ষিত |
| failed | ব্যর্থ |
| required | আবশ্যক |
| optional | ঐচ্ছিক |
| warning | সতর্কতা |
| error | ত্রুটি |
| help | সহায়তা |
| settings | সেটিংস |
| printer | প্রিন্টার |
| browser | ব্রাউজার |
| language | ভাষা |

Brand names, protocol names, paper widths, IPs, ports, file formats, payment gateway names, SKU/HSN/CSV/XLSX/JSON/API/URL tokens, and other technical identifiers remain unchanged. ICU argument names, selector names, and rich-text tag names must be byte-for-byte equivalent to English.

## 4. Concrete specification

1. Add `bn` to `LANGUAGES` with locale `bn-BD`, native name `বাংলা`, direction `ltr`, `selectable: true`, and a loader for `messages/bn.json`.
2. Scaffold from canonical English and replace every leaf with reviewed Bengali. Preserve all ICU and rich-text contracts. Do not use English fallback values except explicitly shared brand/technical tokens.
3. Add Bengali setup/demo seeds while keeping the selected country independent.
4. Add Bengali translation-quality guards, print-label expectations, all-locale renderer/load arrays, and browser-visible label coverage.
5. Regenerate `main/print/print-labels.generated.ts` through its owner script.
6. Update current documentation and supported-language lists. Do not edit generated output by hand and do not add a tax pack, country profile, migration, or runtime dependency.
7. Prove the static Bengali chunk is lazy, local, and unique; prove all canonical leaves and generated print labels are present; prove browser rendering, language persistence, and print-policy behavior.
8. Manually inspect Bengali UI and browser print HTML for conjuncts, matras, line wrapping, mixed Latin/numbers, dialogs, POS/KDS/Server App, and print warnings on the available host.

## 5. Implementation plan

1. Scaffold `bn.json` with `npm run i18n:add -- bn` and translate the canonical catalog using the terminology contract.
2. Register the locale and localize Express/demo seed data.
3. Extend the existing focused tests and explicit all-locale matrices; do not create a new localization framework or printer abstraction.
4. Run `npm run generate:print-labels` and retain only the generated drift-free result.
5. Update `README.md`, `CONTRIBUTING.md`, `docs/README.md`, and `docs/i18n.md` for Bengali.
6. Run narrow tests first, then all applicable localization, print, lint, type, build, and browser checks.
7. Perform manual browser verification and inspect the complete diff/status before committing.

## 6. Challenge reviews

### Product review

- **Challenge:** Bengali spans Bangladesh and India, and `Bengali` versus `Bangla` may be a product choice.
  - **Resolution:** use the ISO key `bn`, the endonym `বাংলা`, and Bangladeshi presentation defaults in `bn-BD`. The locale remains portable, and regional business settings remain separate.
- **Challenge:** a new language might imply country, currency, or tax behavior.
  - **Resolution:** reject that coupling. It would contradict the documented regional-settings decision and expand scope.
- **Challenge:** setup/demo data could silently fall back to English.
  - **Resolution:** localize the existing seed vocabulary and rely on the all-locale Phase 7 assertions.

### Engineering review

- **Challenge:** adding a locale might require touching the print kernel or database.
  - **Resolution:** neither is needed. The registry is injected, language storage is unconstrained text, and the print-label file is generated.
- **Challenge:** changing every hard-coded test list invites omissions.
  - **Resolution:** first inventory all current lists, update only those representing all registered locales, and rely on registry-driven tests for generic parity/loading.
- **Challenge:** machine-assisted translation could leak English or damage ICU.
  - **Resolution:** protect and verify every placeholder/tag, reject placeholder prefixes and unapproved identical values, and review POS, finance, print, setup, auth, and error terminology explicitly.

### QA and rendering review

- **Challenge:** valid UTF-8 does not prove correct Bengali glyphs.
  - **Resolution:** browser/manual verification must include conjuncts and vowel signs. The test suite can verify text presence, locale metadata, wrapping CSS, and grapheme behavior, but it cannot certify fonts on every operating system.
- **Challenge:** Bengali strings are longer in some places and can overflow controls.
  - **Resolution:** inspect the highest-density navigation, settings, POS, tables, and dialog surfaces at supported viewport sizes. Do not add a global truncation redesign.
- **Challenge:** a lazy chunk could accidentally reference the network.
  - **Resolution:** run the existing static-export chunk test and inspect the built output.

### Printing and hardware review

- **Challenge:** registering Bengali may imply native thermal support.
  - **Resolution:** it does not. Generic printers must keep explicit fallback/refusal behavior. No capability flag changes without model-specific evidence.
- **Challenge:** Unicode code-unit truncation can damage conjuncts.
  - **Resolution:** do not admit Bengali to native thermal layout. Browser layout and the existing grapheme-aware raster boundary are the only shaping-capable paths.
- **Challenge:** browser print can look correct while a physical printer cannot render it.
  - **Resolution:** state this residual risk in the PR. Physical Bengali ESC/POS proof remains profile/font/hardware gated and is not claimed by this locale addition.

### Security and privacy review

- **Challenge:** translation strings are rendered through rich text or print paths.
  - **Resolution:** preserve the existing tag whitelist/validation and never add executable markup. ESC/POS control-token and merchant-template validation remain unchanged.
- **Challenge:** locale loading could call a translation service.
  - **Resolution:** no. Bengali is a committed static JSON chunk; the application makes no translation or font-network request.
- **Challenge:** translation work could expose customer or credential data.
  - **Resolution:** only public repository message strings are authored; no database dump, customer data, secret, or credential is used.

### Release-risk review

- **Moderate risk:** physical thermal support is not claimed and generic printers will warn/refuse for Bengali financial content.
- **Moderate risk:** platform font fallback varies, especially on minimal Linux installations.
- **Low risk after checks:** persistence and locale selection are registry-driven and require no migration.
- **Acceptance gate:** parity, ICU/tag safety, generated-label drift, lazy/offline chunk, type/lint/build, focused print tests, browser E2E, and manual rendering must all pass before the PR is marked ready.

## 7. References

- W3C, [Bengali Layout Requirements](https://www.w3.org/TR/beng-lreq/)
- Unicode, [Unicode Standard, Chapter 12: Complex Contexts](https://www.unicode.org/versions/Unicode17.0.0/core-spec/chapter-12/)
- Unicode, [UAX #29: Unicode Text Segmentation](https://www.unicode.org/reports/tr29/)
- Unicode, [UAX #14: Unicode Line Breaking Algorithm](https://www.unicode.org/reports/tr14/)
- Unicode CLDR, [Bangla (`bn`) locale summary](https://unicode.org/cldr/charts/48/summary/bn.html)
- FloCafe, [Internationalization guide](i18n.md)
- FloCafe, [Printing architecture](printing-architecture.md)
- FloCafe, [Non-Latin thermal printing capability study](printing-nonlatin-capabilities.md)

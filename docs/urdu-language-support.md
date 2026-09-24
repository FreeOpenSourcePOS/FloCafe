# Urdu language support

**Status:** CURRENT implementation and research record

## 1. Purpose and scope

This document records the investigation, concrete specification, implementation plan, and challenge reviews for adding Urdu to FloCafe's existing localization architecture. The work is additive: it adds one locale to the current registry, canonical message catalog, generated backend print-label view, setup/demo seeds, tests, and user documentation. It does not redesign localization, regional settings, or printing.

The implementation must preserve the following existing boundaries:

- UI language remains independent of store country, currency, timezone, calendar, and tax compliance.
- English remains the eager, packaged fallback.
- Non-English messages remain lazy-loaded packaged chunks and never depend on the network.
- Print labels remain generated from the canonical message files; generated files are never edited by hand.
- Printer capability, not UI language, determines whether native ESC/POS can shape and order Arabic-script text.
- Existing Persian and Arabic RTL behavior remains unchanged.

## 2. Repository evidence and current architecture

### 2.1 Canonical source and registry

`frontend/src/lib/i18n/messages/en.json` is the canonical message schema. It currently contains 2,639 string leaves across 30 top-level namespaces. Every committed locale must have exact leaf parity with English, valid ICU syntax, matching argument names and selectors, and matching rich-text tags.

`frontend/src/lib/i18n/languages.ts` is the single frontend registry. Each language owns:

- a lowercase two- or three-letter registry key and message filename;
- a canonical BCP-47 formatting locale;
- a native endonym;
- `ltr` or `rtl` direction;
- selectability;
- a dynamic JSON import.

Setup, Settings, print-language selectors, browser-language detection, KDS/Server App synchronization, print contexts, and client-side receipt/KOT rendering all consume this registry. Adding a language-specific branch to those consumers would duplicate the registry and is therefore out of scope.

### 2.2 Offline loading and fallback

`frontend/src/lib/i18n/loader.ts` primes English synchronously, caches active messages, and deduplicates in-flight dynamic imports. The desktop build statically exports Next.js and packages every locale chunk. The existing `test:locale-chunks` suite proves that every non-English locale:

- appears in exactly one independent chunk;
- is not eagerly referenced by exported HTML;
- contains no external URL reference.

Authenticated bootstrap separately warms locales named by receipt, KOT, and Z-report policies. A failed print-locale load is surfaced; English fallback is never presented silently as Urdu. No migration, network call, API token, or remote translation service is required.

### 2.3 Persistence and synchronization

The selected UI language is stored as the tenant `settings.language` value and mirrored in the Zustand `pos-settings` local store. Login and tenant selection validate the value through `isLanguage`; standalone KDS and Server App surfaces accept it only through the same registry. Existing installations require no data migration because `ur` is a new valid stored value and English remains the fallback for older/missing values.

Setup sends the selected language to `POST /auth/setup/initialize`; Settings persists it through the business settings API. The store country is a separate setup field and must continue to drive customer phone normalization, regional defaults, and demo dial codes.

### 2.4 Setup and demo seeds

`main/routes/auth.ts` has a closed `SeedLanguage` union and a locale-specific seed table. A complete Urdu addition must extend that union and every express/demo branch:

- express category and product labels;
- demo categories and products;
- demo customers and staff names;
- country-independent phone handling.

`tests/phase7-setup-i18n.test.ts` runs every registered language through both seed profiles. Urdu is not an English-identical seed exception; Filipino remains the sole allowlisted exception.

### 2.5 Backend, renderer, and print boundary

The Electron main process cannot import frontend loaders. `scripts/generate-print-labels.cjs` reads the registry and canonical message files, extracts the audited print namespace and borrowed keys, and regenerates `main/print/print-labels.generated.ts`. The generated registry feeds backend receipt, KOT, test-page, and Z-report label lookup and print-policy validation.

The renderer boundaries remain:

- semantic print documents carry labels and values without transport details;
- browser HTML delegates shaping, bidi, and wrapping to the browser;
- WebUSB and native ESC/POS paths use the shared thermal capability policy;
- capability-gated raster uses isolated Chromium and grapheme segmentation for pixel measurement;
- generic ASCII printers skip unsupported non-financial Arabic-script lines with a warning and refuse unsupported financial units before transport.

Urdu therefore joins the existing Arabic-script path without a Urdu branch in the print kernel.

### 2.6 Validation tooling

Repository-owned validation is offline and deterministic:

- `npm run i18n:add -- ur` scaffolds `ur.json` from English with no overwrite;
- `npm run i18n:check` validates registry/file consistency, exact parity, ICU arguments/selectors, rich-text tags, generated print-label drift, and frontend TypeScript key safety;
- `npm run test:print-labels` checks generated selection, runtime receipt/KOT label resolution, fallbacks, and generator drift;
- `npm run test:phase6-locale-loading` covers browser and WebUSB loading for every registered locale;
- `npm run test:locale-chunks` proves packaged offline loading after `npm run build:frontend`;
- RTL suites verify logical layout, mirrored navigation, LTR islands, and direction metadata;
- Phase 7 setup coverage verifies localized seed data;
- lint and frontend/backend builds cover production compilation.

### 2.7 Language-addition inventory from recent additions

The recent Italian, Japanese, Simplified Chinese, Korean, Bahasa Indonesia, and Arabic additions establish the current minimum inventory:

1. canonical locale JSON with exact English parity;
2. registry entry and lazy loader;
3. Urdu-specific setup/demo seed branch;
4. generated backend print labels;
5. locale-specific translation fallback/placeholder guard;
6. setup, print, browser/WebUSB, and RTL test coverage;
7. i18n guide, contributor guide, and supported-language documentation;
8. regenerated print labels after message edits.

Recent follow-up commits corrected Italian Server App wording, Korean add-on-group terminology, and Chinese KOT terminology after integration. This is evidence that terminology and print semantics need explicit review even when structural tests pass. The Arabic follow-up also demonstrated why setup hydration must remain deterministic and why generated assets must replace, rather than sit beside, source locale files.

## 3. Urdu-specific research

### 3.1 Identifier

The IANA language-subtag registry defines `ur` as Urdu with the `Arab` script. `ur` is therefore the smallest correct registry/message identifier and matches `i18n:add` and all existing locale keys. `ur-PK` is the smallest region-qualified formatting locale consistent with the current language-specific regional entries and the primary Urdu locale. Script and numbering-system extensions are unnecessary because CLDR already supplies the intended defaults.

Browser detection parses only the primary language subtag, so `ur`, `ur-PK`, and `ur-IN` all resolve to the same registered Urdu UI language. This does not change the separately selected store country.

### 3.2 Arabic script is reusable only at the script boundary

Urdu is written with the Arabic script, so the existing script detector and Arabic joining machinery are appropriate. It is not Arabic or Persian, and its vocabulary, grammar, orthography, and terminology must not be copied from those catalogs. Reuse is limited to:

- `direction: 'rtl'`;
- script-range detection;
- contextual shaping capability classification;
- browser/Chromium rendering;
- shared RTL layout and LTR-island behavior.

The Urdu catalog is authored independently from English. Arabic and Persian files are evidence for plumbing and script behavior only, never translation sources.

### 3.3 Direction, shaping, and bidi

Unicode's Arabic shaping data assigns right, dual, and transparent joining behavior to letters used in Urdu. A logical string therefore cannot be measured or rendered correctly by treating each code point as an independent visual glyph. The correct boundaries are:

- browser: native Unicode bidi and shaping from logical-order source text;
- raster: Chromium canvas with explicit direction, plus existing grapheme-safe pixel measurement;
- native ESC/POS: only a printer profile proven to perform Arabic-script shaping and bidi ordering may receive logical text directly;
- generic ESC/POS: explicit warning/refusal behavior remains unchanged.

The existing detector covers Urdu's Arabic-script code points and ZWNJ/ZWJ/RLM controls. It should be exercised with real Urdu words containing joining and non-joining letters, not an Arabic or Persian substitute.

Urdu text is stored in logical Unicode order. No visual-order conversion or presentation-form substitution belongs in the locale file or application code.

### 3.4 Fonts and grapheme-safe measurement

The application uses the system/Geist sans stack, while browser receipts already fall back through system fonts to `Noto Naskh Arabic`. Existing Arabic-script support relies on platform font fallback rather than a bundled font. Adding Urdu-specific UI font or Nastaliq typography would alter every Arabic-script locale and belongs to the separately hardware/font-gated non-Latin print decision, not this language addition.

Urdu combining marks, ZWNJ/ZWJ, and bidi controls are zero-width. The shared thermal width code accounts for Arabic combining marks and bidi controls; the raster path already uses `Intl.Segmenter` at grapheme granularity. Native print width remains a monospaced-cell approximation, and a profile-proven shaped printer can render a different visual width. That pre-existing hardware limitation is not repaired in this change; unsafe financial rows still fail closed.

### 3.5 Numbers, currency, dates, and regional settings

CLDR and current Node `Intl` behavior show Latin digits for `ur-PK`, with Western grouping/decimal separators and localized Urdu month names. FloCafe deliberately keeps formatting domains separate:

- `ur-PK` supplies UI message and presentation-language conventions;
- selected store country and currency remain authoritative for monetary and regional presentation;
- print amounts continue to use tenant country locale with Latin digits where required;
- tax and compliance remain country-owned.

No Urdu-specific currency conversion, numeral conversion, country default, timezone, calendar, or tax rule is added. This preserves `docs/business-decisions.md` and the decoupling contract.

### 3.6 Translation style and terminology

Urdu strings should be natural, concise, professional Urdu rather than word-for-word English or Arabic/Persian copies. Mozilla's Urdu localization guide recommends avoiding word-by-word translation, using contemporary professional language, preserving placeholders/tags, Latin digits, and consistent terminology. Google likewise warns that unreviewed machine translation of short, context-specific UI strings can create usability problems.

This implementation applies one reviewed POS glossary throughout UI, print, KDS, Server App, WhatsApp, and setup copy. Product names and proven technical tokens remain untranslated. Urdu punctuation uses `،` and `۔` in natural-language prose; literal identifiers, URLs, currency codes, and technical examples remain exact.

Core glossary:

| Concept | Urdu |
| --- | --- |
| FloCafe, FloPOS, POS, KDS, PIN, USB, URL, QR, CSV, ESC/POS, RevFlo, FloAdmin, WhatsApp | Preserve |
| owner | مالک |
| manager | منیجر |
| cashier | کیشیئر |
| server | ویٹر |
| chef | شیف |
| staff | ملازم |
| order | آرڈر |
| table | میز |
| dine-in | ٹیبل سروس |
| takeaway | ٹیک اوے |
| delivery | ڈیلیوری |
| bill | بل |
| receipt | رسید |
| invoice | انوائس |
| subtotal | ذیلی رقم |
| total | کل رقم |
| amount | رقم |
| price | قیمت |
| tax | ٹیکس |
| discount | رعایت |
| payment | ادائیگی |
| cash | نقد |
| card | کارڈ |
| customer | گاہک |
| product | پروڈکٹ |
| category | زمرہ |
| add-on | ایڈ آن |
| quantity | مقدار |
| loyalty | وفاداری |
| points | پوائنٹس |
| save | محفوظ کریں |
| cancel | منسوخ کریں |
| delete | حذف کریں |
| settings | ترتیبات |

### 3.7 Printing and release risk

Urdu uses the same Arabic-script capability class as Arabic and Persian, but firmware support is printer-specific. A generic profile must not claim shaping support merely because the UI language is Urdu. Browser print and capability-gated raster provide the existing correct rendering paths; native hardware claims require a real printer test.

The implementation must add semantic tests but must not enable raster, change printer profiles, or invent a hardware support claim. Physical Urdu receipt/KOT validation remains an operator release check under the existing printer protocol.

### 3.8 Security and privacy

The locale is static repository content loaded from the packaged application. It introduces:

- no runtime network request;
- no credential, account, or remote translation dependency;
- no new backend trust boundary;
- no new HTML/script execution path;
- no change to telemetry fields or customer-data handling.

Existing rich-text validation, print-label generation, control-character filtering, CSP, and template trust rules remain authoritative. Translation review must avoid inserting bidi controls or control characters merely to force visual order; markup and logical order are used instead.

## 4. Concrete specification

### 4.1 Registry contract

Add:

```ts
ur: {
  locale: 'ur-PK',
  nativeName: 'اردو',
  direction: 'rtl',
  selectable: true,
  load: () => import('./messages/ur.json'),
}
```

No new language unions, loader branches, persistence versions, API payloads, or database schema changes are permitted.

### 4.2 Message contract

`frontend/src/lib/i18n/messages/ur.json` must:

- contain all 2,639 canonical English leaves and no extras;
- use valid ICU MessageFormat syntax;
- preserve every argument name, selector, plural category set, and rich-text tag;
- use the glossary above consistently;
- preserve brand/technical/example values only where the source is intentionally non-translatable;
- contain no `[UR]`, `[TODO]`, raw key, untranslated English prose, control character, or malformed RTL workaround.

A Urdu-specific fallback guard must reject placeholder prefixes and English-identical values outside a documented allowlist.

### 4.3 Setup and print contract

Urdu must be accepted by the seed-language union and produce localized express/demo categories, products, customers, and staff names. The generated print-label view must be regenerated from canonical messages and include Urdu in registry order. Urdu labels must resolve through classic/compact receipts, KOT, test pages, browser receipts, WebUSB, and Z-report generation without raw keys.

### 4.4 Verification contract

The change is acceptable only when:

- Urdu is selectable in Setup and Settings;
- browser preference `ur-*` selects Urdu without hydration errors;
- `<html lang="ur-PK" dir="rtl">` is applied after the Urdu bundle loads;
- common screens have no horizontal overflow and directional icons mirror;
- emails, phones, URLs, IDs, money, and quantities remain readable LTR islands;
- Urdu bundles are local, lazy, independently chunked, and parity-clean;
- generated backend labels have no drift;
- generic printer warnings and capability-gated shaping tests distinguish safe/unsafe Urdu lines;
- no existing locale, print byte stream, regional setting, or database behavior changes unintentionally.

## 5. Implementation plan

1. Scaffold `ur.json` with `npm run i18n:add -- ur`.
2. Register `ur` in the canonical frontend language registry.
3. Translate the canonical English catalog namespace by namespace, applying the shared glossary and preserving ICU/tag structure.
4. Add the Urdu fallback/placeholder validator and negative fixtures.
5. Extend setup/demo seed data for Urdu.
6. Regenerate `main/print/print-labels.generated.ts` through its owner script.
7. Extend registry-driven and explicit-language tests for parity, offline chunks, print labels, setup seeds, RTL direction, browser detection, print-test labels, and Arabic-script capability behavior.
8. Update the i18n guide, contributor guide, README language list/link, and documentation index.
9. Run focused localization/print/RTL/setup tests, `npm run i18n:check`, `npm run lint`, `npm run build`, `npm run build:frontend`, locale-chunk validation, and manual desktop/browser verification.
10. Review the full diff for unrelated behavior, commit one focused change, push the task branch, and open a ready-for-review PR without merge or auto-merge.

## 6. Challenge reviews

### 6.1 Product challenge

**Challenge:** Does adding `ur-PK` accidentally make Pakistan the store country or currency?

**Resolution:** No. The locale is presentation metadata only. Country remains a required, independent setup choice and continues to own regional defaults and phone rules. Browser `ur-IN` and stored Urdu users remain supported through primary-language detection.

**Challenge:** Should Urdu be selectable before native-speaker review?

**Resolution:** Structural and rendering completeness can be delivered without a product redesign, but idiomatic quality remains a release risk. The implementation uses one reviewed glossary, dedicated fallback tests, native-language visual review of high-traffic POS screens, and terminology review of print labels. It does not claim formal native-speaker certification.

### 6.2 Architecture challenge

**Challenge:** Should Urdu be implemented as a special RTL branch or by copying Persian/Arabic messages?

**Resolution:** No. The existing registry already owns direction, lazy loading, browser detection, persistence, setup, and print selection. Urdu needs one registry entry, canonical messages, and seed data. Script-level shaping and bidi behavior are shared capabilities; language content is not shared.

**Challenge:** Should print capability be enabled automatically for Urdu?

**Resolution:** No. That would turn a UI-language addition into an unsupported hardware claim. Existing printer-profile evidence and warning/refusal semantics remain unchanged.

### 6.3 Security and privacy challenge

**Challenge:** Does static translated content create injection or data-exfiltration risk?

**Resolution:** No new execution or network path is introduced. Existing ICU/tag validation, generated print labels, HTML escaping, control filtering, CSP, and template validation remain in force. The Urdu catalog must not contain control characters or forced visual-order hacks.

### 6.4 QA and release challenge

**Challenge:** Can automated parity prove Urdu translation quality or printer correctness?

**Resolution:** No. Automated checks prove completeness, ICU/tag integrity, registry/loading behavior, direction metadata, print-label selection, and capability gating. Manual screenshots and native-speaker terminology review cover UI quality; physical printers remain gated by the existing hardware matrix. These residual risks must be visible in the PR rather than misrepresented as automated proof.

## 7. Non-goals

- No localization or print architecture redesign.
- No new translation service, API key, or runtime dependency.
- No Urdu-specific currency, tax, country, timezone, or calendar behavior.
- No automatic printer-profile or raster enablement.
- No bundled Nastaliq or other global UI font.
- No database migration or stored-data rewrite.
- No changes to unrelated RTL behavior.

## 9. Validation record

The implementation was verified on the task branch against the current `main` base.

- Base commit: `a42eb51d3ee660e259d713ad87b0ee3691feabed`
- Branch: `fm/flocafe-urdu-language-support-r1`
- Worktree: `/Users/gurkiratkhaira/.treehouse/FloCafe-f5cc04/3/FloCafe`

- `npm run i18n:check` passed, including 15-locale registry/file consistency, 2,639-leaf parity for Urdu, ICU argument/tag parity, Urdu fallback guards, generated print-label drift, and frontend TypeScript checks.
- `npm run test:print-labels` passed (99 print-label assertions, phase 3 regression coverage, and generator drift check).
- `npm run test:phase6-locale-loading`, `npm run test:phase7-setup-i18n`, RTL foundation/setup/dashboard/KDS suites, browser receipts, and i18n audit remediation tests passed.
- `npm run build:frontend` passed, and `npm run test:locale-chunks` proved Urdu is one lazy packaged chunk with no external URL reference and no eager page reference.
- Manual Chromium verification through `chrome-devtools-axi` confirmed the Urdu option in Setup, `<html lang="ur-PK" dir="rtl">`, localized Setup copy, Pakistan currency selection (`PKR`), no horizontal overflow, Urdu `Intl` grouping/currency output, and no console errors beyond a pre-existing form-field accessibility warning.

Physical Urdu receipt/KOT output remains subject to the documented printer-profile and hardware test matrix. Automated checks cannot substitute for a fluent Urdu linguistic review or a physical shaping-capability test.

## 10. References

- [IANA Language Subtag Registry](https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry) - `ur` Urdu, `PK` Pakistan.
- [Unicode Arabic Shaping Data](https://www.unicode.org/Public/UNIDATA/ArabicShaping.txt) - contextual joining properties.
- [Unicode CLDR Urdu summary](https://unicode.org/cldr/charts/45/summary/ur.html) - Urdu locale data and `ur_PK`/`ur_IN` inheritance.
- [W3C, Authoring HTML: Handling Right-to-left Scripts](https://www.w3.org/TR/i18n-html-tech-bidi/) - document direction, logical order, and bidi isolation.
- [W3C CSS Logical Properties](https://www.w3.org/TR/css-logical-1/) - flow-relative layout.
- [Mozilla Urdu localization style guide](https://mozilla-l10n.github.io/styleguides/ur/) and [glossary](https://mozilla-l10n.github.io/styleguides/ur/glossary.html) - natural Urdu, consistency, placeholders, Latin digits, and terminology.
- [Google localization guidance](https://support.google.com/l10n/answer/6272807) - human review risk for short context-specific UI messages.
- [`docs/i18n.md`](i18n.md) and [`docs/printing-architecture.md`](printing-architecture.md) - repository-specific contracts.

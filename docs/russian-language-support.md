# Russian language support - research, specification, plan, and challenge review

**Task:** add complete Russian UI and print-language support through the existing FloCafe localization architecture.

**Base:** `a42eb51d3ee660e259d713ad87b0ee3691feabed` (`origin/main`, 2026-09-24 inspection)

**Working branch:** `fm/flocafe-russian-language-support-r1`

**Scope decision:** add Russian (`ru`, `ru-RU`, LTR) to the existing offline locale
architecture. Do not add a country profile, tax pack, database migration,
remote translation service, font download, or new print architecture.

## 1. Research report

### 1.1 Current locale registry and canonical source

- `frontend/src/lib/i18n/messages/en.json` is the canonical message tree. At
  the inspected base it contains 2,639 non-empty string leaves across 30
  namespaces.
- Every committed locale is a static JSON file with exact leaf-key parity
  with `en.json`. The current registry has 14 entries in this order: `en`,
  `es`, `de`, `tr`, `fil`, `fr`, `it`, `pt`, `fa`, `ar`, `ja`, `zh`, `ko`,
  `id`.
- `frontend/src/lib/i18n/languages.ts` is the single source of truth for
  language keys, BCP-47 tags, native names, direction, selectability, and
  dynamic import loaders. Region/script metadata belongs in `locale`; the
  message filename and registry key remain the lowercase primary identifier.
- `scripts/i18n-add.cjs` accepts only a lowercase two- or three-letter
  canonical language identifier. Therefore the smallest identifier consistent
  with the current architecture is `ru`, not `ru-RU` or `russian`.

### 1.2 Loading, fallback, and persistence

- `frontend/src/lib/i18n/loader.ts` eagerly packages English as a cold-boot
  fallback and lazy-loads every other locale through its registry `load()`
  function. It deduplicates in-flight requests and caches successful bundles.
- `I18nProvider` resolves initial language in this order: persisted
  `pos-settings` language, browser preference, then English. A failed locale
  load leaves the currently rendered locale active and does not expose a raw
  key.
- `frontend/src/store/pos-settings.ts` persists the UI language locally under
  `pos-settings`; backend tenant language is stored in the settings table and
  is synchronized to standalone KDS/Server App surfaces through
  `server-language.ts` / `/api/kds/info`.
- `LANGUAGES` is consumed by the setup wizard, settings language selector,
  print-policy controls, and browser-language detection. Adding one registry
  entry makes all of those selectors registry-driven; no per-page language
  list should be added.

### 1.3 Print and backend boundary

- Canonical `print.*` and audited borrowed keys are extracted from every
  locale JSON by `scripts/generate-print-labels.cjs` into the committed
  generated file `main/print/print-labels.generated.ts`. This is a derived
  artifact, not an independent translation source.
- `main/lib/print-language-settings.ts` validates backend receipt/KOT/Z-report
  policies against the generated registry. The frontend independently
  validates against `LANGUAGES` and `selectable`.
- Authenticated POS bootstrap warms UI-selected receipt and KOT print locales
  before releasing the dashboard (`frontend/src/lib/print-policy-bootstrap.ts`).
  A failed print-locale load is surfaced as a warning; it is not silently
  presented as a successful Russian print.
- Browser/system HTML receipt and KOT paths have full Unicode support and
  escape database values. Thermal paths remain capability-gated: generic
  ASCII-only printers cannot represent Cyrillic; unsupported non-financial
  rows are skipped with warnings and unsupported financial rows are refused
  before dispatch. The additive raster path is the existing profile-owned
  escape hatch and uses Chromium canvas measurement/segmentation.
- This change must not translate backend error strings, payment method
  identifiers, country/currency codes, product/customer data, or technical
  test-page literals. Only catalog messages change.

### 1.4 Seed/setup inventory

`main/routes/auth.ts` contains the only hard-coded `SeedLanguage` union and
language-specific seed branches. The existing Phase 7 test exercises express
and demo seed data for every registry entry and explicitly allows Filipino as
the only English-identical seed language. Russian therefore needs Russian
express/demo categories, products, customer names, and inactive staff names,
while country selection and phone normalization remain independent of UI
language.

The setup route already accepts a registered language string and persists it;
there is no schema change or data migration required.

### 1.5 Russian-specific behavior

- `ru-RU` is a valid canonical BCP-47 tag. Node's offline `Intl` data renders
  Russian dates in `ДД.ММ.ГГГГ` form, uses non-breaking-space grouping and a
  comma decimal separator for numbers, and formats RUB with the ruble symbol
  after the amount. These are presentation concerns and must remain
  country/currency-authoritative.
- Russian cardinal plural categories are `one`, `few`, `many`, and `other`.
  Messages that already use plural ICU retain the English selector variable
  and `#` semantics while adding the locale-appropriate categories. Messages
  whose English source has a plain count argument use count-safe label wording
  (for example, `Заказов: {count}`) rather than introducing a selector that
  would break source parity. The repository validator checks selector names
  and syntax.
- Russian is LTR. Cyrillic has no contextual letter shaping comparable to
  Arabic, so the existing Arabic shaping flag must not be enabled for `ru`.
- The ordinary Russian translation is expected to use NFC Cyrillic code
  points. Raster rendering already uses `Intl.Segmenter` for grapheme-safe
  wrapping. The shared native thermal width helper is code-point/display-cell
  based, which is sufficient for standard Russian letters but remains a known
  limitation for arbitrary user-entered combining marks. Changing all native
  width code would be a separate printing redesign and is outside this task.
- The current profile table enables raster output for the listed generic,
  Xprinter, and Epson profiles, while the printing study still requires
  real-printer evidence before claiming broad Cyrillic hardware support. This
  change does not alter that capability policy or substitute a font.
- UI/browser fonts use system fallbacks and the existing print stylesheets.
  The current app font is loaded with a Latin subset; Russian glyphs therefore
  rely on the platform/browser fallback. Raster output likewise has a local
  Chromium font fallback but no new remote font source. A bundled font would
  require a separate licensing, size, packaging, and hardware decision.

### 1.6 Recent-language evidence

The merged Japanese, Simplified Chinese, Korean, Italian, and Bahasa
Indonesia additions consistently use the six-step i18n workflow, localize
setup seeds, regenerate print labels, extend focused locale matrices, and
document the new language. Their follow-up commits corrected terminology
(Korean addon groups and Chinese KOT wording) and Server App copy (Italian),
showing that terminology and print-label review are release requirements,
not optional polish. Arabic also demonstrates that a locale addition can
require separate hydration/runtime follow-up; Russian should retain the
already-stable registry-driven loader and avoid unrelated setup refactors.

## 2. Concrete specification

### 2.1 Locale contract

- Registry key: `ru`.
- Message file: `frontend/src/lib/i18n/messages/ru.json`.
- Locale tag: `ru-RU`.
- Native name: `Русский`.
- Direction: `ltr`.
- Selectable: `true`.
- Dynamic loader: `import('./messages/ru.json')`.
- Translation source: English JSON, with all ICU arguments, plural/select
  selectors, rich-text tags, placeholders, and literal formatting retained.

### 2.2 Seed contract

Add `ru` to the seed-language union and resolver. Localize express labels and
demo categories/products/customer/staff data. Use neutral Russian sample
names and keep selected country/currency behavior unchanged. Do not add
Russian to the English-identical seed allowlist.

### 2.3 Print contract

- Regenerate `main/print/print-labels.generated.ts` from the edited message
  file and registry.
- Russian must resolve all generated print concepts, including receipt/KOT,
  payment-method, Z-report, and print-test labels.
- Do not alter capability profiles, Arabic shaping, native text
  normalization, or financial warning behavior as part of locale addition.
- Browser HTML is expected to render Russian Unicode. Thermal validation must
  prove explicit capability behavior, not claim that every printer can print
  Cyrillic natively.

### 2.4 Quality contract

Russian values are non-empty, not scaffold markers, and not silently identical
to English except for documented brands, technical identifiers, measurement
strings, pure format strings, and international terms. ICU placeholder,
selector, and tag parity must be exact. Plain source count arguments use
count-safe Russian labels where a new plural selector would violate parity.
No raw translation key may appear in a rendered Russian receipt, warning, or
print-test surface.

### 2.5 Documentation contract

Update the language lists in `docs/i18n.md`, `CONTRIBUTING.md`, and `README.md`
with Russian and `ru.json`. Keep UI language, country/currency, timezone, and
tax rules explicitly decoupled.

## 3. Implementation plan

1. Create the Russian message file with the canonical schema and translate all
   2,639 leaves; preserve ICU and markup; review POS terminology.
2. Add the `ru` registry entry with `ru-RU`, `Русский`, LTR, selectable, and
   dynamic import.
3. Add Russian seed branches and localized setup/demo sample data in
   `main/routes/auth.ts`.
4. Update focused translation safeguards, print-label assertions, seed/print
   locale matrices, and any explicitly enumerated locale/tag test fixtures
   that represent “all supported locales”. Do not refactor unrelated tests.
5. Regenerate the derived print-label module; never edit it manually.
6. Run the repository-native localization, print, seed, and browser checks;
   inspect the complete diff and remove unrelated changes.
7. Commit the focused branch, push only `fm/flocafe-russian-language-support-r1`,
   open a ready-for-review PR, and verify the forge reports `isDraft: false`.
   Do not merge or run no-mistakes.

## 4. Challenge reviews

### Product challenge

**Risk:** Russian is a long locale, and translations can make the setup and
print-test language grids taller or wider. **Resolution:** retain the existing
responsive registry-driven grid and validate the visible print-test labels;
do not add language-specific layout branches.

**Risk:** “Russian” could be confused with a country/currency/tax choice.
**Resolution:** use only `ru`/`ru-RU` in the UI registry. Country, currency,
and tax selection remain independent; this task does not add or assume a
Russia-specific country profile. Any future regional profile can be paired
with Russian UI independently.

### Translation challenge

**Risk:** literal English-to-Russian word substitutions produce incorrect POS
meanings, inconsistent billing terms, or incorrect plural categories.
**Resolution:** use one reviewed POS glossary, explicitly review receipt/KOT,
tax, refund, inventory, and setup namespaces, and run the ICU/leaf-parity
validator. Technical/brand/shared exceptions are documented in the test
safeguard.

**Risk:** a future English key can be missed. **Resolution:** exact leaf parity
is a hard validator failure; no selectable-until-complete shortcut is used.

### Architecture challenge

**Risk:** changing the loader, policy parser, database, or print kernel would
broaden scope. **Resolution:** the existing registry-driven paths are already
generic. Reuse them and change only registry/messages/seeds/generated output
plus focused test/docs inventories.

**Risk:** a direct backend print could expose a missing label. **Resolution:**
regenerate the derived view and run print-label, print-kernel, print-parity,
and locale-loading tests. Unknown/unsupported text remains an explicit
capability warning/refusal, never a silent financial omission.

### Rendering and accessibility challenge

**Risk:** Cyrillic wrapping or mixed identifiers can be cut incorrectly.
**Resolution:** browser/raster paths use bounded Unicode wrapping; preserve
LTR isolation for IDs/phones/amounts. Treat arbitrary combining-mark data as
a documented residual native-thermal limitation rather than redesigning
layout in this change.

**Risk:** screen readers receive the wrong document direction. **Resolution:**
`ru` is LTR and the existing `HtmlLangSync`, KDS sync, and browser receipt
`lang`/`dir` paths will emit `lang="ru-RU" dir="ltr"` without a new
direction layer.

### Security/privacy challenge

**Risk:** translation retrieval or telemetry could expose customer data.
**Resolution:** JSON is committed and packaged locally; no network lookup,
credential, or customer value enters the translation path. Print warnings
continue to carry bounded language codes and existing privacy-safe failure
classes.

### QA/release challenge

**Risk:** generated assets drift, cached locale chunks are missing, or setup
seeds silently remain English. **Resolution:** run `npm run i18n:check`,
`npm run test:locale-chunks`, `npm run test:phase6-locale-loading`,
`npm run test:phase7-setup-i18n`, `npm run test:print-labels`,
`npm run test:print-kernel`, `npm run test:print-parity`, focused browser/
phase7 coverage, lint, and builds. Inspect generated drift and final status
before delivery.

### Scope/YAGNI challenge

**Challenge:** a new font, Cyrillic code page, country profile, or locale
preference panel would be a separate product/architecture change. **Decision:**
do not add one. Russian UI support uses the existing browser system fonts and
existing capability-gated print path; native printer limitations remain
visible and explicit.

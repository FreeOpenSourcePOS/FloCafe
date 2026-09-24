# Hindi language support: research, specification, and delivery plan

Status: implementation and validation plan for `hi-IN` UI and print-label support
Prepared: 2026-09-24
Base reviewed: `a2b0419b` (current `origin/main`, including PRs #846 and #847)

## 1. Research findings

### 1.1 Locale registry and runtime ownership

`frontend/src/lib/i18n/languages.ts` is the only registry of supported UI language keys. Each entry owns:

- the stable language key (`hi` for Hindi);
- a canonical BCP-47 locale tag (`hi-IN`);
- the native endonym shown in Setup and Settings;
- `ltr` or `rtl` direction;
- whether the language is selectable;
- a dynamic loader for one canonical message bundle.

`LANGUAGES` order is also the canonical order consumed by the print-label generator. Adding a key to the registry makes the language visible to the registry-derived UI selectors, browser preference detection, standalone KDS synchronization, frontend print-language validation, and the generated backend print-language table. No parallel Hindi list is needed.

The active locale is loaded by `frontend/src/lib/i18n/loader.ts`. English is synchronously cached as the cold-boot fallback. Other bundles are dynamically imported, deduplicated while loading, cached after success, and surfaced to the caller on failure. The loader must remain local and lazy: no runtime translation service, network fetch, telemetry, or locale CDN is acceptable.

`I18nProvider` resolves the persisted Zustand value, then browser preference, then English. A failed load leaves the last successfully rendered language active. The `pos-settings` persisted store already carries the language value, so Hindi persistence requires no migration or new state field.

### 1.2 Canonical translation source and validation

`frontend/src/lib/i18n/messages/en.json` is the canonical schema. It currently has 2,639 leaf strings across 30 namespaces. Every registered locale must have exact leaf parity, non-empty string leaves, valid ICU, identical argument names and selectors, and identical rich-text tags.

The repository-native integrity test is `tests/translations.test.ts`, exposed as `npm run test:translations` and `npm run i18n:check`. Recent language additions also added a language-specific identical-value/placeholder guard. Hindi needs the same guard, with a small allowlist limited to brands, protocol names, measurements, example placeholders, pure format strings, and values that are genuinely shared in Hindi.

The Hindi source must therefore be edited only at `frontend/src/lib/i18n/messages/hi.json`. Keys, ICU arguments, selectors, and tags are not negotiable. Technical identifiers and printer protocol literals stay in their existing form. Values that look untranslated must be reviewed rather than hidden in an overly broad allowlist.

### 1.3 Setup, persistence, and standalone surfaces

Setup derives selectable options from `LANGUAGES` and orders the browser-detected language first. The selected value is written both to the local Zustand store and `/api/settings/language`; the backend returns it in the tenant snapshot. Standalone KDS and Server App surfaces call the server info synchronization hook and only accept registered language keys. These existing paths cover Hindi selection and persistence without new API fields or migrations.

Backend setup/demo seed data has a separate `SeedLanguage` union and explicit labels in `main/routes/auth.ts`. That is a real second localization surface, not a fallback: omitting `hi` from this union would silently seed English demo data after a Hindi Setup selection. Hindi express and demo catalogs, products, customers, and staff names need explicit localized branches. The selected country remains an independent input to phone normalization and currency behavior.

### 1.4 Print architecture and renderer boundaries

The print system has four distinct output paths:

| Path | Script behavior for Hindi | Existing owner |
| --- | --- | --- |
| Browser receipt HTML and browser KOT | Chromium performs Unicode shaping, line breaking, and fallback-font selection | `frontend/src/lib/printer/web-print.ts`, `kot-web-print.ts` |
| Direct ESC/POS and OS RAW transports | Profile capabilities decide representability; generic profiles do not claim Devanagari support | `main/printers/thermal.ts`, `shared/print/thermal-capabilities.ts` |
| WebUSB receipt/KOT and tax-bill encoders | Same capability/warning contract for migrated paths, with documented legacy raw exceptions | `frontend/src/lib/printer/receipt-encoder.ts`, `kot-encoder.ts`, `tax-bill-encoder.ts` |
| Raster `GS v 0` | Hidden Chromium can shape and render Unicode when a profile enables raster; the current profiles use local fallback fonts unless a bundled font is configured | `main/printers/raster-renderer.ts` |

Canonical receipt and KOT labels are extracted from the message JSON by `scripts/generate-print-labels.cjs` into the committed derived file `main/print/print-labels.generated.ts`. The generated file includes the `print.*` namespace and an audited borrowed-key manifest. It is not a second translation source. The required workflow is:

```text
edit messages/hi.json -> npm run generate:print-labels -> commit generated output
```

The generated table is also the backend registry used to validate stored receipt, KOT, and Z-report language policies. Unknown languages still fall back to English at the print-label boundary.

Direct thermal printing is not made magically Indic-capable by adding a locale. Shipped profiles remain conservative, and unsupported financial rows are refused before transport. Hindi labels therefore require an explicit warning or browser-print fallback on unsupported hardware; the implementation must not claim raw Devanagari output where no profile evidence exists.

### 1.5 Devanagari shaping, measurement, and fonts

Devanagari is an LTR script, but it is not a simple Latin code page. Correct rendering involves contextual shaping, conjuncts, matras, reordering, and grapheme-cluster boundaries. A direct thermal printer without Indic shaping/font support may output boxes, isolated forms, or missing text. The existing `arabicShaping` switch is Arabic-specific and must not be reused for Hindi.

The UI already uses browser-native Unicode shaping, but the font stacks name only Latin/CJK/Arabic fallbacks. Hindi should be supported through platform-local fallback names (`Noto Sans Devanagari`, `Nirmala UI`, and macOS Devanagari families) without downloading a font at runtime. The raster renderer accepts an optional bundled local font data URL and otherwise uses local fallback families; it refuses remote font sources. Current printer profiles already enable the raster capability without a Hindi-specific font, so this change does not toggle profile capabilities. A hardware-specific claim requires a real printer and font probe.

The shared width/truncation logic on current `main` is already grapheme-safe with a code-point fallback for runtimes without `Intl.Segmenter`; Hindi must preserve that shared implementation and add only a focused Devanagari regression test. This is a small correctness fix in the existing measurement owner, not a Hindi-specific print architecture.

The browser print HTML should include the same local Devanagari fallback families and retain normal browser line breaking. Browser HTML remains the honest full-Unicode path when direct thermal capability is absent.

### 1.6 Numbers, currency, dates, and plurals

`hi-IN` is a valid canonical locale. UI date/time presentation uses the active `Intl` locale through `use-intl` and `useFormatDate`, while tenant country, currency, timezone, and digit preferences remain authoritative and decoupled. The UI locale therefore changes month/date wording and presentation, not store currency or tax math.

Hindi translation strings must preserve ICU plural branches even though Hindi commonly uses the same lexical noun with different number agreement. The existing `one`/`other` selector shape must remain intact. Amounts and identifiers remain data, not translated strings. `Ltr`/bidi isolation remains relevant for phone numbers, order IDs, email addresses, URLs, IPs, and currency/number strings inside otherwise LTR or RTL documents, but Hindi itself must set `dir="ltr"`.

The POS glossary should use common restaurant terms consistently:

- order: `ऑर्डर`;
- table: `टेबल`;
- item: `आइटम`;
- addon: `एड-ऑन`;
- bill/receipt: `बिल`;
- payment: `भुगतान`;
- subtotal: `उप-योग`;
- grand total: `कुल योग`;
- tax: `कर`;
- customer: `ग्राहक`;
- kitchen: `रसोई`;
- print: `प्रिंट`;
- save: `सहेजें`.

Use `खाता`, `प्रिंटर`, `सर्वर`, `सेटिंग`, `डैशबोर्ड`, and other familiar UI loanwords consistently rather than switching synonyms. Do not translate product or merchant data stored in the database; only catalog labels and system messages are localized.

### 1.7 Offline, privacy, and security properties

The Hindi bundle is a committed JSON asset and is code-split into the packaged frontend. It contains no network URL, credential, tenant data, or runtime fetch. Dynamic import uses the existing local asset path. Adding a language must not alter cloud synchronization, telemetry, support payloads, printer error payloads, or the opt-in nature of optional network features.

Print warnings must continue to use the existing stable, privacy-safe warning classes. A Hindi label must not cause raw printer errors, customer data, or translated text to be sent to telemetry. Security behavior is unchanged: language policy values are validated against the generated registered-language table, HTML output continues to escape merchant data, and the raster surface remains sandboxed and accepts no remote font source.

## 2. Historical addition review

The recent additions establish the expected complete inventory and show that terminology and cross-surface assertions need follow-up review:

- Simplified Chinese (`39dda6bb`) added the registry, full message bundle, seed branches, generated labels, tests, and docs. Follow-up `855c7aaf` corrected the KOT wording to `厨房订单`, demonstrating that print concepts need semantic review rather than literal UI translation.
- Japanese (`435f40dc`) added the same core surfaces and explicitly touched browser print font behavior and print-kernel coverage. This is the closest precedent for a non-Latin script, but Japanese print support still depends on actual font/printer capability.
- Italian (`3fe19537`) added full UI, seed, print, and test coverage. Follow-up `8c929047` corrected a Server App string, showing that every surface in the canonical bundle must be reviewed.
- Korean (`7e1c3b51`) added the registry, bundle, seeds, generated labels, and cross-language assertions. Follow-up `b30e819e` corrected addon-group terminology, reinforcing a fixed POS glossary.
- Bahasa Indonesia (`529039e1`) added the same inventory. Follow-up `0d7f9d75` aligned an Indonesian print label, reinforcing that generated print output and visible browser labels must be tested together.
- Arabic (`5a42954c`) added RTL support, a localized README, seed data, and setup hydration fixes. Follow-ups `cb92dc1f` and `81862464` restored runtime behavior and localized demo customers. Hindi is LTR, so it must not import Arabic-specific shaping, hydration, or RTL changes.
- After the shared fixes landed in PRs #846 and #847, Hindi retains the shared order-slip direction and grapheme behavior without adding a language-specific JavaScript chunk. Post-build offline verification confirmed one local lazy chunk for each non-English locale, with no external URL. Pre-publication offline verification used Node's built-in fetch because the sandbox has no `python3` executable.

The common failure mode is a translation that is structurally valid but semantically wrong on a secondary surface. Hindi review must explicitly inspect Setup, Settings, auth/recovery, KDS, Server App, print-test, receipt, KOT, Z-report, error/warning, report/export, and WhatsApp strings.

## 3. Concrete specification

### 3.1 Runtime contract

- Registry key: `hi`.
- Locale: `hi-IN`.
- Native name: `हिन्दी`.
- Direction: `ltr`.
- Selectable: `true` after translation and regression review.
- Dynamic loader: `./messages/hi.json`.
- No new API, database column, translation service, remote font, CDN, telemetry, or dependency.
- Existing persisted `pos-settings.language` stores `hi` unchanged.
- Existing server settings and KDS synchronization accept the registered key through existing paths.

### 3.2 Message and terminology contract

- `hi.json` has exactly the English leaf set and preserves every ICU argument, selector, and tag.
- Use the POS glossary above across all namespaces.
- Translate user-facing errors, dialogs, labels, setup copy, status text, report/export labels, print labels, and warning guidance.
- Keep brand names, protocol names, measurements, currency codes, example identifiers, and pure format strings shared only where the allowlist explicitly documents why.
- Use natural Hindi sentences, not word-for-word English. Preserve technical identifiers such as KOT, QR, USB, WebUSB, SKU, HSN, API, CSV, XLSX, UPI, FloCafe, FloAdmin, and RevFlo.
- Do not translate stored business data or customer-provided names.

### 3.3 Printing contract

- `printLabel('hi', concept)` resolves every generated print concept and falls back to English only for an unknown language.
- Browser receipt and KOT HTML declare `lang="hi-IN"` and `dir="ltr"`, include local Devanagari font fallbacks, and preserve complete grapheme clusters when wrapping.
- Direct ESC/POS continues to use profile capabilities. Hindi does not enable Arabic shaping and does not turn on raster for a profile.
- Unsupported Hindi thermal lines retain explicit warnings; unsupported financial units retain the existing refusal-before-transport rule.
- Hindi does not change raster capability flags. The current profiles use the existing local fallback-font path; this change adds Devanagari fallback names but does not claim hardware-specific Indic support without a real printer and font probe.
- Shared width/truncation logic on current `main` is already grapheme-safe with a code-point fallback for runtimes without `Intl.Segmenter`; preserve that implementation and cover Devanagari boundaries in the focused tests.

### 3.4 Acceptance criteria

1. `npm run i18n:check` passes with 17 registered languages and 2,639 Hindi leaves, with exact English parity.
2. `main/print/print-labels.generated.ts` is regenerated and drift-free, while preserving the shared grapheme-safe implementation from current `main`.
3. Hindi appears in Setup, Settings, auth, dashboard, POS, orders, products, inventory, tables, KDS, Server App, print-test, reports, support, and print warnings through the canonical bundle.
4. Express and demo Setup seeds are Hindi-localized, while country selection remains independent.
5. Browser receipt/KOT HTML renders Hindi LTR, correct `hi-IN` metadata, localized labels, and readable long text.
6. Direct thermal and WebUSB tests demonstrate either localized representable output or the existing explicit warning/refusal behavior, without claiming unsupported hardware support.
7. Grapheme tests cover Devanagari combining marks and conjunct boundaries at narrow widths.
8. No network reference, secret, unrelated file, generated-file manual edit, or historical localization regression is introduced.

## 4. Implementation plan

1. Add `hi` to the canonical registry and create the complete `hi.json` bundle from the English schema.
2. Add Hindi to the backend setup seed language union, express labels, demo categories/products/customers/staff names, and focused seed assertions.
3. Preserve current `main`'s grapheme-safe shared width primitive and add narrow-width Devanagari tests.
4. Add local Devanagari fallback families to the app and browser print font stacks without introducing a remote font.
5. Regenerate `main/print/print-labels.generated.ts` through its owner script.
6. Extend translation integrity, print-label, print-regression, locale-loading, RTL/LTR metadata, error-surface, setup/print-test, and chunk-loading coverage where language inventories are explicit.
7. Update maintained language lists in `README.md`, `CONTRIBUTING.md`, and `docs/i18n.md`; add the Hindi-specific limitations and print evidence to the existing printing documentation rather than creating a Hindi-specific architecture.
8. Run focused tests first, then the required lint, backend build, frontend build, i18n check, print/raster checks, and available E2E/manual checks. Inspect the complete diff against `origin/main` before committing.

No step introduces a new abstraction. The plan reuses the existing registry, loader, cache, generator, policy, print, and validation owners.

## 5. Challenge reviews

### 5.1 Product challenge review

**Challenge:** Is Hindi a UI language only, or does selecting it imply Indian currency, tax rules, phone rules, or regional defaults?

**Finding:** The product decision and existing code require strict decoupling. `hi-IN` controls presentation language only. Store country, currency, timezone, tax pack, and phone normalization remain independently selected and persisted.

**Verdict:** Proceed with `hi-IN` as a presentation locale. Do not add an India tax pack, country fallback, or currency rule as part of this task.

**Risks and mitigations:** A user may expect Hindi to imply India. Setup and Settings already explain the separation; the Hindi messages must retain the existing country, currency, and tax wording rather than implying a country switch.

### 5.2 Engineering and architecture challenge review

**Challenge:** Could a Hindi bundle, font, shaping library, or print path require a second architecture?

**Finding:** The registry and generated print-label view already support any registered language. Browser Chromium performs Unicode shaping. Direct thermal capability is profile-owned, and raster already has a typed local-font boundary. A new Hindi-specific loader, remote service, or hardcoded language union would duplicate existing ownership.

**Verdict:** Proceed through the existing source of truth. Current `main` already provides grapheme-safe width measurement; Hindi must preserve that shared implementation and cover it with Devanagari-focused tests.

**Risks and mitigations:** `Intl.Segmenter` availability varies by runtime. Keep a code-point fallback and test it. Do not enable raster or claim Indic thermal support without hardware evidence.

### 5.3 QA and translation challenge review

**Challenge:** Does structural parity guarantee a usable Hindi experience across every surface?

**Finding:** No. ICU parity catches malformed variables but not awkward terminology, missing Setup seeds, wrong print concepts, or fallback-to-English values. Recent language follow-ups found exactly these classes of defects.

**Verdict:** Require full leaf translation, a Hindi identical-value guard, explicit seed assertions, browser receipt/KOT assertions, print-label assertions, locale chunk checks, and manual review of high-risk namespaces. Review all generated print labels after regeneration.

**Risks and mitigations:** A large bundle can hide untranslated values. The guard and an allowlist with comments force intentional exceptions. Long Devanagari text can overflow. Grapheme tests, browser visual checks, and width coverage catch truncation.

### 5.4 Security and privacy challenge review

**Challenge:** Does adding a locale or font create a network, injection, secret, or data-exfiltration path?

**Finding:** A committed JSON import is local, dynamic, and code-split. The app has existing HTML escaping and print-policy validation. Font fallback names do not fetch resources. No translation values contain customer data or credentials.

**Verdict:** Proceed without a new dependency or service. Keep print warnings privacy-safe, preserve the sandboxed raster boundary, and verify that the generated locale chunk has no external URL.

**Risks and mitigations:** A malformed translation could inject rich-text tags or controls. Existing ICU/tag and HTML escaping checks must pass. Do not put URLs, tokens, or tenant-specific examples in the bundle.

### 5.5 Release and operations challenge review

**Challenge:** What could make a Hindi release fail on a supported desktop, network KDS, browser print, or thermal printer?

**Finding:** Desktop and browser platforms normally provide a Devanagari fallback, but exact glyph coverage and line metrics vary. Generic ESC/POS profiles are ASCII-only. KDS/Server App language sync depends on the server snapshot and cached chunk. Static export and packaging must include the Hindi chunk.

**Verdict:** Release the UI and browser paths with explicit printer limitations. Require the frontend static build and locale-chunk test, run backend/print suites, and record manual browser and printer evidence. Do not change profile-owned raster capabilities or promise raw Hindi ESC/POS support in this change.

**Risks and mitigations:** A platform without a Devanagari font could show fallback glyphs. Add local font-family names and document the limitation. A failed chunk load must retain the existing English fallback and actionable warning. A printer that cannot represent Devanagari must not silently omit financial content.

## 6. Verification record

The implementation was verified on the task worktree. After rebasing onto `origin/main` commit `a2b0419b`, the current post-rebase validation was:

| Check | Result |
| --- | --- |
| `npm run i18n:check` | PASS - 17 registered locales, 2,639 leaves per locale, ICU/tag/placeholder parity, generated-label drift check, and frontend TypeScript check |
| `npm run lint` | PASS - 0 errors; existing repository warnings remain (1,000 backend warnings and 5 frontend warnings) |
| `npm run build` | PASS - backend TypeScript compile and runtime asset copy |
| `npm run build:frontend` | PASS - Next.js static desktop export |
| `npm run test:print-kernel` | PASS - policy, direction, bilingual layout, grapheme-safe Devanagari width, and language-policy suites |
| `npm run test:print-labels` | PASS - 96 assertions and 17-locale cross-path print regression matrix |
| `npm run test:thermal-capabilities` | PASS - explicit unsupported-Devanagari warning and profile capability behavior |
| `npm run test:raster` | PASS - raster encoder plus Electron Chromium renderer, including a Hindi system-font rendering assertion |
| `npm run test:phase7-setup-i18n` | PASS - 17 locales, Hindi express/demo seed data, country decoupling, print labels, and fallback checks |
| `npm run test:locale-chunks` | PASS - 16 non-English locales each have one distinct lazy offline chunk with no external URL; Hindi chunk is `5405.903262b40cfec42c.js` |
| `npm run test:locale-chunks` | PASS - Hindi is one distinct lazy offline chunk with no external URL |
| `npm run test:browser-receipts` | PASS - 63/63, including Hindi `hi-IN` LTR browser receipt labels |
| `npm run test:i18n-audit-remediations` | PASS - 47/47, including Hindi metadata and all message files |
| `npm run test:decoupled-ui-locale` | PASS - Hindi `hi-IN` date/time presentation and receipt artifact |
| `npm run test:issue-241-localized-errors` | PASS - 32 visual evidence artifacts, including Hindi error/toast surfaces |
| `npm run test:rtl-foundation && npm run test:rtl-setup-auth-settings && npm run test:rtl-dashboard-pos-common && npm run test:rtl-kds-server-whatsapp` | PASS - Hindi is covered as an LTR registered language and `hi-IN` browser preference resolves correctly |
| `npm run test:print-parity` | PASS - 555 semantic/byte parity assertions |
| `npm run test:e2e:browser` | PASS - 76/76 Playwright browser tests; the print-test spec covers Hindi labels |
| `npm test` | PASS - full repository suite completed with no test failure; existing informational test output, expected timeout-path logging, and lint warnings remain |
| `git diff --check` | PASS |

Manual browser verification used the current local E2E server and native `agent_browser`. Hindi was selected in the Settings language control, and the live document metadata reported `lang="hi-IN"` and `dir="ltr"`. The print-test page displayed `मूल रसीद (थर्मल)`, `विस्तृत कर बिल (थर्मल)`, `KOT (रसोई टिकट)`, `वेब प्रिंट (ब्राउज़र)`, and `WhatsApp शेयर`; the standalone KDS displayed `रसोई डिस्प्ले` with Hindi stage controls; the Server App login and table/order surface were localized after login. Screenshots were saved at `/tmp/flocafe-hindi-print-test.png` and `/tmp/flocafe-hindi-kds.png`.

Manual browser verification was performed after rebasing onto the current `origin/main` base. Physical printer validation was not performed because no supported ESC/POS hardware was attached. The capability tests and documentation preserve the honest limitation: generic native profiles do not claim Devanagari shaping, while the existing local-font raster path was exercised successfully in Electron. A real printer/photo probe remains required before claiming hardware-specific Hindi support.

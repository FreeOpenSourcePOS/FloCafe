# Vietnamese language support research, specification, and implementation plan

**Status:** CURRENT - investigated against `main` at `3ad0dd54e3d4e9ff42ef8350b579eeaea2851d05` on 2026-09-25 and implemented through the existing localization and print-generation paths. No unresolved product, architecture, security, or credential decision remains.

## Research report

### Current localization architecture

FloCafe has one repository-native localization path:

1. `frontend/src/lib/i18n/messages/en.json` is the canonical 2,639-leaf message schema.
2. `frontend/src/lib/i18n/languages.ts` is the registry of language keys, canonical BCP-47 presentation locales, endonyms, direction, selectability, and dynamic imports.
3. `frontend/src/lib/i18n/loader.ts` bundles English eagerly and lazy-loads, deduplicates, and caches every other locale.
4. `frontend/src/lib/i18n/browser-language.ts` maps the primary subtag of `navigator.languages` to a registered selectable key. A `vi-VN` browser preference therefore resolves to `vi` once registered.
5. `frontend/src/store/pos-settings.ts` persists the UI language locally under `pos-settings`; authenticated tenant `settings.language` synchronizes it through the auth store. Settings writes persist the same tenant value used by the standalone KDS and Server App.
6. Setup, Settings, receipt policy, KOT policy, print bootstrap, and standalone surfaces all derive their options from the central registry. A new registry entry therefore reaches those surfaces without per-component allowlists.
7. `main/print/print-labels.generated.ts` is a committed derived backend view of the canonical `print.*` and audited borrowed keys. `npm run generate:print-labels` is the only supported way to update it.
8. `tests/translations.test.ts`, `npm run i18n:check`, `npm run test:locale-chunks`, the phase 6/7 suites, and print-label tests enforce registry/file parity, exact leaf parity, ICU variables/selectors/tags, offline chunks, policy loading, seed data, and generated print-label freshness.

The current English fallback behavior is deliberate: unknown print languages resolve through generated `printLabel()` to English, malformed stored print policies resolve to the default policy, and a failed selected print-locale load is reported rather than silently treated as a successful Vietnamese load.

### Persistence, setup, and seed behavior

- Adding a locale requires no schema migration and no new persisted state. The existing `settings.language` value is a locale key and already syncs among desktop, KDS, and Server App.
- `main/routes/auth.ts` has a closed `SeedLanguage` union and a separate `resolveSeedLanguage()` fallback. `vi` must be added to both so new Express and demo setup data is Vietnamese rather than English.
- Setup/demo seed data is customer-visible business data, not translation chrome. The added data must use the existing `seedSetupProfile()` path, keep sample staff inactive, and continue accepting the owner's separately selected country for phone normalization.
- Existing database rows are never translated. The new locale affects only new setup seed profiles and subsequently selected UI/print presentation.

### Renderer, backend, and print boundaries

- Desktop renderer: React, Next.js static export, `use-intl`, and the shared registry/loader.
- Standalone KDS and Server App: the same frontend messages plus tenant language synchronization.
- Backend print policy validation: generated `PRINT_LABEL_LANGUAGES`.
- Browser receipts and browser KOT: full-Unicode HTML paths using canonical messages and `vi-VN` document metadata.
- WebUSB/native ESC/POS paths: generated print concepts plus existing capability-driven representability and warning/refusal behavior.
- Shared print kernel: remains language-union agnostic and receives registry facts from each caller; it must not import the frontend registry.
- PrintDocument v1, currency handling, tax calculations, and transport code require no language-specific branch.

### Evidence from recent language additions

The maintained pattern is consistent across:

- https://github.com/FreeOpenSourcePOS/FloCafe/pull/816 - Simplified Chinese, including the CJK web-print fallback and a full validation matrix.
- https://github.com/FreeOpenSourcePOS/FloCafe/pull/818 - Italian, including local seeds, generated labels, translation safeguards, and locale enumerations.
- https://github.com/FreeOpenSourcePOS/FloCafe/pull/819 - Korean, including an explicit no-new-font decision and broad offline/print/UI verification.
- https://github.com/FreeOpenSourcePOS/FloCafe/pull/820 - Bahasa Indonesia, including natural seed content and per-language fallback protection.
- https://github.com/FreeOpenSourcePOS/FloCafe/pull/823 - Japanese, including capability-gated thermal output and browser Unicode fallback.
- https://github.com/FreeOpenSourcePOS/FloCafe/pull/831 - Arabic, including setup hydration, RTL, generated labels, and seed integration.

Follow-up history supplies four concrete review rules:

- https://github.com/FreeOpenSourcePOS/FloCafe/commit/855c7aafd5e14b94abb09d9a0a4bf4382517ef91 corrected Chinese kitchen-ticket terminology and regenerated print labels.
- https://github.com/FreeOpenSourcePOS/FloCafe/commit/b30e819ec8021988fb637471819c23bfb3f07692 corrected a Korean add-on-group term across every related message.
- https://github.com/FreeOpenSourcePOS/FloCafe/commit/8c9290479d9c7273f49a8d546dfe2422e2570f0a corrected an Italian Server App message, showing why standalone surfaces need domain review.
- https://github.com/FreeOpenSourcePOS/FloCafe/commit/cb92dc1f4f79088fb61d876fdb2c76dfef13d8a2 restored Arabic runtime behavior after a broad locale change, showing the cost of unrelated configuration edits and the value of hydration tests.

Vietnamese must therefore receive one terminology pass across setup, products/add-ons, KDS, server/table-side ordering, print, and settings rather than isolated literal fixes.

### Vietnamese Unicode, measurement, and wrapping

- The smallest correct registry key is `vi`: ISO 639-1 for Vietnamese. `vn` is the country code and must not be used as the language key.
- The canonical presentation locale is `vi-VN`, which is a canonical BCP-47 tag and matches the existing country-specific locale convention used by regional locales.
- Vietnamese is a left-to-right Latin-script language. It needs no bidi or RTL code change.
- Vietnamese syllables can contain stacked tone and vowel marks. The committed translation must use NFC so common values such as `Tiếng Việt` and `Hóa đơn` are composed.
- Unicode UAX #29 defines extended grapheme clusters as user-perceived characters and states that boundaries do not occur within a combining sequence. UAX #15 defines NFC as canonical decomposition followed by canonical composition. See the references below.
- The shared native width helper segments extended grapheme clusters with `Intl.Segmenter` (and a conservative fallback), measures visible code points within each cluster, treats combining marks as zero-width, and preserves marks when truncating. A local baseline probe showed NFC and NFD `Tiếng Việt` both measure as 10 thermal display cells and wrap identically at 8 columns. Raster rendering uses grapheme granularity and canvas measurement.
- Vietnamese normally uses spaces between words, so the existing whitespace-first thermal wrapper is suitable. No locale-specific line-breaking dependency or print redesign is justified.

### Fonts and printing

- The root UI already has a system sans-serif fallback chain and the standalone Server App has Next.js-managed Inter plus global fallbacks. The web-print CSS also has a broad system font stack. Adding a remote font, font dependency, or network fetch would violate offline-first behavior and is unnecessary for Latin Extended Vietnamese coverage.
- Manual Chromium rendering must verify representative stacked marks (`ế`, `ệ`, `ượ`) in Setup, Settings, POS, Print Test, and browser receipt/KOT surfaces. A missing glyph or tofu box blocks release; ordinary font fallback does not.
- Generic and currently declared Latin ESC/POS profiles do not cover all Vietnamese characters. Local capability probes show `Món` and `Khách hàng` are CP437-representable, while `Tổng cộng`, `Hóa đơn`, `Thời gian`, `Tiền`, and `Ăn tại chỗ` are not representable by a currently declared native code page.
- The correct behavior is the existing capability contract: browser HTML remains full-Unicode, unsupported native text warns, and unsupported financial content refuses before transport. Accent-stripping would silently change Vietnamese meaning and is prohibited. Enabling a new printer code page, UTF-8 mode, bundled font, or raster profile requires model-specific hardware evidence and is outside this locale addition.

### Number, date, and currency behavior

- `vi-VN` is appropriate for `use-intl` date/time presentation. Current Node CLDR output uses Vietnamese month names and `d/M/y` ordering.
- UI locale does not choose tenant currency, number separators, or tax rules. Those remain country/currency-authoritative under `docs/regional-snapshot.md` and `docs/business-decisions.md`.
- Vietnam already has a country profile with `vi-VN`, `VND`, and `Asia/Ho_Chi_Minh`. No country or currency behavior changes are needed.
- A Vietnamese UI on a non-Vietnam store must continue displaying that store's currency and regional formatting. Translation strings must not hard-code `₫`, decimal separators, or thousands separators.

### Terminology contract

Use one POS glossary throughout UI, seeds, and print:

| Concept | Vietnamese term |
| --- | --- |
| POS | POS |
| order | đơn hàng |
| bill / invoice | hóa đơn |
| receipt | biên nhận when a short noun is needed; `hóa đơn` in customer-facing billing flows |
| product / menu item | sản phẩm / món |
| category | danh mục |
| add-on / add-on group | tuỳ chọn / nhóm tuỳ chọn |
| table | bàn |
| dine in | ăn tại chỗ |
| takeaway | mang đi |
| delivery | giao hàng |
| online order | đơn hàng trực tuyến |
| subtotal | tạm tính |
| grand total | tổng cộng |
| tax | thuế |
| discount | giảm giá |
| payment | thanh toán |
| amount | số tiền |
| customer | khách hàng |
| staff | nhân viên |
| owner | chủ cửa hàng |
| manager | quản lý |
| server | nhân viên phục vụ |
| chef | đầu bếp |
| kitchen ticket | phiếu bếp |
| inventory | kho |
| supplies | vật tư |
| recipe | công thức |
| floor / floor area | khu vực |
| shift | ca |
| refund | hoàn tiền |
| void | hủy |

Use formal, concise operational Vietnamese rather than machine-like literal fragments. Preserve FloCafe, FloPOS, POS, KDS, WhatsApp, WebUSB, ESC/POS, SKU, API, IP, CSV, XLSX, RevFlo, Orderflow, and technical examples where translation would be incorrect.

### Security and privacy

- The locale is a static JSON chunk with no runtime code, eval, remote fetch, credential, telemetry payload, customer record, or new network dependency.
- The offline chunk test is a release gate for this invariant.
- ICU parser and variable/tag parity checks prevent malformed interpolation. Rich text is limited to the existing message/tag contract.
- Demo data remains synthetic, staff accounts remain inactive with random password hashes, and phone/country behavior remains owner-selected rather than inferred from UI language.
- The `settings.language` request field is existing state. This task adds no migration and does not broaden authorization.

### Complete language-addition inventory

Required source and generated changes:

1. `frontend/src/lib/i18n/messages/vi.json` - all 2,639 canonical leaves, NFC, ICU/tag parity.
2. `frontend/src/lib/i18n/languages.ts` - `vi`, `vi-VN`, `Tiếng Việt`, `ltr`, `selectable: true`, dynamic import.
3. `main/routes/auth.ts` - `SeedLanguage`, `resolveSeedLanguage()`, Express labels, demo categories/products/customers/staff.
4. `main/print/print-labels.generated.ts` - regenerated only through `npm run generate:print-labels`.
5. `README.md`, `CONTRIBUTING.md`, and `docs/i18n.md` - current supported-language inventories and translator links.
6. `docs/vietnamese-language-support.md` - this research/specification/plan and final verification record.

Required maintained-language test updates follow the current addition pattern:

1. `tests/translations.test.ts` - Vietnamese placeholder, English-identical allowlist, live checks, and negative fixtures.
2. `tests/print-labels.test.ts` - explicit Vietnamese print assertions; registry-derived checks already enumerate every locale.
3. `tests/phase3-print-regressions.test.ts` - add `vi` and Vietnamese time/KOT label alternatives.
4. `frontend/e2e/phase7-setup-print-i18n.spec.ts` - visible Print Test labels.
5. `tests/browser-receipts.test.ts`, `tests/i18n-audit-remediations.test.ts`, `tests/rtl-dashboard-pos-common.test.ts`, `tests/rtl-kds-server-whatsapp.test.ts`, and `tests/rtl-setup-auth-settings.test.ts` - extend existing explicit locale matrices.

Registry-derived tests require no source enumeration change but are mandatory verification: `test:locale-chunks`, `test:phase6-locale-loading`, `test:phase7-setup-i18n`, `test:i18n-ssr-timezone`, and `test:decoupled-ui-locale`.

Explicitly out of scope: locale README translation, app-store metadata language declarations, country/tax profiles, currency behavior, RTL work, a new font, printer code pages/profiles, print architecture changes, database migrations, and localization redesign.

## Concrete specification

### Locale contract

- Registry key: `vi`
- BCP-47 presentation locale: `vi-VN`
- Endonym: `Tiếng Việt`
- Direction: `ltr`
- Selectable: `true`
- Lazy loader: `./messages/vi.json`
- Fallback: existing English behavior for invalid or failed locales; no Vietnamese-specific fallback state.

### Message contract

- Exactly 2,639 string leaves and no missing, duplicate, extra, empty, boolean, numeric, array, or object leaves.
- All values stored in Unicode NFC.
- Exact ICU argument names, selector names/types, and rich-text tags from `en.json`.
- Natural Vietnamese in formal POS register with the glossary above.
- English-identical values limited to brands, protocols, acronyms, units, examples, pure formats, and words that are genuinely identical, each justified in the test allowlist.

### Seed contract

- Express: Vietnamese labels for food, beverages, meal, tea, coffee, and snack.
- Demo: Vietnamese categories and products, three synthetic Vietnamese customer names, and localized inactive manager/cashier/chef display names.
- Existing country argument remains authoritative for phone/customer regional behavior.

### Print contract

- Canonical JSON is the only translation source.
- Backend labels are regenerated from the registry and never hand-edited.
- Browser print supports full Vietnamese Unicode.
- Native ESC/POS remains capability-gated and fail-closed for unsupported financial text.
- No new transliteration, code page, font, or profile is enabled without separate evidence.

### Data and compatibility contract

- No database migration or destructive operation.
- Existing stores and settings remain unchanged.
- New installs using Vietnamese UI receive Vietnamese sample seed content.
- No change to tax, currency, timezone, authorization, telemetry, networking, or transport behavior.

### Acceptance criteria

1. `vi` is selected from Setup and Settings and synchronizes to KDS/Server App.
2. Vietnamese browser preferences resolve to `vi`; document metadata is `lang="vi-VN" dir="ltr"`.
3. All 2,639 leaves pass parity, ICU, tag, and maintained-language fallback checks.
4. The locale is one isolated local chunk with no external URL and is not eagerly loaded.
5. New Express and demo setup data is Vietnamese, while country behavior remains independently selected.
6. Print-policy loading, generated labels, browser receipt/KOT labels, and WebUSB/backend capability paths cover `vi`.
7. Representative Vietnamese glyphs render in browser UI and browser print at common desktop widths.
8. Lint, backend/frontend builds, focused localization/print tests, E2E, full diff review, and status checks pass.

## Implementation plan

1. Scaffold with `npm run i18n:add -- vi` and register the locale in canonical order.
2. Translate the copied canonical JSON to NFC Vietnamese, preserving keys, ICU, tags, and the agreed glossary.
3. Add Vietnamese Express/demo seed data through the existing `SeedLanguage` path.
4. Run `npm run generate:print-labels`; never edit the generated module manually.
5. Add Vietnamese maintained-language safeguards, negative fixtures, and focused print/UI/standalone assertions.
6. Update supported-language documentation and explicit test matrices.
7. Run narrow checks first, then the repository-required broad checks.
8. Build and manually inspect Vietnamese Setup, Settings, POS, KDS/Server App, Print Test, and browser receipt/KOT surfaces through `chrome-devtools-axi` with network disabled where practical.
9. Review the entire diff for unrelated files, generated drift, secrets, English fallback, terminology drift, and NFC.
10. Commit, push only `fm/flocafe-vietnamese-language-support-r1`, open one ready-for-review GitHub PR, verify `isDraft=false`, and do not merge or run no-mistakes.

## Challenge reviews

### Product challenge

- **Challenge:** Is Vietnamese a UI locale, a country profile, or both?
- **Finding:** The request is language support. Vietnam regional support already exists and must remain independent.
- **Decision:** Add only the UI locale. Do not infer country, currency, timezone, or tax from Vietnamese selection.

### Architecture challenge

- **Challenge:** Could a new service, database key, print union, or per-renderer language list be needed?
- **Finding:** Every required boundary is already registry-driven. The print kernel deliberately avoids language unions and the backend view is generated.
- **Decision:** Reuse the registry, loader, persistence, seed union, and print generator. No new abstraction or service.

### Typography and printing challenge

- **Challenge:** Will every Vietnamese glyph work on every thermal printer and font?
- **Finding:** No. Current native profiles do not prove Vietnamese coverage, while browser rendering can use full Unicode.
- **Decision:** Preserve the established capability gate, verify browser glyphs, document native fallback/refusal, and avoid untested printer/font changes. Hardware expansion requires separate evidence.

### Translation-quality challenge

- **Challenge:** Could parser-valid strings still be poor Vietnamese?
- **Finding:** Yes. Recent Chinese, Korean, and Italian follow-ups were small terminology corrections.
- **Decision:** Use one explicit glossary, review every domain, prohibit English-identical values outside a justified allowlist, and record native-speaker review as residual release risk. Set `selectable: true` because the task requests complete support and no deterministic blocker remains.

### Security and privacy challenge

- **Challenge:** Does the locale introduce remote loading, executable translation content, or new personal data?
- **Finding:** No. The bundle is static and packaged; seeds are synthetic and staff stay inactive.
- **Decision:** Add no network service, dependency, credential, migration, or telemetry field. Enforce the offline-chunk gate and scan the final diff for secrets/URLs.

### QA and release challenge

- **Challenge:** Are green parity tests enough?
- **Finding:** No. They cannot prove terminology, glyph rendering, layout, or printer behavior.
- **Decision:** Add focused tests, run the full required matrix and E2E suite, inspect screenshots/browser output, verify generated drift, and disclose that physical native thermal printers were not available unless a test result proves otherwise.

### Baseline evidence

Before production edits, `npm run i18n:check`, `npm run test:print-labels`, `npm run test:phase6-locale-loading`, and `npm run test:phase7-setup-i18n` all passed on the 19-locale baseline. `npm ci` also completed in both root and frontend workspaces.

The implementation adds the `vi` / `vi-VN` registry entry, all 2,639 Vietnamese message leaves, localized Express/demo seed data, Vietnamese maintained-language safeguards, the registry-derived print table, focused UI/print/standalone assertions, and the current documentation inventory.

## Final verification record

- `npm run i18n:check` - passed; 20 registered locales, exact 2,639-leaf parity, ICU/selector/tag checks, Vietnamese NFC and fallback safeguards, generated print-label drift check, and frontend type-check all passed.
- `npm run test:print-labels` - passed; 119 print-label assertions and 19-locale phase 3 print regression matrix.
- `npm run test:phase6-locale-loading` and `npm run test:phase7-setup-i18n` - passed across all 20 locales, including Vietnamese seed data and browser/WebUSB locale loading.
- `npm run test:print-kernel` - passed, including NFC/NFD Vietnamese grapheme measurement and wrapping.
- `npm run test:browser-receipts`, `npm run test:i18n-audit-remediations`, and the three RTL/standalone focused suites - passed.
- `npm run test:locale-chunks` - passed; Vietnamese is a distinct lazy chunk with no external URLs and is not eagerly referenced by pages.
- `npm run lint` - passed with zero errors; the existing 1,000 backend warnings and five frontend warnings remain.
- `npm run build` and `npm run build:frontend` - passed.
- `npm test` - passed.
- `npm run test:e2e:browser` - passed, 76/76 tests.
- `git diff --check` - passed.
- Manual `chrome-devtools-axi` verification against the static export selected Vietnamese on Setup, rendered `Chào mừng đến với FloCafe` with real stacked diacritics, set `html lang="vi-VN" dir="ltr"`, and persisted `language: "vi"` in `pos-settings`. No native physical thermal-printer test was run; native printer capability behavior remains the documented fail-closed boundary.

## References

- FloCafe i18n guide: [`i18n.md`](i18n.md)
- FloCafe print architecture: [`printing-architecture.md`](printing-architecture.md)
- FloCafe non-Latin print decision record: [`printing-nonlatin-capabilities.md`](printing-nonlatin-capabilities.md)
- Unicode Text Segmentation, UAX #29: <https://www.unicode.org/reports/tr29/>
- Unicode Normalization Forms, UAX #15: <https://www.unicode.org/reports/tr15/>
- Unicode Line Breaking, UAX #14: <https://www.unicode.org/reports/tr14/>
- CLDR Vietnamese locale data: <https://github.com/unicode-org/cldr/blob/main/common/main/vi.xml>
- Next.js font API: <https://nextjs.org/docs/app/api-reference/components/font>

# Taiwan Traditional Chinese language support

**Status:** investigated and specified for the `fm/flocafe-zh-tw-language-support-r1` worktree. This document records the research, decision, implementation plan, and challenge reviews required before production changes. It is an implementation record, not a replacement for the runtime sources in [`docs/i18n.md`](../docs/i18n.md) or [`docs/printing-architecture.md`](../docs/printing-architecture.md).

## Decision summary

- Add a separate runtime key `zh-tw`, backed by [`frontend/src/lib/i18n/messages/zh-tw.json`](../frontend/src/lib/i18n/messages/zh-tw.json), with BCP-47 presentation locale `zh-TW`, native name `繁體中文`, direction `ltr`, and `selectable: true`.
- Keep the existing `zh` key, `zh-CN` locale, `简体中文` name, translations, persistence, and seed data unchanged. `zh` must continue to mean Simplified Chinese for existing stores and browser preferences.
- Use the lowercase regional key `zh-tw` in registry, settings, print-policy JSON, and filename paths. The runtime BCP-47 tag remains `zh-TW`; the key is an internal stable identifier and is not sent to `Intl` as a locale tag.
- Extend the existing scaffolder to accept a canonical lowercase regional key such as `zh-tw`, while retaining the atomic no-overwrite behavior. This is a narrow extension to the language-file workflow, not a new localization subsystem.
- Translate the complete canonical English schema into a separate Taiwan-oriented Traditional Chinese bundle. Preserve every JSON key, ICU argument/selector, rich-text tag, and technical/shared value.
- Regenerate [`main/print/print-labels.generated.ts`](../main/print/print-labels.generated.ts) through its owner. Do not hand-edit that file.
- Add Taiwan-oriented browser-print font fallbacks (`PingFang TC`, `Microsoft JhengHei`, `Noto Sans CJK TC`) without changing the existing Simplified Chinese stack.
- Do not change tax rules, country selection, currency authority, regional snapshots, or the RTL infrastructure. CJK shaping, raw thermal font coverage, and printer capability remain governed by the existing print architecture and its warnings/refusals.

No product or architecture blocker was found. The key choice follows the existing language-key contract, preserves every existing `zh-CN` installation, and uses the regional identity required for Taiwan formatting and terminology.

## 1. Research report

### 1.1 Current locale architecture

The current `main` baseline is commit `a42eb51d3ee660e259d713ad87b0ee3691feabed` (`origin/main` at investigation time). The current registry has 14 entries and the message directory has 14 JSON files. The canonical English bundle currently has 2,639 string leaves; `zh.json` has the same 2,639 leaves.

| Boundary | Current owner and behavior | Taiwan change |
| --- | --- | --- |
| Canonical messages | `frontend/src/lib/i18n/messages/en.json` defines the schema and leaf parity contract. | Create a full `zh-tw.json` with exact parity. Do not derive a partial file from the UI or print code. |
| Registry | `frontend/src/lib/i18n/languages.ts` owns the key, BCP-47 tag, native name, direction, selectability, and dynamic import. | Add `zh-tw` after `zh`; keep `zh`/`zh-CN` intact. |
| Lazy loading | `frontend/src/lib/i18n/loader.ts` primes English eagerly and deduplicates dynamic loads/caches them in memory. `I18nProvider` switches atomically and reverts on load failure. | The new import must remain dynamic, cached, and offline; no network loader is introduced. |
| Browser detection | `browser-language.ts` currently matches only the primary language, so `zh-TW` would incorrectly fall through to `zh`/`zh-CN`. | Match a candidate's regional/script locale before its primary-language fallback. `zh-TW` and `zh-Hant-TW` should select `zh-tw`; bare `zh` must remain Simplified `zh`. |
| Persistence | `pos-settings.ts` persists the language key; auth sync copies the tenant setting into the store. | `zh-tw` is a normal persisted value. Existing `zh` values are not migrated or rewritten. |
| Setup and settings | Setup, General Settings, and Printer Settings derive selectable options from `LANGUAGES`; no new hard-coded UI list is needed. | Registry addition exposes the new option automatically. |
| Seed/setup | `main/routes/auth.ts` resolves the selected UI language and seeds express/demo categories, products, customers, and staff. | Add a `zh-tw` seed arm. Country-provided phone normalization and regional settings remain independent. |
| Standalone KDS/server | Server info returns the stored language key; the renderer warms and uses the registered bundle. | The new key flows through existing synchronization and print-policy bootstrap. |
| Print policy | `shared/print/policy.ts` receives registry facts injected by frontend/backend bridges. `main/lib/print-language-settings.ts` uses generated print tables. | No new policy shape. Generated labels and policy validation must recognize `zh-tw`. |
| Print labels | `scripts/generate-print-labels.cjs` extracts the print namespace and audited borrowed keys from every registry locale into the committed generated module. | Add the bundle first, then regenerate and run `--check`; never copy labels into the generated module. |
| Browser receipts/KOT | `web-print.ts` and `kot-web-print.ts` use registry locales/messages and HTML escaping. | Add Taiwan font fallbacks and retain escaping, locale tags, and existing warning behavior. |
| Native thermal output | Capability profiles are conservative; CJK is not assumed representable by generic ESC/POS firmware. Unsupported non-financial text is warned/skipped and financial text is refused rather than silently lost. | Do not claim native CJK support or add a new code page. Raster/browser output remains the correct path until hardware evidence exists. |
| Validation | `tests/translations.test.ts`, locale chunk tests, phase 6/7 tests, print tests, and generator drift checks enforce parity, ICU/tag safety, loading, setup, and print coverage. | Extend the relevant dynamic matrices and add explicit Taiwan regression assertions. |

The existing architecture already supplies the required boundaries. The new work should be additive and registry-driven.

### 1.2 Simplified Chinese addition as evidence

The merged Simplified Chinese PR is [`https://github.com/FreeOpenSourcePOS/FloCafe/pull/816`](https://github.com/FreeOpenSourcePOS/FloCafe/pull/816). Its evidence is useful but not a template to copy without review:

- The original implementation commit (`874f081e`) registered `zh` with locale `zh-CN`, added the complete message bundle, extended auth seed data, updated print/auth/direction/translation tests, regenerated print labels, and documented the language.
- The merged follow-up (`855c7aaf`) changed the Chinese kitchen-ticket title/banner from `厨房订单单` to `厨房订单`. This demonstrates that POS terminology needs a native-language review, not only character conversion.
- The PR's QA evidence covers setup switching, persistence, `zh-CN` metadata, LTR layout, localized seed data, browser/KDS surfaces, receipt labels, and the grand-total label. It also records that country selection remains independent of UI language.
- The PR added Simplified CJK browser-print font fallbacks. The Taiwan change must add a distinct Taiwan stack rather than replacing that stack.
- The PR's generated labels were owned by the generator and its tests checked drift. The same ownership rule applies here.

The current tree has evolved since that PR: the canonical schema is now 2,639 leaves, and newer language additions have added more language-specific test coverage. The new implementation must validate against the current tree, not the old PR's counts.

### 1.3 Correct Taiwan identity

`zh-TW` is the correct BCP-47 tag for Chinese as used in Taiwan. Local runtime evidence from Node's `Intl` implementation is:

| Input | Canonical tag | Maximized tag | Relevant presentation difference |
| --- | --- | --- | --- |
| `zh` | `zh` | `zh-Hans-CN` | Simplified default; preserve existing `zh` behavior. |
| `zh-CN` | `zh-CN` | `zh-Hans-CN` | Existing Simplified Chinese locale. |
| `zh-TW` | `zh-TW` | `zh-Hant-TW` | Traditional script and Taiwan conventions. |
| `zh-Hant-TW` | `zh-Hant-TW` | `zh-Hant-TW` | Same Taiwan identity with an explicit script subtag. |

`Intl.DateTimeFormat('zh-TW', ...)` produces Taiwan-style date/time ordering and wording, while `zh-CN` produces the Simplified presentation. Both use Western digits in this runtime. `Intl.NumberFormat('zh-TW', ...)` uses the same grouping and decimal separators in this runtime, but locale-aware date presentation still differs. The locale tag is therefore meaningful even though currency is country-owned.

The internal key `zh-tw` is distinct from the BCP-47 tag and follows the repository's lowercase filename/key convention. A generic primary-language-only match is insufficient: it would make a Taiwan browser select `zh`/`zh-CN`.

### 1.4 Taiwan terminology and glossary

The bundle should use a consistent Taiwan POS/software vocabulary rather than a literal character conversion. The following glossary is the baseline for review; the full bundle must be checked for the same concepts.

| Concept | Preferred Taiwan wording | Notes |
| --- | --- | --- |
| Traditional Chinese | `繁體中文` | Registry endonym; keep `zh-CN` endonym `简体中文` separate. |
| Restaurant | `餐廳` | Use for the business type and setup copy. |
| POS / checkout | `POS` / `結帳` | `結帳` is the checkout verb, not `結賬`. |
| Bill / receipt | `帳單` / `收據` | Keep bill, receipt, and invoice concepts distinct. |
| Invoice | `發票` | Do not translate as a generic tax form where the product means invoice. |
| Kitchen ticket | `廚房單` or `廚房訂單` | Use the same short label in the print catalog and UI; avoid a doubled `訂單單`. |
| Menu | `菜單` | Prefer the restaurant noun over a generic software-menu noun for catalog screens. |
| Order | `訂單` | Stable across POS, KOT, server app, and reports. |
| Dine-in / takeaway / delivery | `內用` / `外帶` / `外送` | Taiwan restaurant terminology; do not retain `堂食` or `外賣`. |
| Cashier / cash | `收銀` / `現金` | Preserve as a distinct product concept. |
| Customer | `顧客` for the person; `客戶` only where the source explicitly means a customer/account relationship. | Do not flatten all contexts mechanically. |
| Account / user | `帳戶` / `使用者` | Taiwan usage; do not use mainland `賬` forms. |
| Software / server | `軟體` / `伺服器` | Software terms should not remain `軟件`/`服務器`. |
| Print / printer | `列印` / `印表機` | Browser, thermal, and settings labels should agree. |
| Database / data | `資料庫` / `資料` | Avoid `數據` in product copy. |
| Default / setting / load / save | `預設` / `設定` / `載入` / `儲存` | Use the same terms across setup, settings, and errors. |
| Network / online / offline | `網路` / `線上` / `離線` | Network and connection wording should be consistent. |
| Refund / payment / cashback | `退款` / `付款` / `付款` or `回饋` by context | `Cashback` is a loyalty concept; do not silently change financial meaning. |
| Stock / inventory | `庫存` / `庫存` | Use the existing product namespace consistently. |
| Report | `報表` | Stable for dashboard, Z-report, and settings. |
| Tax | `稅額` / `稅率` / `稅務` | Do not alter tax calculation or country behavior. |
| Backup / restore | `備份` / `復原` | Distinguish data restoration from password reset. |
| Technical/shared values | Preserve reviewed English, IDs, formats, protocol names, and placeholders | The translation validator may allow only the documented technical allowlist. |

The final review should search for mainland variants such as `軟件`, `服務器`, `打印`, `賬`, `結賬`, `選單` where a restaurant noun is intended, `小票`, `訪問`, `應用` used as a software noun, and `實時` where `即時` is clearer. A native Taiwan reviewer should sign off on customer-facing POS, tax, receipt, and settings wording before release; OpenCC-style conversion is only a drafting aid and is not a runtime dependency.

### 1.5 Fonts, shaping, measurement, and wrapping

- CJK ideographs are left-to-right text, so the registry direction is `ltr`; no RTL code or layout changes are needed.
- Traditional Chinese does not require Arabic contextual shaping. Unicode grapheme clusters still matter for combining marks, variation selectors, emoji, and future supplementary CJK characters.
- The raster renderer already uses `Intl.Segmenter` with `granularity: 'grapheme'` and canvas `measureText` before wrapping. This is the correct boundary for pixel-accurate CJK text. The shared native width helper iterates code points and charges CJK ideographs two thermal display cells; ordinary Traditional Chinese characters are normally BMP code points, but it is not a complete grapheme-cluster engine for every possible input.
- The native `truncate` and some legacy formatting paths still use string/code-unit operations. A broad change to all print measurement would be a printing redesign and is intentionally out of scope. The existing capability/refusal path and raster path are the safe boundaries.
- Browser receipt CSS currently names Simplified Chinese faces (`PingFang SC`, `Microsoft YaHei`, `Noto Sans CJK SC`). Add a Taiwan-specific fallback rule using `PingFang TC`, `Microsoft JhengHei`, and `Noto Sans CJK TC`, while leaving the existing `zh-CN` rule intact. The raster renderer should include Taiwan faces in its fallback list so a verified raster profile can render Traditional glyphs when a bundled font is not yet enabled.
- No font file is downloaded at runtime. A future bundled raster font remains a separate profile/font review because it changes package size, licensing, and hardware evidence requirements.

Relevant standards and project evidence:

- Unicode Text Segmentation, UAX #29: <https://www.unicode.org/reports/tr29/>
- Unicode line breaking, UAX #14: <https://www.unicode.org/reports/tr14/>
- Noto CJK font family and OFL licensing: <https://github.com/notofonts/noto-cjk>
- Epson ESC/POS `FS &` reference, which explicitly limits kanji mode by printer model and includes Traditional Chinese models: <https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/fs_ampersand.html>
- Current FloCafe capability study: [`docs/printing-nonlatin-capabilities.md`](printing-nonlatin-capabilities.md)

### 1.6 Currency, numbers, and regional boundaries

The locale registry controls UI/date presentation, not store currency or tax. `main/countries.ts` remains the authority for country locale, currency symbol, fraction digits, and timezone. The new `zh-TW` locale must not:

- change Taiwan's `TWD` or `Asia/Taipei` country profile;
- infer Taiwan from the selected UI language;
- make a Simplified Chinese store in another country use TWD;
- make a Taiwan UI change a store's tax, invoice numbering, or accounting calculations.

Browser receipt date formatting may use the active UI locale as an existing presentation override. Amount formatting continues to use the tenant/country profile. The runtime experiment showed `zh-TW` and `zh-CN` use the same Western grouping/decimal pattern in this environment but different date wording/order, and `zh-TW` uses a different narrow TWD symbol presentation. That difference is presentation data, not a reason to duplicate regional country logic.

### 1.7 Offline, security, and privacy review

- The message file is a static, committed asset. Its dynamic import must resolve to a packaged Next.js chunk with no external URL.
- The locale chunk test must prove the new chunk is distinct from every other locale and is not eagerly referenced by the initial page.
- English remains the eager fallback. A failed `zh-tw` load must leave the current active locale intact; print-policy warmup must report a failed locale rather than silently presenting English as `zh-tw`.
- Translation values are static UI text. They must not contain credentials, customer data, or runtime interpolation beyond the existing ICU variables. Product/customer strings are escaped by existing browser-print code.
- No external translation service, API token, remote font, or telemetry content is introduced.
- The backend language-policy parser is already registry-driven and rejects unknown selectable codes. The new generated table must be present before accepting `zh-tw` as a print policy.
- The existing wildcard settings endpoint is not a new security boundary for this feature. The language dropdown sends registry keys, and adding a key does not grant roles, access to orders, or tax privileges.

## 2. Concrete specification

### 2.1 Registry and source contract

Implement exactly one new registry entry:

```ts
'zh-tw': {
  locale: 'zh-TW',
  nativeName: '繁體中文',
  direction: 'ltr',
  selectable: true,
  load: () => import('./messages/zh-tw.json'),
},
```

Keep `zh` immediately before it with its current `zh-CN` identity. Do not rename, move, or rewrite `zh.json`.

The message file must:

1. Have exactly the same nested leaf keys as `en.json`.
2. Preserve all ICU arguments, plural/select selectors, and rich-text tags.
3. Use Taiwan terminology consistently.
4. Contain no `[TODO]`/`[TW]` placeholders.
5. Keep only reviewed technical/shared values identical to English.
6. Be translated from the canonical schema, with the existing Simplified bundle used as a reviewed drafting reference rather than copied as an unexamined duplicate.

### 2.2 Browser selection and persistence

- Exact/canonical regional matching must happen before primary-language matching.
- `zh-TW` and `zh-Hant-TW` select `zh-tw`; `zh` and `zh-CN` continue to select `zh`.
- Unsupported candidates continue to fall through in navigator preference order and ultimately English.
- A persisted `zh` value is not migrated. A newly persisted `zh-tw` value survives reload and auth sync like any other registry key.
- The server-provided language remains authoritative after auth; country remains independent.

### 2.3 Seed/setup contract

`main/routes/auth.ts` must recognize `zh-tw` and seed localized sample data for both express and demo profiles. The seed must include Taiwan Traditional Chinese labels for categories, products, customers, and staff while retaining the country-selected phone code and regional defaults. Filipino remains the only English-identical seed allowlist.

### 2.4 Print and browser contract

- The generated backend label table includes `zh-tw` in canonical registry order.
- `printLabel('zh-tw', ...)` resolves Traditional labels and unknown concepts still fall back to English.
- Browser receipt and KOT HTML retain `lang="zh-TW"`, LTR direction, existing escaping, and locale-aware date presentation.
- Taiwan font fallback names are additive; Simplified fallback names remain present for `zh-CN`.
- Native thermal CJK support is not enabled by this change. Existing warnings, financial-row refusal, and raster/browser fallbacks remain authoritative.

### 2.5 Explicitly out of scope

- No tax pack, country profile, currency, timezone, or regional-snapshot changes.
- No rewrite of shared print measurement, bidi, raster architecture, or printer profiles.
- No remote translation service, credentials, telemetry, or font download.
- No migration of existing `zh` users to `zh-tw`.
- No automatic language selection from store country.
- No translation of product data supplied by merchants; only the built-in seed data is localized.

## 3. Implementation plan

1. Add the research/specification record and update the documentation catalog.
2. Add the `zh-tw` message bundle from the canonical schema, apply the reviewed Taiwan glossary, and run ICU/leaf/placeholder checks locally.
3. Register `zh-tw` in `languages.ts`; extend regional-key validation in `scripts/i18n-add.cjs` and its documentation without changing existing primary-code behavior.
4. Update browser-language selection to prefer a matching regional/script locale and add explicit `zh-TW`/`zh-Hant-TW` regression coverage while proving `zh`/`zh-CN` remain unchanged.
5. Add the `zh-tw` seed branch in `main/routes/auth.ts` and strengthen phase 7 assertions for localized seed data.
6. Add Taiwan font fallbacks to browser receipt/KOT and raster fallback HTML, with tests that retain the Simplified stack.
7. Run the print-label generator, then add print-label and phase 3 print-regression assertions for the new generated table.
8. Extend the dynamic locale-loading, browser-receipt, LTR, translation-integrity, and chunk-splitting coverage where hardcoded locale lists are part of the contract.
9. Run the focused verification set, then the project minimum checks: `npm run lint`, `npm run build`, and `npm run build:frontend`; run locale/print/type tests and manual browser verification. Do not run `/no-mistakes`.
10. Inspect the complete diff, remove only task-created noise, commit one focused change, push only `fm/flocafe-zh-tw-language-support-r1`, and open one ready-for-review PR.

## 4. Challenge reviews

### Challenge 1: Locale-key collision

**Risk:** Using `zh` for Taiwan would replace `zh-CN`; using `zh-Hant` as the only key would lose the Taiwan region and could not be created by the current scaffolder.

**Resolution:** Use the distinct lowercase key `zh-tw`, BCP-47 locale `zh-TW`, and extend only the scaffolder's accepted canonical regional-key syntax. Keep `zh` untouched. This is the smallest safe persistence identity.

### Challenge 2: Browser preference regression

**Risk:** The current detector discards the region, so a Taiwan browser would silently receive Simplified Chinese.

**Resolution:** Resolve a canonical regional/script match before the primary-language fallback. Test `zh-TW`, `zh-Hant-TW`, `zh`, `zh-CN`, unsupported locales, and ordered `navigator.languages` fallback.

### Challenge 3: Mechanical conversion quality

**Risk:** Character conversion can leave `軟件`, `服務器`, `打印`, `賬`, `結賬`, or inappropriate `選單`/`小票` wording, as happened in the Simplified KOT follow-up.

**Resolution:** Use a Taiwan POS glossary, review core surfaces, add a scan for known mainland variants, and require the existing no-English-fallback/placeholder validator. A Taiwan native reviewer remains the release-quality gate for customer-facing wording.

### Challenge 4: Font and print capability

**Risk:** Adding Traditional labels to generated print tables does not make generic ESC/POS firmware contain CJK glyphs. Native text can be skipped or refused, especially for financial rows.

**Resolution:** Add only font fallback metadata/rendering support in browser/raster paths. Do not claim native printer support or alter capability profiles. Preserve the existing explicit warning/refusal contract and record physical-printer validation as a release follow-up.

### Challenge 5: Grapheme and wrapping safety

**Risk:** Code-unit slicing can damage future combining sequences, and CJK display cells differ from JavaScript string length.

**Resolution:** Keep the existing raster grapheme/canvas boundary, use the existing display-cell width helper for native layout, add CJK wrapping/font assertions, and do not expand scope into a shared print-engine rewrite. Any future general grapheme change requires a separate architecture review.

### Challenge 6: Offline and privacy regression

**Risk:** A new external translation/font source could make first use network-dependent or expose data.

**Resolution:** Commit static JSON, use the existing dynamic local import, add the new chunk to the offline/no-eager/external-reference test, and add no runtime dependency or network path.

### Challenge 7: Generated-file drift and partial implementation

**Risk:** Adding a registry entry without regenerating labels makes backend print policies reject or fall back unexpectedly; editing generated TypeScript by hand creates an unreviewable source of truth.

**Resolution:** Edit messages and registry only, run `npm run generate:print-labels`, commit the generated result, and require `--check` in `i18n:check` and print tests.

### Challenge 8: Scope and release risk

**Risk:** Country/currency/tax behavior could accidentally be coupled to UI language, and a large translation could hide unrelated regressions.

**Resolution:** Keep the locale bundle and registry-driven surfaces isolated, retain the country-independence tests, run focused print/locale suites plus lint/build/type checks, and review the final diff file by file.

## 5. Acceptance matrix

| Requirement | Evidence required |
| --- | --- |
| Separate Taiwan locale | Registry has `zh-tw`/`zh-TW`; existing `zh`/`zh-CN` remains byte/behavior compatible. |
| Complete translation | `npm run test:translations` passes exact parity, ICU, tags, placeholders, and Taiwan fallback checks. |
| Offline loading | Frontend build plus `npm run test:locale-chunks` shows one local lazy `zh-tw` chunk, not eagerly loaded, with no external refs. |
| Persistence and detection | Locale tests cover localStorage/auth/server sync and `zh-TW` browser selection. |
| Setup/seed | `npm run test:phase7-setup-i18n` covers localized `zh-tw` express/demo data and country independence. |
| Print labels | Generator drift check, print-label tests, and phase 3 regression matrix cover `zh-tw`. |
| Browser receipts/KOT | Browser receipt test confirms `lang="zh-TW"`, Traditional labels, no raw keys, and Taiwan font fallback names. |
| Native thermal safety | Existing capability tests remain green; no unsupported financial content is silently dropped. |
| Static checks | `npm run i18n:check`, focused tests, `npm run lint`, `npm run build`, and `npm run build:frontend` pass. |
| Manual evidence | Setup, Settings, POS, KDS, server app, browser receipt, and print-test surfaces are checked with `chrome-devtools-axi`; hardware print limitations are recorded. |

## References

- Existing i18n architecture and workflow: [`docs/i18n.md`](i18n.md)
- Print architecture and language behavior: [`docs/printing-architecture.md`](printing-architecture.md)
- CJK/non-Latin print capability study: [`docs/printing-nonlatin-capabilities.md`](printing-nonlatin-capabilities.md)
- Simplified Chinese implementation and QA evidence: <https://github.com/FreeOpenSourcePOS/FloCafe/pull/816>
- BCP 47 language tags: <https://www.rfc-editor.org/rfc/rfc5646.html>
- Unicode text segmentation: <https://www.unicode.org/reports/tr29/>
- Unicode line breaking: <https://www.unicode.org/reports/tr14/>
- Noto CJK fonts: <https://github.com/notofonts/noto-cjk>
- Epson ESC/POS kanji-mode reference: <https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/fs_ampersand.html>

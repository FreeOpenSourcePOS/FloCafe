# FloCafe Dutch language support - research and implementation brief

## Evidence and scope

- Task worktree: `/Users/gurkiratkhaira/.treehouse/FloCafe-f5cc04/11/FloCafe`
- Branch: `fm/flocafe-dutch-language-support-r1`
- Base: `a42eb51d3ee660e259d713ad87b0ee3691feabed` (`origin/main` at investigation time)
- The registry uses short lowercase ISO language keys, a BCP-47 presentation locale, an endonym, direction, selectability, and a dynamic JSON loader. The smallest consistent Dutch key is `nl`; the default locale should be `nl-NL` and the endonym `Nederlands`.
- The canonical message source is `frontend/src/lib/i18n/messages/en.json`. It currently has 2,639 string leaves across 30 top-level namespaces. All committed locale files are required to have exact leaf parity, valid ICU, identical argument/selector names, and identical rich-text tags.

## Current architecture

1. `frontend/src/lib/i18n/languages.ts` is the central registry. `en` is synchronously bundled in `loader.ts`; other locales are dynamic chunks with an in-memory cache and deduplicated in-flight loads. Failed loads remain on the previous language and do not silently replace the active bundle.
2. `I18nProvider` resolves persisted Zustand language first, then browser language, then English. `pos-settings` persists the selected UI language locally. Tenant language is returned by auth/setup/settings APIs and synchronized into the same store. Standalone KDS/Server App surfaces synchronize the tenant language through the server info endpoint.
3. Setup and Settings derive selectable options from the registry, so registering `nl` is sufficient to expose it in both UI language pickers. The backend stores the language setting as text; it does not encode a language union or alter country/currency/tax data.
4. `scripts/generate-print-labels.cjs` reads the canonical registry and message files, extracts print namespace and audited borrowed keys, and writes `main/print/print-labels.generated.ts`. Backend print policy validation accepts only generated print languages. The generated file must be regenerated, never hand-edited.
5. `main/routes/auth.ts` has an explicit seed-language union and localized Express/demo seed catalogs. A selectable language must be added there so setup/demo data is not silently English for Dutch users. The existing `fil` English-identical exception is not applicable to Dutch.
6. Existing automated coverage derives most locale matrices from `LANGUAGES`, while several focused print/RTL/browser suites use explicit language arrays and sample labels. Those arrays and print label assertions must be extended for Dutch.

## Translation and typography assessment

- Dutch is a left-to-right Latin-script language. It does not need RTL CSS or Arabic/Persian shaping changes. The existing bundled/system Latin fonts should cover the language; no new dependency or font asset is justified.
- Dutch labels are generally longer than English in several places. Browser layouts already use wrapping/truncation paths, and receipt/KOT renderers enforce paper columns. The implementation must preserve those paths and verify representative 58 mm and 80 mm receipts, KOTs, dialogs, setup cards, and POS screens.
- `nl-NL` gives Dutch date, number, and currency presentation defaults, while store currency, grouping, tax, and country remain tenant-authoritative. No currency or tax changes are part of this task. Thermal test fixtures must use a realistic Dutch label and existing country/locale test paths; do not infer EUR or a Dutch store country from the UI language.
- ICU strings must retain every variable, selector, and tag. Dutch plural messages can use the canonical `one`/`other` selectors; translated wording may use `#` and the same arguments. Technical identifiers, brand names, example credentials/IPs, and pure format strings should remain intentionally identical only where Dutch users expect the same token.

## Recent language-addition evidence

- Recent merged additions (`#816` Chinese, `#818` Italian, `#819` Korean, `#820` Indonesian) all add a canonical message file, registry entry, localized setup seeds, generated print labels, docs, and explicit language-matrix test updates. Indonesian and Korean additions also show that print and browser label tests need a Dutch sample rather than relying only on a dynamic registry loop.
- Follow-up fixes corrected terminology after merge: Italian Server App wording (`8c929047`), Korean addon-group terminology (`b30e819e`), and Chinese KOT wording (`855c7aaf`). Dutch review must specifically check POS terminology (bon, bestelling, tafel, afhaal, bezorging, klant, betaling) and KOT/receipt wording before generation.
- A prior Arabic follow-up (`cb92dc1f`) demonstrates that a language addition must preserve runtime loading and standalone language synchronization; Dutch should not change those boundaries.

## Concrete specification

1. Add `frontend/src/lib/i18n/messages/nl.json`, translated from the canonical English schema, with exact leaf parity, valid ICU, preserved variables/tags, and no placeholder prefixes.
2. Register `nl` in `frontend/src/lib/i18n/languages.ts` as `{ locale: 'nl-NL', nativeName: 'Nederlands', direction: 'ltr', selectable: true, load: () => import('./messages/nl.json') }`.
3. Add `nl` to the setup/demo seed-language union and provide Dutch Express, demo catalog, customer, and staff labels in `main/routes/auth.ts` without changing the English-identical seed exception.
4. Extend only language-addition inventories and focused coverage: explicit locale matrices, visible print-test labels, Dutch print-label assertions, and translation safeguard tests. Do not introduce a language union outside the existing seed boundary or redesign loading/printing.
5. Update the human-facing language lists in `docs/i18n.md`, `README.md`, and `CONTRIBUTING.md`. Do not add a translated README or tax/country data for this UI-only change.
6. Run `npm run generate:print-labels` after the canonical message file is complete; commit the generated TypeScript view and verify `--check` is clean.

## Implementation plan

- Scaffold `nl.json` with the repository helper, then replace all values from the canonical English source while preserving structure and ICU tokens.
- Register the locale, update seed catalogs, and update the explicit locale inventories/tests/docs.
- Regenerate print labels through the owner script; inspect the generated diff and run parity/ICU/type/print checks.
- Run `npm run i18n:check`, focused `test:translations`, `test:locale-chunks`, `test:phase6-locale-loading`, `test:phase7-setup-i18n`, `test:print-labels` (which includes the phase 3 print regressions), relevant browser/RTL suites, `npm run lint`, `npm run build`, and `npm run build:frontend`. Perform offline/manual checks for setup, settings, POS, KDS, receipt, and KOT language selection.

## Challenge reviews

### Architecture and ownership

- **Challenge:** Could Dutch be implemented as a country profile, tax pack, or currency locale? **Resolution:** No. The registry and docs explicitly decouple UI language from tenant regional settings and tax compliance. Use only the UI registry and seed catalog.
- **Challenge:** Should Dutch be a selectable language before all print labels are generated? **Resolution:** No. Expose it only after complete messages and generated print labels are present, otherwise the print policy validator can reject a fixed Dutch policy.
- **Challenge:** Does adding a new chunk affect offline boot? **Resolution:** English remains the synchronous fallback; Dutch follows the existing dynamic chunk/cache path and is warmed by auth print-policy bootstrap when selected. Test both cold load and failed-load behavior without network access.

### Product and translation quality

- **Challenge:** What locale tag and endonym should be shown? **Resolution:** Follow existing European language conventions: `nl` key, `nl-NL` BCP-47 tag, `Nederlands` endonym. This is a presentation locale only.
- **Challenge:** How should Dutch handle singular/plural wording? **Resolution:** Keep canonical ICU selector names and use Dutch `one`/`other` branches with the existing count argument; do not invent a new runtime plural system.
- **Challenge:** Could translated strings silently remain English? **Resolution:** Use the repository's existing language-specific fallback safeguards for Dutch, with a narrow intentional-identical allowlist for brands, technical identifiers, example values, measurements, and pure formats. Run the full translation validator.

### Printing, measurement, and release risk

- **Challenge:** Will longer labels corrupt thermal receipts? **Resolution:** Do not change renderer algorithms. Exercise existing 58/80 mm, classic/compact, KOT, test-page, and print-policy tests with Dutch samples; inspect warnings and truncation output.
- **Challenge:** Should browser/web print be treated differently from thermal print? **Resolution:** Both resolve the same canonical concepts, but browser HTML and generated backend labels have separate boundaries. Extend each existing test matrix rather than introducing a new print path.
- **Challenge:** Could the generated file drift? **Resolution:** Never hand-edit it; run the owner generator and its check command, then inspect the diff.
- **Challenge:** Does a locale addition require packaging metadata or a migration? **Resolution:** No. Static JSON is bundled by the existing frontend build, and language is a settings string; no schema migration, cloud contract, or package dependency is indicated by current code.
- **Challenge:** What could make this unsafe or privacy-invasive? **Resolution:** The change adds no network request, credential, telemetry field, user data, or external runtime dependency. The only external research used during translation preparation must not be added to the product.

## Verification evidence to collect

- Exact registry/file count and `npm run i18n:check` pass.
- `test:locale-chunks` confirms a distinct Dutch chunk and English fallback.
- `test:phase6-locale-loading` and `test:phase7-setup-i18n` cover runtime loading and Dutch seed localization.
- Print tests confirm Dutch concepts resolve in generated backend labels, browser HTML, and representative thermal output.
- Lint, backend build, frontend desktop build, focused tests, and final diff/status review pass with no unrelated changes.

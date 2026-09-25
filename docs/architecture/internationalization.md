# Internationalization

FloCafe supports 23 UI languages. This page describes how a language is declared, loaded, and
validated, and how the UI language stays separate from a store's regional settings.

## Source of truth and the parity rule

`frontend/src/lib/i18n/messages/en.json` is the canonical message catalogue. It holds 30
top-level namespaces and 2,639 non-empty string leaves. Every other catalogue under
`frontend/src/lib/i18n/messages/` must match it exactly: zero missing keys and zero orphan keys.

Exact parity is a hard gate rather than a fallback, because there is no per-key English fallback in
the runtime. A missing key does not render the English string; it renders nothing, and the
translation test fails. `npm run i18n:check` runs `tests/translations.test.ts`, which enforces
registry and file consistency, key parity, ICU validity, placeholder and tag parity, per-language
completeness, and frontend key safety.

The 23 committed catalogues are: `ar`, `bn`, `de`, `en`, `es`, `fa`, `fil`, `fr`, `hi`, `id`, `it`,
`ja`, `ko`, `nl`, `pt`, `ru`, `sq`, `th`, `tr`, `ur`, `vi`, `zh`, `zh-tw`.

## The registry

`frontend/src/lib/i18n/languages.ts` exports `LANGUAGES`, the single source for everything about a
language. Each entry carries:

| Field | Meaning |
| --- | --- |
| key | The object key in `LANGUAGES`, and the language code used in settings, print policies, and message filenames. |
| `locale` | The canonical BCP-47 tag passed to `Intl`. It is the tag, not the key: `de` has locale `de-DE`, `pt` has `pt-BR`. |
| `nativeName` | The endonym shown in the language picker. It is written in the language itself. |
| `direction` | `ltr` or `rtl`. |
| `selectable` | Whether the language may be chosen by an end user. |
| `load` | A lazy dynamic import returning that language's message catalogue. |

Because the registry is the only place a language is declared, adding a language means adding an
entry here and nothing else structural. The registry also exports `isLanguage()`,
`getLanguageFromLocale()`, `getLanguageDirection()`, and `getLanguageLocale()`; the reverse map
from BCP-47 tag to key is derived from `locale`, so the tag and the key cannot drift apart.

The registry key must be a canonical lowercase BCP-47 identifier, which is why a regional variant
gets a key such as `zh-tw` and a `locale` of `zh-TW`. See [adding a language](../guides/adding-a-language.md).

### Right-to-left languages

Exactly three registered languages are right-to-left: `fa` (Persian, `fa-IR`), `ar` (Arabic,
`ar-SA`), and `ur` (Urdu, `ur-PK`). There is no Hebrew locale.

Direction is applied to the document by `HtmlLangSync` in
`frontend/src/components/layout/HtmlLangSync.tsx`, which sets `<html lang>` to the language's
`locale` and `<html dir>` to its `direction`. Toasts flip separately through `DirectionalToaster`.
Direction is a property of the registry entry and of nothing else, so a new RTL language needs no
layout code.

## Loading

`frontend/src/lib/i18n/loader.ts` owns the message cache.

- English is imported statically at module load and pre-seeded into the cache, so a cold boot always
  has a complete catalogue and never waits on the network.
- Every other language is a dynamic import, one chunk per catalogue, declared by the registry's
  `load` function.
- Concurrent requests for the same language are deduplicated. The second caller receives the same
  in-flight promise rather than starting a second import.
- A language resolves from the cache synchronously once loaded, through `getCachedMessages()` and
  `isLocaleLoaded()`.
- An unknown language falls back to the English loader rather than throwing.

`I18nProvider` in `frontend/src/components/providers/I18nProvider.tsx` wraps the tree in
`use-intl`'s `IntlProvider` and makes locale switching atomic. It renders from the cached catalogue
and only advances once the new one has loaded in full. A failed load logs a warning, keeps
the last successfully rendered language active, and writes that language back to the store. A
superseded load is discarded, so a rapid sequence of language changes cannot leave the UI showing a
catalogue the store no longer names. A partially loaded catalogue is never rendered.

## Initial language resolution

`resolveInitialLanguage()` in `I18nProvider` resolves in a fixed order:

1. The persisted store value in `localStorage` under the `pos-settings` key, if it names a
   registered language.
2. `getBrowserLanguage()`.
3. `en`.

The result is written to the store, so browser detection runs only when there is nothing persisted.

## Browser detection

`frontend/src/lib/i18n/browser-language.ts` matches `navigator.languages` (plus
`navigator.language`) against the registered `selectable` languages. Each registered locale is
expanded with `Intl.Locale` and `maximize()`, which supplies the likely script for a bare language
subtag.

Resolution for a candidate tag, in order:

1. An exact `baseName` match against a registered locale.
2. A maximized `baseName` match, so a bare `de` reaches `de-DE`.
3. A same-script, same-language match, and only when exactly one candidate exists.

Step 3 deliberately never crosses a script boundary. A `zh-TW` tag resolves to `zh-tw` and must not
silently select `zh-CN`; a tag whose script has no unique registered candidate falls through to the
next preference and ultimately to `en`. A malformed tag is skipped rather than thrown on. When
`navigator` is unavailable, the result is `en`.

## Message format and key safety

Messages are ICU MessageFormat, parsed by `use-intl`. `tests/translations.test.ts` checks, across
every locale, that each message parses as valid ICU and that argument names and `plural` and
`select` selector variables match the English message exactly. A locale that renames an argument or
drops a plural branch fails the check.

Key safety is compile-time. `frontend/src/lib/i18n/messages.d.ts` augments `use-intl`'s `AppConfig`
with `Messages = typeof en` and `Locale`, so a `t()` call with a key that does not exist in
`en.json`, or an argument set that does not match, is a TypeScript error. `npm run i18n:check` runs
`tsc --noEmit -p frontend/tsconfig.json` and therefore fails on it. The same step also type-checks
the frontend, which is why the command reports anything it finds beyond translations.

## UI language is independent of regional settings

The interface language and the store's regional identity are separate domains and are configured
separately. The UI language chooses message catalogues, `Intl` locale tags, and the endonym in the
picker. The tenant's regional settings choose the business timezone, number and currency
formatting, digit shape, and calendar. Neither derives from the other: a Persian speaker running an
Iranian store sees Persian text and Iranian number formatting, and a Persian speaker running a
different store sees Persian text with that store's formatting. Changing one does not change the
other. `tests/decoupled-ui-locale.test.ts` pins this, including that an RTL locale formats decimals
with a comma and non-breaking space grouping and renders month names in its own script while
keeping Latin digits.

Print output has its own language settings, separate from both; see
[printing](printing.md).

## Derived print labels

The main process cannot import the frontend's message loaders, but it needs the same label text for
thermal printing. `main/print/print-labels.generated.ts` is a committed, generated TypeScript view of
the canonical catalogues for exactly that purpose. It is produced by
`scripts/generate-print-labels.cjs`, which extracts the `print.*` namespace plus an explicit manifest
of borrowed keys from other namespaces, for every committed language, in registry order.

- The generated module is a derived view. Never edit it by hand; edit the message catalogues and
  regenerate.
- A concept with no translation in a language falls back to English, so a receipt always renders a
  real label rather than a raw key.
- `PRINT_LABEL_LANGUAGES` in the generated module is the registry's language list, so adding a
  language adds its print labels with no separate registration.
- Drift is gated by `npm run generate:print-labels -- --check`, which regenerates in memory and
  byte-compares against the committed file. The check is wired into both `npm run i18n:check` and
  `tests/print-labels.test.ts`.

## Warming print locales at bootstrap

Printing can happen before any user interaction, so the locales a store's print policies select are
loaded during authenticated bootstrap. `syncPrintPoliciesAtBootstrap()` in
`frontend/src/lib/print-policy-bootstrap.ts` parses the tenant's `bill_language_policy` and
`kot_language_policy`, resolves the receipt and KOT languages, loads that set with
`Promise.allSettled`, and returns the languages whose load rejected. The caller surfaces those
failures. It does not silently substitute English, because a receipt printed in the wrong language is
a worse outcome than a visible error.

An unparseable or missing print policy is not an error: it resolves to the default policy, which
falls back to the store language.

## Adding or changing a language

`[adding a language](../guides/adding-a-language.md)` is the procedure. The script-level contracts a
translator and implementer must not violate, such as conjunct handling and printer code-page
representability, are in
[translation terminology](../reference/translation-terminology.md).

## Verification

```sh
npm run i18n:check
```

The command runs `npm run test:translations`, the print-label drift check, and the frontend
TypeScript check. It is fully offline and needs no server or database.

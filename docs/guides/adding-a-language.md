# Adding a language

Outcome: a new language appears in the language picker, renders complete UI text, prints correct
receipt and KOT labels, and passes `npm run i18n:check`.

A new language needs maintainer coordination through an issue before the work starts, because
adding one touches the seed data used by the express-restaurant sample and several test matrices.
Once approved, the steps below are mechanical apart from the translation itself.

Read [internationalization](../architecture/internationalization.md) for how the registry, loader,
and print labels work, and
[translation terminology](../reference/translation-terminology.md) for the script-level contracts a
translation must not violate.

## 1. Scaffold the message catalogue

```sh
npm run i18n:add -- <lang>
```

`<lang>` is a lowercase canonical BCP-47 identifier, optionally with a region or script subtag. The
scaffolder accepts a two or three letter primary language, optionally followed by hyphenated subtags
of two to eight alphanumerics, so both `de` and `zh-tw` are valid. It rejects anything `Intl.Locale`
would not canonicalise back to the same string, so `zh-TW` and `EN` are refused.

The scaffolder copies `en.json` to `<lang>.json`. It uses an exclusive file copy, so it never
overwrites an existing catalogue, including when two people run it at once.

## 2. Add the registry entry

Add a `<lang>` entry to `LANGUAGES` in `frontend/src/lib/i18n/languages.ts`:

| Field | Value |
| --- | --- |
| key | `<lang>`, matching the filename. |
| `locale` | The canonical BCP-47 tag. For a language with a region, this is where the region belongs: key `zh-tw`, locale `zh-TW`. |
| `nativeName` | The endonym, written in the language itself. |
| `direction` | `ltr`, or `rtl` for a right-to-left script. |
| `selectable` | `true` once the catalogue is complete. |
| `load` | `() => import('./messages/<lang>.json')` |

Direction is the only field that needs more than a translation decision. An RTL language requires no
layout code: `HtmlLangSync` sets `<html dir>` from the registry entry, and toasts flip through
`DirectionalToaster`. The three existing RTL languages are `fa`, `ar`, and `ur`.

## 3. Translate every leaf

`<lang>.json` has the same top-level namespaces and non-empty string leaves as `en.json`, whose counts
are recorded in [internationalization](../architecture/internationalization.md). All of them need
real translations, because parity against `en.json` is exact and there is no per-key English
fallback at runtime.

While translating:

- Preserve every ICU placeholder name and tag exactly. `{count}`, `{name}`, `<b>`, `<strong>` and
  `<i>` are matched against the English message by `tests/translations.test.ts`, and a rename fails
  the check.
- Preserve every `plural` and `select` selector variable. Adding a branch, or renaming a selector,
  fails the check.
- Do not introduce a plural selector to avoid awkward wording. See the count-safe guidance in
  [translation terminology](../reference/translation-terminology.md).
- Leave a key English-identical only when it is genuinely identical in your language: a brand name,
  a technical acronym, a measurement such as `58mm`, a pure format string, or an example placeholder
  such as an email or IP address. Anything else renders as untranslated English to your users, and
  the check will reject it.
- For a language with combining marks, the value must be in Unicode NFC. `tests/translations.test.ts`
  enforces NFC for the languages it checks by name, which are `ru`, `th`, and `vi`.
- Avoid invisible formatting characters. The Russian validator in `tests/translations.test.ts` rejects
  U+200B, U+200C, U+200D, U+00AD, and U+FEFF, because they corrupt printed text silently. No other
  language's validator checks for them yet, so this is your responsibility to get right rather than
  something the test will catch.
- Do not start a value with `[TODO]` or any other placeholder prefix. The check rejects it.

## 4. Register the intentional-identical keys

Each language has a `<LANG>_INTENTIONAL_IDENTICAL` set in `tests/translations.test.ts` listing the
keys allowed to be English-identical, most with a comment saying why. There are 18 such sets.

Add an entry for every key you deliberately left identical, with a comment giving the reason. Without
the entry the check fails, and the failure is what keeps an accidentally untranslated string from
shipping. This allowlist is the only mechanism protecting against silent English fallback; there is
no separate fixture file for it.

Do not add a key to the allowlist as a way to get past a failure you have not understood. The failure
means a value is still English, and for most keys the fix is to translate it.

## 5. Add the seed data

`main/routes/auth.ts` holds a `SeedLanguage` union type, a `resolveSeedLanguage()` function, and a
`labels` map of four sample strings (food, beverage, meal, tea) per language, used by the
express-restaurant sample. Add the new key to all three, with real translated sample strings.

`ENGLISH_IDENTICAL_SEED_LANGUAGES` in the same file lists languages that intentionally use the
English sample data. Filipino is the only entry. A new language is not added there.

`tests/phase7-setup-i18n.test.ts` checks every seeded merchant-visible string for script integrity.
The letters of a localized seed string must come from the scripts its locale uses, so a code point
copied from another script fails the run rather than shipping as a plausible-looking broken word.
The expected scripts are derived from the registry through `Intl.Locale`, so a new language is
covered without an edit here.

## 6. Regenerate the print labels

```sh
npm run generate:print-labels
```

`main/print/print-labels.generated.ts` is a committed generated file and must be regenerated after
any message change. It covers every language in the registry automatically, so no edit to the
generated module is needed for a new language. Labels with no translation in the new language fall
back to English.

If you add a new print concept, add its id to `PRINT_CONCEPT_IDS` in `shared/print/concepts.ts` in
the same order the generator uses, then regenerate.

## 7. Extend the test locale matrices

Several tests iterate a hard-coded array of locale codes rather than reading the registry. A new
language is not covered by them until you add it:

| File | Array | Current coverage |
| --- | --- | --- |
| `tests/phase3-print-regressions.test.ts` | `languages` | 22 of 23; omits `ar`. |
| `tests/issue-241-localized-errors.test.ts` | `LANGUAGES` | 11 of 23; omits 12 including `ar` and `ur`. |
| `tests/rtl-setup-auth-settings.test.ts` | `languages` | 19 of 23; omits `ar`, `de`, `fil`, `tr`. |
| `tests/browser-receipts.test.ts` | loop array | 19 of 23; omits `ar`, `de`, `fil`, `tr`. |
| `tests/i18n-audit-remediations.test.ts` | two loop arrays | 19 of 23 each; omits `ar`, `de`, `fil`, `tr`. |
| `tests/rtl-kds-server-whatsapp.test.ts` | four loop arrays | 19 of 23 for the all-language loops, 17 for the LTR-only loops. |
| `tests/rtl-dashboard-pos-common.test.ts` | two LTR-only loop arrays | 17 of 23; omits the RTL languages plus `de`, `fil`, `tr`. |

This is a known baseline, not something this procedure introduces. Several of these arrays already
omit registered locales, so they are not a reliable coverage signal. The arrays whose names include
`rtl` and that iterate `ltrLang` are intentionally LTR-only and should stay that way.

The pattern that does not drift is in `tests/print-labels.test.ts`: it reads
`Object.keys(LANGUAGES)` and asserts the generated `PRINT_LABEL_LANGUAGES` equals it, so a new
language is covered with no edit. Prefer that shape if you are adding coverage.

## 8. Verify

```sh
npm run i18n:check
```

This runs the translations test, the print-label drift check, and the frontend TypeScript check. It
is fully offline. Do not open the pull request until it passes; the TypeScript step also catches any
key or argument mistake the translations test does not.

Report any check you could not run, and why. Do not claim verification you did not perform.

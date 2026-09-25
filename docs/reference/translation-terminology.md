# Translation terminology and script contracts

Script-level rules a translation must satisfy that no code in the repository can express. The
message catalogues in `frontend/src/lib/i18n/messages/` are the authoritative artefact for wording;
this page covers the constraints behind them.

Word-list glossaries are deliberately not kept here. They are translator working material for the
pull request that fills `messages/<lang>.json`, and a glossary held in documentation has no
enforcement mechanism and drifts on the first translation change.

## Measurement is by grapheme cluster, never by UTF-16 code unit

`shared/print/width.ts` segments text into grapheme clusters with `Intl.Segmenter` at
`granularity: 'grapheme'`, and measures each cluster in display cells. A fallback segmenter keeps
Indic, Thai, and Urdu clusters together, attaches emoji modifiers, and pairs regional indicators, for
hosts without `Intl.Segmenter`.

Every truncation, padding, wrapping, and line-fitting helper in that module works on whole clusters.
A cluster is never split, even when the column budget ends inside it, and a cluster is never
partially emitted at zero cells.

The practical consequence for a translator: a combining mark, a variation selector, or a ZWNJ is
part of the character it attaches to. A word whose display width looks wrong is a shaping problem, not
a measurement problem, and the fix belongs in the message, not in the width code.

Pinned by `tests/print-kernel.test.ts`.

## Indic conjuncts are never split

A Devanagari or Bengali conjunct is a single grapheme cluster and must stay one. The virama
characters that join them, U+094D in Devanagari and U+09CD in Bengali, are the ones a naive
splitter would break.

Pinned by `tests/print-kernel.test.ts`, which asserts that wrapping a two-cluster Indic string at one
column per line keeps each conjunct intact, and that truncation whose budget ends inside a conjunct
drops the whole conjunct rather than emitting half of it. Thai and Urdu conjunct clusters are held
to the same rule.

## A zero-width non-joiner stays with the preceding grapheme

U+200C binds to the grapheme before it and must not pull the following letter into the same cluster.
For Urdu, `خ‌ود` segments as three clusters: `خ‌`, then `و`, then `د`. If the ZWNJ were treated as a
plain zero-width character that starts a new cluster, the word would be measured and wrapped
incorrectly.

Pinned by `tests/print-kernel.test.ts` for both the segmented and the fallback segmenter.

## NFC is required for Vietnamese

Vietnamese values must be in Unicode NFC. A decomposed value, where the vowel carries a separate
combining diacritic, measures as the same display width and wraps to the same lines, so the difference
is invisible on screen and corrupts comparison, searching, and print labels.

`tests/print-kernel.test.ts` asserts that the composed and decomposed forms of `Tiếng Việt` measure
identically and wrap identically after normalisation, which is what makes NFC a requirement rather
than a preference. `tests/translations.test.ts` rejects a `vi.json` value that is not already NFC.

The same NFC requirement is enforced for `ru.json` and `th.json`.

## Albanian and Vietnamese on a generic thermal printer

`LATIN_THERMAL_CAPABILITIES` in `shared/print/thermal-capabilities.ts` covers Latin-script printers
with `cp437`, `cp850`, `cp858`, and `windows1252` code pages, and transliteration to ASCII.

Albanian is transliterated through a fixed `LATIN_ASCII_MAP`, so `Ç` and `ç` become `C` and `c`, and
`Ë` and `ë` become `E` and `e`. The map exists because those two characters are outside CP437. German
umlauts are transliterated the same way in the same table. A translation is free to use the full
character set; the printer path handles the reduction.

Vietnamese is a different case, because many of its characters are outside every supported code page.
Verified against `LATIN_THERMAL_CAPABILITIES`:

| String | Representable | Code page |
| --- | --- | --- |
| `Món` | yes | `cp437` |
| `Khách hàng` | yes | `cp437` |
| `Cà phê` | yes | `cp437` |
| `Bàn` | yes | `cp437` |
| `Tổng cộng` | no | none |
| `Hóa đơn` | no | none |
| `Ăn tại chỗ` | no | none |
| `Nước` | no | none |
| `Số tiền` | no | none |
| `Đơn vị` | no | none |
| `Tiếng Việt` | no | none |

The characters that fail are those carrying a tone mark: `ộ`, `đ`, `ạ`, `ố`, `ơ`, and the stacked
`ế` in `Tiếng`. Note that the language endonym itself is not representable, so a printer-specific
surface that prints the language name needs a fallback too.

This is a property of the printer, not of the translation. A Vietnamese string that fails this table
still renders correctly in the UI, on a browser receipt, and on a printer with a raster path.

## Print capability is owned by the printer profile

A locale never enables a code page, a shaping mode, a transliteration mode, or a raster path. Those
belong to a printer profile in `main/printers/profiles.ts`, and a profile is selected by the
configured printer.

The practical rule for a translation: do not assume a character will print because another locale's
does, and do not work around a printer limitation by rewriting a label to avoid the character. The
profile decides, and a label that is unrepresentable on a financial row is refused by design rather
than silently substituted. See [printing](../architecture/printing.md) for the capability and refusal
model.

## Count-safe wording instead of a new plural selector

A message should not gain a `plural` selector to work around a language's word order. Restructure the
sentence so the count reads correctly with a single form.

Russian is the pinned example. `auth.attemptsRemaining` is `{count} attempt(s) remaining before
lockout.` in English and `До блокировки осталось попыток: {count}` in Russian, and `pos.tableSeats`
is `{count} seats` and `Мест: {count}`. Both are pinned by assertions in `tests/translations.test.ts`,
which also enforces that the selector variables of a locale match the English message, so a new
selector would fail the check for every other locale too.

The pattern to follow: put the noun in a form that works with any number, and let the count follow as
an argument.

## POS terminology a translator would otherwise get wrong

**Russian.** Orders are `Заказов` in the counter wording, not a pluralised noun. Refund and payment
method are `Способы оплаты`. Cash movement, the drawer-variance screen, is `Движение наличных`, and
the counted-versus-expected pair is `Фактические наличные` and `Ожидаемые наличные`. Use count-safe
wording throughout, as above.

**Albanian.** Takeaway is `Me vete` and dine-in is `Në lokal`; they are order types, not verbs, and
"delivery" is `Dorëzim`, distinct from both. Payment methods is `Metodat e pagesës`. Cash movement is
`Lëvizja e parave të gatshme`, and the counted-versus-expected pair is `Paratë e numëruara` and
`Paratë e pritura`. Where a term must be abbreviated on a receipt, remember that `Ë` and `ë`
transliterate to `E` and `e` on a generic thermal printer.

## Verification

The contracts on this page are pinned by `tests/print-kernel.test.ts`,
`tests/print-labels.test.ts`, `tests/thermal-capabilities.test.ts`, and
`tests/translations.test.ts`. Run them when a change touches message text or the print kernel:

```sh
npm run test:print-kernel
npm run test:print-labels
npm run i18n:check
```

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

A Devanagari, Bengali, Gurmukhi, or Telugu conjunct is a single grapheme cluster and must stay one. The
virama characters that join them, U+094D in Devanagari, U+09CD in Bengali, U+0A4D in Gurmukhi, and U+0C4D in Telugu,
are the ones a naive splitter would break.

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

The same NFC requirement is enforced for `ha.json`, `jv.json`, `mr.json`, `ne.json`, `pa.json`, `ru.json`, `sw.json`, `ta.json`, `te.json`, `th.json`, and `uk.json`.

## Albanian and Vietnamese on thermal and impact printers

`GENERIC_THERMAL_CAPABILITIES` (`scripts: ['ascii']`) in `shared/print/thermal-capabilities.ts`
transliterates only through the fixed `LATIN_ASCII_MAP`, so Albanian `Ç`/`ç` and `Ë`/`ë` become
`C`/`c` and `E`/`e`, and German umlauts (`Ä`/`Ö`/`Ü`/`ß`) fold the same way. Characters outside
that map remain unrepresentable on `GENERIC_THERMAL_CAPABILITIES` unless raster rendering is
enabled.

`LATIN_THERMAL_CAPABILITIES` (`scripts: ['ascii', 'latin']`) covers Latin-script printers with
`cp437`, `cp850`, `cp858`, and `windows1252` code pages plus fallback transliteration. Native
code-page coverage (without transliteration, as checked by `shouldUseOrderTypeFallback()`) for
Vietnamese strings is:

| String | Native code-page match | Code page |
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

The characters lacking a native single-byte code page are those carrying a tone mark, horn, or
stroke: `ộ`, `đ`, `ạ`, `ố`, `ơ`, and the stacked `ế` in `Tiếng`. When no single native code page
can represent a Latin-script string on `LATIN_THERMAL_CAPABILITIES` (and raster rendering is not
handling it), `normalizeThermalText()` applies `LATIN_ASCII_MAP`, `LATIN_EXTENDED_ASCII_MAP`
(`Æ/æ`, `Œ/œ`, `Ø/ø`, `Ł/ł`, `Đ/đ`, `Ð/ð`, `Þ/þ`, `Ğ/ğ`, `İ/ı`, `Ş/ş`, `Ơ/ơ`, `Ư/ư`), and Unicode
NFD `\p{Diacritic}` stripping on Latin characters so non-raster Latin profiles (such as
`escpos-impact-76`) fold those strings to ASCII (`cp437`). A translation is free to use the full
character set; the printer path handles the reduction or raster fallback.

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

## An order-number placeholder is never welded to a word

`{number}` names an order number, and the number must be introduced by punctuation or a space, never
by a letter or combining mark. In a verb-final language the failure is silent and reads as a
mangled word: English `Adding items to order #{number}` became
`अर्डर # मा वस्तुहरू थप्दै{number}` in Nepali, which renders as
`अर्डर # मा वस्तुहरू थप्दैA-12`.

ICU argument parity cannot catch this. The placeholder is present, its name is unchanged, and
`npm run i18n:check` passes; only the position is wrong. `tests/translations.test.ts` therefore
asserts across every registered locale that the character before `{number}` is not a letter or
combining mark, which covers this class for all locales rather than for one.

A space before `{number}` is legitimate. Persian and Arabic use `شماره {number}`, and
`№{number}` in Russian is also correct.

## Devanagari spelling: the visarga in पुनः

Nepali and Marathi spell "again" `पुनः` with the visarga, U+0903, not with an ASCII colon. `पुन:` looks
close enough in a diff to be overlooked, and it renders as a visibly wrong glyph on a thermal
receipt. The same applies to the matra in a trailing syllable, where a base consonant must keep
the marks that attach to it.

`tests/translations.test.ts` rejects a `ne.json` or `mr.json` value containing `पुन:` and requires at least one
`पुनः`, so the spelling cannot silently regress.

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

**Nepali.** Subtotal `उप-जम्मा` and grand total `कुल जम्मा` are distinct labels and must stay
distinct on the receipt. The vegetarian tags are `शाकाहारी` and the non-vegetarian tags
`मासाहारी`, identical between `pos.*` and `products.*` so the two surfaces never disagree. Cash
movement uses `नगद जम्मा` for pay-in and `नगद निकासी` for pay-out, identically on the dashboard and on
the Z-report. Watch the visarga above, and note that Nepali keeps loanwords common in restaurant
POS use: order is `अर्डर`, takeaway is `टेकअवे`, delivery is `डेलिभरी`, dine-in is
`रेस्टुरेन्टमा खाने`, and a WebUSB or USB port is untranslated.

**Hausa.** Cash received on a receipt is `Kuɗin hannu da aka karɓa`. The vegetarian tags are
`Na ganyayyaki` and the non-vegetarian tags `Mai nama`, identical between `pos.*` and `products.*`.
Takeaway is identical between `orders.takeaway` and `pos.orderTypeTakeaway`. Cash movement uses
`Shigar da kuɗi` for pay-in and `Fitar da kuɗi` for pay-out, identically on the dashboard and on the
Z-report.

**Javanese.** Subtotal `Sub-gunggung` and grand total `Gunggung Akhir` (`GUNGGUNG` on thermal
receipts) stay distinct from each other and from Indonesian `Subtotal` / `Total Akhir`. Order types
use idiomatic Javanese: dine-in is `Mangan ing Kene`, takeaway is `Gawa Mulih`, and delivery is
`Kiriman`. The vegetarian and non-vegetarian tags are `Nabati` and `Non-Nabati` across both
`pos.*` and `products.*`. Cash movement uses `Lebokake Tunai` for pay-in and `Wetokake Tunai` for
pay-out across both the dashboard and the Z-report, and cash received on a receipt is
`Tunai Ditampa`.

**Marathi.** Subtotal `उप-एकूण` and grand total `एकूण रक्कम` are distinct labels and must stay
distinct on the receipt. The vegetarian tags are `शाकाहारी` and the non-vegetarian tags
`मांसाहारी`, identical between `pos.*` and `products.*`. Cash movement uses `रोख जमा` for pay-in
and `रोख काढणे` for pay-out, identically on the dashboard and on the Z-report. Reprint is
`पुनःमुद्रण` with the visarga (U+0903), and standard restaurant POS loanwords remain natural:
order is `ऑर्डर`, takeaway is `टेकअवे`, delivery is `डिलिव्हरी`, and dine-in is `डाइन-इन`.

**Swahili.** Subtotal `Jumla Ndogo` and grand total `JUMLA KUU` (`Jumla Kuu` on browser receipts) are
distinct labels and must stay distinct on the receipt. Vegetarian tags are `Mboga` and non-vegetarian
tags `Isiyo ya Mboga`, identical between `pos.*` and `products.*`. Takeaway is `Kuchukua`, dine-in is
`Kula Hapa`, and delivery is `Uwasilishaji`. Cash movement uses `Uwekaji pesa` for pay-in and
`Utoaji pesa` for pay-out, identically on the dashboard and on the Z-report.

**Punjabi.** Subtotal `ਉਪ-ਜੋੜ` and grand total `ਕੁੱਲ ਜੋੜ` stay distinct on the receipt, and cash
received is `ਪ੍ਰਾਪਤ ਨਕਦ`. The vegetarian and non-vegetarian tags are `ਸ਼ਾਕਾਹਾਰੀ` and `ਮਾਸਾਹਾਰੀ` across
both `pos.*` and `products.*`. Cash movement uses `ਨਕਦ ਜਮ੍ਹਾਂ` for pay-in and `ਨਕਦ ਨਿਕਾਸੀ` for
pay-out on both the dashboard and the Z-report, and takeaway is `ਟੇਕਅਵੇ` across `orders.*` and
`pos.*`. Gurmukhi virama conjuncts (`ਪ੍ਰ`, `ਸ੍ਰ`) and combining signs (`ੰ` tippi, `ਂ` bindi, `ੱ`
addak, `਼` nukta) must remain NFC-normalized and attached to their base consonant.

**Telugu.** Subtotal `ఉప మొత్తం` and grand total `మొత్తం` are distinct labels and must stay
distinct on the receipt. The vegetarian tags are `శాకాహారం` and the non-vegetarian tags
`మాంసాహారం`, identical between `pos.*` and `products.*`. Cash movement uses `నగదు జమ` for pay-in
and `నగదు ఉపసంహరణ` for pay-out, identically on the dashboard and on the Z-report. Takeaway is
`టేక్అవే` and delivery is `డెలివరీ`.

**Tamil.** Subtotal `துணை மொத்தம்` and grand total `மொத்தத் தொகை` are distinct labels and must stay
distinct on the receipt. The vegetarian tags are `சைவம்` and the non-vegetarian tags `அசைவம்`,
identical between `pos.*` and `products.*`. Cash movement uses `ரொக்க வரவு` for pay-in and `ரொக்க செலவு`
for pay-out across the dashboard and the Z-report. Takeaway is `பார்சல்` across `orders.takeaway` and
`pos.orderTypeTakeaway`, distinct from delivery `டெலிவரி` and dine-in `உணவகத்தில் சாப்பிட`.

**Ukrainian.** Takeaway is `З собою` and dine-in is `У закладі`; "delivery" is `Доставка`. Subtotal
`Проміжний підсумок` and grand total `РАЗОМ` (or `Загальна сума` on browser receipts) stay distinct,
and cash received on a receipt is `Отримано готівкою`. The dietary tags are `Вегетаріанське`,
`Не вегетаріанське`, and `Без молочних продуктів` (dairy-free, not lactose-free) across both `pos.*`
and `products.*`. Store-credit refund is `Баланс гаманця клієнта`, and waiving a charge is
`Не стягувати`. Cash movement is `Внесення готівки` for pay-in, `Видача готівки` for pay-out, and
`Інкасація` for safe drop, identically on the dashboard and on the Z-report, and the
counted-versus-expected pair is `Фактична готівка` and `Очікувана готівка`. Use count-safe wording
throughout where the English catalogue has no plural selector.

## Verification

The contracts on this page are pinned by `tests/print-kernel.test.ts`,
`tests/print-labels.test.ts`, `tests/thermal-capabilities.test.ts`, and
`tests/translations.test.ts`. Run them when a change touches message text or the print kernel:

```sh
npm run test:print-kernel
npm run test:print-labels
npm run i18n:check
```

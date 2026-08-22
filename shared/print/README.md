# shared/print — print kernel

Neutral, dependency-free print semantics shared by the Electron main process
(`main/`), the Next.js renderer (`frontend/`), and the test suite. Owned by
issue #441 (epic #438).

## Purity rules (binding)

`shared/print/**` contains **types and pure functions only**:

- No Electron, DOM, React, Node built-ins (`node:*`, `fs`, `path`, …),
  database, filesystem, network, or transport IO.
- No imports from `frontend/` or `main/`. Nothing outside `shared/print/`
  may be imported at all.
- No hardcoded language unions (`'en' | 'fa' | …`). The central language
  registry (`frontend/src/lib/i18n/languages.ts`) is authoritative; the
  kernel treats codes as structural strings (`PrintLanguageCode = string`).
- Enforced in CI by `tests/kernel-purity.test.ts` (static import audit) and
  ESLint (`npm run lint` covers `shared/` with import restrictions).

## Registry-injection pattern

Call sites inject registry-derived facts as plain parameters:

```ts
import { parsePrintLanguagePolicy } from '@print/policy'; // frontend
import { LANGUAGES } from '@/lib/i18n';

const result = parsePrintLanguagePolicy(payload, {
  isSelectableLanguage: (code) => code in LANGUAGES && LANGUAGES[code].selectable,
});
```

The backend injects its own view of "registered + selectable" derived from
the generated print-label table (`main/print/print-labels.generated.ts`).
This keeps the dependency direction one-way: registry → call site → kernel,
never kernel → registry.

## Module map

| File          | Contents |
| ------------- | -------- |
| `types.ts`    | `PrintLanguageCode`, policy shapes (`ReceiptLanguagePolicy`, `KotLanguagePolicy`), `DirectionScope`, registry-facts interface |
| `policy.ts`   | Resolution (`resolveReceiptLanguages`, `resolveKotLanguage`) and validation (`parsePrintLanguagePolicy`, `parseKotLanguagePolicy`); max-2 documents enforced at type level for v1 |
| `direction.ts`| Per-scope direction (`document` / `block` / `value`), LTR-island classification |
| `bilingual.ts`| `BilingualLabel` + width-fit strategies (`inline` vs `stacked`) parameterized by column count |

Consumers: `main/*` imports the relative path `../../shared/print` and gets
one compiled runtime copy under `dist/shared/print`; `frontend/*` imports
via the `@print/*` tsconfig alias so Next bundles kernel sources directly
into renderer bundles. There must never be a second compiled copy of this
kernel inside the Electron main bundle.

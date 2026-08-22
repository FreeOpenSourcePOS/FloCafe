/**
 * Shared print kernel — core types (#441, epic #438).
 *
 * PURITY RULES (see shared/print/README.md):
 *   - Types + pure functions only. No Electron, DOM, React, DB, filesystem,
 *     network, or transport IO of any kind.
 *   - No imports from `frontend/` or `main/`. The central UI language
 *     registry (`frontend/src/lib/i18n/languages.ts`) stays authoritative:
 *     call sites inject registry-derived facts as plain parameters.
 *   - Never hardcode a language union (`'en' | 'fa' | ...`). Language codes
 *     are structural strings validated against injected registry facts.
 */

/**
 * Structural print language code. Intentionally NOT a literal union: the set
 * of valid codes is owned by the central language registry and injected at
 * call sites (see {@link LanguageRegistryFacts}).
 */
export type PrintLanguageCode = string;

/** Base text direction for rendered content. */
export type TextDirection = 'ltr' | 'rtl';

/**
 * Direction granularity. A printed document carries one base direction,
 * blocks inherit it, and individual embedded values (IDs, phones, amounts)
 * may be LTR islands inside an RTL document.
 */
export type DirectionScope = 'document' | 'block' | 'value';

/** Primary language selection for a print surface. */
export type PrimaryLanguageSelection =
  | { readonly mode: 'inherit' }
  | { readonly mode: 'fixed'; readonly language: PrintLanguageCode };

/**
 * Typed language policy. `"inherit"` is a MODE on `primary`, never a value
 * stored where a language code belongs.
 *
 * `additional` is a bounded tuple so the total languages per document stay
 * enforceable at the type level:
 *   - {@link ReceiptLanguagePolicy}: at most 1 additional → max 2 (v1).
 *   - {@link KotLanguagePolicy}: single-primary only.
 */
export interface PrintLanguagePolicy<Additional extends readonly PrintLanguageCode[] = readonly []> {
  readonly primary: PrimaryLanguageSelection;
  readonly additional: Additional;
}

/** Receipt/bill policy: primary + up to one additional language (max 2). */
export type ReceiptLanguagePolicy =
  | PrintLanguagePolicy<readonly []>
  | PrintLanguagePolicy<readonly [PrintLanguageCode]>;

/** Kitchen ticket policy: single-primary for v1. */
export type KotLanguagePolicy = PrintLanguagePolicy<readonly []>;

/**
 * Registry-derived facts injected by call sites. The kernel never imports the
 * frontend registry; each consumer maps its own view of the registry onto
 * this shape (frontend filters by `selectable`, backend uses its generated
 * print-label language table).
 */
export interface LanguageRegistryFacts {
  /** True when `code` is registered AND selectable in the caller's registry view. */
  isSelectableLanguage(code: string): boolean;
}

/** Ordered resolved languages for a printable document (primary first). */
export type ResolvedPrintLanguages = readonly [
  PrintLanguageCode,
] | readonly [
  PrintLanguageCode,
  PrintLanguageCode,
];

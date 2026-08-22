/**
 * Shared print kernel — language policy resolution & validation (#441).
 * Pure functions only. Registry facts are injected, never imported.
 */

import type {
  KotLanguagePolicy,
  LanguageRegistryFacts,
  PrimaryLanguageSelection,
  PrintLanguageCode,
  PrintLanguagePolicy,
  ReceiptLanguagePolicy,
  ResolvedPrintLanguages,
} from './types';

/** Maximum total languages per receipt document in v1 (primary + 1). */
export const MAX_RECEIPT_LANGUAGES = 2;

/**
 * Resolve the effective primary language for a policy.
 * `inherit` yields the caller-supplied store/UI language; `fixed` yields the
 * configured language. Empty/whitespace store languages are returned as-is:
 * English fallback is a renderer concern (#440 owns label fallbacks), not a
 * kernel decision about specific codes.
 */
export function resolvePrimaryLanguage(
  primary: PrimaryLanguageSelection,
  storeLanguage: PrintLanguageCode,
): PrintLanguageCode {
  return primary.mode === 'inherit' ? storeLanguage : primary.language;
}

/**
 * Resolve the ordered language list for a receipt: resolved primary first,
 * then any additional language. Duplicates (additional === resolved primary)
 * collapse so a document never renders the same language twice. The result
 * length never exceeds {@link MAX_RECEIPT_LANGUAGES}.
 */
export function resolveReceiptLanguages(
  policy: ReceiptLanguagePolicy,
  storeLanguage: PrintLanguageCode,
): ResolvedPrintLanguages {
  const primary = resolvePrimaryLanguage(policy.primary, storeLanguage);
  const [additional] = policy.additional;
  if (additional === undefined || additional === primary) {
    return [primary];
  }
  return [primary, additional];
}

/** Resolve the single primary language for a KOT policy. */
export function resolveKotLanguage(
  policy: KotLanguagePolicy,
  storeLanguage: PrintLanguageCode,
): PrintLanguageCode {
  return resolvePrimaryLanguage(policy.primary, storeLanguage);
}

export type PrintLanguagePolicyParseResult<P> =
  | { readonly ok: true; readonly policy: P }
  | { readonly ok: false; readonly error: string };

interface RawPolicyShape {
  primary?: unknown;
  additional?: unknown;
}

function parsePrimarySelection(raw: unknown, facts: LanguageRegistryFacts):
  { ok: true; value: PrimaryLanguageSelection } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'policy.primary must be an object' };
  }
  const mode = (raw as { mode?: unknown }).mode;
  if (mode === 'inherit') return { ok: true, value: { mode: 'inherit' } };
  if (mode === 'fixed') {
    const language = (raw as { language?: unknown }).language;
    if (typeof language !== 'string' || language.length === 0) {
      return { ok: false, error: 'policy.primary.language must be a non-empty string when mode is "fixed"' };
    }
    if (!facts.isSelectableLanguage(language)) {
      return { ok: false, error: `policy.primary.language "${language}" is not a registered selectable language` };
    }
    return { ok: true, value: { mode: 'fixed', language } };
  }
  return { ok: false, error: 'policy.primary.mode must be "inherit" or "fixed"' };
}

function parseAdditional(raw: unknown, maxEntries: number, facts: LanguageRegistryFacts):
  { ok: true; value: readonly PrintLanguageCode[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'policy.additional must be an array' };
  }
  if (raw.length > maxEntries) {
    return { ok: false, error: `policy.additional supports at most ${maxEntries} entr${maxEntries === 1 ? 'y' : 'ies'} in v1` };
  }
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return { ok: false, error: 'policy.additional entries must be non-empty strings' };
    }
    if (!facts.isSelectableLanguage(entry)) {
      return { ok: false, error: `policy.additional entry "${entry}" is not a registered selectable language` };
    }
    if (seen.has(entry)) {
      return { ok: false, error: `policy.additional entries must be deduped (duplicate "${entry}")` };
    }
    seen.add(entry);
  }
  return { ok: true, value: Object.freeze([...raw]) };
}

function parsePolicyBody(raw: unknown, maxAdditional: number, facts: LanguageRegistryFacts):
  { ok: true; primary: PrimaryLanguageSelection; additional: readonly PrintLanguageCode[] }
  | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'policy must be a JSON object' };
  }
  const shape = raw as RawPolicyShape;
  for (const key of Object.keys(shape)) {
    if (key !== 'primary' && key !== 'additional') {
      return { ok: false, error: `unknown policy key "${key}"` };
    }
  }
  if (shape.primary === undefined) {
    return { ok: false, error: 'policy.primary is required' };
  }
  const primary = parsePrimarySelection(shape.primary, facts);
  if (!primary.ok) return primary;
  const additional = parseAdditional(shape.additional ?? [], maxAdditional, facts);
  if (!additional.ok) return additional;
  if (
    primary.value.mode === 'fixed'
    && additional.value.includes(primary.value.language)
  ) {
    return { ok: false, error: `policy.additional duplicates the fixed primary "${primary.value.language}"` };
  }
  return { ok: true, primary: primary.value, additional: additional.value };
}

/**
 * Validate and normalize an untrusted receipt language policy payload.
 * Enforces: known keys only, valid primary mode, registered+selectable
 * languages (via injected facts), dedupe, and ≤1 additional entry (max-2
 * documents in v1). Frozen result — safe to persist verbatim.
 */
export function parsePrintLanguagePolicy(
  raw: unknown,
  facts: LanguageRegistryFacts,
): PrintLanguagePolicyParseResult<ReceiptLanguagePolicy> {
  const body = parsePolicyBody(raw, 1, facts);
  if (!body.ok) return body;
  const policy: ReceiptLanguagePolicy = body.additional.length === 0
    ? { primary: body.primary, additional: [] as const }
    : { primary: body.primary, additional: [body.additional[0]] as const };
  return { ok: true, policy: Object.freeze(policy) };
}

/**
 * Validate and normalize an untrusted KOT language policy payload.
 * Single-primary for v1: `additional` must be absent or empty.
 */
export function parseKotLanguagePolicy(
  raw: unknown,
  facts: LanguageRegistryFacts,
): PrintLanguagePolicyParseResult<KotLanguagePolicy> {
  const body = parsePolicyBody(raw, 0, facts);
  if (!body.ok) return body;
  const policy: KotLanguagePolicy = { primary: body.primary, additional: [] as const };
  return { ok: true, policy: Object.freeze(policy) };
}

/** Canonical stored form for a freshly defaulted policy (inherit / none). */
export function defaultPrintLanguagePolicy(): PrintLanguagePolicy<readonly []> {
  const policy: PrintLanguagePolicy<readonly []> = { primary: { mode: 'inherit' }, additional: [] as const };
  return Object.freeze(policy);
}

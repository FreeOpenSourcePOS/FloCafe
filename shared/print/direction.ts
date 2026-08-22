/**
 * Shared print kernel — direction semantics (#441).
 * Pure functions only.
 */

import type { DirectionScope, TextDirection } from './types';

/**
 * Per-scope direction for a document. `document` and `block` follow the base
 * direction; `value` defaults to the base but individual values may resolve
 * to LTR islands via {@link resolveValueDirection}.
 */
export interface DirectionSpec {
  readonly base: TextDirection;
  readonly document: TextDirection;
  readonly block: TextDirection;
  readonly value: TextDirection;
}

/** Build the per-scope direction spec for a base document direction. */
export function resolveDirectionSpec(base: TextDirection): DirectionSpec {
  return Object.freeze({
    base,
    document: base,
    block: base,
    value: base,
  });
}

/**
 * Resolve the direction for a specific embedded value inside a document with
 * the given base direction. Confident LTR islands (IDs, phones, URLs, SKUs,
 * tax IDs, invoice numbers, amounts) resolve to `'ltr'` even in RTL
 * documents; everything else follows the base. Classification is heuristic
 * and conservative — mixed natural-language text is never an island.
 */
export function resolveValueDirection(text: string, base: TextDirection): TextDirection {
  return isLtrIsland(text) ? 'ltr' : base;
}

/** Scope-aware direction resolution. */
export function resolveScopeDirection(
  scope: DirectionScope,
  base: TextDirection,
  value?: string,
): TextDirection {
  if (scope === 'value') {
    return resolveValueDirection(value ?? '', base);
  }
  return base;
}

// ── LTR-island classification ──────────────────────────────────────────────
//
// Conservative single-line heuristics over the trimmed value. A string is an
// LTR island when it is confidently one of:
//   - phone number        "+1 (555) 010-2030", "+91 98765 43210"
//   - URL / email         "https://…", "www.…", "a@b.c"
//   - identifier          SKU, invoice number, order number, tax ID:
//                         "ORD-2026-001", "GSTIN22AAAAA0000A1Z5", "SKU 0042"
//   - amount              "$1,234.56", "1234.56", "₹ 5,00,000", "12%"

const PHONE_RE = /^[+(\d][\d\s().\-/]{3,}\d$/;
const URL_RE = /^(?:https?:\/\/|www\.)/i;
const EMAIL_RE = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;
const AMOUNT_RE = /^[\s$€£¥₹﷼¤]*[-+]?[\d][\d,\s.'’]*?(?:[.,]\d{1,3})?\s*(?:%|[A-Z]{2,3})?[\s%]*$/u;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9\s./_#:+\-]*$/;

function hasDigit(text: string): boolean {
  return /\d/.test(text);
}

/** Contains letters from an RTL script → never an LTR island. */
function hasRtlScript(text: string): boolean {
  return /[\u0591-\u07FF\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(text);
}

/**
 * Classify whether `text` is a confident LTR island (IDs, phones, URLs,
 * SKUs, tax IDs, invoice numbers, amounts). Returns false for empty input
 * and for any text containing RTL script characters.
 */
export function isLtrIsland(text: string): boolean {
  if (typeof text !== 'string') return false;
  const value = text.trim();
  if (value.length === 0 || value.length > 64) return false;
  if (hasRtlScript(value)) return false;
  if (URL_RE.test(value)) return true;
  if (EMAIL_RE.test(value)) return true;
  if (PHONE_RE.test(value) && hasDigit(value)) return true;
  if (AMOUNT_RE.test(value) && hasDigit(value)) return true;
  // Identifiers must be ASCII-ish token material AND carry at least one
  // digit, so plain words ("Espresso") stay in the base direction. More than
  // three whitespace-separated tokens reads as a sentence, not an ID.
  if (IDENTIFIER_RE.test(value) && hasDigit(value) && value.split(/\s+/).length <= 3) return true;
  return false;
}

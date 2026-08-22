/**
 * Receipt/KOT language policy settings (#441, epic #438).
 *
 * Bridges the neutral shared print kernel to the tenant settings store.
 * The kernel stays registry-independent: this module injects the backend's
 * registry-derived view — the generated print-label language table
 * (main/print/print-labels.generated.ts). The print-label generation workflow
 * owns that backend view; no language union is hardcoded here.
 */

import { PRINT_LABEL_LANGUAGES } from '../print/print-labels.generated';
import {
  defaultPrintLanguagePolicy,
  parseKotLanguagePolicy,
  parsePrintLanguagePolicy,
  type KotLanguagePolicy,
  type LanguageRegistryFacts,
  type ReceiptLanguagePolicy,
} from '../../shared/print';

export const BILL_LANGUAGE_POLICY_KEY = 'bill_language_policy';
export const KOT_LANGUAGE_POLICY_KEY = 'kot_language_policy';

export const LANGUAGE_POLICY_SETTING_KEYS: ReadonlySet<string> = new Set([
  BILL_LANGUAGE_POLICY_KEY,
  KOT_LANGUAGE_POLICY_KEY,
]);

/** Backend registry view: languages with generated print labels. */
const SELECTABLE_PRINT_LANGUAGES: ReadonlySet<string> = new Set<string>(PRINT_LABEL_LANGUAGES);

const REGISTRY_FACTS: LanguageRegistryFacts = {
  isSelectableLanguage: (code: string) => SELECTABLE_PRINT_LANGUAGES.has(code),
};

/** Canonical JSON stored when a tenant has not customized the policy. */
export function defaultLanguagePolicySettingJson(): string {
  return JSON.stringify(defaultPrintLanguagePolicy());
}

export type LanguagePolicyValidation =
  | { ok: true; stored: string }
  | { ok: false; error: string };

/**
 * Validate an untrusted policy value for a language-policy settings key.
 * Accepts a JSON string or an already-parsed object; returns the canonical
 * JSON to persist. Invalid payloads are rejected with a reason.
 */
export function validateLanguagePolicySetting(
  key: string,
  value: unknown,
): LanguagePolicyValidation {
  if (typeof value === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return { ok: false, error: `${key} must be valid policy JSON` };
    }
    return validateLanguagePolicySetting(key, parsed);
  }
  if (key === BILL_LANGUAGE_POLICY_KEY) {
    const result = parsePrintLanguagePolicy(value, REGISTRY_FACTS);
    return result.ok
      ? { ok: true, stored: JSON.stringify(result.policy) }
      : { ok: false, error: `Invalid ${key}: ${result.error}` };
  }
  if (key === KOT_LANGUAGE_POLICY_KEY) {
    const result = parseKotLanguagePolicy(value, REGISTRY_FACTS);
    return result.ok
      ? { ok: true, stored: JSON.stringify(result.policy) }
      : { ok: false, error: `Invalid ${key}: ${result.error}` };
  }
  return { ok: false, error: `${key} is not a language policy key` };
}

export type StoredPrintLanguagePolicy = ReceiptLanguagePolicy | KotLanguagePolicy;

/**
 * Lenient read-side parse of a stored policy. Malformed or invalid stored
 * values fall back to the inherit/none default so a bad row can never break
 * printing; writers are the strict path.
 */
export function parseStoredLanguagePolicy(
  key: string,
  stored: string | undefined,
): StoredPrintLanguagePolicy {
  const fallback = defaultPrintLanguagePolicy();
  if (!stored) return fallback;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (key === KOT_LANGUAGE_POLICY_KEY) {
      const result = parseKotLanguagePolicy(parsed, REGISTRY_FACTS);
      return result.ok ? result.policy : fallback;
    }
    const result = parsePrintLanguagePolicy(parsed, REGISTRY_FACTS);
    return result.ok ? result.policy : fallback;
  } catch {
    return fallback;
  }
}

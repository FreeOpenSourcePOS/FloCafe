import { LANGUAGES, type Language } from './i18n/languages';
import { parseKotLanguagePolicy, parsePrintLanguagePolicy } from '@print/policy';
import type { KotLanguagePolicy, ReceiptLanguagePolicy } from '@print/types';

const PRINT_LANGUAGE_REGISTRY_FACTS = {
  isSelectableLanguage: (code: string) =>
    Object.prototype.hasOwnProperty.call(LANGUAGES, code) && LANGUAGES[code as Language].selectable,
};

function decodePolicyInput(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' ? value : null;
}

export function parseStoredReceiptLanguagePolicy(value: unknown): ReceiptLanguagePolicy | null {
  const decoded = decodePolicyInput(value);
  if (!decoded) return null;
  const result = parsePrintLanguagePolicy(decoded, PRINT_LANGUAGE_REGISTRY_FACTS);
  return result.ok ? result.policy : null;
}

export function parseStoredKotLanguagePolicy(value: unknown): KotLanguagePolicy | null {
  const decoded = decodePolicyInput(value);
  if (!decoded) return null;
  const result = parseKotLanguagePolicy(decoded, PRINT_LANGUAGE_REGISTRY_FACTS);
  return result.ok ? result.policy : null;
}

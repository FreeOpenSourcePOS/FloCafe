import { LANGUAGES, type Language } from './i18n/languages';
import { parseKotLanguagePolicy, parsePrintLanguagePolicy } from '@print/policy';
import type { KotLanguagePolicy, ReceiptLanguagePolicy } from '@print/types';

const PRINT_LANGUAGE_REGISTRY_FACTS = {
  isSelectableLanguage: (code: string) =>
    Object.prototype.hasOwnProperty.call(LANGUAGES, code)
    && LANGUAGES[code as Language].selectable,
};

export function parseStoredReceiptLanguagePolicy(value: unknown): ReceiptLanguagePolicy | null {
  if (typeof value !== 'string') return null;
  try {
    const result = parsePrintLanguagePolicy(JSON.parse(value), PRINT_LANGUAGE_REGISTRY_FACTS);
    return result.ok ? result.policy : null;
  } catch {
    return null;
  }
}

export function parseStoredKotLanguagePolicy(value: unknown): KotLanguagePolicy | null {
  if (typeof value !== 'string') return null;
  try {
    const result = parseKotLanguagePolicy(JSON.parse(value), PRINT_LANGUAGE_REGISTRY_FACTS);
    return result.ok ? result.policy : null;
  } catch {
    return null;
  }
}

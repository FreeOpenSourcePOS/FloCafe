import {
  defaultPrintLanguagePolicy,
  parseKotLanguagePolicy,
  parsePrintLanguagePolicy,
  resolveKotLanguage,
  resolveReceiptLanguages,
} from '../../../shared/print/policy';
import type { KotLanguagePolicy, ReceiptLanguagePolicy, ResolvedPrintLanguages } from '../../../shared/print/types';
import { LANGUAGES, isLanguage, type Language } from './i18n/languages';
import { loadLocaleMessages } from './i18n/loader';
import type { Tenant } from './types';

const PRINT_LANGUAGE_REGISTRY_FACTS = {
  isSelectableLanguage: (code: string) => isLanguage(code) && LANGUAGES[code].selectable,
};

type PosSettingsActions = {
  getState: () => {
    language?: Language;
    setBillLanguagePolicy?: (policy: ReceiptLanguagePolicy) => void;
    setKotLanguagePolicy?: (policy: KotLanguagePolicy) => void;
  };
};

function parsePolicy(value: string | null | undefined, kind: 'receipt' | 'kot'): ReceiptLanguagePolicy | KotLanguagePolicy {
  const fallback = defaultPrintLanguagePolicy();
  if (!value) return fallback;
  try {
    const result = kind === 'receipt'
      ? parsePrintLanguagePolicy(JSON.parse(value), PRINT_LANGUAGE_REGISTRY_FACTS)
      : parseKotLanguagePolicy(JSON.parse(value), PRINT_LANGUAGE_REGISTRY_FACTS);
    return result.ok ? result.policy : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Apply authenticated tenant print policies and warm every selected locale
 * before auth bootstrap releases the dashboard. Failed packaged chunks are
 * returned for the print warning path; they never become a different locale's
 * English output without an explicit failure signal.
 */
export async function syncPrintPoliciesAtBootstrap(
  tenant: Tenant,
  settingsStore: PosSettingsActions,
): Promise<Language[]> {
  const receiptPolicy = parsePolicy(tenant.bill_language_policy, 'receipt') as ReceiptLanguagePolicy;
  const kotPolicy = parsePolicy(tenant.kot_language_policy, 'kot') as KotLanguagePolicy;
  const uiLanguage = isLanguage(tenant.language)
    ? tenant.language
    : settingsStore.getState().language ?? 'en';
  const receiptLanguages = resolveReceiptLanguages(receiptPolicy, uiLanguage) as ResolvedPrintLanguages;
  const kotLanguage = resolveKotLanguage(kotPolicy, uiLanguage) as Language;

  settingsStore.getState().setBillLanguagePolicy?.(receiptPolicy);
  settingsStore.getState().setKotLanguagePolicy?.(kotPolicy);

  const languages = [...new Set([...receiptLanguages, kotLanguage])] as Language[];
  const outcomes = await Promise.allSettled(languages.map((language) => loadLocaleMessages(language)));
  return languages.filter((_, index) => outcomes[index].status === 'rejected');
}
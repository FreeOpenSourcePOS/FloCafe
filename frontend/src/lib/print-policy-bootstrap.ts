import {
  defaultPrintLanguagePolicy,
  parseKotLanguagePolicy,
  parsePrintLanguagePolicy,
  resolveKotLanguage,
  resolveReceiptLanguages,
} from '../../../shared/print/policy';
import type {
  KotLanguagePolicy,
  ReceiptLanguagePolicy,
  ResolvedPrintLanguages,
} from '../../../shared/print/types';
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

type BootstrapBarrierEntry = {
  promise: Promise<void>;
  release: () => void;
};

let activeBootstrapBarrier: BootstrapBarrierEntry | null = null;

/** Tracks the active tenant print-policy bootstrap so immediate prints wait for policy + locale readiness. */
export function registerPrintPolicyBootstrap<T>(task: Promise<T>): Promise<T> {
  const previous = activeBootstrapBarrier;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entry: BootstrapBarrierEntry = {
    promise: gate,
    release,
  };
  activeBootstrapBarrier = entry;
  previous?.release();

  const clearIfCurrent = () => {
    if (activeBootstrapBarrier === entry) {
      activeBootstrapBarrier = null;
    }
    entry.release();
  };
  void task.then(clearIfCurrent, clearIfCurrent);
  return task;
}

/** Releases any in-flight print-policy bootstrap barrier when a session locks, clears, or has no tenant. */
export function clearPrintPolicyBootstrap(): void {
  const previous = activeBootstrapBarrier;
  activeBootstrapBarrier = null;
  previous?.release();
}

/** Resolves once the active tenant's print-policy bootstrap (if any) has settled. */
export async function awaitPrintPolicyBootstrap(): Promise<void> {
  while (activeBootstrapBarrier) {
    await activeBootstrapBarrier.promise;
  }
}

function parsePolicy(
  value: string | null | undefined,
  kind: 'receipt' | 'kot',
): ReceiptLanguagePolicy | KotLanguagePolicy {
  const fallback = defaultPrintLanguagePolicy();
  if (!value) return fallback;
  try {
    const result =
      kind === 'receipt'
        ? parsePrintLanguagePolicy(JSON.parse(value), PRINT_LANGUAGE_REGISTRY_FACTS)
        : parseKotLanguagePolicy(JSON.parse(value), PRINT_LANGUAGE_REGISTRY_FACTS);
    return result.ok ? result.policy : fallback;
  } catch {
    return fallback;
  }
}

export const DEFAULT_PRINT_LOCALE_TIMEOUT_MS = 5_000;

/** Loads a print locale bundle bounded by a deadline so hung fetches fall back to English. */
export async function loadPrintLocaleWithDeadline(
  language: Language,
  timeoutMs: number = DEFAULT_PRINT_LOCALE_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      loadLocaleMessages(language).then(() => undefined),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out loading print locale "${language}" after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Applies tenant print policies and warms selected locales at auth bootstrap;
 * returns any locales that failed to load. */
export async function syncPrintPoliciesAtBootstrap(
  tenant: Tenant,
  settingsStore: PosSettingsActions,
  isCurrent: () => boolean = () => true,
  localeTimeoutMs: number = DEFAULT_PRINT_LOCALE_TIMEOUT_MS,
): Promise<Language[]> {
  const receiptPolicy = parsePolicy(
    tenant.bill_language_policy,
    'receipt',
  ) as ReceiptLanguagePolicy;
  const kotPolicy = parsePolicy(tenant.kot_language_policy, 'kot') as KotLanguagePolicy;
  const uiLanguage = isLanguage(tenant.language)
    ? tenant.language
    : (settingsStore.getState().language ?? 'en');
  const receiptLanguages = resolveReceiptLanguages(
    receiptPolicy,
    uiLanguage,
  ) as ResolvedPrintLanguages;
  const kotLanguage = resolveKotLanguage(kotPolicy, uiLanguage) as Language;

  const languages = [...new Set([...receiptLanguages, kotLanguage])] as Language[];
  const outcomes = await Promise.allSettled(
    languages.map((language) => loadPrintLocaleWithDeadline(language, localeTimeoutMs)),
  );
  if (!isCurrent()) return [];

  settingsStore.getState().setBillLanguagePolicy?.(receiptPolicy);
  settingsStore.getState().setKotLanguagePolicy?.(kotPolicy);
  return languages.filter((_, index) => outcomes[index].status === 'rejected');
}

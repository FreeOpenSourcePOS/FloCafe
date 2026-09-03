/**
 * warnings-toast.ts
 *
 * Amber toast shown after a print job skipped lines it could not render.
 * Messages are localized in the active UI language (#437) so a Persian
 * merchant, for example, can read why items were missing and which setting
 * fixes it; the skipped line contents themselves are raw receipt data
 * (item names etc.) and are listed as-is.
 */

import toast from 'react-hot-toast';
import { createTranslator } from 'use-intl/core';
import type { PrintLanguageCode } from '@print/types';
import type { PrintWarning } from './warnings';
import { hasArabicScript } from './warnings';
import { getCachedMessages } from '@/lib/i18n/loader';
import { LANGUAGES, type Language } from '@/lib/i18n/languages';
import { usePosSettingsStore } from '@/store/pos-settings';

/** Max skipped-line excerpts listed before collapsing into "…and N more". */
const MAX_LISTED_LINES = 8;

function resolveLanguage(): Language {
  try {
    return usePosSettingsStore.getState().language ?? 'en';
  } catch {
    return 'en';
  }
}

/** Same translator bootstrap as web-print.ts: cached bundle, English fallback. */
function getTranslator(lang: Language): (key: string, values?: Record<string, unknown>) => string {
  const locale = LANGUAGES[lang]?.locale ?? 'en';
  const messages = getCachedMessages(lang) ?? getCachedMessages('en') ?? {};
  return createTranslator({ locale, messages }) as unknown as
    (key: string, values?: Record<string, unknown>) => string;
}

/** Shows one amber toast listing every line a print job skipped, if any. */
export function showPrintWarningsToast(warnings: PrintWarning[]): void {
  if (warnings.length === 0) return;

  const t = getTranslator(resolveLanguage());
  const lineWarnings = warnings.filter((warning) => warning.kind !== 'configuration');
  const templateWarnings = warnings.filter((warning) => warning.kind === 'configuration');
  const sections: string[] = [];
  if (templateWarnings.length > 0) sections.push(t('printWarnings.templateFallback'));
  if (lineWarnings.length > 0) {
    const hasArabic = lineWarnings.some((warning) => hasArabicScript(warning.text));
    sections.push(t('printWarnings.title', { count: lineWarnings.length }));
    sections.push(hasArabic ? t('printWarnings.arabicShapingHint') : t('printWarnings.genericHint'));
  }

  const texts = warnings.map((warning) => warning.message || warning.text).filter(Boolean);
  if (texts.length > 0) {
    const listed = texts.slice(0, MAX_LISTED_LINES);
    if (texts.length > MAX_LISTED_LINES) {
      listed.push(t('printWarnings.moreLines', { count: texts.length - MAX_LISTED_LINES }));
    }
    sections.push(listed.join('\n'));
  }

  toast(sections.join('\n\n'), {
    duration: 7000,
    style: {
      background: '#fffbeb',
      color: '#b45309',
      border: '1px solid #fcd34d',
      whiteSpace: 'pre-line',
    },
  });
}

export function showPrintLanguageLoadErrorsToast(languages: readonly PrintLanguageCode[]): void {
  if (languages.length === 0) return;

  toast.error(
    `Print language bundle(s) "${languages.join(', ')}" could not be loaded. Check the locale bundle and reload the app to retry.`,
    { duration: 7000, id: 'print-language-load-errors' },
  );
}

'use client';

import { Toaster } from 'react-hot-toast';
import { useLocale } from 'use-intl';
import { getLanguageDirection, getLanguageFromLocale } from '@/lib/i18n';

/**
 * Direction-aware toast host (Batch E, Refs #241).
 *
 * react-hot-toast's `position` prop is physical (`top-right` / `top-left`),
 * so it must follow the active document direction: RTL languages (Persian)
 * place toasts at the inline-end (top-left) while LTR languages keep the
 * existing top-right placement. Direction comes from the active loaded
 * locale in the i18n context (`useLocale`), not a hard-coded language
 * check — and only flips after the locale's bundle has actually loaded
 * (#375/#376). Toast content direction itself is inherited from
 * `<html dir>` via HtmlLangSync.
 */
export function DirectionalToaster() {
  const locale = useLocale();
  const language = getLanguageFromLocale(locale) ?? 'en';
  const rtl = getLanguageDirection(language) === 'rtl';
  return <Toaster position={rtl ? 'top-left' : 'top-right'} />;
}

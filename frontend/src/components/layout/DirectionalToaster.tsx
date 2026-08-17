'use client';

import { Toaster } from 'react-hot-toast';
import { usePosSettingsStore } from '@/store/pos-settings';
import { getLanguageDirection } from '@/lib/i18n';

/**
 * Direction-aware toast host (Batch E, Refs #241).
 *
 * react-hot-toast's `position` prop is physical (`top-right` / `top-left`),
 * so it must follow the active document direction: RTL languages (Persian)
 * place toasts at the inline-end (top-left) while LTR languages keep the
 * existing top-right placement. Direction comes from the shared language
 * metadata (`getLanguageDirection`), not a hard-coded language check. Toast
 * content direction itself is inherited from `<html dir>` via HtmlLangSync.
 */
export function DirectionalToaster() {
  const language = usePosSettingsStore((s) => s.language);
  const rtl = getLanguageDirection(language) === 'rtl';
  return <Toaster position={rtl ? 'top-left' : 'top-right'} />;
}

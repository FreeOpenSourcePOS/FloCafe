'use client';

import { Toaster } from 'react-hot-toast';
import { usePosSettingsStore } from '@/store/pos-settings';

/**
 * Direction-aware toast host (Batch E, Refs #241).
 *
 * react-hot-toast's `position` prop is physical (`top-right` / `top-left`),
 * so it must follow the active document direction: Persian (RTL) toasts
 * appear at the inline-end (top-left) while all LTR languages keep the
 * existing top-right placement. Toast content direction itself is inherited
 * from `<html dir>` via HtmlLangSync.
 */
export function DirectionalToaster() {
  const language = usePosSettingsStore((s) => s.language);
  return <Toaster position={language === 'fa' ? 'top-left' : 'top-right'} />;
}

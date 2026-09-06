'use client';

import { ToastBar, Toaster } from 'react-hot-toast';
import { useLocale } from 'use-intl';
import { getLanguageDirection, getLanguageFromLocale } from '@/lib/i18n';

/** Direction-aware toast host with drain progress bar; remounts on direction
 * flip to safely position toasts inline-end without DOM racing. */
export function DirectionalToaster() {
  const locale = useLocale();
  const language = getLanguageFromLocale(locale) ?? 'en';
  const rtl = getLanguageDirection(language) === 'rtl';

  return (
    <Toaster
      key={rtl ? 'rtl' : 'ltr'}
      position={rtl ? 'top-left' : 'top-right'}
      containerStyle={{
        top: 'calc(var(--flo-sidebar-block-start, 0px) + 16px)',
      }}
      toastOptions={{
        className: 'flo-toast-card',
        duration: 4000,
        success: {
          duration: 2500,
        },
      }}
    >
      {(t) => (
        <ToastBar
          toast={t}
          style={{
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {({ icon, message }) => (
            <>
              {icon}
              {message}
              {t.type !== 'loading' && t.duration !== Infinity && (
                <span
                  aria-hidden="true"
                  className={`flo-toast-drain flo-toast-drain--${t.type}`}
                  style={{
                    animationDuration: `${t.duration || (t.type === 'success' ? 2000 : 4000)}ms`,
                  }}
                />
              )}
            </>
          )}
        </ToastBar>
      )}
    </Toaster>
  );
}

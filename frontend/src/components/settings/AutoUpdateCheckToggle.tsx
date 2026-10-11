'use client';

/** Settings switch for the automatic startup update check. */

import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { useAutoUpdateCheck } from '@/hooks/useAutoUpdateCheck';

export default function AutoUpdateCheckToggle() {
  const t = useTranslations('update');
  const { supported, enabled, busy, setEnabled } = useAutoUpdateCheck();

  const handleChange = async (next: boolean) => {
    if (!(await setEnabled(next))) toast.error(t('autoCheckToggleFailed'));
  };

  if (supported === false) return null;

  return (
    <div
      className="bg-card rounded-xl border border-border p-6"
      data-testid="auto-update-check-toggle"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold text-foreground">{t('autoCheckTitle')}</h3>
          <p className="text-sm text-muted-foreground mt-1">{t('autoCheckDescription')}</p>
        </div>
        <label className="inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            disabled={supported !== true || busy}
            onChange={(e) => void handleChange(e.target.checked)}
            data-testid="auto-update-check-checkbox"
            aria-label={t('autoCheckTitle')}
            className="sr-only peer"
          />
          <span
            className={`relative w-9 h-5 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-brand ${
              enabled ? 'bg-brand' : 'bg-gray-300'
            } ${supported === true ? '' : 'opacity-40 cursor-not-allowed'}`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 bg-card rounded-full shadow transition-transform ${
                enabled ? 'translate-x-4' : ''
              }`}
            />
          </span>
          <span className="ml-2 text-sm font-medium text-foreground">
            {enabled ? t('betaOn') : t('betaOff')}
          </span>
        </label>
      </div>
    </div>
  );
}

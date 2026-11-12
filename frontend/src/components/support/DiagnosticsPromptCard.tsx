'use client';

/** Small, non-blocking ask for error reports after a problem. Nothing blocks the POS. */

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { Bug } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth';
import { useCartStore } from '@/store/cart';
import { shouldShowDiagnosticsPrompt } from '@shared/diagnostics-prompt';

interface PromptState {
  enabled: boolean;
  dismissed: boolean;
  prompt_count: number;
  last_asked_at: string | null;
  problems_since: number;
}

const TOAST_ID = 'diagnostics-prompt';

// One check per app launch, whatever the router does.
let checkedThisLaunch = false;

export default function DiagnosticsPromptCard() {
  const t = useTranslations('diagnosticsPrompt');
  const tp = useTranslations('productAnalytics');
  const pathname = usePathname();
  const token = useAuthStore((s) => s.token);
  const hasItems = useCartStore((s) => s.items.length > 0);

  useEffect(() => {
    if (!token || checkedThisLaunch) return;
    checkedThisLaunch = true;
    const orderOrPaymentOpen = hasItems || Boolean(pathname?.startsWith('/orders'));
    let cancelled = false;

    const close = () => toast.dismiss(TOAST_ID);

    const sendReports = async () => {
      close();
      try {
        await api.put('/settings/diagnostics_consent', { value: 'true' });
        await api.put('/settings/diagnostics_transmission_enabled', { value: 'true' });
      } catch {
        toast.error(tp('saveFailed'));
      }
    };

    const dontAskAgain = async () => {
      close();
      try {
        await api.post('/settings/diagnostics-prompt', { event: 'dismissed' });
      } catch {
        /* The local flag already stops this launch; the next launch retries. */
      }
    };

    const whatIsSent = () => toast(`${tp('errorsBody')} ${tp('neverSee')}`, { duration: 8000 });

    api
      .get<PromptState>('/settings/diagnostics-prompt')
      .then(({ data }) => {
        if (cancelled || !data) return;
        const show = shouldShowDiagnosticsPrompt({
          enabled: data.enabled,
          dismissed: data.dismissed,
          promptCount: data.prompt_count,
          lastAskedAt: data.last_asked_at,
          problemsSince: data.problems_since,
          orderOrPaymentOpen,
          now: Date.now(),
        });
        if (!show) return;
        toast.custom(
          () => (
            <div
              className="flex w-[20rem] max-w-[calc(100vw-2rem)] flex-col gap-2"
              data-testid="diagnostics-prompt"
            >
              <p className="flex items-start gap-2 text-sm text-foreground">
                <Bug size={16} className="mt-0.5 shrink-0 text-brand" />
                <span>{t('body', { count: data.problems_since })}</span>
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void sendReports()}
                  data-testid="diagnostics-prompt-send"
                >
                  {t('send')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={close}
                  data-testid="diagnostics-prompt-not-now"
                >
                  {t('notNow')}
                </Button>
              </div>
              <div className="flex items-center justify-between text-xs">
                <button type="button" className="underline underline-offset-2" onClick={whatIsSent}>
                  {t('whatIsSent')}
                </button>
                <button
                  type="button"
                  className="underline underline-offset-2 text-muted-foreground"
                  onClick={() => void dontAskAgain()}
                  data-testid="diagnostics-prompt-dont-ask"
                >
                  {t('dontAsk')}
                </button>
              </div>
            </div>
          ),
          { id: TOAST_ID, duration: Infinity, className: 'flo-toast-card' },
        );
        api.post('/settings/diagnostics-prompt', { event: 'shown' }).catch(() => {});
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [token, pathname, hasItems, t, tp]);

  return null;
}

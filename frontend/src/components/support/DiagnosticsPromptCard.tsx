'use client';

/** Small, non-blocking ask for error reports after a problem. Nothing blocks the POS. */

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { Bug } from 'lucide-react';
import { normalizePathname } from '@/lib/utils';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';
import { useCartStore } from '@/store/cart';
import { shouldShowDiagnosticsPrompt } from '@shared/diagnostics-prompt';

interface PromptState {
  enabled: boolean;
  dismissed: boolean;
  prompt_count: number;
  last_asked_at: string | null;
  problems_since: number;
}

// One check per app launch, whatever the router does.
let checkedThisLaunch = false;

export default function DiagnosticsPromptCard() {
  const t = useTranslations('diagnosticsPrompt');
  const tp = useTranslations('productAnalytics');
  const ts = useTranslations('support');
  const pathname = usePathname();
  const token = useAuthStore((s) => s.token);
  // Only managers can turn reports on; others would get a 403 on every launch.
  const canManage = useAuthStore((s) => tenantCan(s.currentTenant, 'settings.manage'));
  const hasItems = useCartStore((s) => s.items.length > 0);
  const [problems, setProblems] = useState(0);
  const [open, setOpen] = useState(false);
  const shownSent = useRef(false);
  const path = normalizePathname(pathname);
  // Hidden, not dismissed, on the selling screens and while an order is in progress.
  const visible =
    open && !hasItems && !['/pos', '/kds', '/tables'].includes(path) && !path.startsWith('/orders');

  useEffect(() => {
    if (!token || !canManage || checkedThisLaunch) return;
    checkedThisLaunch = true;
    api
      .get<PromptState>('/settings/diagnostics-prompt')
      .then(({ data }) => {
        if (!data) return;
        const show = shouldShowDiagnosticsPrompt({
          enabled: data.enabled,
          dismissed: data.dismissed,
          promptCount: data.prompt_count,
          lastAskedAt: data.last_asked_at,
          problemsSince: data.problems_since,
          now: Date.now(),
        });
        if (!show) return;
        setProblems(data.problems_since);
        setOpen(true);
      })
      .catch(() => {});
  }, [token, canManage]);

  useEffect(() => {
    if (!visible || shownSent.current) return;
    shownSent.current = true;
    api.post('/settings/diagnostics-prompt', { event: 'shown' }).catch(() => {});
  }, [visible]);

  const body = t('body', { count: problems });
  // Mounted before the card, so screen readers announce the text when it appears; no role, so
  // it does not compete with the page's own status messages.
  const status = (
    <p aria-live="polite" className="sr-only">
      {visible ? body : ''}
    </p>
  );
  if (!visible) return status;

  const sendReports = async () => {
    try {
      await api.post('/settings/diagnostics-prompt', { event: 'accepted' });
    } catch {
      /* The count is optional; turning reports on is not. */
    }
    try {
      await api.put('/settings/diagnostics_consent', { value: 'true' });
      await api.put('/settings/diagnostics_transmission_enabled', {
        value: 'true',
      });
      setOpen(false);
    } catch {
      // The card stays, so the person can try again.
      toast.error(tp('saveFailed'));
    }
  };

  const dontAskAgain = async () => {
    try {
      await api.post('/settings/diagnostics-prompt', { event: 'dismissed' });
      setOpen(false);
    } catch {
      // The card stays, so the choice is not lost.
      toast.error(tp('saveFailed'));
    }
  };

  const whatIsSent = () =>
    toast(t('whatIsSentBody', { place: ts('tabDiagnostics') }), {
      duration: 12000,
    });

  return (
    <>
      {status}
      <div
        role="region"
        aria-labelledby="diagnostics-prompt-body"
        data-testid="diagnostics-prompt"
        className="fixed bottom-12 end-4 z-40 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-xl border border-border bg-background p-4 text-sm shadow-lg"
      >
        <p className="flex items-start gap-2 text-foreground">
          <Bug size={16} className="mt-0.5 shrink-0 text-brand" aria-hidden="true" />
          <span id="diagnostics-prompt-body">{body}</span>
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
            onClick={() => setOpen(false)}
            data-testid="diagnostics-prompt-not-now"
          >
            {t('notNow')}
          </Button>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs">
          <button type="button" className="underline underline-offset-2" onClick={whatIsSent}>
            {t('whatIsSent')}
          </button>
          <button
            type="button"
            className="text-muted-foreground underline underline-offset-2"
            onClick={() => void dontAskAgain()}
            data-testid="diagnostics-prompt-dont-ask"
          >
            {t('dontAsk')}
          </button>
        </div>
      </div>
    </>
  );
}

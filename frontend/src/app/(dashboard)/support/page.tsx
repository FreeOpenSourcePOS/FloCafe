'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LifeBuoy } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { SupportTicketForm } from '@/components/support/SupportTicketForm';
import { DiagnosticsPanel, type LocalFailure } from '@/components/support/DiagnosticsPanel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const TICKET_TAB = 'ticket';
const DIAGNOSTICS_TAB = 'diagnostics';

type TicketDraft = { id: number; category: string; subject: string; message: string };

const EMPTY_DRAFT: TicketDraft = { id: 0, category: '', subject: '', message: '' };

export default function SupportPage() {
  const t = useTranslations('support');
  const router = useRouter();
  const searchParams = useSearchParams();
  // Deep-linkable so a link can open straight into the requested half of the hub.
  const requestedTab = searchParams?.get('tab') === DIAGNOSTICS_TAB ? DIAGNOSTICS_TAB : TICKET_TAB;
  const [activeTab, setActiveTab] = useState(requestedTab);
  const [draft, setDraft] = useState<TicketDraft>(EMPTY_DRAFT);

  // Sync the active tab when the query string changes while mounted, so back
  // and forward and an in-app link to a deep link land on the right half.
  useEffect(() => {
    // This is navigation state arriving from Next.js, not an async data effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveTab(requestedTab);
  }, [requestedTab]);

  const handleTabChange = useCallback((value: string) => {
    setActiveTab(value);
    const next = value === TICKET_TAB ? '' : `?tab=${value}`;
    router.replace(`/support${next}`);
  }, [router]);

  /** Turn a captured failure into a started report, so the evidence is not retyped. */
  const handleCreateTicket = useCallback((failure: LocalFailure) => {
    const metadata = failure.metadata ? `\nmetadata: ${JSON.stringify(failure.metadata)}` : '';
    // The id changes so the form remounts onto this draft rather than keeping
    // whatever was half typed before.
    setDraft((current) => ({
      id: current.id + 1,
      category: 'bug',
      // The backend keeps 255 characters; the full signature stays in the
      // message, so bound the subject here instead of losing its tail on save.
      subject: `[Failure] ${failure.event_code}: ${failure.signature}`.slice(0, 255),
      message: `${t('diagnosticsFailureReport')}\n`
        + `occurred_at: ${failure.occurred_at}\n`
        + `summary: ${failure.summary}\n`
        + `signature: ${failure.signature}\n`
        + `event_code: ${failure.event_code}\n`
        + `severity: ${failure.severity}`
        + metadata,
    }));
    handleTabChange(TICKET_TAB);
  }, [handleTabChange, t]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-brand/10 p-3 text-brand"><LifeBuoy className="size-6" /></div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value={TICKET_TAB}>{t('menuSubmitTicket')}</TabsTrigger>
          <TabsTrigger value={DIAGNOSTICS_TAB}>{t('tabDiagnostics')}</TabsTrigger>
        </TabsList>
        <TabsContent value={TICKET_TAB} forceMount hidden={activeTab !== TICKET_TAB}>
          <SupportTicketForm
            key={draft.id}
            initialCategory={draft.category || undefined}
            initialSubject={draft.subject}
            initialMessage={draft.message}
          />
        </TabsContent>
        <TabsContent value={DIAGNOSTICS_TAB}>
          <DiagnosticsPanel onCreateTicket={handleCreateTicket} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

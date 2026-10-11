'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LifeBuoy } from 'lucide-react';
import { useTranslations } from 'use-intl';
import {
  SupportTicketForm,
  type SupportOperationFailure,
} from '@/components/support/SupportTicketForm';
import { DiagnosticsPanel, type LocalFailure } from '@/components/support/DiagnosticsPanel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const TICKET_TAB = 'ticket';
const DIAGNOSTICS_TAB = 'diagnostics';

type TicketDraft = {
  id: number;
  category: string;
  subject: string;
  message: string;
  eventCode?: string;
  correlationId?: string;
  operationFailure?: SupportOperationFailure;
  diagnostics?: Record<string, unknown>;
};

type HubState = {
  tab: string;
  /** The ticket form mounts the first time its tab is shown and stays mounted
   * after, so it never loads for a tab nobody opened but survives a switch. */
  ticketTabSeen: boolean;
};

const EMPTY_DRAFT: TicketDraft = { id: 0, category: '', subject: '', message: '' };
const FAILURE_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HELP_CAPTURE_OUTCOMES: Record<string, readonly string[]> = {
  'fc.backend.order.create.quantity_validation': ['not_applied'],
  'fc.backend.order.create.stock_validation': ['not_applied'],
  'fc.backend.order.create.other_validation': ['not_applied'],
  'fc.backend.order.create.persistence': ['not_applied', 'partial', 'unknown'],
  'fc.backend.order.create.server_error': ['not_applied', 'partial', 'unknown'],
  'fc.backend.order.create.completion': ['applied'],
  'fc.backend.order.append.validation': ['not_applied'],
  'fc.backend.order.append.persistence': ['not_applied'],
  'fc.backend.order.append.completion': ['applied'],
  'fc.backend.order.discount.validation': ['not_applied'],
  'fc.backend.order.discount.persistence': ['not_applied'],
  'fc.backend.order.discount.completion': ['applied'],
  'fc.backend.bill.discount.validation': ['not_applied'],
  'fc.backend.bill.discount.persistence': ['not_applied'],
  'fc.backend.bill.discount.completion': ['applied'],
  'fc.backend.payment.create.validation': ['not_applied'],
  'fc.backend.payment.create.persistence': ['not_applied', 'partial', 'unknown'],
  'fc.backend.payment.create.completion': ['applied'],
  'fc.backend.bill.generate.validation': ['not_applied'],
  'fc.backend.bill.generate.failure': ['not_applied', 'partial', 'unknown'],
  'fc.backend.bill.generate.completion': ['applied'],
  'fc.backend.bill.charge.validation': ['not_applied'],
  'fc.backend.bill.charge.persistence': ['not_applied', 'unknown'],
  'fc.backend.bill.charge.completion': ['applied'],
  'fc.frontend.pos.order.append.transport': ['unknown'],
  'fc.frontend.pos.order.append.recovery': ['unknown'],
  'fc.frontend.pos.order.append.retry_storage': ['not_applied'],
  'fc.frontend.pos.order.append.retry_cleanup': ['applied'],
  'fc.frontend.pos.order.create.transport': ['unknown'],
  'fc.frontend.pos.order.create.recovery': ['unknown'],
  'fc.frontend.pos.order.create.retry_storage': ['not_applied'],
  'fc.frontend.pos.order.create.retry_cleanup': ['applied'],
  'fc.frontend.pos.order.create.held_cleanup': ['applied'],
  'fc.frontend.pos.payment.create.transport': ['unknown'],
  'fc.frontend.pos.payment.create.recovery': ['unknown'],
  'fc.frontend.pos.payment.create.retry_storage': ['not_applied'],
  'fc.frontend.pos.payment.create.retry_cleanup': ['applied'],
  'fc.frontend.pos.payment.create.held_cleanup': ['applied'],
  'fc.client.order.create.retry_state_update': ['applied'],
  'fc.client.payment.create.retry_state_update': ['applied'],
  'fc.client.bill.generate.retry_state_update': ['applied'],
};
const HELP_DISPLAY_CODES = new Set([
  'invalid_type',
  'invalid_value',
  'disabled',
  'type_disabled',
  'limit_exceeded',
  'order_not_discountable',
  'bill_not_discountable',
  'split_check',
  'refunded',
  'paid',
  'transaction_reference_used',
  'transaction_reference_reused',
  'bill_refunded',
  'bill_already_paid',
  'customer_mismatch',
  'customer_unavailable',
  'wallet_customer_required',
  'amount_required',
  'non_cash_exceeds_balance',
  'cash_reference_zero_applied',
  'wallet_insufficient',
  'kitchen_undelivered',
  'idempotency_conflict',
  'payment_method_unavailable',
  'payment_input_invalid',
  'charge_required',
  'bill_not_found',
  'split_check',
  'bill_paid',
  'bill_refunded',
  'order_not_found',
  'order_cancelled',
  'charge_unavailable',
  'order_type_unsupported',
  'change_required',
  'invalid_change_type',
  'charge_not_waivable',
  'charge_always_applied',
]);
const HELP_FAILURE_CLASSES = new Set([
  'timeout',
  'dns',
  'connection_refused',
  'offline',
  'unreachable',
  'invalid_response',
  'unknown',
]);

function operationFailureForHelp(failure: LocalFailure): {
  correlationId?: string;
  operationFailure?: SupportOperationFailure;
} {
  const metadata = failure.metadata;
  if (!metadata) return {};
  const correlationId =
    typeof metadata.correlation_id === 'string' && FAILURE_UUID_V4.test(metadata.correlation_id)
      ? metadata.correlation_id
      : undefined;
  const capturePoint = metadata.capture_point;
  const outcome = metadata.outcome;
  if (
    !correlationId ||
    typeof capturePoint !== 'string' ||
    typeof outcome !== 'string' ||
    !Object.prototype.hasOwnProperty.call(HELP_CAPTURE_OUTCOMES, capturePoint) ||
    !HELP_CAPTURE_OUTCOMES[capturePoint].includes(outcome)
  )
    return { correlationId };

  const facts: NonNullable<SupportOperationFailure['facts']> = {};
  if (typeof metadata.display_code === 'string' && HELP_DISPLAY_CODES.has(metadata.display_code)) {
    facts.display_code = metadata.display_code;
  }
  if (
    capturePoint.endsWith('.transport') &&
    typeof metadata.failure_class === 'string' &&
    HELP_FAILURE_CLASSES.has(metadata.failure_class)
  ) {
    facts.failure_class = metadata.failure_class;
  }
  if (capturePoint.endsWith('.transport') && !facts.failure_class) return { correlationId };

  return {
    correlationId,
    operationFailure: {
      capture_point: capturePoint,
      operation_id: correlationId,
      outcome,
      ...(Object.keys(facts).length > 0 ? { facts } : {}),
    },
  };
}

export default function SupportPage() {
  const t = useTranslations('support');
  const router = useRouter();
  const searchParams = useSearchParams();
  // Deep-linkable so a link can open straight into the requested half of the hub.
  const requestedTab = searchParams?.get('tab') === DIAGNOSTICS_TAB ? DIAGNOSTICS_TAB : TICKET_TAB;
  const [hub, setHub] = useState<HubState>({
    tab: requestedTab,
    ticketTabSeen: requestedTab === TICKET_TAB,
  });
  const [draft, setDraft] = useState<TicketDraft>(EMPTY_DRAFT);

  // Sync the active tab when the query string changes while mounted, so back
  // and forward and an in-app link to a deep link land on the right half.
  useEffect(() => {
    // This is navigation state arriving from Next.js, not an async data effect.
    // oxlint-disable-next-line react-hooks/set-state-in-effect
    setHub((current) =>
      current.tab === requestedTab
        ? current
        : {
            tab: requestedTab,
            ticketTabSeen: current.ticketTabSeen || requestedTab === TICKET_TAB,
          },
    );
  }, [requestedTab]);

  const handleTabChange = useCallback(
    (value: string) => {
      setHub((current) => ({
        tab: value,
        ticketTabSeen: current.ticketTabSeen || value === TICKET_TAB,
      }));
      const next = value === TICKET_TAB ? '' : `?tab=${value}`;
      router.replace(`/support${next}`);
    },
    [router],
  );

  /** Turn a captured failure into a started report, so the evidence is not retyped. */
  const handleCreateTicket = useCallback(
    (failure: LocalFailure) => {
      const metadata = failure.metadata ? `\nmetadata: ${JSON.stringify(failure.metadata)}` : '';
      const operationContext = operationFailureForHelp(failure);
      // The id changes so the form remounts onto this draft rather than keeping
      // whatever was half typed before.
      setDraft((current) => ({
        id: current.id + 1,
        category: 'bug',
        // The backend keeps 255 characters; the full signature stays in the
        // message, so bound the subject here instead of losing its tail on save.
        subject: `[Failure] ${failure.event_code}: ${failure.signature}`.slice(0, 255),
        eventCode: failure.event_code,
        correlationId: operationContext.correlationId,
        operationFailure: operationContext.operationFailure,
        diagnostics: {
          selected_failure: {
            event_code: failure.event_code,
            severity: failure.severity,
            error_class: failure.error_class,
            signature: failure.signature,
            occurred_at: failure.occurred_at,
          },
        },
        message:
          `${t('diagnosticsFailureReport')}\n` +
          `occurred_at: ${failure.occurred_at}\n` +
          `summary: ${failure.summary}\n` +
          `signature: ${failure.signature}\n` +
          `event_code: ${failure.event_code}\n` +
          `severity: ${failure.severity}` +
          metadata,
      }));
      handleTabChange(TICKET_TAB);
    },
    [handleTabChange, t],
  );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-brand/10 p-3 text-brand">
          <LifeBuoy className="size-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </div>

      <Tabs value={hub.tab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value={TICKET_TAB}>{t('menuSubmitTicket')}</TabsTrigger>
          <TabsTrigger value={DIAGNOSTICS_TAB}>{t('tabDiagnostics')}</TabsTrigger>
        </TabsList>
        {hub.ticketTabSeen && (
          <TabsContent value={TICKET_TAB} forceMount hidden={hub.tab !== TICKET_TAB}>
            <SupportTicketForm
              key={draft.id}
              initialCategory={draft.category || undefined}
              initialSubject={draft.subject}
              initialMessage={draft.message}
              initialEventCode={draft.eventCode}
              initialCorrelationId={draft.correlationId}
              initialOperationFailure={draft.operationFailure}
              initialDiagnostics={draft.diagnostics}
            />
          </TabsContent>
        )}
        <TabsContent value={DIAGNOSTICS_TAB}>
          <DiagnosticsPanel onCreateTicket={handleCreateTicket} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

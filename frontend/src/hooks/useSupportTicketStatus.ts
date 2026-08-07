'use client';

import { useEffect, useRef, useState } from 'react';
import api from '@/lib/api';

export interface SupportTicketDelivery {
  status: 'pending' | 'sending' | 'delivered' | 'failed' | null;
  supportCode: string | null;
}

const POLL_INTERVAL_MS = 4000;
const MAX_POLLS = 20;

/**
 * Submission is fire-and-forget into FloCafe's local outbox — the real
 * support_code only exists once FloAdmin has accepted the ticket. Polls the
 * local status route until delivery is confirmed (or gives up after
 * MAX_POLLS, leaving the outbox's own retry/backoff to keep trying).
 */
export function useSupportTicketStatus(clientTicketId: string | null): SupportTicketDelivery {
  const [state, setState] = useState<SupportTicketDelivery>({ status: null, supportCode: null });
  const pollsRef = useRef(0);

  // Reset synchronously when the tracked ticket changes, read directly during
  // render (React's recommended pattern for "adjusting state when a prop
  // changes") rather than inside the effect below.
  const [trackedId, setTrackedId] = useState(clientTicketId);
  if (clientTicketId !== trackedId) {
    setTrackedId(clientTicketId);
    setState({ status: null, supportCode: null });
  }

  useEffect(() => {
    pollsRef.current = 0;
    if (!clientTicketId) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const { data } = await api.get(`/support-ticket/${clientTicketId}/status`);
        if (cancelled) return;
        setState({ status: data.status ?? null, supportCode: data.support_code ?? null });
        if (data.status === 'delivered') return;
      } catch {
        // Transient — keep polling until MAX_POLLS is exhausted.
      }
      pollsRef.current += 1;
      if (!cancelled && pollsRef.current < MAX_POLLS) {
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [clientTicketId]);

  return state;
}

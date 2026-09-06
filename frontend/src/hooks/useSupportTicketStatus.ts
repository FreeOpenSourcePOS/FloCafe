'use client';

import { useEffect, useRef, useState } from 'react';
import api from '@/lib/api';

export interface SupportTicketDelivery {
  status: 'pending' | 'sending' | 'delivered' | 'failed' | null;
  supportCode: string | null;
}

const POLL_INTERVAL_MS = 4000;
const MAX_POLLS = 20;

/** Polls local status route until ticket delivery is confirmed
 * or max retry threshold is reached. */
export function useSupportTicketStatus(clientTicketId: string | null): SupportTicketDelivery {
  const [state, setState] = useState<SupportTicketDelivery>({ status: null, supportCode: null });
  const pollsRef = useRef(0);

  // Reset synchronously during render when tracked ticket changes.
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

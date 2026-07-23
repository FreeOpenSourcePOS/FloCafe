'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';

/**
 * Returns true iff Flo's WhatsApp integration is enabled and currently
 * connected. Polls /whatsapp/status every 5s. Single boolean — the rest of
 * the status payload is not needed by any current consumer.
 */
export function useWhatsAppReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const tick = async () => {
      try {
        const { data } = await api.get('/whatsapp/status');
        setReady(!!data?.enabled && data?.state === 'connected');
      } catch {
        // not logged in or backend down — keep last known value
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);
  return ready;
}

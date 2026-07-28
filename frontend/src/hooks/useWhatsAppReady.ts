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
    let active = true;
    const tick = async () => {
      try {
        const { data } = await api.get('/whatsapp/status');
        if (active) {
          setReady(!!data?.enabled && data?.state === 'connected');
        }
      } catch {
        // not logged in or backend down — keep last known value
      }
    };
    void tick();
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') void tick();
    }, 5000);
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') void tick();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      active = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);
  return ready;
}

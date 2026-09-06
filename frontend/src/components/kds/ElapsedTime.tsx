'use client';

import { useEffect, useState } from 'react';
import { parseDbTimestamp } from '@/lib/utils';

function formatElapsed(dateStr: string): string {
  const timestamp = parseDbTimestamp(dateStr).getTime();
  if (!Number.isFinite(timestamp)) return '—';
  const totalSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Renders elapsed time for an order with a local 1-second tick,
 * avoiding parent re-renders every second. */
export function ElapsedTime({ dateStr }: { dateStr: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return <span>{formatElapsed(dateStr)}</span>;
}

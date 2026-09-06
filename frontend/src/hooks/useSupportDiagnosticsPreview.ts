'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';

/** Fetches system diagnostics preview attached to support tickets. */
export function useSupportDiagnosticsPreview(category: string | null): Record<string, unknown> | null {
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);

  // Reset synchronously during render when category changes.
  const [trackedCategory, setTrackedCategory] = useState(category);
  if (category !== trackedCategory) {
    setTrackedCategory(category);
    setPreview(null);
  }

  useEffect(() => {
    if (category === null) return;
    let cancelled = false;
    api.get('/support-ticket/diagnostics-preview', { params: { category } })
      .then(({ data }) => { if (!cancelled) setPreview(data); })
      .catch(() => { if (!cancelled) setPreview(null); });
    return () => { cancelled = true; };
  }, [category]);

  return preview;
}

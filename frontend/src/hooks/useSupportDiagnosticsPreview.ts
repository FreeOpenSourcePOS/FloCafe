'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';

/**
 * The system diagnostics fields FloCafe's local backend attaches to a
 * support ticket on submit (device, app version, cloud sync status, etc).
 * Fetched from the same code path the submit route uses, so a "here's
 * exactly what gets sent" preview can never drift from what's actually sent.
 */
export function useSupportDiagnosticsPreview(category: string | null): Record<string, unknown> | null {
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);

  // Reset synchronously when category changes, read directly during render
  // (React's recommended pattern for "adjusting state when a prop changes")
  // rather than inside the effect below.
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

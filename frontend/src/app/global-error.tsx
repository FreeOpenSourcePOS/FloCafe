'use client';

import { useEffect, useRef, useState } from 'react';
import { reportRendererError } from '@/lib/report-renderer-error';

/**
 * Catches an exception thrown by the root layout itself (e.g. I18nProvider,
 * AuthGuard) — the one place a render error would otherwise produce a blank
 * white window with no recovery path at all. Must render its own <html>/
 * <body>: this replaces the root layout entirely while active.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const reportedDigest = useRef<string | undefined>(undefined);
  const [reportStatus, setReportStatus] = useState<'pending' | 'sent' | 'failed'>('pending');

  useEffect(() => {
    const digest = error.digest ?? error.message;
    if (reportedDigest.current !== digest) {
      reportedDigest.current = digest;
      setReportStatus('pending');
      void reportRendererError(error).then((sent) => {
        // A newer error may have started (and possibly already finished) its
        // own report while this one was in flight — don't let this stale
        // completion overwrite that newer status.
        if (reportedDigest.current === digest) setReportStatus(sent ? 'sent' : 'failed');
      });
    }
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f8f8f8', color: '#1a1a1a' }}>
        <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Flo needs to restart</h1>
            <p style={{ fontSize: 14, color: '#555', marginBottom: 16 }}>
              Something went wrong loading Flo. Your data is safe.{' '}
              {reportStatus === 'pending' && 'Sending a diagnostic report…'}
              {reportStatus === 'sent' && 'A diagnostic report was sent automatically.'}
              {reportStatus === 'failed' && "Couldn't send a diagnostic report automatically."}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button
                onClick={() => reset()}
                style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#3248FF', color: '#fff', cursor: 'pointer' }}
              >
                Try Again
              </button>
              <button
                onClick={() => window.location.reload()}
                style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' }}
              >
                Reload Flo
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}

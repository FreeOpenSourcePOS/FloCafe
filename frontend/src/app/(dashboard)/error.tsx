'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { reportRendererError } from '@/lib/report-renderer-error';

const AUTO_RETRY_DELAY_MS = 2000;

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const reportedDigest = useRef<string | undefined>(undefined);
  const hasAutoRetried = useRef(false);
  const [autoRetrying, setAutoRetrying] = useState(false);
  const [reportStatus, setReportStatus] = useState<'pending' | 'sent' | 'failed'>('pending');

  useEffect(() => {
    // Deduplicate error reporting across resets using error digest.
    const digest = error.digest ?? error.message;
    if (reportedDigest.current !== digest) {
      reportedDigest.current = digest;
      setReportStatus('pending');
      void reportRendererError(error).then((sent) => {
        // Avoid overwriting status if a newer error occurred while in flight.
        if (reportedDigest.current === digest) setReportStatus(sent ? 'sent' : 'failed');
      });
    }

    // Perform a single automatic retry on transient render exceptions before showing manual actions.
    if (!hasAutoRetried.current) {
      hasAutoRetried.current = true;
      setAutoRetrying(true);
      const timer = setTimeout(() => {
        setAutoRetrying(false);
        reset();
      }, AUTO_RETRY_DELAY_MS);
      return () => clearTimeout(timer);
    }
  }, [error, reset]);

  return (
    <div className="flex h-full min-h-[60vh] items-center justify-center p-4">
      <Card className="max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-destructive" />
            <CardTitle>Something went wrong</CardTitle>
          </div>
          <CardDescription>
            {autoRetrying
              ? 'This screen hit a snag — recovering automatically…'
              : 'This screen ran into a problem. Your data is safe — this only affects the current page.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!autoRetrying && (
            <>
              <div className="flex gap-2">
                <Button onClick={() => reset()}>Try Again</Button>
                <Button variant="outline" onClick={() => window.location.reload()}>Reload Flo</Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {reportStatus === 'pending' && 'Sending a diagnostic report to help us fix this…'}
                {reportStatus === 'sent' && 'A diagnostic report was sent automatically to help us fix this.'}
                {reportStatus === 'failed' && "Couldn't send a diagnostic report automatically — diagnostics may be off in Settings > Privacy, or there's no connection."}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

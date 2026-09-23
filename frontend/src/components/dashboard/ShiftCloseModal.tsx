'use client';
import { useState } from 'react';
import { Ltr } from '@/components/layout/Ltr';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, Lock, Printer, AlertTriangle } from 'lucide-react';
import type { CashSessionModel } from '@/hooks/useCashSession';

/** Shift-close ("Cerrar turno") modal. Pure view over useCashSession:
 *  count form with live expected + variance preview, then the immutable
 *  result with a print button. */
export function ShiftCloseModal({ model }: { model: CashSessionModel }) {
  const {
    closeModalOpen, setCloseModalOpen, session, countedInput, setCountedInput,
    submitting, submitError, closedResult, setClosedResult, printing,
    variancePreviewCents, minorFactor, fmt, t, tCommon, closeShift, printClosure,
    setSubmitError,
  } = model;
  // Tracks the first successful print so retries carry the REPRINT banner
  // (same pattern as day close: the backend derives the marker solely from
  // the client flag, and the closure row is never mutated server-side).
  const [hasPrinted, setHasPrinted] = useState(false);
  const closeModal = (next: boolean) => {
    if (!next && submitting) return;
    if (!next) {
      setClosedResult(null);
      setSubmitError(null);
      setCountedInput('');
      setHasPrinted(false);
    }
    setCloseModalOpen(next);
  };
  return (
    <Dialog open={closeModalOpen} onOpenChange={closeModal}>
      <DialogContent className="sm:max-w-md max-h-[90vh] flex flex-col" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock size={18} className="text-foreground" />
            {t('closeShiftSession')}
          </DialogTitle>
          <DialogDescription>{t('zReport')}</DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-4">
          {submitError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>{submitError}</span>
            </div>
          )}
          {!closedResult && session && (
            <>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t('expectedCash')}</span>
                <span className="font-semibold text-foreground"><Ltr>{fmt(session.expected_cash_cents / minorFactor)}</Ltr></span>
              </div>
              <div>
                <label htmlFor="shift-counted-cash" className="block text-sm text-muted-foreground mb-1">
                  {t('countedCash')}
                </label>
                <input
                  id="shift-counted-cash"
                  type="number"
                  min="0"
                  inputMode="decimal"
                  value={countedInput}
                  onChange={(e) => setCountedInput(e.target.value)}
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-foreground"
                  placeholder="0"
                />
              </div>
              {variancePreviewCents !== null && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t('variance')}</span>
                  <span className="font-semibold text-foreground"><Ltr>{fmt(variancePreviewCents / minorFactor)}</Ltr></span>
                </div>
              )}
            </>
          )}
          {closedResult && (
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('expectedCash')}</span>
                <span className="font-semibold text-foreground"><Ltr>{fmt(closedResult.expected_cash_cents / minorFactor)}</Ltr></span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('countedCash')}</span>
                <span className="font-semibold text-foreground"><Ltr>{fmt(closedResult.counted_cash_cents / minorFactor)}</Ltr></span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('variance')}</span>
                <span className="font-semibold text-foreground"><Ltr>{fmt(closedResult.variance_cents / minorFactor)}</Ltr></span>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          {closedResult ? (
            <>
              <Button variant="outline" onClick={() => closeModal(false)} disabled={printing}>
                {tCommon('close')}
              </Button>
              <Button
                onClick={async () => {
                  if (!closedResult) return;
                  const ok = await printClosure(closedResult.closure_id, hasPrinted);
                  if (ok) setHasPrinted(true);
                }}
                disabled={printing}
              >
                {printing ? <Loader2 size={16} className="animate-spin" /> : <Printer size={16} />}
                {t(hasPrinted ? 'reprintZ' : 'printZReport')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => closeModal(false)} disabled={submitting}>
                {tCommon('cancel')}
              </Button>
              <Button onClick={closeShift} disabled={submitting || !session}>
                {submitting && <Loader2 size={16} className="animate-spin" />}
                {t('closeShiftSession')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

'use client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, LockOpen, AlertTriangle } from 'lucide-react';
import type { CashSessionModel } from '@/hooks/useCashSession';

/** Shift-open ("Abrir caja") modal. Pure view over useCashSession. */
export function ShiftOpenModal({ model }: { model: CashSessionModel }) {
  const { openModalOpen, setOpenModalOpen, floatInput, setFloatInput, submitting, submitError, setSubmitError, t, tCommon, openShift } = model;
  // Centralized dismiss: blocks mid-submit closes and clears a stale amount
  // plus any submit error so a reopen always starts clean (mirrors ShiftCloseModal).
  const closeModal = (next: boolean) => {
    if (!next && submitting) return;
    if (!next) {
      setSubmitError(null);
      setFloatInput('');
    }
    setOpenModalOpen(next);
  };
  return (
    <Dialog open={openModalOpen} onOpenChange={closeModal}>
      <DialogContent className="sm:max-w-md max-h-[90vh] flex flex-col" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LockOpen size={18} className="text-foreground" />
            {t('openShift')}
          </DialogTitle>
          <DialogDescription>{t('openShiftHint')}</DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-4">
          {submitError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>{submitError}</span>
            </div>
          )}
          <div>
            <label htmlFor="shift-opening-float" className="block text-sm text-muted-foreground mb-1">
              {t('openingFloat')}
            </label>
            <input
              id="shift-opening-float"
              type="number"
              min="0"
              inputMode="decimal"
              value={floatInput}
              onChange={(e) => setFloatInput(e.target.value)}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-foreground"
              placeholder="0"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => closeModal(false)} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={openShift} disabled={submitting}>
            {submitting && <Loader2 size={16} className="animate-spin" />}
            {t('openShift')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

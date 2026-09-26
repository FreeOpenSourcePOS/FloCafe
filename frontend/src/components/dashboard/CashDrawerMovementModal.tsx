'use client';

import { useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Banknote, Loader2, Shield, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Ltr } from '@/components/layout/Ltr';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';
import type { CashDrawerMovementType, CashDrawerMovementsModel } from '@/hooks/useCashDrawerMovements';

export function CashDrawerMovementModal({ model }: { model: CashDrawerMovementsModel }) {
  const { currentTenant } = useAuthStore();
  const canVoid = tenantCan(currentTenant, 'cash.movements.void');
  const {
    open, setOpen, businessDate, setBusinessDate, loadMovements, movementType, setMovementType,
    amountInput, setAmountInput, reason, setReason, movements, loading, submitting, error,
    recordMovement, voidMovement, fmt, minorFactor, unitAdapter, t, tCommon, todayLocal,
  } = model;
  const [voidingId, setVoidingId] = useState<number | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const movementLabel = (type: CashDrawerMovementType) => {
    if (type === 'opening_float') return t('openingFloat');
    if (type === 'pay_in') return t('payIn');
    if (type === 'pay_out') return t('payOut');
    return t('safeDrop');
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) setOpen(next); }}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote size={18} />
            {t('cashMovement')}
          </DialogTitle>
          <DialogDescription>{t('cashMovementHint')}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4">
          <div>
            <label htmlFor="movement-business-date" className="block text-sm text-muted-foreground mb-1">
              {t('businessDateLabel')}
            </label>
            <input
              id="movement-business-date"
              type="date"
              value={businessDate}
              max={todayLocal}
              onChange={(event) => {
                const next = event.target.value;
                if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || next > todayLocal) return;
                setBusinessDate(next);
                void loadMovements(next);
              }}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground outline-none focus:ring-2 focus:ring-brand/30"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label htmlFor="movement-type" className="block text-sm text-muted-foreground mb-1">
                {t('movementType')}
              </label>
              <select
                id="movement-type"
                value={movementType}
                onChange={(event) => setMovementType(event.target.value as CashDrawerMovementType)}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground outline-none focus:ring-2 focus:ring-brand/30"
              >
                <option value="opening_float">{t('openingFloat')}</option>
                <option value="pay_in">{t('payIn')}</option>
                <option value="pay_out">{t('payOut')}</option>
                <option value="safe_drop">{t('safeDrop')}</option>
              </select>
            </div>
            <div>
              <label htmlFor="movement-amount" className="block text-sm text-muted-foreground mb-1">
                {t('movementAmount')}
              </label>
              <input
                id="movement-amount"
                type="number"
                inputMode="decimal"
                min={0}
                step={unitAdapter.step}
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground outline-none focus:ring-2 focus:ring-brand/30"
              />
            </div>
          </div>

          <div>
            <label htmlFor="movement-reason" className="block text-sm text-muted-foreground mb-1">
              {t('movementReason')} {movementType === 'opening_float' && <span>({tCommon('optional')})</span>}
            </label>
            <textarea
              id="movement-reason"
              value={reason}
              maxLength={500}
              rows={2}
              onChange={(event) => setReason(event.target.value)}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground outline-none focus:ring-2 focus:ring-brand/30 resize-y"
            />
          </div>

          {error && <p className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-300">{error}</p>}

          <section aria-labelledby="movement-history-heading">
            <h3 id="movement-history-heading" className="text-sm font-medium text-foreground mb-2">{t('movementHistory')}</h3>
            {loading ? (
              <div className="flex items-center justify-center py-6 text-muted-foreground"><Loader2 size={16} className="animate-spin" /></div>
            ) : movements.length === 0 ? (
              <p className="text-sm text-muted-foreground rounded-lg border border-border p-3">{t('noMovements')}</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {movements.map((movement) => (
                  <li key={movement.id} className={`p-3 space-y-2 ${movement.voided_at ? 'opacity-60' : ''}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground flex items-center gap-2">
                          {movement.movement_type === 'pay_in' ? <ArrowDownToLine size={14} /> : movement.movement_type === 'pay_out' || movement.movement_type === 'safe_drop' ? <ArrowUpFromLine size={14} /> : <Shield size={14} />}
                          {movementLabel(movement.movement_type)}
                          {movement.voided_at && <span className="text-xs text-red-700 dark:text-red-300">({t('voided')})</span>}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">{movement.reason || t('openingFloat')} · {movement.created_by_name}</p>
                      </div>
                      <Ltr><span className="text-sm font-semibold text-foreground whitespace-nowrap">{fmt(movement.amount_cents / minorFactor)}</span></Ltr>
                    </div>
                    {movement.voided_at ? (
                      <p className="text-xs text-muted-foreground">{movement.void_reason}</p>
                    ) : !canVoid ? null : voidingId === movement.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          autoFocus
                          value={voidReason}
                          maxLength={500}
                          onChange={(event) => setVoidReason(event.target.value)}
                          placeholder={t('voidReason')}
                          className="min-w-0 flex-1 px-2 py-1.5 text-sm border border-border rounded-lg bg-background text-foreground outline-none focus:ring-2 focus:ring-brand/30"
                        />
                        <Button type="button" size="sm" onClick={async () => { if (await voidMovement(movement.id, voidReason)) { setVoidingId(null); setVoidReason(''); } }}>
                          {t('voidMovement')}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => { setVoidingId(null); setVoidReason(''); }} aria-label={tCommon('cancel')}>
                          <X size={14} />
                        </Button>
                      </div>
                    ) : (
                      <button type="button" onClick={() => { setVoidingId(movement.id); setVoidReason(''); }} className="text-xs text-red-700 dark:text-red-300 hover:underline">
                        {t('voidMovement')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            <X size={14} />
            {tCommon('close')}
          </Button>
          <Button onClick={recordMovement} disabled={submitting || loading}>
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Banknote size={14} />}
            {t('recordMovement')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

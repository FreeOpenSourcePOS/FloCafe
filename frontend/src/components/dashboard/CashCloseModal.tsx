'use client';
import { Ltr } from '@/components/layout/Ltr';
import { CashCloseTicketPreview, type CashCloseTicketPreviewProps } from '@/components/dashboard/CashCloseTicketPreview';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Lock, Loader2, Printer, AlertTriangle, X, Check, ArrowLeft, ArrowRight } from 'lucide-react';
import type { CashCloseModel } from '@/hooks/useCashClose';

/** Day-close wizard modal (steps 1 Revisar / 2 Contar / 3 Cerrar).
 *  Pure view over useCashClose: every value and action arrives on
 *  `model`, so this file holds JSX only. */
export function CashCloseModal({ model }: { model: CashCloseModel }) {
  const { closeOpen, setCloseOpen, closeAnotherDay, businessDate, setBusinessDate, xReport, xLoading, xError, closeStep, setCloseStep, openingFloatInput, setOpeningFloatInput, countedInput, setCountedInput, submittingClose, submitError, alreadyClosedOverride, setAlreadyClosedOverride, amountsValid, expectedCashTotalCents, varianceCents, closedZ, printingZ, hasPrintedFresh, setHasPrintedFresh, hydratedZ, minorFactor, fmt, unitAdapter, t, tCommon, shiftDate, todayLocal, submitClose, printZ } = model;
  return (
    <>
{/* ── Close-day modal ─────────────────────────────────────────────── */}
<Dialog open={closeOpen} onOpenChange={(next) => {
  // Block mid-submit close so the operator can't drop a POST in flight.
  if (!next && submittingClose) return;
  setCloseOpen(next);
}}>
  <DialogContent
    className="sm:max-w-lg max-h-[90vh] flex flex-col"
    // The browser-native date picker popup renders outside the Radix
    // portal; without this, clicking a day closes the modal and the
    // date selection is swallowed. Spec requires past-date late closes.
    onInteractOutside={(e) => e.preventDefault()}
  >
    <DialogHeader>
      <DialogTitle className="flex items-center gap-2">
        <Lock size={18} className="text-foreground" />
        {t('closeShift')}
        {xReport && (
          <span className="ms-2 text-sm font-normal text-muted-foreground"><Ltr>{xReport.businessDate}</Ltr></span>
        )}
      </DialogTitle>
      <DialogDescription>
        {closeStep === 3 ? t('zReport') : t('xReport')}
      </DialogDescription>
    </DialogHeader>

    {/* 3-step stepper (Toast-style): 1 Revisar · 2 Contar · 3 Cerrar.
        On a hydrated close the auto-jump above puts us on step 3 and
        the stepper reflects that. Completed steps get the check; the
        active step gets the ring. Pure visual — clicks are routed by
        the Back/Continue footer, not the chips themselves. */}
    <ol className="flex items-center gap-2 px-1 pb-1 select-none" aria-label={t('closeFlowLabel')}>
      {([1, 2, 3] as const).map((step, i) => {
        const completed = closeStep > step;
        const active = closeStep === step;
        const label = step === 1 ? t('closeStepReview') : step === 2 ? t('closeStepCount') : t('closeStepDone');
        return (
          <li key={step} className="flex items-center gap-2 flex-1 last:flex-none">
            <span
              className={`flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-semibold border ${active ? 'bg-brand text-brand-foreground border-brand' : completed ? 'bg-brand/15 text-brand border-brand/30' : 'bg-muted text-muted-foreground border-border'}`}
              aria-current={active ? 'step' : undefined}
            >
              {completed ? <Check size={12} /> : step}
            </span>
            <span className={`text-xs ${active ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>{label}</span>
            {i < 2 && <span aria-hidden="true" className={`flex-1 h-px ${completed ? 'bg-brand/40' : 'bg-border'}`} />}
          </li>
        );
      })}
    </ol>

    <div className="flex-1 overflow-y-auto space-y-4">
      {/* ── Step 1: Revisar ── X summary only, no inputs except the date. */}
      {closeStep === 1 && (
        <div className="space-y-3">
          {xLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
              <Loader2 size={16} className="animate-spin" />
              {tCommon('loading')}
            </div>
          )}
          {xError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>{xError}</span>
            </div>
          )}
          <div>
            <label htmlFor="business-date" className="block text-sm text-muted-foreground mb-1">
              {t('businessDateLabel')}
            </label>
            <input
              id="business-date"
              type="date"
              value={businessDate}
              min={shiftDate(todayLocal, -365)}
              max={todayLocal}
              onChange={(e) => {
                const next = e.target.value;
                if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return;
                if (next > todayLocal) return;
                setBusinessDate(next);
              }}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground outline-none focus:ring-2 focus:ring-brand/30"
            />
          </div>
          {xReport && (
            <>
              {(xReport.alreadyClosed || alreadyClosedOverride) && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                  <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                  <span>{t('alreadyClosed')}</span>
                </div>
              )}
              {/* Two hero numbers, then a flat methods list. No inputs
                  here: counting is step 2. */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-border p-3 bg-muted/40">
                  <p className="text-xs text-muted-foreground">{t('xReportSales')}</p>
                  {/* grossCollected is already display MAJOR units
                      (backend divides by minorFactor at the response
                      boundary, same convention as paymentMethods[].total
                      below) — do NOT divide again here. */}
                  <p className="text-lg font-semibold text-foreground ltr-island"><Ltr>{fmt(xReport.grossCollected)}</Ltr></p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {t('billsCount', { count: xReport.billCount })}
                  </p>
                </div>
                <div className="rounded-lg border border-border p-3 bg-muted/40">
                  <p className="text-xs text-muted-foreground">{t('expectedCashSalesOnly')}</p>
                  <p className="text-lg font-semibold text-foreground ltr-island"><Ltr>{fmt(xReport.expectedCashCents / minorFactor)}</Ltr></p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {t('refundsCount', { count: xReport.refundCount })}
                    {/* refunded is display MAJOR units like grossCollected above. */}
                    {' · '}<Ltr>{fmt(xReport.refunded)}</Ltr>
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">{t('ticketSectionPayments')}</p>
                {xReport.paymentMethods.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('ticketNoPayments')}</p>
                ) : (
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {xReport.paymentMethods.map((pm) => (
                      <li key={pm.method} className="flex items-center justify-between px-3 py-2 text-sm">
                        <span className="text-foreground">{pm.method}</span>
                        <span className="text-muted-foreground">
                          {/* paymentMethods[].total is display MAJOR units — do NOT divide. */}
                          <Ltr>{fmt(pm.total)}</Ltr>
                          <span className="ms-2 text-[11px]">x{pm.count}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      )}


      {/* ── Step 2: Contar ── float + counted, expected/variance as
          hero numbers. Submit happens here. The date input is shown
          read-only so the operator always sees which day they are
          closing; changing it goes back to step 1. */}
      {closeStep === 2 && xReport && (
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2">
            <span className="text-xs text-muted-foreground">{t('businessDateLabel')}</span>
            <span className="text-sm font-medium text-foreground ltr-island"><Ltr>{xReport.businessDate}</Ltr></span>
          </div>
          <div>
            <label htmlFor="opening-float" className="block text-sm text-muted-foreground mb-1">
              {t('openingFloat')}
            </label>
            <input
              id="opening-float"
              type="number"
              inputMode="decimal"
              min={0}
              step={unitAdapter.step}
              value={openingFloatInput}
              onChange={(e) => setOpeningFloatInput(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground outline-none focus:ring-2 focus:ring-brand/30"
            />
            {xReport.priorBusinessDate === null && (
              <p className="text-xs text-amber-700 mt-1">{t('noPriorCloseHint')}</p>
            )}
          </div>
          <div>
            <label htmlFor="counted-cash" className="block text-sm text-muted-foreground mb-1">
              {t('countedCash')}
            </label>
            <input
              id="counted-cash"
              type="number"
              inputMode="decimal"
              min={0}
              step={unitAdapter.step}
              value={countedInput}
              onChange={(e) => setCountedInput(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground outline-none focus:ring-2 focus:ring-brand/30"
            />
          </div>
          {/* Two hero numbers dominate step 2: expected (left) and
              variance (right). Same color logic as the existing
              variance box. */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-border p-3 bg-muted/40">
              <p className="text-xs text-muted-foreground">{t('expectedCash')}</p>
              <p className="text-xl font-bold text-foreground ltr-island"><Ltr>{amountsValid ? fmt(expectedCashTotalCents / minorFactor) : '—'}</Ltr></p>
            </div>
            <div className={`rounded-lg border p-3 ${varianceCents === 0 ? 'border-border bg-muted/40' : varianceCents < 0 ? 'border-red-300 bg-red-50' : 'border-amber-300 bg-amber-50'}`}>
              <p className="text-xs text-muted-foreground">{t('variance')}</p>
              <p className={`text-xl font-bold ltr-island ${varianceCents === 0 ? 'text-foreground' : varianceCents < 0 ? 'text-red-700' : 'text-amber-700'}`}>
                {/* Invalid/empty input renders no figure: the ?? 0 fallback
                    below would show a plausible-but-wrong variance while
                    Close stays disabled. */}
                <Ltr>{amountsValid ? fmt(varianceCents / minorFactor) : '—'}</Ltr>
              </p>
            </div>
          </div>
          {submitError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>{submitError}</span>
            </div>
          )}
        </div>
      )}

      {/* ── Step 3: Cerrar ── closed Z summary + designed ticket.
          Same component, but no longer shoved inside the same scroll
          view as the form. */}
      {closeStep === 3 && closedZ && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={closeAnotherDay}
              className="text-xs font-medium text-brand hover:underline focus:outline-none focus:ring-2 focus:ring-brand/30 rounded px-1 py-0.5"
              disabled={submittingClose || printingZ}
            >
              {t('closeAnotherDay')}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">{t('openingFloat')}</p>
              <p className="text-base font-semibold text-foreground"><Ltr>{fmt(closedZ.opening_float_cents / minorFactor)}</Ltr></p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">{t('expectedCash')}</p>
              <p className="text-base font-semibold text-foreground"><Ltr>{fmt(closedZ.expected_cash_cents / minorFactor)}</Ltr></p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">{t('countedCash')}</p>
              <p className="text-base font-semibold text-foreground"><Ltr>{fmt(closedZ.counted_cash_cents / minorFactor)}</Ltr></p>
            </div>
            <div className={`rounded-lg border p-3 ${closedZ.variance_cents === 0 ? 'border-border' : closedZ.variance_cents < 0 ? 'border-red-300 bg-red-50' : 'border-amber-300 bg-amber-50'}`}>
              <p className="text-xs text-muted-foreground">{t('variance')}</p>
              <p className={`text-base font-semibold ltr-island ${closedZ.variance_cents === 0 ? 'text-foreground' : closedZ.variance_cents < 0 ? 'text-red-700' : 'text-amber-700'}`}>
                <Ltr>{fmt(closedZ.variance_cents / minorFactor)}</Ltr>
              </p>
            </div>
          </div>
          <div className="rounded-lg border border-border p-3 bg-muted/40">
            <p className="text-sm font-medium text-foreground">{t('billsCount', { count: closedZ.bill_count })}</p>
          </div>
          {closedZ.notes && (
            <div className="rounded-lg border border-border p-3 bg-muted/40">
              <p className="text-xs text-muted-foreground">{t('closureNotes')}</p>
              <p className="text-sm text-foreground whitespace-pre-wrap">{closedZ.notes}</p>
            </div>
          )}
          <CashCloseTicketPreview
            z={{
              ...closedZ,
              tax_components: closedZ.tax_components as CashCloseTicketPreviewProps['z']['tax_components'],
            }}
            minorFactor={minorFactor}
            formatter={fmt}
            labels={{
              payments: t('ticketSectionPayments'),
              refunds: t('ticketSectionRefunds'),
              tax: t('ticketSectionTax'),
              staff: t('ticketSectionStaff'),
              operator: t('ticketSectionOperator'),
              notes: t('ticketSectionNotes'),
              openingFloat: t('openingFloat'),
              expectedCash: t('expectedCash'),
              countedCash: t('countedCash'),
              variance: t('variance'),
              methodCount: (n: number) => t('ticketMethodCount', { count: n }),
              refundCount: (n: number) => t('ticketRefundCount', { count: n }),
              noRefunds: t('ticketNoRefunds'),
              noTax: t('ticketNoTax'),
              noStaff: t('ticketNoStaff'),
              billCount: (n: number) => t('billsCount', { count: n }),
              closedAt: (d: string) => t('ticketClosedAt', { date: d }),
              footer: t('ticketFooter'),
            }}
          />
          <p className="text-[11px] text-muted-foreground -mt-1 text-center">
            {t('reprintAddsMarker')}
          </p>
        </div>
      )}
    </div>

    <DialogFooter>
      {closeStep === 3 ? (
        <>
          <Button variant="outline" onClick={() => setCloseOpen(false)}>
            {tCommon('close')}
          </Button>
          {(hasPrintedFresh || hydratedZ) ? (
            <Button onClick={() => { if (closedZ) printZ(closedZ, true); }} disabled={printingZ || !closedZ}>
              {printingZ ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
              {t('reprintZ')}
            </Button>
          ) : (
            <Button onClick={async () => {
              if (!closedZ) return;
              const ok = await printZ(closedZ, false);
              if (ok) setHasPrintedFresh(true);
            }} disabled={printingZ || !closedZ}>
              {printingZ ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
              {t('printZReport')}
            </Button>
          )}
        </>
      ) : (
        <>
          <Button variant="outline" onClick={() => setCloseOpen(false)} disabled={submittingClose}>
            <X size={14} />
            {tCommon('cancel')}
          </Button>
          <div className="flex items-center gap-2 ms-auto">
            {closeStep > 1 && (
              <Button variant="ghost" onClick={() => {
                setAlreadyClosedOverride(false);
                setCloseStep((s) => (s > 1 ? ((s - 1) as 1 | 2) : s));
              }} disabled={submittingClose}>
                <ArrowLeft size={14} className="rtl-flip" />
                {tCommon('back')}
              </Button>
            )}
            {closeStep === 1 && (
              <Button
                onClick={() => {
                  if (!xReport || xReport.alreadyClosed || alreadyClosedOverride) return;
                  setCloseStep(2);
                }}
                disabled={xLoading || xError !== null || !xReport || xReport.alreadyClosed || alreadyClosedOverride}
              >
                {tCommon('continue')}
                <ArrowRight size={14} className="rtl-flip" />
              </Button>
            )}
            {closeStep === 2 && (
              <Button
                onClick={submitClose}
                disabled={submittingClose || !xReport || !amountsValid || xReport.alreadyClosed || alreadyClosedOverride}
              >
                {submittingClose ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
                {t('closeShift')}
              </Button>
            )}
          </div>
        </>
      )}
    </DialogFooter>
  </DialogContent>
</Dialog>
    </>
  );
}

'use client';
import { useState, useEffect } from 'react';
import axios from 'axios';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import { getCurrencyMinorUnitFactor } from '@/lib/countries';
import { printerService } from '@/lib/printer/PrinterService';
/** Live day aggregates returned by GET /api/reports/x-report. Display totals
 *  are in tenant major units (minorFactor-divided); expectedCashCents is the
 *  integer-cents drawer expected figure. Do not rename fields — the backend
 *  contract is fixed by main/routes/reports.ts. */
interface XReport {
  businessDate: string;
  periodStart: string;
  periodEnd: string;
  grossCollected: number;
  refunded: number;
  netCollected: number;
  billCount: number;
  refundCount: number;
  paymentMethods: { method: string | null; count: number; total: number }[];
  staffSales: { user_id: string; name: string; role: string; revenue: number; orderCount: number }[];
  taxComponents: unknown[];
  /** Drawer expected figure in INTEGER cents (no opening float — the float
   *  is captured at close). Cash-only raw filter, refunds by created_at. */
  expectedCashCents: number;
  /** F3: server-resolved prior close (most recent scope='day' row with
   *  business_date < this.businessDate). Both fields are null when no
   *  prior close exists. The frontend ONLY shows the "no prior close"
   *  hint when priorBusinessDate === null AND the X fetch succeeded —
   *  never on a transport error, so a network blip cannot be confused
   *  with a clean store history. */
  priorClosedCashCents: number | null;
  priorBusinessDate: string | null;
  alreadyClosed: boolean;
}

/** Immutable close-of-day snapshot returned by POST /api/cash-closures and
 *  GET /api/reports/z-report. Money fields are integer cents. */
interface ZReport {
  id: number;
  scope: string;
  business_date: string;
  period_start: string;
  period_end: string;
  opening_float_cents: number;
  expected_cash_cents: number;
  counted_cash_cents: number;
  variance_cents: number;
  gross_collected_cents: number;
  refunded_cents: number;
  net_collected_cents: number;
  bill_count: number;
  refund_count: number;
  payment_methods: { method: string; count: number; total_cents: number }[];
  staff_sales: { user_id: string; name: string; role: string; revenue_cents: number; orderCount: number }[];
  tax_components: unknown[];
  z_number: number;
  closed_by: string;
  closed_by_name: string;
  notes: string | null;
  created_at: string;
}

/** Day-close (cierre de caja) controller: owns the close-day modal's
 *  state machine (steps 1-2-3), X/Z fetching, submit, and print.
 *  Extracted from the dashboard page so the page stays a tile layout;
 *  the modal UI lives in CashCloseModal. */
export function useCashClose() {
  const { currentTenant } = useAuthStore();
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const timeZone = currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dayStartTime = currentTenant?.business_day_start_time || '00:00';
  const startMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(dayStartTime.trim());
  const startOffsetMs = startMatch ? (Number(startMatch[1]) * 60 + Number(startMatch[2])) * 60 * 1000 : 0;
  const nowInstant = new Date();
  const adjustedInstant = startOffsetMs > 0 ? new Date(nowInstant.getTime() - startOffsetMs) : nowInstant;
  const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(adjustedInstant);
  // ── Close-day modal state ────────────────────────────────────────────────
  // Modal flow: open → load X (live aggregates) + prior-day Z (default float)
  // → operator edits float + counted → POST /cash-closures → immutable Z view
  // → optional print. Currency math stays in INTEGER cents end-to-end (the
  // backend stores cents and returns display totals; we convert to cents at
  // the POST boundary via the unit adapter, and back to display for the
  // preview).
  const [closeOpen, setCloseOpen] = useState(false);
  // Bumping this token is how we re-trigger the load effect on each open.
  // Reset of the form fields happens during render via the token comparison
  // below (React-recommended idiom for "adjusting state when a prop
  // changes" — mirrors the `syncKey`/`setSyncedKey` pattern in the dashboard page).
  const [openToken, setOpenToken] = useState(0);
  const [businessDate, setBusinessDate] = useState(todayLocal);
  // Entry override: `null` means "fresh open, default to todayLocal";
  // the empty string means "another-day open, leave the date blank so
  // the operator must pick one". The render-time reset block reads this
  // and clears it, so the only place that sets it is `closeAnotherDay`.
  const [dateOverride, setDateOverride] = useState<string | null>(null);
  const [xReport, setXReport] = useState<XReport | null>(null);
  const [xLoading, setXLoading] = useState(false);
  const [xError, setXError] = useState<string | null>(null);
  // 3-step wizard (Revisar / Contar / Cerrar). On a fresh close, the
  // operator moves 1 -> 2 -> 3; on a hydrated close (modal opened on an
  // already-closed day) the effect below jumps straight to 3 once the
  // x-report says `alreadyClosed: true`.
  const [closeStep, setCloseStep] = useState<1 | 2 | 3>(1);
  // F3: derive a token from `openToken + businessDate`. The render-time
  // `if (closeOpen && xToken !== refXToken)` block wipes stale X-report
  // state when the token changes (modal open OR operator picks a different
  // date). Derives from existing state instead of carrying a separate
  // counter so the wipe is automatic — same pattern as the `syncKey`
  // block above (recommended by React for "adjusting state when a prop
  // changes" and avoids the cascading-renders ESLint rule).
  const xToken = `${openToken}:${businessDate}`;
  const [refXToken, setRefXToken] = useState(xToken);
  const [openingFloatInput, setOpeningFloatInput] = useState('');
  const [countedInput, setCountedInput] = useState('');
  const [submittingClose, setSubmittingClose] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // F4: local override of `xReport.alreadyClosed` for the case where the
  // operator's POST hits a 409 (the X report still says alreadyClosed:false
  // until it re-fetches, so the Submit button would stay enabled and the
  // pre-existing 409 path would loop). Mirrors the X-report flag locally.
  const [alreadyClosedOverride, setAlreadyClosedOverride] = useState(false);
  const [closedZ, setClosedZ] = useState<ZReport | null>(null);
  const [printingZ, setPrintingZ] = useState(false);
  const [hasPrintedFresh, setHasPrintedFresh] = useState(false);
  const [hydratedZ, setHydratedZ] = useState(false);
  const unitAdapter = useCurrencyUnitAdapter();
  // Storage minor-unit factor (`Math.pow(10, fractionDigits)`) is the cents
  // denominator; the adapter's `maxDecimals` would be wrong for IRR/Toman
  // (where display has 3 decimals but storage is still Rial-cents, factor 100).
  const minorFactor = getCurrencyMinorUnitFactor(currentTenant?.currency || 'INR');

  // Prior business date = day before the modal's date. ISO date arithmetic on
  // the YYYY-MM-DD string is timezone-safe — no need for `localDateInTimezone`
  // in the renderer.
  const shiftDate = (yyyymmdd: string, deltaDays: number): string => {
    const d = new Date(`${yyyymmdd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    return d.toISOString().slice(0, 10);
  };

  useEffect(() => {
    if (!closeOpen) return;
    // Empty date = "operator hasn't chosen a day yet" (e.g. arrived via
    // closeAnotherDay). Skip the fetch entirely: no request, no error,
    // no auto-jump via closed-Z hydration. Step 1 stays on screen until
    // the operator picks a date. Form state already starts null/empty
    // so no state reset is needed here. Clear xLoading here too: the
    // reset block above sets it true on each open, and an empty-date
    // early-return without this would leave the modal stuck on
    // "Cargando..." with a disabled Continue (correctly disabled, but
    // for the wrong reason). Empty date is a valid idle state, not an
    // error, so xReport/xError stay null.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors the reset-block pattern immediately below this effect.
    if (!businessDate) { setXLoading(false); return; }
    const controller = new AbortController();
    const isActive = () => !controller.signal.aborted;
    // Use the operator-selected date so past-day closes work.
    api.get('/reports/x-report', { params: { date: businessDate }, signal: controller.signal })
      .then((res) => {
        if (!isActive()) return;
        setXReport(res.data.xReport);
        const xr = res.data.xReport;
        // F3: prior close is now part of the X envelope. Prefill the
        // opening-float input ONLY on a clean X fetch (xError stays null
        // here) and ONLY when the backend reports a prior close. The
        // GET /reports/x-report route returns null fields when no prior
        // close exists; we use that as the explicit "no prior close"
        // signal — transport errors set xError, leaving priorBusinessDate
        // null WITHOUT triggering the noPriorCloseHint (F7 discipline).
        if (!xError && xr) {
          if (xr.priorClosedCashCents !== null && xr.priorBusinessDate) {
            // F2: convert to display units via the adapter (Toman/Rial etc.)
            setOpeningFloatInput(unitAdapter.toDisplay(xr.priorClosedCashCents / minorFactor).toString());
            setAlreadyClosedOverride(false);
          } else {
            // F1: no prior close for this date — reset the prefill so a
            // POST cannot submit a stale value from a previously-closed
            // day, and clear any stale alreadyClosed override (a 409 on
            // day A must not leave a false closed banner + disabled
            // submit on unclosed day B).
            setOpeningFloatInput('');
            setAlreadyClosedOverride(false);
          }
        }
        // F4: if the day is already closed, hydrate the closed-Z view so
        // the operator can read/reprint the snapshot without POSTing a
        // second close.
        if (xr?.alreadyClosed) {
          return api.get('/reports/z-report', { params: { date: businessDate }, signal: controller.signal })
            .then((zRes) => {
              if (!isActive()) return;
              if (zRes.data?.zReport) {
                setClosedZ(zRes.data.zReport);
                setHasPrintedFresh(false);
                setHydratedZ(true);
              }
            })
            .catch((err: unknown) => {
              if (axios.isCancel(err) || (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))) return;
              if (!isActive()) return;
              // 404 means the X said closed but Z is missing — fall back
              // to the banner. Any other error is logged and toasted because
              // the X envelope alone already gave us the alreadyClosed banner
              // content but the operator should know the printed Z could
              // not be hydrated (reprint/snapshot-read).
              if (axios.isAxiosError(err) && err.response?.status === 404) return;
              const msg = axios.isAxiosError(err) ? err.response?.data?.error || err.message : (err instanceof Error ? err.message : 'Failed to load closed Z');
              console.warn('[cierre] hydrate z-report failed:', msg);
              toast.error(tCommon('somethingWrong'));
            });
        }
        return undefined;
      })
      .catch((err: unknown) => {
        if (axios.isCancel(err) || (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))) return;
        if (!isActive()) return;
        setXError(axios.isAxiosError(err) ? err.response?.data?.error || err.message : (err instanceof Error ? err.message : 'Failed to load day'));
      })
      .finally(() => {
        if (isActive()) setXLoading(false);
      });
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeOpen, openToken, businessDate]);

  // Reset modal state at the start of each new open (React-recommended
  // pattern for "adjusting state when a prop changes" — the equivalent of
  // a class component's `getDerivedStateFromProps`; mirrors the existing
  // `syncKey` / `setSyncedKey` pattern in this file).
  const [resetToken, setResetToken] = useState(0);
  if (closeOpen && resetToken !== openToken) {
    setResetToken(openToken);
    setXLoading(true);
    setXError(null);
    setXReport(null);
    // (priorFloatCents removed: the backend's xReport.priorBusinessDate is
    // the unambiguous source of truth for the no-prior-close hint.)
    setAlreadyClosedOverride(false);
    setBusinessDate(dateOverride ?? todayLocal);
    setDateOverride(null);
    setOpeningFloatInput('');
    setCountedInput('');
    setSubmitError(null);
    setClosedZ(null);
    setHasPrintedFresh(false);
    setHydratedZ(false);
    setCloseStep(1);
  }
  // F3: render-time wipe of stale X state when the operator changes the
  // business date inside the modal. Token derives from openToken +
  // businessDate so it changes on either event. Same pattern as the
  // `syncKey` block above (recommended by React for "adjusting state when
  // a prop changes" and avoids the cascading-renders ESLint rule).
  // F1/F2: also reset counted/submit-error/closed-Z/printed-fresh so a
  // value typed for day A cannot carry into day B's immutable close (F1)
  // and so changing dates after closing day A leaves no stale Z in view (F2).
  if (closeOpen && xToken !== refXToken) {
    setRefXToken(xToken);
    setXLoading(true);
    setXError(null);
    setXReport(null);
    setCountedInput('');
    setSubmitError(null);
    setClosedZ(null);
    setHasPrintedFresh(false);
    setHydratedZ(false);
    // Date is part of xToken, so a change here jumps the wizard back to
    // step 1. (Re-)entered with a fresh day that might already be closed.
    setCloseStep(1);
  }
  // Auto-jump to step 3 when the X report hydrates and says the day is
  // already closed: nothing to count, just show the stored Z. Skip while
  // xLoading is true so we don't briefly replace the spinner with a flash
  // of step 3. Fire only after the closed-Z hydrate finishes — otherwise the
  // operator lands on a blank step 3 with no Back path. Recomputes on every
  // render of the open modal — the cost is two field reads and a conditional.
  if (closeOpen && xReport?.alreadyClosed && !xLoading && closedZ !== null && closeStep !== 3) {
    setCloseStep(3);
  }

  const openCloseModal = () => {
    setOpenToken((n) => n + 1);
    setCloseOpen(true);
  };
  // Close-another-day entry point from the stored-Z view. The reset block
  // above (driven by `openToken !== resetToken`) already wipes closedZ,
  // hasPrintedFresh, countedInput, submitError and forces closeStep back to
  // 1, so bumping openToken here is the existing reset idiom: same behavior
  // path as the header button, just arriving with a higher token. The date
  // resets to todayLocal, matching the open-from-header behavior — the
  // operator then uses the existing step-1 date picker to navigate back.
  const closeAnotherDay = () => {
    setDateOverride('');
    setOpenToken((n) => n + 1);
  };

  // Convert a display-amount input string to integer cents. The adapter's
  // `toStored` returns the value in MAJOR units (Rial for IRR/Toman — the
  // adapter folds the Toman-to-Rial ratio itself), so multiplying by the
  // storage minor factor gives integer cents. Empty/invalid/negative →
  // null: the operator can type `-5` and the input would render `-5`
  // while submit sent 0, leaving a misleading variance preview and a
  // 400 on a row that is about to become immutable. The X already
  // exposes `expectedCashCents` in cents and the submit gate now reads
  // `amountsValid`, so we can return null and let the caller decide.
  const displayToCents = (raw: string): number | null => {
    if (raw.trim() === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(unitAdapter.toStored(n) * minorFactor);
  };

  const openingFloatCentsOrNull = displayToCents(openingFloatInput);
  const countedCashCentsOrNull = displayToCents(countedInput);
  const openingFloatCents = openingFloatCentsOrNull ?? 0;
  const countedCashCents = countedCashCentsOrNull ?? 0;
  const amountsValid = openingFloatCentsOrNull !== null && countedCashCentsOrNull !== null;
  const expectedCashTotalCents = xReport ? xReport.expectedCashCents + openingFloatCents : 0;
  const varianceCents = countedCashCents - expectedCashTotalCents;

  const submitClose = async () => {
    if (!xReport) return;
    setSubmittingClose(true);
    setSubmitError(null);
    try {
      const res = await api.post('/cash-closures', {
        business_date: businessDate,
        opening_float_cents: openingFloatCents,
        counted_cash_cents: countedCashCents,
      });
      setClosedZ(res.data.zReport);
      setHydratedZ(false);
      setCloseStep(3);
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        // The backend's 409 carries alreadyClosed; surface the message and
        // keep the form so the operator can retry once they have the prior Z.
        setSubmitError(t('alreadyClosed'));
        // F4: the X report still says alreadyClosed:false until it re-fetches.
        // Set the local override so the Submit button disables immediately and
        // the alreadyClosed banner shows without waiting for a re-fetch.
        setAlreadyClosedOverride(true);
      } else {
        const msg = axios.isAxiosError(err)
          ? err.response?.data?.error || err.message
          : (err instanceof Error ? err.message : 'Close failed');
        setSubmitError(msg);
      }
    } finally {
      setSubmittingClose(false);
    }
  };

  // POST /cash-closures/:id/print. Mirrors main/routes/cash-closures.ts:471-505:
  // network/usb printers print server-side and return { success, isReprint };
  // webusb printers return { success, webusb: true, isReprint, bytes } and the
  // renderer dispatches the bytes through printerService.print().
  // F5: returns true on the first successful print so the caller can flip
  // the hasPrintedFresh flag. The button must NOT flip on failure — a
  // failed first print should still offer "Print Z" (not "Reprint"), so the
  // operator can see it never actually printed.
  const printZ = async (z: ZReport, isReprint = false): Promise<boolean> => {
    setPrintingZ(true);
    try {
      const res = await api.post(`/cash-closures/${z.id}/print`, { isReprint });
      if (res.data?.webusb && Array.isArray(res.data.bytes)) {
        await printerService.print(Uint8Array.from(res.data.bytes));
        toast.success(t(isReprint ? 'reprintZ' : 'printZReport'));
        return true;
      } else if (res.data?.success) {
        toast.success(t(isReprint ? 'reprintZ' : 'printZReport'));
        return true;
      } else {
        toast.error(tCommon('somethingWrong'));
        return false;
      }
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? err.response?.data?.error || err.response?.data?.detail || err.message
        : (err instanceof Error ? err.message : 'Print failed');
      toast.error(msg);
      return false;
    } finally {
      setPrintingZ(false);
    }
  };
  return {
    closeOpen, setCloseOpen, openCloseModal, closeAnotherDay, businessDate, setBusinessDate,
    xReport, xLoading, xError, closeStep, setCloseStep,
    openingFloatInput, setOpeningFloatInput, countedInput, setCountedInput,
    submittingClose, submitError, alreadyClosedOverride, setAlreadyClosedOverride,
    amountsValid, expectedCashTotalCents, varianceCents, closedZ, printingZ,
    hasPrintedFresh, setHasPrintedFresh, hydratedZ, minorFactor, fmt, unitAdapter, t, tCommon,
    shiftDate, todayLocal, submitClose, printZ,
  };
}

export type CashCloseModel = ReturnType<typeof useCashClose>;

'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import api from '@/lib/api';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import { getCurrencyMinorUnitFactor } from '@/lib/countries';
import { useAuthStore } from '@/store/auth';
import { printerService } from '@/lib/printer/PrinterService';
import { displayAmountToCents } from '@/lib/money';

/** Open cash session row plus the live expected figure, from
 *  GET /api/cash-sessions/current. Money fields are integer cents. */
export interface CashSession {
  id: number;
  opened_by: string;
  opened_by_name: string;
  opened_at: string;
  opening_float_cents: number;
  status: string;
  expected_cash_cents: number;
}

export interface ShiftCloseResult {
  closure_id: number;
  variance_cents: number;
  expected_cash_cents: number;
  counted_cash_cents: number;
}

/** Result of a shift refresh. Superseded calls carry no session and must not
 *  trigger routing because a newer refresh owns the current UI state. */
export type CashSessionRefreshResult =
  | { status: 'ok'; session: CashSession | null; error: string | null }
  | { status: 'superseded' };

/** Shift (cash session) controller for the POS terminal: owns the
 *  open/close modal state, current-session fetch, submit, and print.
 *  Mirrors useCashClose but without the date picker, prior-close prefill,
 *  or already-closed hydration — sessions have exactly one open row. */
export function useCashSession() {
  const { currentTenant } = useAuthStore();
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const unitAdapter = useCurrencyUnitAdapter();
  const minorFactor = getCurrencyMinorUnitFactor(currentTenant?.currency || '');

  const [session, setSession] = useState<CashSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openModalOpen, setOpenModalOpen] = useState(false);
  const [closeModalOpen, setCloseModalOpen] = useState(false);
  const [floatInput, setFloatInput] = useState('');
  const [countedInput, setCountedInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [closedResult, setClosedResult] = useState<ShiftCloseResult | null>(null);
  const [printing, setPrinting] = useState(false);

  // Pure fetcher shared by the mount effect and refresh(): performs the
  // request, returns data-or-null, never touches state itself. (The mount
  // effect calls it directly rather than refresh() because the
  // cascading-renders lint rule forbids effects from calling
  // setter-containing functions, even behind awaits.)
  /** Fetches the current shift without mutating hook state. */
  const fetchState = async (): Promise<{ data: CashSession | null; error: string | null }> => {
    try {
      const res = await api.get('/cash-sessions/current');
      return { data: res.data as CashSession, error: null };
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return { data: null, error: null };
      }
      return {
        data: null,
        error: axios.isAxiosError(err) ? err.response?.data?.error || err.message : 'Failed to load shift',
      };
    }
  };

  // Sequence guard and explicit superseded result: a stale response must not
  // write state or route shift entry when a newer request owns the UI.
  const refreshSeq = useRef(0);
  /** Refreshes the current shift and commits state only for the latest request. */
  const refresh = useCallback(async (): Promise<CashSessionRefreshResult> => {
    const seq = ++refreshSeq.current;
    setLoading(true);
    setError(null);
    const { data, error: loadError } = await fetchState();
    if (seq !== refreshSeq.current) return { status: 'superseded' };
    setSession(data);
    setError(loadError);
    setLoading(false);
    return { status: 'ok', session: data, error: loadError };
  }, []);

  // Mount fetch: loading starts true, so state settles only in async
  // continuations (lint-clean by construction). It participates in the same
  // generation sequence as refresh so late mount data cannot win.
  useEffect(() => {
    let cancelled = false;
    const seq = ++refreshSeq.current;
    fetchState().then(({ data, error: loadError }) => {
      if (cancelled || seq !== refreshSeq.current) return;
      setSession(data);
      setError(loadError);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Shared display→cents semantics with day close (lib/money.ts).
  const displayToCents = (raw: string): number | null =>
    displayAmountToCents(raw, unitAdapter, minorFactor);

  /** Opens a shift with the entered float and refreshes the current state. */
  const openShift = async () => {
    const floatCents = displayToCents(floatInput);
    if (floatCents === null) {
      setSubmitError(t('movementAmountRequired'));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.post('/cash-sessions/open', { opening_float_cents: floatCents });
      setFloatInput('');
      setOpenModalOpen(false);
      toast.success(t('shiftOpened'));
      await refresh();
    } catch (err: unknown) {
      setSubmitError(axios.isAxiosError(err) ? err.response?.data?.error || err.message : 'Open failed');
    } finally {
      setSubmitting(false);
    }
  };

  /** Closes the open shift with the entered count, refreshes state, and
   *  retains the closure result for Z printing. */
  const closeShift = async () => {
    if (!session) return;
    const countedCents = displayToCents(countedInput);
    if (countedCents === null) {
      setSubmitError(t('movementAmountRequired'));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.post(`/cash-sessions/${session.id}/close`, { counted_cash_cents: countedCents });
      setClosedResult(res.data);
      setCountedInput('');
      toast.success(t('shiftClosed'));
      await refresh();
    } catch (err: unknown) {
      setSubmitError(axios.isAxiosError(err) ? err.response?.data?.error || err.message : 'Close failed');
    } finally {
      setSubmitting(false);
    }
  };

  // Session closures persist as cash_closures rows, so the Z print path is
  // the existing POST /cash-closures/:id/print (same webusb/server split
  // as useCashClose.printZ).
  /** Prints or reprints the session Z and reports whether dispatch succeeded. */
  const printClosure = async (closureId: number, isReprint = false): Promise<boolean> => {
    setPrinting(true);
    try {
      const res = await api.post(`/cash-closures/${closureId}/print`, { isReprint });
      if (res.data?.webusb && Array.isArray(res.data.bytes)) {
        await printerService.print(Uint8Array.from(res.data.bytes));
        toast.success(t(isReprint ? 'reprintZ' : 'printZReport'));
        return true;
      } else if (res.data?.success) {
        toast.success(t(isReprint ? 'reprintZ' : 'printZReport'));
        return true;
      }
      toast.error(tCommon('somethingWrong'));
      return false;
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? err.response?.data?.error || err.response?.data?.detail || err.message
        : (err instanceof Error ? err.message : 'Print failed');
      toast.error(msg);
      return false;
    } finally {
      setPrinting(false);
    }
  };

  const countedCentsOrNull = displayToCents(countedInput);
  const shiftLoadFailedMessage = t('shiftLoadFailed');
  const variancePreviewCents = session && countedCentsOrNull !== null
    ? countedCentsOrNull - session.expected_cash_cents
    : null;

  return {
    session, loading, error, refresh,
    openModalOpen, setOpenModalOpen, closeModalOpen, setCloseModalOpen,
    floatInput, setFloatInput, countedInput, setCountedInput,
    submitting, submitError, setSubmitError, closedResult, setClosedResult,
    printing, variancePreviewCents, minorFactor, fmt, unitAdapter,
    t, tCommon, openShift, closeShift, printClosure, shiftLoadFailedMessage,
  };
}

export type CashSessionModel = ReturnType<typeof useCashSession>;

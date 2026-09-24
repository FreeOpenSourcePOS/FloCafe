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

  // Latest settled payload: a superseded refresh returns what the UI shows
  // instead of its own discarded payload, so entry routing never acts on
  // data that never made it into `session`.
  const latestData = useRef<CashSession | null>(null);
  // Sequence guard: a slow response settling after a newer refresh (or
  // after unmount-via-stale-callers) must not overwrite fresh state.
  const refreshSeq = useRef(0);
  // Returns the session plus the fresh load error: entry routing must not
  // offer the open form when the load itself failed (unknown state ≠ no
  // shift), and callers can surface the specific load error.
  const refresh = useCallback(async (): Promise<{ session: CashSession | null; error: string | null }> => {
    const seq = ++refreshSeq.current;
    setLoading(true);
    setError(null);
    const { data, error: loadError } = await fetchState();
    latestData.current = data;
    if (seq !== refreshSeq.current) return { session: latestData.current, error: null };
    setSession(data);
    setError(loadError);
    setLoading(false);
    return { session: data, error: loadError };
  }, []);

  // Mount fetch: loading starts true, so state settles only in async
  // continuations (lint-clean by construction).
  useEffect(() => {
    let cancelled = false;
    fetchState().then(({ data, error: loadError }) => {
      if (cancelled) return;
      latestData.current = data;
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

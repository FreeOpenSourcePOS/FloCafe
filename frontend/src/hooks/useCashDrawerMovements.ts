'use client';

import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import { getCurrencyMinorUnitFactor } from '@/lib/countries';
import { businessDateInTimezone } from '@/lib/business-date';

export type CashDrawerMovementType = 'opening_float' | 'pay_in' | 'pay_out' | 'safe_drop';

export interface CashDrawerMovement {
  id: number;
  business_date: string;
  movement_type: CashDrawerMovementType;
  amount_cents: number;
  reason: string | null;
  created_by: string;
  created_by_name: string;
  created_at: string;
  voided_at: string | null;
  voided_by: string | null;
  voided_by_name: string | null;
  void_reason: string | null;
}

export function useCashDrawerMovements() {
  const { currentTenant } = useAuthStore();
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const unitAdapter = useCurrencyUnitAdapter();
  const minorFactor = getCurrencyMinorUnitFactor(currentTenant?.currency || '');
  const todayLocal = businessDateInTimezone(
    currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    currentTenant?.business_day_start_time || '00:00',
  );
  const [open, setOpen] = useState(false);
  const [businessDate, setBusinessDate] = useState(todayLocal);
  const [movementType, setMovementType] = useState<CashDrawerMovementType>('pay_in');
  const [amountInput, setAmountInput] = useState('');
  const [reason, setReason] = useState('');
  const [movements, setMovements] = useState<CashDrawerMovement[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const movementRequestRef = useRef(0);
  const businessDateRef = useRef(businessDate);
  useEffect(() => {
    businessDateRef.current = businessDate;
  }, [businessDate]);

  const loadMovements = async (date?: string) => {
    const requestedDate = date ?? businessDateRef.current;
    if (date !== undefined) businessDateRef.current = date;
    const requestId = ++movementRequestRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await api.get('/cash-closures/movements', { params: { business_date: requestedDate } });
      if (requestId !== movementRequestRef.current || requestedDate !== businessDateRef.current) return;
      setMovements(response.data?.movements || []);
    } catch (err: unknown) {
      if (requestId !== movementRequestRef.current || requestedDate !== businessDateRef.current) return;
      const message = axios.isAxiosError(err)
        ? err.response?.data?.error || err.message
        : err instanceof Error ? err.message : tCommon('somethingWrong');
      setError(message);
    } finally {
      if (requestId === movementRequestRef.current) setLoading(false);
    }
  };

  const openModal = () => {
    setBusinessDate(todayLocal);
    setMovementType('pay_in');
    setAmountInput('');
    setReason('');
    setOpen(true);
    void loadMovements(todayLocal);
  };

  const amountCents = () => {
    const amountText = amountInput.trim();
    if (amountText === '') return null;
    const amount = Number(amountText);
    if (!Number.isFinite(amount) || amount < 0) return null;
    return Math.round(unitAdapter.toStored(amount) * minorFactor);
  };

  const recordMovement = async () => {
    const cents = amountCents();
    if (cents === null || (movementType !== 'opening_float' && cents === 0)) {
      setError(t('movementAmountRequired'));
      return;
    }
    if (movementType !== 'opening_float' && reason.trim() === '') {
      setError(t('movementReasonRequired'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/cash-closures/movements', {
        business_date: businessDate,
        movement_type: movementType,
        amount_cents: cents,
        reason: reason.trim() || undefined,
      });
      setAmountInput('');
      setReason('');
      await loadMovements();
      toast.success(t('movementSaved'));
    } catch (err: unknown) {
      const message = axios.isAxiosError(err)
        ? err.response?.data?.error || err.message
        : err instanceof Error ? err.message : t('movementSaveFailed');
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const voidMovement = async (id: number, voidReason: string) => {
    if (voidReason.trim() === '') {
      setError(t('voidReason') + ': ' + t('movementReasonRequired'));
      return false;
    }
    setError(null);
    try {
      await api.post(`/cash-closures/movements/${id}/void`, { reason: voidReason.trim() });
      await loadMovements();
      toast.success(t('movementVoided'));
      return true;
    } catch (err: unknown) {
      const message = axios.isAxiosError(err)
        ? err.response?.data?.error || err.message
        : err instanceof Error ? err.message : tCommon('somethingWrong');
      setError(message);
      toast.error(message);
      return false;
    }
  };

  return {
    open,
    setOpen,
    openModal,
    loadMovements,
    businessDate,
    setBusinessDate,
    movementType,
    setMovementType,
    amountInput,
    setAmountInput,
    reason,
    setReason,
    movements,
    loading,
    submitting,
    error,
    recordMovement,
    voidMovement,
    fmt,
    minorFactor,
    unitAdapter,
    t,
    tCommon,
    todayLocal,
  };
}

export type CashDrawerMovementsModel = ReturnType<typeof useCashDrawerMovements>;

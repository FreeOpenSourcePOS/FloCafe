'use client';

import { useRef, useState } from 'react';
import axios from 'axios';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import { getCurrencyMinorUnitFactor } from '@/lib/countries';

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

function localDateInTimezone(timeZone: string, startTime = '00:00'): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const localPart = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const localDate = `${localPart('year')}-${localPart('month')}-${localPart('day')}`;
  const startMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(startTime.trim());
  const localMinutes = Number(localPart('hour')) * 60 + Number(localPart('minute'));
  const startMinutes = startMatch ? Number(startMatch[1]) * 60 + Number(startMatch[2]) : 0;
  if (startMatch && localMinutes < startMinutes) {
    return new Date(Date.UTC(Number(localPart('year')), Number(localPart('month')) - 1, Number(localPart('day')) - 1)).toISOString().slice(0, 10);
  }
  return localDate;
}

export function useCashDrawerMovements() {
  const { currentTenant } = useAuthStore();
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const unitAdapter = useCurrencyUnitAdapter();
  const minorFactor = getCurrencyMinorUnitFactor(currentTenant?.currency || 'INR');
  const todayLocal = localDateInTimezone(
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
  businessDateRef.current = businessDate;

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

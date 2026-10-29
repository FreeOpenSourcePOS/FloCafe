'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApproverSelect } from '@/components/ApproverSelect';
import { Ltr } from '@/components/layout/Ltr';
import { useManagerApprovers } from '@/hooks/useManagerApprovers';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import api from '@/lib/api';
import { createPaymentIdempotencyKey } from '@/lib/payment-idempotency';
import { PAYMENT_METHODS, type CustomPaymentMethod } from '@/lib/payment-methods';
import { normalizeBillPaymentDetails } from '@/components/orders/OrderDetailPanel';
import type { Bill, Order } from '@/lib/types';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';

const BUILT_IN_PAYMENT_KEYS = {
  cash: 'methodCash',
  card: 'methodCard',
} as const;

function extractErrorMessage(error: unknown): string | null {
  const data = (error as { response?: { data?: { error?: unknown } } } | undefined)?.response?.data;
  return typeof data?.error === 'string' && data.error.trim() ? data.error.trim() : null;
}

function firstCorrectableLineIndex(lines: Array<{ method?: string }>): number {
  const idx = lines.findIndex((line) => String(line?.method || '').toLowerCase() !== 'wallet');
  return idx >= 0 ? idx : 0;
}

interface Props {
  order: Order;
  bills: Bill[];
  onClose: () => void;
  onCorrected: (updatedBill?: Bill) => void;
}

export default function CorrectPaymentMethodModal({ order, bills, onClose, onCorrected }: Props) {
  const tOrders = useTranslations('orders');
  const tPos = useTranslations('pos');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();

  const [selectedBillId, setSelectedBillId] = useState<number>(() => bills[0]?.id ?? 0);
  const effectiveBill = bills.find((b) => b.id === selectedBillId) ?? bills[0] ?? null;

  const paymentLines = normalizeBillPaymentDetails(effectiveBill?.payment_details);
  const initialLineIndex = firstCorrectableLineIndex(paymentLines);
  const initialLine = paymentLines[initialLineIndex] ?? paymentLines[0] ?? null;
  const [selectedIndex, setSelectedIndex] = useState<number>(initialLineIndex);

  const [customMethods, setCustomMethods] = useState<CustomPaymentMethod[]>([]);
  const [cardTransactionIdRequired, setCardTransactionIdRequired] = useState<boolean>(false);
  const [methodSelection, setMethodSelection] = useState<string>(() => {
    const firstMethod = String(initialLine?.method || '').toLowerCase();
    return firstMethod === 'cash' ? 'card' : 'cash';
  });
  const [transactionId, setTransactionId] = useState<string>(() =>
    initialLine?.transaction_id ? String(initialLine.transaction_id) : '',
  );
  const [reason, setReason] = useState<string>('');
  const [overridePin, setOverridePin] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => createPaymentIdempotencyKey());

  const managerApprovers = useManagerApprovers();

  const currentLine = paymentLines[selectedIndex] ?? paymentLines[0] ?? null;

  const syncLineDefaults = (line: (typeof paymentLines)[number] | null | undefined) => {
    const currentMethod = String(line?.method || '').toLowerCase();
    setMethodSelection(currentMethod === 'cash' ? 'card' : 'cash');
    setTransactionId(line?.transaction_id ? String(line.transaction_id) : '');
    setIdempotencyKey(createPaymentIdempotencyKey());
  };

  useEffect(() => {
    let cancelled = false;
    api
      .get('/payment-methods')
      .then((res) => {
        if (!cancelled) {
          setCustomMethods(
            (res.data?.payment_methods || []).filter((m: CustomPaymentMethod) =>
              Boolean(m.is_active),
            ),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setCustomMethods([]);
      });
    api
      .get('/settings/card_transaction_id_required')
      .then((res) => {
        if (!cancelled) {
          setCardTransactionIdRequired(res.data?.setting?.value === 'true');
        }
      })
      .catch(() => {
        if (!cancelled) setCardTransactionIdRequired(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const formatLineMethod = (method: string) => {
    const lower = String(method || '').toLowerCase();
    if (lower === 'cash') return tPos('methodCash');
    if (lower === 'card') return tPos('methodCard');
    if (lower === 'wallet') return tPos('methodWallet');
    return method;
  };

  const selectedCustomMethod = methodSelection.startsWith('custom:')
    ? (customMethods.find((m) => `custom:${m.id}` === methodSelection) ?? null)
    : null;
  const resolvedMethodName = selectedCustomMethod ? selectedCustomMethod.name : methodSelection;
  const isCashSelected = resolvedMethodName.toLowerCase() === 'cash' && !selectedCustomMethod;
  const isBuiltInCardSelected = methodSelection === 'card' && !selectedCustomMethod;
  const missingRequiredCardTxId =
    isBuiltInCardSelected && cardTransactionIdRequired && !transactionId.trim();

  const canSubmit =
    Boolean(effectiveBill) &&
    Boolean(currentLine) &&
    String(currentLine?.method || '').toLowerCase() !== 'wallet' &&
    !missingRequiredCardTxId &&
    !submitting &&
    !managerApprovers.loading &&
    !managerApprovers.loadFailed &&
    Boolean(managerApprovers.selectedApproverId) &&
    /^\d{4,6}$/.test(overridePin);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveBill || !currentLine || !canSubmit) return;

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        method: selectedCustomMethod ? 'custom' : methodSelection,
        ...(selectedCustomMethod ? { payment_method_id: selectedCustomMethod.id } : {}),
        ...(!isCashSelected && transactionId.trim()
          ? { transaction_id: transactionId.trim() }
          : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        approver_id: managerApprovers.selectedApproverId,
        override_pin: overridePin,
      };
      const { data } = await api.patch(
        `/bills/${effectiveBill.id}/payments/${selectedIndex}/method`,
        payload,
        {
          headers: {
            'Idempotency-Key': idempotencyKey,
          },
        },
      );
      toast.success(tOrders('paymentMethodCorrected'));
      onCorrected(data?.bill);
    } catch (error) {
      const msg = extractErrorMessage(error) || tOrders('correctPaymentMethodFailed');
      toast.error(msg);
      setIdempotencyKey(createPaymentIdempotencyKey());
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      data-testid="correct-payment-method-modal"
    >
      <div className="bg-card rounded-xl shadow-xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-bold text-foreground mb-1">
          {tOrders('correctPaymentMethod')} #<Ltr>{order.order_number}</Ltr>
        </h2>
        <p className="text-xs text-muted-foreground mb-4">{tOrders('correctPaymentMethodHint')}</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {bills.length > 1 && (
            <div>
              <label
                htmlFor="correctPaymentBillSelect"
                className="block text-sm font-medium text-foreground mb-1"
              >
                {tOrders('refundBillLabel')}
              </label>
              <select
                id="correctPaymentBillSelect"
                value={effectiveBill?.id ?? ''}
                onChange={(e) => {
                  const nextBillId = Number(e.target.value);
                  setSelectedBillId(nextBillId);
                  const nextBill = bills.find((b) => b.id === nextBillId) ?? bills[0] ?? null;
                  const nextLines = normalizeBillPaymentDetails(nextBill?.payment_details);
                  const nextIdx = firstCorrectableLineIndex(nextLines);
                  setSelectedIndex(nextIdx);
                  syncLineDefaults(nextLines[nextIdx]);
                }}
                className="w-full px-3 py-2 border border-border bg-card rounded-lg text-sm text-foreground"
              >
                {bills.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.split_label || `#${b.bill_number}`} · {fmt(Number(b.total))}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label
              htmlFor="correctPaymentLineSelect"
              className="block text-sm font-medium text-foreground mb-1"
            >
              {tOrders('paymentLineLabel')}
            </label>
            {paymentLines.length > 1 ? (
              <select
                id="correctPaymentLineSelect"
                value={selectedIndex}
                onChange={(e) => {
                  const nextIndex = Number(e.target.value);
                  setSelectedIndex(nextIndex);
                  syncLineDefaults(paymentLines[nextIndex]);
                }}
                className="w-full px-3 py-2 border border-border bg-card rounded-lg text-sm text-foreground"
              >
                {paymentLines.map((line, idx) => (
                  <option
                    key={`${line.method}-${idx}`}
                    value={idx}
                    disabled={String(line.method || '').toLowerCase() === 'wallet'}
                  >
                    #{idx + 1} · {formatLineMethod(line.method)} · {fmt(Number(line.amount))}
                  </option>
                ))}
              </select>
            ) : currentLine ? (
              <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-border bg-muted/40 text-sm">
                <span className="font-medium text-foreground">
                  {formatLineMethod(currentLine.method)}
                </span>
                <span className="font-bold text-foreground" data-testid="immutable-payment-amount">
                  {fmt(Number(currentLine.amount))}
                </span>
              </div>
            ) : null}
          </div>

          <div>
            <label
              htmlFor="correctPaymentNewMethod"
              className="block text-sm font-medium text-foreground mb-1"
            >
              {tPos('payment')}
            </label>
            <select
              id="correctPaymentNewMethod"
              data-testid="correct-payment-method-select"
              value={methodSelection}
              onChange={(e) => {
                setMethodSelection(e.target.value);
                setIdempotencyKey(createPaymentIdempotencyKey());
              }}
              className="w-full px-3 py-2 border border-border bg-card rounded-lg text-sm text-foreground"
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m.key} value={m.key}>
                  {tPos(BUILT_IN_PAYMENT_KEYS[m.key])}
                </option>
              ))}
              {customMethods.map((cm) => (
                <option key={cm.id} value={`custom:${cm.id}`}>
                  {cm.name}
                </option>
              ))}
            </select>
          </div>

          {!isCashSelected && (
            <div>
              <label
                htmlFor="correctPaymentTransactionId"
                className="block text-sm font-medium text-foreground mb-1"
              >
                {tOrders('transactionNumber')}
              </label>
              <input
                id="correctPaymentTransactionId"
                type="text"
                maxLength={256}
                value={transactionId}
                onChange={(e) => setTransactionId(e.target.value)}
                placeholder={tOrders('transactionNumber')}
                className="w-full px-3 py-2 border border-border bg-card rounded-lg text-sm text-foreground"
              />
            </div>
          )}

          <div>
            <label
              htmlFor="correctPaymentReason"
              className="block text-sm font-medium text-foreground mb-1"
            >
              {tCommon('reasonOptional')}
            </label>
            <input
              id="correctPaymentReason"
              type="text"
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-3 py-2 border border-border bg-card rounded-lg text-sm text-foreground"
            />
          </div>

          <div className="space-y-3 pt-1 border-t border-border">
            <ApproverSelect
              id="correctPaymentApproverSelect"
              approvers={managerApprovers.approvers}
              selectedApproverId={managerApprovers.selectedApproverId}
              onSelectApprover={(id) => {
                managerApprovers.setSelectedApproverId(id);
                setOverridePin('');
              }}
              loading={managerApprovers.loading}
              loadFailed={managerApprovers.loadFailed}
              disabled={submitting}
            />
            <div>
              <label
                htmlFor="correctPaymentOverridePin"
                className="block text-sm font-medium text-foreground mb-1"
              >
                {tOrders('refundApprovalPinLabel')}
              </label>
              <input
                id="correctPaymentOverridePin"
                data-testid="correct-payment-pin-input"
                type="password"
                inputMode="numeric"
                maxLength={6}
                value={overridePin}
                onChange={(e) => setOverridePin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder={tOrders('managerPin')}
                className="w-full px-3 py-2 border border-border bg-card rounded-lg text-sm text-foreground"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {tOrders('refundApprovalPinHint')}
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={submitting}
            >
              {tCommon('cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              data-testid="correct-payment-submit-button"
              disabled={!canSubmit}
            >
              {submitting && <Loader2 size={14} className="animate-spin me-1.5" />}
              {tCommon('save')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

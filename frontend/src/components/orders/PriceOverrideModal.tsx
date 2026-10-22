'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import api from '@/lib/api';
import { formatItemHeading } from '@/lib/printer/item-heading';
import type { OrderItem } from '@/lib/types';

const MAX_REASON_LENGTH = 200;

interface Props {
  orderId: number;
  item: OrderItem;
  onClose: () => void;
  onSaved: () => void;
}

/** Owner-only: sets a manual unit price (0 allowed) with a required reason. */
export function PriceOverrideModal({ orderId, item, onClose, onSaved }: Props) {
  const t = useTranslations('orders');
  const tCommon = useTranslations('common');
  const [price, setPrice] = useState(String(item.unit_price ?? ''));
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const parsedPrice = price.trim() === '' ? NaN : Number(price);
  const valid = Number.isFinite(parsedPrice) && parsedPrice >= 0 && reason.trim().length > 0;

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      await api.patch(`/orders/${orderId}/items/${item.id}/price`, {
        price: parsedPrice,
        reason: reason.trim(),
      });
      toast.success(t('overridePriceSaved'));
      onSaved();
      onClose();
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data
        ?.error;
      toast.error(message || t('overridePriceFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !submitting) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('overridePriceTitle')}</DialogTitle>
          <DialogDescription>
            {formatItemHeading(item.product_name, item.variant_selection)} —{' '}
            {t('overridePriceHint')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="override-price">{t('overridePriceNewPrice')}</Label>
            <Input
              id="override-price"
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="override-reason">{t('overridePriceReason')}</Label>
            <Input
              id="override-reason"
              value={reason}
              maxLength={MAX_REASON_LENGTH}
              placeholder={t('overridePriceReasonPlaceholder')}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={submit} disabled={!valid || submitting}>
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {t('overridePriceSave')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

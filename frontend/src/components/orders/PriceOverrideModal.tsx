'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { formatItemHeading } from '@/lib/printer/item-heading';
import type { OrderItem } from '@/lib/types';
import { PriceOverrideDialog } from './PriceOverrideDialog';

interface Props {
  orderId: number;
  item: OrderItem;
  onClose: () => void;
  onSaved: () => void;
}

/** Owner-only: sets a manual unit price (0 allowed) with a required reason on a placed order. */
export function PriceOverrideModal({ orderId, item, onClose, onSaved }: Props) {
  const t = useTranslations('orders');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (price: number, reason: string) => {
    setSubmitting(true);
    try {
      await api.patch(`/orders/${orderId}/items/${item.id}/price`, { price, reason });
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
    <PriceOverrideDialog
      heading={formatItemHeading(item.product_name, item.variant_selection)}
      initialPrice={Number(item.unit_price) || 0}
      submitting={submitting}
      onSubmit={submit}
      onClose={onClose}
    />
  );
}

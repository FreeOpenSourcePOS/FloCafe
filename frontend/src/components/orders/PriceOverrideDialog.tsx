'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
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

const MAX_REASON_LENGTH = 200;

interface Props {
  /** Item heading shown in the dialog description. */
  heading: string;
  initialPrice: number;
  initialReason?: string;
  submitting?: boolean;
  onSubmit: (price: number, reason: string) => void;
  /** When provided, shows a button that drops the override and returns to the menu price. */
  onClear?: () => void;
  onClose: () => void;
}

/** Shared price + reason form for the owner-only manual price override. */
export function PriceOverrideDialog({
  heading,
  initialPrice,
  initialReason = '',
  submitting = false,
  onSubmit,
  onClear,
  onClose,
}: Props) {
  const t = useTranslations('orders');
  const tCommon = useTranslations('common');
  const [price, setPrice] = useState(String(initialPrice));
  const [reason, setReason] = useState(initialReason);

  const parsedPrice = price.trim() === '' ? NaN : Number(price);
  const valid = Number.isFinite(parsedPrice) && parsedPrice >= 0 && reason.trim().length > 0;

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
            {heading} — {t('overridePriceHint')}
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
          {onClear && (
            <Button variant="ghost" onClick={onClear} disabled={submitting}>
              {t('overridePriceClear')}
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button
            onClick={() => valid && !submitting && onSubmit(parsedPrice, reason.trim())}
            disabled={!valid || submitting}
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {t('overridePriceSave')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

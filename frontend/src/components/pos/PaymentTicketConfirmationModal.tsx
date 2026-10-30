'use client';

import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Printer, Check, Loader2, QrCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { Order } from '@/lib/types';

interface Props {
  open: boolean;
  order: Order | null;
  qrDataUrl?: string | null;
  qrPayload?: string | null;
  onClose: () => void;
}

export function PaymentTicketConfirmationModal({
  open,
  order,
  qrDataUrl,
  qrPayload,
  onClose,
}: Props) {
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const [printing, setPrinting] = useState(false);

  if (!order) return null;

  const handlePrint = async () => {
    setPrinting(true);
    try {
      await api.post('/printers/print-payment-ticket', { order_id: order.id });
      toast.success(t('paymentTicketPrinted'));
    } catch (err: unknown) {
      const errData = (err as { response?: { data?: { error?: string } } })?.response?.data;
      toast.error(errData?.error || t('paymentTicketPrintFailed'));
    } finally {
      setPrinting(false);
    }
  };

  const ticketPayload = qrPayload || `FLOCAFE-TICKET:${order.order_number}`;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        className="sm:max-w-md text-center"
        data-testid="payment-ticket-confirmation-modal"
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-bold flex items-center justify-center gap-2">
            <QrCode className="size-6 text-brand" />
            {t('paymentTicket')}
          </DialogTitle>
          <DialogDescription>{t('paymentTicketDesc')}</DialogDescription>
        </DialogHeader>

        <div className="my-4 flex flex-col items-center space-y-4">
          <div className="rounded-xl bg-muted/60 p-4 w-full">
            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
              {t('ticketNumber')}
            </p>
            <p
              className="text-4xl font-extrabold text-brand my-1"
              data-testid="payment-ticket-number"
            >
              #{order.order_number}
            </p>
            <div className="flex justify-between items-center text-sm pt-2 border-t border-border mt-2">
              <span className="text-muted-foreground capitalize">
                {order.type === 'dine_in'
                  ? `${t('orderTypeDineIn')}${order.table?.name ? ` (${order.table.name})` : ''}`
                  : t('orderTypeTakeaway')}
              </span>
              <span className="font-bold text-foreground text-base">{fmt(order.total)}</span>
            </div>
          </div>

          {qrDataUrl ? (
            <div className="p-3 bg-white rounded-xl shadow-sm border border-border inline-block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrDataUrl}
                alt={ticketPayload}
                className="w-48 h-48 mx-auto"
                data-testid="payment-ticket-qr"
              />
            </div>
          ) : (
            <div className="p-8 bg-muted rounded-xl text-center">
              <p className="font-mono text-sm font-semibold">{ticketPayload}</p>
            </div>
          )}

          <p className="text-xs text-muted-foreground">{t('paymentTicketInstruction')}</p>
        </div>

        <DialogFooter className="flex sm:flex-row gap-2 justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={handlePrint}
            disabled={printing}
            className="flex-1"
            data-testid="print-payment-ticket-btn"
          >
            {printing ? (
              <Loader2 className="size-4 animate-spin me-2" />
            ) : (
              <Printer className="size-4 me-2" />
            )}
            {t('printTicket')}
          </Button>
          <Button
            type="button"
            onClick={onClose}
            className="flex-1"
            data-testid="payment-ticket-done-btn"
          >
            <Check className="size-4 me-2" />
            {tCommon('done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MasterPinPrompt } from './MasterPinPrompt';

type Impact = {
  currentCurrency: string;
  invoices: number;
  orders: number;
  refunds: number;
  customers: number;
  products: number;
  addons: number;
};

interface CurrencyResetDialogProps {
  open: boolean;
  targetCurrency: string;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function CurrencyResetDialog({ open, targetCurrency, onOpenChange, onSuccess }: CurrencyResetDialogProps) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const [impactResult, setImpactResult] = useState<{ target: string; impact: Impact | null } | null>(null);
  const [phrase, setPhrase] = useState('');
  const [showPin, setShowPin] = useState(false);
  const confirmationPhrase = `CHANGE TO ${targetCurrency}`;
  const impact = impactResult?.target === targetCurrency ? impactResult.impact : null;
  const loading = open && impactResult?.target !== targetCurrency;

  useEffect(() => {
    if (!open) return;
    api.get('/db-tools/currency-reset-impact')
      .then(({ data }) => setImpactResult({ target: targetCurrency, impact: data }))
      .catch(() => setImpactResult({ target: targetCurrency, impact: null }));
  }, [open, targetCurrency]);

  const close = () => {
    setPhrase('');
    setShowPin(false);
    onOpenChange(false);
  };

  const submitPin = async (pin: string) => {
    if (!impact) return { success: false, error: t('currencyImpactFailed') };
    try {
      await api.post('/db-tools/currency-reset', {
        currency: targetCurrency,
        current_currency: impact.currentCurrency,
        confirmation_phrase: confirmationPhrase,
        master_pin: pin,
      });
      onSuccess();
      return { success: true };
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { error?: string } } }).response?.data?.error;
      return { success: false, error: message || t('currencyResetFailed') };
    }
  };

  return (
    <>
      <Dialog open={open && !showPin} onOpenChange={(next) => !next && close()}>
        <DialogContent className="sm:max-w-lg" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle size={20} />
              {t('currencyChangeTitle', { currency: targetCurrency })}
            </DialogTitle>
            <DialogDescription className="space-y-3 pt-2 text-start">
              {loading ? <span className="block">{tCommon('loading')}</span> : null}
              {!loading && impact ? (
                <>
                  <span className="block font-semibold text-red-700 dark:text-red-400">
                    {t('currencyChangeExistingData', {
                      currency: impact.currentCurrency,
                      invoices: impact.invoices,
                      orders: impact.orders,
                    })}
                  </span>
                  <span className="block">{t('currencyChangeDestructiveBody', { currency: targetCurrency })}</span>
                  <span className="block font-medium">{t('currencyChangeMenuBody')}</span>
                  <span className="block">{t('currencyChangeBackupBody')}</span>
                </>
              ) : null}
              {!loading && !impact ? <span className="block text-red-600">{t('currencyImpactFailed')}</span> : null}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="currency-reset-confirm">{t('currencyChangeTypeConfirm', { phrase: confirmationPhrase })}</Label>
            <Input
              id="currency-reset-confirm"
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
              placeholder={confirmationPhrase}
              autoComplete="off"
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={close}>{tCommon('cancel')}</Button>
            <Button
              variant="destructive"
              disabled={!impact || phrase !== confirmationPhrase}
              onClick={() => setShowPin(true)}
            >
              {t('currencyChangeConfirmButton', { currency: targetCurrency })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MasterPinPrompt
        open={open && showPin}
        mode="verify"
        title={t('masterPin')}
        description={t('currencyChangePinPrompt')}
        onCancel={() => setShowPin(false)}
        onSubmit={submitPin}
      />
    </>
  );
}

'use client';

import { useState } from 'react';
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
import { useI18n } from '@/hooks/useI18n';

interface MasterPinPromptProps {
  open: boolean;
  mode: 'verify' | 'set';
  title?: string;
  description?: string;
  onCancel: () => void;
  onSubmit: (pin: string) => Promise<{ success: boolean; error?: string }>;
}

const PIN_REGEX = /^\d{4}$/;

export function MasterPinPrompt({ open, mode, title, description, onCancel, onSubmit }: MasterPinPromptProps) {
  const { t } = useI18n();
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setPin('');
    setConfirmPin('');
    setError(null);
    setSubmitting(false);
  };

  const handleCancel = () => {
    reset();
    onCancel();
  };

  const handleSubmit = async () => {
    setError(null);

    if (!PIN_REGEX.test(pin)) {
      setError(t('settings.pinFourDigits'));
      return;
    }
    if (mode === 'set' && pin !== confirmPin) {
      setError(t('settings.pinMismatch'));
      setConfirmPin('');
      return;
    }

    setSubmitting(true);
    const result = await onSubmit(pin);
    setSubmitting(false);

    if (result.success) {
      reset();
    } else {
      setError(result.error || t('common.somethingWrong'));
      setPin('');
      setConfirmPin('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleCancel()}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title || t('settings.masterPin')}</DialogTitle>
          <DialogDescription>
            {description || (mode === 'set'
              ? t('settings.setPinDescription')
              : t('settings.verifyPinDescription'))}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="master-pin">{mode === 'set' ? t('settings.newPin') : t('settings.masterPin')}</Label>
            <Input
              id="master-pin"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              onKeyDown={(e) => e.key === 'Enter' && mode === 'verify' && handleSubmit()}
              placeholder="••••"
              className="text-center text-lg tracking-[0.5em]"
            />
          </div>

          {mode === 'set' && (
            <div className="space-y-2">
              <Label htmlFor="master-pin-confirm">{t('settings.confirmPin')}</Label>
              <Input
                id="master-pin-confirm"
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={4}
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                placeholder="••••"
                className="text-center text-lg tracking-[0.5em]"
              />
            </div>
          )}

          {error && <p className="text-sm font-medium text-red-600">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || pin.length !== 4}>
            {submitting ? t('common.loading') : mode === 'set' ? t('settings.setPinButton') : t('settings.confirmButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

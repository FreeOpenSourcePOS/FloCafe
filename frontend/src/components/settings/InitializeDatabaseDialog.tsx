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
import { MasterPinPrompt } from './MasterPinPrompt';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';

const CONFIRM_PHRASE = 'INITIALIZE';

interface InitializeDatabaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (pin: string) => Promise<{ success: boolean; error?: string; backupPath?: string }>;
  onSuccess: (backupPath?: string) => void;
}

export function InitializeDatabaseDialog({ open, onOpenChange, onConfirm, onSuccess }: InitializeDatabaseDialogProps) {
  const { t } = useI18n();
  const [phrase, setPhrase] = useState('');
  const [showPinPrompt, setShowPinPrompt] = useState(false);

  const reset = () => {
    setPhrase('');
    setShowPinPrompt(false);
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const handlePinSubmit = async (pin: string) => {
    try {
      const result = await onConfirm(pin);
      if (result.success) {
        reset();
        onOpenChange(false);
        onSuccess(result.backupPath);
      }
      return result;
    } catch (err: unknown) {
      const errorMsg = (err as Error)?.message || 'Initialization failed';
      return { success: false, error: errorMsg };
    }
  };

  return (
    <>
      <Dialog open={open && !showPinPrompt} onOpenChange={(next) => !next && close()}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle size={18} />
              {t('settings.initializeDatabase')}
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-2 text-left">
              <span className="block">
                {t('settings.initializeDialogBody')}
              </span>
              <span className="block font-medium text-gray-700">
                {t('settings.initializeDialogBackup')}
              </span>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="initialize-confirm">
              {t('settings.initializeTypeConfirm', { phrase: CONFIRM_PHRASE })}
            </Label>
            <Input
              id="initialize-confirm"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder={CONFIRM_PHRASE}
              autoFocus
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={close}>{t('common.cancel')}</Button>
            <Button
              variant="destructive"
              disabled={phrase !== CONFIRM_PHRASE}
              onClick={() => setShowPinPrompt(true)}
            >
              {t('common.continue')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MasterPinPrompt
        open={open && showPinPrompt}
        mode="verify"
        title={t('settings.masterPin')}
        description={t('settings.initializeMasterPinPrompt')}
        onCancel={() => setShowPinPrompt(false)}
        onSubmit={handlePinSubmit}
      />
    </>
  );
}

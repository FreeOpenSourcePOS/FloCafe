'use client';

/**
 * Restart-to-install confirmation guard (#463).
 *
 * Every UI path that can restart the app to install a downloaded update must
 * go through this dialog. It shows a prominent RED warning that all systems
 * go down while the update installs, and requires an explicit manager or
 * owner PIN confirmation before the restart is requested.
 *
 * The PIN is verified in the main process (`authorizeMasterPin` inside the
 * `restart-and-install` handler); a wrong PIN, a rate limit, or cancelling
 * the dialog simply keeps the app running — there is no path from this
 * dialog to `quitAndInstall` without an approved PIN.
 */

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
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
import {
  canSubmitRestartInstall,
  normalizeRestartInstallResult,
} from '@/lib/updates/restart-install';

interface UpdateInstallGuardDialogProps {
  open: boolean;
  onCancel: () => void;
  /** Performs the guarded IPC call; resolves with the normalized result. */
  onRequestRestart: (pin: string) => Promise<unknown>;
}

export function UpdateInstallGuardDialog({ open, onCancel, onRequestRestart }: UpdateInstallGuardDialogProps) {
  const t = useTranslations('update');
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPin('');
    setError(null);
    setSubmitting(false);
  };

  const handleCancel = () => {
    if (submitting) return;
    reset();
    onCancel();
  };

  const handleSubmit = async () => {
    // Explicit confirm only: an empty/invalid PIN can never reach the IPC
    // layer, so dismissing or fat-fingering this dialog cannot restart the app.
    if (!canSubmitRestartInstall(pin, submitting)) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = normalizeRestartInstallResult(await onRequestRestart(pin));
      if (!result.ok) {
        setError(result.error || t('installGuardFailedGeneric'));
        setPin('');
        setSubmitting(false);
      }
      // On success the app quits; leave the dialog in its busy state.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPin('');
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleCancel()}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('installGuardTitle')}</DialogTitle>
          <DialogDescription>{t('installGuardDescription')}</DialogDescription>
        </DialogHeader>

        {/* Prominent red warning: restarting to install takes the whole POS down. */}
        <div className="rounded-lg border-2 border-red-600 bg-red-50 p-4" role="alert" data-testid="update-install-warning">
          <div className="flex items-start gap-2">
            <AlertTriangle size={20} className="mt-0.5 shrink-0 text-red-600" aria-hidden />
            <div className="space-y-1.5 text-sm text-red-700">
              <p className="font-semibold text-red-800">{t('installWarnTitle')}</p>
              <ul className="list-disc space-y-1 pl-4">
                <li>{t('installWarnSystemsDown')}</li>
                <li>{t('installWarnAutoRestart')}</li>
                <li>{t('installWarnBusinessHours')}</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="update-install-pin">{t('installPinLabel')}</Label>
          <Input
            id="update-install-pin"
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={4}
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder="••••"
            disabled={submitting}
            className="text-center text-lg tracking-[0.5em]"
          />
          {error && <p className="text-sm font-medium text-red-600">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={submitting}>
            {t('installCancelButton')}
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={!canSubmitRestartInstall(pin, submitting)}
            data-testid="update-install-confirm"
          >
            {submitting ? t('installRestarting') : t('installConfirmButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

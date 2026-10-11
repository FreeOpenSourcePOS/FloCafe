'use client';

/** Asks before downloading an available update, with the automatic-check opt-out. */

import { useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useUpdateStatus } from '@/hooks/useUpdateStatus';
import { useAutoUpdateCheck } from '@/hooks/useAutoUpdateCheck';

export default function UpdateAvailableDialog() {
  const t = useTranslations('update');
  const { updateStatus, downloadUpdate } = useUpdateStatus();
  const autoCheck = useAutoUpdateCheck();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const version = updateStatus?.version ?? '';
  const open = updateStatus?.status === 'available' && dismissedVersion !== version;

  const handleLater = () => setDismissedVersion(version);

  const handleDownload = async () => {
    setStarting(true);
    const result = await downloadUpdate();
    setStarting(false);
    if (!result.success) toast.error(t('downloadFailedToStart'));
    setDismissedVersion(version);
  };

  const handleAutoCheckChange = async (next: boolean) => {
    if (!(await autoCheck.setEnabled(next))) toast.error(t('autoCheckToggleFailed'));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleLater();
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="update-available-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download size={18} className="text-brand" />
            {t('availableTitle')}
          </DialogTitle>
          <DialogDescription>{t('availableDescription', { version })}</DialogDescription>
        </DialogHeader>

        {autoCheck.supported && (
          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={autoCheck.enabled}
              disabled={autoCheck.busy}
              onChange={(e) => void handleAutoCheckChange(e.target.checked)}
              data-testid="update-auto-check-checkbox"
              className="h-4 w-4 accent-brand"
            />
            {t('autoCheckTitle')}
          </label>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleLater} disabled={starting}>
            {t('later')}
          </Button>
          <Button onClick={() => void handleDownload()} disabled={starting}>
            {t('downloadNow')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

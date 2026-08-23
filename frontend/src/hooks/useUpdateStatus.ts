import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@/types/electron';
import { shouldApplyInitialUpdateStatus } from './update-status-sync';

/**
 * Shared update-status state, backed by the same IPC channels the Settings
 * page and the header badge both need: current app version, the live
 * update-status stream, and the ability to trigger a manual check or restart
 * once a downloaded update is ready to install.
 */
export function useUpdateStatus() {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');
  // True only inside the Electron app; browser/LAN users never get update
  // controls (Settings hides them instead of showing a dead button).
  const [isElectron, setIsElectron] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI) return;

    // Resolving app info proves we are in the Electron host; deriving
    // isElectron here (instead of a synchronous effect setState) keeps the
    // first render stable for SSR/static export.
    window.electronAPI.getAppInfo().then((info) => {
      setAppVersion(info.version);
      setIsElectron(true);
    });
    let receivedLiveUpdateStatus = false;
    const unsubscribe = window.electronAPI.onUpdateStatus((status) => {
      receivedLiveUpdateStatus = true;
      setUpdateStatus(status);
    });
    // Seed from the persisted main-process state so reloads recover one-shot
    // states (store-managed / linux-managed / dev-mode) and failures (#467).
    window.electronAPI.getUpdateStatus().then((status) => {
      if (!status || !shouldApplyInitialUpdateStatus(receivedLiveUpdateStatus)) return;
      setUpdateStatus({
        status: status.status,
        ...(status.version !== undefined ? { version: status.version } : {}),
        ...(status.percent !== undefined ? { percent: status.percent } : {}),
        ...(status.reason !== undefined ? { reason: status.reason } : {}),
        ...(status.error !== undefined ? { error: status.error } : {})
      });
    });
    return () => { unsubscribe?.(); };
  }, []);

  const checkForUpdates = () => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.checkForUpdates();
    }
  };

  const restartAndInstall = () => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.restartAndInstall();
    }
  };

  return { updateStatus, appVersion, isElectron, checkForUpdates, restartAndInstall };
}

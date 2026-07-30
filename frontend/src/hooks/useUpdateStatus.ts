import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@/types/electron';

/**
 * Shared update-status state, backed by the same IPC channels the Settings
 * page and the header badge both need: current app version, the live
 * update-status stream, and the ability to trigger a manual check or restart
 * once a downloaded update is ready to install.
 */
export function useUpdateStatus() {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI) return;

    window.electronAPI.getAppInfo().then((info) => setAppVersion(info.version));
    const unsubscribe = window.electronAPI.onUpdateStatus((status) => {
      setUpdateStatus(status);
    });
    window.electronAPI.getUpdateStatus().then((status) => {
      if (status) setUpdateStatus({ status: status.status, version: status.info?.version });
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

  return { updateStatus, appVersion, checkForUpdates, restartAndInstall };
}

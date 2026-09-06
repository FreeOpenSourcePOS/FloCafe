import { useEffect, useState } from 'react';
import type { ElectronActionResult, UpdateStatus } from '@/types/electron';
import { shouldApplyInitialUpdateStatus } from './update-status-sync';

/** Shared update status hook backed by Electron IPC channels
 * for version info, status stream, and restart triggers. */
export function useUpdateStatus() {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');
  // True only inside the Electron app; browser/LAN users never get update
  // controls (Settings hides them instead of showing a dead button).
  const [isElectron, setIsElectron] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI) return;

    // App info resolution confirms Electron host; keeps initial render
    // stable for static SSR export.
    window.electronAPI.getAppInfo().then((info) => {
      if ('error' in info) return;
      setAppVersion(info.version);
      setIsElectron(true);
    });
    let receivedLiveUpdateStatus = false;
    const unsubscribe = window.electronAPI.onUpdateStatus((status) => {
      receivedLiveUpdateStatus = true;
      setUpdateStatus(status);
    });
    // Seed from persisted main-process state so reloads recover status.
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

  // Forwards PIN to main process restart-and-install handler and returns result.
  const restartAndInstall = (pin?: string) => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      return window.electronAPI.restartAndInstall(pin);
    }
    return Promise.resolve({ success: false, error: 'not-available' } satisfies ElectronActionResult);
  };

  return { updateStatus, appVersion, isElectron, checkForUpdates, restartAndInstall };
}

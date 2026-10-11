import { useEffect, useState } from 'react';
import {
  readAutoUpdateCheckState,
  writeAutoUpdateCheckState,
} from '@/lib/updates/auto-update-check';

/** Automatic update check preference, moved only on a confirmed main-process write. */
export function useAutoUpdateCheck() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    readAutoUpdateCheckState(typeof window !== 'undefined' ? window.electronAPI : undefined).then(
      (state) => {
        if (cancelled) return;
        setSupported(state.supported);
        if (state.enabled !== null) setEnabled(state.enabled);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const update = async (next: boolean): Promise<boolean> => {
    if (!supported || busy) return false;
    setBusy(true);
    const result = await writeAutoUpdateCheckState(window.electronAPI, next);
    if (result.ok && result.enabled !== null) setEnabled(result.enabled);
    setBusy(false);
    return result.ok;
  };

  return { supported, enabled, busy, setEnabled: update };
}

/** Helpers for the automatic update check preference, sharing the beta toggle's IPC normalization. */

import {
  normalizeBetaChannelValue,
  normalizeBetaChannelWriteResult,
  type ReadBetaChannelResult,
  type WriteBetaChannelResult,
} from './beta-channel';

export interface AutoUpdateCheckApi {
  getAutoUpdateCheck?: () => Promise<unknown>;
  setAutoUpdateCheck?: (enabled: boolean) => Promise<unknown>;
}

export function autoUpdateCheckApiSupported(api: AutoUpdateCheckApi | null | undefined): boolean {
  return (
    typeof api?.getAutoUpdateCheck === 'function' && typeof api?.setAutoUpdateCheck === 'function'
  );
}

export async function readAutoUpdateCheckState(
  api: AutoUpdateCheckApi | null | undefined,
): Promise<ReadBetaChannelResult> {
  if (!autoUpdateCheckApiSupported(api)) return { supported: false, enabled: null };
  try {
    const enabled = normalizeBetaChannelValue(await api!.getAutoUpdateCheck!());
    return { supported: enabled !== null, enabled };
  } catch {
    return { supported: false, enabled: null };
  }
}

export async function writeAutoUpdateCheckState(
  api: AutoUpdateCheckApi | null | undefined,
  enabled: boolean,
): Promise<WriteBetaChannelResult> {
  if (!autoUpdateCheckApiSupported(api)) {
    return { ok: false, enabled: null, error: 'auto-update-check-unavailable' };
  }
  try {
    return normalizeBetaChannelWriteResult(await api!.setAutoUpdateCheck!(enabled), enabled);
  } catch (error) {
    return {
      ok: false,
      enabled: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

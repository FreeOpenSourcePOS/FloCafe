import { getSettingValue } from '../db';

export const OFFLINE_MODE_SETTING = 'offline_mode';

export class OfflineModeError extends Error {
  readonly code = 'offline_mode';

  constructor(feature: string) {
    super(`${feature} is unavailable while Offline mode is on`);
    this.name = 'OfflineModeError';
  }
}

/** True when the owner switched every optional outbound connection off. */
export function isOfflineMode(): boolean {
  if (process.env.FLO_MATRIX_OFFLINE === '1') return true;
  try {
    return getSettingValue(OFFLINE_MODE_SETTING) === 'true';
  } catch {
    return false;
  }
}

const enabledListeners = new Set<() => void>();

/** Runs `listener` whenever the owner switches Offline mode on, so live connections can close. */
export function onOfflineModeEnabled(listener: () => void): void {
  enabledListeners.add(listener);
}

export function notifyOfflineModeEnabled(): void {
  for (const listener of enabledListeners) {
    try {
      listener();
    } catch (error) {
      console.error('[OfflineMode] Listener failed:', error);
    }
  }
}

export function assertOnlineAllowed(feature: string): void {
  if (isOfflineMode()) throw new OfflineModeError(feature);
}

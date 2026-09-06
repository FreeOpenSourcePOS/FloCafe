/** Pure helpers for restart-to-install confirmation guard. */

export const MANAGER_PIN_REGEX = /^\d{4}$/;

export interface RestartInstallResult {
  ok: boolean;
  error?: string;
}

/** Normalizes restartAndInstall IPC result for both legacy void and guarded responses. */
export function normalizeRestartInstallResult(raw: unknown): RestartInstallResult {
  if (raw === undefined || raw === null) {
    // Legacy void resolution: the main process used to just quit.
    return { ok: true };
  }
  if (typeof raw !== 'object') {
    return { ok: false, error: String(raw) };
  }
  const record = raw as { success?: unknown; error?: unknown };
  if (record.success === true) return { ok: true };
  const error = typeof record.error === 'string' && record.error.length > 0
    ? record.error
    : undefined;
  return { ok: false, error };
}

/** Renderer-side precondition: exactly 4 digits, matching the Master PIN format. */
export function isValidManagerPinInput(pin: string): boolean {
  return MANAGER_PIN_REGEX.test(pin);
}

/** Checks whether confirm action may fire (valid PIN format and not busy). */
export function canSubmitRestartInstall(pin: string, busy: boolean): boolean {
  return !busy && isValidManagerPinInput(pin);
}

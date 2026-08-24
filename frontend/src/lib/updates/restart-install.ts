/**
 * Pure helpers for the restart-to-install confirmation guard (#463).
 *
 * The authoritative gate lives in the main process (`restart-and-install`
 * authorizes the manager/owner PIN via `authorizeMasterPin` before calling
 * `quitAndInstall`). These helpers only normalize the IPC result and enforce
 * the renderer-side preconditions so the dialog can never submit an
 * obviously invalid request.
 */

export const MANAGER_PIN_REGEX = /^\d{4}$/;

export interface RestartInstallResult {
  ok: boolean;
  error?: string;
}

/**
 * Normalize what `restartAndInstall(pin)` resolved to.
 *
 * Older preload builds resolved the invoke with `undefined` (fire and
 * forget), while the guarded contract resolves `{ success, error? }`. Both
 * must keep working so this UI stays correct across a rolling update.
 */
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

/**
 * Whether the confirm action may fire: a well-formed PIN is required and no
 * submission may already be in flight. The dialog stays open on failure, so
 * a failed or cancelled attempt can never turn into a restart.
 */
export function canSubmitRestartInstall(pin: string, busy: boolean): boolean {
  return !busy && isValidManagerPinInput(pin);
}

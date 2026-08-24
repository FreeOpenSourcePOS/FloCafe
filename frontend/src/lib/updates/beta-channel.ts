/**
 * Pure helpers for the beta/pre-release update channel toggle (#463).
 *
 * The `updates:get-beta-channel` / `updates:set-beta-channel` IPC contract
 * is implemented by the main process and preload bindings. This module keeps
 * the renderer compatible with older builds that do not expose those methods.
 *
 * Everything here is deliberately tolerant of unknown result shapes so the
 * renderer can degrade safely when an older build or an unavailable IPC call
 * does not return the current response envelope.
 */

export interface BetaChannelApi {
  getBetaChannel?: () => Promise<unknown>;
  setBetaChannel?: (enabled: boolean) => Promise<unknown>;
}

/** True only when BOTH sides of the contract are callable on the exposed API. */
export function betaChannelApiSupported(api: BetaChannelApi | null | undefined): boolean {
  return typeof api?.getBetaChannel === 'function'
    && typeof api?.setBetaChannel === 'function';
}

/**
 * Coerce a get/set payload into a tri-state: true/false when a boolean is
 * recoverable, null when the value is missing or malformed (callers treat
 * null as "unsupported" and fall back to the disabled UI).
 */
export function normalizeBetaChannelValue(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if ('enabled' in record) return normalizeBetaChannelValue(record.enabled);
    if ('success' in record && record.success === false) return null;
    if ('error' in record) return null;
  }
  return null;
}

export interface WriteBetaChannelResult {
  ok: boolean;
  /** New persisted state when known; null when the response was unusable. */
  enabled: boolean | null;
  error?: string;
}

/** Normalize a set-beta-channel response into an optimistic-update decision. */
export function normalizeBetaChannelWriteResult(raw: unknown, requested: boolean): WriteBetaChannelResult {
  if (raw === undefined) {
    // Legacy void resolution: assume the request landed with the asked-for value.
    return { ok: true, enabled: requested };
  }
  if (typeof raw !== 'object') {
    return { ok: false, enabled: null, error: String(raw) };
  }
  const record = raw as Record<string, unknown>;
  if (record.success === false) {
    const error = typeof record.error === 'string' && record.error.length > 0
      ? record.error
      : undefined;
    return { ok: false, enabled: null, error };
  }
  const enabled = 'enabled' in record ? normalizeBetaChannelValue(record.enabled) : requested;
  return { ok: true, enabled: enabled ?? requested };
}

export interface ReadBetaChannelResult {
  supported: boolean;
  enabled: boolean | null;
}

/** Read the current channel state; unsupported/unreadable APIs report supported=false. */
export async function readBetaChannelState(api: BetaChannelApi | null | undefined): Promise<ReadBetaChannelResult> {
  if (!betaChannelApiSupported(api)) return { supported: false, enabled: null };
  try {
    const enabled = normalizeBetaChannelValue(await api!.getBetaChannel!());
    return { supported: enabled !== null, enabled };
  } catch {
    return { supported: false, enabled: null };
  }
}

/**
 * Optimistic-update helper for the Settings toggle: returns the state to
 * render after the IPC call settles. Only a confirmed success moves the
 * toggle; failures keep the previously rendered value.
 */
export async function writeBetaChannelState(
  api: BetaChannelApi | null | undefined,
  enabled: boolean,
): Promise<WriteBetaChannelResult> {
  if (!betaChannelApiSupported(api)) {
    return { ok: false, enabled: null, error: 'beta-channel-unavailable' };
  }
  try {
    return normalizeBetaChannelWriteResult(await api!.setBetaChannel!(enabled), enabled);
  } catch (error) {
    return { ok: false, enabled: null, error: error instanceof Error ? error.message : String(error) };
  }
}

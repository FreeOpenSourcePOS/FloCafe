/**
 * Anonymous usage telemetry — independent of cloud sync (sends whether or
 * not this store has cloud sync configured, since it's a separate concern).
 * Opt-in: only sends once the user has consented, either at first-run setup
 * (`anonymous_data_consent`, see routes/auth.ts `/setup/initialize`) or
 * later via Settings > Privacy. See db.isTelemetryEnabled — no consent ever
 * given means this stays a no-op, including for installs that predate this
 * feature.
 *
 * anon_id is a random UUID persisted locally (see db.ensureTelemetryAnonId),
 * never a store id, device id, or anything else that ties back to a business.
 * See specs/floadmin.md § Anonymous telemetry for the endpoint contract.
 */

import { app } from 'electron';
import log from 'electron-log';
import { ensureTelemetryAnonId, isTelemetryEnabled, getSettingValue, upsertTelemetryLastPing } from '../db';

export const TELEMETRY_URL = 'https://telemetry.flopos.com/collect';

const REQUEST_TIMEOUT_MS = 8_000;
const DAILY_PING_INTERVAL_MS = 60 * 60_000; // check hourly, send at most once/24h
const DAILY_PING_MIN_GAP_MS = 24 * 60 * 60_000;

let dailyPingTimer: ReturnType<typeof setInterval> | null = null;

export async function sendEvent(eventType: string, payload?: Record<string, unknown>): Promise<void> {
  if (!isTelemetryEnabled()) return;

  try {
    const anonId = ensureTelemetryAnonId();
    await fetch(TELEMETRY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anon_id: anonId,
        app: 'flocafe',
        app_version: app.getVersion(),
        event_type: eventType,
        platform: process.platform,
        ...(payload ? { payload } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    // Telemetry must never disrupt the app or surface to the user.
    log.debug('[Flo] telemetry send failed (non-fatal):', e);
  }
}

function maybeSendDailyPing(): void {
  if (!isTelemetryEnabled()) return;

  const lastPingAt = getSettingValue('telemetry_last_ping_at');
  const elapsed = lastPingAt ? Date.now() - new Date(lastPingAt).getTime() : Infinity;
  if (elapsed < DAILY_PING_MIN_GAP_MS) return;

  void sendEvent('daily_ping').then(() => upsertTelemetryLastPing());
}

export const telemetry = {
  start(): void {
    void sendEvent('app_launch');
    maybeSendDailyPing();
    dailyPingTimer = setInterval(maybeSendDailyPing, DAILY_PING_INTERVAL_MS);
  },
  stop(): void {
    if (dailyPingTimer) {
      clearInterval(dailyPingTimer);
      dailyPingTimer = null;
    }
  },
};

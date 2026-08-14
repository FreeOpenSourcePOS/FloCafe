/**
 * Anonymous usage telemetry — independent of cloud sync (sends whether or
 * not this store has cloud sync configured, since it's a separate concern).
 * Enabled by default for new installs. The owner can switch it off at any
 * time in Settings > Privacy. Tier 2 store diagnostics is a separate,
 * explicit opt-in and is never bundled into this stream.
 *
 * anon_id is a random UUID persisted locally (see db.ensureTelemetryAnonId),
 * never a store id, device id, or anything else that ties back to a business.
 * See specs/floadmin.md § Anonymous telemetry for the endpoint contract.
 */

import { app } from 'electron';
import log from 'electron-log';
import { ensureTelemetryAnonId, isTelemetryEnabled, getSettingValue, parseDbTimestamp, upsertTelemetryLastPing } from '../db';

export const TELEMETRY_URL = 'https://telemetry.flopos.com/collect';

const REQUEST_TIMEOUT_MS = 8_000;
const DAILY_PING_INTERVAL_MS = 60 * 60_000; // check hourly, send at most once/24h
const DAILY_PING_MIN_GAP_MS = 24 * 60 * 60_000;

let dailyPingTimer: ReturnType<typeof setInterval> | null = null;
let telemetryStopping = false;
let telemetryStopPromise: Promise<void> | null = null;
const inFlightTelemetry = new Set<Promise<unknown>>();

function trackTelemetry<T>(operation: Promise<T>): Promise<T> {
  inFlightTelemetry.add(operation);
  void operation.finally(() => inFlightTelemetry.delete(operation)).catch(() => {});
  return operation;
}

async function sendEventImpl(eventType: string, payload?: Record<string, unknown>): Promise<boolean> {
  if (!isTelemetryEnabled()) return false;

  try {
    const anonId = ensureTelemetryAnonId();
    const configuredCountry = (getSettingValue('country') || '').trim().toUpperCase();
    const country = /^[A-Z]{2}$/.test(configuredCountry) ? configuredCountry : undefined;
    const response = await fetch(TELEMETRY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anon_id: anonId,
        app: 'flocafe',
        app_version: app.getVersion(),
        event_type: eventType,
        platform: process.platform,
        ...(country ? { country } : {}),
        ...(payload ? { payload } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const ok = response.ok;
    if (!ok) {
      log.debug(`[Flo] telemetry rejected with HTTP ${response.status}`);
    }
    await response.body?.cancel().catch(() => {});
    return ok;
  } catch (e) {
    // Telemetry must never disrupt the app or surface to the user.
    log.debug('[Flo] telemetry send failed (non-fatal):', e);
    return false;
  }
}

export function sendEvent(eventType: string, payload?: Record<string, unknown>): Promise<boolean> {
  if (telemetryStopping) return Promise.resolve(false);
  return trackTelemetry(sendEventImpl(eventType, payload));
}

function maybeSendDailyPing(): void {
  if (telemetryStopping) return;
  if (!isTelemetryEnabled()) return;

  const lastPingAt = getSettingValue('telemetry_last_ping_at');
  const lastPingMs = lastPingAt ? parseDbTimestamp(lastPingAt).getTime() : NaN;
  const elapsed = isNaN(lastPingMs) ? Infinity : Date.now() - lastPingMs;
  if (elapsed < DAILY_PING_MIN_GAP_MS) return;

  const operation = sendEvent('daily_ping').then((sent) => {
    if (sent) upsertTelemetryLastPing();
  });
  trackTelemetry(operation);
}

export const telemetry = {
  start(): void {
    telemetryStopping = false;
    telemetryStopPromise = null;
    if (dailyPingTimer) {
      clearInterval(dailyPingTimer);
      dailyPingTimer = null;
    }
    void sendEvent('app_launch');
    maybeSendDailyPing();
    dailyPingTimer = setInterval(maybeSendDailyPing, DAILY_PING_INTERVAL_MS);
  },
  stop(): Promise<void> {
    if (telemetryStopPromise) return telemetryStopPromise;
    telemetryStopping = true;
    if (dailyPingTimer) {
      clearInterval(dailyPingTimer);
      dailyPingTimer = null;
    }
    telemetryStopPromise = Promise.allSettled([...inFlightTelemetry]).then(() => undefined);
    return telemetryStopPromise;
  },
};

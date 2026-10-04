/** Anonymous usage telemetry using a randomized local UUID, independent of cloud sync. */

import { app } from 'electron';
import * as fs from 'fs';
import { readCountryProvenance } from './country-provenance';
import log from 'electron-log';
import { ensureTelemetryAnonId, isTelemetryEnabled, getSettingValue, parseDbTimestamp, upsertTelemetryLastPing } from '../db';
import { normalizeSupportedCurrencyCode } from '../../shared/currencies';

export const TELEMETRY_URL = 'https://telemetry.flopos.com/collect';

/** How this instance was launched, so a merchant install is distinguishable from a developer's run. */
export type RunMode = 'packaged' | 'dev';

/**
 * Where the running binary came from. `linux_package` is the honest fallback for
 * a native Linux install whose distro is unreadable or unrecognised, so an
 * unknown distribution is never reported as `deb` or `rpm`.
 */
export type InstallSource =
  | 'github'
  | 'ms_store'
  | 'mac_app_store'
  | 'snap'
  | 'appimage'
  | 'flatpak'
  | 'deb'
  | 'rpm'
  | 'linux_package'
  | 'dev';

const REQUEST_TIMEOUT_MS = 8_000;
const DAILY_PING_INTERVAL_MS = 60 * 60_000; // check hourly, send at most once/24h
const DAILY_PING_MIN_GAP_MS = 24 * 60 * 60_000;

let dailyPingTimer: ReturnType<typeof setInterval> | null = null;
let telemetryStopping = false;
let telemetryStopPromise: Promise<void> | null = null;
const inFlightTelemetry = new Set<Promise<unknown>>();

/**
 * Resolves Electron's `app` without assuming an Electron runtime. This module is
 * imported by unit tests and scripts where `electron` resolves to a path string
 * or is missing entirely, so an unguarded `app.isPackaged` would throw. Any
 * failure degrades to a dev-mode report instead of breaking the import.
 */
function electronApp(): typeof app | undefined {
  try {
    const electronModule = require('electron') as { app?: typeof app } | undefined;
    return electronModule?.app;
  } catch {
    return undefined;
  }
}

function isPackagedRun(): boolean {
  return electronApp()?.isPackaged === true;
}

function envFlag(name: string): boolean {
  return String(process.env[name] ?? '').trim() !== '';
}

/** The distro families each native Linux package format belongs to. */
const DEBIAN_FAMILY = ['debian', 'ubuntu'];
const RPM_FAMILY = ['rhel', 'fedora', 'suse'];

/**
 * Maps `/etc/os-release` contents to a native Linux package format. `ID` is
 * authoritative; `ID_LIKE` carries the parent families, which is how a
 * derivative such as Rocky Linux or Linux Mint still resolves. Anything else
 * reports `linux_package` rather than a guess.
 */
export function linuxPackageFromOsRelease(contents: string): 'deb' | 'rpm' | 'linux_package' {
  const fields = new Map<string, string>();
  for (const line of contents.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/m.exec(line.trim());
    if (match) fields.set(match[1].toLowerCase(), match[2].trim().replace(/^"(.*)"$/, '$1'));
  }
  const families = [fields.get('id'), ...String(fields.get('id_like') ?? '').split(/\s+/)]
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean);
  if (families.some((id) => DEBIAN_FAMILY.includes(id))) return 'deb';
  if (families.some((id) => RPM_FAMILY.includes(id))) return 'rpm';
  return 'linux_package';
}

function linuxPackageFormat(): 'deb' | 'rpm' | 'linux_package' {
  try {
    return linuxPackageFromOsRelease(fs.readFileSync('/etc/os-release', 'utf8'));
  } catch {
    return 'linux_package';
  }
}

/** `packaged` for a real merchant install, `dev` for `npm run dev` and non-Electron hosts. */
export function getRunMode(): RunMode {
  return isPackagedRun() ? 'packaged' : 'dev';
}

/** Classifies the distribution channel the running binary was installed from. */
export function getInstallSource(): InstallSource {
  if (!isPackagedRun()) return 'dev';
  if (process.windowsStore) return 'ms_store';
  if (process.mas) return 'mac_app_store';
  if (envFlag('SNAP')) return 'snap';
  if (envFlag('APPIMAGE')) return 'appimage';
  if (envFlag('FLATPAK_ID')) return 'flatpak';
  if (process.platform === 'win32' || process.platform === 'darwin') return 'github';
  return linuxPackageFormat();
}

function matrixOffline(): boolean {
  return process.env.FLO_MATRIX_OFFLINE === '1';
}

function trackTelemetry<T>(operation: Promise<T>): Promise<T> {
  inFlightTelemetry.add(operation);
  void operation.finally(() => inFlightTelemetry.delete(operation)).catch(() => {});
  return operation;
}

async function sendEventImpl(eventType: string, payload?: Record<string, unknown>): Promise<boolean> {
  if (matrixOffline() || !isTelemetryEnabled()) return false;

  try {
    const anonId = ensureTelemetryAnonId();
    // Report only user-confirmed country so FloAdmin IP geolocation fallback can operate.
    const provenance = readCountryProvenance();
    const country = provenance.country ?? undefined;
    const currency = normalizeSupportedCurrencyCode(getSettingValue('currency')) ?? undefined;
    const response = await fetch(TELEMETRY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anon_id: anonId,
        app: 'flocafe',
        app_version: app.getVersion(),
        event_type: eventType,
        platform: process.platform,
        run_mode: getRunMode(),
        install_source: getInstallSource(),
        ...(country ? { country } : {}),
        ...(currency ? { currency } : {}),
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
  if (matrixOffline() || telemetryStopping) return Promise.resolve(false);
  return trackTelemetry(sendEventImpl(eventType, payload));
}

function maybeSendDailyPing(): void {
  if (matrixOffline() || telemetryStopping) return;
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
    if (matrixOffline()) return;
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

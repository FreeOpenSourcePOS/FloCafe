/** Anonymous usage telemetry using a randomized local UUID, independent of cloud sync. */

import { app } from 'electron';
import * as fs from 'fs';
import { readCountryProvenance } from './country-provenance';
import log from 'electron-log';
import {
  ensureTelemetryAnonId,
  isDiagnosticsConsentEnabled,
  isDiagnosticsTransmissionEnabled,
  isTelemetryEnabled,
  getSettingValue,
  parseDbTimestamp,
  upsertTelemetryLastPing,
} from '../db';
import { normalizeSupportedCurrencyCode } from '../../shared/currencies';
import { isOperationReference, serializeOperationFailure } from '../lib/operation-failure';
import { getBuildIdentity } from './build-identity';

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
const DIAGNOSTIC_REPORT_KEYS =
  'app_build,app_version,capture_point,classification,count,examples,facts,first_occurred_at,last_occurred_at,operation,outcome,platform,reason_code,report_id,schema_version,stage,window_start';
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
    .map((value) =>
      String(value ?? '')
        .trim()
        .toLowerCase(),
    )
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

export function isTelemetrySuppressed(): boolean {
  if (
    process.env.FLO_MATRIX_OFFLINE === '1' ||
    Boolean(process.env.E2E_TASK_LOCAL_PORTS) ||
    process.env.FLO_E2E_SKIP_OPTIONAL_NETWORK === '1'
  ) {
    return true;
  }
  if (process.env.FLO_TELEMETRY_DEV === '1') {
    return false;
  }
  const version = typeof app?.getVersion === 'function' ? app.getVersion() : '';
  if (
    version === '1.0.0-test' ||
    version === 'test' ||
    version === 'e2e' ||
    /(?:^|[-.])(?:test|e2e)(?:[-.]|$)/i.test(version)
  ) {
    return true;
  }
  const isDev = !app?.isPackaged || getBuildIdentity() === 'dev';
  if (isDev) return true;
  return false;
}

function matrixOffline(): boolean {
  return isTelemetrySuppressed();
}

function trackTelemetry<T>(operation: Promise<T>): Promise<T> {
  inFlightTelemetry.add(operation);
  void operation.finally(() => inFlightTelemetry.delete(operation)).catch(() => {});
  return operation;
}

async function sendEventImpl(
  eventType: string,
  payload?: Record<string, unknown>,
): Promise<boolean> {
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

/** PostHog receives the same usage events; required lazily because posthog.ts imports this module. */
function mirrorToPostHog(eventType: string, payload?: Record<string, unknown>): void {
  if (eventType !== 'app_launch' && eventType !== 'feature_used') return;
  try {
    (require('./posthog') as typeof import('./posthog')).capturePostHogUsage(eventType, payload);
  } catch {
    // PostHog is optional and never disrupts the collector.
  }
}

/** PostHog's daily ping and milestones run on this timer but never wait on the collector. */
function runPostHogDailyChecks(): void {
  if (matrixOffline() || telemetryStopping) return;
  try {
    (require('./posthog') as typeof import('./posthog')).runPostHogDailyChecks();
  } catch {
    // PostHog is optional.
  }
}

export function sendEvent(eventType: string, payload?: Record<string, unknown>): Promise<boolean> {
  if (matrixOffline() || telemetryStopping) return Promise.resolve(false);
  mirrorToPostHog(eventType, payload);
  return trackTelemetry(sendEventImpl(eventType, payload));
}

export type AnonymousDiagnosticDisposition =
  | 'accepted'
  | 'duplicate'
  | 'rejected'
  | 'invalid_ack'
  | 'report_id_mismatch'
  | 'network_error';
export type AnonymousDiagnosticResult = {
  disposition: AnonymousDiagnosticDisposition;
  retry_after_ms?: number;
};

function anonymousRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  const delay =
    Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? Math.min(60 * 60_000, delay) : undefined;
}

function safeAnonymousDiagnosticProjection(
  report: Record<string, unknown>,
): Record<string, unknown> | null {
  if (
    Object.keys(report).sort().join(',') !== DIAGNOSTIC_REPORT_KEYS ||
    report.schema_version !== 2 ||
    !isOperationReference(report.report_id) ||
    !Number.isSafeInteger(report.count) ||
    (report.count as number) < 1 ||
    (report.count as number) > 100_000 ||
    !Array.isArray(report.examples) ||
    report.examples.length > 3 ||
    report.examples.some(
      (value) =>
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).join(',') !== 'correlation_id' ||
        !isOperationReference((value as Record<string, unknown>).correlation_id),
    )
  )
    return null;
  const failure = serializeOperationFailure({
    capture_point: report.capture_point,
    outcome: report.outcome,
    facts: report.facts,
  });
  if (
    !failure ||
    failure.reason_code !== report.reason_code ||
    failure.classification !== report.classification ||
    failure.operation !== report.operation ||
    failure.stage !== report.stage
  )
    return null;
  const timestamp = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
  if (
    !timestamp(report.window_start) ||
    !timestamp(report.first_occurred_at) ||
    !timestamp(report.last_occurred_at)
  )
    return null;
  const window = Date.parse(report.window_start as string);
  const first = Date.parse(report.first_occurred_at as string);
  const last = Date.parse(report.last_occurred_at as string);
  if (
    new Date(window).toISOString().replace(/\.\d{3}Z$/, 'Z') !== report.window_start ||
    new Date(window).getUTCMinutes() !== 0 ||
    new Date(window).getUTCSeconds() !== 0 ||
    Math.floor(first / 3_600_000) !== Math.floor(window / 3_600_000) ||
    Math.floor(last / 3_600_000) !== Math.floor(window / 3_600_000) ||
    first > last
  )
    return null;
  for (const key of ['app_version', 'app_build'] as const) {
    if (typeof report[key] !== 'string' || !/^[A-Za-z0-9._:+-]{1,64}$/.test(report[key] as string))
      return null;
  }
  if (
    typeof report.platform !== 'string' ||
    !['win32', 'darwin', 'linux', 'unknown'].includes(report.platform)
  )
    return null;
  return {
    schema_version: 2,
    report_id: report.report_id,
    reason_code: failure.reason_code,
    classification: failure.classification,
    operation: failure.operation,
    stage: failure.stage,
    outcome: failure.outcome,
    capture_point: failure.capture_point,
    count: report.count,
    window_start: report.window_start,
    first_occurred_at: report.first_occurred_at,
    last_occurred_at: report.last_occurred_at,
    app_version: report.app_version,
    app_build: report.app_build,
    platform: report.platform,
    facts: failure.facts,
  };
}

/** Sends a store-unlinked count report through the existing anonymous collector. */
export async function sendAnonymousDiagnosticReport(
  report: Record<string, unknown>,
): Promise<AnonymousDiagnosticResult> {
  if (
    matrixOffline() ||
    telemetryStopping ||
    !isTelemetryEnabled() ||
    !isDiagnosticsConsentEnabled() ||
    !isDiagnosticsTransmissionEnabled()
  )
    return { disposition: 'network_error' };
  const safeReport = safeAnonymousDiagnosticProjection(report);
  if (!safeReport) return { disposition: 'invalid_ack' };

  try {
    const anonId = ensureTelemetryAnonId();
    const build = getBuildIdentity();
    const response = await fetch(TELEMETRY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anon_id: anonId,
        app: 'flocafe',
        app_version: app.getVersion(),
        app_build: build,
        event_type: 'diagnostic_counts',
        platform: process.platform,
        run_mode: getRunMode(),
        install_source: getInstallSource(),
        payload: { schema_version: 2, report: safeReport },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const ack = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    await response.body?.cancel().catch(() => {});
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return {
        disposition: 'network_error',
        retry_after_ms: anonymousRetryAfterMs(response.headers.get('retry-after')),
      };
    }
    const reportId = safeReport.report_id;
    if (ack && isOperationReference(ack.report_id) && ack.report_id !== reportId)
      return { disposition: 'report_id_mismatch' };
    if (
      !ack ||
      Object.keys(ack).sort().join(',') !== 'disposition,report_id,schema_version' ||
      ack.schema_version !== 2 ||
      !isOperationReference(ack.report_id) ||
      ack.report_id !== reportId
    )
      return { disposition: 'invalid_ack' };
    if (response.ok && (ack.disposition === 'accepted' || ack.disposition === 'duplicate'))
      return { disposition: ack.disposition };
    if (response.status === 422 && ack.disposition === 'rejected')
      return { disposition: 'rejected' };
    return { disposition: 'invalid_ack' };
  } catch {
    return { disposition: 'network_error' };
  }
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
    runPostHogDailyChecks();
    dailyPingTimer = setInterval(() => {
      maybeSendDailyPing();
      runPostHogDailyChecks();
    }, DAILY_PING_INTERVAL_MS);
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

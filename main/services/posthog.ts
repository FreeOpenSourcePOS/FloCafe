/**
 * PostHog beside the existing collector. Usage follows the sharing level in posthog-identity.ts;
 * nothing is sent without a project token (posthog-config.ts) or outside official releases.
 */

import type { NextFunction, Request, Response } from 'express';
import * as os from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  getDatabase,
  getSettingValue,
  getSettingsRevision,
  now,
  upsertSettings,
  isDiagnosticsTransmissionEnabled,
} from '../db';
import {
  postHogEnvironment,
  postHogNetworkSuppressed,
  readPostHogConfig,
  type PostHogConfig,
  type PostHogEnvironment,
} from './posthog-config';
import { getOfflineModeAbortSignal, onOfflineModeEnabled } from './offline-mode';
import { isOperationReference } from '../lib/operation-failure';
import { readCountryProvenance } from './country-provenance';
import { getInstallSource, getRunMode } from './telemetry';
import {
  getRequestStats,
  runWithRequestStats,
  slowRequestEventGate,
  type SlowRequestRouteState,
} from './db-timing';
import {
  markAliased,
  pendingAlias,
  productAnalyticsChoicePending,
  readProductAnalyticsLevel,
  resolvePostHogIdentity,
  type PostHogIdentity,
  type ProductAnalyticsLevel,
} from './posthog-identity';
import { normalizeSupportedCurrencyCode } from '../../shared/currencies';
import { scrubPrinterErrorText } from '../../shared/printer-error-text';
import {
  isPostHogCapturePoint,
  redactExceptionMessage,
  sanitizeErrorName,
  scrubPostHogEvent,
  stackFrameLines,
  type ExceptionContext,
  type PostHogCapturePoint,
  type PostHogUsageEvent,
  type ScrubbableEvent,
} from '../../shared/posthog-scrub';

interface PostHogClient {
  capture: (payload: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
  }) => void;
  captureException: (
    error: Error,
    distinctId?: string,
    additionalProperties?: Record<string, unknown>,
  ) => void;
  alias: (payload: { distinctId: string; alias: string }) => void;
  shutdown: (shutdownTimeoutMs?: number) => Promise<void>;
}

// Well under SHUTDOWN_TIMEOUT_MS: a timed-out cleanup step aborts the rest, database close included.
export const POSTHOG_SHUTDOWN_TIMEOUT_MS = 2_000;

export interface SuperProperties {
  app_version: string;
  platform: string;
  run_mode: string;
  install_source: string;
  environment: string;
  release_channel: string;
  install_ref?: string;
  store_ref?: string;
}

export interface PostHogBootstrap {
  enabled: false;
}

export interface PostHogBootstrapReady {
  enabled: true;
  distinctId: string;
  identified: boolean;
  token: string;
  host: string;
  telemetryEnabled: boolean;
  accountLinked: boolean;
  diagnosticsEnabled: boolean;
  superProperties: SuperProperties;
}

let client: PostHogClient | null = null;
let clientKey: string | null = null;
let clientAbort: AbortController | null = null;

onOfflineModeEnabled(() => {
  invalidatePostHogConsentCache();
  if (client) void stopPostHog({ flush: false });
});

function appVersion(): string {
  try {
    const version = (
      require('electron') as { app?: { getVersion?: () => string } }
    ).app?.getVersion?.();
    if (typeof version === 'string' && version) return version;
  } catch {
    // Outside Electron.
  }
  return (require('../../package.json') as { version: string }).version;
}

const CONSENT_CACHE_TTL_MS = 30_000;
/** One `api-5xx` exception per method, route, and status, so a polling route cannot flood a plan. */
const API_FAILURE_WINDOW_MS = 60 * 60_000;
/** Cloud routes fail for every store without a cloud subscription, and the sidebar polls them. */
const CLOUD_ROUTE_PREFIX = '/api/settings/cloud';
/** These answer 502 or 503 when a remote host is unreachable, which is normal while offline. */
const OFFLINE_GATEWAY_ROUTES = ['/api/products/fetch-url', '/api/mobile/devices'];
const apiFailureSentAt = new Map<string, number>();
/** Reports already sent, so a delivery retry does not send the same window twice. */
const sentOperationReports = new Set<string>();

interface CachedConsentState {
  level: ProductAnalyticsLevel;
  identity: PostHogIdentity;
  config: PostHogConfig | null;
  diagnosticsEnabled: boolean;
  environment: PostHogEnvironment | null;
  envKey: string;
  revision: number;
  expiresAt: number;
}

let cachedConsent: CachedConsentState | null = null;

export function invalidatePostHogConsentCache(): void {
  cachedConsent = null;
}

function getEnvCacheKey(): string {
  return `${process.env.CI ?? ''}|${process.env.FLO_MATRIX_OFFLINE ?? ''}|${process.env.E2E_TASK_LOCAL_PORTS ?? ''}|${process.env.NODE_ENV ?? ''}|${process.env.FLO_E2E_SKIP_OPTIONAL_NETWORK ?? ''}|${(process as NodeJS.Process & { type?: string }).type ?? ''}|${process.env.FLO_POSTHOG_DEV ?? ''}|${process.env.FLO_POSTHOG_DEV_TOKEN ?? ''}|${process.env.FLO_POSTHOG_DEV_HOST ?? ''}`;
}

function getConsentState(): CachedConsentState {
  const nowMs = Date.now();
  const revision = getSettingsRevision();
  const envKey = getEnvCacheKey();
  if (
    cachedConsent &&
    cachedConsent.expiresAt > nowMs &&
    cachedConsent.revision === revision &&
    cachedConsent.envKey === envKey
  ) {
    return cachedConsent;
  }
  const level = readProductAnalyticsLevel();
  const resolvedIdentity = resolvePostHogIdentity(level);
  const config = readPostHogConfig();
  const diagnosticsEnabled = isDiagnosticsTransmissionEnabled();
  const environment = postHogEnvironment();
  cachedConsent = {
    level,
    identity: resolvedIdentity,
    config,
    diagnosticsEnabled,
    environment,
    envKey,
    revision: getSettingsRevision(),
    expiresAt: nowMs + CONSENT_CACHE_TTL_MS,
  };
  return cachedConsent;
}

function usageEnabled(): boolean {
  return getConsentState().level !== 'off';
}

function identity(): PostHogIdentity {
  return getConsentState().identity;
}

/** Release and channel, plus the device and, at the `full` level, the account (`store_ref`). */
export function readSuperProperties(current: PostHogIdentity = identity()): SuperProperties {
  return {
    app_version: appVersion(),
    platform: process.platform,
    run_mode: getRunMode(),
    install_source: getInstallSource(),
    environment: getConsentState().environment ?? 'development',
    release_channel: /-beta\b/.test(appVersion()) ? 'beta' : 'stable',
    ...(current.installRef ? { install_ref: current.installRef } : {}),
    ...(current.accountRef ? { store_ref: current.accountRef } : {}),
  };
}

/** macOS 15.6, not the Darwin kernel 24.6.0 that `os.release()` gives. */
function osVersion(): string {
  return typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : os.release();
}

/** The OS names PostHog reports, from the Node platform. */
const OS_NAMES: Record<string, string> = {
  darwin: 'Mac OS X',
  win32: 'Windows',
  linux: 'Linux',
};

let cachedExceptionContext: ExceptionContext | undefined;

/** Release, OS, install source, and process: an exception must carry them even if it arrived bare. */
function exceptionContext(): ExceptionContext {
  // Fixed for the life of the process; on Linux the install source reads /etc/os-release.
  return (cachedExceptionContext ??= {
    app_version: appVersion(),
    platform: process.platform,
    install_source: getInstallSource(),
    process_type: 'main',
    ...readOsProperties(),
  });
}

/** The OS PostHog reports, from the Node platform. */
export function readOsProperties(): { $os: string; $os_version: string } {
  return {
    $os: OS_NAMES[process.platform] ?? process.platform,
    $os_version: osVersion(),
  };
}

function emailField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 320 || /\s/.test(trimmed) || !trimmed.includes('@')) {
    return undefined;
  }
  return trimmed;
}

/**
 * The store email cloud registration already sends, falling back to the account setup created.
 * Names are never sent.
 */
export function readInstallationEmail(): string | undefined {
  const store = emailField(getSettingValue('email'));
  if (store) return store;
  const row = getDatabase().prepare('SELECT email FROM users ORDER BY rowid ASC LIMIT 1').get() as
    | { email?: string | null }
    | undefined;
  return emailField(row?.email);
}

function readStoreProperties(): Record<string, string | boolean> {
  const properties: Record<string, string | boolean> = {};
  const country = readCountryProvenance().country;
  if (country) properties.country = country;
  const currency = normalizeSupportedCurrencyCode(getSettingValue('currency'));
  if (currency) properties.currency = currency;
  const language = getSettingValue('language');
  if (language) properties.language = language;
  const serviceModel = getSettingValue('service_model');
  if (serviceModel) properties.service_model = serviceModel;
  const kds = getSettingValue('kds_enabled');
  if (kds !== null) properties.kds_enabled = kds === 'true' || kds === '1';
  return properties;
}

/** Store configuration on the person, and the installation email at the `full` level only. */
export function readPersonProperties(): Record<string, string | boolean> | undefined {
  const level = readProductAnalyticsLevel();
  if (level === 'off') return undefined;
  const email = level === 'full' ? readInstallationEmail() : undefined;
  return {
    ...readStoreProperties(),
    ...readSuperProperties(),
    ...(email ? { email } : {}),
  };
}

function count(sql: string): number | undefined {
  try {
    const row = getDatabase().prepare(sql).get() as { n?: number } | undefined;
    return typeof row?.n === 'number' ? row.n : undefined;
  } catch {
    return undefined;
  }
}

/** Counts only: how much this store used FloCafe in the last 24 hours, and how it is set up. */
export function readDailyUsageSummary(): Record<string, number | boolean | string> {
  const day = "datetime('now', '-1 day')";
  const counts: Record<string, number | undefined> = {
    orders_24h: count(`SELECT COUNT(*) AS n FROM orders WHERE created_at >= ${day}`),
    orders_dine_in_24h: count(
      `SELECT COUNT(*) AS n FROM orders WHERE created_at >= ${day} AND type = 'dine_in'`,
    ),
    orders_takeaway_24h: count(
      `SELECT COUNT(*) AS n FROM orders WHERE created_at >= ${day} AND type = 'takeaway'`,
    ),
    orders_delivery_24h: count(
      `SELECT COUNT(*) AS n FROM orders WHERE created_at >= ${day} AND type = 'delivery'`,
    ),
    orders_online_24h: count(
      `SELECT COUNT(*) AS n FROM orders WHERE created_at >= ${day} AND type = 'online'`,
    ),
    orders_cancelled_24h: count(
      `SELECT COUNT(*) AS n FROM orders WHERE created_at >= ${day} AND status = 'cancelled'`,
    ),
    bills_paid_24h: count(`SELECT COUNT(*) AS n FROM bills WHERE paid_at >= ${day}`),
    staff_with_orders_24h: count(
      `SELECT COUNT(DISTINCT user_id) AS n FROM orders WHERE created_at >= ${day}`,
    ),
    active_staff_count: count('SELECT COUNT(*) AS n FROM users WHERE is_active = 1'),
    products_count: count('SELECT COUNT(*) AS n FROM products'),
    tables_count: count('SELECT COUNT(*) AS n FROM tables'),
    customers_count: count('SELECT COUNT(*) AS n FROM customers'),
    printers_count: count('SELECT COUNT(*) AS n FROM printers'),
    kitchen_stations_count: count('SELECT COUNT(*) AS n FROM kitchen_stations'),
  };
  const summary: Record<string, number | boolean | string> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (value !== undefined) summary[key] = value;
  }
  return { ...summary, ...readStoreProperties() };
}

function createClient(token: string, host: string, abortSignal: AbortSignal): PostHogClient {
  const { PostHog } = require('posthog-node') as {
    PostHog: new (projectToken: string, options: Record<string, unknown>) => PostHogClient;
  };
  return new PostHog(token, {
    host,
    isServer: false,
    // Store-level location (country, city) for regional analysis; the SDK defaults it off.
    disableGeoip: false,
    enableLocalEvaluation: false,
    flushAt: 1,
    flushInterval: 0,
    fetch: async (url: string, options?: RequestInit) => {
      if (abortSignal.aborted || postHogNetworkSuppressed()) {
        return new Response(null, { status: 204 });
      }
      const signals: AbortSignal[] = [abortSignal, getOfflineModeAbortSignal()];
      if (options?.signal) signals.push(options.signal);
      try {
        return await globalThis.fetch(url, { ...options, signal: AbortSignal.any(signals) });
      } catch (error) {
        if (abortSignal.aborted || postHogNetworkSuppressed()) {
          return new Response(null, { status: 204 });
        }
        throw error;
      }
    },
    before_send: (event: ScrubbableEvent | null) => {
      const { level, diagnosticsEnabled, environment } = getConsentState();
      if (abortSignal.aborted || environment === null) return null;
      return scrubPostHogEvent(event, {
        telemetryEnabled: level !== 'off',
        accountLinked: level === 'full',
        allowExceptions: diagnosticsEnabled,
        exceptionContext: exceptionContext(),
      });
    },
  });
}

function activeClient(): PostHogClient | null {
  const { config, level, diagnosticsEnabled, environment } = getConsentState();
  if (environment === null) return null;
  if (!config) return null;
  if (level === 'off' && !diagnosticsEnabled) return null;
  const key = `${config.host}\n${config.token}`;
  if (client && clientKey === key) return client;
  const previous = client;
  const previousAbort = clientAbort;
  const nextAbort = new AbortController();
  client = createClient(config.token, config.host, nextAbort.signal);
  clientKey = key;
  clientAbort = nextAbort;
  previousAbort?.abort();
  if (previous) void previous.shutdown(POSTHOG_SHUTDOWN_TIMEOUT_MS).catch(() => {});
  return client;
}

/** The sharing level for Settings and the one-time question, asked only where PostHog can send. */
export function readProductAnalyticsChoice() {
  invalidatePostHogConsentCache();
  return {
    level: readProductAnalyticsLevel(),
    choice_pending:
      productAnalyticsChoicePending() &&
      !postHogNetworkSuppressed() &&
      readPostHogConfig() !== null,
    email: readInstallationEmail() ?? null,
    diagnostics_enabled: isDiagnosticsTransmissionEnabled(),
  };
}

export function readPostHogBootstrap(): PostHogBootstrap | PostHogBootstrapReady {
  invalidatePostHogConsentCache();
  if (postHogNetworkSuppressed()) return { enabled: false };
  const config = readPostHogConfig();
  if (!config) return { enabled: false };
  const level = readProductAnalyticsLevel();
  const telemetryEnabled = level !== 'off';
  const diagnosticsEnabled = isDiagnosticsTransmissionEnabled();
  if (!telemetryEnabled && !diagnosticsEnabled) return { enabled: false };
  const current = resolvePostHogIdentity(level);
  return {
    enabled: true,
    distinctId: current.distinctId,
    // At `anonymous` main has created the device person, so renderer events join it.
    identified: current.identified || level === 'anonymous',
    token: config.token,
    host: config.host,
    telemetryEnabled,
    accountLinked: level === 'full',
    diagnosticsEnabled,
    superProperties: readSuperProperties(current),
  };
}

/**
 * Updates the person for the current level: the account with the device folded into it, or the
 * anonymous device. Safe to call when PostHog is not configured.
 */
export function syncPostHogIdentity(): void {
  try {
    invalidatePostHogConsentCache();
    if (postHogNetworkSuppressed() || !readPostHogConfig()) {
      if (client) void stopPostHog({ flush: false });
      return;
    }
    if (!usageEnabled() && !getConsentState().diagnosticsEnabled) {
      void stopPostHog({ flush: false });
      return;
    }
    if (!usageEnabled()) return;
    const current = activeClient();
    if (!current) return;
    const who = identity();
    const device = who.identified ? pendingAlias(who) : null;
    if (device) {
      current.alias({ distinctId: who.distinctId, alias: device });
      markAliased(who);
    }
    const person = readPersonProperties();
    current.capture({
      distinctId: who.distinctId,
      event: who.identified ? '$identify' : '$set',
      properties: person ? { $set: person } : {},
    });
  } catch {
    // A failed PostHog send is dropped. There is no outbox.
  }
}

/** Mirrors a usage event the collector also receives. Dropped at the `off` level. */
export function capturePostHogUsage(
  event: PostHogUsageEvent,
  properties?: Record<string, unknown>,
): void {
  try {
    if (!usageEnabled()) return;
    const current = activeClient();
    if (!current) return;
    const who = identity();
    current.capture({
      distinctId: who.distinctId,
      event,
      properties: { ...readSuperProperties(who), ...(properties ?? {}) },
    });
  } catch {
    // A failed PostHog send is dropped. There is no outbox.
  }
}

const MILESTONES_SETTING = 'posthog_milestones_sent';
const MILESTONES_SINCE_SETTING = 'posthog_milestones_since';
const DAILY_PING_SETTING = 'posthog_last_daily_ping_at';
const DAILY_PING_MIN_GAP_MS = 24 * 60 * 60_000;

const MILESTONES: Array<{ event: 'first_order_created' | 'first_bill_paid'; sql: string }> = [
  { event: 'first_order_created', sql: 'SELECT MIN(created_at) AS at FROM orders' },
  { event: 'first_bill_paid', sql: 'SELECT MIN(paid_at) AS at FROM bills' },
];

function dbTimeMs(value: string | null | undefined): number {
  return value ? Date.parse(`${value.replace(' ', 'T')}Z`) : NaN;
}

function hoursBetween(from: string | undefined, to: string): number | undefined {
  const start = dbTimeMs(from);
  const end = dbTimeMs(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return Math.round(((end - start) / 3_600_000) * 10) / 10;
}

/**
 * First order and first payment, once per installation, read from the database. Milestones older
 * than this check (upgraded stores) are tagged `backfilled` to keep them out of live funnels.
 */
export function checkPostHogMilestones(): void {
  try {
    if (!usageEnabled() || !activeClient()) return;
    const db = getDatabase();
    let since = getSettingValue(MILESTONES_SINCE_SETTING);
    if (!since) {
      since = now();
      upsertSettings({ [MILESTONES_SINCE_SETTING]: since });
    }
    const sent = new Set((getSettingValue(MILESTONES_SETTING) ?? '').split(',').filter(Boolean));
    const setupAt = (
      db.prepare('SELECT created_at AS at FROM users ORDER BY rowid ASC LIMIT 1').get() as
        | { at?: string }
        | undefined
    )?.at;
    for (const milestone of MILESTONES) {
      if (sent.has(milestone.event)) continue;
      const at = (db.prepare(milestone.sql).get() as { at?: string | null } | undefined)?.at;
      if (!at) continue;
      const hours = hoursBetween(setupAt, at);
      capturePostHogUsage(milestone.event, {
        ...(hours === undefined ? {} : { hours_since_setup: hours }),
        ...(dbTimeMs(at) < dbTimeMs(since) ? { backfilled: true } : {}),
      });
      sent.add(milestone.event);
      upsertSettings({ [MILESTONES_SETTING]: [...sent].join(',') });
    }
  } catch {
    // Milestones are best-effort.
  }
}

/**
 * The 24h usage summary, at most once a day and independent of the collector. Best effort:
 * a ping the SDK cannot deliver is not resent.
 */
export function maybeSendPostHogDailyPing(nowMs: number = Date.now()): void {
  try {
    if (!usageEnabled() || !activeClient()) return;
    const last = dbTimeMs(getSettingValue(DAILY_PING_SETTING));
    if (Number.isFinite(last) && nowMs - last < DAILY_PING_MIN_GAP_MS) return;
    capturePostHogUsage('daily_ping', readDailyUsageSummary());
    upsertSettings({ [DAILY_PING_SETTING]: now() });
  } catch {
    // The daily ping is best-effort.
  }
}

/** Runs from the telemetry service's hourly check. */
export function runPostHogDailyChecks(): void {
  maybeSendPostHogDailyPing();
  checkPostHogMilestones();
}

export function startPostHog(): void {
  syncPostHogIdentity();
}

export async function stopPostHog(options?: { flush?: boolean }): Promise<void> {
  invalidatePostHogConsentCache();
  const current = client;
  const currentAbort = clientAbort;
  client = null;
  clientKey = null;
  clientAbort = null;
  if (!current) return;
  const suppressFlush = options?.flush === false || postHogNetworkSuppressed();
  if (suppressFlush) {
    currentAbort?.abort();
    const internal = current as unknown as { disabled?: boolean; queue?: unknown[] };
    internal.disabled = true;
    if (Array.isArray(internal.queue)) internal.queue.length = 0;
  }
  try {
    await current.shutdown(POSTHOG_SHUTDOWN_TIMEOUT_MS);
  } catch {
    // Drop a failed flush.
  }
}

/** A copy of the error whose message is redacted and whose stack carries only frame lines. */
function scrubbedError(input: unknown, depth = 0): Error {
  const record =
    input instanceof Error
      ? input
      : input && typeof input === 'object'
        ? (input as { name?: unknown; message?: unknown; stack?: unknown; cause?: unknown })
        : {};
  const stack = typeof record.stack === 'string' ? record.stack : undefined;
  const name = sanitizeErrorName(record.name, stack);
  // A rejection reason is often a plain string; keep it as the message instead of sending a blank.
  const message = redactExceptionMessage(typeof input === 'string' ? input : record.message);
  const error = new Error(message);
  error.name = name;
  error.stack = [message ? `${name}: ${message}` : name, ...stackFrameLines(stack)].join('\n');
  // A chained cause stays, scrubbed the same way. Two levels, so a self-referencing cause ends.
  if (depth < 2 && record.cause instanceof Error) {
    error.cause = scrubbedError(record.cause, depth + 1);
  }
  return error;
}

/** Returns whether the exception was handed to the client, so a caller's throttle starts only then. */
export function capturePostHogException(
  capturePoint: PostHogCapturePoint,
  input: unknown,
  properties?: Record<string, unknown>,
): boolean {
  try {
    if (!isPostHogCapturePoint(capturePoint)) return false;
    if (!getConsentState().diagnosticsEnabled) return false;
    const current = activeClient();
    if (!current) return false;
    const who = identity();
    current.captureException(scrubbedError(input), who.distinctId, {
      ...readSuperProperties(who),
      process_type: 'main',
      ...(who.identified || who.installRef ? {} : { $process_person_profile: false }),
      ...(properties ?? {}),
      capture_point: capturePoint,
    });
    return true;
  } catch {
    // A failed PostHog send is dropped. There is no outbox.
    return false;
  }
}

/** The facts a failed print job carries. No queue name, no host, no path. */
export interface PrintFailureFacts {
  kind: string;
  connection_type: string;
  failure_class: string;
  correlation_id?: string;
  detail?: string;
  /** Removed from the text before it is sent; the queue name itself never leaves the machine. */
  printer_name?: string;
}

/** Sends a failed print job while error sending is on. Make and model are not known here. */
export function capturePostHogPrintFailure(facts: PrintFailureFacts): void {
  try {
    if (!getConsentState().diagnosticsEnabled) return;
    const current = activeClient();
    if (!current) return;
    const who = identity();
    current.capture({
      distinctId: who.distinctId,
      event: 'printer_failed',
      properties: {
        ...readSuperProperties(who),
        ...readOsProperties(),
        process_type: 'main',
        ...(who.identified || who.installRef ? {} : { $process_person_profile: false }),
        capture_point: 'printer',
        kind: facts.kind,
        connection_type: facts.connection_type,
        failure_class: facts.failure_class,
        ...(facts.correlation_id ? { correlation_id: facts.correlation_id } : {}),
        ...(facts.detail
          ? { error_text: scrubPrinterErrorText(facts.detail, facts.printer_name) }
          : {}),
      },
    });
  } catch {
    // A failed PostHog send is dropped. There is no outbox.
  }
}

/**
 * Sends one sealed operation-failure report, while error sending is on. It carries only the
 * report's validated fields, never a correlation id, a message, or free text.
 */
export function capturePostHogOperationFailure(report: Record<string, unknown>): void {
  try {
    if (!getConsentState().diagnosticsEnabled) return;
    const capturePoint = report.capture_point;
    // Printer failures already leave as printer_failed from the printer capture point.
    if (typeof capturePoint !== 'string' || capturePoint.startsWith('fc.backend.printer.')) return;
    const current = activeClient();
    if (!current) return;
    const reportId = report.report_id;
    if (isOperationReference(reportId)) {
      if (sentOperationReports.has(reportId)) return;
      // Bounded, so a long run cannot grow the set without end.
      if (sentOperationReports.size >= 500) sentOperationReports.clear();
      sentOperationReports.add(reportId);
    }
    const lastOccurredAt = new Date(String(report.last_occurred_at ?? ''));
    const occurredAt = Number.isNaN(lastOccurredAt.getTime()) ? undefined : lastOccurredAt;
    const reportAppVersion =
      typeof report.app_version === 'string' && report.app_version.trim()
        ? report.app_version.trim()
        : undefined;
    const reportPlatform =
      typeof report.platform === 'string' && report.platform.trim()
        ? report.platform.trim()
        : undefined;
    const who = identity();
    current.capture({
      distinctId: who.distinctId,
      event: 'operation_failed',
      // The report id and its last occurrence keep a resend after a restart as one event.
      ...(isOperationReference(reportId) ? { uuid: reportId } : {}),
      ...(occurredAt ? { timestamp: occurredAt } : {}),
      properties: {
        ...readSuperProperties(who),
        ...(reportAppVersion
          ? {
              app_version: reportAppVersion,
              release_channel: /-beta\b/.test(reportAppVersion) ? 'beta' : 'stable',
            }
          : {}),
        ...(reportPlatform ? { platform: reportPlatform } : {}),
        process_type: 'main',
        ...(who.identified || who.installRef ? {} : { $process_person_profile: false }),
        capture_point: capturePoint,
        reason_code: report.reason_code,
        operation: report.operation,
        stage: report.stage,
        outcome: report.outcome,
        classification: report.classification,
        count: report.count,
        facts: report.facts,
      },
    });
  } catch {
    // A failed PostHog send is dropped. There is no outbox.
  }
}

/**
 * The matched route pattern, such as `/api/orders/:id`. Express resets `baseUrl` once an error
 * leaves its router, so the mount prefix is recovered from the request path instead.
 */
export function apiRoutePattern(originalUrl: string, routePath: unknown): string {
  if (typeof routePath !== 'string' || /[*{(]/.test(routePath)) return '<unmatched>';
  const pathSegments = originalUrl.split('?')[0].split('/').filter(Boolean);
  const routeSegments = routePath.split('/').filter(Boolean);
  if (routeSegments.length > pathSegments.length) return '<unmatched>';
  const prefix = pathSegments.slice(0, pathSegments.length - routeSegments.length);
  return `/${[...prefix, ...routeSegments].join('/')}`;
}

/**
 * A 5xx from the local API, keyed by method and route pattern. No params, query, or body. What it
 * failed on keeps its own type and frames; the message is the route pattern, because a route error
 * can name a customer.
 */
export function capturePostHogApiFailure(
  method: string,
  route: string,
  status: number,
  thrown?: unknown,
  sentStack?: string,
): void {
  if (route.startsWith(CLOUD_ROUTE_PREFIX)) return;
  if ((status === 502 || status === 503) && OFFLINE_GATEWAY_ROUTES.includes(route)) return;
  const key = `${method} ${route} ${status}`;
  const at = Date.now();
  const last = apiFailureSentAt.get(key);
  if (last !== undefined && at - last < API_FAILURE_WINDOW_MS) return;
  const source = thrown instanceof Error ? thrown : undefined;
  const error = frameError(
    source?.name ?? 'ApiServerError',
    `${method} ${route}`,
    source?.stack ?? sentStack,
  );
  // The cause keeps only what links it: its type and its frames, never its message.
  const cause = source?.cause instanceof Error ? source.cause : undefined;
  if (cause) error.cause = frameError(cause.name, '', cause.stack);
  // The slot is taken only by a send, so an event dropped for no consent cannot block the key.
  const sent = capturePostHogException('api-5xx', error, {
    http_method: method,
    http_route: route,
    http_status: status,
    process_type: 'api',
  });
  if (sent) apiFailureSentAt.set(key, at);
}

/** An error built from a type, a message, and frame lines only. */
function frameError(name: unknown, message: string, stack: unknown): Error {
  const error = new Error(message);
  error.name = typeof name === 'string' && name ? name : 'Error';
  const frames = stackFrameLines(stack);
  // Without frames the error keeps the stack of this call, which still points inside this app.
  if (frames.length > 0) {
    error.stack = [message ? `${error.name}: ${message}` : error.name, ...frames].join('\n');
  }
  return error;
}

/** The matched route pattern, or the mount prefix Express has left on the request. */
function requestRoute(req: Request): string {
  return req.route
    ? apiRoutePattern(req.originalUrl, req.route.path)
    : req.baseUrl || '<unmatched>';
}

/** Reports every 5xx the local API sends, including those from the global error handler. */
export function postHogApiFailureMiddleware(req: Request, res: Response, next: NextFunction): void {
  const sendStatus = res.status.bind(res);
  let sentStack: string | undefined;
  // Recorded where the route sends the 500, so a 5xx without a thrown error still has frames.
  res.status = (code: number) => {
    if (code >= 500 && !sentStack) sentStack = new Error().stack;
    return sendStatus(code);
  };
  res.on('finish', () => {
    if (res.statusCode < 500) return;
    capturePostHogApiFailure(
      req.method,
      requestRoute(req),
      res.statusCode,
      res.locals?.postHogError,
      sentStack,
    );
  });
  next();
}

/** A request at or above this wall-clock time is logged, and sent when SQL is the slow part. */
export const SLOW_REQUEST_MS = 200;

// Keyed by method and route pattern, so the map stays as small as the API surface.
const slowRequestRoutes = new Map<string, SlowRequestRouteState>();

/** Opens the SQL stats of the request, then reports the requests slow enough to notice. */
export function apiSlowRequestMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = performance.now();
  runWithRequestStats(() => {
    // A `finish` listener can run outside this async context, so hold the store itself.
    const stats = getRequestStats();
    res.on('finish', () => {
      const durationMs = Math.round(performance.now() - startedAt);
      if (durationMs < SLOW_REQUEST_MS) return;
      const route = requestRoute(req);
      if (!stats) return;
      const dbMs = Math.round(stats.dbMs);
      console.warn(
        `[API] slow request ${req.method} ${route} ${res.statusCode} ${durationMs}ms db=${dbMs}ms queries=${stats.queries}`,
      );
      // Same condition as the capture below: with no consent or no client the gate stays untouched,
      // so the route is not blocked for the hour after consent turns on.
      if (!usageEnabled() || !activeClient()) return;
      const gate = slowRequestEventGate(
        slowRequestRoutes,
        `${req.method} ${route}`,
        dbMs,
        Date.now(),
      );
      if (!gate.send) return;
      capturePostHogUsage('api_slow_request', {
        http_method: req.method,
        http_route: route,
        http_status: res.statusCode,
        duration_ms: durationMs,
        db_ms: dbMs,
        db_queries: stats.queries,
        slowest_query_ms: Math.round(stats.slowestMs),
        slowest_query: stats.slowestSql,
        occurrences: gate.occurrences,
      });
    });
    next();
  });
}

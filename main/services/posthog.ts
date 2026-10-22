/**
 * PostHog beside the existing collector. Usage follows the sharing level in posthog-identity.ts;
 * nothing is sent without a project token (posthog-config.ts) or outside official releases.
 */

import type { NextFunction, Request, Response } from 'express';
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
} from './posthog-config';
import { readCountryProvenance } from './country-provenance';
import { getInstallSource, getRunMode } from './telemetry';
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
import {
  isPostHogCapturePoint,
  redactExceptionMessage,
  sanitizeErrorName,
  scrubPostHogEvent,
  stackFrameLines,
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

interface CachedConsentState {
  level: ProductAnalyticsLevel;
  identity: PostHogIdentity;
  config: PostHogConfig | null;
  revision: number;
  expiresAt: number;
}

let cachedConsent: CachedConsentState | null = null;

export function invalidatePostHogConsentCache(): void {
  cachedConsent = null;
}

function getConsentState(): CachedConsentState {
  const nowMs = Date.now();
  const revision = getSettingsRevision();
  if (cachedConsent && cachedConsent.expiresAt > nowMs && cachedConsent.revision === revision) {
    return cachedConsent;
  }
  const level = readProductAnalyticsLevel();
  const resolvedIdentity = resolvePostHogIdentity(level);
  const config = readPostHogConfig();
  cachedConsent = {
    level,
    identity: resolvedIdentity,
    config,
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
    environment: postHogEnvironment() ?? 'development',
    release_channel: /-beta\b/.test(appVersion()) ? 'beta' : 'stable',
    ...(current.installRef ? { install_ref: current.installRef } : {}),
    ...(current.accountRef ? { store_ref: current.accountRef } : {}),
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

function createClient(token: string, host: string): PostHogClient {
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
    before_send: (event: ScrubbableEvent | null) => {
      const { level } = getConsentState();
      return scrubPostHogEvent(event, {
        telemetryEnabled: level !== 'off',
        accountLinked: level === 'full',
        allowExceptions: isDiagnosticsTransmissionEnabled(),
      });
    },
  });
}

function activeClient(): PostHogClient | null {
  if (postHogNetworkSuppressed()) return null;
  const { config, level } = getConsentState();
  if (!config) return null;
  if (level === 'off' && !isDiagnosticsTransmissionEnabled()) return null;
  const key = `${config.host}\n${config.token}`;
  if (client && clientKey === key) return client;
  const previous = client;
  client = createClient(config.token, config.host);
  clientKey = key;
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
    if (!readPostHogConfig()) {
      if (client) void stopPostHog();
      return;
    }
    if (!usageEnabled() && !isDiagnosticsTransmissionEnabled()) {
      void stopPostHog();
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

export async function stopPostHog(): Promise<void> {
  invalidatePostHogConsentCache();
  const current = client;
  client = null;
  clientKey = null;
  if (!current) return;
  try {
    await current.shutdown(POSTHOG_SHUTDOWN_TIMEOUT_MS);
  } catch {
    // Drop a failed flush.
  }
}

/** A copy of the error whose message is redacted and whose stack carries only frame lines. */
function scrubbedError(input: unknown): Error {
  const record =
    input instanceof Error
      ? { name: input.name, message: input.message, stack: input.stack }
      : input && typeof input === 'object'
        ? (input as { name?: unknown; message?: unknown; stack?: unknown })
        : {};
  const stack = typeof record.stack === 'string' ? record.stack : undefined;
  const name = sanitizeErrorName(record.name, stack);
  const message = redactExceptionMessage(record.message);
  const error = new Error(message);
  error.name = name;
  error.stack = [message ? `${name}: ${message}` : name, ...stackFrameLines(stack)].join('\n');
  return error;
}

export function capturePostHogException(
  capturePoint: PostHogCapturePoint,
  input: unknown,
  properties?: Record<string, unknown>,
): void {
  try {
    if (!isPostHogCapturePoint(capturePoint)) return;
    if (!isDiagnosticsTransmissionEnabled()) return;
    const current = activeClient();
    if (!current) return;
    const who = identity();
    current.captureException(scrubbedError(input), who.distinctId, {
      ...readSuperProperties(who),
      ...(who.identified || who.installRef ? {} : { $process_person_profile: false }),
      ...(properties ?? {}),
      capture_point: capturePoint,
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

/** A 5xx from the local API, keyed by method and route pattern. No params, query, or body. */
export function capturePostHogApiFailure(method: string, route: string, status: number): void {
  const error = new Error(`${method} ${route}`);
  error.name = 'ApiServerError';
  error.stack = error.name;
  capturePostHogException('api-5xx', error, {
    http_method: method,
    http_route: route,
    http_status: status,
  });
}

/** Reports every 5xx the local API sends, including those from the global error handler. */
export function postHogApiFailureMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    if (res.statusCode < 500) return;
    const route = req.route
      ? apiRoutePattern(req.originalUrl, req.route.path)
      : req.baseUrl || '<unmatched>';
    capturePostHogApiFailure(req.method, route, res.statusCode);
  });
  next();
}

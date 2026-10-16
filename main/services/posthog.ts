/**
 * PostHog beside the existing collector. Identities live in posthog-identity.ts: the person is the
 * customer account, `install_ref` is the device. The client sends nothing until the
 * posthog_project_token and posthog_host settings are both set, and only from official releases
 * or an opted-in development run.
 */

import {
  getDatabase,
  getSettingValue,
  upsertSettings,
  isDiagnosticsTransmissionEnabled,
  isTelemetryEnabled,
} from '../db';
import { postHogEnvironment, postHogNetworkSuppressed, readPostHogConfig } from './posthog-config';
import { readCountryProvenance } from './country-provenance';
import { getInstallSource, getRunMode } from './telemetry';
import {
  markAliased,
  pendingAlias,
  resolvePostHogIdentity,
  type PostHogIdentity,
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

function identity(): PostHogIdentity {
  return resolvePostHogIdentity(isTelemetryEnabled());
}

/** Release, channel, and while telemetry is on the device and the account (`store_ref`). */
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

/** Person properties while telemetry is on: the installation email and store configuration. */
export function readPersonProperties(): Record<string, string | boolean> | undefined {
  if (!isTelemetryEnabled()) return undefined;
  const email = readInstallationEmail();
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
    before_send: (event: ScrubbableEvent | null) =>
      scrubPostHogEvent(event, {
        telemetryEnabled: isTelemetryEnabled(),
        allowExceptions: isDiagnosticsTransmissionEnabled(),
      }),
  });
}

function activeClient(): PostHogClient | null {
  if (postHogNetworkSuppressed()) return null;
  const config = readPostHogConfig();
  if (!config) return null;
  if (!isTelemetryEnabled() && !isDiagnosticsTransmissionEnabled()) return null;
  const key = `${config.host}\n${config.token}`;
  if (client && clientKey === key) return client;
  const previous = client;
  client = createClient(config.token, config.host);
  clientKey = key;
  if (previous) void previous.shutdown(POSTHOG_SHUTDOWN_TIMEOUT_MS).catch(() => {});
  return client;
}

export function readPostHogBootstrap(): PostHogBootstrap | PostHogBootstrapReady {
  if (postHogNetworkSuppressed()) return { enabled: false };
  const config = readPostHogConfig();
  if (!config) return { enabled: false };
  const telemetryEnabled = isTelemetryEnabled();
  const diagnosticsEnabled = isDiagnosticsTransmissionEnabled();
  if (!telemetryEnabled && !diagnosticsEnabled) return { enabled: false };
  const current = resolvePostHogIdentity(telemetryEnabled);
  return {
    enabled: true,
    distinctId: current.distinctId,
    identified: current.identified,
    token: config.token,
    host: config.host,
    telemetryEnabled,
    diagnosticsEnabled,
    superProperties: readSuperProperties(current),
  };
}

/** Pins the account person and folds this device into it. Safe to call when PostHog is not configured. */
export function syncPostHogIdentity(): void {
  try {
    if (!readPostHogConfig()) return;
    if (!isTelemetryEnabled() && !isDiagnosticsTransmissionEnabled()) {
      void stopPostHog();
      return;
    }
    if (!isTelemetryEnabled()) return;
    const current = activeClient();
    if (!current) return;
    const who = identity();
    if (!who.identified) return;
    const device = pendingAlias(who);
    if (device) {
      current.alias({ distinctId: who.distinctId, alias: device });
      markAliased(who);
    }
    const person = readPersonProperties();
    current.capture({
      distinctId: who.distinctId,
      event: '$identify',
      properties: person ? { $set: person } : {},
    });
  } catch {
    // A failed PostHog send is dropped. There is no outbox.
  }
}

/** Mirrors a usage event the collector also receives. Dropped unless telemetry is on. */
export function capturePostHogUsage(
  event: PostHogUsageEvent,
  properties?: Record<string, unknown>,
): void {
  try {
    if (!isTelemetryEnabled()) return;
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

const MILESTONES: Array<{ event: 'first_order_created' | 'first_bill_paid'; sql: string }> = [
  { event: 'first_order_created', sql: 'SELECT MIN(created_at) AS at FROM orders' },
  { event: 'first_bill_paid', sql: 'SELECT MIN(paid_at) AS at FROM bills' },
];

function hoursBetween(from: string | undefined, to: string): number | undefined {
  if (!from) return undefined;
  const start = Date.parse(`${from.replace(' ', 'T')}Z`);
  const end = Date.parse(`${to.replace(' ', 'T')}Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return Math.round(((end - start) / 3_600_000) * 10) / 10;
}

/**
 * Activation milestones, each sent once per installation: how long after setup the store
 * rang up its first order and took its first payment. Read from the database, never from the
 * order or payment path.
 */
export function checkPostHogMilestones(): void {
  try {
    if (!isTelemetryEnabled() || !activeClient()) return;
    const db = getDatabase();
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
      capturePostHogUsage(milestone.event, hours === undefined ? {} : { hours_since_setup: hours });
      sent.add(milestone.event);
      upsertSettings({ [MILESTONES_SETTING]: [...sent].join(',') });
    }
  } catch {
    // Milestones are best-effort.
  }
}

export function startPostHog(): void {
  syncPostHogIdentity();
}

export async function stopPostHog(): Promise<void> {
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

/** Outbound-only cloud bridge for pushing local events and polling signed commands. */

import * as crypto from 'crypto';
import * as os from 'os';
import type BetterSqlite3 from 'better-sqlite3';
import { app } from 'electron';
import log from 'electron-log';
import { WebSocket, type RawData } from 'ws';
import { readCountryProvenance } from './country-provenance';
import { getInstallSource, getRunMode } from './telemetry';
import {
  getDatabase,
  now,
  parseItemJson,
  attachEffectiveAddons,
  ensureCloudIdentity,
  isDiagnosticsConsentEnabled,
  isDiagnosticsTransmissionEnabled,
  isTelemetryEnabled,
  isDatabaseMaintenanceActive,
  registerDatabaseMaintenanceEndListener,
  registerDatabaseMaintenanceStartListener,
  utcDayBounds,
  utcTodayDate,
  withDatabaseRequest,
} from '../db';
import {
  classClauseSummary,
  deriveDiagnosticSignature,
  errorClassOf,
} from '../lib/diagnostic-signature';
import { isOperationReference, serializeOperationFailure } from '../lib/operation-failure';
import { getTenantCurrency } from './refund';
import { getCurrencyMinorUnitFactor } from '../countries';
import { assertOnlineAllowed, isOfflineMode } from './offline-mode';
import { normalizeSupportedCurrencyCode } from '../../shared/currencies';

export const DEFAULT_CLOUD_SERVER_URL = 'https://blue.flopos.com/';

const HEARTBEAT_INTERVAL_MS = 5 * 60_000;
const OUTBOX_INTERVAL_MS = 15_000;
const COMMAND_POLL_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 8_000;

export class CloudRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CloudRequestError';
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

function throwIfRequestAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Cloud request cancelled');
}
const MAX_COMMAND_RANGE_DAYS = 370;

// Live-relay channel (commands + heartbeat): WSS primary, HTTP poll/POST fallback.
// See specs/architecture.md § Realtime channel and specs/floadmin.md § WSS /api/pos/relay.
const RELAY_PING_INTERVAL_MS = 25_000;
const RELAY_RECONNECT_BASE_MS = 1_000;
const RELAY_RECONNECT_MAX_MS = 60_000;
const RELAY_FALLBACK_THRESHOLD = 5;

// Zero-touch registration creates the live store immediately.
const AUTO_REGISTER_MAX_BACKOFF_MS = 30 * 60_000;
const CLOUD_DELETION_BLOCKING_STATUSES = new Set([
  'pending',
  'processing',
  'approved',
  'completed',
  'deleted',
  'failed',
  'unknown',
]);
const CLOUD_DELETION_KNOWN_STATUSES = new Set([
  'pending',
  'processing',
  'approved',
  'completed',
  'deleted',
  'cancelled',
  'rejected',
]);
const CLOUD_DELETION_FINAL_STATUSES = new Set(['approved', 'completed', 'deleted']);

function isCloudDeletionBlocking(status?: string): boolean {
  return CLOUD_DELETION_BLOCKING_STATUSES.has(status || '');
}

function validateCloudDeletionResponse(
  data: Record<string, unknown> | null,
  fallbackRequestId = '',
  fallbackStatusToken = '',
): { status: string; requestId: string; statusToken: string } {
  const status = typeof data?.status === 'string' ? data.status.trim().toLowerCase() : '';
  if (!CLOUD_DELETION_KNOWN_STATUSES.has(status)) {
    throw new Error('Cloud deletion returned an unknown or missing status');
  }
  const requestId =
    typeof data?.request_id === 'string' && data.request_id.trim()
      ? data.request_id.trim()
      : fallbackRequestId;
  const statusToken =
    typeof data?.status_token === 'string' && data.status_token.trim()
      ? data.status_token.trim()
      : fallbackStatusToken;
  if ((status === 'pending' || status === 'processing') && (!requestId || !statusToken)) {
    throw new Error('Cloud deletion response omitted tracking details');
  }
  return { status, requestId, statusToken };
}

type CloudSettings = {
  server_url: string;
  api_key: string;
  store_id: string;
  pos_id: string;
  pos_hash: string;
  sync_enabled: boolean;
  orders_enabled: boolean;
  reports_enabled: boolean;
  command_polling_enabled: boolean;
  cloud_registration_status: string;
  cloud_deletion_status: string;
  cloud_deletion_outcome: string;
};

type CloudCommand = {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
  correlation_id?: string;
};

type OutboxRow = {
  id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: string;
  attempt_count: number;
};

export type SupportTicketInput = {
  client_ticket_id: string;
  subject: string;
  severity?: 'low' | 'normal' | 'high' | 'urgent';
  event_code?: string;
  correlation_id?: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  message: string;
  diagnostics?: Record<string, unknown> | null;
  /** Tail of the app's log file at submission time, when the user opted to attach it. */
  log_tail?: string;
};

/** Tier 2 store-attributed diagnostic event payload without customer PII or order data. */
export type DiagnosticEventInput = {
  event_id: string;
  event_code: string;
  severity: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  correlation_id?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  occurred_at: string;
};

/** A locally captured failure, as the diagnostics screen and the copy-for-support bundle see it. */
export type LocalDiagnostic = {
  id: number;
  event_code: string;
  severity: string;
  error_class: string;
  signature: string;
  summary: string;
  metadata?: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
};

/** Allowlist of event codes; built from this list, never filtered from a wider set afterwards. */
const DIAGNOSTIC_EVENT_CODES = [
  'order.place.failed',
  'order.place.rejected',
  'order.place.unreachable',
  'order.place.storage_unavailable',
  'order.create.failed',
  'payment.batch.failed',
  'server.internal_error',
  'print.receipt.failed',
  'print.kot.failed',
] as const;

type DiagnosticEventCode = (typeof DIAGNOSTIC_EVENT_CODES)[number];

export const ALLOWED_DIAGNOSTIC_EVENT_CODES = new Set<DiagnosticEventCode>([
  ...DIAGNOSTIC_EVENT_CODES,
]);

/** Upper bound on both the local failure log and the undelivered outbox. Oldest rows are evicted first. */
export const DIAGNOSTIC_LOG_MAX_ROWS = 200;

const ALLOWED_DIAGNOSTIC_SEVERITIES = new Set<DiagnosticEventInput['severity']>([
  'debug',
  'info',
  'warn',
  'error',
  'critical',
]);
const ALLOWED_ORDER_PLACE_STAGES = new Set(['order_place']);
const ALLOWED_ORDER_CREATE_STAGES = new Set(['inventory_validation', 'order_insert']);
const ALLOWED_PAYMENT_STAGES = new Set(['payment_batch']);
const ALLOWED_DIAGNOSTIC_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'HEAD',
]);
const ALLOWED_PRINT_CONNECTION_TYPES = new Set(['network', 'usb', 'webusb', 'unknown']);
const ALLOWED_PRINT_KINDS = new Set(['receipt', 'kot']);
const ALLOWED_PRINT_FAILURE_CLASSES = new Set([
  'not_configured',
  'offline',
  'needs_attention',
  'queue_unavailable',
  'spooler_error',
  'driver_error',
  'permission_denied',
  'timeout',
  'write_error',
  'unsupported',
  'unknown',
]);
const ALLOWED_PRINT_PLATFORMS = new Set([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'linux',
  'openbsd',
  'win32',
]);
const DIAGNOSTIC_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function isAllowedDiagnosticEventCode(value: unknown): value is DiagnosticEventCode {
  return (
    typeof value === 'string' && ALLOWED_DIAGNOSTIC_EVENT_CODES.has(value as DiagnosticEventCode)
  );
}

function pickInteger(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): void {
  if (
    typeof source[key] === 'number' &&
    Number.isSafeInteger(source[key]) &&
    source[key] >= min &&
    source[key] <= max
  )
    target[key] = source[key];
}

function pickEnum(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  allowed: Set<string>,
): void {
  if (typeof source[key] === 'string' && allowed.has(source[key])) target[key] = source[key];
}

function pickString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  maxLength: number,
): void {
  if (typeof source[key] === 'string' && source[key].length > 0)
    target[key] = source[key].slice(0, maxLength);
}

/** Projects diagnostic metadata to the small set of event-specific non-PII fields. */
function sanitizeDiagnosticMetadata(
  eventCode: DiagnosticEventCode,
  metadata: unknown,
): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const source = metadata as Record<string, unknown>;
  const target: Record<string, unknown> = {};

  if (eventCode.startsWith('order.place.')) {
    pickEnum(source, target, 'stage', ALLOWED_ORDER_PLACE_STAGES);
    pickInteger(source, target, 'status', 100, 599);
  } else if (eventCode === 'order.create.failed') {
    pickEnum(source, target, 'stage', ALLOWED_ORDER_CREATE_STAGES);
    pickInteger(source, target, 'status', 100, 599);
    pickInteger(source, target, 'item_count', 0, 10_000);
  } else if (eventCode === 'payment.batch.failed') {
    pickEnum(source, target, 'stage', ALLOWED_PAYMENT_STAGES);
    pickInteger(source, target, 'status', 100, 599);
  } else if (eventCode === 'server.internal_error') {
    pickString(source, target, 'route', 200);
    pickEnum(source, target, 'method', ALLOWED_DIAGNOSTIC_METHODS);
    pickInteger(source, target, 'status', 500, 599);
  } else {
    pickEnum(source, target, 'connection_type', ALLOWED_PRINT_CONNECTION_TYPES);
    pickEnum(source, target, 'kind', ALLOWED_PRINT_KINDS);
    pickEnum(source, target, 'failure_class', ALLOWED_PRINT_FAILURE_CLASSES);
    pickEnum(source, target, 'os_platform', ALLOWED_PRINT_PLATFORMS);
    pickInteger(source, target, 'platform_error_code', -1_000_000, 1_000_000);
    pickInteger(source, target, 'job_id', 1, Number.MAX_SAFE_INTEGER);
    pickInteger(source, target, 'printer_status', 0, Number.MAX_SAFE_INTEGER);
  }
  return Object.keys(target).length > 0 ? target : undefined;
}

type DateRange = {
  from: string;
  to: string;
};

/** Fixed operator reason per print failure class. Every one is a source-controlled phrase carrying no source text. */
const PRINT_FAILURE_REASON: Record<string, string> = {
  not_configured: 'No printer is configured',
  offline: 'The printer was offline or disconnected',
  needs_attention: 'The printer needs attention - check its paper, cover and consumables',
  queue_unavailable: 'The print queue was not accepting jobs',
  spooler_error: 'The print spooler rejected the job',
  driver_error: 'The printer driver failed',
  permission_denied: 'Access to the printer was denied',
  timeout: 'The printer did not respond in time',
  write_error: 'The printer failed while writing the job',
  unsupported: 'This print is not supported on the current setup',
};

/**
 * The line an operator reads when the template has nothing real in it, rebuilt
 * from the projected metadata. A class with no reason falls back to the clause.
 */
function describeDiagnosticFailure(
  eventCode: DiagnosticEventCode,
  metadata: Record<string, unknown> | undefined,
  errorClass: string,
): string {
  const failureClass = metadata?.failure_class;
  const reason =
    eventCode.startsWith('print.') && typeof failureClass === 'string'
      ? PRINT_FAILURE_REASON[failureClass]
      : undefined;
  return reason ? `${reason}.` : classClauseSummary(errorClass);
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmacHex(secret: string, value: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

/** Appends a locally captured failure and keeps the log inside its row cap. */
function recordLocalDiagnostic(
  db: BetterSqlite3.Database,
  entry: Omit<LocalDiagnostic, 'id' | 'created_at'>,
  timestamp: string,
): void {
  db.prepare(`
    INSERT INTO local_diagnostics
      (event_code, severity, error_class, signature, summary, metadata_json, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.event_code,
    entry.severity,
    entry.error_class,
    entry.signature,
    entry.summary,
    entry.metadata ? JSON.stringify(entry.metadata) : null,
    entry.occurred_at,
    timestamp,
  );
  // No delivery state here, so oldest-first is the only sensible eviction.
  const overflow =
    (db.prepare('SELECT COUNT(*) AS count FROM local_diagnostics').get() as { count: number })
      .count - DIAGNOSTIC_LOG_MAX_ROWS;
  if (overflow > 0) addDiagnosticsDeliveryGap(db, 'local_retention', overflow);
  evictOldestDiagnostics(db, 'local_diagnostics', DIAGNOSTIC_LOG_MAX_ROWS);
}

// Enforced on write, not on read, so neither log can grow between reads. `rowid`
// is insertion order on both tables; the outbox's `event_id` key is not a rowid alias.
function evictOldestDiagnostics(
  db: BetterSqlite3.Database,
  table: 'local_diagnostics' | 'store_diagnostics_outbox',
  max: number,
): void {
  db.prepare(
    `DELETE FROM ${table} WHERE rowid NOT IN (SELECT rowid FROM ${table} ORDER BY rowid DESC LIMIT ?)`,
  ).run(max);
}

// Evicts resolved rows first, then oldest undelivered rows.
function evictOutboxDiagnostics(db: BetterSqlite3.Database, max: number): void {
  const overflow =
    (
      db.prepare('SELECT COUNT(*) AS count FROM store_diagnostics_outbox').get() as {
        count: number;
      }
    ).count - max;
  if (overflow <= 0) return;
  const rows = db
    .prepare(`
    SELECT rowid, payload, status, permanent_failure FROM store_diagnostics_outbox
     ORDER BY CASE WHEN status = 'delivered' THEN 0 WHEN permanent_failure = 1 THEN 1 ELSE 2 END, rowid ASC
     LIMIT ?
  `)
    .all(overflow) as Array<{
    rowid: number;
    payload: string;
    status: string;
    permanent_failure: number;
  }>;
  const remove = db.prepare('DELETE FROM store_diagnostics_outbox WHERE rowid = ?');
  for (const row of rows) {
    if (row.status !== 'delivered' && row.permanent_failure !== 1) {
      addDiagnosticsDeliveryGap(db, 'queue_eviction', diagnosticPayloadCount(row.payload));
    }
    remove.run(row.rowid);
  }
}

function evictResolvedOutboxDiagnostics(db: BetterSqlite3.Database, max: number): void {
  const overflow =
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM store_diagnostics_outbox WHERE status = 'delivered' OR permanent_failure = 1",
        )
        .get() as { count: number }
    ).count - max;
  if (overflow <= 0) return;
  db.prepare(`DELETE FROM store_diagnostics_outbox WHERE rowid IN (
    SELECT rowid FROM store_diagnostics_outbox WHERE status = 'delivered' OR permanent_failure = 1
    ORDER BY CASE WHEN status = 'delivered' THEN 0 ELSE 1 END, rowid ASC LIMIT ?
  )`).run(overflow);
}

const DIAGNOSTICS_GAP_REASONS = [
  'queue_eviction',
  'permanent_rejection',
  'invalid_ack',
  'report_id_mismatch',
  'local_retention',
] as const;
type DiagnosticsGapReason = (typeof DIAGNOSTICS_GAP_REASONS)[number];

function addDiagnosticsDeliveryGap(
  db: BetterSqlite3.Database,
  reason: DiagnosticsGapReason,
  count: number,
): void {
  if (!Number.isSafeInteger(count) || count <= 0) return;
  const timestamp = diagnosticUtcTimestamp();
  db.prepare(`
    INSERT INTO diagnostics_delivery_gaps (reason_code, count, first_occurred_at, last_occurred_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(reason_code) DO UPDATE SET count = count + excluded.count,
      last_occurred_at = excluded.last_occurred_at, updated_at = excluded.updated_at
  `).run(reason, count, timestamp, timestamp, now());
}

function diagnosticPayloadCount(payload: string): number {
  try {
    const value = JSON.parse(payload) as { schema_version?: unknown; count?: unknown };
    return value.schema_version === 2 &&
      Number.isSafeInteger(value.count) &&
      (value.count as number) > 0
      ? (value.count as number)
      : 1;
  } catch {
    return 1;
  }
}

function canonicalDiagnosticFacts(
  facts: Record<string, number | string>,
): Record<string, number | string> {
  return Object.fromEntries(
    Object.entries(facts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function diagnosticOccurrenceTime(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64) return diagnosticUtcTimestamp();
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    timestamp > Date.now() + 86_400_000 ||
    timestamp < Date.now() - 365 * 86_400_000
  ) {
    return diagnosticUtcTimestamp();
  }
  return diagnosticUtcTimestamp(timestamp);
}

function diagnosticUtcTimestamp(timestamp = Date.now()): string {
  return new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function diagnosticWindowStart(occurredAt: string): string {
  const date = new Date(occurredAt);
  date.setUTCMinutes(0, 0, 0);
  return diagnosticUtcTimestamp(date.getTime());
}

function diagnosticBuildIdentity(): string {
  try {
    const value = require('./build-identity').getBuildIdentity() as unknown;
    return typeof value === 'string' && /^[A-Za-z0-9._:+-]{1,64}$/.test(value) ? value : 'unknown';
  } catch {
    return 'unknown';
  }
}

function diagnosticAppVersion(): string {
  try {
    const value = app.getVersion();
    return /^[A-Za-z0-9._:+-]{1,64}$/.test(value) ? value : 'unknown';
  } catch {
    return 'unknown';
  }
}

function parseRetryAfterMs(value: string): number | null {
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(Number.MAX_SAFE_INTEGER, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

type DiagnosticAggregateRow = {
  aggregate_key: string;
  capture_point: string;
  reason_code: string;
  classification: string;
  operation: string;
  stage: string;
  outcome: string;
  window_start: string;
  count: number;
  first_occurred_at: string;
  last_occurred_at: string;
  app_version: string;
  app_build: string;
  platform: string;
  examples_json: string;
  facts_json: string;
};

type DiagnosticTransport = 'signed' | 'anonymous';
const DIAGNOSTIC_REPORT_MAX_COUNT = 100_000;
const DIAGNOSTIC_FLUSH_BATCH = 20;

function parseBoundedExamples(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed
          .filter(
            (value) =>
              typeof value === 'string' &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
          )
          .slice(0, 3)
      : [];
  } catch {
    return [];
  }
}

function parseBoundedFacts(json: string): Record<string, number | string> | null {
  try {
    const value = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function enqueueDiagnosticReport(
  db: BetterSqlite3.Database,
  report: Record<string, unknown>,
  transport: DiagnosticTransport,
  preservePending = false,
): boolean {
  const timestamp = now();
  if (preservePending) {
    const queued = (
      db.prepare('SELECT COUNT(*) AS count FROM store_diagnostics_outbox').get() as {
        count: number;
      }
    ).count;
    const needed = Math.max(0, queued - (DIAGNOSTIC_LOG_MAX_ROWS - 1));
    if (needed > 0) {
      const resolved = (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM store_diagnostics_outbox WHERE status = 'delivered' OR permanent_failure = 1",
          )
          .get() as { count: number }
      ).count;
      evictResolvedOutboxDiagnostics(db, Math.max(0, resolved - needed));
    }
    const queuedAfterResolvedEviction = (
      db.prepare('SELECT COUNT(*) AS count FROM store_diagnostics_outbox').get() as {
        count: number;
      }
    ).count;
    if (queuedAfterResolvedEviction >= DIAGNOSTIC_LOG_MAX_ROWS) return false;
  } else {
    evictOutboxDiagnostics(db, DIAGNOSTIC_LOG_MAX_ROWS - 1);
  }
  const payload =
    transport === 'anonymous'
      ? JSON.stringify({ ...report, examples: [] })
      : JSON.stringify(report);
  db.prepare(`INSERT INTO store_diagnostics_outbox
    (event_id, payload, status, created_at, updated_at, transport, permanent_failure)
    VALUES (?, ?, 'pending', ?, ?, ?, 0)`).run(
    report.report_id,
    payload,
    timestamp,
    timestamp,
    transport,
  );
  return true;
}

function sealDiagnosticAggregates(
  db: BetterSqlite3.Database,
  transport: DiagnosticTransport,
  reportBudget: number,
): number {
  if (reportBudget <= 0) return 0;
  const aggregates = db
    .prepare(
      'SELECT * FROM diagnostics_hourly_aggregates ORDER BY window_start, updated_at LIMIT ?',
    )
    .all(DIAGNOSTIC_LOG_MAX_ROWS) as DiagnosticAggregateRow[];
  for (const row of aggregates) {
    const facts = parseBoundedFacts(row.facts_json);
    const failure = serializeOperationFailure({
      capture_point: row.capture_point,
      outcome: row.outcome,
      facts,
    });
    if (
      !failure ||
      failure.reason_code !== row.reason_code ||
      failure.operation !== row.operation ||
      failure.stage !== row.stage ||
      failure.classification !== row.classification ||
      !Number.isSafeInteger(row.count) ||
      row.count <= 0
    ) {
      addDiagnosticsDeliveryGap(
        db,
        'local_retention',
        Number.isSafeInteger(row.count) && row.count > 0 ? row.count : 1,
      );
      db.prepare('DELETE FROM diagnostics_hourly_aggregates WHERE aggregate_key = ?').run(
        row.aggregate_key,
      );
      continue;
    }
    let remaining = row.count;
    const examples = parseBoundedExamples(row.examples_json);
    while (remaining > 0 && reportBudget > 0) {
      const count = Math.min(remaining, DIAGNOSTIC_REPORT_MAX_COUNT);
      const enqueued = enqueueDiagnosticReport(
        db,
        {
          schema_version: 2,
          report_id: crypto.randomUUID(),
          reason_code: failure.reason_code,
          classification: failure.classification,
          operation: failure.operation,
          stage: failure.stage,
          outcome: failure.outcome,
          capture_point: failure.capture_point,
          count,
          window_start: row.window_start,
          first_occurred_at: row.first_occurred_at,
          last_occurred_at: row.last_occurred_at,
          app_version: row.app_version,
          app_build: row.app_build,
          platform: row.platform,
          examples: examples.map((correlation_id) => ({ correlation_id })),
          facts: failure.facts,
        },
        transport,
        true,
      );
      if (!enqueued) break;
      remaining -= count;
      reportBudget -= 1;
    }
    if (remaining === 0) {
      db.prepare('DELETE FROM diagnostics_hourly_aggregates WHERE aggregate_key = ?').run(
        row.aggregate_key,
      );
    } else {
      db.prepare('UPDATE diagnostics_hourly_aggregates SET count = ? WHERE aggregate_key = ?').run(
        remaining,
        row.aggregate_key,
      );
    }
    if (reportBudget === 0) return 0;
  }
  return reportBudget;
}

function sealDiagnosticGaps(
  db: BetterSqlite3.Database,
  transport: DiagnosticTransport,
  reportBudget: number,
): void {
  if (reportBudget <= 0) return;
  const gaps = db
    .prepare('SELECT * FROM diagnostics_delivery_gaps WHERE count > 0 ORDER BY reason_code')
    .all() as Array<{
    reason_code: DiagnosticsGapReason;
    count: number;
    first_occurred_at: string;
    last_occurred_at: string;
  }>;
  for (const gap of gaps) {
    let remaining = gap.count;
    while (remaining > 0 && reportBudget > 0) {
      const count = Math.min(remaining, DIAGNOSTIC_REPORT_MAX_COUNT);
      const failure = serializeOperationFailure({
        capture_point: 'fc.diagnostics.delivery.queue_gap',
        outcome: 'partial',
        facts: { gap_count: count, gap_reason: gap.reason_code },
      });
      if (!failure) return;
      const observedAt = diagnosticUtcTimestamp();
      const enqueued = enqueueDiagnosticReport(
        db,
        {
          schema_version: 2,
          report_id: crypto.randomUUID(),
          reason_code: failure.reason_code,
          classification: failure.classification,
          operation: failure.operation,
          stage: failure.stage,
          outcome: failure.outcome,
          capture_point: failure.capture_point,
          count,
          window_start: diagnosticWindowStart(observedAt),
          first_occurred_at: observedAt,
          last_occurred_at: observedAt,
          app_version: diagnosticAppVersion(),
          app_build: diagnosticBuildIdentity(),
          platform: ['win32', 'darwin', 'linux'].includes(process.platform)
            ? process.platform
            : 'unknown',
          examples: [],
          facts: failure.facts,
        },
        transport,
        true,
      );
      if (!enqueued) break;
      remaining -= count;
      reportBudget -= 1;
    }
    if (remaining === 0) {
      db.prepare('DELETE FROM diagnostics_delivery_gaps WHERE reason_code = ?').run(
        gap.reason_code,
      );
    } else {
      db.prepare(
        `UPDATE diagnostics_delivery_gaps SET count = ?, updated_at = ? WHERE reason_code = ?`,
      ).run(remaining, now(), gap.reason_code);
    }
    if (reportBudget === 0) return;
  }
}

function safeParseMetadata(json: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isLocalDevUrl(url: URL): boolean {
  return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
}

export function normalizeCloudServerUrl(raw?: string | null): string {
  const url = new URL(raw && raw.trim() ? raw.trim() : DEFAULT_CLOUD_SERVER_URL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalDevUrl(url))) {
    throw new Error('Cloud server URL must use HTTPS');
  }
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/g, '');
  return url.toString().replace(/\/+$/g, '');
}

function apiPath(pathname: string): string {
  return pathname.startsWith('/api/') ? pathname : `/api/${pathname.replace(/^\/+/, '')}`;
}

function endpoint(serverUrl: string, pathname: string): URL {
  const base = new URL(serverUrl);
  const basePath = base.pathname.replace(/\/+$/g, '');
  // Strip query string before pathname assignment to avoid percent-encoding '?'.
  const [rawPath, rawQuery] = apiPath(pathname).split('?');
  const adjustedPath =
    basePath.endsWith('/api') && rawPath.startsWith('/api/')
      ? rawPath.slice('/api'.length)
      : rawPath;
  base.pathname = `${basePath}${adjustedPath}`.replace(/\/{2,}/g, '/');
  base.search = rawQuery || '';
  return base;
}

function relayEndpoint(serverUrl: string): string {
  const base = new URL(serverUrl);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const basePath = base.pathname.replace(/\/+$/g, '');
  base.pathname = `${basePath}/api/pos/relay`.replace(/\/{2,}/g, '/');
  base.hash = '';
  base.search = '';
  return base.toString();
}

function parseIsoDate(value: unknown, fallback: Date): Date {
  if (typeof value !== 'string') return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date;
}

function dateRange(payload?: Record<string, unknown>): DateRange {
  const nowDate = new Date();
  const defaultFrom = new Date(nowDate);
  defaultFrom.setDate(defaultFrom.getDate() - 30);

  const from = parseIsoDate(payload?.from, defaultFrom);
  const to = parseIsoDate(payload?.to, nowDate);
  const days = Math.abs(to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
  if (days > MAX_COMMAND_RANGE_DAYS) {
    throw new Error(`Report range cannot exceed ${MAX_COMMAND_RANGE_DAYS} days`);
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
  };
}

function safeJsonParse(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function sanitizeOrderSnapshot(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const snapshot = value as Record<string, unknown>;
  const safe = { ...snapshot };
  delete safe.customer;
  delete safe.customer_id;
  // PII: the snapshot is a SELECT * spread, so a new free-text address or
  // courier-note column leaves the machine unless it is named here. Tests enforce that.
  delete safe.delivery_address;
  delete safe.delivery_note;
  delete safe.special_instructions;
  delete safe.discount_reason;
  delete safe.cancellation_reason;
  if (Array.isArray(safe.items)) {
    safe.items = safe.items.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const safeItem = { ...(item as Record<string, unknown>) };
      delete safeItem.special_instructions;
      return safeItem;
    });
  }
  if (safe.bill && typeof safe.bill === 'object' && !Array.isArray(safe.bill)) {
    const safeBill = { ...(safe.bill as Record<string, unknown>) };
    delete safeBill.payment_details;
    delete safeBill.customer_id;
    safe.bill = safeBill;
  }
  if (Array.isArray(safe.bills)) {
    safe.bills = safe.bills.map((bill) => {
      if (!bill || typeof bill !== 'object' || Array.isArray(bill)) return bill;
      const safeBill = { ...(bill as Record<string, unknown>) };
      delete safeBill.payment_details;
      delete safeBill.customer_id;
      return safeBill;
    });
  }
  return safe;
}

interface OrderSnapshotSource extends Record<string, unknown> {
  id?: string | number;
  table_id?: string | number | null;
}

interface OrderItemSnapshotSource extends Record<string, unknown> {
  id: number;
  order_id?: string | number;
}

interface TableSnapshotSource extends Record<string, unknown> {
  id?: string | number;
  number?: string;
}

interface BillSnapshotSource extends Record<string, unknown> {
  id?: string | number;
  order_id?: string | number;
  payment_status?: string;
  payment_details?: string | null;
}

export class CloudSyncService {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private supportOutboxTimer: ReturnType<typeof setInterval> | null = null;
  private diagnosticsOutboxTimer: ReturnType<typeof setInterval> | null = null;
  private commandTimer: ReturnType<typeof setInterval> | null = null;
  private settings: CloudSettings | null = null;
  private flushing = false;
  private outboxFlushPromise: Promise<void> | null = null;
  private pollingCommands = false;

  // Live-relay channel state (commands + heartbeat) — see § Realtime channel in specs.
  private relaySocket: WebSocket | null = null;
  private relayPingTimer: ReturnType<typeof setInterval> | null = null;
  private relayAwaitingPong = false;
  private relayHeartbeatFrameTimer: ReturnType<typeof setInterval> | null = null;
  private relayReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private relayReconnectAttempts = 0;
  private httpFallbackActive = false;
  private relayMode: 'websocket' | 'http_fallback' | 'disconnected' = 'disconnected';
  private supportFlushing = false;
  private supportFlushPromise: Promise<void> | null = null;
  private diagnosticsFlushing = false;
  private diagnosticsFlushPromise: Promise<void> | null = null;
  private cloudDeletionInProgress = false;
  private cloudNetworkOperations = 0;
  private cloudNetworkIdleWaiters: (() => void)[] = [];
  private backgroundPromises = new Set<Promise<unknown>>();
  private relayCommandPromises = new Set<Promise<unknown>>();
  private commandPollPromises = new Set<Promise<unknown>>();
  private commandPollAbortController: AbortController | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private shutdownRequested = false;
  private shutdownController = new AbortController();

  // Zero-touch registration state.
  private autoRegisterTimer: ReturnType<typeof setTimeout> | null = null;
  private offlineAbort = new AbortController();
  private autoRegisterAttempts = 0;
  private autoRegisterInFlight = false;
  private runtimeStarted = false;

  start() {
    if (this.cloudDeletionInProgress) return;
    this.shutdownRequested = false;
    this.shutdownPromise = null;
    this.shutdownController = new AbortController();
    this.runtimeStarted = true;
    const settings = this.readSettings(getDatabase());
    if (!isCloudDeletionBlocking(settings.cloud_deletion_status)) ensureCloudIdentity();
    this.reload();
    // Register once at boot. The v2 endpoint creates/finds the live store and
    // returns a working API key immediately; there is no claim or pending state.
    this.maybeAutoRegister();
  }

  reload() {
    if (this.cloudDeletionInProgress || this.shutdownRequested) return;
    this.stop();
    if (isOfflineMode()) return;
    const persisted = this.loadSettings(false);
    this.settings = persisted;
    if (!persisted || isCloudDeletionBlocking(persisted.cloud_deletion_status)) return;
    const cfg = this.loadSettings(true);
    this.settings = cfg;
    if (!cfg) return;

    if (cfg.sync_enabled && cfg.api_key) {
      this.runBackground(this.flushOutbox(), 'outbox flush');
      this.outboxTimer = setInterval(
        () => this.runBackground(this.flushOutbox(), 'outbox flush'),
        OUTBOX_INTERVAL_MS,
      );
      this.runBackground(this.flushSupportTicketOutbox(), 'support outbox flush');
      this.supportOutboxTimer = setInterval(
        () => this.runBackground(this.flushSupportTicketOutbox(), 'support outbox flush'),
        OUTBOX_INTERVAL_MS,
      );
    }
    this.refreshDiagnosticsOutbox(cfg);

    this.maybeStartRelay();
    if (cfg.api_key || cfg.cloud_registration_status !== 'unregistered') {
      log.info('[CloudSync] started', {
        server: cfg.server_url,
        sync: cfg.sync_enabled,
        commands: cfg.command_polling_enabled,
        registered: Boolean(cfg.api_key),
      });
    }
  }

  resumeAfterMaintenance() {
    if (this.runtimeStarted && !this.shutdownRequested) this.reload();
  }

  private refreshDiagnosticsOutbox(cfg: CloudSettings | null, enabled = true): void {
    const canSendDiagnostics =
      enabled &&
      !this.cloudDeletionInProgress &&
      !this.shutdownRequested &&
      Boolean(cfg) &&
      !isCloudDeletionBlocking(cfg?.cloud_deletion_status || '') &&
      isDiagnosticsConsentEnabled() &&
      isDiagnosticsTransmissionEnabled() &&
      Boolean(cfg && ((cfg.sync_enabled && cfg.api_key) || isTelemetryEnabled()));
    if (!canSendDiagnostics) {
      if (this.diagnosticsOutboxTimer) {
        clearInterval(this.diagnosticsOutboxTimer);
        this.diagnosticsOutboxTimer = null;
      }
      return;
    }
    this.runBackground(this.flushDiagnosticsOutbox(), 'diagnostics outbox flush');
    if (!this.diagnosticsOutboxTimer) {
      this.diagnosticsOutboxTimer = setInterval(
        () => this.runBackground(this.flushDiagnosticsOutbox(), 'diagnostics outbox flush'),
        OUTBOX_INTERVAL_MS,
      );
    }
  }

  stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }
    if (this.supportOutboxTimer) {
      clearInterval(this.supportOutboxTimer);
      this.supportOutboxTimer = null;
    }
    if (this.diagnosticsOutboxTimer) {
      clearInterval(this.diagnosticsOutboxTimer);
      this.diagnosticsOutboxTimer = null;
    }
    if (this.commandTimer) {
      clearInterval(this.commandTimer);
      this.commandTimer = null;
    }
    this.commandPollAbortController?.abort();
    this.commandPollAbortController = null;
    if (this.autoRegisterTimer) {
      clearTimeout(this.autoRegisterTimer);
      this.autoRegisterTimer = null;
    }
    this.httpFallbackActive = false;
    this.teardownRelay();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownRequested = true;
    this.shutdownController.abort();
    this.runtimeStarted = false;
    this.stop();
    const activeFlushes = [
      this.outboxFlushPromise,
      this.supportFlushPromise,
      this.diagnosticsFlushPromise,
    ].filter((promise): promise is Promise<void> => promise !== null);
    const activeRelayCommands = [...this.relayCommandPromises];
    const activeCommandPolls = [...this.commandPollPromises];
    const activeBackground = [...this.backgroundPromises];
    this.shutdownPromise = Promise.allSettled([
      ...activeFlushes,
      ...activeRelayCommands,
      ...activeCommandPolls,
      ...activeBackground,
    ])
      .then(() => this.waitForBackgroundWork())
      .then(() => this.waitForCloudNetworkIdle())
      .then(() => undefined);
    return this.shutdownPromise;
  }

  private async waitForBackgroundWork(): Promise<void> {
    while (this.backgroundPromises.size > 0) {
      await Promise.allSettled([...this.backgroundPromises]);
    }
  }

  private withDatabaseRequest<T>(
    operation: () => T | Promise<T>,
    requestSignal?: AbortSignal,
  ): Promise<T> {
    const signal = requestSignal
      ? AbortSignal.any([this.shutdownController.signal, requestSignal])
      : this.shutdownController.signal;
    return withDatabaseRequest(operation, signal);
  }

  private teardownRelay() {
    if (this.relayReconnectTimer) {
      clearTimeout(this.relayReconnectTimer);
      this.relayReconnectTimer = null;
    }
    if (this.relayPingTimer) {
      clearInterval(this.relayPingTimer);
      this.relayPingTimer = null;
    }
    if (this.relayHeartbeatFrameTimer) {
      clearInterval(this.relayHeartbeatFrameTimer);
      this.relayHeartbeatFrameTimer = null;
    }
    if (this.relaySocket) {
      const socket = this.relaySocket;
      this.relaySocket = null;
      socket.removeAllListeners();
      // Swallow errors while terminating a connecting socket after listeners were removed.
      socket.on('error', () => {});
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    }
    this.relayReconnectAttempts = 0;
    this.relayMode = 'disconnected';
  }

  /** Returns whether cloud account features are available and enabled by the user. */
  isCloudAccountAvailable(): boolean {
    const settings = this.readSettings(getDatabase());
    return (
      settings.cloud_registration_status === 'registered' &&
      Boolean(settings.cloud_api_key) &&
      settings.cloud_services_disabled_by_user !== 'true' &&
      !isCloudDeletionBlocking(settings.cloud_deletion_status)
    );
  }

  getStatus() {
    const db = getDatabase();
    const s = this.readSettings(db);
    const deletionBlocked = isCloudDeletionBlocking(s.cloud_deletion_status);
    if (!this.cloudDeletionInProgress && !deletionBlocked) ensureCloudIdentity();
    const refreshed = this.readSettings(db);
    return {
      cloud_server_url: refreshed.cloud_server_url || DEFAULT_CLOUD_SERVER_URL,
      cloud_pos_hash: refreshed.cloud_pos_hash || null,
      cloud_pos_id: refreshed.cloud_pos_id || null,
      cloud_sync_enabled: refreshed.cloud_sync_enabled === '1',
      cloud_orders_enabled: refreshed.cloud_orders_enabled === '1',
      cloud_reports_enabled: refreshed.cloud_reports_enabled === '1',
      cloud_command_polling_enabled: refreshed.cloud_command_polling_enabled === '1',
      cloud_registration_status: refreshed.cloud_registration_status || 'unregistered',
      cloud_services_disabled_by_user: refreshed.cloud_services_disabled_by_user === 'true',
      cloud_connected: refreshed.cloud_connected === 'true',
      cloud_last_sync: refreshed.cloud_last_sync || null,
      cloud_last_heartbeat: refreshed.cloud_last_heartbeat || null,
      cloud_last_error: refreshed.cloud_last_error
        ? refreshed.cloud_registration_status === 'registration_failed'
          ? 'Cloud registration failed'
          : refreshed.cloud_deletion_status === 'failed'
            ? 'Cloud deletion request failed'
            : 'Cloud service request failed'
        : null,
      cloud_deletion_status: refreshed.cloud_deletion_status || '',
      cloud_deletion_outcome: refreshed.cloud_deletion_outcome || '',
      cloud_deletion_blocked: isCloudDeletionBlocking(refreshed.cloud_deletion_status),
      cloud_relay_mode: this.relayMode,
      outbox_pending: this.countOutbox('pending'),
      outbox_failed: this.countOutbox('failed'),
      loaded: Boolean(s),
    };
  }

  // Registration carries contact metadata for FloAdmin support. It is not an
  // authentication credential and does not create a cloud owner account.
  async register(signal?: AbortSignal): Promise<Record<string, unknown>> {
    throwIfRequestAborted(signal);
    if (this.cloudDeletionInProgress || this.shutdownRequested)
      throw new Error('Cloud shutdown in progress');
    return this.withDatabaseRequest(async () => {
      throwIfRequestAborted(signal);
      if (this.cloudDeletionInProgress || this.shutdownRequested)
        throw new Error('Cloud shutdown in progress');
      const db = getDatabase();
      const settings = this.readSettings(db);
      if (isCloudDeletionBlocking(settings.cloud_deletion_status)) {
        throw new Error('Cloud deletion is pending; cancel it before registering again');
      }
      const { posHash, deviceSecret } = ensureCloudIdentity();
      const serverUrl = normalizeCloudServerUrl(
        settings.cloud_server_url || DEFAULT_CLOUD_SERVER_URL,
      );
      const owner = db
        .prepare(
          "SELECT name FROM users WHERE role = 'owner' AND is_active = 1 ORDER BY created_at ASC LIMIT 1",
        )
        .get() as { name?: string } | undefined;
      // Use country provenance to avoid reporting seeded default country values.
      const provenance = readCountryProvenance();
      const currency = normalizeSupportedCurrencyCode(settings.currency);
      const body = {
        pos_hash: posHash,
        device_secret_hash: sha256Hex(deviceSecret),
        device_name: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        app_version: require('../../package.json').version,
        run_mode: getRunMode(),
        install_source: getInstallSource(),
        store_type: 'cafe',
        business: {
          name: settings.business_name || '',
          contact_name: owner?.name || '',
          email: settings.email || '',
          phone: settings.business_phone || settings.phone || '',
          instagram_handle: settings.instagram_handle || '',
          country: provenance.country,
          ...(currency ? { currency } : {}),
          country_source: provenance.countrySource,
          os_country: provenance.osCountry,
          os_locale: provenance.osLocale,
          os_timezone: provenance.osTimezone,
          timezone: settings.timezone || '',
          address: settings.business_address || '',
        },
        requested_at: new Date().toISOString(),
      };

      try {
        const res = await this.trackedFetch(endpoint(serverUrl, '/api/pos/register'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Flo-POS-Hash': posHash,
          },
          body: JSON.stringify(body),
          signal: requestSignal(signal),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throwIfRequestAborted(signal);
        if (this.cloudDeletionInProgress || this.shutdownRequested)
          throw new Error('Cloud shutdown in progress');
        if (!res.ok) {
          throw new Error(String(data.error || `Registration failed (${res.status})`));
        }

        const apiKey = typeof data.api_key === 'string' ? data.api_key : settings.cloud_api_key;
        if (!apiKey) throw new Error('Registration response did not include api_key');

        this.upsertSettings({
          cloud_server_url: serverUrl,
          cloud_api_key: apiKey,
          cloud_pos_id: typeof data.pos_id === 'string' ? data.pos_id : settings.cloud_pos_id,
          cloud_store_id:
            typeof data.store_id === 'string' ? data.store_id : settings.cloud_store_id,
          cloud_registration_status: 'registered',
          cloud_connected: 'true',
          cloud_last_error: '',
          cloud_deletion_status: '',
          cloud_deletion_outcome: '',
          cloud_last_heartbeat: new Date().toISOString(),
        });
        throwIfRequestAborted(signal);
        if (this.shutdownRequested) throw new Error('Cloud shutdown in progress');
        this.reload();
        if (settings.cloud_verification_welcome_requested !== '1') {
          try {
            await this.requestEmailVerification(
              {
                product_updates: settings.email_product_updates === 'true',
                marketing: settings.email_marketing === 'true',
                source: 'signup',
              },
              signal,
            );
            throwIfRequestAborted(signal);
            if (this.shutdownRequested) throw new Error('Cloud shutdown in progress');
            this.upsertSettings({ cloud_verification_welcome_requested: '1' });
          } catch (emailError) {
            throwIfRequestAborted(signal);
            log.warn(
              '[CloudSync] welcome email request failed (registration remains valid)',
              (emailError as Error).message,
            );
          }
        }
        return this.getStatus();
      } catch (err) {
        if (this.shutdownRequested) throw err;
        const currentSettings = this.readSettings(getDatabase());
        if (
          !this.cloudDeletionInProgress &&
          !this.shutdownRequested &&
          currentSettings.cloud_services_disabled_by_user !== 'true'
        ) {
          this.upsertSettings({
            cloud_registration_status: 'registration_failed',
            cloud_connected: 'false',
            cloud_last_error: 'Cloud registration failed',
          });
        }
        throw err;
      }
    }, signal);
  }

  async testConnection(signal?: AbortSignal): Promise<Record<string, unknown>> {
    throwIfRequestAborted(signal);
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    const res = await this.signedFetch('/api/pos/connection-test', {
      method: 'POST',
      body: '{}',
      signal,
    });
    await res.json().catch(() => ({}));
    throwIfRequestAborted(signal);
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    if (!res.ok) throw new Error(`Cloud test failed (${res.status})`);
    this.upsertSettings({
      cloud_connected: 'true',
      cloud_last_error: '',
      cloud_last_heartbeat: new Date().toISOString(),
    });
    return { ok: true, status: this.getStatus() };
  }

  async getEmailPreferences(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const res = await this.signedFetch('/api/pos/email-preferences', { method: 'GET', signal });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throwIfRequestAborted(signal);
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    if (!res.ok) throw new Error(String(data.error || `Email status failed (${res.status})`));
    this.upsertSettings({
      cloud_email_verified: data.verified ? 'true' : 'false',
      cloud_email_verification_sent_at:
        typeof data.verification_sent_at === 'string' ? data.verification_sent_at : '',
      email_product_updates: data.product_updates ? 'true' : 'false',
      email_marketing: data.marketing ? 'true' : 'false',
    });
    return data;
  }

  async updateEmailPreferences(
    preferences: { product_updates?: boolean; marketing?: boolean },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const res = await this.signedFetch('/api/pos/email-preferences', {
      method: 'PUT',
      body: JSON.stringify(preferences),
      signal,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throwIfRequestAborted(signal);
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    if (!res.ok) throw new Error(String(data.error || `Preference update failed (${res.status})`));
    await this.getEmailPreferences(signal);
    return data;
  }

  async requestEmailVerification(
    preferences: { product_updates?: boolean; marketing?: boolean; source?: string } = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    throwIfRequestAborted(signal);
    const res = await this.signedFetch('/api/pos/email/verification', {
      method: 'POST',
      body: JSON.stringify(preferences),
      signal,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throwIfRequestAborted(signal);
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    if (!res.ok) {
      throw new CloudRequestError(
        String(data.error || `Verification request failed (${res.status})`),
        res.status,
      );
    }
    this.upsertSettings({
      cloud_email_verified: data.verified ? 'true' : 'false',
      cloud_email_verification_sent_at:
        typeof data.verification_sent_at === 'string' ? data.verification_sent_at : '',
    });
    return data;
  }

  /** True when cloud services are on and the store has an owner email FloAdmin can verify and mail. */
  isEmailRecoveryAvailable(): boolean {
    return this.isCloudAccountAvailable() && Boolean(this.getRegisteredOwnerEmail());
  }

  async isOwnerEmailVerified(signal?: AbortSignal): Promise<boolean> {
    return (await this.getEmailPreferences(signal)).verified === true;
  }

  /** Sends the verification email when the owner email is unverified; returns whether it already is. */
  async ensureOwnerEmailVerification(signal?: AbortSignal): Promise<boolean> {
    if (await this.isOwnerEmailVerified(signal)) return true;
    const sent = await this.requestEmailVerification({ source: 'password-recovery' }, signal);
    return sent.verified === true;
  }

  /** The owner email the store registered with, which FloAdmin mails the reset link to. */
  getRegisteredOwnerEmail(): string {
    return String(this.readSettings(getDatabase()).email || '')
      .trim()
      .toLowerCase();
  }

  private async passwordResetCall(
    pathname: string,
    method: 'GET' | 'POST',
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    throwIfRequestAborted(signal);
    const res = await this.signedFetch(pathname, {
      method,
      body: method === 'POST' ? '{}' : undefined,
      signal,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throwIfRequestAborted(signal);
    if (!res.ok) {
      throw new CloudRequestError(
        String(data.error || data.status || `Password reset request failed (${res.status})`),
        res.status,
      );
    }
    return data;
  }

  requestPasswordReset(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.passwordResetCall('/api/pos/password-reset/request', 'POST', signal);
  }

  getPasswordResetStatus(resetId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.passwordResetCall(
      `/api/pos/password-reset/${encodeURIComponent(resetId)}`,
      'GET',
      signal,
    );
  }

  redeemPasswordReset(resetId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.passwordResetCall(
      `/api/pos/password-reset/${encodeURIComponent(resetId)}/redeem`,
      'POST',
      signal,
    );
  }

  async stopAllCloudServices(signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    await this.setDiagnosticsConsent(false, signal);
    this.stop();
    this.upsertSettings({
      cloud_sync_enabled: '0',
      cloud_orders_enabled: '0',
      cloud_reports_enabled: '0',
      cloud_command_polling_enabled: '0',
      diagnostics_consent: 'false',
      telemetry_enabled: 'false',
      anonymous_data_consent: 'false',
      cloud_services_disabled_by_user: 'true',
      cloud_connected: 'false',
    });
    this.reload();
    return this.getStatus();
  }

  async deleteCloudData(signal?: AbortSignal): Promise<Record<string, unknown>> {
    throwIfRequestAborted(signal);
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion already in progress');
    const currentSettings = this.readSettings(getDatabase());
    if (
      isCloudDeletionBlocking(currentSettings.cloud_deletion_status) &&
      currentSettings.cloud_deletion_status !== 'failed'
    ) {
      throw new Error(
        'Cloud deletion is already pending; resolve or retry it before submitting another request',
      );
    }
    this.cloudDeletionInProgress = true;
    let deletionOutcome: 'unknown' | 'rejected' = 'unknown';
    return this.withDatabaseRequest(async () => {
      const activeFlushes = [
        this.outboxFlushPromise,
        this.supportFlushPromise,
        this.diagnosticsFlushPromise,
      ].filter((promise): promise is Promise<void> => promise !== null);
      this.stop();
      if (activeFlushes.length > 0) await Promise.allSettled(activeFlushes);
      await this.waitForCloudNetworkIdle();
      const db = getDatabase();
      // Persist deletion intent locally before remote purge to prevent sync resumption.
      db.transaction(() => {
        db.prepare('DELETE FROM cloud_sync_outbox').run();
        db.prepare('DELETE FROM support_ticket_outbox').run();
        db.prepare('DELETE FROM store_diagnostics_outbox').run();
        this.upsertSettings(
          {
            cloud_registration_status: 'deletion_pending',
            cloud_connected: 'false',
            cloud_sync_enabled: '0',
            cloud_orders_enabled: '0',
            cloud_reports_enabled: '0',
            cloud_command_polling_enabled: '0',
            diagnostics_consent: 'false',
            telemetry_enabled: 'false',
            anonymous_data_consent: 'false',
            cloud_services_disabled_by_user: 'true',
            cloud_deletion_request_id: '',
            cloud_deletion_status_token: '',
            cloud_deletion_status: 'pending',
            cloud_deletion_outcome: '',
            cloud_last_error: '',
          },
          true,
        );
      })();
      const res = await this.signedFetch(
        '/api/pos/cloud-data/delete',
        {
          method: 'POST',
          body: JSON.stringify({ confirmation: 'DELETE CLOUD DATA' }),
          signal,
        },
        true,
      );
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      throwIfRequestAborted(signal);
      if (!res.ok) {
        deletionOutcome = 'rejected';
        throw new Error(String(data?.error || `Cloud deletion failed (${res.status})`));
      }
      const deletion = validateCloudDeletionResponse(data);
      const responseData: Record<string, unknown> = { status: deletion.status };
      if (deletion.requestId) responseData.request_id = deletion.requestId;
      if (deletion.status === 'rejected' || deletion.status === 'cancelled') {
        deletionOutcome = 'rejected';
        throw new Error(`Cloud deletion was ${deletion.status}`);
      }
      const deletionStatus = deletion.status;
      const deletionComplete = CLOUD_DELETION_FINAL_STATUSES.has(deletionStatus);
      const deletionSettings: Record<string, string> = {
        cloud_registration_status: deletionComplete ? 'deleted' : 'deletion_pending',
        cloud_connected: 'false',
        cloud_sync_enabled: '0',
        cloud_orders_enabled: '0',
        cloud_reports_enabled: '0',
        cloud_command_polling_enabled: '0',
        diagnostics_consent: 'false',
        telemetry_enabled: 'false',
        anonymous_data_consent: 'false',
        telemetry_anon_id: crypto.randomUUID(),
        cloud_services_disabled_by_user: 'true',
        cloud_deletion_request_id: deletionComplete ? '' : deletion.requestId,
        cloud_deletion_status_token: deletionComplete ? '' : deletion.statusToken,
        cloud_deletion_status: deletionStatus,
        cloud_deletion_outcome: '',
      };
      if (deletionComplete)
        Object.assign(deletionSettings, {
          cloud_api_key: '',
          cloud_store_id: '',
          cloud_pos_id: '',
          cloud_pos_hash: '',
          cloud_device_secret: '',
          cloud_device_created_at: '',
          cloud_email_verified: 'false',
          cloud_email_verification_sent_at: '',
          cloud_verification_welcome_requested: '0',
        });
      db.transaction(() => {
        db.prepare('DELETE FROM cloud_sync_outbox').run();
        db.prepare('DELETE FROM support_ticket_outbox').run();
        db.prepare('DELETE FROM store_diagnostics_outbox').run();
        this.upsertSettings(deletionSettings, true);
      })();
      this.stop();
      this.settings = this.loadSettings(false);
      return responseData;
    }, signal)
      .catch((error) => {
        if (!this.shutdownRequested) {
          this.upsertSettings(
            {
              cloud_deletion_status: 'failed',
              cloud_deletion_outcome: deletionOutcome,
              cloud_connected: 'false',
              cloud_last_error: 'Cloud data deletion failed',
            },
            true,
          );
          this.settings = this.loadSettings(false);
        }
        throw error;
      })
      .finally(() => {
        this.cloudDeletionInProgress = false;
      });
  }

  async getDeletionRequestStatus(
    options: { allowRemote?: boolean; signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown> | null> {
    throwIfRequestAborted(options.signal);
    return this.withDatabaseRequest(async () => {
      throwIfRequestAborted(options.signal);
      const settings = this.readSettings(getDatabase());
      const requestId = settings.cloud_deletion_request_id;
      const statusToken = settings.cloud_deletion_status_token;
      if (!requestId || !statusToken) return null;
      if (options.allowRemote === false) {
        return {
          request_id: requestId,
          status: settings.cloud_deletion_status || 'pending',
        };
      }
      const serverUrl = normalizeCloudServerUrl(
        settings.cloud_server_url || DEFAULT_CLOUD_SERVER_URL,
      );
      const url = endpoint(
        serverUrl,
        `/api/cloud-data/deletion-request/status?id=${encodeURIComponent(requestId)}&token=${encodeURIComponent(statusToken)}`,
      );
      const res = await this.trackedFetch(url, { signal: requestSignal(options.signal) });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throwIfRequestAborted(options.signal);
      if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
      if (!res.ok) throw new Error(String(data.error || `Deletion status failed (${res.status})`));
      const deletion = validateCloudDeletionResponse(data, requestId, statusToken);
      const status = deletion.status;
      this.upsertSettings({
        cloud_deletion_status: status,
        cloud_deletion_request_id: deletion.requestId,
        cloud_deletion_status_token: deletion.statusToken,
        cloud_last_error: '',
      });
      if (CLOUD_DELETION_FINAL_STATUSES.has(status)) {
        this.upsertSettings({
          cloud_api_key: '',
          cloud_store_id: '',
          cloud_pos_id: '',
          cloud_pos_hash: '',
          cloud_device_secret: '',
          cloud_device_created_at: '',
          cloud_registration_status: 'deleted',
          cloud_email_verified: 'false',
          cloud_email_verification_sent_at: '',
          cloud_verification_welcome_requested: '0',
          cloud_deletion_request_id: '',
          cloud_deletion_status_token: '',
          cloud_deletion_outcome: '',
        });
        this.settings = this.loadSettings(false);
      } else if (['cancelled', 'rejected'].includes(status)) {
        this.upsertSettings({
          cloud_registration_status: 'registered',
          cloud_deletion_request_id: '',
          cloud_deletion_status_token: '',
          cloud_deletion_outcome: '',
        });
        this.settings = this.loadSettings(false);
      }
      return data;
    }, options.signal).catch((error) => {
      if (!this.cloudDeletionInProgress && !this.shutdownRequested) {
        this.upsertSettings({
          cloud_deletion_status: 'failed',
          cloud_deletion_outcome: 'unknown',
          cloud_connected: 'false',
          cloud_last_error: 'Cloud deletion status check failed',
        });
        this.settings = this.loadSettings(false);
      }
      throw error;
    });
  }

  async cancelDeletionRequest(signal?: AbortSignal): Promise<Record<string, unknown>> {
    throwIfRequestAborted(signal);
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    return this.withDatabaseRequest(async () => {
      if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
      const settings = this.readSettings(getDatabase());
      if (!settings.cloud_deletion_request_id) throw new Error('No pending deletion request');
      const res = await this.signedFetch(
        '/api/pos/cloud-data/deletion-request/cancel',
        {
          method: 'POST',
          body: JSON.stringify({ request_id: settings.cloud_deletion_request_id }),
          signal,
        },
        true,
      );
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throwIfRequestAborted(signal);
      if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
      if (!res.ok) throw new Error(String(data.error || `Cancellation failed (${res.status})`));
      this.upsertSettings({
        cloud_deletion_status: 'cancelled',
        cloud_registration_status: 'registered',
        cloud_deletion_request_id: '',
        cloud_deletion_status_token: '',
        cloud_deletion_outcome: '',
      });
      return { status: typeof data.status === 'string' ? data.status : 'cancelled' };
    }, signal);
  }

  /** Persists and synchronizes an explicit local diagnostics choice. */
  async setDiagnosticsConsent(enabled: boolean, signal?: AbortSignal): Promise<void> {
    const db = getDatabase();
    const existingPending =
      (
        db
          .prepare("SELECT value FROM settings WHERE key = 'diagnostics_consent_sync_pending'")
          .get() as { value: string } | undefined
      )?.value === 'true';
    const existingChangeId = (
      db.prepare("SELECT value FROM settings WHERE key = 'diagnostics_consent_change_id'").get() as
        | { value: string }
        | undefined
    )?.value;
    const changeId =
      existingPending && isOperationReference(existingChangeId)
        ? existingChangeId
        : crypto.randomUUID();
    db.transaction(() => {
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_settings_explicit', 'true', ?)
        ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at`).run(
        now(),
      );
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_consent_sync_pending', 'true', ?)
        ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at`).run(
        now(),
      );
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_consent_change_id', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(
        changeId,
        now(),
      );
    })();
    const requestedEnabled =
      enabled && isDiagnosticsConsentEnabled() && isDiagnosticsTransmissionEnabled();
    await this.postDiagnosticsConsent(requestedEnabled, changeId, false, signal);
    this.refreshDiagnosticsOutbox(this.loadSettings(false), requestedEnabled);
  }

  private async postDiagnosticsConsent(
    enabled: boolean,
    changeId: string,
    initializeIfUnconfigured: boolean,
    signal?: AbortSignal,
  ): Promise<{ enabled: boolean; revision: number } | null> {
    try {
      const db = getDatabase();
      const body = {
        schema_version: 2,
        enabled,
        change_id: changeId,
        ...(initializeIfUnconfigured ? { initialize_if_unconfigured: true } : {}),
      };
      const res = await this.signedFetch('/api/pos/diagnostics-consent', {
        method: 'POST',
        body: JSON.stringify(body),
        signal,
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const keys = data && Object.keys(data).sort().join(',');
      if (
        res.status === 409 &&
        keys === 'disposition,enabled,reason_code,revision,schema_version' &&
        data?.schema_version === 2 &&
        data.disposition === 'rejected' &&
        data.enabled === false &&
        data.reason_code === 'deletion_pending' &&
        Number.isSafeInteger(data.revision) &&
        (data.revision as number) >= 0
      ) {
        const currentChangeId = (
          getDatabase()
            .prepare("SELECT value FROM settings WHERE key = 'diagnostics_consent_change_id'")
            .get() as { value: string } | undefined
        )?.value;
        if (currentChangeId !== changeId) return null;
        db.transaction(() => {
          for (const [key, value] of [
            ['diagnostics_consent', 'false'],
            ['diagnostics_transmission_enabled', 'false'],
            ['diagnostics_settings_explicit', 'true'],
            ['diagnostics_consent_sync_pending', 'false'],
            ['diagnostics_consent_remote_initialized', 'true'],
            ['diagnostics_consent_revision', String(data.revision)],
          ]) {
            db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(
              key,
              value,
              now(),
            );
          }
        })();
        return { enabled: false, revision: data.revision as number };
      }
      if (
        !res.ok ||
        data?.schema_version !== 2 ||
        data.disposition !== 'accepted' ||
        keys !== 'disposition,enabled,revision,schema_version' ||
        typeof data.enabled !== 'boolean' ||
        !Number.isSafeInteger(data.revision) ||
        (data.revision as number) < 0 ||
        (!initializeIfUnconfigured && data.enabled !== enabled)
      ) {
        log.debug('[CloudSync] diagnostics consent acknowledgment was invalid');
        return null;
      }
      const currentChangeId = (
        getDatabase()
          .prepare("SELECT value FROM settings WHERE key = 'diagnostics_consent_change_id'")
          .get() as { value: string } | undefined
      )?.value;
      if (currentChangeId !== changeId) return null;
      db.prepare(`UPDATE settings SET value = 'false', updated_at = ?
        WHERE key = 'diagnostics_consent_sync_pending'
          AND EXISTS (SELECT 1 FROM settings WHERE key = 'diagnostics_consent_change_id' AND value = ?)`).run(
        now(),
        changeId,
      );
      if (initializeIfUnconfigured && !data.enabled) {
        db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_consent', 'false', ?)
          ON CONFLICT(key) DO UPDATE SET value = 'false', updated_at = excluded.updated_at`).run(
          now(),
        );
        db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_settings_explicit', 'true', ?)
          ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at`).run(
          now(),
        );
      }
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_consent_revision', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(
        String(data.revision),
        now(),
      );
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_consent_remote_initialized', 'true', ?)
        ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at`).run(
        now(),
      );
      return { enabled: data.enabled, revision: data.revision as number };
    } catch (err) {
      if (signal?.aborted) throw err;
      log.debug('[CloudSync] diagnostics consent sync failed (non-fatal)');
      return null;
    }
  }

  private async reconcileDiagnosticsConsent(): Promise<boolean> {
    const db = getDatabase();
    const cfg = this.loadSettings(false);
    if (!cfg?.api_key || !cfg.sync_enabled || isCloudDeletionBlocking(cfg.cloud_deletion_status))
      return false;
    const pending =
      (
        db
          .prepare("SELECT value FROM settings WHERE key = 'diagnostics_consent_sync_pending'")
          .get() as { value: string } | undefined
      )?.value === 'true';
    if (pending) {
      const changeId = (
        db
          .prepare("SELECT value FROM settings WHERE key = 'diagnostics_consent_change_id'")
          .get() as { value: string } | undefined
      )?.value;
      if (!isOperationReference(changeId)) return false;
      const explicit =
        (
          db
            .prepare("SELECT value FROM settings WHERE key = 'diagnostics_settings_explicit'")
            .get() as { value: string } | undefined
        )?.value === 'true';
      const initialized =
        (
          db
            .prepare(
              "SELECT value FROM settings WHERE key = 'diagnostics_consent_remote_initialized'",
            )
            .get() as { value: string } | undefined
        )?.value === 'true';
      const response = await this.postDiagnosticsConsent(
        isDiagnosticsConsentEnabled() && isDiagnosticsTransmissionEnabled(),
        changeId,
        !explicit && !initialized,
      );
      if (!response) return false;
      const stillPending =
        (
          db
            .prepare("SELECT value FROM settings WHERE key = 'diagnostics_consent_sync_pending'")
            .get() as { value: string } | undefined
        )?.value === 'true';
      return (
        !stillPending &&
        response.enabled &&
        isDiagnosticsConsentEnabled() &&
        isDiagnosticsTransmissionEnabled()
      );
    }

    try {
      const res = await this.signedFetch('/api/pos/diagnostics-consent', { method: 'GET' });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (
        !res.ok ||
        data?.schema_version !== 2 ||
        typeof data.enabled !== 'boolean' ||
        Object.keys(data).sort().join(',') !== 'enabled,initialized,revision,schema_version' ||
        !Number.isSafeInteger(data.revision) ||
        (data.revision as number) < 0 ||
        typeof data.initialized !== 'boolean'
      )
        return false;
      const explicit =
        (
          db
            .prepare("SELECT value FROM settings WHERE key = 'diagnostics_settings_explicit'")
            .get() as { value: string } | undefined
        )?.value === 'true';
      if (explicit && (!isDiagnosticsConsentEnabled() || !isDiagnosticsTransmissionEnabled())) {
        const changeId = crypto.randomUUID();
        db.transaction(() => {
          db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_consent_sync_pending', 'true', ?)
            ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at`).run(
            now(),
          );
          db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_consent_change_id', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(
            changeId,
            now(),
          );
        })();
        const response = await this.postDiagnosticsConsent(false, changeId, false);
        return (
          response?.enabled === false &&
          !(
            (
              db
                .prepare(
                  "SELECT value FROM settings WHERE key = 'diagnostics_consent_sync_pending'",
                )
                .get() as { value: string } | undefined
            )?.value === 'true'
          )
        );
      }
      if (!data.initialized) {
        const eligibleForDefault =
          !explicit && isDiagnosticsConsentEnabled() && isDiagnosticsTransmissionEnabled();
        const changeId = crypto.randomUUID();
        db.transaction(() => {
          db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_consent_sync_pending', 'true', ?)
            ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at`).run(
            now(),
          );
          db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_consent_change_id', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(
            changeId,
            now(),
          );
        })();
        const response = await this.postDiagnosticsConsent(
          eligibleForDefault,
          changeId,
          eligibleForDefault,
        );
        return response?.enabled === true && isDiagnosticsTransmissionEnabled();
      }
      db.transaction(() => {
        db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_consent', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(
          data.enabled ? 'true' : 'false',
          now(),
        );
        if (!data.enabled) {
          db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_settings_explicit', 'true', ?)
            ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at`).run(
            now(),
          );
        }
        db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_consent_revision', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(
          String(data.revision),
          now(),
        );
        db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('diagnostics_consent_remote_initialized', 'true', ?)
          ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at`).run(
          now(),
        );
      })();
      return data.enabled && isDiagnosticsTransmissionEnabled();
    } catch {
      return false;
    }
  }

  /** Queue a support request durably; the caller can be offline. */
  async queueSupportTicket(
    input: SupportTicketInput,
    signal?: AbortSignal,
  ): Promise<{ queued: boolean; client_ticket_id: string }> {
    throwIfRequestAborted(signal);
    if (this.cloudDeletionInProgress || this.shutdownRequested)
      return { queued: false, client_ticket_id: input.client_ticket_id };
    const payload = {
      client_ticket_id: input.client_ticket_id,
      subject: input.subject,
      message: input.message,
      severity: input.severity || 'normal',
      event_code: input.event_code,
      correlation_id: input.correlation_id,
      contact: { name: input.contact_name, email: input.contact_email, phone: input.contact_phone },
      app_version: require('../../package.json').version,
      platform: process.platform,
      diagnostics: input.diagnostics,
      log_tail: input.log_tail,
    };
    return this.withDatabaseRequest(async () => {
      throwIfRequestAborted(signal);
      if (this.cloudDeletionInProgress || this.shutdownRequested)
        return { queued: false, client_ticket_id: input.client_ticket_id };
      const db = getDatabase();
      const timestamp = now();
      db.prepare(`
        INSERT OR IGNORE INTO support_ticket_outbox
          (client_ticket_id, payload, status, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?)
      `).run(input.client_ticket_id, JSON.stringify(payload), timestamp, timestamp);
      this.runBackground(this.flushSupportTicketOutbox(), 'support outbox flush');
      return { queued: true, client_ticket_id: input.client_ticket_id };
    }, signal);
  }

  private flushSupportTicketOutbox(): Promise<void> {
    if (this.cloudDeletionInProgress || this.shutdownRequested) return Promise.resolve();
    if (this.supportFlushPromise) return this.supportFlushPromise;
    const run = this.withDatabaseRequest(async () => {
      if (this.cloudDeletionInProgress || this.shutdownRequested) return;
      const cfg = this.settings ?? this.loadSettings();
      if (!cfg?.sync_enabled || !cfg.api_key || this.supportFlushing) return;
      this.supportFlushing = true;
      try {
        const db = getDatabase();
        db.prepare(
          "UPDATE support_ticket_outbox SET status = 'failed', next_attempt_at = ?, updated_at = ? WHERE status = 'sending'",
        ).run(now(), now());
        const rows = db
          .prepare(`
      SELECT * FROM support_ticket_outbox
       WHERE status IN ('pending', 'failed')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC LIMIT 10
    `)
          .all(now()) as Array<{
          client_ticket_id: string;
          payload: string;
          attempt_count: number;
        }>;
        if (rows.length === 0) return;

        try {
          for (const row of rows) {
            db.prepare(
              `UPDATE support_ticket_outbox SET status = 'sending', updated_at = ? WHERE client_ticket_id = ?`,
            ).run(now(), row.client_ticket_id);
            const res = await this.signedFetch('/api/pos/support-ticket', {
              method: 'POST',
              body: row.payload,
            });
            const data = (await res.json().catch(() => ({}))) as { support_code?: string };
            if (this.cloudDeletionInProgress || this.shutdownRequested) return;
            if (!res.ok) throw new Error(`support ticket submission failed (${res.status})`);
            db.prepare(`
          UPDATE support_ticket_outbox
             SET status = 'delivered', support_code = ?, delivered_at = ?, updated_at = ?, last_error = NULL
           WHERE client_ticket_id = ?
        `).run(data.support_code || null, now(), now(), row.client_ticket_id);
          }
          this.upsertSettings({ cloud_connected: 'true', cloud_last_error: '' });
        } catch (err) {
          if (this.shutdownRequested) return;
          const message = (err as Error).message;
          const rowsToFail = db
            .prepare(
              `SELECT client_ticket_id, attempt_count FROM support_ticket_outbox WHERE status = 'sending'`,
            )
            .all() as Array<{ client_ticket_id: string; attempt_count: number }>;
          for (const row of rowsToFail) {
            const attempts = row.attempt_count + 1;
            const delayMs = Math.min(30 * 60_000, Math.pow(2, Math.min(attempts, 8)) * 1000);
            // Format timestamp with space to match SQLite now() lexicographical comparison.
            const nextAttemptAt = new Date(Date.now() + delayMs)
              .toISOString()
              .replace('T', ' ')
              .replace(/\..*$/, '');
            db.prepare(`
          UPDATE support_ticket_outbox
             SET status = 'failed', attempt_count = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
           WHERE client_ticket_id = ?
        `).run(attempts, nextAttemptAt, message, now(), row.client_ticket_id);
          }
          this.markError(message);
        }
      } finally {
        this.supportFlushing = false;
      }
    });
    this.supportFlushPromise = run.finally(() => {
      this.supportFlushPromise = null;
    });
    return this.supportFlushPromise;
  }

  // Legacy event capture remains local. Automatic transmission uses the closed
  // v2 operation registry so source-derived signatures never enter the outbox.
  reportDiagnostic(input: DiagnosticEventInput, error?: unknown): void {
    if (this.cloudDeletionInProgress || this.shutdownRequested) return;
    if (!isAllowedDiagnosticEventCode(input.event_code)) return;
    if (!ALLOWED_DIAGNOSTIC_SEVERITIES.has(input.severity)) return;
    if (typeof input.event_id !== 'string' || !DIAGNOSTIC_ID_RE.test(input.event_id)) return;
    const metadata = sanitizeDiagnosticMetadata(input.event_code, input.metadata);
    // A handler that catches a non-Error throw has no `.message`; the thrown value
    // itself is then the only text there is, and a string throw is the message.
    const thrown =
      error === undefined || error === null
        ? input.message
        : typeof error === 'string'
          ? error
          : typeof (error as { message?: unknown }).message === 'string'
            ? (error as { message: string }).message
            : input.message;
    const derived = deriveDiagnosticSignature(
      error ? { errorClass: errorClassOf(error), message: thrown } : { message: thrown },
    );
    const summary = derived.is_informative
      ? derived.summary
      : describeDiagnosticFailure(input.event_code, metadata, derived.error_class);
    const sanitized: DiagnosticEventInput = {
      event_id: input.event_id,
      event_code: input.event_code,
      severity: input.severity,
      message: derived.signature,
      ...(typeof input.correlation_id === 'string' && DIAGNOSTIC_ID_RE.test(input.correlation_id)
        ? { correlation_id: input.correlation_id }
        : {}),
      ...(metadata ? { metadata } : {}),
      occurred_at:
        typeof input.occurred_at === 'string' && input.occurred_at.length <= 64
          ? input.occurred_at
          : new Date().toISOString(),
    };
    this.runBackground(
      this.withDatabaseRequest(() => {
        if (this.cloudDeletionInProgress || this.shutdownRequested) return;
        const db = getDatabase();
        const timestamp = now();
        recordLocalDiagnostic(
          db,
          {
            event_code: sanitized.event_code,
            severity: sanitized.severity,
            error_class: derived.error_class,
            signature: derived.signature,
            summary,
            metadata,
            occurred_at: sanitized.occurred_at,
          },
          timestamp,
        );
      }),
      'diagnostic enqueue',
      (enqueueError) => this.markError((enqueueError as Error).message),
    );
  }

  /** Capture a registry-approved occurrence into the bounded local hourly aggregate. */
  captureOperationFailure(input: {
    capture_point: unknown;
    outcome: unknown;
    correlation_id?: unknown;
    facts?: unknown;
    occurred_at?: unknown;
  }): void {
    if (this.cloudDeletionInProgress || this.shutdownRequested) return;
    const failure = serializeOperationFailure(input);
    if (!failure) return;
    const occurredAt = diagnosticOccurrenceTime(input.occurred_at);
    const windowStart = diagnosticWindowStart(occurredAt);
    const appVersion = diagnosticAppVersion();
    const appBuild = diagnosticBuildIdentity();
    const platform = ['win32', 'darwin', 'linux'].includes(process.platform)
      ? process.platform
      : 'unknown';
    const facts = canonicalDiagnosticFacts(failure.facts);
    const aggregateKey = sha256Hex(
      JSON.stringify([
        failure.operation,
        failure.stage,
        failure.reason_code,
        failure.capture_point,
        failure.outcome,
        windowStart,
        appVersion,
        appBuild,
        platform,
        facts,
      ]),
    );
    const timestamp = now();

    this.runBackground(
      this.withDatabaseRequest(() => {
        if (this.cloudDeletionInProgress || this.shutdownRequested) return;
        const db = getDatabase();
        const safeMetadata = {
          capture_point: failure.capture_point,
          operation: failure.operation,
          stage: failure.stage,
          reason_code: failure.reason_code,
          classification: failure.classification,
          outcome: failure.outcome,
          ...(failure.correlation_id ? { correlation_id: failure.correlation_id } : {}),
          ...facts,
        };
        const displaySummary = `${failure.operation} failed during ${failure.stage} (${failure.reason_code}).`;
        const transaction = db.transaction(() => {
          recordLocalDiagnostic(
            db,
            {
              event_code: failure.reason_code,
              severity: failure.classification === 'expected_rejection' ? 'warn' : 'error',
              error_class: failure.classification,
              signature: `${failure.operation}:${failure.stage}:${failure.reason_code}`,
              summary: displaySummary,
              metadata: safeMetadata,
              occurred_at: occurredAt,
            },
            timestamp,
          );

          const existing = db
            .prepare('SELECT * FROM diagnostics_hourly_aggregates WHERE aggregate_key = ?')
            .get(aggregateKey) as
            | {
                count: number;
                first_occurred_at: string;
                last_occurred_at: string;
                examples_json: string;
              }
            | undefined;
          if (existing) {
            if (
              !Number.isSafeInteger(existing.count) ||
              existing.count >= Number.MAX_SAFE_INTEGER
            ) {
              addDiagnosticsDeliveryGap(db, 'local_retention', 1);
              return;
            }
            let examples: string[] = [];
            try {
              const parsed = JSON.parse(existing.examples_json);
              if (Array.isArray(parsed))
                examples = parsed
                  .filter(
                    (item) =>
                      typeof item === 'string' &&
                      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                        item,
                      ),
                  )
                  .slice(0, 3);
            } catch {
              /* keep the bounded example list empty */
            }
            if (
              failure.correlation_id &&
              !examples.includes(failure.correlation_id) &&
              examples.length < 3
            )
              examples.push(failure.correlation_id);
            db.prepare(`UPDATE diagnostics_hourly_aggregates
            SET count = count + 1, first_occurred_at = MIN(first_occurred_at, ?),
                last_occurred_at = MAX(last_occurred_at, ?), examples_json = ?, updated_at = ?
            WHERE aggregate_key = ?`).run(
              occurredAt,
              occurredAt,
              JSON.stringify(examples),
              timestamp,
              aggregateKey,
            );
            return;
          }

          const aggregateCount = (
            db.prepare('SELECT COUNT(*) AS count FROM diagnostics_hourly_aggregates').get() as {
              count: number;
            }
          ).count;
          if (aggregateCount >= DIAGNOSTIC_LOG_MAX_ROWS) {
            addDiagnosticsDeliveryGap(db, 'local_retention', 1);
            return;
          }
          db.prepare(`INSERT INTO diagnostics_hourly_aggregates (
          aggregate_key, capture_point, reason_code, classification, operation, stage, outcome,
          window_start, count, first_occurred_at, last_occurred_at, app_version, app_build, platform,
          examples_json, facts_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            aggregateKey,
            failure.capture_point,
            failure.reason_code,
            failure.classification,
            failure.operation,
            failure.stage,
            failure.outcome,
            windowStart,
            occurredAt,
            occurredAt,
            appVersion,
            appBuild,
            platform,
            JSON.stringify(failure.correlation_id ? [failure.correlation_id] : []),
            JSON.stringify(facts),
            timestamp,
          );
        });
        transaction();
        const cfg = this.loadSettings(false);
        if (
          isDiagnosticsConsentEnabled() &&
          isDiagnosticsTransmissionEnabled() &&
          ((cfg?.sync_enabled && cfg.api_key) || isTelemetryEnabled())
        ) {
          this.runBackground(this.flushDiagnosticsOutbox(), 'diagnostics outbox flush');
        }
      }),
      'diagnostic capture',
      (captureError) => this.markError((captureError as Error).message),
    );
  }

  /** Safe counts for the diagnostics screen; never includes report bytes or raw errors. */
  listDiagnosticDeliveryHealth(): {
    effective_consent: boolean;
    transmission_enabled: boolean;
    consent_sync_pending: boolean;
    delayed: boolean;
    transport: 'signed' | 'anonymous' | 'local' | 'disabled';
    pending_reports: number;
    pending_occurrences: number;
    pending_aggregates: number;
    pending_aggregate_occurrences: number;
    permanently_rejected_reports: number;
    gaps: Array<{ reason_code: DiagnosticsGapReason; count: number }>;
  } {
    const db = getDatabase();
    const reports = db
      .prepare(
        `SELECT payload FROM store_diagnostics_outbox WHERE status IN ('pending', 'failed', 'sending') AND permanent_failure = 0`,
      )
      .all() as Array<{ payload: string }>;
    const permanent = db
      .prepare('SELECT COUNT(*) AS count FROM store_diagnostics_outbox WHERE permanent_failure = 1')
      .get() as { count: number };
    const pendingAggregate = db
      .prepare(
        'SELECT COUNT(*) AS count, COALESCE(SUM(count), 0) AS occurrences FROM diagnostics_hourly_aggregates',
      )
      .get() as { count: number; occurrences: number };
    const gaps = db
      .prepare(
        'SELECT reason_code, count FROM diagnostics_delivery_gaps WHERE count > 0 ORDER BY reason_code',
      )
      .all() as Array<{ reason_code: DiagnosticsGapReason; count: number }>;
    const effectiveConsent = isDiagnosticsConsentEnabled();
    const transmissionEnabled = isDiagnosticsTransmissionEnabled();
    const consentSyncPending =
      (
        db
          .prepare("SELECT value FROM settings WHERE key = 'diagnostics_consent_sync_pending'")
          .get() as { value: string } | undefined
      )?.value === 'true';
    const cfg = this.loadSettings(false);
    const signedAvailable = Boolean(cfg?.sync_enabled && cfg.api_key);
    const transportBlocked =
      this.cloudDeletionInProgress ||
      isCloudDeletionBlocking(cfg?.cloud_deletion_status || '') ||
      (signedAvailable && consentSyncPending);
    const transport: 'signed' | 'anonymous' | 'local' | 'disabled' =
      !effectiveConsent || !transmissionEnabled || transportBlocked
        ? 'disabled'
        : signedAvailable
          ? 'signed'
          : isTelemetryEnabled()
            ? 'anonymous'
            : 'local';
    const pendingOccurrences = reports.reduce(
      (sum, row) => sum + diagnosticPayloadCount(row.payload),
      0,
    );
    const delayed = reports.length > 0 || pendingAggregate.count > 0 || gaps.length > 0;
    return {
      effective_consent: effectiveConsent,
      transmission_enabled: transmissionEnabled,
      consent_sync_pending: consentSyncPending,
      delayed,
      transport,
      pending_reports: reports.length,
      pending_occurrences: pendingOccurrences,
      pending_aggregates: pendingAggregate.count,
      pending_aggregate_occurrences: pendingAggregate.occurrences,
      permanently_rejected_reports: permanent.count,
      gaps,
    };
  }

  /** Recent locally captured failures, newest first, for the diagnostics screen. */
  listLocalDiagnostics(limit = 50): LocalDiagnostic[] {
    const db = getDatabase();
    const bounded =
      Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, DIAGNOSTIC_LOG_MAX_ROWS) : 50;
    const rows = db
      .prepare(`
      SELECT id, event_code, severity, error_class, signature, summary, metadata_json, occurred_at, created_at
        FROM local_diagnostics ORDER BY id DESC LIMIT ?
    `)
      .all(bounded) as Array<{
      id: number;
      event_code: string;
      severity: string;
      error_class: string;
      signature: string;
      summary: string;
      metadata_json: string | null;
      occurred_at: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      event_code: row.event_code,
      severity: row.severity,
      error_class: row.error_class,
      signature: row.signature,
      summary: row.summary,
      metadata: row.metadata_json ? safeParseMetadata(row.metadata_json) : undefined,
      occurred_at: row.occurred_at,
      created_at: row.created_at,
    }));
  }

  /** Remove every locally captured failure. Nothing has been transmitted, so nothing is withdrawn. */
  clearLocalDiagnostics(): number {
    const db = getDatabase();
    const removed = db.prepare('SELECT COUNT(*) AS count FROM local_diagnostics').get() as {
      count: number;
    };
    db.prepare('DELETE FROM local_diagnostics').run();
    return removed?.count || 0;
  }

  private flushDiagnosticsOutbox(): Promise<void> {
    if (this.cloudDeletionInProgress || this.shutdownRequested) return Promise.resolve();
    if (this.diagnosticsFlushPromise) return this.diagnosticsFlushPromise;
    const run = this.withDatabaseRequest(async () => {
      if (this.cloudDeletionInProgress || this.shutdownRequested) return;
      const cfg = this.loadSettings(false);
      if (!cfg || isCloudDeletionBlocking(cfg.cloud_deletion_status) || this.diagnosticsFlushing)
        return;
      const signedAvailable = cfg.sync_enabled && Boolean(cfg.api_key);
      const transport: DiagnosticTransport | null = signedAvailable
        ? 'signed'
        : isTelemetryEnabled()
          ? 'anonymous'
          : null;
      if (!transport) return;
      if (signedAvailable && !(await this.reconcileDiagnosticsConsent())) return;
      if (!isDiagnosticsConsentEnabled() || !isDiagnosticsTransmissionEnabled()) return;
      if (transport === 'anonymous' && !isTelemetryEnabled()) return;
      this.diagnosticsFlushing = true;
      try {
        const db = getDatabase();
        db.prepare(
          "UPDATE store_diagnostics_outbox SET status = 'failed', next_attempt_at = ?, updated_at = ? WHERE status = 'sending' AND permanent_failure = 0",
        ).run(now(), now());
        db.transaction(() => {
          const hasAggregates =
            (db.prepare('SELECT 1 FROM diagnostics_hourly_aggregates LIMIT 1').get() as
              | { 1: number }
              | undefined) !== undefined;
          const hasGaps =
            (db.prepare('SELECT 1 FROM diagnostics_delivery_gaps WHERE count > 0 LIMIT 1').get() as
              | { 1: number }
              | undefined) !== undefined;
          const aggregateBudget =
            hasAggregates && hasGaps ? DIAGNOSTIC_FLUSH_BATCH - 1 : DIAGNOSTIC_FLUSH_BATCH;
          const aggregateBudgetRemaining = sealDiagnosticAggregates(db, transport, aggregateBudget);
          const aggregateReportsCreated = aggregateBudget - aggregateBudgetRemaining;
          const gapBudget =
            hasAggregates && hasGaps
              ? Math.min(1, DIAGNOSTIC_FLUSH_BATCH - aggregateReportsCreated)
              : DIAGNOSTIC_FLUSH_BATCH - aggregateReportsCreated;
          sealDiagnosticGaps(db, transport, gapBudget);
        })();
        const rows = db
          .prepare(`
      SELECT * FROM store_diagnostics_outbox
       WHERE status IN ('pending', 'failed')
         AND permanent_failure = 0
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC LIMIT ?
    `)
          .all(now(), DIAGNOSTIC_FLUSH_BATCH) as Array<{
          event_id: string;
          payload: string;
          attempt_count: number;
          transport: string;
        }>;
        if (rows.length === 0) return;

        const { isTelemetrySuppressed } = require('./telemetry') as typeof import('./telemetry');
        if (isTelemetrySuppressed()) return;

        for (const row of rows) {
          if (this.cloudDeletionInProgress || this.shutdownRequested) return;
          if (!isDiagnosticsConsentEnabled() || !isDiagnosticsTransmissionEnabled()) return;
          const currentCfg = this.loadSettings(false);
          if (!currentCfg || isCloudDeletionBlocking(currentCfg.cloud_deletion_status)) return;
          const rowTransport: DiagnosticTransport =
            row.transport === 'anonymous' ? 'anonymous' : 'signed';
          if (rowTransport === 'signed' && (!currentCfg.sync_enabled || !currentCfg.api_key))
            continue;
          if (rowTransport === 'anonymous' && !isTelemetryEnabled()) continue;
          db.prepare(
            `UPDATE store_diagnostics_outbox SET status = 'sending', updated_at = ? WHERE event_id = ?`,
          ).run(now(), row.event_id);
          try {
            const report = JSON.parse(row.payload) as Record<string, unknown>;
            if (report.schema_version === 2) {
              if (rowTransport === 'anonymous') {
                const { sendAnonymousDiagnosticReport } =
                  require('./telemetry') as typeof import('./telemetry');
                const delivery = await sendAnonymousDiagnosticReport(report);
                const disposition = delivery.disposition;
                if (disposition === 'accepted' || disposition === 'duplicate') {
                  this.markDiagnosticReportDelivered(db, row.event_id);
                } else if (disposition === 'rejected') {
                  this.markDiagnosticReportRejected(
                    db,
                    row.event_id,
                    row.payload,
                    'permanent_rejection',
                  );
                } else if (disposition === 'invalid_ack') {
                  this.markDiagnosticReportRejected(db, row.event_id, row.payload, 'invalid_ack');
                } else if (disposition === 'report_id_mismatch') {
                  this.markDiagnosticReportRejected(
                    db,
                    row.event_id,
                    row.payload,
                    'report_id_mismatch',
                  );
                } else {
                  this.retryDiagnosticReport(
                    db,
                    row.event_id,
                    row.attempt_count,
                    'network_error',
                    delivery.retry_after_ms,
                  );
                  break;
                }
                continue;
              }
              const response = await this.signedFetch('/api/pos/diagnostics/v2', {
                method: 'POST',
                body: row.payload,
              });
              const ack = (await response.json().catch(() => null)) as Record<
                string,
                unknown
              > | null;
              if (this.cloudDeletionInProgress || this.shutdownRequested) return;
              const ackKeys = ack && Object.keys(ack).sort().join(',');
              const validMatchingReportId = Boolean(
                ack && isOperationReference(ack.report_id) && ack.report_id === row.event_id,
              );
              if (response.status === 408 || response.status === 429 || response.status >= 500) {
                this.retryDiagnosticReport(
                  db,
                  row.event_id,
                  row.attempt_count,
                  `http_${response.status}`,
                  response.headers.get('retry-after'),
                );
                break;
              } else if (
                ack &&
                isOperationReference(ack.report_id) &&
                ack.report_id !== row.event_id
              ) {
                this.markDiagnosticReportRejected(
                  db,
                  row.event_id,
                  row.payload,
                  'report_id_mismatch',
                );
              } else if (
                ack &&
                ackKeys === 'disposition,report_id,schema_version' &&
                ack.schema_version === 2 &&
                (ack.disposition === 'accepted' || ack.disposition === 'duplicate') &&
                validMatchingReportId &&
                response.ok
              ) {
                this.markDiagnosticReportDelivered(db, row.event_id);
              } else if (
                ack &&
                ackKeys === 'disposition,report_id,schema_version' &&
                ack.schema_version === 2 &&
                ack.disposition === 'consent_disabled' &&
                validMatchingReportId &&
                response.ok
              ) {
                db.prepare(
                  `UPDATE settings SET value = 'false', updated_at = ? WHERE key = 'diagnostics_consent'`,
                ).run(now());
                db.prepare(
                  `UPDATE settings SET value = 'true', updated_at = ? WHERE key = 'diagnostics_settings_explicit'`,
                ).run(now());
                db.prepare(
                  `UPDATE settings SET value = 'true', updated_at = ? WHERE key = 'diagnostics_consent_remote_initialized'`,
                ).run(now());
                db.prepare(
                  `UPDATE settings SET value = 'false', updated_at = ? WHERE key = 'diagnostics_consent_sync_pending'`,
                ).run(now());
                db.prepare(
                  `UPDATE store_diagnostics_outbox SET status = 'pending', next_attempt_at = NULL, updated_at = ? WHERE event_id = ?`,
                ).run(now(), row.event_id);
                return;
              } else if (
                ack &&
                ackKeys === 'disposition,report_id,schema_version' &&
                ack.schema_version === 2 &&
                ack.disposition === 'rejected' &&
                validMatchingReportId
              ) {
                this.markDiagnosticReportRejected(
                  db,
                  row.event_id,
                  row.payload,
                  'permanent_rejection',
                );
              } else {
                this.markDiagnosticReportRejected(db, row.event_id, row.payload, 'invalid_ack');
              }
            } else {
              this.markDiagnosticReportRejected(db, row.event_id, row.payload, 'local_retention');
            }
          } catch {
            if (!this.shutdownRequested)
              this.retryDiagnosticReport(db, row.event_id, row.attempt_count, 'network_error');
            break;
          }
        }
      } finally {
        this.diagnosticsFlushing = false;
      }
    });
    this.diagnosticsFlushPromise = run.finally(() => {
      this.diagnosticsFlushPromise = null;
    });
    return this.diagnosticsFlushPromise;
  }

  private markDiagnosticReportDelivered(db: BetterSqlite3.Database, eventId: string): void {
    db.prepare(`UPDATE store_diagnostics_outbox
      SET status = 'delivered', delivered_at = ?, updated_at = ?, last_error = NULL, next_attempt_at = NULL
      WHERE event_id = ?`).run(now(), now(), eventId);
  }

  private markDiagnosticReportRejected(
    db: BetterSqlite3.Database,
    eventId: string,
    payload: string,
    reason: DiagnosticsGapReason,
  ): void {
    db.transaction(() => {
      const report = safeJsonParse(payload) as {
        capture_point?: unknown;
        facts?: { gap_reason?: unknown; gap_count?: unknown };
      } | null;
      if (report?.capture_point !== 'fc.diagnostics.delivery.queue_gap') {
        addDiagnosticsDeliveryGap(db, reason, diagnosticPayloadCount(payload));
      } else {
        const originalReason = report?.facts?.gap_reason;
        const originalCount =
          typeof report?.facts?.gap_count === 'number'
            ? report.facts.gap_count
            : diagnosticPayloadCount(payload);
        if (
          typeof originalReason === 'string' &&
          (DIAGNOSTICS_GAP_REASONS as readonly string[]).includes(originalReason) &&
          originalCount > 0
        ) {
          addDiagnosticsDeliveryGap(db, originalReason as DiagnosticsGapReason, originalCount);
        }
      }
      db.prepare(`UPDATE store_diagnostics_outbox
        SET status = 'failed', permanent_failure = 1, next_attempt_at = NULL, last_error = ?, updated_at = ?
        WHERE event_id = ?`).run(reason, now(), eventId);
    })();
  }

  private retryDiagnosticReport(
    db: BetterSqlite3.Database,
    eventId: string,
    attemptCount: number,
    reason: string,
    retryAfter?: string | number | null,
  ): void {
    const attempts = attemptCount + 1;
    const exponentialDelay = Math.min(30 * 60_000, Math.pow(2, Math.min(attempts, 8)) * 1000);
    const retryAfterMs =
      typeof retryAfter === 'number'
        ? retryAfter
        : retryAfter
          ? parseRetryAfterMs(retryAfter)
          : null;
    const delay =
      retryAfterMs === null
        ? exponentialDelay
        : Math.max(exponentialDelay, Math.min(60 * 60_000, retryAfterMs));
    const nextAttemptAt = new Date(Date.now() + delay)
      .toISOString()
      .replace('T', ' ')
      .replace(/\..*$/, '');
    db.prepare(`UPDATE store_diagnostics_outbox
      SET status = 'failed', attempt_count = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE event_id = ?`).run(attempts, nextAttemptAt, reason, now(), eventId);
  }

  /** Generate or rotate the RevFlo pairing code for this store. */
  async generatePairingCode(revoke: boolean): Promise<{ code: string; expires_at: string }> {
    const res = await this.signedFetch('/api/pos/pairing-code', {
      method: 'POST',
      body: JSON.stringify({ revoke_devices: revoke }),
    });
    const data = (await res.json().catch(() => ({}))) as { code?: string; expires_at?: string };
    if (!res.ok) throw new Error(`Pairing code request failed (${res.status})`);
    return data as { code: string; expires_at: string };
  }

  /** Devices (RevFlo installs) currently paired to this store. */
  async listPairedDevices(): Promise<Record<string, unknown>[]> {
    const res = await this.signedFetch('/api/pos/devices', { method: 'GET' });
    const data = (await res.json().catch(() => ({ devices: [] }))) as {
      devices?: Record<string, unknown>[];
    };
    if (!res.ok) throw new Error(`Device list request failed (${res.status})`);
    return Array.isArray(data.devices) ? data.devices : [];
  }

  // Customer PII is never pushed to the cloud.
  recordOrderChanged(orderId: number | string, eventType = 'order.updated') {
    try {
      if (!this.loadSettings()?.orders_enabled) return;
      const snapshot = this.buildOrderSnapshot(orderId);
      if (snapshot) this.enqueueEvent(eventType, 'order', String(orderId), snapshot);
    } catch (err) {
      log.warn('[CloudSync] order snapshot failed', (err as Error).message);
    }
  }

  sendOrderStatus(orderflowOrderId: string, status: string, note?: string) {
    this.enqueueEvent('order.status', 'order', orderflowOrderId, {
      orderflow_order_id: orderflowOrderId,
      status,
      note,
    });
  }

  private buildHeartbeatPayload(cfg: CloudSettings) {
    const db = getDatabase();
    const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
    const activeOrders = db
      .prepare(`
      SELECT COUNT(*) as count FROM orders
      WHERE status IN ('pending', 'preparing', 'ready', 'served')
    `)
      .get() as { count: number };
    // #208: UTC "today" via the new idx_bills_paid_status_paid_at
    // instead of date() on every row.
    const [ts, te] = utcDayBounds(utcTodayDate());
    const todaySales = db
      .prepare(`
      SELECT
        COALESCE((SELECT SUM(paid_amount) FROM bills WHERE paid_at >= ? AND paid_at < ?), 0)
        - COALESCE((SELECT SUM(CAST(amount_cents AS REAL)) / ? FROM refunds WHERE created_at >= ? AND created_at < ?), 0) as total,
        (SELECT COUNT(*) FROM bills WHERE paid_at >= ? AND paid_at < ?) as count
    `)
      .get(ts, te, minorFactor, ts, te, ts, te) as { total: number; count: number };
    return {
      pos_hash: cfg.pos_hash,
      pos_id: cfg.pos_id || null,
      app_version: require('../../package.json').version,
      device_name: os.hostname(),
      active_orders: activeOrders.count,
      today_sales: todaySales.total,
      today_bills: todaySales.count,
      sent_at: new Date().toISOString(),
    };
  }

  /** HTTP fallback path — used only while the WSS relay is unavailable. */
  private async sendHeartbeat() {
    return this.withDatabaseRequest(async () => {
      if (this.cloudDeletionInProgress || this.shutdownRequested) return;
      const cfg = this.settings;
      if (!cfg?.sync_enabled || !cfg.api_key) return;
      try {
        const body = this.buildHeartbeatPayload(cfg);
        const res = await this.signedFetch('/api/pos/heartbeat', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (this.cloudDeletionInProgress || this.shutdownRequested) return;
        if (!res.ok) throw new Error(`heartbeat failed (${res.status})`);
        this.upsertSettings({
          cloud_connected: 'true',
          cloud_last_error: '',
          cloud_last_heartbeat: new Date().toISOString(),
        });
        this.applyFeatures(data.features);
      } catch (err) {
        this.markError((err as Error).message);
      }
    });
  }

  /** Primary path — heartbeat carried as a frame on the open relay connection. */
  private async sendRelayHeartbeat() {
    return this.withDatabaseRequest(async () => {
      if (this.cloudDeletionInProgress || this.shutdownRequested) return;
      const cfg = this.settings;
      if (!cfg?.sync_enabled || !cfg.api_key || this.relaySocket?.readyState !== WebSocket.OPEN)
        return;
      try {
        const payload = this.buildHeartbeatPayload(cfg);
        this.relaySocket.send(JSON.stringify({ type: 'heartbeat', ...payload }));
        this.upsertSettings({
          cloud_connected: 'true',
          cloud_last_error: '',
          cloud_last_heartbeat: new Date().toISOString(),
        });
      } catch (err) {
        this.markError((err as Error).message);
      }
    });
  }

  private enqueueEvent(eventType: string, entityType: string, entityId: string, payload: unknown) {
    if (this.cloudDeletionInProgress || this.shutdownRequested) return;
    this.runBackground(
      this.withDatabaseRequest(async () => {
        if (this.cloudDeletionInProgress || this.shutdownRequested) return;
        const cfg = this.loadSettings();
        if (!cfg?.sync_enabled) return;
        const db = getDatabase();
        const id = crypto.randomUUID();
        db.prepare(`
        INSERT INTO cloud_sync_outbox
          (id, event_type, entity_type, entity_id, payload, status, attempt_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
      `).run(id, eventType, entityType, entityId || null, JSON.stringify(payload), now(), now());
        this.runBackground(this.flushOutbox(), 'outbox flush');
      }),
      'event enqueue',
      (error) => this.markError((error as Error).message),
    );
  }

  private flushOutbox(): Promise<void> {
    if (this.cloudDeletionInProgress || this.shutdownRequested || this.outboxFlushPromise)
      return this.outboxFlushPromise || Promise.resolve();
    const run = this.withDatabaseRequest(async () => {
      if (this.cloudDeletionInProgress || this.shutdownRequested) return;
      const cfg = this.settings ?? this.loadSettings();
      if (!cfg?.sync_enabled || !cfg.api_key || this.flushing) return;
      this.flushing = true;
      try {
        const db = getDatabase();
        db.prepare(
          "UPDATE cloud_sync_outbox SET status = 'failed', next_attempt_at = ?, updated_at = ? WHERE status = 'sending'",
        ).run(now(), now());
        const rows = db
          .prepare(`
        SELECT * FROM cloud_sync_outbox
        WHERE status IN ('pending', 'failed')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at ASC
        LIMIT 50
      `)
          .all(now()) as OutboxRow[];
        if (rows.length === 0) return;

        const events = rows.map((row) => ({
          id: row.id,
          type: row.event_type,
          entity_type: row.entity_type,
          entity_id: row.entity_id,
          payload:
            row.entity_type === 'order'
              ? sanitizeOrderSnapshot(safeJsonParse(row.payload))
              : safeJsonParse(row.payload),
        }));

        const updateStmt = db.prepare(
          `UPDATE cloud_sync_outbox SET status = 'sending', updated_at = ? WHERE id = ?`,
        );
        for (const row of rows) {
          updateStmt.run(now(), row.id);
        }

        const res = await this.signedFetch('/api/pos/events', {
          method: 'POST',
          body: JSON.stringify({
            pos_hash: cfg.pos_hash,
            events,
            sent_at: new Date().toISOString(),
          }),
        });
        await this.drainResponse(res);
        if (this.cloudDeletionInProgress || this.shutdownRequested) return;
        if (!res.ok) throw new Error(`event push failed (${res.status})`);

        const markDelivered = db.prepare(`
        UPDATE cloud_sync_outbox
        SET status = 'delivered', delivered_at = ?, updated_at = ?, last_error = NULL
        WHERE id = ?
      `);
        const deliveredAt = now();
        for (const row of rows) markDelivered.run(deliveredAt, deliveredAt, row.id);
        this.upsertSettings({
          cloud_connected: 'true',
          cloud_last_sync: new Date().toISOString(),
          cloud_last_error: '',
        });
      } catch (err) {
        if (!this.shutdownRequested) this.failSendingRows((err as Error).message);
      } finally {
        this.flushing = false;
      }
    });
    this.outboxFlushPromise = run.finally(() => {
      this.outboxFlushPromise = null;
    });
    return this.outboxFlushPromise;
  }

  private failSendingRows(message: string) {
    const db = getDatabase();
    const rows = db
      .prepare(`
      SELECT id, attempt_count FROM cloud_sync_outbox WHERE status = 'sending'
    `)
      .all() as { id: string; attempt_count: number }[];
    const stmt = db.prepare(`
      UPDATE cloud_sync_outbox
      SET status = 'failed', attempt_count = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `);
    for (const row of rows) {
      const attempts = row.attempt_count + 1;
      const delayMs = Math.min(30 * 60_000, Math.pow(2, Math.min(attempts, 8)) * 1000);
      // Format timestamp with space to match SQLite now() lexicographical comparison.
      const nextAttemptAt = new Date(Date.now() + delayMs)
        .toISOString()
        .replace('T', ' ')
        .replace(/\..*$/, '');
      stmt.run(attempts, nextAttemptAt, message, now(), row.id);
    }
    this.markError(message);
  }

  private async pollCommands() {
    return this.withDatabaseRequest(async () => {
      if (this.cloudDeletionInProgress || this.shutdownRequested) return;
      const cfg = this.settings;
      if (!cfg?.command_polling_enabled || !cfg.api_key || this.pollingCommands) return;
      this.pollingCommands = true;
      const abortController = new AbortController();
      this.commandPollAbortController = abortController;
      try {
        const res = await this.signedFetch('/api/pos/commands?limit=5', {
          method: 'GET',
          signal: abortController.signal,
        });
        const data = (await res.json().catch(() => ({}))) as { commands?: CloudCommand[] };
        if (
          this.cloudDeletionInProgress ||
          this.shutdownRequested ||
          abortController.signal.aborted
        )
          return;
        if (!res.ok) throw new Error(`command poll failed (${res.status})`);
        const commands = Array.isArray(data.commands) ? data.commands : [];
        for (const command of commands) {
          if (
            this.cloudDeletionInProgress ||
            this.shutdownRequested ||
            abortController.signal.aborted
          )
            return;
          await this.executeCommand(command, abortController.signal);
        }
      } catch (err) {
        if (!this.shutdownRequested && !abortController.signal.aborted)
          this.markError((err as Error).message);
      } finally {
        this.pollingCommands = false;
        if (this.commandPollAbortController === abortController)
          this.commandPollAbortController = null;
      }
    });
  }

  private async executeCommand(command: CloudCommand, signal?: AbortSignal) {
    if (this.cloudDeletionInProgress || this.shutdownRequested || signal?.aborted) return;
    let body: Record<string, unknown>;
    try {
      const result = this.runCommand(command);
      body = {
        version: 1,
        correlation_id: command.correlation_id || command.id,
        ok: true,
        result,
        completed_at: new Date().toISOString(),
      };
    } catch (err) {
      body = {
        version: 1,
        correlation_id: command.correlation_id || command.id,
        ok: false,
        error: (err as Error).message,
        completed_at: new Date().toISOString(),
      };
    }

    const res = await this.signedFetch(
      `/api/pos/commands/${encodeURIComponent(command.id)}/result`,
      {
        method: 'POST',
        body: JSON.stringify(body),
        signal,
      },
    );
    await this.drainResponse(res);
    if (this.cloudDeletionInProgress || this.shutdownRequested || signal?.aborted) return;
    if (!res.ok) throw new Error(`command result failed (${res.status})`);
  }

  /** Same as executeCommand, but for a command pushed over the relay socket — result goes back as a frame, not a POST. */
  private async executeRelayCommand(command: CloudCommand) {
    return this.withDatabaseRequest(async () => {
      if (this.cloudDeletionInProgress || this.shutdownRequested) return;
      let body: Record<string, unknown>;
      try {
        const result = this.runCommand(command);
        body = {
          version: 1,
          correlation_id: command.correlation_id || command.id,
          ok: true,
          result,
          completed_at: new Date().toISOString(),
        };
      } catch (err) {
        body = {
          version: 1,
          correlation_id: command.correlation_id || command.id,
          ok: false,
          error: (err as Error).message,
          completed_at: new Date().toISOString(),
        };
      }
      if (
        !this.cloudDeletionInProgress &&
        !this.shutdownRequested &&
        this.relaySocket?.readyState === WebSocket.OPEN
      ) {
        this.relaySocket.send(JSON.stringify({ type: 'result', id: command.id, ...body }));
      }
    });
  }

  private trackRelayCommand(command: Promise<unknown>): void {
    let tracked: Promise<unknown>;
    tracked = command.finally(() => this.relayCommandPromises.delete(tracked));
    this.relayCommandPromises.add(tracked);
    this.runBackground(tracked, 'relay command');
  }

  private trackCommandPoll(poll: Promise<unknown>): void {
    let tracked: Promise<unknown>;
    tracked = poll.finally(() => this.commandPollPromises.delete(tracked));
    this.commandPollPromises.add(tracked);
    this.runBackground(tracked, 'command polling');
  }

  /** Register on startup to sync updated store metadata with FloAdmin. */
  private maybeAutoRegister() {
    if (isOfflineMode()) return;
    const db = getDatabase();
    const settings = this.readSettings(db);
    if (
      isCloudDeletionBlocking(settings.cloud_deletion_status) ||
      settings.cloud_sync_enabled !== '1' ||
      settings.cloud_services_disabled_by_user === 'true'
    )
      return;
    // Wait until first-run setup writes a business name before registering.
    if (!settings.business_name?.trim()) return;
    this.attemptAutoRegister();
  }

  /** Aborts in-flight FloAdmin requests when Offline mode is switched on. */
  suspendForOfflineMode() {
    this.offlineAbort.abort();
    this.offlineAbort = new AbortController();
    this.reload();
  }

  /** Refresh FloAdmin after setup or store-profile settings change. */
  refreshRegistrationProfile() {
    // Skip registration retries when desktop runtime is not running.
    if (!this.runtimeStarted) return;
    this.maybeAutoRegister();
  }

  private attemptAutoRegister() {
    if (this.shutdownRequested) return;
    let settings: Record<string, string>;
    try {
      settings = this.readSettings(getDatabase());
    } catch {
      return;
    }
    if (
      this.cloudDeletionInProgress ||
      isCloudDeletionBlocking(settings.cloud_deletion_status) ||
      settings.cloud_sync_enabled !== '1' ||
      settings.cloud_services_disabled_by_user === 'true'
    )
      return;
    if (this.autoRegisterTimer || this.autoRegisterInFlight) return;
    this.autoRegisterInFlight = true;
    this.runBackground(
      this.register()
        .then(() => {
          this.autoRegisterAttempts = 0;
          this.autoRegisterInFlight = false;
        })
        .catch(() => {
          this.autoRegisterInFlight = false;
          if (this.shutdownRequested) return;
          const currentSettings = this.readSettings(getDatabase());
          if (
            this.cloudDeletionInProgress ||
            isCloudDeletionBlocking(currentSettings.cloud_deletion_status) ||
            currentSettings.cloud_sync_enabled !== '1' ||
            currentSettings.cloud_services_disabled_by_user === 'true'
          )
            return;
          const delay = Math.min(
            AUTO_REGISTER_MAX_BACKOFF_MS,
            2 ** this.autoRegisterAttempts * 1000,
          );
          this.autoRegisterAttempts++;
          this.autoRegisterTimer = setTimeout(() => {
            this.autoRegisterTimer = null;
            if (!this.shutdownRequested) this.attemptAutoRegister();
          }, delay);
        }),
      'auto-registration',
    );
  }

  // --- Live-relay connection (WSS primary, HTTP fallback) ---------------------------------

  private maybeStartRelay() {
    if (this.cloudDeletionInProgress || this.shutdownRequested) return;
    const cfg = this.settings;
    if (!cfg?.api_key || !(cfg.sync_enabled || cfg.command_polling_enabled)) {
      this.teardownRelay();
      this.stopHttpFallback();
      return;
    }
    this.connectRelay();
  }

  private connectRelay() {
    if (this.cloudDeletionInProgress || this.shutdownRequested) return;
    const cfg = this.settings;
    if (!cfg?.api_key || !(cfg.sync_enabled || cfg.command_polling_enabled)) return;
    if (
      this.relaySocket &&
      (this.relaySocket.readyState === WebSocket.OPEN ||
        this.relaySocket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    let socket: WebSocket;
    try {
      const url = relayEndpoint(cfg.server_url);
      const headers = this.buildSignedHeaders(
        cfg.api_key,
        cfg.pos_hash,
        'GET',
        '/api/pos/relay',
        '',
      );
      socket = new WebSocket(url, { headers, handshakeTimeout: REQUEST_TIMEOUT_MS });
    } catch (err) {
      log.warn('[CloudSync] relay connect failed', (err as Error).message);
      this.scheduleRelayReconnect();
      return;
    }

    this.relaySocket = socket;
    socket.on('open', () => this.onRelayOpen());
    socket.on('message', (data) => this.onRelayMessage(data));
    socket.on('pong', () => {
      this.relayAwaitingPong = false;
    });
    socket.on('close', () => this.onRelayClosed());
    socket.on('error', (err) => log.warn('[CloudSync] relay error', (err as Error).message));
  }

  private onRelayOpen() {
    if (this.cloudDeletionInProgress || this.shutdownRequested) {
      this.teardownRelay();
      return;
    }
    this.relayReconnectAttempts = 0;
    this.relayMode = 'websocket';
    this.stopHttpFallback();

    this.relayAwaitingPong = false;
    this.relayPingTimer = setInterval(() => {
      if (!this.relaySocket || this.relaySocket.readyState !== WebSocket.OPEN) return;
      if (this.relayAwaitingPong) {
        log.warn('[CloudSync] relay missed pong, reconnecting');
        this.relaySocket.terminate();
        return;
      }
      this.relayAwaitingPong = true;
      this.relaySocket.ping();
    }, RELAY_PING_INTERVAL_MS);

    const cfg = this.settings;
    if (cfg?.sync_enabled) {
      this.runBackground(this.sendRelayHeartbeat(), 'relay heartbeat');
      this.relayHeartbeatFrameTimer = setInterval(
        () => this.runBackground(this.sendRelayHeartbeat(), 'relay heartbeat'),
        HEARTBEAT_INTERVAL_MS,
      );
    }

    this.upsertSettings({
      cloud_connected: 'true',
      cloud_last_error: '',
      cloud_last_heartbeat: new Date().toISOString(),
    });
    log.info('[CloudSync] relay connected');
  }

  private onRelayMessage(data: RawData) {
    if (this.cloudDeletionInProgress || this.shutdownRequested) return;
    let frame: any;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (frame?.type === 'command' && frame.id && frame.cmd) {
      const envelope = frame.payload && typeof frame.payload === 'object' ? frame.payload : {};
      const commandPayload =
        envelope.version === 1 && envelope.payload && typeof envelope.payload === 'object'
          ? envelope.payload
          : envelope;
      this.trackRelayCommand(
        this.executeRelayCommand({
          id: frame.id,
          type: frame.cmd,
          payload: commandPayload,
          correlation_id:
            typeof envelope.correlation_id === 'string' ? envelope.correlation_id : frame.id,
        }),
      );
    } else if (frame?.type === 'heartbeat_ack') {
      this.applyFeatures(frame.features);
    }
  }

  private onRelayClosed() {
    if (this.relayPingTimer) {
      clearInterval(this.relayPingTimer);
      this.relayPingTimer = null;
    }
    if (this.relayHeartbeatFrameTimer) {
      clearInterval(this.relayHeartbeatFrameTimer);
      this.relayHeartbeatFrameTimer = null;
    }
    this.relaySocket = null;
    this.relayMode = 'disconnected';
    this.markError('relay connection closed');
    this.scheduleRelayReconnect();
  }

  private scheduleRelayReconnect() {
    if (this.shutdownRequested) return;
    const cfg = this.settings;
    if (!cfg?.api_key || !(cfg.sync_enabled || cfg.command_polling_enabled)) return;

    this.relayReconnectAttempts += 1;
    if (this.relayReconnectAttempts >= RELAY_FALLBACK_THRESHOLD && !this.httpFallbackActive) {
      this.startHttpFallback();
    }

    const backoff = Math.min(
      RELAY_RECONNECT_MAX_MS,
      RELAY_RECONNECT_BASE_MS * 2 ** this.relayReconnectAttempts,
    );
    const jitter = backoff * (0.8 + Math.random() * 0.4);
    if (this.relayReconnectTimer) clearTimeout(this.relayReconnectTimer);
    this.relayReconnectTimer = setTimeout(() => this.connectRelay(), jitter);
  }

  /** Degraded mode — same HTTP command-poll/heartbeat behavior the POS shipped with before the relay existed. */
  private startHttpFallback() {
    if (this.cloudDeletionInProgress || this.shutdownRequested) return;
    const cfg = this.settings;
    if (!cfg?.api_key || this.httpFallbackActive) return;
    this.httpFallbackActive = true;
    this.relayMode = 'http_fallback';

    if (cfg.sync_enabled && !this.heartbeatTimer) {
      this.runBackground(this.sendHeartbeat(), 'heartbeat');
      this.heartbeatTimer = setInterval(
        () => this.runBackground(this.sendHeartbeat(), 'heartbeat'),
        HEARTBEAT_INTERVAL_MS,
      );
    }
    if (cfg.command_polling_enabled && !this.commandTimer) {
      this.trackCommandPoll(this.pollCommands());
      this.commandTimer = setInterval(
        () => this.trackCommandPoll(this.pollCommands()),
        COMMAND_POLL_INTERVAL_MS,
      );
    }
    log.warn('[CloudSync] relay unavailable, falling back to HTTP polling');
  }

  private stopHttpFallback() {
    if (!this.httpFallbackActive) return;
    this.httpFallbackActive = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.commandTimer) {
      clearInterval(this.commandTimer);
      this.commandTimer = null;
    }
  }

  /** Apply feature flags only when values changed to avoid relay reconnect storms. */
  private applyFeatures(features: unknown) {
    if (!features || typeof features !== 'object') return;
    const f = features as Record<string, unknown>;
    const cfg = this.settings;
    const entries: Record<string, string> = {};
    const maybeSet = (flag: keyof typeof f, current: boolean | undefined, key: string) => {
      const value = f[flag];
      if (typeof value !== 'boolean' || value === current) return;
      entries[key] = value ? '1' : '0';
    };
    maybeSet('cloud_sync_enabled', cfg?.sync_enabled, 'cloud_sync_enabled');
    maybeSet('cloud_orders_enabled', cfg?.orders_enabled, 'cloud_orders_enabled');
    maybeSet('cloud_reports_enabled', cfg?.reports_enabled, 'cloud_reports_enabled');
    if (Object.keys(entries).length === 0) return;
    this.upsertSettings(entries);
    this.reload();
  }

  private runCommand(command: CloudCommand): unknown {
    if (
      command.payload &&
      command.payload.version === 1 &&
      command.payload.payload &&
      typeof command.payload.payload === 'object'
    ) {
      command = { ...command, payload: command.payload.payload as Record<string, unknown> };
    }
    switch (command.type) {
      case 'health.get':
        return this.healthPayload();
      case 'orders.live':
        return this.liveOrders(command.payload);
      case 'orders.get':
        return this.getOrder(command.payload);
      case 'report.sales':
        return this.salesReport(command.payload);
      case 'report.dashboard':
        return this.dashboardReport(command.payload);
      case 'report.hourly':
        return this.hourlyReport(command.payload);
      case 'report.items':
        return this.itemsReport(command.payload);
      case 'report.payments':
        return this.paymentsReport(command.payload);
      default:
        throw new Error(`Unsupported command type: ${command.type}`);
    }
  }

  private healthPayload() {
    const db = getDatabase();
    const schema = db.pragma('user_version', { simple: true }) as number;
    return {
      pos_hash: this.settings?.pos_hash,
      schema_version: schema,
      app_version: require('../../package.json').version,
      device_name: os.hostname(),
      time: new Date().toISOString(),
    };
  }

  private liveOrders(payload?: Record<string, unknown>) {
    const db = getDatabase();
    const rawStatuses = Array.isArray(payload?.statuses)
      ? payload?.statuses
      : ['pending', 'preparing', 'ready', 'served'];
    const statuses = rawStatuses
      .map((status) => String(status))
      .filter((status) => ['pending', 'preparing', 'ready', 'served'].includes(status));
    if (statuses.length === 0) return { orders: [] };

    const placeholders = statuses.map(() => '?').join(',');
    const orders = db
      .prepare(`
      SELECT * FROM orders
      WHERE status IN (${placeholders})
      ORDER BY created_at ASC
      LIMIT 200
    `)
      .all(...statuses) as OrderSnapshotSource[];

    return { orders: this.decorateOrders(orders) };
  }

  private getOrder(payload?: Record<string, unknown>) {
    const id = payload?.order_id;
    if (!id) throw new Error('order_id is required');
    const order = this.buildOrderSnapshot(String(id));
    if (!order) throw new Error('Order not found');
    return { order };
  }

  private salesReport(payload?: Record<string, unknown>) {
    const db = getDatabase();
    const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
    const range = dateRange(payload);
    const totals = db
      .prepare(`
      SELECT
        COUNT(*) as bill_count,
        COALESCE(SUM(total), 0) as gross_sales,
        COALESCE(SUM(subtotal), 0) as subtotal,
        COALESCE(SUM(tax_amount), 0) as tax_amount,
        COALESCE(SUM(discount_amount), 0) as discount_amount,
        COALESCE(SUM(paid_amount), 0)
          - COALESCE((SELECT SUM(CAST(amount_cents AS REAL)) / ? FROM refunds WHERE created_at >= ? AND created_at <= ?), 0) as paid_amount
      FROM bills
      WHERE paid_at >= ? AND paid_at <= ?
    `)
      .get(minorFactor, range.from, range.to, range.from, range.to);

    const byDay = db
      .prepare(`
      WITH events AS (
        SELECT date(paid_at) as date, 1 as bill_count, paid_amount as gross_sales
        FROM bills WHERE paid_at >= ? AND paid_at <= ?
        UNION ALL
        SELECT date(created_at), 0, -(CAST(amount_cents AS REAL) / ?)
        FROM refunds WHERE created_at >= ? AND created_at <= ?
      )
      SELECT date, SUM(bill_count) as bill_count, COALESCE(SUM(gross_sales), 0) as gross_sales
      FROM events
      GROUP BY date
      ORDER BY date ASC
    `)
      .all(range.from, range.to, minorFactor, range.from, range.to);

    const topItems = db
      .prepare(`
      SELECT oi.product_id, oi.product_name,
        COALESCE(SUM(CASE WHEN b.split_group_id IS NULL THEN oi.quantity ELSE bi.quantity END), 0) as quantity,
        COALESCE(SUM(CASE WHEN b.split_group_id IS NULL THEN oi.total ELSE oi.total * bi.quantity / oi.quantity END), 0) as total
      FROM bills b JOIN orders o ON o.id = b.order_id JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN bill_items bi ON bi.bill_id = b.id AND bi.order_item_id = oi.id
      WHERE b.paid_at IS NOT NULL
        AND (b.split_group_id IS NULL OR bi.bill_id IS NOT NULL)
        AND COALESCE(b.paid_at, b.created_at) >= ?
        AND COALESCE(b.paid_at, b.created_at) <= ?
      GROUP BY oi.product_id, oi.product_name
      ORDER BY total DESC
      LIMIT 20
    `)
      .all(range.from, range.to);

    return {
      range,
      totals,
      data: (byDay as any[]).map((row) => ({
        period: row.date,
        total: row.gross_sales,
        bill_count: row.bill_count,
      })),
      top_items: topItems,
    };
  }

  private dashboardReport(payload?: Record<string, unknown>) {
    const range = dateRange({ from: payload?.date, to: payload?.date });
    const db = getDatabase();
    const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
    const totals = db
      .prepare(`
      SELECT COUNT(*) AS bill_count, COALESCE(SUM(paid_amount), 0)
             - COALESCE((SELECT SUM(CAST(amount_cents AS REAL)) / ? FROM refunds WHERE date(created_at) BETWEEN date(?) AND date(?)), 0) AS total_sales,
             COALESCE(SUM(tax_amount), 0) AS total_tax,
             COALESCE(SUM(discount_amount), 0) AS total_discount
        FROM bills
       WHERE paid_at IS NOT NULL AND date(paid_at) BETWEEN date(?) AND date(?)
    `)
      .get(minorFactor, range.from, range.to, range.from, range.to) as any;
    const topItems = db
      .prepare(`
      SELECT oi.product_name AS name, COALESCE(SUM(CASE WHEN b.split_group_id IS NULL THEN oi.quantity ELSE bi.quantity END), 0) AS qty,
             COALESCE(SUM(CASE WHEN b.split_group_id IS NULL THEN oi.total ELSE oi.total * bi.quantity / oi.quantity END), 0) AS revenue,
             COALESCE(AVG(oi.unit_price), 0) AS price
        FROM bills b JOIN orders o ON o.id = b.order_id JOIN order_items oi ON oi.order_id = o.id
        LEFT JOIN bill_items bi ON bi.bill_id = b.id AND bi.order_item_id = oi.id
       WHERE b.paid_at IS NOT NULL AND date(b.paid_at) BETWEEN date(?) AND date(?)
         AND (b.split_group_id IS NULL OR bi.bill_id IS NOT NULL)
       GROUP BY oi.product_id, oi.product_name ORDER BY revenue DESC LIMIT 5
    `)
      .all(range.from, range.to);
    const paymentRows = this.paymentBreakdown(range);
    const totalSales = Number(totals.total_sales || 0);
    return {
      ...totals,
      avg_order_value: totals.bill_count ? totalSales / Number(totals.bill_count) : 0,
      payment_breakdown: Object.fromEntries(
        (paymentRows as any[]).map((row) => [
          String(row.method || 'other').toLowerCase(),
          row.amount,
        ]),
      ),
      top_items: topItems,
    };
  }

  private hourlyReport(payload?: Record<string, unknown>) {
    const range = dateRange({ from: payload?.date, to: payload?.date });
    const db = getDatabase();
    const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
    const rows = db
      .prepare(`
      WITH events AS (
        SELECT strftime('%H', paid_at) AS hour, paid_amount AS sales, 1 AS bills
        FROM bills WHERE paid_at IS NOT NULL AND date(paid_at) BETWEEN date(?) AND date(?)
        UNION ALL
        SELECT strftime('%H', created_at), -(CAST(amount_cents AS REAL) / ?), 0
        FROM refunds WHERE date(created_at) BETWEEN date(?) AND date(?)
      )
      SELECT hour, COALESCE(SUM(sales), 0) AS sales, SUM(bills) AS bills
      FROM events GROUP BY hour ORDER BY hour
    `)
      .all(range.from, range.to, minorFactor, range.from, range.to) as any[];
    const byHour = new Map(rows.map((row) => [String(row.hour).padStart(2, '0'), row]));
    return {
      hours: Array.from({ length: 24 }, (_, hour) => {
        const row = byHour.get(String(hour).padStart(2, '0'));
        return {
          hour: `${String(hour).padStart(2, '0')}:00`,
          sales: row?.sales || 0,
          bills: row?.bills || 0,
        };
      }),
    };
  }

  private itemsReport(payload?: Record<string, unknown>) {
    const range = dateRange(payload);
    const requestedLimit = Number(payload?.limit);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 50;
    const items = getDatabase()
      .prepare(`
      SELECT oi.product_name AS name, COALESCE(SUM(CASE WHEN b.split_group_id IS NULL THEN oi.quantity ELSE bi.quantity END), 0) AS qty_sold,
             COALESCE(SUM(CASE WHEN b.split_group_id IS NULL THEN oi.total ELSE oi.total * bi.quantity / oi.quantity END), 0) AS revenue
        FROM bills b JOIN orders o ON o.id = b.order_id JOIN order_items oi ON oi.order_id = o.id
        LEFT JOIN bill_items bi ON bi.bill_id = b.id AND bi.order_item_id = oi.id
       WHERE b.paid_at IS NOT NULL AND date(b.paid_at) BETWEEN date(?) AND date(?)
         AND (b.split_group_id IS NULL OR bi.bill_id IS NOT NULL)
       GROUP BY oi.product_id, oi.product_name ORDER BY revenue DESC LIMIT ?
    `)
      .all(range.from, range.to, limit);
    return { items };
  }

  private paymentsReport(payload?: Record<string, unknown>) {
    const range = dateRange(payload);
    const rows = this.paymentBreakdown(range) as any[];
    const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    return {
      total,
      breakdown: rows.map((row) => ({
        method: row.method || 'Other',
        amount: row.amount || 0,
        count: row.count || 0,
        percent: total ? (Number(row.amount || 0) / total) * 100 : 0,
      })),
    };
  }

  private paymentBreakdown(range: DateRange) {
    const db = getDatabase();
    const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
    return db
      .prepare(`
      WITH entries AS (
        SELECT COALESCE(pm.name, json_extract(je.value, '$.method')) AS method,
               json_extract(je.value, '$.amount') AS amount,
               COALESCE(json_extract(je.value, '$.timestamp'), b.paid_at, b.created_at) AS occurred_at
          FROM bills b, json_each(b.payment_details) je
          LEFT JOIN payment_methods pm ON pm.id = CAST(json_extract(je.value, '$.payment_method_id') AS INTEGER)
         WHERE b.payment_details IS NOT NULL
        UNION ALL
        SELECT method, -(CAST(amount_cents AS REAL) / ?), created_at FROM refunds
      )
      SELECT method, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
        FROM entries
       WHERE date(occurred_at) BETWEEN date(?) AND date(?)
       GROUP BY method ORDER BY amount DESC
    `)
      .all(minorFactor, range.from, range.to);
  }

  private buildOrderSnapshot(orderId: number | string) {
    const db = getDatabase();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as
      | OrderSnapshotSource
      | undefined;
    if (!order) return null;
    return this.decorateOrder(order);
  }

  private decorateOrder(order: OrderSnapshotSource) {
    return this.decorateOrders([order])[0] ?? null;
  }

  private decorateOrders(orders: OrderSnapshotSource[]): unknown[] {
    if (orders.length === 0) return [];

    const db = getDatabase();
    const orderIds = orders.map((o) => o.id);
    const CHUNK_SIZE = 400;

    const rawItems: OrderItemSnapshotSource[] = [];
    for (let offset = 0; offset < orderIds.length; offset += CHUNK_SIZE) {
      const chunk = orderIds.slice(offset, offset + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      rawItems.push(
        ...(db
          .prepare(`SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY id ASC`)
          .all(...chunk) as OrderItemSnapshotSource[]),
      );
    }

    const parsedItems = attachEffectiveAddons(db, rawItems.map(parseItemJson));
    const itemsByOrderId = new Map<string, unknown[]>();
    for (const item of parsedItems) {
      const key = String(item.order_id);
      const list = itemsByOrderId.get(key);
      if (list) {
        list.push(item);
      } else {
        itemsByOrderId.set(key, [item]);
      }
    }

    const tableIds = Array.from(
      new Set(orders.map((o) => o.table_id).filter((id): id is string | number => Boolean(id))),
    );
    const tableMap = new Map<string, TableSnapshotSource>();
    if (tableIds.length > 0) {
      for (let offset = 0; offset < tableIds.length; offset += CHUNK_SIZE) {
        const chunk = tableIds.slice(offset, offset + CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');
        const tableRows = db
          .prepare(`SELECT * FROM tables WHERE id IN (${placeholders})`)
          .all(...chunk) as TableSnapshotSource[];
        for (const table of tableRows) {
          tableMap.set(String(table.id), table);
        }
      }
    }

    const billRows: BillSnapshotSource[] = [];
    for (let offset = 0; offset < orderIds.length; offset += CHUNK_SIZE) {
      const chunk = orderIds.slice(offset, offset + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      billRows.push(
        ...(db
          .prepare(`SELECT * FROM bills WHERE order_id IN (${placeholders}) ORDER BY id ASC`)
          .all(...chunk) as BillSnapshotSource[]),
      );
    }
    const billsByOrderId = new Map<string, BillSnapshotSource[]>();
    for (const bill of billRows) {
      const key = String(bill.order_id);
      const list = billsByOrderId.get(key);
      if (list) {
        list.push(bill);
      } else {
        billsByOrderId.set(key, [bill]);
      }
    }

    return orders.map((order) => {
      const items = itemsByOrderId.get(String(order.id)) ?? [];
      const tableRow = order.table_id ? (tableMap.get(String(order.table_id)) ?? null) : null;
      const bills = billsByOrderId.get(String(order.id)) ?? [];
      const bill = bills.find((row) => row.payment_status !== 'paid') || bills[0] || null;
      return sanitizeOrderSnapshot({
        ...order,
        items,
        table: tableRow ? { ...tableRow, name: tableRow.number } : null,
        bill: bill ? { ...bill, payment_details: safeJsonParse(bill.payment_details) } : null,
        bills: bills.map((row) => ({
          ...row,
          payment_details: safeJsonParse(row.payment_details),
        })),
      });
    });
  }

  /** Shared HMAC signing used by every signed HTTP call and the relay WS handshake — see floadmin.md § Identity & request signing. */
  private buildSignedHeaders(
    apiKey: string,
    posHash: string,
    method: string,
    signedPath: string,
    body: string,
  ): Record<string, string> {
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomUUID();
    const bodyHash = sha256Hex(body);
    const signatureBase = [method.toUpperCase(), signedPath, timestamp, nonce, bodyHash].join('\n');
    const signature = hmacHex(apiKey, signatureBase);
    return {
      Authorization: `Bearer ${apiKey}`,
      'X-Flo-POS-Hash': posHash,
      'X-Flo-Timestamp': timestamp,
      'X-Flo-Nonce': nonce,
      'X-Flo-Body-SHA256': bodyHash,
      'X-Flo-Signature': `sha256=${signature}`,
    };
  }

  private async signedFetch(
    pathname: string,
    init: RequestInit,
    allowDuringDeletion = false,
  ): Promise<Response> {
    if (this.cloudDeletionInProgress && !allowDuringDeletion)
      throw new Error('Cloud deletion in progress');
    const persistedSettings = this.readSettings(getDatabase());
    if (isCloudDeletionBlocking(persistedSettings.cloud_deletion_status) && !allowDuringDeletion) {
      throw new Error(
        'Cloud deletion is unresolved; retry or cancel it before using cloud services',
      );
    }
    const cfg = this.settings ?? this.loadSettings();
    if (!cfg?.api_key) throw new Error('Cloud POS is not registered');
    if (!allowDuringDeletion && !this.isCloudAccountAvailable()) {
      throw new Error('Cloud account services are unavailable while Cloud services are stopped');
    }

    const method = (init.method || 'GET').toUpperCase();
    const url = endpoint(cfg.server_url, pathname);
    const body = typeof init.body === 'string' ? init.body : '';
    const signedPath = `${url.pathname}${url.search}`;
    const signedHeaders = this.buildSignedHeaders(
      cfg.api_key,
      cfg.pos_hash,
      method,
      signedPath,
      body,
    );

    return this.trackedFetch(
      url,
      {
        ...init,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...signedHeaders,
          ...(init.headers || {}),
        },
        body: method === 'GET' ? undefined : body,
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      allowDuringDeletion,
    );
  }

  private runBackground<T>(
    operation: Promise<T>,
    label: string,
    onError?: (error: unknown) => void,
  ): void {
    const tracked = operation.catch((error) => {
      if (this.shutdownRequested || (error as { code?: unknown })?.code === 'ERR_SHUTDOWN_ABORTED')
        return;
      try {
        if (onError) {
          onError(error);
        } else {
          log.warn(`[CloudSync] ${label} failed`, (error as Error).message);
        }
      } catch (callbackError) {
        log.warn(`[CloudSync] ${label} failure handling failed`, (callbackError as Error).message);
      }
    });
    this.backgroundPromises.add(tracked);
    void tracked.finally(() => this.backgroundPromises.delete(tracked));
  }

  private async trackedFetch(
    url: string | URL,
    init: RequestInit,
    allowDuringDeletion = false,
  ): Promise<Response> {
    if (this.cloudDeletionInProgress && !allowDuringDeletion)
      throw new Error('Cloud deletion in progress');
    assertOnlineAllowed('Cloud sync');
    this.cloudNetworkOperations += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.cloudNetworkOperations -= 1;
      if (this.cloudNetworkOperations === 0) {
        const waiters = this.cloudNetworkIdleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    };
    try {
      const signal = init.signal
        ? AbortSignal.any([init.signal, this.offlineAbort.signal])
        : this.offlineAbort.signal;
      const response = await fetch(url, { ...init, signal });
      if (this.cloudDeletionInProgress && !allowDuringDeletion) {
        release();
        throw new Error('Cloud deletion in progress');
      }
      if (!response.body) {
        release();
      } else {
        for (const method of ['arrayBuffer', 'blob', 'formData', 'json', 'text'] as const) {
          const original = (response[method] as any).bind(response);
          Object.defineProperty(response, method, {
            configurable: true,
            value: async (...args: any[]) => {
              try {
                return await original(...args);
              } finally {
                release();
              }
            },
          });
        }
      }
      return response;
    } catch (error) {
      release();
      throw error;
    }
  }

  private async drainResponse(response: Response): Promise<void> {
    try {
      await response.arrayBuffer();
    } catch {}
  }

  private waitForCloudNetworkIdle(timeoutMs = 5_000): Promise<void> {
    if (this.cloudNetworkOperations === 0) return Promise.resolve();
    let timeout: NodeJS.Timeout | undefined;
    const idlePromise = new Promise<void>((resolve) => this.cloudNetworkIdleWaiters.push(resolve));
    const timeoutPromise = new Promise<void>((resolve) => {
      timeout = setTimeout(() => resolve(), timeoutMs);
    });
    return Promise.race([idlePromise, timeoutPromise]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  private loadSettings(ensureIdentity = true): CloudSettings | null {
    try {
      const db = getDatabase();
      if (ensureIdentity) ensureCloudIdentity();
      const s = this.readSettings(db);
      const server_url = normalizeCloudServerUrl(s.cloud_server_url || DEFAULT_CLOUD_SERVER_URL);
      return {
        server_url,
        api_key: s.cloud_api_key || '',
        store_id: s.cloud_store_id || '',
        pos_id: s.cloud_pos_id || '',
        pos_hash: s.cloud_pos_hash || '',
        sync_enabled: s.cloud_sync_enabled === '1',
        orders_enabled: s.cloud_orders_enabled === '1',
        reports_enabled: s.cloud_reports_enabled === '1',
        command_polling_enabled: s.cloud_command_polling_enabled === '1',
        cloud_registration_status: s.cloud_registration_status || 'unregistered',
        cloud_deletion_status: s.cloud_deletion_status || '',
        cloud_deletion_outcome: s.cloud_deletion_outcome || '',
      };
    } catch (err) {
      log.warn('[CloudSync] settings unavailable', (err as Error).message);
      return null;
    }
  }

  private readSettings(db: ReturnType<typeof getDatabase>): Record<string, string> {
    const rows = db.prepare('SELECT key, value FROM settings').all() as {
      key: string;
      value: string;
    }[];
    const s: Record<string, string> = {};
    for (const row of rows) s[row.key] = row.value;
    return s;
  }

  private upsertSettings(
    entries: Record<string, string | undefined | null>,
    allowDuringDeletion = false,
  ) {
    if (this.shutdownRequested || (this.cloudDeletionInProgress && !allowDuringDeletion)) return;
    if (isDatabaseMaintenanceActive()) {
      this.runBackground(
        this.withDatabaseRequest(() => this.upsertSettings(entries, allowDuringDeletion)),
        'settings update',
      );
      return;
    }
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    for (const [key, value] of Object.entries(entries)) {
      if (value !== undefined && value !== null) stmt.run(key, value, now());
    }
  }

  private countOutbox(status: string): number {
    try {
      const row = getDatabase()
        .prepare('SELECT COUNT(*) as count FROM cloud_sync_outbox WHERE status = ?')
        .get(status) as { count: number };
      return row.count;
    } catch {
      return 0;
    }
  }

  private markError(message: string) {
    if (this.cloudDeletionInProgress || this.shutdownRequested) return;
    const settings = this.readSettings(getDatabase());
    if (settings.cloud_services_disabled_by_user === 'true') return;
    this.upsertSettings({
      cloud_connected: 'false',
      cloud_last_error: 'Cloud service request failed',
    });
    log.warn('[CloudSync]', message);
  }
}

export const cloudSync = new CloudSyncService();
registerDatabaseMaintenanceStartListener(() => cloudSync.stop());
registerDatabaseMaintenanceEndListener(() => cloudSync.resumeAfterMaintenance());

/**
 * Allowlist for everything FloCafe sends to PostHog. Usage follows the sharing level, the email
 * only the `full` level, and exceptions follow diagnostics transmission.
 */

import { scrubPrinterErrorText } from './printer-error-text';

export const POSTHOG_CAPTURE_POINTS = [
  'uncaughtException',
  'unhandledRejection',
  'renderer-autocapture',
  'react-error-boundary',
  'api-5xx',
  'printer',
] as const;

export type PostHogCapturePoint = (typeof POSTHOG_CAPTURE_POINTS)[number];

/** Diagnostics events that follow error-sending consent, not the usage level. */
export const POSTHOG_DIAGNOSTIC_EVENTS = ['printer_failed', 'operation_failed'] as const;

export type PostHogDiagnosticEvent = (typeof POSTHOG_DIAGNOSTIC_EVENTS)[number];

export const POSTHOG_USAGE_EVENTS = [
  'app_launch',
  'daily_ping',
  'feature_used',
  'setup_completed',
  'first_order_created',
  'first_bill_paid',
  'api_slow_request',
  'diagnostics_prompt_shown',
  'diagnostics_prompt_accepted',
] as const;

export type PostHogUsageEvent = (typeof POSTHOG_USAGE_EVENTS)[number];

/** Every property a usage event may carry. Anything else is dropped. */
export const POSTHOG_USAGE_PROPERTY_KEYS = [
  'feature',
  'action',
  'check_count',
  'setup_profile',
  'service_model',
  'business_type',
  'hours_since_setup',
  'backfilled',
  'country',
  'currency',
  'language',
  'kds_enabled',
  'orders_24h',
  'orders_dine_in_24h',
  'orders_takeaway_24h',
  'orders_delivery_24h',
  'orders_online_24h',
  'orders_cancelled_24h',
  'bills_paid_24h',
  'staff_with_orders_24h',
  'active_staff_count',
  'products_count',
  'tables_count',
  'customers_count',
  'printers_count',
  'kitchen_stations_count',
  'http_method',
  'http_route',
  'http_status',
  'duration_ms',
  'db_ms',
  'db_queries',
  'slowest_query_ms',
  'slowest_query',
  'occurrences',
] as const;

/** Store configuration kept on the person. None of it identifies a customer or an order. */
export const POSTHOG_PERSON_KEYS = [
  'email',
  'country',
  'currency',
  'language',
  'service_model',
  'kds_enabled',
  'app_version',
  'platform',
  'run_mode',
  'install_source',
  'store_ref',
  'environment',
  'release_channel',
] as const;

/** Sent with every event so error tracking and insights can filter by release and channel. */
export const POSTHOG_SUPER_KEYS = [
  'app_version',
  'platform',
  'run_mode',
  'install_source',
  'store_ref',
  'environment',
  'release_channel',
  'install_ref',
  'process_type',
] as const;

/**
 * Who used the app, without saying who: the staff role and a per-installation hash of the
 * user id. One installation stays one person; staff are an event dimension, not persons.
 */
export const POSTHOG_STAFF_KEYS = ['staff_role', 'staff_ref'] as const;

/** Screen-level pageview fields: the route, the settings tab, and views folded into this one. */
const PAGEVIEW_KEYS = new Set(['screen', 'settings_tab', 'repeat_views']);

const CAPTURE_POINT_SET = new Set<string>(POSTHOG_CAPTURE_POINTS);
const DIAGNOSTIC_EVENT_SET = new Set<string>(POSTHOG_DIAGNOSTIC_EVENTS);
const USAGE_EVENT_SET = new Set<string>(POSTHOG_USAGE_EVENTS);
const PERSON_KEY_SET = new Set<string>(POSTHOG_PERSON_KEYS);
const USAGE_PROPERTY_KEY_SET = new Set<string>(POSTHOG_USAGE_PROPERTY_KEYS);
const ACCOUNT_KEYS = ['email', 'store_ref'] as const;

const CONTEXT_KEYS = new Set<string>([
  ...POSTHOG_SUPER_KEYS,
  ...POSTHOG_STAFF_KEYS,
  'token',
  'distinct_id',
  '$lib',
  '$lib_version',
  '$os',
  '$os_version',
  '$browser',
  '$browser_version',
  '$device_type',
  '$screen_height',
  '$screen_width',
  '$viewport_height',
  '$viewport_width',
  '$timezone',
  '$session_id',
  '$window_id',
  '$pageview_id',
  '$insert_id',
  '$geoip_disable',
  '$release_id',
  '$process_person_profile',
]);

const API_FAILURE_KEYS = new Set(['http_method', 'http_route', 'http_status']);

/** Closed sets for a print failure, so a queue or staff name can never ride along. */
const PRINT_ENUM_KEYS: Record<string, Set<string>> = {
  kind: new Set(['receipt', 'kot', 'delivery_slip', 'payment_ticket']),
  connection_type: new Set(['network', 'usb', 'webusb', 'unknown']),
  failure_class: new Set([
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
  ]),
};
const DIAGNOSTIC_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** An operation failure is code-shaped only: ids from the operation registry, a count, flat facts. */
const OPERATION_CAPTURE_POINT = /^fc(?:\.[a-z][a-z0-9_]*){2,5}$/;
const OPERATION_CODE = /^[a-z][a-z0-9]*(?:[._][a-z][a-z0-9]*){0,5}$/;
const OPERATION_CLASSES = new Set(['expected_rejection', 'unexpected_failure']);
const OPERATION_OUTCOMES = new Set([
  'not_applied',
  'applied',
  'partial',
  'unknown',
  'not_applicable',
]);
const FACT_KEY = /^[a-z][a-z0-9_]{0,40}$/;
const FACT_TEXT = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_FACTS = 12;
const MAX_FACT_NUMBER = 1_000_000_000;

const PROJECT_MARKERS = [
  'frontend/src/',
  'frontend/',
  'dist/main/',
  'dist/',
  'main/',
  'shared/',
  'tests/',
];

const ERROR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,80}$/;
const IDENTIFIER = /^[A-Za-z_$<][\w$.<>]{0,99}$/;
const CHUNK_ID = /^[\w-]{1,100}$/;
const OPAQUE_REF = /^[0-9a-f]{16}$/;
const OPAQUE_REF_KEYS = new Set(['store_ref', 'staff_ref', 'install_ref']);
/** The only distinct ids FloCafe creates: account, device, and per-launch. */
const FLO_DISTINCT_ID = /^(?:acct_[0-9a-f]{16}|inst_[0-9a-f]{16}|anon_[0-9a-f-]{36})$/;
const ACCOUNT_DISTINCT_ID = /^acct_/;
const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g;

const MAX_FRAMES = 50;
const MAX_MESSAGE = 300;
/** Normalized SQL: `normalizeSql` leaves no quoted literal or comment behind. */
const NORMALIZED_SQL = /^[\w\s(),.?*=<>%:;!|+/@$[\]-]{1,400}$/;

export interface ScrubbableEvent {
  event?: string;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PostHogScrubOptions {
  /** Usage events, pageviews, and person properties: the `full` or `anonymous` level. */
  telemetryEnabled: boolean;
  /** The email, `store_ref`, and account ids: the `full` level only. */
  accountLinked: boolean;
  /** Exceptions. Follows diagnostics transmission. */
  allowExceptions: boolean;
  /** Release and device facts an exception may arrive without; the sender knows them. */
  exceptionContext?: ExceptionContext;
}

export interface ExceptionContext {
  app_version?: string;
  platform?: string;
  install_source?: string;
  process_type?: string;
  $os?: string;
  $os_version?: string;
}

export function isPostHogCapturePoint(value: unknown): value is PostHogCapturePoint {
  return typeof value === 'string' && CAPTURE_POINT_SET.has(value);
}

export function sanitizeErrorName(name: unknown, stack?: string): string {
  if (typeof name === 'string' && ERROR_NAME.test(name)) return name;
  if (typeof stack === 'string') {
    const first = stack.split('\n', 1)[0] ?? '';
    const token = first.split(':', 1)[0]?.trim() ?? '';
    if (ERROR_NAME.test(token)) return token;
  }
  return 'Error';
}

/**
 * Removes emails, URLs, digit runs and quoted text from an error message. Identifier-like
 * quotes in engine messages, such as "(reading 'name')", are kept.
 */
export function redactExceptionMessage(message: unknown): string {
  if (typeof message !== 'string') return '';
  let text = message.split('\n', 1)[0] ?? '';
  text = text.replace(EMAIL, '<email>');
  text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>');
  text = text.replace(/"[^"]*"|“[^”]*”|`[^`]*`/g, '"<redacted>"');
  text = text.replace(/'([^']*)'/g, (match, inner: string) =>
    /^[A-Za-z_$][\w$.]{0,60}$/.test(inner) ? match : "'<redacted>'",
  );
  text = text.replace(/\+?\d[\d\s().-]{1,}\d/g, (match) =>
    match.replace(/\D/g, '').length >= 3 ? '<n>' : match,
  );
  text = text.trim();
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text;
}

/** Project-relative path, or null when the frame is outside this repo. */
export function projectRelativeFile(raw: string): string | null {
  let file = raw.trim();
  if (!file || file.startsWith('node:') || file === 'native' || file.includes('<anonymous>')) {
    return null;
  }
  if (file.includes('node_modules') || file.includes('electron/js2c')) return null;

  const served = /^https?:\/\/[^/]+\/(_next\/[^?#]+)/.exec(file);
  if (served) return safeRelative(served[1]);

  const webpack =
    /^(?:rsc:\/\/React\/[^/]+\/)?webpack-internal:\/\/\/(?:\([\w-]+\)\/)?\.\/(.+)$/.exec(file);
  if (webpack) {
    const rel = webpack[1].replace(/\\/g, '/').split('?')[0].split('#')[0];
    if (rel.startsWith('src/')) return safeRelative(`frontend/${rel}`);
    if (rel.startsWith('frontend/')) return safeRelative(rel);
    return null;
  }

  file = file.replace(/^file:\/\//, '').replace(/\\/g, '/');
  const asar = file.lastIndexOf('app.asar/');
  if (asar !== -1) file = file.slice(asar + 'app.asar/'.length);

  let chosen: { at: number; marker: string } | null = null;
  for (const marker of PROJECT_MARKERS) {
    const at = file.lastIndexOf(`/${marker}`);
    if (at < 0) continue;
    const start = at + 1;
    if (
      !chosen ||
      start > chosen.at ||
      (start === chosen.at && marker.length > chosen.marker.length)
    ) {
      chosen = { at: start, marker };
    }
  }
  if (!chosen) {
    if (PROJECT_MARKERS.some((marker) => file.startsWith(marker))) return safeRelative(file);
    return null;
  }
  return safeRelative(file.slice(chosen.at).split('?')[0].split('#')[0]);
}

function safeRelative(file: string): string | null {
  if (!file || file.includes('..') || file.startsWith('/') || /^[A-Za-z]:/.test(file)) return null;
  if (!/^[\w./()[\]@+~-]+$/.test(file)) return null;
  return file;
}

/** Keeps only the stack lines of an error, so the message never rides along in the stack. */
export function stackFrameLines(stack: unknown): string[] {
  if (typeof stack !== 'string') return [];
  return stack
    .split('\n')
    .filter((line) => line.trim().startsWith('at '))
    .slice(0, MAX_FRAMES);
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number > 0 && number <= 10_000_000 ? number : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 10_000 ? number : null;
}

function scrubFrame(
  frame: unknown,
  fallbackPlatform: string | null,
): Record<string, unknown> | null {
  if (!frame || typeof frame !== 'object') return null;
  const item = frame as Record<string, unknown>;
  const filename = typeof item.filename === 'string' ? projectRelativeFile(item.filename) : null;
  const lineno = positiveInteger(item.lineno);
  if (!filename || lineno === null) return null;
  const next: Record<string, unknown> = { filename, lineno };
  const colno = positiveInteger(item.colno);
  if (colno !== null) next.colno = colno;
  if (typeof item.function === 'string' && IDENTIFIER.test(item.function)) {
    next.function = item.function;
  }
  if (typeof item.in_app === 'boolean') next.in_app = item.in_app;
  if (typeof item.platform === 'string' && /^[\w:]{1,40}$/.test(item.platform)) {
    next.platform = item.platform;
  } else if (fallbackPlatform) {
    next.platform = fallbackPlatform;
  }
  if (typeof item.chunk_id === 'string' && CHUNK_ID.test(item.chunk_id)) {
    next.chunk_id = item.chunk_id;
  }
  return next;
}

function scrubMechanism(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  if (typeof record.handled === 'boolean') next.handled = record.handled;
  if (typeof record.synthetic === 'boolean') next.synthetic = record.synthetic;
  if (typeof record.type === 'string' && /^[\w-]{1,40}$/.test(record.type)) next.type = record.type;
  // The link to a chained cause, so the exception list reads in order.
  for (const key of ['exception_id', 'parent_id'] as const) {
    const id = nonNegativeInteger(record[key]);
    if (id !== null) next[key] = id;
  }
  if (typeof record.source === 'string' && /^[a-z_]{1,20}$/.test(record.source)) {
    next.source = record.source;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function scrubExceptionList(value: unknown, platform?: unknown): Array<Record<string, unknown>> {
  const fallback = typeof platform === 'string' && /^[\w:]{1,40}$/.test(platform) ? platform : null;
  const entries = Array.isArray(value) && value.length > 0 ? value.slice(0, 5) : [{}];
  return entries.map((entry) => {
    const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const stacktrace =
      record.stacktrace && typeof record.stacktrace === 'object'
        ? (record.stacktrace as Record<string, unknown>)
        : {};
    const rawFrames = Array.isArray(stacktrace.frames) ? stacktrace.frames : [];
    const frames = rawFrames
      .map((frame) => scrubFrame(frame, fallback))
      .filter((frame): frame is Record<string, unknown> => frame !== null)
      .slice(-MAX_FRAMES);
    const next: Record<string, unknown> = {
      type: sanitizeErrorName(record.type),
      stacktrace: { type: 'raw', frames },
    };
    // PostHog needs a message on every exception, so an empty one falls back to the type.
    next.value = redactExceptionMessage(record.value) || String(next.type);
    const mechanism = scrubMechanism(record.mechanism);
    if (mechanism) next.mechanism = mechanism;
    return next;
  });
}

function emailField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 320 || /[\s\r\n]/.test(trimmed) || !trimmed.includes('@')) {
    return undefined;
  }
  return trimmed;
}

function opaqueRef(value: unknown): string | undefined {
  return typeof value === 'string' && OPAQUE_REF.test(value) ? value : undefined;
}

function plainValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || trimmed.includes('@') || /\d{6,}/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function personProperties(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const key of PERSON_KEY_SET) {
    const field =
      key === 'email'
        ? emailField(record[key])
        : OPAQUE_REF_KEYS.has(key)
          ? opaqueRef(record[key])
          : plainValue(record[key]);
    if (field !== undefined) next[key] = field;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function contextProperties(source: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of CONTEXT_KEYS) {
    const value = source[key];
    if (OPAQUE_REF_KEYS.has(key)) {
      if (typeof value === 'string' && OPAQUE_REF.test(value)) next[key] = value;
    } else if (key === 'distinct_id' || key === 'token' || key.startsWith('$')) {
      if (typeof value === 'string' && value.length > 0 && value.length <= 200) next[key] = value;
      else if (typeof value === 'number' || typeof value === 'boolean') next[key] = value;
    } else {
      const plain = plainValue(value);
      if (plain !== undefined) next[key] = plain;
    }
  }
  return next;
}

/** Route path with query, hash, and id-like segments removed. */
export function scrubPathname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let path = value.trim();
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(path);
  if (absolute) path = absolute[1] ?? '/';
  path = path.split('?')[0].split('#')[0];
  if (!path.startsWith('/')) return null;
  const segments = path
    .split('/')
    // Any all-digit segment is an id, however short, so no order or product number rides along.
    .map((segment) => (/^\d+$|^[0-9a-f-]{16,}$|@/i.test(segment) ? ':id' : segment));
  const scrubbed = segments.join('/');
  // `*` is allowed so a caller can shorten a path to a prefix pattern.
  return /^[\w/().:~*-]{1,200}$/.test(scrubbed) ? scrubbed : null;
}

/**
 * A request path in the renderer: the first segment only, because a call can put a customer name,
 * a phone number, or a search term in the next one.
 */
export function scrubRequestPath(value: unknown): string | null {
  const pathname = scrubPathname(value);
  if (!pathname) return null;
  const segments = pathname.split('/');
  // `segments[0]` is the empty string before the leading slash.
  return segments.length > 2 ? `${segments.slice(0, 2).join('/')}/*` : pathname;
}

function withoutPersonOperators(event: ScrubbableEvent): ScrubbableEvent {
  const rest = { ...event };
  delete rest.$set;
  delete rest.$set_once;
  delete rest.$unset;
  return rest;
}

function withoutAccountKeys(properties: Record<string, unknown> | undefined): void {
  if (!properties) return;
  for (const key of ACCOUNT_KEYS) delete properties[key];
  if (properties.$set && typeof properties.$set === 'object') {
    for (const key of ACCOUNT_KEYS) delete (properties.$set as Record<string, unknown>)[key];
  }
}

function sentByAccount(event: ScrubbableEvent): boolean {
  return [event.distinctId, event.distinct_id, event.properties?.distinct_id].some(
    (id) => typeof id === 'string' && ACCOUNT_DISTINCT_ID.test(id),
  );
}

function scrubIdentify(event: ScrubbableEvent, telemetryEnabled: boolean): ScrubbableEvent {
  const source = event.properties ?? {};
  const properties: Record<string, unknown> = {};
  for (const key of ['distinct_id', 'token'] as const) {
    if (typeof source[key] === 'string' && source[key]) properties[key] = source[key];
  }
  if (source.$geoip_disable === true) properties.$geoip_disable = true;
  if (telemetryEnabled) {
    const set = {
      ...(personProperties(source.$set) ?? {}),
      ...(personProperties(event.$set) ?? {}),
    };
    if (Object.keys(set).length > 0) properties.$set = set;
  }
  return { ...withoutPersonOperators(event), properties };
}

function scrubUsage(event: ScrubbableEvent): ScrubbableEvent {
  const source = event.properties ?? {};
  const properties = contextProperties(source);
  for (const key of USAGE_PROPERTY_KEY_SET) {
    if (key in properties) continue;
    if (key === 'slowest_query') {
      if (typeof source[key] === 'string' && NORMALIZED_SQL.test(source[key])) {
        properties[key] = source[key];
      }
      continue;
    }
    const plain = plainValue(source[key]);
    if (plain !== undefined) properties[key] = plain;
  }
  return { ...withoutPersonOperators(event), properties };
}

/** The screen as a route pattern, on both properties PostHog reads. */
function setScreen(properties: Record<string, unknown>, pathname: string | null): void {
  if (!pathname) return;
  properties.$pathname = pathname;
  properties.$current_url = pathname;
}

function scrubPageview(event: ScrubbableEvent): ScrubbableEvent | null {
  const source = event.properties ?? {};
  const pathname = scrubPathname(source.$pathname ?? source.$current_url);
  if (!pathname) return null;
  const properties = contextProperties(source);
  setScreen(properties, pathname);
  for (const key of PAGEVIEW_KEYS) {
    const plain = key === 'screen' ? scrubPathname(source[key]) : plainValue(source[key]);
    if (plain !== undefined && plain !== null) properties[key] = plain;
  }
  return { ...withoutPersonOperators(event), properties };
}

function scrubException(
  event: ScrubbableEvent,
  options: PostHogScrubOptions & { defaultCapturePoint?: PostHogCapturePoint },
): ScrubbableEvent | null {
  const source = event.properties ?? {};
  const capturePoint = source.capture_point ?? options.defaultCapturePoint;
  if (!isPostHogCapturePoint(capturePoint)) return null;
  const context = contextProperties(source);
  // An exception captured outside FloCafe's own calls arrives without these fields.
  for (const [key, value] of Object.entries(options.exceptionContext ?? {})) {
    if (context[key] === undefined && typeof value === 'string' && value) context[key] = value;
  }
  // PostHog parses a frame by its language tag, not the OS; main-process frames are Node.
  const list = scrubExceptionList(
    source.$exception_list,
    options.exceptionContext ? 'node:javascript' : undefined,
  );
  const properties: Record<string, unknown> = {
    ...context,
    capture_point: capturePoint,
    $exception_list: list,
  };
  const first = list[0];
  if (typeof first?.type === 'string') properties.$exception_type = first.type;
  if (typeof first?.value === 'string') properties.$exception_message = first.value;
  // The screen, as a route pattern: no query, no ids. Next.js reports the full URL.
  setScreen(properties, scrubPathname(source.$pathname ?? source.$current_url));
  if (
    typeof source.$exception_level === 'string' &&
    /^[a-z]{1,10}$/.test(source.$exception_level)
  ) {
    properties.$exception_level = source.$exception_level;
  }
  // The request an exception failed on: a route pattern, its method, and its status.
  for (const key of API_FAILURE_KEYS) {
    const raw = source[key];
    // `requestRoute` sends this exact sentinel when Express cannot name the matched route.
    const value =
      key === 'http_route' ? (raw === '<unmatched>' ? raw : scrubPathname(raw)) : plainValue(raw);
    if (value !== undefined && value !== null) properties[key] = value;
  }
  return { ...withoutPersonOperators(event), properties };
}

function scrubDiagnosticEvent(event: ScrubbableEvent): ScrubbableEvent | null {
  const source = event.properties ?? {};
  const capturePoint = source.capture_point;
  if (!isPostHogCapturePoint(capturePoint)) return null;
  const properties: Record<string, unknown> = {
    ...contextProperties(source),
    capture_point: capturePoint,
  };
  for (const [key, allowed] of Object.entries(PRINT_ENUM_KEYS)) {
    const value = source[key];
    if (typeof value === 'string' && allowed.has(value)) properties[key] = value;
  }
  if (typeof source.correlation_id === 'string' && DIAGNOSTIC_ID.test(source.correlation_id)) {
    properties.correlation_id = source.correlation_id;
  }
  const errorText = scrubPrinterErrorText(source.error_text);
  if (errorText) properties.error_text = errorText;
  return { ...withoutPersonOperators(event), properties };
}

function scrubFailureFacts(value: unknown): Record<string, string | number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kept: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(kept).length >= MAX_FACTS) break;
    if (!FACT_KEY.test(key)) continue;
    if (typeof entry === 'number' && Number.isFinite(entry) && Math.abs(entry) <= MAX_FACT_NUMBER) {
      kept[key] = entry;
    } else if (typeof entry === 'string' && FACT_TEXT.test(entry)) {
      kept[key] = entry;
    }
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

function scrubOperationFailure(event: ScrubbableEvent): ScrubbableEvent | null {
  const source = event.properties ?? {};
  const capturePoint = source.capture_point;
  if (typeof capturePoint !== 'string' || !OPERATION_CAPTURE_POINT.test(capturePoint)) return null;
  const properties: Record<string, unknown> = {
    ...contextProperties(source),
    capture_point: capturePoint,
  };
  for (const key of ['reason_code', 'operation', 'stage'] as const) {
    const value = source[key];
    if (typeof value === 'string' && OPERATION_CODE.test(value)) properties[key] = value;
  }
  if (typeof source.classification === 'string' && OPERATION_CLASSES.has(source.classification))
    properties.classification = source.classification;
  if (typeof source.outcome === 'string' && OPERATION_OUTCOMES.has(source.outcome))
    properties.outcome = source.outcome;
  const count = source.count;
  if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 1 && count <= 100_000)
    properties.count = count;
  const facts = scrubFailureFacts(source.facts);
  if (facts) properties.facts = facts;
  // A correlation id names one attempt, not a window, so it is never part of this event.
  return { ...withoutPersonOperators(event), properties };
}

/** With telemetry off nothing may link an exception or a failure to the device or the store. */
function withoutLinkedRefs(
  scrubbed: ScrubbableEvent | null,
  telemetryEnabled: boolean,
): ScrubbableEvent | null {
  if (scrubbed && !telemetryEnabled) {
    for (const key of ['install_ref', 'store_ref', 'staff_ref']) delete scrubbed.properties?.[key];
  }
  return scrubbed;
}

/**
 * Returns the event as it may leave the machine, or null when it must not.
 * `defaultCapturePoint` tags exceptions an SDK captured on its own (renderer autocapture).
 */
export function scrubPostHogEvent(
  event: ScrubbableEvent | null,
  options: PostHogScrubOptions & { defaultCapturePoint?: PostHogCapturePoint },
): ScrubbableEvent | null {
  if (!event || typeof event.event !== 'string') return null;
  const named = event as ScrubbableEvent & { event: string };
  if (options.accountLinked) return scrubAllowed(named, options);
  if (named.event === '$create_alias' || sentByAccount(named)) return null;
  const scrubbed = scrubAllowed(named, options);
  withoutAccountKeys(scrubbed?.properties);
  return scrubbed;
}

function scrubAllowed(
  event: ScrubbableEvent & { event: string },
  options: PostHogScrubOptions & { defaultCapturePoint?: PostHogCapturePoint },
): ScrubbableEvent | null {
  if (event.event === '$create_alias') {
    if (!options.telemetryEnabled) return null;
    const source = event.properties ?? {};
    if (
      !FLO_DISTINCT_ID.test(String(source.distinct_id)) ||
      !FLO_DISTINCT_ID.test(String(source.alias))
    ) {
      return null;
    }
    const properties: Record<string, unknown> = {
      distinct_id: source.distinct_id,
      alias: source.alias,
    };
    if (typeof source.token === 'string') properties.token = source.token;
    return { ...withoutPersonOperators(event), properties };
  }
  if (event.event === '$identify' || event.event === '$set') {
    return scrubIdentify(event, options.telemetryEnabled);
  }
  if (event.event === '$exception') {
    if (!options.allowExceptions) return null;
    return withoutLinkedRefs(scrubException(event, options), options.telemetryEnabled);
  }
  if (event.event === 'operation_failed') {
    if (!options.allowExceptions) return null;
    return withoutLinkedRefs(scrubOperationFailure(event), options.telemetryEnabled);
  }
  if (DIAGNOSTIC_EVENT_SET.has(event.event)) {
    if (!options.allowExceptions) return null;
    return withoutLinkedRefs(scrubDiagnosticEvent(event), options.telemetryEnabled);
  }
  if (!options.telemetryEnabled) return null;
  if (event.event === '$pageview') return scrubPageview(event);
  if (USAGE_EVENT_SET.has(event.event)) return scrubUsage(event);
  return null;
}

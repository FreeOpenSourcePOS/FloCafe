import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { WASocket as BaileysSocket, WAMessageKey } from '@whiskeysockets/baileys';
import { parsePhoneNumber } from 'libphonenumber-js';
import { getDatabase, getSettingValue, now } from '../db';
import { SHUTDOWN_TIMEOUT_MS } from '../shutdown';
import { isOfflineMode } from './offline-mode';
import { getCountryByCode, getCurrencyFractionDigits } from '../countries';
import { parsePhoneE164 } from '../lib/phone';
import {
  WHATSAPP_AUTOMATION_SETTING_KEY,
  WHATSAPP_PLACEHOLDER_KEYS,
  WHATSAPP_PLACEHOLDER_GROUPS,
  WHATSAPP_PLACEHOLDERS,
  DEFAULT_WHATSAPP_AUTOMATION_CONFIG,
  DEFAULT_WHATSAPP_TEMPLATES,
  DEFAULT_WHATSAPP_RULES,
  DEFAULT_WHATSAPP_SAFETY,
  SAMPLE_WHATSAPP_TEMPLATE_CONTEXT,
  renderWhatsAppTemplate,
  buildSampleWhatsAppContext,
  normalizeWhatsAppAutomationConfig,
  isAutoOptOutText,
  isTimeWithinQuietHours,
  extractTriggerRule,
  type WhatsAppPlaceholderKey,
  type WhatsAppPlaceholderDefinition,
  type WhatsAppTemplateContext,
  type WhatsAppTriggerType,
  type WhatsAppRuleAttribution,
  type WhatsAppTemplate,
  type WhatsAppAutomationRule,
  type WhatsAppSafetyConfig,
  type WhatsAppAutomationConfig,
} from '../../shared/whatsapp-automation';

export {
  WHATSAPP_AUTOMATION_SETTING_KEY,
  WHATSAPP_PLACEHOLDER_KEYS,
  WHATSAPP_PLACEHOLDER_GROUPS,
  WHATSAPP_PLACEHOLDERS,
  DEFAULT_WHATSAPP_AUTOMATION_CONFIG,
  DEFAULT_WHATSAPP_TEMPLATES,
  DEFAULT_WHATSAPP_RULES,
  DEFAULT_WHATSAPP_SAFETY,
  SAMPLE_WHATSAPP_TEMPLATE_CONTEXT,
  renderWhatsAppTemplate,
  buildSampleWhatsAppContext,
  normalizeWhatsAppAutomationConfig,
  isAutoOptOutText,
  isTimeWithinQuietHours,
  extractTriggerRule,
  type WhatsAppPlaceholderKey,
  type WhatsAppPlaceholderDefinition,
  type WhatsAppTemplateContext,
  type WhatsAppTriggerType,
  type WhatsAppRuleAttribution,
  type WhatsAppTemplate,
  type WhatsAppAutomationRule,
  type WhatsAppSafetyConfig,
  type WhatsAppAutomationConfig,
};

const { loadBaileys: loadBaileysModule } = require('../baileys-loader.cjs') as {
  loadBaileys: () => Promise<typeof import('@whiskeysockets/baileys')>;
};

// Baileys is ESM-only; lazily load via dynamic import and cache reference.
let baileysModule: typeof import('@whiskeysockets/baileys') | null = null;
async function loadBaileys(): Promise<typeof import('@whiskeysockets/baileys')> {
  if (!baileysModule) {
    baileysModule = await loadBaileysModule();
  }
  return baileysModule;
}

type WhatsAppLogLevel = 'debug' | 'info' | 'warn' | 'error';
const WHATSAPP_LOG_LEVEL = process.env.FLO_WHATSAPP_LOG_LEVEL === 'debug' ? 'debug' : 'warn';
const WHATSAPP_LOG_LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function sanitizeLogText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/(?<!\d)\+?\d(?:[\s().-]*\d){6,14}(?!\d)/g, '[redacted-number]')
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|token|secret|password|auth|authorization|credential|api[_-]?key|key)["']?\s*[:=]\s*)(?:Bearer\s+)?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}]+)/gi,
      '$1[redacted]',
    )
    .slice(0, 240);
}

function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 5) return '[redacted-number]';
  return `+${'*'.repeat(Math.max(1, digits.length - 4))}${digits.slice(-4)}`;
}

function logWhatsApp(
  level: WhatsAppLogLevel,
  event: string,
  details: Record<string, unknown> = {},
): void {
  const line = `[WhatsApp] ${JSON.stringify({ event, ...details })}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (level === 'debug') console.debug(line);
  else console.info(line);
}

// Keep Baileys warnings/errors in the existing Electron main log. Its verbose
// debug stream is opt-in because it is otherwise too noisy for production.
type MinimalLogger = {
  level: string;
  trace: (...a: unknown[]) => void;
  debug: (...a: unknown[]) => void;
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
  fatal: (...a: unknown[]) => void;
  child: (obj: Record<string, unknown>) => MinimalLogger;
};
function makeBaileysLogger(): MinimalLogger {
  const emit =
    (level: WhatsAppLogLevel) =>
    (...args: unknown[]): void => {
      if (WHATSAPP_LOG_LEVELS[level] < WHATSAPP_LOG_LEVELS[WHATSAPP_LOG_LEVEL]) return;
      const message = typeof args[1] === 'string' ? args[1] : null;
      logWhatsApp(level === 'debug' ? 'debug' : level, 'baileys_log', {
        level,
        detail: sanitizeLogText(message),
      });
    };
  const logger: MinimalLogger = {
    level: WHATSAPP_LOG_LEVEL,
    trace: emit('debug'),
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    fatal: emit('error'),
    child: () => logger,
  };
  return logger;
}

const AUTH_DIR_NAME = 'whatsapp-auth';
const RATE_LIMIT_MAX_PER_HOUR = 4;
const RATE_LIMIT_MIN_GAP_MS = 30 * 1000;
const BODY_REPEAT_WINDOW_MS = 10 * 60 * 1000;
const RECENT_BODIES_PER_PHONE_MAX = 10;
const SENT_MESSAGE_CACHE_MAX = 256;
const TYPING_MIN_MS = 800;
const TYPING_MAX_PER_100_CHARS_MS = 4000;
const RECONNECT_DELAY_MS = 5_000;
const VERSION_FETCH_TIMEOUT_MS = 5_000;
const RATE_LIMITED_STATUS_CODES = new Set([429]);

// Baileys is extremely chatty at debug. Keep that level opt-in while retaining
// warnings and errors in the Electron log for packaged-app diagnostics.
const baileysLogger = makeBaileysLogger();

const SHORTENER_HOSTS = new Set([
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'shorturl.at',
  'rb.gy',
  'cutt.ly',
  'rebrand.ly',
]);

export type WhatsAppConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'waiting_qr'
  | 'waiting_pairing'
  | 'connected'
  | 'cooldown';

export interface WhatsAppStatus {
  enabled: boolean;
  state: WhatsAppConnectionState;
  connectedPhone: string | null;
  lastError: string | null;
  cooldownUntil: string | null;
  /** Stable reason code for frontend i18n translation of connection errors. */
  lastErrorReason?: string | null;
  qr?: string;
  pairingCode?: string;
}

interface QueuedSend {
  phoneE164: string;
  body: string;
  billId: number | null;
  customerId: string | number | null;
  kind: 'bill_receipt' | 'manual_reply' | 'auto_followup' | 'z_report';
  userId: string | null;
  signal?: AbortSignal;
}

const AUTOMATION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const state: {
  enabled: boolean;
  shuttingDown: boolean;
  socket: BaileysSocket | null;
  state: WhatsAppConnectionState;
  lastQr: string | null;
  lastPairingCode: string | null;
  connectedPhone: string | null;
  lastError: string | null;
  lastErrorReason: string | null;
  cooldownUntil: string | null;
  cooldownTimer: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  automationTimer: NodeJS.Timeout | null;
  lastSendByPhone: Map<string, number>;
  recentBodies: Map<string, { body: string; at: number }[]>;
  sentMessageCache: Map<string, any>;
  lidToPhoneMap: Map<string, string>;
} = {
  enabled: false,
  shuttingDown: false,
  socket: null,
  state: 'disconnected',
  lastQr: null,
  lastPairingCode: null,
  connectedPhone: null,
  lastError: null,
  lastErrorReason: null,
  cooldownUntil: null,
  cooldownTimer: null,
  reconnectTimer: null,
  automationTimer: null,
  lastSendByPhone: new Map(),
  recentBodies: new Map(),
  sentMessageCache: new Map(),
  lidToPhoneMap: new Map(),
};

type WhatsAppWorkCancellation = () => void;
const inFlightWhatsAppWork = new Map<Promise<unknown>, WhatsAppWorkCancellation>();
let whatsappShutdownPromise: Promise<void> | null = null;
let whatsappAbortController = new AbortController();
let whatsappStartPromise: Promise<void> | null = null;
let whatsappStartController: AbortController | null = null;
let whatsappStartAttempt = 0;
let credentialWriteTail: Promise<void> = Promise.resolve();
let authCleanupPromise: Promise<void> = Promise.resolve();
let shutdownSocket: BaileysSocket | null = null;
let whatsappTerminalCleanup = false;
let whatsappShutdownRequested = false;

function isWhatsAppTerminal(): boolean {
  return state.shuttingDown || whatsappTerminalCleanup;
}

function createWhatsAppAbortError(): Error & { code: string } {
  const error = new Error('WhatsApp work cancelled during shutdown') as Error & { code: string };
  error.code = 'ERR_SHUTDOWN_ABORTED';
  return error;
}

function cancelWhatsAppSocket(): void {
  if (!isWhatsAppTerminal()) return;
  const socket = state.socket ?? shutdownSocket;
  if (!socket) return;
  try {
    socket.end(undefined);
  } catch {}
}

function abortable<T>(
  operationFactory: () => Promise<T>,
  signal: AbortSignal,
  cancel: WhatsAppWorkCancellation = cancelWhatsAppSocket,
): Promise<T> {
  if (signal.aborted) return Promise.reject(createWhatsAppAbortError());
  let operation: Promise<T>;
  try {
    operation = operationFactory();
  } catch (error) {
    return Promise.reject(error);
  }
  trackWhatsAppWork(operation, cancel);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let aborted = false;
    let joinTimeout: NodeJS.Timeout | undefined;
    let onAbort = (): void => {};
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      if (joinTimeout) clearTimeout(joinTimeout);
    };
    onAbort = (): void => {
      if (settled || aborted) return;
      aborted = true;
      cancel();
      const settleCancellation = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(createWhatsAppAbortError());
      };
      if (!isWhatsAppTerminal()) {
        settleCancellation();
        return;
      }
      joinTimeout = setTimeout(settleCancellation, SHUTDOWN_TIMEOUT_MS);
      void operation.then(settleCancellation, settleCancellation);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled || aborted) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled || aborted) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(createWhatsAppAbortError());
  return new Promise<void>((resolve, reject) => {
    let onAbort = (): void => {};
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(createWhatsAppAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function trackWhatsAppWork<T>(
  operation: Promise<T>,
  cancel: WhatsAppWorkCancellation = cancelWhatsAppSocket,
): Promise<T> {
  inFlightWhatsAppWork.set(operation, cancel);
  void operation
    .finally(() => {
      inFlightWhatsAppWork.delete(operation);
      if (isWhatsAppTerminal() && inFlightWhatsAppWork.size === 0) {
        if (state.socket === shutdownSocket) state.socket = null;
        shutdownSocket = null;
      }
    })
    .catch(() => {});
  return operation;
}

function cancelInFlightWhatsAppWork(): void {
  for (const cancel of inFlightWhatsAppWork.values()) {
    try {
      cancel();
    } catch {}
  }
}

async function waitForWhatsAppWork(): Promise<void> {
  const drain = (async () => {
    while (inFlightWhatsAppWork.size > 0) {
      // Keys, not entries: the key is the in-flight operation. Spreading the Map
      // yields [operation, cancel] entry arrays, which allSettled treats as
      // non-thenable, so the loop would spin on microtasks and starve the timer
      // that bounds this drain.
      await Promise.allSettled([...inFlightWhatsAppWork.keys()]);
    }
  })();
  void drain.catch(() => {});
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      whatsappTerminalCleanup = true;
      cancelInFlightWhatsAppWork();
      const timeoutError = new Error(
        `WhatsApp shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms`,
      ) as Error & { code: string };
      timeoutError.code = 'ERR_SHUTDOWN_TIMEOUT';
      reject(timeoutError);
    }, SHUTDOWN_TIMEOUT_MS);
    drain.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function getAuthDir(): string {
  return path.join(app.getPath('userData'), AUTH_DIR_NAME);
}

function writeSetting(key: string, value: string): void {
  getDatabase()
    .prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `)
    .run(key, value, now());
}

export function getStatus(): WhatsAppStatus {
  return {
    enabled: state.enabled,
    state: state.state,
    connectedPhone: state.connectedPhone,
    lastError: state.lastError,
    lastErrorReason: state.lastErrorReason,
    cooldownUntil: state.cooldownUntil ?? null,
    qr: state.lastQr ?? undefined,
    pairingCode: state.lastPairingCode ?? undefined,
  };
}

/** Resolves user phone number to canonical WhatsApp JID via format normalization and registry check. */
async function resolveJid(
  phoneE164: string,
  sock: BaileysSocket,
  signal: AbortSignal,
): Promise<string | null> {
  let normalized: string;
  try {
    const pn = parsePhoneNumber(phoneE164);
    if (!pn?.isValid() && !pn?.isPossible()) return null;
    normalized = pn.number;
  } catch {
    return null;
  }
  const naive = `${normalized.replace('+', '')}@s.whatsapp.net`;
  try {
    const results = (await abortable(() => sock.onWhatsApp(naive), signal)) ?? [];
    return results[0]?.exists ? results[0].jid : null;
  } catch {
    return naive;
  }
}

/** Strip the device id and domain from a Baileys JID, leaving just the user. */
function userFromJid(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

/** Translates WhatsApp Local ID (@lid) JIDs back to phone-number JIDs. */
async function translateJid(
  jid: string,
  altJid: string | undefined,
  sock: BaileysSocket,
  signal: AbortSignal,
): Promise<string> {
  if (!jid.endsWith('@lid')) return jid;
  const lidUser = userFromJid(jid);
  const cached = state.lidToPhoneMap.get(lidUser);
  if (cached) return cached;
  if (altJid && !altJid.endsWith('@lid')) {
    const phoneJid = altJid.includes('@') ? altJid : `${altJid}@s.whatsapp.net`;
    if (!isActiveSocket(sock)) return jid;
    state.lidToPhoneMap.set(lidUser, phoneJid);
    return phoneJid;
  }
  try {
    const pn: string | null = await abortable(
      () => sock.signalRepository.lidMapping.getPNForLID(jid),
      signal,
    );
    if (pn) {
      if (!isActiveSocket(sock)) return jid;
      const phoneJid = `${userFromJid(pn)}@s.whatsapp.net`;
      state.lidToPhoneMap.set(lidUser, phoneJid);
      return phoneJid;
    }
  } catch {
    // best-effort
  }
  return jid;
}

function randomDelayMs(body: string): number {
  if (process.env.FLO_WHATSAPP_FAST_DELAY === '1') return 5;
  const perHundred = Math.ceil(body.length / 100);
  const lower = TYPING_MIN_MS * perHundred;
  const upper = TYPING_MAX_PER_100_CHARS_MS * perHundred;
  return lower + Math.floor(Math.random() * (upper - lower));
}

export function getAutomationConfig(): WhatsAppAutomationConfig {
  const raw = getSettingValue(WHATSAPP_AUTOMATION_SETTING_KEY);
  return normalizeWhatsAppAutomationConfig(raw);
}

export function saveAutomationConfig(raw: unknown): WhatsAppAutomationConfig {
  const normalized = normalizeWhatsAppAutomationConfig(raw);
  writeSetting(WHATSAPP_AUTOMATION_SETTING_KEY, JSON.stringify(normalized));
  return normalized;
}

export function isCurrentlyQuietHours(
  safety: WhatsAppSafetyConfig = getAutomationConfig().safety,
  nowDate: Date = new Date(),
): boolean {
  if (!safety.quietHoursEnabled) return false;
  const tz = getSettingValue('timezone') || 'UTC';
  let currentHhMm = '00:00';
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(nowDate);
    currentHhMm = formatted.replace(/^24:/, '00:');
  } catch {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(nowDate);
    currentHhMm = formatted.replace(/^24:/, '00:');
  }
  return isTimeWithinQuietHours(currentHhMm, safety.quietHoursStart, safety.quietHoursEnd);
}

export function isOverWeeklyAutomatedCap(
  phoneE164: string,
  maxPerCustomerPerWeek = getAutomationConfig().safety.maxPerCustomerPerWeek,
): boolean {
  if (!Number.isFinite(maxPerCustomerPerWeek) || maxPerCustomerPerWeek <= 0) return false;
  const db = getDatabase();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\..*$/, '');
  const row = db
    .prepare(`
      SELECT COUNT(*) AS c FROM whatsapp_messages
      WHERE phone_e164 = ?
        AND direction = 'outbound'
        AND (kind = 'auto_followup' OR created_by_user_id LIKE 'rule:%')
        AND queued_at >= ?
    `)
    .get(phoneE164, sevenDaysAgo) as { c: number };
  return row.c >= maxPerCustomerPerWeek;
}

function isAutomatedSend(req: QueuedSend): boolean {
  return (
    req.kind === 'auto_followup' ||
    (typeof req.userId === 'string' && req.userId.startsWith('rule:'))
  );
}

function hasShortenerOrNonHttps(body: string): string | null {
  const urlRe = /\bhttps?:\/\/[^\s)]+/gi;
  const matches = body.match(urlRe);
  if (!matches) return null;
  for (const raw of matches) {
    if (!raw.toLowerCase().startsWith('https://')) {
      return `Refusing non-HTTPS link: ${raw.slice(0, 80)}`;
    }
    try {
      const host = new URL(raw).hostname.toLowerCase();
      if (SHORTENER_HOSTS.has(host)) {
        return `Refusing URL shortener link: ${host}`;
      }
    } catch {
      return `Refusing unparseable URL: ${raw.slice(0, 80)}`;
    }
  }
  return null;
}

function isDuplicateBody(phoneE164: string, body: string): boolean {
  const cutoff = Date.now() - BODY_REPEAT_WINDOW_MS;
  const recent = state.recentBodies.get(phoneE164) ?? [];
  const fresh = recent.filter((r) => r.at >= cutoff);
  for (const r of fresh) {
    if (r.body === body) {
      state.recentBodies.set(phoneE164, fresh);
      return true;
    }
  }
  fresh.push({ body, at: Date.now() });
  // Bound the per-phone history to avoid unbounded growth in long-running installs.
  if (fresh.length > RECENT_BODIES_PER_PHONE_MAX)
    fresh.splice(0, fresh.length - RECENT_BODIES_PER_PHONE_MAX);
  state.recentBodies.set(phoneE164, fresh);
  return false;
}

function isBlocked(phoneE164: string): boolean {
  const row = getDatabase()
    .prepare('SELECT 1 FROM whatsapp_blocklist WHERE phone_e164 = ?')
    .get(phoneE164);
  return !!row;
}

function isOverRateLimit(
  phoneE164: string,
  maxPerHour = RATE_LIMIT_MAX_PER_HOUR,
  skipMinGap = false,
): { limited: boolean; retryAfterMs?: number } {
  if (!skipMinGap && process.env.FLO_WHATSAPP_FAST_DELAY !== '1') {
    const last = state.lastSendByPhone.get(phoneE164);
    if (last) {
      const gap = Date.now() - last;
      if (gap < RATE_LIMIT_MIN_GAP_MS) {
        return { limited: true, retryAfterMs: RATE_LIMIT_MIN_GAP_MS - gap };
      }
    }
  }
  const db = getDatabase();
  // Space form, same as now()/queued_at — an ISO-Z bound would sort above
  // every space-form row of the same day and the rate limit would never fire.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\..*$/, '');
  const row = db
    .prepare(`
    SELECT COUNT(*) AS c FROM whatsapp_messages
    WHERE phone_e164 = ? AND direction = 'outbound' AND queued_at >= ?
  `)
    .get(phoneE164, oneHourAgo) as { c: number };
  if (row.c >= maxPerHour) {
    return { limited: true };
  }
  return { limited: false };
}

function isInCooldown(): boolean {
  if (!state.cooldownUntil) return false;
  return new Date(state.cooldownUntil).getTime() > Date.now();
}

function triggerCooldown(
  reason: string,
  durationMs = 5 * 60 * 1000,
  reasonCode: string = 'cooldown',
): void {
  const until = new Date(Date.now() + durationMs).toISOString();
  state.cooldownUntil = until;
  state.lastError = reason;
  state.lastErrorReason = reasonCode;
  if (state.cooldownTimer) clearTimeout(state.cooldownTimer);
  state.cooldownTimer = setTimeout(() => {
    state.cooldownUntil = null;
  }, durationMs);
}

function recordMessageRow(row: {
  phone_e164: string;
  direction: 'inbound' | 'outbound';
  kind: QueuedSend['kind'];
  status: string;
  body: string;
  external_message_id?: string | null;
  error?: string | null;
  bill_id?: number | null;
  customer_id?: string | number | null;
  created_by_user_id?: string | null;
  timestamp_field?: 'seen_at' | 'typing_at' | 'sent_at' | 'delivered_at' | 'read_at' | 'failed_at';
  external_id?: string;
}): number {
  const db = getDatabase();
  const tsField = row.timestamp_field;
  const baseTs = now();
  const result = db
    .prepare(`
    INSERT INTO whatsapp_messages (
      bill_id, customer_id, phone_e164, direction, kind, status,
      body, external_message_id, error, queued_at,
      seen_at, typing_at, sent_at, delivered_at, read_at, failed_at,
      created_by_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      row.bill_id ?? null,
      row.customer_id ?? null,
      row.phone_e164,
      row.direction,
      row.kind,
      row.status,
      row.body,
      row.external_message_id ?? row.external_id ?? null,
      row.error ?? null,
      baseTs,
      tsField === 'seen_at' ? baseTs : null,
      tsField === 'typing_at' ? baseTs : null,
      tsField === 'sent_at' ? baseTs : null,
      tsField === 'delivered_at' ? baseTs : null,
      tsField === 'read_at' ? baseTs : null,
      tsField === 'failed_at' ? baseTs : null,
      row.created_by_user_id ?? null,
    );
  return Number(result.lastInsertRowid);
}

const ALLOWED_TIMESTAMP_FIELDS = new Set([
  'seen_at',
  'typing_at',
  'sent_at',
  'delivered_at',
  'read_at',
  'failed_at',
]);

function updateMessageRow(
  id: number,
  patch: {
    status?: string;
    external_message_id?: string | null;
    error?: string | null;
    timestamp_field?:
      | 'seen_at'
      | 'typing_at'
      | 'sent_at'
      | 'delivered_at'
      | 'read_at'
      | 'failed_at';
  },
): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: any[] = [];
  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (patch.external_message_id !== undefined) {
    fields.push('external_message_id = ?');
    values.push(patch.external_message_id);
  }
  if (patch.error !== undefined) {
    fields.push('error = ?');
    values.push(patch.error);
  }
  if (patch.timestamp_field && ALLOWED_TIMESTAMP_FIELDS.has(patch.timestamp_field)) {
    fields.push(`${patch.timestamp_field} = ?`);
    values.push(now());
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE whatsapp_messages SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/** Advances message status and backfills earlier timestamps using COALESCE. */
function advanceStatus(id: number, latest: 'sent' | 'delivered' | 'read'): void {
  const ts = now();
  const stamps = new Set<string>([latest]);
  if (latest === 'read') {
    stamps.add('delivered');
    stamps.add('sent');
  } else if (latest === 'delivered') {
    stamps.add('sent');
  }
  const exprs = Array.from(stamps, (s) => `${s}_at = COALESCE(${s}_at, ?)`).join(', ');
  const placeholders = Array(stamps.size).fill(ts);
  getDatabase()
    .prepare(`UPDATE whatsapp_messages SET status = ?, ${exprs} WHERE id = ?`)
    .run(latest, ...placeholders, id);
}

function findMessageByExternalId(externalId: string): { id: number; phone_e164: string } | null {
  const row = getDatabase()
    .prepare('SELECT id, phone_e164 FROM whatsapp_messages WHERE external_message_id = ?')
    .get(externalId) as { id: number; phone_e164: string } | undefined;
  return row ?? null;
}

export function processInboundOptOut(phoneE164: string, body: string): boolean {
  if (!phoneE164 || !isAutoOptOutText(body)) return false;
  const safety = getAutomationConfig().safety;
  if (!safety.autoOptOutEnabled) return false;
  const keyword = body.trim().toUpperCase().slice(0, 40);
  addToBlocklist(phoneE164, `Auto opt-out: ${keyword}`, 'system:auto_opt_out');
  return true;
}

async function persistIncoming(msg: any, sock: BaileysSocket): Promise<void> {
  if (!msg?.message) return;
  const signal = whatsappAbortController.signal;
  const rawJid: string = msg.key?.remoteJid ?? '';
  if (!rawJid || rawJid === 'status@broadcast') return;
  const isGroup = rawJid.endsWith('@g.us');
  // Translate DM @lid to phone JID while preserving group chat @g.us JIDs.
  const resolvedJid = isGroup
    ? rawJid
    : await translateJid(rawJid, msg.key?.remoteJidAlt, sock, signal);
  if (!isActiveSocket(sock)) return;
  const phone = '+' + userFromJid(resolvedJid);
  const body =
    msg.message?.conversation ??
    msg.message?.extendedTextMessage?.text ??
    msg.message?.imageMessage?.caption ??
    msg.message?.videoMessage?.caption ??
    '';
  if (!body) return;
  if (!isActiveSocket(sock)) return;
  recordMessageRow({
    phone_e164: phone,
    direction: 'inbound',
    kind: 'manual_reply',
    status: 'delivered',
    body,
    external_message_id: msg.key?.id ?? null,
    created_by_user_id: null,
  });
  if (!isGroup) {
    processInboundOptOut(phone, body);
  }
}

async function runSocketPhase<T>(
  attemptId: number,
  phase: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    logWhatsApp('info', 'socket_phase', {
      attemptId,
      phase,
      ok: true,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    logWhatsApp('error', 'socket_phase', {
      attemptId,
      phase,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: sanitizeLogText(error),
    });
    throw error;
  }
}

function isActiveSocket(socket: BaileysSocket): boolean {
  return !isWhatsAppTerminal() && state.socket === socket;
}

function attachSocketHandlers(socket: BaileysSocket): void {
  socket.ev.on('connection.update', (update: any) => {
    void trackWhatsAppWork(
      (async () => {
        if (!isActiveSocket(socket)) return;
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          state.lastQr = qr;
          state.lastPairingCode = null;
          state.state = 'waiting_qr';
          logWhatsApp('info', 'connection_state', { state: 'waiting_qr' });
        }
        if (connection === 'open') {
          state.state = 'connected';
          state.lastQr = null;
          state.lastPairingCode = null;
          state.lastError = null;
          state.lastErrorReason = null;
          const user = (socket as any).user;
          if (user?.id) {
            const phone = '+' + userFromJid(user.id);
            state.connectedPhone = phone;
            writeSetting('whatsapp_connected_phone', phone);
          }
          logWhatsApp('info', 'connection_state', {
            state: 'connected',
            phone: maskPhone(state.connectedPhone),
          });
        } else if (connection === 'close') {
          const disconnectError = lastDisconnect?.error;
          const status = (disconnectError as any)?.output?.statusCode as number | undefined;
          state.socket = null;
          state.lastQr = null;
          state.lastPairingCode = null;
          logWhatsApp('warn', 'connection_state', {
            state: 'closed',
            statusCode: status ?? null,
            reason: sanitizeLogText(disconnectError),
          });
          // Baileys's DisconnectReason.loggedOut == 401. Hardcoded here so we
          // don't have to load Baileys synchronously just to compare a number.
          if (status === 401) {
            // Server-side logout — stale creds will 401 again. Wipe and force
            // a fresh QR pairing on next start.
            state.state = 'disconnected';
            state.connectedPhone = null;
            writeSetting('whatsapp_connected_phone', '');
            state.lastError = 'Logged out. Reconnect to continue.';
            state.lastErrorReason = 'logged_out';
            scheduleAuthWipe();
          } else if (!isWhatsAppTerminal() && state.enabled) {
            // Auto-reconnect on transient disconnections; cooldown only applies to explicit 429 errors.
            state.state = 'connecting';
            state.lastError = `Connection closed (${status ?? 'unknown'}), reconnecting in ${RECONNECT_DELAY_MS / 1000}s…`;
            state.lastErrorReason = 'reconnecting';
            if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
            logWhatsApp('info', 'reconnect_scheduled', {
              delayMs: RECONNECT_DELAY_MS,
              statusCode: status ?? null,
            });
            state.reconnectTimer = setTimeout(() => {
              state.reconnectTimer = null;
              if (state.enabled && !isWhatsAppTerminal()) {
                logWhatsApp('info', 'reconnect_attempt');
                void startSocket()
                  .then(() => logWhatsApp('info', 'reconnect_started'))
                  .catch((err) =>
                    logWhatsApp('error', 'reconnect_failed', { error: sanitizeLogText(err) }),
                  );
              }
            }, RECONNECT_DELAY_MS);
          } else {
            state.state = 'disconnected';
          }
        }
      })(),
    ).catch(() => {});
  });

  socket.ev.on('creds.update', () => {});

  // Keep the LID→phone cache fresh. WhatsApp rotates these over time.
  socket.ev.on('lid-mapping.update', (update: any) => {
    if (!isActiveSocket(socket)) return;
    const lid = update?.lid as string | undefined;
    const pn = update?.pn as string | undefined;
    if (!lid || !pn) return;
    const lidUser = userFromJid(lid);
    const phoneJid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
    state.lidToPhoneMap.set(lidUser, phoneJid);
  });

  socket.ev.on('messages.upsert', ({ messages }: { messages: any[] }) => {
    void trackWhatsAppWork(
      (async () => {
        if (!isActiveSocket(socket)) return;
        const filterGroups = getSettingValue('whatsapp_filter_groups') === 'true';
        for (const msg of messages) {
          if (!isActiveSocket(socket)) return;
          if (msg.key?.fromMe) continue;
          // Ignore incoming group messages when group filtering is enabled.
          if (filterGroups && msg.key?.remoteJid?.endsWith('@g.us')) continue;
          await persistIncoming(msg, socket);
        }
      })(),
    ).catch(() => {});
  });

  socket.ev.on('messages.update', (updates: any[]) => {
    void trackWhatsAppWork(
      (async () => {
        if (!isActiveSocket(socket)) return;
        for (const u of updates) {
          if (!isActiveSocket(socket)) return;
          const id = u.key?.id;
          if (!id) continue;
          const stored = findMessageByExternalId(id);
          if (!stored) continue;
          const status = u.update?.status;
          if (status === undefined) continue;
          // Map Baileys status updates: 2=SERVER_ACK (sent), 3=delivered, 4=read.
          if (status === 2) advanceStatus(stored.id, 'sent');
          else if (status === 3) advanceStatus(stored.id, 'delivered');
          else if (status === 4) advanceStatus(stored.id, 'read');
        }
      })(),
    ).catch(() => {});
  });
}

async function resolveWaWebVersion(
  signal: AbortSignal,
): Promise<[number, number, number] | undefined> {
  // Fetch latest WhatsApp Web version to prevent connection rejection from stale build hashes.
  try {
    const res = await fetch('https://wppconnect.io/whatsapp-versions/', {
      signal: AbortSignal.any([signal, AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS)]),
    });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/2\.3000\.(\d+)/);
      if (match) return [2, 3000, Number(match[1])];
    }
  } catch {
    // fall through
  }
  try {
    const { fetchLatestWaWebVersion } = await abortable(() => loadBaileys(), signal);
    const { version } = await abortable(() => fetchLatestWaWebVersion({}), signal);
    return version as [number, number, number];
  } catch {
    // fall through
  }
  // Let Baileys use its hardcoded fallback. Better than refusing to start.
  return undefined;
}

async function startSocketImpl(attemptId: number): Promise<void> {
  const signal = whatsappAbortController.signal;
  if (!state.enabled || isWhatsAppTerminal() || signal.aborted) return;
  if (isOfflineMode()) {
    logWhatsApp('info', 'socket_start_skipped', { attemptId, reason: 'offline_mode' });
    return;
  }
  await authCleanupPromise;
  await credentialWriteTail;
  if (!state.enabled || isWhatsAppTerminal() || signal.aborted || isOfflineMode()) return;
  logWhatsApp('info', 'socket_start', { attemptId });
  if (state.socket) {
    logWhatsApp('info', 'socket_start_skipped', { attemptId, reason: 'socket_exists' });
    return;
  }
  const authDir = getAuthDir();
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  }
  const version = await runSocketPhase(attemptId, 'version_lookup', () =>
    resolveWaWebVersion(signal),
  );
  if (isWhatsAppTerminal() || signal.aborted || isOfflineMode()) return;
  const { useMultiFileAuthState, makeWASocket, Browsers, proto } = await runSocketPhase(
    attemptId,
    'baileys_load',
    () => abortable(() => loadBaileys(), signal),
  );
  if (isWhatsAppTerminal() || signal.aborted || isOfflineMode()) return;
  const { state: authState, saveCreds } = await runSocketPhase(attemptId, 'auth_load', () =>
    abortable(() => useMultiFileAuthState(authDir), signal),
  );
  if (isWhatsAppTerminal() || signal.aborted || isOfflineMode()) return;
  const socket = await runSocketPhase(attemptId, 'socket_create', () =>
    makeWASocket({
      version,
      auth: authState,
      printQRInTerminal: false,
      logger: baileysLogger,
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async (key: WAMessageKey) => {
        const cached = state.sentMessageCache.get(key.id ?? '');
        if (cached) return cached;
        // Return empty message to avoid hanging on re-encryption requests.
        return proto.Message.create({});
      },
    }),
  );
  if (isWhatsAppTerminal() || signal.aborted || isOfflineMode()) {
    try {
      socket.end(undefined);
    } catch {}
    return;
  }
  state.socket = socket;
  state.state = 'connecting';
  attachSocketHandlers(socket);
  socket.ev.on('creds.update', (...args: unknown[]) => {
    queueCredentialWrite(socket, saveCreds as (...values: unknown[]) => unknown, args);
  });
  logWhatsApp('info', 'socket_created', { attemptId, state: state.state });
}

function wipeAuthDir(): void {
  try {
    fs.rmSync(getAuthDir(), { recursive: true, force: true });
  } catch (err) {
    logWhatsApp('error', 'auth_cleanup_failed', { error: sanitizeLogText(err) });
  }
}

function scheduleAuthWipe(): void {
  const pendingWrites = credentialWriteTail;
  authCleanupPromise = authCleanupPromise.then(() => pendingWrites).then(() => wipeAuthDir());
}

function queueCredentialWrite(
  socket: BaileysSocket,
  saveCreds: (...values: unknown[]) => unknown,
  args: unknown[],
): void {
  if (!isActiveSocket(socket)) return;
  const write = credentialWriteTail.then(async () => {
    if (!isActiveSocket(socket)) return;
    await saveCreds(...args);
  });
  credentialWriteTail = write.catch((error) => {
    logWhatsApp('error', 'credentials_save_failed', { error: sanitizeLogText(error) });
  });
  void trackWhatsAppWork(write, () => {}).catch(() => {});
}

function startSocket(requestSignal?: AbortSignal): Promise<void> {
  // Test processes never need a live WhatsApp session. Dialing out only adds
  // third-party latency and a reconnect loop to an otherwise deterministic run.
  if (process.env.FLO_WHATSAPP_SOCKET_DISABLED === '1') {
    logWhatsApp('info', 'socket_start_skipped', { reason: 'externally_disabled' });
    return Promise.resolve();
  }
  if (isOfflineMode()) {
    logWhatsApp('info', 'socket_start_skipped', { reason: 'offline_mode' });
    return Promise.resolve();
  }
  const previousStart = whatsappStartPromise;
  if (previousStart && !whatsappStartController?.signal.aborted) {
    logWhatsApp('info', 'socket_start_deduplicated', { attemptId: whatsappStartAttempt });
    return previousStart;
  }
  if (previousStart) {
    logWhatsApp('info', 'socket_start_replacing_cancelled', { attemptId: whatsappStartAttempt });
  }
  if (!state.enabled || isWhatsAppTerminal() || requestSignal?.aborted) return Promise.resolve();
  if (state.socket) {
    logWhatsApp('info', 'socket_start_skipped', { reason: 'socket_exists' });
    return Promise.resolve();
  }

  const attemptId = ++whatsappStartAttempt;
  const startedAt = Date.now();
  const startController = whatsappAbortController;
  state.state = 'connecting';
  let sharedPromise: Promise<void>;
  const startup = (previousStart ? previousStart.catch(() => {}) : Promise.resolve())
    .then(() => startSocketImpl(attemptId))
    .then(() => {
      logWhatsApp('info', 'socket_start_result', {
        attemptId,
        ok: true,
        durationMs: Date.now() - startedAt,
      });
    })
    .catch((error) => {
      if (
        !isWhatsAppTerminal() &&
        !startController.signal.aborted &&
        attemptId === whatsappStartAttempt
      ) {
        state.socket = null;
        state.state = 'disconnected';
        state.lastError = 'WhatsApp connection could not be started.';
        state.lastErrorReason = 'startup_failed';
      }
      logWhatsApp('error', 'socket_start_result', {
        attemptId,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: sanitizeLogText(error),
      });
      throw error;
    });
  sharedPromise = trackWhatsAppWork(startup).finally(() => {
    if (whatsappStartPromise === sharedPromise) {
      whatsappStartPromise = null;
      whatsappStartController = null;
    }
  });
  whatsappStartPromise = sharedPromise;
  whatsappStartController = startController;
  return sharedPromise;
}

function ensureAutomationTimer(): void {
  if (state.automationTimer) {
    clearInterval(state.automationTimer);
    state.automationTimer = null;
  }
  if (!state.enabled || isWhatsAppTerminal() || process.env.FLO_WHATSAPP_SOCKET_DISABLED === '1') {
    return;
  }
  state.automationTimer = setInterval(() => {
    if (!state.enabled || isWhatsAppTerminal() || state.state !== 'connected') return;
    void runScheduledAutomationSweep().catch(() => {});
  }, AUTOMATION_SWEEP_INTERVAL_MS);
  state.automationTimer.unref?.();
}

export async function enable(userId: string): Promise<{ ok: boolean; error?: string }> {
  if (whatsappShutdownPromise || whatsappShutdownRequested)
    return { ok: false, error: 'WhatsApp is shutting down.' };
  state.enabled = true;
  // Reset shutdown flag so the auto-reconnect-on-disconnect logic in the
  // close handler is active again after a previous disable() round.
  state.shuttingDown = false;
  if (whatsappAbortController.signal.aborted) whatsappAbortController = new AbortController();
  writeSetting('whatsapp_enabled', 'true');
  writeSetting('whatsapp_activated_by_user_id', userId);
  writeSetting('whatsapp_activated_at', now());
  writeSetting('whatsapp_disclosure_version_acknowledged', '1');
  state.lastError = null;
  state.lastErrorReason = null;
  ensureAutomationTimer();
  // Restore session from existing credentials if present to avoid unneeded re-pairing.
  const credsPath = path.join(getAuthDir(), 'creds.json');
  if (fs.existsSync(credsPath)) {
    void startSocket().catch((err) => {
      logWhatsApp('error', 'auto_restore_failed', { error: sanitizeLogText(err) });
    });
  }
  return { ok: true };
}

export function disable(): void {
  state.enabled = false;
  state.shuttingDown = true;
  whatsappAbortController.abort();
  writeSetting('whatsapp_enabled', 'false');
  writeSetting('whatsapp_connected_phone', '');
  if (state.socket) {
    try {
      state.socket.end(undefined);
    } catch {
      /* ignore */
    }
    state.socket = null;
  }
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.automationTimer) {
    clearInterval(state.automationTimer);
    state.automationTimer = null;
  }
  state.state = 'disconnected';
  state.connectedPhone = null;
  state.lastQr = null;
  state.lastPairingCode = null;
  state.lastError = null;
  state.lastErrorReason = null;
  state.cooldownUntil = null;
  if (state.cooldownTimer) {
    clearTimeout(state.cooldownTimer);
    state.cooldownTimer = null;
  }
  scheduleAuthWipe();
}

export async function connectWithQr(
  requestSignal?: AbortSignal,
): Promise<{ ok: boolean; qr?: string; error?: string }> {
  if (!state.enabled) return { ok: false, error: 'WhatsApp is not enabled.' };
  if (isOfflineMode()) return { ok: false, error: 'Offline mode is on.' };
  if (whatsappShutdownPromise || whatsappShutdownRequested)
    return { ok: false, error: 'WhatsApp is shutting down.' };
  state.shuttingDown = false;
  if (whatsappAbortController.signal.aborted) whatsappAbortController = new AbortController();
  const signal = requestSignal
    ? AbortSignal.any([requestSignal, whatsappAbortController.signal])
    : whatsappAbortController.signal;
  if (signal.aborted) return { ok: false, error: 'WhatsApp request cancelled.' };
  state.lastQr = null;
  state.lastPairingCode = null;
  await abortable(() => startSocket(signal), signal);
  // QR arrives asynchronously via connection.update
  return { ok: true };
}

export async function connectWithPairingCode(
  phone: string,
  requestSignal?: AbortSignal,
): Promise<{ ok: boolean; code?: string; error?: string }> {
  if (!state.enabled) return { ok: false, error: 'WhatsApp is not enabled.' };
  if (isOfflineMode()) return { ok: false, error: 'Offline mode is on.' };
  if (whatsappShutdownPromise || whatsappShutdownRequested)
    return { ok: false, error: 'WhatsApp is shutting down.' };
  state.shuttingDown = false;
  if (whatsappAbortController.signal.aborted) whatsappAbortController = new AbortController();
  const signal = requestSignal
    ? AbortSignal.any([requestSignal, whatsappAbortController.signal])
    : whatsappAbortController.signal;
  if (signal.aborted) return { ok: false, error: 'WhatsApp request cancelled.' };
  try {
    if (!state.socket) {
      await abortable(() => startSocket(signal), signal);
      await abortableDelay(1500, signal);
    }
    if (!state.socket) return { ok: false, error: 'Socket not ready, try again.' };
    const code = await abortable(
      () => state.socket!.requestPairingCode(phone.replace(/\D/g, '')),
      signal,
    );
    state.lastPairingCode = code;
    state.state = 'waiting_pairing';
    return { ok: true, code };
  } catch (err: any) {
    return { ok: false, error: err.message ?? 'Failed to request pairing code.' };
  }
}

/** Closes the live socket without unpairing so Offline mode can be switched off again. */
export function suspendForOfflineMode(): void {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.socket) {
    try {
      state.socket.end(undefined);
    } catch {
      /* ignore */
    }
    state.socket = null;
  }
  state.state = 'disconnected';
}

export function disconnect(): void {
  // Set shuttingDown before closing socket to prevent automatic reconnect loops.
  state.shuttingDown = true;
  whatsappAbortController.abort();
  if (state.socket) {
    try {
      state.socket.logout();
    } catch {
      /* ignore */
    }
    try {
      state.socket.end(undefined);
    } catch {
      /* ignore */
    }
    state.socket = null;
  }
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.automationTimer) {
    clearInterval(state.automationTimer);
    state.automationTimer = null;
  }
  state.state = 'disconnected';
  state.connectedPhone = null;
  state.lastQr = null;
  state.lastPairingCode = null;
  state.lastError = null;
  state.lastErrorReason = null;
  writeSetting('whatsapp_connected_phone', '');
  scheduleAuthWipe();
}

export interface SendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
  reason?:
    | 'feature_off'
    | 'no_phone'
    | 'blocked'
    | 'quiet_hours'
    | 'weekly_cap'
    | 'rate_limited'
    | 'cooldown'
    | 'not_connected'
    | 'not_on_whatsapp'
    | 'content_blocked'
    | 'send_failed';
}

const sendLocks = new Map<string, Promise<void>>();

// Serializes outgoing sends per recipient to prevent race conditions during rate-limit checks.
export function sendMessage(req: QueuedSend): Promise<SendResult> {
  return trackWhatsAppWork(sendMessageWithLock(req));
}

async function sendMessageWithLock(req: QueuedSend): Promise<SendResult> {
  const startedAt = Date.now();
  logWhatsApp('info', 'send_requested', { phone: maskPhone(req.phoneE164) });
  const signal = req.signal
    ? AbortSignal.any([whatsappAbortController.signal, req.signal])
    : whatsappAbortController.signal;
  const previous = sendLocks.get(req.phoneE164) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  sendLocks.set(req.phoneE164, current);
  try {
    await abortable(() => previous, signal);
    if (isWhatsAppTerminal()) {
      const result = {
        ok: false,
        error: 'WhatsApp is shutting down.',
        reason: 'send_failed' as const,
      };
      logWhatsApp('warn', 'send_result', {
        phone: maskPhone(req.phoneE164),
        ok: false,
        reason: result.reason,
        durationMs: Date.now() - startedAt,
      });
      return result;
    }
    const result = await sendMessageInternal(req, signal);
    logWhatsApp(result.ok ? 'info' : 'warn', 'send_result', {
      phone: maskPhone(req.phoneE164),
      ok: result.ok,
      reason: result.reason ?? 'sent',
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    if (isWhatsAppTerminal() || signal.aborted) {
      const result = {
        ok: false,
        error: 'WhatsApp is shutting down.',
        reason: 'send_failed' as const,
      };
      logWhatsApp('warn', 'send_result', {
        phone: maskPhone(req.phoneE164),
        ok: false,
        reason: result.reason,
        durationMs: Date.now() - startedAt,
      });
      return result;
    }
    logWhatsApp('error', 'send_result', {
      phone: maskPhone(req.phoneE164),
      ok: false,
      reason: 'send_failed',
      error: sanitizeLogText(error),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  } finally {
    release();
    if (sendLocks.get(req.phoneE164) === current) sendLocks.delete(req.phoneE164);
  }
}

async function sendMessageInternal(req: QueuedSend, signal: AbortSignal): Promise<SendResult> {
  if (!state.enabled || isWhatsAppTerminal())
    return { ok: false, error: 'WhatsApp is not enabled.', reason: 'feature_off' };
  if (!req.phoneE164) return { ok: false, error: 'Phone number required.', reason: 'no_phone' };
  if (isBlocked(req.phoneE164)) {
    return { ok: false, error: 'This number asked to stop receiving messages.', reason: 'blocked' };
  }
  const automationConfig = getAutomationConfig();
  const automated = isAutomatedSend(req);
  if (automated) {
    if (automationConfig.safety.quietHoursEnabled && isCurrentlyQuietHours(automationConfig.safety)) {
      return { ok: false, error: 'Automated messages are paused during quiet hours.', reason: 'quiet_hours' };
    }
    if (isOverWeeklyAutomatedCap(req.phoneE164, automationConfig.safety.maxPerCustomerPerWeek)) {
      return { ok: false, error: 'Weekly automated message limit reached for this customer.', reason: 'weekly_cap' };
    }
  }
  if (state.state !== 'connected' || !state.socket) {
    return { ok: false, error: 'Flo is not connected to WhatsApp.', reason: 'not_connected' };
  }
  const socket = state.socket;
  const jid = await resolveJid(req.phoneE164, socket, signal);
  if (isWhatsAppTerminal())
    return { ok: false, error: 'WhatsApp is shutting down.', reason: 'send_failed' };
  if (!jid) {
    return {
      ok: false,
      error: 'This phone is not registered on WhatsApp.',
      reason: 'not_on_whatsapp',
    };
  }
  if (isInCooldown()) {
    return { ok: false, error: 'Send is temporarily paused.', reason: 'cooldown' };
  }
  const rate = isOverRateLimit(req.phoneE164, RATE_LIMIT_MAX_PER_HOUR, automated);
  if (rate.limited) {
    return { ok: false, error: 'Rate limit reached for this number.', reason: 'rate_limited' };
  }
  const contentErr = hasShortenerOrNonHttps(req.body);
  if (contentErr) {
    return { ok: false, error: contentErr, reason: 'content_blocked' };
  }
  if (isDuplicateBody(req.phoneE164, req.body)) {
    return {
      ok: false,
      error: 'Identical message sent to this number recently.',
      reason: 'content_blocked',
    };
  }

  const db = getDatabase();
  const bill = req.billId
    ? (db
        .prepare(`
        SELECT b.*, o.customer_id AS order_customer_id
        FROM bills b
        LEFT JOIN orders o ON o.id = b.order_id
        WHERE b.id = ?
      `)
        .get(req.billId) as any)
    : null;
  if (bill && bill.payment_status !== 'paid') {
    return { ok: false, error: 'Bill is not paid.', reason: 'send_failed' };
  }
  let resolvedKind = req.kind;
  let resolvedCustomerId = req.customerId;
  if (bill) {
    if (!resolvedCustomerId && (bill.customer_id || bill.order_customer_id)) {
      resolvedCustomerId = bill.customer_id || bill.order_customer_id;
    }
    if (req.kind !== 'auto_followup' && bill.customer_id && String(bill.customer_id) === String(bill.order_customer_id)) {
      resolvedKind = 'bill_receipt';
    }
  }

  let messageId: number;
  try {
    messageId = recordMessageRow({
      phone_e164: req.phoneE164,
      direction: 'outbound',
      kind: resolvedKind,
      status: 'queued',
      body: req.body,
      bill_id: req.billId,
      customer_id: resolvedCustomerId,
      created_by_user_id: req.userId,
    });
  } catch (err: any) {
    return { ok: false, error: err.message ?? 'Failed to record message.', reason: 'send_failed' };
  }

  const shutdownFailure = (): SendResult => {
    if (!whatsappTerminalCleanup) {
      try {
        updateMessageRow(messageId, {
          status: 'failed',
          error: 'WhatsApp is shutting down.',
          timestamp_field: 'failed_at',
        });
      } catch {}
    }
    return { ok: false, messageId, error: 'WhatsApp is shutting down.', reason: 'send_failed' };
  };

  try {
    if (resolvedKind === 'manual_reply') {
      try {
        updateMessageRow(messageId, { status: 'seen', timestamp_field: 'seen_at' });
      } catch {
        /* best-effort */
      }
    }
    await abortable(() => socket.presenceSubscribe(jid), signal).catch(() => {});
    if (isWhatsAppTerminal() || signal.aborted) return shutdownFailure();
    await abortable(() => socket.sendPresenceUpdate('composing', jid), signal).catch(() => {});
    if (isWhatsAppTerminal() || signal.aborted) return shutdownFailure();
    updateMessageRow(messageId, { status: 'typing', timestamp_field: 'typing_at' });
    await abortableDelay(randomDelayMs(req.body), signal);
    await abortable(() => socket.sendPresenceUpdate('paused', jid), signal).catch(() => {});
    if (isWhatsAppTerminal() || signal.aborted) return shutdownFailure();
    const sent = await abortable(() => socket.sendMessage(jid, { text: req.body }), signal);
    if (isWhatsAppTerminal() || signal.aborted) return shutdownFailure();
    // Do not mark 'sent' immediately; wait for server ACK (status=2) in messages.update.
    updateMessageRow(messageId, {
      external_message_id: sent?.key?.id ?? null,
    });
    // Cache sent message payload for session restart re-encryption requests.
    if (sent?.key?.id && sent?.message) {
      state.sentMessageCache.set(sent.key.id, sent.message);
      if (state.sentMessageCache.size > SENT_MESSAGE_CACHE_MAX) {
        const oldest = state.sentMessageCache.keys().next().value!;
        state.sentMessageCache.delete(oldest);
      }
    }
    state.lastSendByPhone.set(req.phoneE164, Date.now());
    if (state.lastSendByPhone.size > 1000) {
      const oldestKey = state.lastSendByPhone.keys().next().value;
      if (oldestKey) state.lastSendByPhone.delete(oldestKey);
    }
    return { ok: true, messageId };
  } catch (err: any) {
    if (isWhatsAppTerminal() || signal.aborted) return shutdownFailure();
    updateMessageRow(messageId, {
      status: 'failed',
      error: err?.message ?? 'Send failed',
      timestamp_field: 'failed_at',
    });
    const statusCode = (err as any)?.output?.statusCode;
    if (typeof statusCode === 'number' && RATE_LIMITED_STATUS_CODES.has(statusCode)) {
      triggerCooldown(
        `Send rate-limited by WhatsApp (${statusCode}). Cooling down for 5 minutes.`,
        5 * 60 * 1000,
        'rate_limited',
      );
    }
    return { ok: false, messageId, error: err?.message ?? 'Send failed', reason: 'send_failed' };
  }
}

export interface InboxMessage {
  id: number;
  phone_e164: string;
  body: string;
  status: string;
  queued_at: string;
}

export function listInbox(limit: number, offset: number): InboxMessage[] {
  return getDatabase()
    .prepare(`
    SELECT id, phone_e164, body, status, queued_at
    FROM whatsapp_messages
    WHERE direction = 'inbound'
    ORDER BY queued_at DESC
    LIMIT ? OFFSET ?
  `)
    .all(limit, offset) as InboxMessage[];
}

export interface SentMessageRow {
  id: number;
  phone_e164: string;
  bill_id: number | null;
  customer_id: string | number | null;
  direction: 'inbound' | 'outbound';
  kind: 'bill_receipt' | 'manual_reply' | 'auto_followup' | 'z_report';
  status: string;
  body: string;
  error: string | null;
  queued_at: string;
  seen_at: string | null;
  typing_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  created_by_user_id: string | null;
  trigger_rule: WhatsAppRuleAttribution | null;
}

export function listMessages(opts: {
  direction?: 'inbound' | 'outbound';
  status?: string;
  phone?: string;
  billId?: number;
  limit: number;
  offset?: number;
  canViewReports?: boolean;
}): SentMessageRow[] {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.direction) {
    where.push('direction = ?');
    params.push(opts.direction);
  }
  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  if (opts.phone) {
    where.push('phone_e164 = ?');
    params.push(opts.phone);
  }
  if (opts.billId) {
    where.push('bill_id = ?');
    params.push(opts.billId);
  }
  if (!opts.canViewReports) where.push("kind != 'z_report'");
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(opts.limit, opts.offset ?? 0);
  const rows = getDatabase()
    .prepare(`
    SELECT id, phone_e164, bill_id, customer_id, direction, kind, status,
           body, error, queued_at, seen_at, typing_at, sent_at,
           delivered_at, read_at, failed_at, created_by_user_id
    FROM whatsapp_messages
    ${whereSql}
    ORDER BY queued_at DESC
    LIMIT ? OFFSET ?
  `)
    .all(...params) as Omit<SentMessageRow, 'trigger_rule'>[];
  return rows.map((row) => ({
    ...row,
    trigger_rule: extractTriggerRule(row.created_by_user_id),
  }));
}

export interface BlocklistRow {
  phone_e164: string;
  reason: string | null;
  blocked_at: string;
  blocked_by_user_id: string | null;
}

export function listBlocklist(): BlocklistRow[] {
  return getDatabase()
    .prepare(
      'SELECT phone_e164, reason, blocked_at, blocked_by_user_id FROM whatsapp_blocklist ORDER BY blocked_at DESC',
    )
    .all() as BlocklistRow[];
}

export function addToBlocklist(phoneE164: string, reason: string, userId: string): void {
  getDatabase()
    .prepare(`
    INSERT INTO whatsapp_blocklist (phone_e164, reason, blocked_at, blocked_by_user_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(phone_e164) DO UPDATE SET reason = excluded.reason, blocked_at = excluded.blocked_at
  `)
    .run(phoneE164, reason, now(), userId);
}

export function removeFromBlocklist(phoneE164: string): boolean {
  const result = getDatabase()
    .prepare('DELETE FROM whatsapp_blocklist WHERE phone_e164 = ?')
    .run(phoneE164);
  return result.changes > 0;
}

function formatCurrencyForTemplate(amount: number, currency: string, country: string): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  const locale = getCountryByCode(country)?.locale || 'en-US';
  if (currency) {
    try {
      const decimals = getCurrencyFractionDigits(currency);
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(safe);
    } catch {
      // Fall back to plain decimal formatting below.
    }
  }
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safe);
}

function formatDateForTemplate(
  rawTs: string | null | undefined,
  country: string,
  timezone: string,
  includeTime = false,
): string {
  if (!rawTs) return '';
  try {
    const iso = rawTs.includes('T') ? rawTs : `${rawTs.replace(' ', 'T')}Z`;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(rawTs);
    const locale = getCountryByCode(country)?.locale || 'en-US';
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      ...(includeTime ? { timeStyle: 'short' } : {}),
      timeZone: timezone || 'UTC',
    }).format(date);
  } catch {
    return String(rawTs);
  }
}

export function buildWhatsAppTemplateContext(opts: {
  billId?: number | null;
  customerId?: string | number | null;
  pointsEarned?: number;
}): WhatsAppTemplateContext {
  const db = getDatabase();
  const config = getAutomationConfig();
  const country = getSettingValue('country') || '';
  const currency = getSettingValue('currency') || '';
  const timezone = getSettingValue('timezone') || 'UTC';
  const storeName = getSettingValue('business_name') || 'Store';
  const storePhone =
    getSettingValue('business_phone') ||
    getSettingValue('phone') ||
    state.connectedPhone ||
    '';
  const feedbackLink = config.safety.feedbackLink || '';
  const instagram = getSettingValue('instagram_handle') || '';

  const context: WhatsAppTemplateContext = {
    customer_name: 'Guest',
    customer_phone: '',
    visit_count: 0,
    last_visit_date: '',
    total_spent: formatCurrencyForTemplate(0, currency, country),
    bill_no: '',
    order_date: '',
    order_items: '',
    total: formatCurrencyForTemplate(0, currency, country),
    payment_method: '',
    points_earned: opts.pointsEarned ?? 0,
    points_balance: 0,
    points_value: formatCurrencyForTemplate(0, currency, country),
    store_name: storeName,
    store_phone: storePhone,
    feedback_link: feedbackLink,
    instagram,
  };

  let resolvedCustomerId: string | null =
    opts.customerId !== undefined && opts.customerId !== null ? String(opts.customerId) : null;

  if (opts.billId != null) {
    const bill = db
      .prepare('SELECT * FROM bills WHERE id = ?')
      .get(Number(opts.billId)) as any;
    if (bill) {
      const order = bill.order_id
        ? (db.prepare('SELECT * FROM orders WHERE id = ?').get(bill.order_id) as any)
        : null;
      if (!resolvedCustomerId && (bill.customer_id || order?.customer_id)) {
        resolvedCustomerId = String(bill.customer_id || order.customer_id);
      }
      context.bill_no = String(bill.bill_number || bill.id);
      context.order_date = formatDateForTemplate(
        bill.paid_at || order?.created_at || bill.created_at,
        country,
        timezone,
        true,
      );
      context.total = formatCurrencyForTemplate(Number(bill.total || 0), currency, country);

      if (bill.order_id) {
        const hasBillItems = Boolean(
          db.prepare('SELECT 1 FROM bill_items WHERE bill_id = ? LIMIT 1').get(bill.id),
        );
        const items = hasBillItems
          ? (db
              .prepare(`
                SELECT
                  oi.product_name,
                  bi.quantity AS quantity,
                  CASE
                    WHEN oi.quantity > 0 THEN oi.total * bi.quantity / oi.quantity
                    ELSE oi.total
                  END AS total
                FROM bill_items bi
                JOIN order_items oi ON oi.id = bi.order_item_id
                WHERE bi.bill_id = ?
                  AND bi.quantity > 0
                  AND oi.order_id = ?
                  AND (oi.status IS NULL OR oi.status NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded'))
                ORDER BY oi.id
              `)
              .all(bill.id, bill.order_id) as Array<{
              product_name: string;
              quantity: number;
              total: number;
            }>)
          : (db
              .prepare(`
                SELECT product_name, quantity, total
                FROM order_items
                WHERE order_id = ?
                  AND (status IS NULL OR status NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded'))
                ORDER BY id
              `)
              .all(bill.order_id) as Array<{
              product_name: string;
              quantity: number;
              total: number;
            }>);
        context.order_items = items
          .map(
            (item) =>
              `${item.quantity}x ${item.product_name} - ${formatCurrencyForTemplate(Number(item.total || 0), currency, country)}`,
          )
          .join('\n');
      }

      if (bill.payment_details) {
        try {
          const parsed = JSON.parse(bill.payment_details);
          const lines = Array.isArray(parsed) ? parsed : [parsed];
          const methods = Array.from(
            new Set(
              lines
                .map((p: any) => String(p?.method || '').trim())
                .filter(Boolean)
                .map((m) => m.charAt(0).toUpperCase() + m.slice(1)),
            ),
          );
          context.payment_method = methods.join(', ') || 'Paid';
        } catch {
          context.payment_method = 'Paid';
        }
      } else {
        context.payment_method = bill.payment_status === 'paid' ? 'Paid' : '';
      }

      if (opts.pointsEarned === undefined) {
        const earnedRow = db
          .prepare(`
            SELECT COALESCE(SUM(amount), 0) AS total
            FROM loyalty_ledger
            WHERE bill_id = ? AND type = 'credit'
          `)
          .get(bill.id) as { total: number } | undefined;
        context.points_earned = Math.round(Number(earnedRow?.total || 0));
      }
    }
  }

  if (resolvedCustomerId) {
    const customer = db
      .prepare('SELECT id, name, phone, country_code FROM customers WHERE id = ?')
      .get(resolvedCustomerId) as
      | { id: string; name: string; phone: string | null; country_code: string | null }
      | undefined;
    if (customer) {
      context.customer_name = customer.name || 'Guest';
      const parsedPhone = customer.phone
        ? parsePhoneE164(customer.phone, country || customer.country_code || '')
        : null;
      context.customer_phone = parsedPhone?.e164 || customer.phone || '';

      const stats = db
        .prepare(`
          SELECT
            COUNT(DISTINCT b.order_id) AS visit_count,
            COALESCE(SUM(b.total), 0) AS total_spent,
            MAX(COALESCE(b.paid_at, b.created_at)) AS last_visit_at
          FROM bills b
          LEFT JOIN orders o ON o.id = b.order_id
          WHERE COALESCE(b.customer_id, o.customer_id) = ?
            AND b.payment_status = 'paid'
        `)
        .get(resolvedCustomerId) as {
        visit_count: number;
        total_spent: number;
        last_visit_at: string | null;
      };

      const visitCount = Number(stats?.visit_count || 0);
      const totalSpent = Number(stats?.total_spent || 0);
      const lastVisitAt = stats?.last_visit_at || null;

      context.visit_count = visitCount;
      context.total_spent = formatCurrencyForTemplate(totalSpent, currency, country);
      context.last_visit_date = lastVisitAt
        ? formatDateForTemplate(lastVisitAt, country, timezone, false)
        : '';

      const ledgerRow = db
        .prepare(`
          SELECT
            COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) -
            COALESCE(SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END), 0) AS balance
          FROM loyalty_ledger
          WHERE customer_id = ?
        `)
        .get(resolvedCustomerId) as { balance: number } | undefined;
      const balance = Math.max(0, Math.round(Number(ledgerRow?.balance || 0)));
      context.points_balance = balance;
      context.points_value = formatCurrencyForTemplate(balance, currency, country);
    }
  }

  return context;
}

function hasRuleMessageForBill(billId: number, ruleUserId: string): boolean {
  const row = getDatabase()
    .prepare(
      'SELECT 1 FROM whatsapp_messages WHERE bill_id = ? AND created_by_user_id = ? LIMIT 1',
    )
    .get(billId, ruleUserId);
  return !!row;
}

const inFlightBillAutomations = new Map<
  number,
  Promise<{ triggered: WhatsAppTriggerType[]; results: Record<string, SendResult> }>
>();
let activeAutomationSweepPromise: Promise<{ feedbackSent: number; winbackSent: number }> | null =
  null;

export function triggerBillPaidAutomation(
  billId: number,
  opts?: { pointsEarned?: number },
): Promise<{ triggered: WhatsAppTriggerType[]; results: Record<string, SendResult> }> {
  const existing = inFlightBillAutomations.get(billId);
  if (existing) {
    return existing;
  }
  const runPromise = trackWhatsAppWork(triggerBillPaidAutomationImpl(billId, opts)).finally(() => {
    if (inFlightBillAutomations.get(billId) === runPromise) {
      inFlightBillAutomations.delete(billId);
    }
  });
  inFlightBillAutomations.set(billId, runPromise);
  return runPromise;
}

async function triggerBillPaidAutomationImpl(
  billId: number,
  opts?: { pointsEarned?: number },
): Promise<{ triggered: WhatsAppTriggerType[]; results: Record<string, SendResult> }> {
  const triggered: WhatsAppTriggerType[] = [];
  const results: Record<string, SendResult> = {};
  try {
    if (!state.enabled || isWhatsAppTerminal()) {
      return { triggered, results };
    }
    const db = getDatabase();
    const bill = db
      .prepare(`
        SELECT b.*, o.customer_id AS order_customer_id
        FROM bills b
        LEFT JOIN orders o ON o.id = b.order_id
        WHERE b.id = ?
      `)
      .get(billId) as any;
    if (!bill || bill.payment_status !== 'paid') {
      return { triggered, results };
    }
    const customerId = bill.customer_id || bill.order_customer_id;
    if (!customerId) {
      return { triggered, results };
    }
    const customer = db
      .prepare('SELECT id, name, phone, country_code, is_active FROM customers WHERE id = ?')
      .get(String(customerId)) as
      | { id: string; name: string; phone: string | null; country_code: string | null; is_active: number }
      | undefined;
    if (!customer || !customer.phone || customer.is_active === 0) {
      return { triggered, results };
    }
    const tenantCountry = getSettingValue('country') || customer.country_code || '';
    const parsedPhone = parsePhoneE164(customer.phone, tenantCountry);
    if (!parsedPhone) {
      return { triggered, results };
    }

    const config = getAutomationConfig();
    const templateMap = new Map(config.templates.map((t) => [t.id, t]));
    const context = buildWhatsAppTemplateContext({
      billId,
      customerId: String(customerId),
      pointsEarned: opts?.pointsEarned,
    });

    const findRule = (trigger: WhatsAppTriggerType) =>
      config.rules.find((r) => r.trigger === trigger);

    // 1. After payment (receipt)
    const afterPaymentRule = findRule('after_payment');
    if (afterPaymentRule?.enabled && !hasRuleMessageForBill(billId, 'rule:after_payment')) {
      const tpl = templateMap.get(afterPaymentRule.templateId) ?? templateMap.get('receipt');
      if (tpl) {
        const body = renderWhatsAppTemplate(tpl.body, context);
        if (body) {
          const res = await sendMessage({
            phoneE164: parsedPhone.e164,
            body,
            billId,
            customerId: String(customerId),
            kind: 'bill_receipt',
            userId: 'rule:after_payment',
          });
          results.after_payment = res;
          if (res.ok) triggered.push('after_payment');
        }
      }
    }

    // 2. Points threshold
    const pointsRule = findRule('points_threshold');
    if (pointsRule?.enabled && !hasRuleMessageForBill(billId, 'rule:points_threshold')) {
      const threshold = pointsRule.pointsThreshold ?? 100;
      const balance = Number(context.points_balance || 0);
      const earned = Number(context.points_earned || 0);
      const redeemedRow = db
        .prepare(`
          SELECT COALESCE(SUM(amount), 0) AS total
          FROM loyalty_ledger
          WHERE bill_id = ? AND type = 'debit'
        `)
        .get(billId) as { total: number } | undefined;
      const redeemed = Math.round(Number(redeemedRow?.total || 0));
      const prevBalance = balance - earned + redeemed;
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .replace('T', ' ')
        .replace(/\..*$/, '');
      const recentPointsReminder = db
        .prepare(`
          SELECT 1 FROM whatsapp_messages
          WHERE phone_e164 = ? AND created_by_user_id = 'rule:points_threshold' AND queued_at >= ?
          LIMIT 1
        `)
        .get(parsedPhone.e164, sevenDaysAgo);
      if (balance >= threshold && (prevBalance < threshold || !recentPointsReminder)) {
        const tpl =
          templateMap.get(pointsRule.templateId) ?? templateMap.get('loyalty_milestone');
        if (tpl) {
          const body = renderWhatsAppTemplate(tpl.body, context);
          if (body) {
            const res = await sendMessage({
              phoneE164: parsedPhone.e164,
              body,
              billId,
              customerId: String(customerId),
              kind: 'auto_followup',
              userId: 'rule:points_threshold',
            });
            results.points_threshold = res;
            if (res.ok) triggered.push('points_threshold');
          }
        }
      }
    }

    // 3. Nth visit milestone
    const nthVisitRule = findRule('nth_visit');
    if (nthVisitRule?.enabled && !hasRuleMessageForBill(billId, 'rule:nth_visit')) {
      const nth = nthVisitRule.nthVisit ?? 5;
      const visitCount = Number(context.visit_count || 0);
      const matchesNth = visitCount > 0 && visitCount % nth === 0;
      if (matchesNth) {
        const tpl =
          templateMap.get(nthVisitRule.templateId) ??
          templateMap.get('visit_milestone') ??
          templateMap.get('loyalty_milestone');
        if (tpl) {
          const body = renderWhatsAppTemplate(tpl.body, context);
          if (body) {
            const res = await sendMessage({
              phoneE164: parsedPhone.e164,
              body,
              billId,
              customerId: String(customerId),
              kind: 'auto_followup',
              userId: 'rule:nth_visit',
            });
            results.nth_visit = res;
            if (res.ok) triggered.push('nth_visit');
          }
        }
      }
    }
  } catch (err) {
    logWhatsApp('warn', 'bill_automation_error', {
      billId,
      error: sanitizeLogText(err),
    });
  }
  return { triggered, results };
}

export function runScheduledAutomationSweep(
  nowMs: number = Date.now(),
): Promise<{ feedbackSent: number; winbackSent: number }> {
  if (activeAutomationSweepPromise) {
    return activeAutomationSweepPromise;
  }
  const sweepPromise = trackWhatsAppWork(runScheduledAutomationSweepImpl(nowMs)).finally(() => {
    if (activeAutomationSweepPromise === sweepPromise) {
      activeAutomationSweepPromise = null;
    }
  });
  activeAutomationSweepPromise = sweepPromise;
  return sweepPromise;
}

async function runScheduledAutomationSweepImpl(
  nowMs: number = Date.now(),
): Promise<{ feedbackSent: number; winbackSent: number }> {
  let feedbackSent = 0;
  let winbackSent = 0;
  if (!state.enabled || isWhatsAppTerminal() || state.state !== 'connected' || !state.socket) {
    return { feedbackSent, winbackSent };
  }
  const db = getDatabase();
  const config = getAutomationConfig();
  const templateMap = new Map(config.templates.map((t) => [t.id, t]));
  const tenantCountry = getSettingValue('country') || '';

  // 1. Delayed feedback requests (X hours after paid_at, within last 7 days)
  const feedbackRule = config.rules.find((r) => r.trigger === 'feedback_delay');
  if (feedbackRule?.enabled) {
    const delayHours = Math.max(1, feedbackRule.delayHours ?? 2);
    const cutoff = new Date(nowMs - delayHours * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\..*$/, '');
    const sevenDaysAgo = new Date(nowMs - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\..*$/, '');
    const dueBills = db
      .prepare(`
        SELECT
          b.id AS bill_id,
          c.id AS customer_id,
          c.phone AS phone,
          c.country_code AS country_code
        FROM bills b
        LEFT JOIN orders o ON o.id = b.order_id
        JOIN customers c ON c.id = COALESCE(b.customer_id, o.customer_id)
        WHERE b.payment_status = 'paid'
          AND c.is_active = 1
          AND c.phone IS NOT NULL AND c.phone != ''
          AND COALESCE(b.paid_at, b.created_at) <= ?
          AND COALESCE(b.paid_at, b.created_at) >= ?
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_blocklist wb
            WHERE wb.phone_e164 = c.phone
          )
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_messages wm
            WHERE wm.bill_id = b.id AND wm.created_by_user_id = 'rule:feedback_delay'
          )
        ORDER BY COALESCE(b.paid_at, b.created_at) DESC
      `)
      .all(cutoff, sevenDaysAgo) as Array<{
      bill_id: number;
      customer_id: string;
      phone: string;
      country_code: string | null;
    }>;

    const tpl = templateMap.get(feedbackRule.templateId) ?? templateMap.get('feedback');
    if (tpl) {
      let attempted = 0;
      for (const row of dueBills) {
        if (isWhatsAppTerminal() || attempted >= 25) break;
        const parsedPhone = parsePhoneE164(
          row.phone,
          tenantCountry || row.country_code || '',
        );
        if (!parsedPhone || isBlocked(parsedPhone.e164)) continue;
        const context = buildWhatsAppTemplateContext({
          billId: row.bill_id,
          customerId: row.customer_id,
        });
        const body = renderWhatsAppTemplate(tpl.body, context);
        if (!body) continue;
        attempted++;
        const res = await sendMessage({
          phoneE164: parsedPhone.e164,
          body,
          billId: row.bill_id,
          customerId: row.customer_id,
          kind: 'auto_followup',
          userId: 'rule:feedback_delay',
        });
        if (res.ok) feedbackSent++;
      }
    }
  }

  // 2. Win-back rule (customers whose last paid bill was >= X days ago)
  const winbackRule = config.rules.find((r) => r.trigger === 'winback');
  if (winbackRule?.enabled) {
    const inactiveDays = winbackRule.inactiveDays ?? 14;
    const cutoff = new Date(nowMs - inactiveDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\..*$/, '');
    const dueCustomers = db
      .prepare(`
        WITH cust_visits AS (
          SELECT
            COALESCE(b.customer_id, o.customer_id) AS customer_id,
            MAX(COALESCE(b.paid_at, b.created_at)) AS last_visit_at,
            COUNT(DISTINCT b.order_id) AS visit_count
          FROM bills b
          LEFT JOIN orders o ON o.id = b.order_id
          WHERE b.payment_status = 'paid'
            AND COALESCE(b.customer_id, o.customer_id) IS NOT NULL
          GROUP BY COALESCE(b.customer_id, o.customer_id)
        )
        SELECT c.id, c.phone, c.country_code, cv.last_visit_at
        FROM cust_visits cv
        JOIN customers c ON c.id = cv.customer_id
        WHERE c.is_active = 1
          AND c.phone IS NOT NULL AND c.phone != ''
          AND cv.visit_count >= 1
          AND cv.last_visit_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_blocklist wb
            WHERE wb.phone_e164 = c.phone
          )
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_messages wm
            WHERE wm.customer_id = c.id
              AND wm.created_by_user_id = 'rule:winback'
              AND wm.queued_at >= ?
          )
        ORDER BY cv.last_visit_at DESC
      `)
      .all(cutoff, cutoff) as Array<{
      id: string;
      phone: string;
      country_code: string | null;
      last_visit_at: string;
    }>;

    const tpl = templateMap.get(winbackRule.templateId) ?? templateMap.get('winback');
    if (tpl) {
      let attempted = 0;
      for (const cust of dueCustomers) {
        if (isWhatsAppTerminal() || attempted >= 25) break;
        const parsedPhone = parsePhoneE164(
          cust.phone,
          tenantCountry || cust.country_code || '',
        );
        if (!parsedPhone || isBlocked(parsedPhone.e164)) continue;
        const context = buildWhatsAppTemplateContext({ customerId: cust.id });
        const body = renderWhatsAppTemplate(tpl.body, context);
        if (!body) continue;
        attempted++;
        const res = await sendMessage({
          phoneE164: parsedPhone.e164,
          body,
          billId: null,
          customerId: cust.id,
          kind: 'auto_followup',
          userId: 'rule:winback',
        });
        if (res.ok) winbackSent++;
      }
    }
  }

  return { feedbackSent, winbackSent };
}

export interface BroadcastSegmentOptions {
  templateId?: string;
  minVisits?: number;
  inactiveDays?: number;
  minPoints?: number;
  limit?: number;
  signal?: AbortSignal;
}

export async function runBroadcast(opts: BroadcastSegmentOptions): Promise<{
  ok: boolean;
  matched: number;
  attempted: number;
  sent: number;
  skipped: number;
  error?: string;
  reason?: string;
  errors: Array<{ phone: string; reason?: string }>;
}> {
  const db = getDatabase();
  const config = getAutomationConfig();
  const tpl = opts.templateId
    ? config.templates.find((t) => t.id === opts.templateId)
    : undefined;
  const rawTemplateBody = tpl?.body?.trim() || '';
  if (!rawTemplateBody) {
    return {
      ok: false,
      matched: 0,
      attempted: 0,
      sent: 0,
      skipped: 0,
      error: 'Template body required',
      reason: 'body_required',
      errors: [],
    };
  }
  if (!state.enabled || isWhatsAppTerminal()) {
    return {
      ok: false,
      matched: 0,
      attempted: 0,
      sent: 0,
      skipped: 0,
      error: 'WhatsApp is not enabled.',
      reason: 'feature_off',
      errors: [],
    };
  }
  if (state.state !== 'connected' || !state.socket) {
    return {
      ok: false,
      matched: 0,
      attempted: 0,
      sent: 0,
      skipped: 0,
      error: 'Flo is not connected to WhatsApp.',
      reason: 'not_connected',
      errors: [],
    };
  }

  const maxLimit = Math.max(1, Math.min(50, Math.round(Number(opts.limit || 25))));
  const minVisits = Math.max(0, Math.round(Number(opts.minVisits || 0)));
  const minPoints = Math.max(0, Math.round(Number(opts.minPoints || 0)));
  const inactiveDays = Math.max(0, Math.round(Number(opts.inactiveDays || 0)));
  const inactiveCutoff =
    inactiveDays > 0
      ? new Date(Date.now() - inactiveDays * 24 * 60 * 60 * 1000)
          .toISOString()
          .replace('T', ' ')
          .replace(/\..*$/, '')
      : null;

  const filtered = db
    .prepare(`
      WITH bill_stats AS (
        SELECT
          COALESCE(b.customer_id, o.customer_id) AS customer_id,
          COUNT(DISTINCT b.order_id) AS visits_count,
          MAX(COALESCE(b.paid_at, b.created_at)) AS last_visit_at
        FROM bills b
        LEFT JOIN orders o ON o.id = b.order_id
        WHERE b.payment_status = 'paid'
          AND COALESCE(b.customer_id, o.customer_id) IS NOT NULL
        GROUP BY COALESCE(b.customer_id, o.customer_id)
      ),
      loyalty_stats AS (
        SELECT
          customer_id,
          MAX(0, COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0)) AS points_balance
        FROM loyalty_ledger
        GROUP BY customer_id
      )
      SELECT
        c.id,
        c.phone,
        c.country_code,
        COALESCE(bs.visits_count, 0) AS visits_count,
        bs.last_visit_at,
        COALESCE(ls.points_balance, 0) AS points_balance
      FROM customers c
      LEFT JOIN bill_stats bs ON bs.customer_id = c.id
      LEFT JOIN loyalty_stats ls ON ls.customer_id = c.id
      WHERE c.is_active = 1
        AND c.phone IS NOT NULL AND c.phone != ''
        AND (? <= 0 OR COALESCE(bs.visits_count, 0) >= ?)
        AND (? <= 0 OR COALESCE(ls.points_balance, 0) >= ?)
        AND (? IS NULL OR (bs.last_visit_at IS NOT NULL AND bs.last_visit_at <= ?))
      ORDER BY c.created_at DESC
      LIMIT ?
    `)
    .all(
      minVisits,
      minVisits,
      minPoints,
      minPoints,
      inactiveCutoff,
      inactiveCutoff,
      maxLimit,
    ) as Array<{
    id: string;
    phone: string;
    country_code: string | null;
    visits_count: number;
    last_visit_at: string | null;
    points_balance: number;
  }>;

  const tenantCountry = getSettingValue('country') || '';

  let attempted = 0;
  let sent = 0;
  let skipped = 0;
  const errors: Array<{ phone: string; reason?: string }> = [];

  for (const cust of filtered) {
    if (isWhatsAppTerminal() || opts.signal?.aborted) break;
    const parsedPhone = parsePhoneE164(cust.phone, tenantCountry || cust.country_code || '');
    if (!parsedPhone) {
      skipped++;
      continue;
    }
    attempted++;
    const context = buildWhatsAppTemplateContext({ customerId: cust.id });
    const rendered = renderWhatsAppTemplate(rawTemplateBody, context);
    if (!rendered) {
      skipped++;
      continue;
    }
    const res = await sendMessage({
      phoneE164: parsedPhone.e164,
      body: rendered,
      billId: null,
      customerId: cust.id,
      kind: 'auto_followup',
      userId: 'rule:broadcast',
      signal: opts.signal,
    });
    if (res.ok) {
      sent++;
    } else {
      skipped++;
      errors.push({ phone: parsedPhone.e164, reason: res.reason });
    }
  }

  return { ok: true, matched: filtered.length, attempted, sent, skipped, errors };
}

export function initFromDb(): void {
  // creds.json is the source of truth for the paired phone; the DB setting
  // is just a fallback when creds.json is missing (fresh install) or corrupt.
  const credsPath = path.join(getAuthDir(), 'creds.json');
  if (fs.existsSync(credsPath)) {
    try {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8')) as { me?: { id?: string } };
      if (creds.me?.id) {
        state.connectedPhone = '+' + userFromJid(creds.me.id);
      }
    } catch {
      // corrupt creds — fall through to DB fallback
    }
  }
  if (!state.connectedPhone) {
    state.connectedPhone = getSettingValue('whatsapp_connected_phone') || null;
  }
  const v = getDatabase()
    .prepare("SELECT value FROM settings WHERE key = 'whatsapp_enabled'")
    .get() as { value: string | null } | undefined;
  state.enabled = v?.value === 'true';
  logWhatsApp('info', 'startup_init', {
    enabled: state.enabled,
    hasCredentials: fs.existsSync(credsPath),
    connectedPhone: maskPhone(state.connectedPhone),
  });
  ensureAutomationTimer();
  if (state.enabled) {
    void startSocket().catch(() => {});
  }
}

export function shutdown(): Promise<void> {
  if (whatsappShutdownPromise) return whatsappShutdownPromise;
  requestShutdown();
  const socket = state.socket;
  shutdownSocket = socket;
  whatsappShutdownPromise = waitForWhatsAppWork().finally(() => {
    if (inFlightWhatsAppWork.size === 0) {
      if (state.socket === socket) state.socket = null;
      shutdownSocket = null;
    }
  });
  return whatsappShutdownPromise;
}

export function requestShutdown(): void {
  if (whatsappShutdownRequested) return;
  whatsappShutdownRequested = true;
  state.shuttingDown = true;
  whatsappAbortController.abort();
  cancelInFlightWhatsAppWork();
  if (state.cooldownTimer) {
    clearTimeout(state.cooldownTimer);
    state.cooldownTimer = null;
  }
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.automationTimer) {
    clearInterval(state.automationTimer);
    state.automationTimer = null;
  }
  const socket = state.socket;
  shutdownSocket = socket;
  if (socket) {
    try {
      socket.end(undefined);
    } catch {
      /* ignore */
    }
  }
}

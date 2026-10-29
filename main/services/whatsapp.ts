import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { WASocket as BaileysSocket, WAMessageKey } from '@whiskeysockets/baileys';
import { parsePhoneNumber } from 'libphonenumber-js';
import { getDatabase, getSettingValue, now, parseDbTimestamp } from '../db';
import { SHUTDOWN_TIMEOUT_MS } from '../shutdown';
import { getOfflineModeAbortSignal, isOfflineMode } from './offline-mode';
import {
  formatMoney,
  formatNumber,
  getCurrencyMinorUnitFactor,
  resolveRegionalSnapshot,
  type LocalePreferences,
  type RegionalSnapshot,
} from '../countries';
import { parsePhoneE164 } from '../lib/phone';
import { printLabel } from '../print/print-labels.generated';
import { getTenantCurrency } from './refund';
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
  resolveWhatsAppRuleTrigger,
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
  resolveWhatsAppRuleTrigger,
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
export const MAX_BODY_CHARS = 4096;
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
  offlineMode?: boolean;
  qr?: string;
  pairingCode?: string;
}

export const REPORT_MESSAGE_KINDS = ['z_report', 'daily_sales_report'] as const;
export type ReportMessageKind = (typeof REPORT_MESSAGE_KINDS)[number];
export type MessageKind =
  | 'bill_receipt'
  | 'manual_reply'
  | 'auto_followup'
  | 'z_report'
  | 'daily_sales_report';

export function isReportMessageKind(kind: unknown): kind is ReportMessageKind {
  return kind === 'z_report' || kind === 'daily_sales_report';
}

interface QueuedSend {
  phoneE164: string;
  body: string;
  billId: number | null;
  customerId: string | number | null;
  kind: MessageKind;
  userId: string | null;
  signal?: AbortSignal;
  retryMessageId?: number | null;
  preclaimedMessageId?: number | null;
}

const AUTOMATION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
export const ACK_TIMEOUT_MS = 5 * 60 * 1000;
export const ACK_SWEEP_INTERVAL_MS = 60 * 1000;
const RESUME_HEALTH_CHECK_TIMEOUT_MS = 5_000;
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  seen: 1,
  typing: 2,
  sent: 3,
  delivered: 4,
  read: 5,
};

const state: {
  enabled: boolean;
  shuttingDown: boolean;
  socket: BaileysSocket | null;
  state: WhatsAppConnectionState;
  pairingMode: 'qr' | 'pairing_code' | null;
  lastQr: string | null;
  lastPairingCode: string | null;
  connectedPhone: string | null;
  lastError: string | null;
  lastErrorReason: string | null;
  cooldownUntil: string | null;
  cooldownTimer: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  automationTimer: NodeJS.Timeout | null;
  ackSweepTimer: NodeJS.Timeout | null;
  lastSendByPhone: Map<string, number>;
  recentBodies: Map<string, { body: string; at: number; messageId?: number | null }[]>;
  sentMessageCache: Map<string, any>;
  lidToPhoneMap: Map<string, string>;
} = {
  enabled: false,
  shuttingDown: false,
  socket: null,
  state: 'disconnected',
  pairingMode: null,
  lastQr: null,
  lastPairingCode: null,
  connectedPhone: null,
  lastError: null,
  lastErrorReason: null,
  cooldownUntil: null,
  cooldownTimer: null,
  reconnectTimer: null,
  automationTimer: null,
  ackSweepTimer: null,
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
let pairingRequestAttempt = 0;
let credentialWriteTail: Promise<void> = Promise.resolve();
let authCleanupPromise: Promise<void> = Promise.resolve();
let authWipeEpoch = 0;
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
    offlineMode: isOfflineMode(),
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
  const current = getAutomationConfig();
  const patch =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  let mergedRules: unknown = current.rules;
  if (Array.isArray(patch.rules)) {
    const providedTriggers = new Set<WhatsAppTriggerType>();
    for (const r of patch.rules) {
      const trigger = resolveWhatsAppRuleTrigger(r);
      if (trigger) providedTriggers.add(trigger);
    }
    mergedRules = [
      ...patch.rules,
      ...current.rules.filter((r) => !providedTriggers.has(r.trigger)),
    ];
  }
  const merged = {
    templates: patch.templates !== undefined ? patch.templates : current.templates,
    rules: mergedRules,
    safety:
      patch.safety && typeof patch.safety === 'object' && !Array.isArray(patch.safety)
        ? { ...current.safety, ...(patch.safety as Record<string, unknown>) }
        : current.safety,
  };
  const normalized = normalizeWhatsAppAutomationConfig(merged);
  writeSetting(WHATSAPP_AUTOMATION_SETTING_KEY, JSON.stringify(normalized));
  sweepRecipientCooldownUntil.clear();
  inFlightNthVisitKeys.clear();
  return normalized;
}

function tenantRegionalSnapshot(): RegionalSnapshot {
  return resolveRegionalSnapshot({
    country: getSettingValue('country') || undefined,
    currency: getSettingValue('currency') || undefined,
    timezone: getSettingValue('timezone') || undefined,
    currency_display: getSettingValue('currency_display') || undefined,
    number_digits: getSettingValue('number_digits') || undefined,
    calendar: getSettingValue('calendar') || undefined,
  });
}

export function isCurrentlyQuietHours(
  safety: WhatsAppSafetyConfig = getAutomationConfig().safety,
  nowDate: Date = new Date(),
): boolean {
  if (!safety.quietHoursEnabled) return false;
  const { timezone } = tenantRegionalSnapshot();
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(nowDate);
  const currentHhMm = formatted.replace(/^24:/, '00:');
  return isTimeWithinQuietHours(currentHhMm, safety.quietHoursStart, safety.quietHoursEnd);
}

export function isOverWeeklyAutomatedCap(
  phoneE164: string,
  maxPerCustomerPerWeek = getAutomationConfig().safety.maxPerCustomerPerWeek,
  excludeMessageId?: number | null,
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
        AND kind NOT IN ('z_report', 'daily_sales_report')
        AND (kind = 'auto_followup' OR created_by_user_id LIKE 'rule:%')
        AND queued_at >= ?
        AND (? IS NULL OR id != ?)
    `)
    .get(phoneE164, sevenDaysAgo, excludeMessageId ?? null, excludeMessageId ?? null) as {
    c: number;
  };
  return row.c >= maxPerCustomerPerWeek;
}

function isAutomatedSend(req: QueuedSend): boolean {
  if (isReportMessageKind(req.kind)) return false;
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

function hasDuplicateBody(
  phoneE164: string,
  body: string,
  excludeMessageId?: number | null,
): boolean {
  const cutoff = Date.now() - BODY_REPEAT_WINDOW_MS;
  const recent = state.recentBodies.get(phoneE164) ?? [];
  const fresh = recent.filter((r) => r.at >= cutoff);
  if (fresh.length !== recent.length) {
    if (fresh.length > 0) state.recentBodies.set(phoneE164, fresh);
    else state.recentBodies.delete(phoneE164);
  }
  return fresh.some(
    (r) => r.body === body && (excludeMessageId == null || r.messageId !== excludeMessageId),
  );
}

function recordRecentBody(phoneE164: string, body: string, messageId: number): void {
  const cutoff = Date.now() - BODY_REPEAT_WINDOW_MS;
  const recent = state.recentBodies.get(phoneE164) ?? [];
  const fresh = recent.filter((r) => r.at >= cutoff && r.messageId !== messageId);
  fresh.push({ body, at: Date.now(), messageId });
  // Bound the per-phone history to avoid unbounded growth in long-running installs.
  if (fresh.length > RECENT_BODIES_PER_PHONE_MAX)
    fresh.splice(0, fresh.length - RECENT_BODIES_PER_PHONE_MAX);
  state.recentBodies.set(phoneE164, fresh);
}

function removeRecentBodyForMessage(phoneE164: string, messageId: number): void {
  const recent = state.recentBodies.get(phoneE164);
  if (!recent) return;
  const filtered = recent.filter((r) => r.messageId !== messageId);
  if (filtered.length > 0) state.recentBodies.set(phoneE164, filtered);
  else state.recentBodies.delete(phoneE164);
}

function isBlocked(phoneE164: string): boolean {
  const row = getDatabase()
    .prepare('SELECT 1 FROM whatsapp_blocklist WHERE phone_e164 = ?')
    .get(phoneE164);
  return !!row;
}

export function isOverRateLimit(
  phoneE164: string,
  maxPerHour = RATE_LIMIT_MAX_PER_HOUR,
  skipMinGap = false,
  excludeMessageId?: number | null,
): { limited: boolean; retryAfterMs?: number } {
  const db = getDatabase();
  if (!skipMinGap && process.env.FLO_WHATSAPP_FAST_DELAY !== '1') {
    let last = state.lastSendByPhone.get(phoneE164) ?? 0;
    const lastRow = db
      .prepare(`
        SELECT MAX(COALESCE(sent_at, typing_at)) AS last_ts
        FROM whatsapp_messages
        WHERE phone_e164 = ?
          AND direction = 'outbound'
          AND (sent_at IS NOT NULL OR typing_at IS NOT NULL)
      `)
      .get(phoneE164) as { last_ts: string | null } | undefined;
    if (lastRow?.last_ts) {
      const parsedMs = parseDbTimestamp(lastRow.last_ts).getTime();
      if (Number.isFinite(parsedMs) && parsedMs > last) {
        last = parsedMs;
      }
    }
    if (last > 0) {
      const gap = Date.now() - last;
      if (gap < RATE_LIMIT_MIN_GAP_MS) {
        return { limited: true, retryAfterMs: RATE_LIMIT_MIN_GAP_MS - gap };
      }
    }
  }
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
      AND (? IS NULL OR id != ?)
  `)
    .get(phoneE164, oneHourAgo, excludeMessageId ?? null, excludeMessageId ?? null) as {
    c: number;
  };
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
  const insertedId = Number(result.lastInsertRowid);
  const extId = row.external_message_id ?? row.external_id ?? null;
  if (row.direction === 'outbound' && extId) {
    recordMessageAttemptExternalId(insertedId, extId);
  }
  return insertedId;
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
  const db = getDatabase();
  const current = db.prepare('SELECT status FROM whatsapp_messages WHERE id = ?').get(id) as
    | { status: string }
    | undefined;
  if (!current) return;
  const currentRank = STATUS_RANK[current.status] ?? -1;
  const targetRank = STATUS_RANK[latest] ?? -1;
  const nextStatus = currentRank > targetRank ? current.status : latest;
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
  db.prepare(
    `UPDATE whatsapp_messages SET status = ?, error = NULL, failed_at = NULL, ${exprs} WHERE id = ?`,
  ).run(nextStatus, ...placeholders, id);
}

const EXTERNAL_ID_MAP_MAX = 1000;
const externalIdToMessageId = new Map<string, number>();
const activeSendMessageIds = new Set<number>();
const inProcessSubmittedIds = new Set<number>();

function rememberExternalMessageId(externalId: string | null | undefined, messageId: number): void {
  if (!externalId) return;
  externalIdToMessageId.delete(externalId);
  externalIdToMessageId.set(externalId, messageId);
  if (externalIdToMessageId.size > EXTERNAL_ID_MAP_MAX) {
    const oldest = externalIdToMessageId.keys().next().value;
    if (oldest !== undefined) externalIdToMessageId.delete(oldest);
  }
}

export function recordMessageAttemptExternalId(
  messageId: number,
  externalId: string | null | undefined,
): void {
  const trimmed = typeof externalId === 'string' ? externalId.trim() : '';
  if (!trimmed) return;
  rememberExternalMessageId(trimmed, messageId);
  const db = getDatabase();
  db.prepare(`
    INSERT OR IGNORE INTO whatsapp_message_attempts (message_id, external_message_id, created_at)
    VALUES (?, ?, ?)
  `).run(messageId, trimmed, now());
  db.prepare(`
    UPDATE whatsapp_messages
    SET external_message_id = COALESCE(external_message_id, ?)
    WHERE id = ? AND direction = 'outbound'
  `).run(trimmed, messageId);
}

/**
 * Sweeps outbound rows still in 'queued', 'seen', or 'typing' past ACK_TIMEOUT_MS
 * (or unfinished outbound rows from before startup / interrupted before socket submission
 * when includeAllUnfinished is true) and marks them 'failed' with error = 'ack_timeout'.
 */
export function sweepAckTimeouts(
  nowMs: number = Date.now(),
  opts?: { includeAllUnfinished?: boolean },
): number {
  if (whatsappTerminalCleanup || whatsappShutdownRequested) return 0;
  try {
    const db = getDatabase();
    const failedAt = new Date(nowMs).toISOString().replace('T', ' ').replace(/\..*$/, '');
    const cutoff = new Date(nowMs - ACK_TIMEOUT_MS)
      .toISOString()
      .replace('T', ' ')
      .replace(/\..*$/, '');
    const candidates = (
      opts?.includeAllUnfinished
        ? db
            .prepare(`
              SELECT id, external_message_id,
                CASE WHEN datetime(COALESCE(typing_at, seen_at, queued_at)) <= datetime(?) THEN 1 ELSE 0 END AS expired
              FROM whatsapp_messages
              WHERE direction = 'outbound'
                AND status IN ('queued', 'seen', 'typing')
            `)
            .all(cutoff)
        : db
            .prepare(`
              SELECT id, external_message_id, 1 AS expired
              FROM whatsapp_messages
              WHERE direction = 'outbound'
                AND status IN ('queued', 'seen', 'typing')
                AND datetime(COALESCE(typing_at, seen_at, queued_at)) <= datetime(?)
            `)
            .all(cutoff)
    ) as { id: number; external_message_id: string | null; expired: number }[];
    const staleRows = candidates.filter((row) => {
      if (activeSendMessageIds.has(row.id)) return false;
      if (row.expired === 1) return true;
      if (!opts?.includeAllUnfinished) return false;
      return !row.external_message_id || !inProcessSubmittedIds.has(row.id);
    });
    if (staleRows.length === 0) return 0;

    const updateUnconditionalStmt = db.prepare(`
      UPDATE whatsapp_messages
      SET status = 'failed', error = 'ack_timeout', failed_at = ?
      WHERE id = ? AND direction = 'outbound' AND status IN ('queued', 'seen', 'typing')
    `);
    const updateCutoffStmt = db.prepare(`
      UPDATE whatsapp_messages
      SET status = 'failed', error = 'ack_timeout', failed_at = ?
      WHERE id = ? AND direction = 'outbound' AND status IN ('queued', 'seen', 'typing')
        AND datetime(COALESCE(typing_at, seen_at, queued_at)) <= datetime(?)
    `);
    let count = 0;
    const sweepTx = db.transaction(() => {
      for (const row of staleRows) {
        if (activeSendMessageIds.has(row.id)) continue;
        const bypassCutoff =
          opts?.includeAllUnfinished &&
          (!row.external_message_id || !inProcessSubmittedIds.has(row.id));
        const result = bypassCutoff
          ? updateUnconditionalStmt.run(failedAt, row.id)
          : updateCutoffStmt.run(failedAt, row.id, cutoff);
        if (result.changes > 0) {
          count += result.changes;
        }
      }
    });
    sweepTx();
    return count;
  } catch (err) {
    logWhatsApp('warn', 'ack_sweep_failed', { error: sanitizeLogText(err) });
    return 0;
  }
}

function findMessageByExternalId(externalId: string): { id: number; phone_e164: string } | null {
  const trimmed = typeof externalId === 'string' ? externalId.trim() : '';
  if (!trimmed) return null;
  const db = getDatabase();
  const row = db
    .prepare('SELECT id, phone_e164 FROM whatsapp_messages WHERE external_message_id = ?')
    .get(trimmed) as { id: number; phone_e164: string } | undefined;
  if (row) return row;
  const attemptRow = db
    .prepare(`
      SELECT m.id, m.phone_e164
      FROM whatsapp_message_attempts a
      JOIN whatsapp_messages m ON m.id = a.message_id
      WHERE a.external_message_id = ?
      LIMIT 1
    `)
    .get(trimmed) as { id: number; phone_e164: string } | undefined;
  if (attemptRow) return attemptRow;
  const mappedId = externalIdToMessageId.get(trimmed);
  if (mappedId !== undefined) {
    const mappedRow = db
      .prepare(
        "SELECT id, phone_e164 FROM whatsapp_messages WHERE id = ? AND direction = 'outbound'",
      )
      .get(mappedId) as { id: number; phone_e164: string } | undefined;
    if (mappedRow) return mappedRow;
  }
  return null;
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

function isSocketTransportHealthy(socket: BaileysSocket): boolean {
  const ws = (
    socket as unknown as {
      ws?: {
        isClosed?: boolean;
        isClosing?: boolean;
        isOpen?: boolean;
        readyState?: number;
        socket?: { destroyed?: boolean; writable?: boolean };
      };
    }
  ).ws;
  if (!ws) return true;
  if (ws.isClosed === true || ws.isClosing === true || ws.isOpen === false) return false;
  if (typeof ws.readyState === 'number' && ws.readyState !== 1) return false;
  if (ws.socket && (ws.socket.destroyed === true || ws.socket.writable === false)) return false;
  return true;
}

function readRegisteredPhoneFromAuthDir(): string | null {
  const credsPath = path.join(getAuthDir(), 'creds.json');
  if (!fs.existsSync(credsPath)) return null;
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8')) as {
      me?: { id?: string };
    };
    if (creds.me?.id) {
      return '+' + userFromJid(creds.me.id);
    }
  } catch {
    // ignore corrupt or partial credentials
  }
  return null;
}

function attachSocketHandlers(socket: BaileysSocket): void {
  let socketSawNewLogin = false;
  socket.ev.on('connection.update', (update: any) => {
    void trackWhatsAppWork(
      (async () => {
        if (!isActiveSocket(socket)) return;
        const { connection, lastDisconnect, qr, isNewLogin } = update;
        if (isNewLogin) {
          socketSawNewLogin = true;
          pairingRequestAttempt += 1;
          state.pairingMode = null;
          state.lastQr = null;
          state.lastPairingCode = null;
          state.lastError = null;
          state.lastErrorReason = null;
          state.state = 'connecting';
        }
        if (qr && state.pairingMode !== 'pairing_code' && state.state !== 'waiting_pairing') {
          state.lastQr = qr;
          state.lastPairingCode = null;
          state.state = 'waiting_qr';
          logWhatsApp('info', 'connection_state', { state: 'waiting_qr' });
        }
        if (connection === 'open') {
          pairingRequestAttempt += 1;
          state.state = 'connected';
          state.pairingMode = null;
          state.lastQr = null;
          state.lastPairingCode = null;
          state.lastError = null;
          state.lastErrorReason = null;
          if (state.reconnectTimer) {
            clearTimeout(state.reconnectTimer);
            state.reconnectTimer = null;
          }
          sweepAckTimeouts();
          ensureAutomationTimer();
          ensureAckSweepTimer();
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
          pairingRequestAttempt += 1;
          const disconnectError = lastDisconnect?.error;
          const status = (disconnectError as any)?.output?.statusCode as number | undefined;
          const previousState = state.state;
          const previousPairingMode = state.pairingMode;
          const wasUnpairedPairingAttempt =
            !state.connectedPhone &&
            !socketSawNewLogin &&
            (previousState === 'waiting_qr' ||
              previousState === 'waiting_pairing' ||
              previousPairingMode !== null);
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
            if (state.reconnectTimer) {
              clearTimeout(state.reconnectTimer);
              state.reconnectTimer = null;
            }
            if (state.automationTimer) {
              clearInterval(state.automationTimer);
              state.automationTimer = null;
            }
            state.pairingMode = null;
            state.state = 'disconnected';
            state.connectedPhone = null;
            writeSetting('whatsapp_connected_phone', '');
            state.lastError = 'Logged out. Reconnect to continue.';
            state.lastErrorReason = 'logged_out';
            scheduleAuthWipe();
          } else if (status === 515 && !isWhatsAppTerminal() && state.enabled) {
            state.pairingMode = null;
            state.state = 'connecting';
            state.lastError = null;
            state.lastErrorReason = null;
            if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
            logWhatsApp('info', 'reconnect_scheduled', {
              delayMs: 0,
              statusCode: status,
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
            }, 0);
            state.reconnectTimer.unref?.();
          } else if (wasUnpairedPairingAttempt && status === 408) {
            if (state.reconnectTimer) {
              clearTimeout(state.reconnectTimer);
              state.reconnectTimer = null;
            }
            state.pairingMode = null;
            state.state = 'disconnected';
            state.lastError = null;
            state.lastErrorReason = null;
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
            state.reconnectTimer.unref?.();
          } else {
            state.pairingMode = null;
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
  signal?: AbortSignal,
): Promise<[number, number, number] | undefined> {
  const effectiveSignal = signal
    ? AbortSignal.any([signal, whatsappAbortController.signal, getOfflineModeAbortSignal()])
    : AbortSignal.any([whatsappAbortController.signal, getOfflineModeAbortSignal()]);
  if (effectiveSignal.aborted || isOfflineMode()) return undefined;
  // Fetch latest WhatsApp Web version to prevent connection rejection from stale build hashes.
  try {
    const res = await fetch('https://wppconnect.io/whatsapp-versions/', {
      signal: AbortSignal.any([effectiveSignal, AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS)]),
    });
    if (effectiveSignal.aborted || isOfflineMode()) return undefined;
    if (res.ok) {
      const html = await res.text();
      if (effectiveSignal.aborted || isOfflineMode()) return undefined;
      const match = html.match(/2\.3000\.(\d+)/);
      if (match) return [2, 3000, Number(match[1])];
    }
  } catch {
    // fall through
  }
  if (effectiveSignal.aborted || isOfflineMode()) return undefined;
  try {
    const { fetchLatestWaWebVersion } = await abortable(() => loadBaileys(), effectiveSignal);
    if (effectiveSignal.aborted || isOfflineMode()) return undefined;
    const { version } = await abortable(
      () => fetchLatestWaWebVersion({ signal: effectiveSignal }),
      effectiveSignal,
    );
    if (effectiveSignal.aborted || isOfflineMode()) return undefined;
    return version as [number, number, number];
  } catch {
    // fall through
  }
  // Let Baileys use its hardcoded fallback. Better than refusing to start.
  return undefined;
}

async function startSocketImpl(
  attemptId: number,
  signal: AbortSignal = whatsappAbortController.signal,
): Promise<void> {
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
  if (
    attemptId !== whatsappStartAttempt ||
    isWhatsAppTerminal() ||
    signal.aborted ||
    isOfflineMode()
  )
    return;
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
  const socket = await runSocketPhase(attemptId, 'socket_create', () => {
    const createdSocket = makeWASocket({
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
    });
    if (!isWhatsAppTerminal() && !signal.aborted && !isOfflineMode()) {
      state.socket = createdSocket;
      state.state = 'connecting';
      attachSocketHandlers(createdSocket);
      createdSocket.ev.on('creds.update', (...args: unknown[]) => {
        queueCredentialWrite(createdSocket, saveCreds as (...values: unknown[]) => unknown, args);
      });
    }
    return createdSocket;
  });
  if (isWhatsAppTerminal() || signal.aborted || isOfflineMode()) {
    if (state.socket === socket) state.socket = null;
    try {
      socket.end(undefined);
    } catch {}
    return;
  }
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
  authWipeEpoch += 1;
  const pendingWrites = credentialWriteTail;
  authCleanupPromise = authCleanupPromise.then(() => pendingWrites).then(() => wipeAuthDir());
}

function queueCredentialWrite(
  socket: BaileysSocket,
  saveCreds: (...values: unknown[]) => unknown,
  args: unknown[],
): void {
  if (!isActiveSocket(socket)) return;
  const wipeEpoch = authWipeEpoch;
  const write = credentialWriteTail.then(async () => {
    if (!state.enabled || wipeEpoch !== authWipeEpoch) return;
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
    .then(() => startSocketImpl(attemptId, startController.signal))
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
        !isOfflineMode() &&
        attemptId === whatsappStartAttempt
      ) {
        state.socket = null;
        state.state = 'disconnected';
        state.lastError = 'WhatsApp connection could not be started.';
        state.lastErrorReason = 'startup_failed';
        if (state.enabled && state.connectedPhone) {
          if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
          state.reconnectTimer = setTimeout(() => {
            state.reconnectTimer = null;
            if (state.enabled && !isWhatsAppTerminal() && !isOfflineMode()) {
              logWhatsApp('info', 'reconnect_attempt');
              void startSocket()
                .then(() => logWhatsApp('info', 'reconnect_started'))
                .catch((err) =>
                  logWhatsApp('error', 'reconnect_failed', { error: sanitizeLogText(err) }),
                );
            }
          }, RECONNECT_DELAY_MS);
          state.reconnectTimer.unref?.();
        }
      } else if (
        (startController.signal.aborted || isOfflineMode()) &&
        attemptId === whatsappStartAttempt
      ) {
        state.socket = null;
        state.state = 'disconnected';
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

function clearAckSweepTimer(): void {
  if (state.ackSweepTimer) {
    clearInterval(state.ackSweepTimer);
    state.ackSweepTimer = null;
  }
}

function ensureAckSweepTimer(): void {
  clearAckSweepTimer();
  if (!state.enabled || isWhatsAppTerminal() || process.env.FLO_WHATSAPP_SOCKET_DISABLED === '1') {
    return;
  }
  state.ackSweepTimer = setInterval(() => {
    if (!state.enabled || isWhatsAppTerminal() || state.state !== 'connected') return;
    sweepAckTimeouts();
  }, ACK_SWEEP_INTERVAL_MS);
  state.ackSweepTimer.unref?.();
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
  ensureAckSweepTimer();
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
  pairingRequestAttempt += 1;
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
  clearAckSweepTimer();
  inFlightRetries.clear();
  activeSendMessageIds.clear();
  inProcessSubmittedIds.clear();
  externalIdToMessageId.clear();
  sweepRecipientCooldownUntil.clear();
  inFlightNthVisitKeys.clear();
  state.pairingMode = null;
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
  pairingRequestAttempt += 1;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  state.pairingMode = 'qr';
  state.lastQr = null;
  state.lastPairingCode = null;
  state.lastError = null;
  state.lastErrorReason = null;
  ensureAutomationTimer();
  ensureAckSweepTimer();
  try {
    await abortable(() => startSocket(signal), signal);
  } catch (err) {
    if (!requestSignal?.aborted && !isWhatsAppTerminal() && (isOfflineMode() || signal.aborted)) {
      await (whatsappStartPromise?.catch(() => {}) ?? Promise.resolve());
      return {
        ok: false,
        error: isOfflineMode() ? 'Offline mode is on.' : 'WhatsApp request cancelled.',
      };
    }
    throw err;
  }
  if (isOfflineMode()) return { ok: false, error: 'Offline mode is on.' };
  if (signal.aborted) return { ok: false, error: 'WhatsApp request cancelled.' };
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
  const requestId = ++pairingRequestAttempt;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  state.lastPairingCode = null;
  state.lastError = null;
  state.lastErrorReason = null;
  if (state.state === 'waiting_pairing') {
    state.pairingMode = state.socket ? 'qr' : null;
    state.state = state.lastQr ? 'waiting_qr' : state.socket ? 'connecting' : 'disconnected';
  }
  ensureAutomationTimer();
  ensureAckSweepTimer();
  try {
    if (!state.socket) {
      await abortable(() => startSocket(signal), signal);
      await abortableDelay(1500, signal);
    }
    if (requestId !== pairingRequestAttempt || signal.aborted || isOfflineMode()) {
      return {
        ok: false,
        error: isOfflineMode() ? 'Offline mode is on.' : 'WhatsApp request cancelled.',
      };
    }
    const requestingSocket = state.socket;
    if (!requestingSocket || !isActiveSocket(requestingSocket)) {
      if (requestId === pairingRequestAttempt) {
        state.pairingMode = null;
        if (!state.reconnectTimer && !whatsappStartPromise) {
          state.state = 'disconnected';
        }
      }
      return { ok: false, error: 'Socket not ready, try again.' };
    }
    const code = await abortable(
      () => requestingSocket.requestPairingCode(phone.replace(/\D/g, '')),
      signal,
    );
    if (
      requestId !== pairingRequestAttempt ||
      !isActiveSocket(requestingSocket) ||
      signal.aborted ||
      isOfflineMode()
    ) {
      return {
        ok: false,
        error: isOfflineMode() ? 'Offline mode is on.' : 'WhatsApp request cancelled.',
      };
    }
    state.pairingMode = 'pairing_code';
    state.lastQr = null;
    state.lastPairingCode = code;
    state.state = 'waiting_pairing';
    return { ok: true, code };
  } catch (err: any) {
    if (requestId === pairingRequestAttempt && !isWhatsAppTerminal()) {
      if (state.socket && isActiveSocket(state.socket)) {
        state.pairingMode = 'qr';
        state.state = state.lastQr ? 'waiting_qr' : 'connecting';
      } else {
        state.pairingMode = null;
        if (!state.reconnectTimer && !whatsappStartPromise) {
          state.state = 'disconnected';
        }
      }
    }
    return { ok: false, error: err.message ?? 'Failed to request pairing code.' };
  }
}

/** Aborts in-flight WhatsApp work and closes the live socket without unpairing so Offline mode can be switched off again. */
export function suspendForOfflineMode(): void {
  pairingRequestAttempt += 1;
  whatsappAbortController.abort();
  whatsappAbortController = new AbortController();
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  clearAckSweepTimer();
  if (state.socket) {
    const socket = state.socket;
    state.socket = null;
    try {
      socket.end(undefined);
    } catch {
      /* ignore */
    }
  }
  state.pairingMode = null;
  state.lastQr = null;
  state.lastPairingCode = null;
  state.state = 'disconnected';
}

/** Cancels an in-progress QR or pairing-code attempt without logging out or wiping existing registered credentials. */
export function cancelPairing(): void {
  if (state.state === 'connected') {
    state.pairingMode = null;
    state.lastQr = null;
    state.lastPairingCode = null;
    return;
  }
  pairingRequestAttempt += 1;
  whatsappAbortController.abort();
  whatsappAbortController = new AbortController();
  state.shuttingDown = false;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.socket) {
    const socket = state.socket;
    state.socket = null;
    try {
      socket.end(undefined);
    } catch {
      /* ignore */
    }
  }
  state.pairingMode = null;
  state.lastQr = null;
  state.lastPairingCode = null;
  state.lastError = null;
  state.lastErrorReason = null;
  state.state = 'disconnected';
  if (!state.connectedPhone) {
    state.connectedPhone =
      readRegisteredPhoneFromAuthDir() || getSettingValue('whatsapp_connected_phone') || null;
  }
}

export function disconnect(): void {
  // Set shuttingDown before closing socket to prevent automatic reconnect loops.
  pairingRequestAttempt += 1;
  state.shuttingDown = true;
  whatsappAbortController.abort();
  if (state.socket) {
    try {
      void Promise.resolve(state.socket.logout()).catch(() => {});
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
  clearAckSweepTimer();
  inFlightRetries.clear();
  activeSendMessageIds.clear();
  inProcessSubmittedIds.clear();
  externalIdToMessageId.clear();
  sweepRecipientCooldownUntil.clear();
  inFlightNthVisitKeys.clear();
  state.pairingMode = null;
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
    | 'offline_mode'
    | 'no_phone'
    | 'blocked'
    | 'quiet_hours'
    | 'weekly_cap'
    | 'rate_limited'
    | 'cooldown'
    | 'not_connected'
    | 'not_on_whatsapp'
    | 'content_blocked'
    | 'not_found'
    | 'not_failed'
    | 'send_failed';
}

const sendLocks = new Map<string, Promise<void>>();
const inFlightRetries = new Map<number, Promise<SendResult>>();

// Serializes outgoing sends per recipient to prevent race conditions during rate-limit checks.
export function sendMessage(req: QueuedSend): Promise<SendResult> {
  return trackWhatsAppWork(sendMessageWithLock(req));
}

export function retryMessage(
  messageId: number,
  opts?: { userId?: string | null; signal?: AbortSignal },
): Promise<SendResult> {
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return Promise.resolve({ ok: false, error: 'Invalid message ID.', reason: 'not_found' });
  }
  if (isOfflineMode()) {
    return Promise.resolve({
      ok: false,
      messageId,
      error: 'Offline mode is on.',
      reason: 'offline_mode',
    });
  }
  if (!state.enabled || isWhatsAppTerminal()) {
    return Promise.resolve({
      ok: false,
      messageId,
      error: 'WhatsApp is not enabled.',
      reason: 'feature_off',
    });
  }
  const existingInFlight = inFlightRetries.get(messageId);
  if (existingInFlight) {
    return existingInFlight;
  }
  if (activeSendMessageIds.has(messageId)) {
    return Promise.resolve({
      ok: false,
      messageId,
      error: 'Only failed messages can be retried.',
      reason: 'not_failed',
    });
  }
  const db = getDatabase();
  const row = db
    .prepare(`
      SELECT id, bill_id, customer_id, phone_e164, direction, kind, status, body, external_message_id, created_by_user_id
      FROM whatsapp_messages
      WHERE id = ? AND direction = 'outbound'
    `)
    .get(messageId) as
    | {
        id: number;
        bill_id: number | null;
        customer_id: string | number | null;
        phone_e164: string;
        direction: 'outbound';
        kind: QueuedSend['kind'];
        status: string;
        body: string;
        external_message_id: string | null;
        created_by_user_id: string | null;
      }
    | undefined;
  if (!row) {
    return Promise.resolve({
      ok: false,
      error: 'Message not found.',
      reason: 'not_found',
    });
  }
  if (row.status !== 'failed') {
    return Promise.resolve({
      ok: false,
      messageId: row.id,
      error: 'Only failed messages can be retried.',
      reason: 'not_failed',
    });
  }
  if (row.external_message_id) {
    recordMessageAttemptExternalId(row.id, row.external_message_id);
  }
  const preservedUserId =
    typeof row.created_by_user_id === 'string' && row.created_by_user_id.startsWith('rule:')
      ? row.created_by_user_id
      : (opts?.userId ?? row.created_by_user_id ?? null);
  const retryPromise = trackWhatsAppWork(
    sendMessageWithLock({
      phoneE164: row.phone_e164,
      body: row.body,
      billId: row.bill_id,
      customerId: row.customer_id,
      kind: row.kind,
      userId: preservedUserId,
      signal: opts?.signal,
      retryMessageId: row.id,
    }),
  ).finally(() => {
    if (inFlightRetries.get(messageId) === retryPromise) {
      inFlightRetries.delete(messageId);
    }
  });
  inFlightRetries.set(messageId, retryPromise);
  return retryPromise;
}

async function sendMessageWithLock(req: QueuedSend): Promise<SendResult> {
  const startedAt = Date.now();
  const existingMessageId = req.retryMessageId ?? req.preclaimedMessageId ?? null;
  const idPart = existingMessageId != null ? { messageId: existingMessageId } : {};
  logWhatsApp('info', 'send_requested', { phone: maskPhone(req.phoneE164) });
  if (isOfflineMode()) {
    return {
      ok: false,
      ...idPart,
      error: 'Offline mode is on.',
      reason: 'offline_mode',
    };
  }
  const signal = req.signal
    ? AbortSignal.any([whatsappAbortController.signal, getOfflineModeAbortSignal(), req.signal])
    : AbortSignal.any([whatsappAbortController.signal, getOfflineModeAbortSignal()]);
  const previous = sendLocks.get(req.phoneE164) ?? Promise.resolve();
  let previousSettled = false;
  void previous.then(
    () => {
      previousSettled = true;
    },
    () => {
      previousSettled = true;
    },
  );
  let releaseOwn!: () => void;
  const ownDone = new Promise<void>((resolve) => {
    releaseOwn = resolve;
  });
  const current = previous.catch(() => {}).then(() => ownDone);
  sendLocks.set(req.phoneE164, current);
  try {
    await abortable(() => previous, signal);
    if (isOfflineMode() && !isWhatsAppTerminal()) {
      return {
        ok: false,
        ...idPart,
        error: 'Offline mode is on.',
        reason: 'offline_mode',
      };
    }
    if (isWhatsAppTerminal()) {
      const result = {
        ok: false,
        ...idPart,
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
    if (isOfflineMode() && !isWhatsAppTerminal()) {
      return {
        ok: false,
        ...idPart,
        error: 'Offline mode is on.',
        reason: 'offline_mode',
      };
    }
    if (isWhatsAppTerminal() || signal.aborted) {
      const result = {
        ok: false,
        ...idPart,
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
    releaseOwn();
    if (previousSettled) {
      if (sendLocks.get(req.phoneE164) === current) {
        sendLocks.delete(req.phoneE164);
      }
    } else {
      void current.finally(() => {
        if (sendLocks.get(req.phoneE164) === current) {
          sendLocks.delete(req.phoneE164);
        }
      });
    }
  }
}

async function sendMessageInternal(req: QueuedSend, signal: AbortSignal): Promise<SendResult> {
  const existingMessageId = req.retryMessageId ?? req.preclaimedMessageId ?? null;
  const retryIdPart = existingMessageId != null ? { messageId: existingMessageId } : {};
  if (isOfflineMode()) {
    return { ok: false, ...retryIdPart, error: 'Offline mode is on.', reason: 'offline_mode' };
  }
  if (!state.enabled || isWhatsAppTerminal())
    return { ok: false, ...retryIdPart, error: 'WhatsApp is not enabled.', reason: 'feature_off' };
  if (!req.phoneE164)
    return { ok: false, ...retryIdPart, error: 'Phone number required.', reason: 'no_phone' };
  if (typeof req.body !== 'string' || !req.body.trim() || req.body.length > MAX_BODY_CHARS) {
    return {
      ok: false,
      ...retryIdPart,
      error: `Message must be a non-empty string of at most ${MAX_BODY_CHARS} characters.`,
      reason: 'content_blocked',
    };
  }
  const db = getDatabase();
  if (req.retryMessageId != null) {
    if (activeSendMessageIds.has(req.retryMessageId)) {
      return {
        ok: false,
        messageId: req.retryMessageId,
        error: 'Only failed messages can be retried.',
        reason: 'not_failed',
      };
    }
    const retryTarget = db
      .prepare(
        'SELECT status, external_message_id FROM whatsapp_messages WHERE id = ? AND direction = ?',
      )
      .get(req.retryMessageId, 'outbound') as
      | { status: string; external_message_id: string | null }
      | undefined;
    if (!retryTarget) {
      return { ok: false, error: 'Message not found.', reason: 'not_found' };
    }
    if (retryTarget.status !== 'failed') {
      return {
        ok: false,
        messageId: req.retryMessageId,
        error: 'Only failed messages can be retried.',
        reason: 'not_failed',
      };
    }
    if (retryTarget.external_message_id) {
      recordMessageAttemptExternalId(req.retryMessageId, retryTarget.external_message_id);
    }
  }
  if (isBlocked(req.phoneE164)) {
    return {
      ok: false,
      ...retryIdPart,
      error: 'This number asked to stop receiving messages.',
      reason: 'blocked',
    };
  }
  const automationConfig = getAutomationConfig();
  const automated = isAutomatedSend(req);
  if (automated) {
    if (
      automationConfig.safety.quietHoursEnabled &&
      isCurrentlyQuietHours(automationConfig.safety)
    ) {
      return {
        ok: false,
        ...retryIdPart,
        error: 'Automated messages are paused during quiet hours.',
        reason: 'quiet_hours',
      };
    }
    if (
      isOverWeeklyAutomatedCap(
        req.phoneE164,
        automationConfig.safety.maxPerCustomerPerWeek,
        existingMessageId,
      )
    ) {
      return {
        ok: false,
        ...retryIdPart,
        error: 'Weekly automated message limit reached for this customer.',
        reason: 'weekly_cap',
      };
    }
  }
  if (state.state !== 'connected' || !state.socket) {
    return {
      ok: false,
      ...retryIdPart,
      error: 'Flo is not connected to WhatsApp.',
      reason: 'not_connected',
    };
  }
  const socket = state.socket;
  const jid = await resolveJid(req.phoneE164, socket, signal);
  if (isOfflineMode() && !isWhatsAppTerminal()) {
    return { ok: false, ...retryIdPart, error: 'Offline mode is on.', reason: 'offline_mode' };
  }
  if (isWhatsAppTerminal())
    return {
      ok: false,
      ...retryIdPart,
      error: 'WhatsApp is shutting down.',
      reason: 'send_failed',
    };
  if (isBlocked(req.phoneE164)) {
    return {
      ok: false,
      ...retryIdPart,
      error: 'This number asked to stop receiving messages.',
      reason: 'blocked',
    };
  }
  if (!jid) {
    return {
      ok: false,
      ...retryIdPart,
      error: 'This phone is not registered on WhatsApp.',
      reason: 'not_on_whatsapp',
    };
  }
  if (isInCooldown()) {
    return { ok: false, ...retryIdPart, error: 'Send is temporarily paused.', reason: 'cooldown' };
  }
  const rate = isOverRateLimit(
    req.phoneE164,
    RATE_LIMIT_MAX_PER_HOUR,
    automated,
    existingMessageId,
  );
  if (rate.limited) {
    return {
      ok: false,
      ...retryIdPart,
      error: 'Rate limit reached for this number.',
      reason: 'rate_limited',
    };
  }
  const contentErr = hasShortenerOrNonHttps(req.body);
  if (contentErr) {
    return { ok: false, ...retryIdPart, error: contentErr, reason: 'content_blocked' };
  }
  if (hasDuplicateBody(req.phoneE164, req.body, existingMessageId)) {
    return {
      ok: false,
      ...retryIdPart,
      error: 'Identical message sent to this number recently.',
      reason: 'content_blocked',
    };
  }

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
    return { ok: false, ...retryIdPart, error: 'Bill is not paid.', reason: 'send_failed' };
  }
  let resolvedKind = req.kind;
  let resolvedCustomerId = req.customerId;
  if (bill) {
    if (!resolvedCustomerId && (bill.customer_id || bill.order_customer_id)) {
      resolvedCustomerId = bill.customer_id || bill.order_customer_id;
    }
    if (
      req.kind !== 'auto_followup' &&
      !isReportMessageKind(req.kind) &&
      bill.customer_id &&
      String(bill.customer_id) === String(bill.order_customer_id)
    ) {
      resolvedKind = 'bill_receipt';
    }
  }
  if (
    req.userId === 'rule:nth_visit' &&
    req.billId != null &&
    resolvedCustomerId &&
    hasNthVisitMessageForOrder(req.billId, bill?.order_id, String(resolvedCustomerId))
  ) {
    return {
      ok: false,
      ...retryIdPart,
      error: 'Visit milestone message already sent for this order.',
      reason: 'content_blocked',
    };
  }

  let messageId: number;
  if (req.retryMessageId != null) {
    const priorRow = db
      .prepare('SELECT external_message_id FROM whatsapp_messages WHERE id = ? AND direction = ?')
      .get(req.retryMessageId, 'outbound') as { external_message_id: string | null } | undefined;
    if (priorRow?.external_message_id) {
      recordMessageAttemptExternalId(req.retryMessageId, priorRow.external_message_id);
    }
    const queuedAt = now();
    const updated = db
      .prepare(`
        UPDATE whatsapp_messages
        SET status = 'queued',
            queued_at = ?,
            seen_at = NULL,
            typing_at = NULL,
            sent_at = NULL,
            delivered_at = NULL,
            read_at = NULL,
            failed_at = NULL,
            error = NULL,
            kind = ?,
            customer_id = COALESCE(?, customer_id),
            created_by_user_id = COALESCE(?, created_by_user_id)
        WHERE id = ? AND direction = 'outbound' AND status = 'failed'
      `)
      .run(
        queuedAt,
        resolvedKind,
        resolvedCustomerId !== undefined && resolvedCustomerId !== null
          ? String(resolvedCustomerId)
          : null,
        req.userId ?? null,
        req.retryMessageId,
      );
    if (updated.changes === 0) {
      return {
        ok: false,
        messageId: req.retryMessageId,
        error: 'Only failed messages can be retried.',
        reason: 'not_failed',
      };
    }
    messageId = req.retryMessageId;
  } else if (req.preclaimedMessageId != null) {
    messageId = req.preclaimedMessageId;
  } else {
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
      return {
        ok: false,
        error: err.message ?? 'Failed to record message.',
        reason: 'send_failed',
      };
    }
  }

  activeSendMessageIds.add(messageId);
  recordRecentBody(req.phoneE164, req.body, messageId);
  let submittedToSocket = false;

  const isAlreadyDeliveredOrSent = (): boolean => {
    if (req.retryMessageId == null) return false;
    const cur = db.prepare('SELECT status FROM whatsapp_messages WHERE id = ?').get(messageId) as
      | { status: string }
      | undefined;
    return !!cur && (STATUS_RANK[cur.status] ?? -1) >= STATUS_RANK.sent;
  };

  const shutdownFailure = (): SendResult => {
    if (!submittedToSocket) {
      removeRecentBodyForMessage(req.phoneE164, messageId);
    }
    const offline = isOfflineMode() && !isWhatsAppTerminal();
    const errorMsg = offline ? 'Offline mode is on.' : 'WhatsApp is shutting down.';
    const reason = offline ? ('offline_mode' as const) : ('send_failed' as const);
    if (!whatsappTerminalCleanup && !isAlreadyDeliveredOrSent()) {
      try {
        updateMessageRow(messageId, {
          status: 'failed',
          error: errorMsg,
          timestamp_field: 'failed_at',
        });
      } catch {}
    }
    return { ok: false, messageId, error: errorMsg, reason };
  };

  try {
    if (resolvedKind === 'manual_reply' && !isAlreadyDeliveredOrSent()) {
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
    if (!isAlreadyDeliveredOrSent()) {
      updateMessageRow(messageId, { status: 'typing', timestamp_field: 'typing_at' });
    }
    await abortableDelay(randomDelayMs(req.body), signal);
    await abortable(() => socket.sendPresenceUpdate('paused', jid), signal).catch(() => {});
    if (isWhatsAppTerminal() || signal.aborted) return shutdownFailure();
    if (isAlreadyDeliveredOrSent()) {
      return { ok: true, messageId };
    }
    if (isBlocked(req.phoneE164)) {
      removeRecentBodyForMessage(req.phoneE164, messageId);
      updateMessageRow(messageId, {
        status: 'failed',
        error: 'This number asked to stop receiving messages.',
        timestamp_field: 'failed_at',
      });
      return {
        ok: false,
        messageId,
        error: 'This number asked to stop receiving messages.',
        reason: 'blocked',
      };
    }
    submittedToSocket = true;
    const sent = await abortable(
      () =>
        Promise.resolve(socket.sendMessage(jid, { text: req.body })).then((res) => {
          const extId = res?.key?.id ?? null;
          if (extId) {
            try {
              recordMessageAttemptExternalId(messageId, extId);
            } catch {}
          }
          return res;
        }),
      signal,
    );
    if (isWhatsAppTerminal() || signal.aborted) return shutdownFailure();
    const sentExternalId = sent?.key?.id ?? null;
    const trimmedSentExternalId = typeof sentExternalId === 'string' ? sentExternalId.trim() : '';
    inProcessSubmittedIds.add(messageId);
    // Do not mark 'sent' immediately; wait for server ACK (status=2) in messages.update.
    // Refresh typing_at on submission completion so ACK_TIMEOUT_MS starts from here.
    updateMessageRow(messageId, {
      ...(trimmedSentExternalId ? { external_message_id: trimmedSentExternalId } : {}),
      timestamp_field: 'typing_at',
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
    if (!isAlreadyDeliveredOrSent()) {
      updateMessageRow(messageId, {
        status: 'failed',
        error: err?.message ?? 'Send failed',
        timestamp_field: 'failed_at',
      });
    }
    const statusCode = (err as any)?.output?.statusCode;
    if (typeof statusCode === 'number' && RATE_LIMITED_STATUS_CODES.has(statusCode)) {
      triggerCooldown(
        `Send rate-limited by WhatsApp (${statusCode}). Cooling down for 5 minutes.`,
        5 * 60 * 1000,
        'rate_limited',
      );
    }
    return { ok: false, messageId, error: err?.message ?? 'Send failed', reason: 'send_failed' };
  } finally {
    activeSendMessageIds.delete(messageId);
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
  cash_closure_id?: number | null;
  direction: 'inbound' | 'outbound';
  kind: MessageKind;
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
  canExportDailySales?: boolean;
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
  if (!opts.canViewReports) {
    where.push("kind NOT IN ('z_report', 'daily_sales_report')");
  } else if (!opts.canExportDailySales) {
    where.push("kind != 'daily_sales_report'");
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(opts.limit, opts.offset ?? 0);
  const rows = getDatabase()
    .prepare(`
    SELECT id, phone_e164, bill_id, customer_id, cash_closure_id, direction, kind, status,
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

export function roundLoyaltyAmount(value: unknown, fractionDigits?: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const rawDigits =
    typeof fractionDigits === 'number' && Number.isFinite(fractionDigits)
      ? Math.max(0, Math.min(6, Math.trunc(fractionDigits)))
      : tenantRegionalSnapshot().currencyFractionDigits;
  const factor = Math.pow(10, rawDigits);
  return Math.round((num + Number.EPSILON) * factor) / factor;
}

function formatCurrencyForTemplate(
  amount: number,
  regional: Pick<RegionalSnapshot, 'locale' | 'currency' | 'currencyFractionDigits'>,
): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat(regional.locale, {
      style: 'currency',
      currency: regional.currency,
      minimumFractionDigits: regional.currencyFractionDigits,
      maximumFractionDigits: regional.currencyFractionDigits,
    }).format(safe);
  } catch {
    return new Intl.NumberFormat(regional.locale, {
      minimumFractionDigits: regional.currencyFractionDigits,
      maximumFractionDigits: regional.currencyFractionDigits,
    }).format(safe);
  }
}

function formatDateForTemplate(
  rawTs: string | null | undefined,
  regional: Pick<RegionalSnapshot, 'locale' | 'timezone'>,
  includeTime = false,
): string {
  if (!rawTs) return '';
  try {
    const iso = rawTs.includes('T') ? rawTs : `${rawTs.replace(' ', 'T')}Z`;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(rawTs);
    return new Intl.DateTimeFormat(regional.locale, {
      dateStyle: 'medium',
      ...(includeTime ? { timeStyle: 'short' } : {}),
      timeZone: regional.timezone,
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
  const regional = tenantRegionalSnapshot();
  const country = regional.country;
  const storeName = getSettingValue('business_name') || 'Store';
  const storePhone =
    getSettingValue('business_phone') || getSettingValue('phone') || state.connectedPhone || '';
  const feedbackLink = config.safety.feedbackLink || '';
  const instagram = getSettingValue('instagram_handle') || '';

  const context: WhatsAppTemplateContext = {
    customer_name: 'Guest',
    customer_phone: '',
    visit_count: 0,
    last_visit_date: '',
    total_spent: formatCurrencyForTemplate(0, regional),
    bill_no: '',
    order_date: '',
    order_items: '',
    total: formatCurrencyForTemplate(0, regional),
    payment_method: '',
    points_earned:
      opts.pointsEarned !== undefined
        ? roundLoyaltyAmount(opts.pointsEarned, regional.currencyFractionDigits)
        : 0,
    points_balance: 0,
    points_value: formatCurrencyForTemplate(0, regional),
    store_name: storeName,
    store_phone: storePhone,
    feedback_link: feedbackLink,
    instagram,
  };

  let resolvedCustomerId: string | null =
    opts.customerId !== undefined && opts.customerId !== null ? String(opts.customerId) : null;

  if (opts.billId != null) {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(opts.billId)) as
      | {
          id: number;
          order_id?: string | number | null;
          customer_id?: string | number | null;
          bill_number?: string | null;
          paid_at?: string | null;
          created_at?: string | null;
          total?: number | null;
          payment_details?: string | null;
          payment_status?: string | null;
        }
      | undefined;
    if (bill) {
      const order = bill.order_id
        ? (db.prepare('SELECT * FROM orders WHERE id = ?').get(bill.order_id) as
            | {
                customer_id?: string | number | null;
                created_at?: string | null;
              }
            | undefined)
        : null;
      if (!resolvedCustomerId && (bill.customer_id || order?.customer_id)) {
        resolvedCustomerId = String(bill.customer_id || order?.customer_id);
      }
      context.bill_no = String(bill.bill_number || bill.id);
      context.order_date = formatDateForTemplate(
        bill.paid_at || order?.created_at || bill.created_at,
        regional,
        true,
      );
      context.total = formatCurrencyForTemplate(Number(bill.total || 0), regional);

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
              `${item.quantity}x ${item.product_name} - ${formatCurrencyForTemplate(Number(item.total || 0), regional)}`,
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
                .map((p: { method?: unknown } | null | undefined) => String(p?.method || '').trim())
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
        context.points_earned = roundLoyaltyAmount(
          earnedRow?.total,
          regional.currencyFractionDigits,
        );
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
      context.total_spent = formatCurrencyForTemplate(totalSpent, regional);
      context.last_visit_date = lastVisitAt
        ? formatDateForTemplate(lastVisitAt, regional, false)
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
      const balance = Math.max(
        0,
        roundLoyaltyAmount(ledgerRow?.balance, regional.currencyFractionDigits),
      );
      context.points_balance = balance;
      context.points_value = formatCurrencyForTemplate(balance, regional);
    }
  }

  return context;
}

function hasRuleMessageForBill(billId: number, ruleUserId: string): boolean {
  const row = getDatabase()
    .prepare(
      "SELECT 1 FROM whatsapp_messages WHERE bill_id = ? AND created_by_user_id = ? AND status != 'failed' LIMIT 1",
    )
    .get(billId, ruleUserId);
  return !!row;
}

function hasNthVisitMessageForOrder(
  billId: number,
  orderId: string | number | null | undefined,
  customerId: string,
): boolean {
  if (hasRuleMessageForBill(billId, 'rule:nth_visit')) return true;
  if (orderId !== null && orderId !== undefined && orderId !== '') {
    const row = getDatabase()
      .prepare(`
        SELECT 1
        FROM whatsapp_messages wm
        JOIN bills b ON b.id = wm.bill_id
        WHERE b.order_id = ?
          AND wm.customer_id = ?
          AND wm.created_by_user_id = 'rule:nth_visit'
          AND wm.status != 'failed'
        LIMIT 1
      `)
      .get(orderId, customerId);
    if (row) return true;
  }
  return false;
}

const inFlightBillAutomations = new Map<
  number,
  Promise<{ triggered: WhatsAppTriggerType[]; results: Record<string, SendResult> }>
>();
const inFlightNthVisitKeys = new Set<string>();

function getNthVisitDedupeKey(
  billId: number,
  orderId: string | number | null | undefined,
  customerId: string,
): string {
  const scope =
    orderId !== null && orderId !== undefined && String(orderId) !== ''
      ? `order:${orderId}`
      : `bill:${billId}`;
  return `${scope}:customer:${customerId}`;
}
let activeAutomationSweepPromise: Promise<{ feedbackSent: number; winbackSent: number }> | null =
  null;
const sweepRecipientCooldownUntil = new Map<string, number>();
const SWEEP_REJECT_COOLDOWN_MS = 30 * 60 * 1000;
const SWEEP_MAX_FAILED_RETRIES = 3;

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
      .get(billId) as
      | {
          order_id?: string | number | null;
          payment_status?: string | null;
          customer_id?: string | number | null;
          order_customer_id?: string | number | null;
        }
      | undefined;
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
      | {
          id: string;
          name: string;
          phone: string | null;
          country_code: string | null;
          is_active: number;
        }
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
      const balance = roundLoyaltyAmount(context.points_balance);
      const earned = roundLoyaltyAmount(context.points_earned);
      const redeemedRow = db
        .prepare(`
          SELECT COALESCE(SUM(amount), 0) AS total
          FROM loyalty_ledger
          WHERE bill_id = ? AND type = 'debit'
        `)
        .get(billId) as { total: number } | undefined;
      const redeemed = roundLoyaltyAmount(redeemedRow?.total);
      const prevBalance = roundLoyaltyAmount(balance - earned + redeemed);
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .replace('T', ' ')
        .replace(/\..*$/, '');
      const recentPointsReminder = db
        .prepare(`
          SELECT 1 FROM whatsapp_messages
          WHERE phone_e164 = ?
            AND created_by_user_id = 'rule:points_threshold'
            AND status != 'failed'
            AND queued_at >= ?
          LIMIT 1
        `)
        .get(parsedPhone.e164, sevenDaysAgo);
      if (balance >= threshold && (prevBalance < threshold || !recentPointsReminder)) {
        const tpl = templateMap.get(pointsRule.templateId) ?? templateMap.get('loyalty_milestone');
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
    const nthVisitKey = getNthVisitDedupeKey(billId, bill.order_id, String(customerId));
    if (
      nthVisitRule?.enabled &&
      !inFlightNthVisitKeys.has(nthVisitKey) &&
      !hasNthVisitMessageForOrder(billId, bill.order_id, String(customerId))
    ) {
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
            inFlightNthVisitKeys.add(nthVisitKey);
            try {
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
            } finally {
              inFlightNthVisitKeys.delete(nthVisitKey);
            }
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
  sweepAckTimeouts(nowMs);
  for (const [key, until] of sweepRecipientCooldownUntil) {
    if (until <= nowMs) sweepRecipientCooldownUntil.delete(key);
  }
  const db = getDatabase();
  const config = getAutomationConfig();
  const templateMap = new Map(config.templates.map((t) => [t.id, t]));
  const tenantCountry = getSettingValue('country') || '';

  // 1. Delayed feedback requests (X hours after paid_at, within 7 days of becoming due)
  const feedbackRule = config.rules.find((r) => r.trigger === 'feedback_delay');
  if (feedbackRule?.enabled) {
    const delayHours = Math.max(1, feedbackRule.delayHours ?? 2);
    const cutoffMs = nowMs - delayHours * 60 * 60 * 1000;
    const cutoff = new Date(cutoffMs).toISOString().replace('T', ' ').replace(/\..*$/, '');
    const lookbackFloor = new Date(cutoffMs - 7 * 24 * 60 * 60 * 1000)
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
            WHERE wm.bill_id = b.id
              AND wm.created_by_user_id = 'rule:feedback_delay'
              AND wm.status != 'failed'
          )
          AND (
            SELECT COUNT(*) FROM whatsapp_messages wm
            WHERE wm.bill_id = b.id
              AND wm.created_by_user_id = 'rule:feedback_delay'
              AND wm.status = 'failed'
          ) < ?
        ORDER BY COALESCE(b.paid_at, b.created_at) DESC
      `)
      .all(cutoff, lookbackFloor, SWEEP_MAX_FAILED_RETRIES) as Array<{
      bill_id: number;
      customer_id: string;
      phone: string;
      country_code: string | null;
    }>;

    const tpl = templateMap.get(feedbackRule.templateId) ?? templateMap.get('feedback');
    if (tpl) {
      let dispatched = 0;
      for (const row of dueBills) {
        if (isWhatsAppTerminal() || dispatched >= 25) break;
        const skipKey = `feedback:${row.bill_id}`;
        const skipUntil = sweepRecipientCooldownUntil.get(skipKey);
        if (skipUntil && skipUntil > nowMs) continue;
        const parsedPhone = parsePhoneE164(row.phone, tenantCountry || row.country_code || '');
        if (!parsedPhone || isBlocked(parsedPhone.e164)) continue;
        const context = buildWhatsAppTemplateContext({
          billId: row.bill_id,
          customerId: row.customer_id,
        });
        const body = renderWhatsAppTemplate(tpl.body, context);
        if (!body) continue;
        const res = await sendMessage({
          phoneE164: parsedPhone.e164,
          body,
          billId: row.bill_id,
          customerId: row.customer_id,
          kind: 'auto_followup',
          userId: 'rule:feedback_delay',
        });
        if (res.ok) {
          dispatched++;
          feedbackSent++;
        } else if (res.messageId !== undefined) {
          dispatched++;
        } else if (
          res.reason === 'quiet_hours' ||
          res.reason === 'cooldown' ||
          res.reason === 'feature_off' ||
          res.reason === 'not_connected'
        ) {
          break;
        } else {
          sweepRecipientCooldownUntil.set(skipKey, nowMs + SWEEP_REJECT_COOLDOWN_MS);
        }
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
              AND wm.status != 'failed'
          )
          AND (
            SELECT COUNT(*) FROM whatsapp_messages wm
            WHERE wm.customer_id = c.id
              AND wm.created_by_user_id = 'rule:winback'
              AND wm.queued_at >= ?
              AND wm.status = 'failed'
          ) < ?
        ORDER BY cv.last_visit_at DESC
      `)
      .all(cutoff, cutoff, cutoff, SWEEP_MAX_FAILED_RETRIES) as Array<{
      id: string;
      phone: string;
      country_code: string | null;
      last_visit_at: string;
    }>;

    const tpl = templateMap.get(winbackRule.templateId) ?? templateMap.get('winback');
    if (tpl) {
      let dispatched = 0;
      for (const cust of dueCustomers) {
        if (isWhatsAppTerminal() || dispatched >= 25) break;
        const skipKey = `winback:${cust.id}`;
        const skipUntil = sweepRecipientCooldownUntil.get(skipKey);
        if (skipUntil && skipUntil > nowMs) continue;
        const parsedPhone = parsePhoneE164(cust.phone, tenantCountry || cust.country_code || '');
        if (!parsedPhone || isBlocked(parsedPhone.e164)) continue;
        const context = buildWhatsAppTemplateContext({ customerId: cust.id });
        const body = renderWhatsAppTemplate(tpl.body, context);
        if (!body) continue;
        const res = await sendMessage({
          phoneE164: parsedPhone.e164,
          body,
          billId: null,
          customerId: cust.id,
          kind: 'auto_followup',
          userId: 'rule:winback',
        });
        if (res.ok) {
          dispatched++;
          winbackSent++;
        } else if (res.messageId !== undefined) {
          dispatched++;
        } else if (
          res.reason === 'quiet_hours' ||
          res.reason === 'cooldown' ||
          res.reason === 'feature_off' ||
          res.reason === 'not_connected'
        ) {
          break;
        } else {
          sweepRecipientCooldownUntil.set(skipKey, nowMs + SWEEP_REJECT_COOLDOWN_MS);
        }
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
  const tpl = opts.templateId ? config.templates.find((t) => t.id === opts.templateId) : undefined;
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
  const minPoints = Math.max(0, roundLoyaltyAmount(opts.minPoints || 0));
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
  if (state.enabled && !whatsappShutdownRequested && !whatsappTerminalCleanup) {
    state.shuttingDown = false;
    if (whatsappAbortController.signal.aborted) whatsappAbortController = new AbortController();
  }
  logWhatsApp('info', 'startup_init', {
    enabled: state.enabled,
    hasCredentials: fs.existsSync(credsPath),
    connectedPhone: maskPhone(state.connectedPhone),
  });
  sweepAckTimeouts(Date.now(), {
    includeAllUnfinished: !state.socket && sendLocks.size === 0 && activeSendMessageIds.size === 0,
  });
  ensureAutomationTimer();
  ensureAckSweepTimer();
  if (state.enabled) {
    void startSocket().catch(() => {});
  }
}

export function handleSystemResume(): void {
  if (
    !state.enabled ||
    isWhatsAppTerminal() ||
    isOfflineMode() ||
    !state.connectedPhone ||
    state.reconnectTimer ||
    whatsappStartPromise
  ) {
    return;
  }
  if (!state.socket) {
    logWhatsApp('info', 'system_resume_reconnect');
    void startSocket().catch((err) => {
      logWhatsApp('error', 'system_resume_reconnect_failed', { error: sanitizeLogText(err) });
    });
    return;
  }
  if (state.state !== 'connected' || !isSocketTransportHealthy(state.socket)) {
    const staleSocket = state.socket;
    state.socket = null;
    state.pairingMode = null;
    state.lastQr = null;
    state.lastPairingCode = null;
    try {
      staleSocket.end(undefined);
    } catch {
      /* ignore */
    }
    logWhatsApp('info', 'system_resume_reconnect', { reason: 'stale_socket' });
    void startSocket().catch((err) => {
      logWhatsApp('error', 'system_resume_reconnect_failed', { error: sanitizeLogText(err) });
    });
    return;
  }
  const activeSocket = state.socket as BaileysSocket & {
    sendPresenceUpdate?: (type: string) => unknown;
  };
  const probe =
    typeof activeSocket.sendPresenceUpdate === 'function'
      ? () => Promise.resolve(activeSocket.sendPresenceUpdate!('available'))
      : null;
  if (!probe) return;
  let probeTimer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    probeTimer = setTimeout(() => {
      reject(new Error('WhatsApp resume health check timed out'));
    }, RESUME_HEALTH_CHECK_TIMEOUT_MS);
    probeTimer.unref?.();
  });
  void Promise.race([probe(), timeoutPromise])
    .then(() => {
      if (probeTimer) clearTimeout(probeTimer);
    })
    .catch((err) => {
      if (probeTimer) clearTimeout(probeTimer);
      if (
        state.socket !== activeSocket ||
        !state.enabled ||
        isWhatsAppTerminal() ||
        isOfflineMode() ||
        !state.connectedPhone ||
        state.reconnectTimer ||
        whatsappStartPromise
      ) {
        return;
      }
      state.socket = null;
      state.pairingMode = null;
      state.lastQr = null;
      state.lastPairingCode = null;
      try {
        activeSocket.end(undefined);
      } catch {
        /* ignore */
      }
      logWhatsApp('warn', 'system_resume_probe_failed', { error: sanitizeLogText(err) });
      void startSocket().catch((startErr) => {
        logWhatsApp('error', 'system_resume_reconnect_failed', {
          error: sanitizeLogText(startErr),
        });
      });
    });
}

export interface StoredZReportClosureRow {
  id: number;
  scope?: string;
  business_date: string;
  period_start: string;
  period_end: string;
  z_number: number;
  closed_by: string;
  notes: string | null;
  gross_collected_cents: number;
  refunded_cents: number;
  net_collected_cents: number;
  bill_count: number;
  opening_float_cents: number;
  expected_cash_cents: number;
  counted_cash_cents: number;
  variance_cents: number;
  payment_methods_json: string | null;
}

function truncateWhatsAppText(value: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  if (value.length <= maxUnits) return value;
  const suffix = maxUnits > 3 ? '...' : '';
  let cut = maxUnits - suffix.length;
  if (cut > 0) {
    const code = value.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  }
  return `${value.slice(0, Math.max(0, cut)).trimEnd()}${suffix}`;
}

function localizeZPaymentMethod(language: string, method: string): string {
  const key = String(method || '')
    .trim()
    .toLowerCase();
  if (key === 'cash') return printLabel(language, 'pos.methodCash');
  if (key === 'card') return printLabel(language, 'pos.methodCard');
  if (key === 'wallet') return printLabel(language, 'pos.methodWallet');
  if (!method) return printLabel(language, 'common.unknown');
  return method.charAt(0).toUpperCase() + method.slice(1);
}

function formatZReportDateTime(
  value: string,
  locale: string,
  timeZone: string,
  preferences?: LocalePreferences,
): string {
  try {
    const parsed = parseDbTimestamp(value);
    if (Number.isNaN(parsed.getTime())) return value;
    const numberingSystem = preferences?.digits === 'latin' ? 'latn' : undefined;
    const calendar =
      preferences?.calendar === 'gregorian'
        ? 'gregory'
        : preferences?.calendar === 'persian'
          ? 'persian'
          : undefined;
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone,
      ...(numberingSystem ? { numberingSystem } : {}),
      ...(calendar ? { calendar } : {}),
    }).format(parsed);
  } catch {
    return value;
  }
}

export function formatStoredZReportWhatsAppMessage(
  closure: StoredZReportClosureRow,
  options?: {
    language?: string;
    locale?: string;
    preferences?: LocalePreferences;
    currency?: string;
    timezone?: string;
    businessName?: string;
    closedByName?: string;
    maxChars?: number;
  },
): string {
  const db = getDatabase();
  const maxChars = Math.max(256, Math.min(MAX_BODY_CHARS, options?.maxChars ?? MAX_BODY_CHARS));
  const language = options?.language || getSettingValue('language') || 'en';
  const snapshot = tenantRegionalSnapshot();
  const locale = options?.locale || snapshot.locale || 'en-US';
  const preferences: LocalePreferences = options?.preferences ?? snapshot.preferences;
  const timezone = options?.timezone || snapshot.timezone || 'UTC';
  const currency = options?.currency || getTenantCurrency(db) || 'USD';
  const minorFactor = getCurrencyMinorUnitFactor(currency);
  const numberingSystem = preferences.digits === 'latin' ? 'latn' : undefined;
  const businessName =
    (options?.businessName !== undefined
      ? options.businessName
      : (getSettingValue('business_name') ?? '')) || 'FloCafe';

  let closedByName = options?.closedByName;
  if (!closedByName) {
    try {
      const userRow = db.prepare('SELECT name FROM users WHERE id = ?').get(closure.closed_by) as
        | { name: string }
        | undefined;
      closedByName = userRow?.name || closure.closed_by;
    } catch {
      closedByName = closure.closed_by;
    }
  }

  const fmtMoney = (cents: number): string =>
    formatMoney(Number(cents || 0) / minorFactor, currency, locale, preferences);
  const fmtNum = (val: number): string => formatNumber(Number(val || 0), locale, numberingSystem);

  let rawMethods: Array<{ method?: string; count?: number; total_cents?: number }> = [];
  try {
    const parsed = JSON.parse(closure.payment_methods_json || '[]');
    if (Array.isArray(parsed)) rawMethods = parsed;
  } catch {
    rawMethods = [];
  }

  const periodStart = formatZReportDateTime(closure.period_start, locale, timezone, preferences);
  const periodEnd = formatZReportDateTime(closure.period_end, locale, timezone, preferences);
  const period = `${periodStart} - ${periodEnd}`;
  const zTitle = printLabel(language, 'dashboard.zReport').replace(/:$/, '').trim();
  const closedByLabel = printLabel(language, 'print.zReport.closedBy').replace(/:$/, '').trim();
  const dateLabel = printLabel(language, 'dashboard.businessDateLabel').replace(/:$/, '').trim();
  const notesLabel = printLabel(language, 'dashboard.closureNotes').replace(/:$/, '').trim();

  const varianceIndicator =
    closure.variance_cents === 0
      ? `✅ ${printLabel(language, 'dashboard.varianceExact')}`
      : closure.variance_cents < 0
        ? `⚠️ ${printLabel(language, 'dashboard.varianceShort')}`
        : `⚠️ ${printLabel(language, 'dashboard.varianceOver')}`;

  const buildPrefixLines = (storeCap?: number, closedByCap = 80): string[] => {
    const storeDisplay = storeCap
      ? truncateWhatsAppText(businessName.trim(), storeCap)
      : businessName.trim();
    return [
      `📊 *${zTitle} #${fmtNum(closure.z_number)} - ${storeDisplay}*`,
      `📅 *${dateLabel}:* ${closure.business_date} (${period})`,
      `👤 *${closedByLabel}:* ${truncateWhatsAppText(String(closedByName || ''), closedByCap)}`,
      '',
      `💰 *${printLabel(language, 'dashboard.salesSummary')}*`,
      `• ${printLabel(language, 'dashboard.grossCollections')}: ${fmtMoney(closure.gross_collected_cents)}`,
      `• ${printLabel(language, 'dashboard.refunds')}: ${fmtMoney(closure.refunded_cents)}`,
      `• ${printLabel(language, 'dashboard.netCollections')}: ${fmtMoney(closure.net_collected_cents)}`,
      `• ${printLabel(language, 'dashboard.billsCount').replace('{count}', fmtNum(closure.bill_count))}`,
      '',
      `💳 *${printLabel(language, 'dashboard.paymentBreakdown')}*`,
    ];
  };

  const buildPaymentLines = (methodCap?: number): string[] => {
    if (rawMethods.length === 0) {
      return [`• ${printLabel(language, 'print.zReport.none')}`];
    }
    return rawMethods.map((pm) => {
      const rawLabel = localizeZPaymentMethod(language, String(pm.method || ''));
      const label = methodCap ? truncateWhatsAppText(rawLabel, methodCap) : rawLabel;
      const amount = fmtMoney(Number(pm.total_cents || 0));
      const count = fmtNum(Number(pm.count || 0));
      return `• ${label}: ${amount} (${count})`;
    });
  };

  const reconciliationLines: string[] = [
    '',
    `💵 *${printLabel(language, 'dashboard.drawerReconciliation')}*`,
    `• ${printLabel(language, 'dashboard.openingFloat')}: ${fmtMoney(closure.opening_float_cents)}`,
    `• ${printLabel(language, 'dashboard.expectedCash')}: ${fmtMoney(closure.expected_cash_cents)}`,
    `• ${printLabel(language, 'dashboard.countedCash')}: ${fmtMoney(closure.counted_cash_cents)}`,
    `• ${printLabel(language, 'dashboard.variance')}: ${fmtMoney(closure.variance_cents)} (${varianceIndicator})`,
  ];

  const buildMessage = (notesCap?: number, storeCap?: number, methodCap?: number): string => {
    const lines: string[] = [
      ...buildPrefixLines(storeCap),
      ...buildPaymentLines(methodCap),
      ...reconciliationLines,
    ];

    if (notesCap !== 0) {
      const rawNotes = (closure.notes ?? '').trim();
      const displayNotes = rawNotes
        ? notesCap !== undefined
          ? truncateWhatsAppText(rawNotes, notesCap)
          : rawNotes
        : printLabel(language, 'print.zReport.none');
      lines.push('', `📝 *${notesLabel}:* ${displayNotes}`);
    }
    return lines.join('\n');
  };

  const candidates: Array<[number | undefined, number | undefined, number | undefined]> = [
    [undefined, undefined, undefined],
    [240, undefined, undefined],
    [80, undefined, undefined],
    [0, undefined, undefined],
    [0, undefined, 36],
    [0, 48, 24],
    [0, 32, 16],
  ];

  for (const [notesCap, storeCap, methodCap] of candidates) {
    const candidate = buildMessage(notesCap, storeCap, methodCap);
    if (candidate.length <= maxChars) return candidate;
  }

  const prefix = buildPrefixLines(32, 32).join('\n');
  const suffix = reconciliationLines.join('\n');
  const ellipsisRow = '• ...';
  const budget = maxChars - prefix.length - 1 - suffix.length;
  if (budget >= 1 + ellipsisRow.length) {
    const keptRows: string[] = [];
    let used = 0;
    const paymentRows = buildPaymentLines(16);
    for (let i = 0; i < paymentRows.length; i++) {
      const row = paymentRows[i];
      const remaining = paymentRows.length - i - 1;
      const reserve = remaining > 0 ? 1 + ellipsisRow.length : 0;
      if (used + 1 + row.length + reserve <= budget) {
        keptRows.push(row);
        used += 1 + row.length;
      } else {
        keptRows.push(ellipsisRow);
        break;
      }
    }
    return [prefix, ...keptRows, suffix].join('\n');
  }

  const minimal = [prefix, suffix].join('\n');
  if (minimal.length <= maxChars) return minimal;
  return truncateWhatsAppText(minimal, maxChars);
}

export interface TriggerDayCloseZReportResult {
  ok: boolean;
  skipped?: boolean;
  messageId?: number;
  reason?: string;
  error?: string;
}

/**
 * Fires at most one automatic Z-report WhatsApp attempt for a completed
 * store-level day close (`scope = 'day'`). Suppresses cleanly with no queued
 * send when Offline mode or disabled WhatsApp is active, and persists failures
 * in `whatsapp_messages` for manual retry without ever auto-retrying on reconnect.
 */
export async function triggerDayCloseZReport(
  closureId: number,
): Promise<TriggerDayCloseZReportResult> {
  try {
    if (!Number.isInteger(closureId) || closureId <= 0) {
      return { ok: false, skipped: true, reason: 'invalid_closure' };
    }
    if (isOfflineMode()) {
      return { ok: false, skipped: true, reason: 'offline_mode' };
    }
    if (!state.enabled || isWhatsAppTerminal()) {
      return { ok: false, skipped: true, reason: 'feature_off' };
    }
    const config = getAutomationConfig();
    const rule = config.rules.find((r) => r.trigger === 'z_report_day_close');
    if (!rule?.enabled) {
      return { ok: false, skipped: true, reason: 'rule_disabled' };
    }
    const rawRecipient = typeof rule.recipientPhone === 'string' ? rule.recipientPhone.trim() : '';
    if (!rawRecipient) {
      return { ok: false, skipped: true, reason: 'phone_required' };
    }
    const parsedPhone = parsePhoneE164(rawRecipient, getSettingValue('country') || '');
    if (!parsedPhone) {
      return { ok: false, skipped: true, reason: 'invalid_phone' };
    }

    const db = getDatabase();
    const closure = db
      .prepare("SELECT * FROM cash_closures WHERE id = ? AND scope = 'day'")
      .get(closureId) as StoredZReportClosureRow | undefined;
    if (!closure) {
      return { ok: false, skipped: true, reason: 'not_day_close' };
    }

    const body = formatStoredZReportWhatsAppMessage(closure);
    const queuedAt = now();
    const claim = db
      .prepare(`
        INSERT OR IGNORE INTO whatsapp_messages (
          phone_e164, direction, kind, status, body, queued_at,
          created_by_user_id, cash_closure_id
        ) VALUES (?, 'outbound', 'z_report', 'queued', ?, ?, 'rule:z_report_day_close', ?)
      `)
      .run(parsedPhone.e164, body, queuedAt, closureId);

    if (claim.changes === 0) {
      return { ok: false, skipped: true, reason: 'duplicate_closure' };
    }
    const messageId = Number(claim.lastInsertRowid);
    activeSendMessageIds.add(messageId);

    const ensureFailedIfUnfinished = (fallbackError: string) => {
      try {
        const cur = db
          .prepare('SELECT status FROM whatsapp_messages WHERE id = ?')
          .get(messageId) as { status: string } | undefined;
        if (cur && cur.status !== 'failed' && (STATUS_RANK[cur.status] ?? -1) < STATUS_RANK.sent) {
          updateMessageRow(messageId, {
            status: 'failed',
            error: fallbackError,
            timestamp_field: 'failed_at',
          });
        }
      } catch {
        /* best-effort */
      }
    };

    try {
      const result = await trackWhatsAppWork(
        sendMessageWithLock({
          phoneE164: parsedPhone.e164,
          body,
          billId: null,
          customerId: null,
          kind: 'z_report',
          userId: 'rule:z_report_day_close',
          preclaimedMessageId: messageId,
        }),
      );
      if (!result.ok) {
        ensureFailedIfUnfinished(result.error || result.reason || 'Send failed');
      }
      return {
        ok: result.ok,
        messageId,
        reason: result.reason,
        error: result.error,
      };
    } catch (sendErr: unknown) {
      const errMsg =
        (sendErr instanceof Error
          ? sendErr.message
          : (sendErr as { message?: string } | null)?.message) || 'Send failed';
      ensureFailedIfUnfinished(errMsg);
      logWhatsApp('warn', 'day_close_z_report_send_error', {
        closureId,
        messageId,
        error: sanitizeLogText(sendErr),
      });
      return { ok: false, messageId, reason: 'send_failed', error: errMsg };
    } finally {
      activeSendMessageIds.delete(messageId);
    }
  } catch (err: unknown) {
    logWhatsApp('error', 'day_close_z_report_error', {
      closureId,
      error: sanitizeLogText(err),
    });
    return {
      ok: false,
      reason: 'send_failed',
      error:
        (err instanceof Error ? err.message : (err as { message?: string } | null)?.message) ||
        'Failed to dispatch day-close Z report',
    };
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
  clearAckSweepTimer();
  inFlightRetries.clear();
  activeSendMessageIds.clear();
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

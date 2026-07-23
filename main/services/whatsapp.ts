import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { WASocket as BaileysSocket, WAMessageKey } from '@whiskeysockets/baileys';
import { parsePhoneNumber } from 'libphonenumber-js';
import { getDatabase, getSettingValue, now } from '../db';

// Baileys is ESM-only; CommonJS `require()` blows up with ERR_REQUIRE_ESM.
// Lazy-load via dynamic import() and cache the module reference for the
// lifetime of the process.
let baileysModule: typeof import('@whiskeysockets/baileys') | null = null;
async function loadBaileys(): Promise<typeof import('@whiskeysockets/baileys')> {
  if (!baileysModule) {
    // Prevent TypeScript from transpiling dynamic import() to require() in CJS mode
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    baileysModule = (await dynamicImport('@whiskeysockets/baileys')) as typeof import('@whiskeysockets/baileys');
  }
  return baileysModule;
}

// pino's default write path pulls in `thread-stream`, which spawns a real
// Node worker_threads Worker pointed at a file path — inside an
// electron-builder asar archive that path doesn't resolve the way plain
// require()/fs calls do, so this can throw at load time in a *packaged*
// build even though it's fine in dev (plain node_modules on disk). This is
// a `require()`, not a static `import`, specifically so the failure is
// catchable here — a static `import { pino } from 'pino'` at module scope
// can't be wrapped in try/catch and would take the entire process down
// before any route (including /api/auth/login) could ever respond, for
// every user, WhatsApp on or off. Fall back to a no-op logger shaped like
// pino's so callers (and Baileys, which uses .child()) don't need to care.
type MinimalLogger = { level: string; trace: (...a: unknown[]) => void; debug: (...a: unknown[]) => void; info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void; fatal: (...a: unknown[]) => void; child: (obj: Record<string, unknown>) => MinimalLogger };
function makeBaileysLogger(): MinimalLogger {
  const noop = (): void => {};
  const fallback: MinimalLogger = { level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => fallback };
  try {
    const pinoFactory = require('pino').pino ?? require('pino');
    return pinoFactory({ level: 'silent' });
  } catch (err) {
    console.error('[WhatsApp] pino failed to load (packaging/ASAR issue?) — WhatsApp logging disabled, everything else unaffected:', (err as Error).message);
    return fallback;
  }
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

// Baileys is extremely chatty at debug. Silence it so the Electron log
// doesn't drown out the real signal from our service.
const baileysLogger = makeBaileysLogger();

const SHORTENER_HOSTS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd',
  'buff.ly', 'shorturl.at', 'rb.gy', 'cutt.ly', 'rebrand.ly',
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
  /**
   * Stable reason code for the last error. Frontend translates via i18n.
   * Distinct from `lastError` (which may be a raw third-party string for
   * debugging). Known values: `logged_out`, `reconnecting`, `rate_limited`.
   */
  lastErrorReason?: string | null;
  qr?: string;
  pairingCode?: string;
}

interface QueuedSend {
  phoneE164: string;
  body: string;
  billId: number | null;
  customerId: number | null;
  kind: 'bill_receipt' | 'manual_reply' | 'auto_followup';
  userId: string | null;
}

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
  lastSendByPhone: new Map(),
  recentBodies: new Map(),
  sentMessageCache: new Map(),
  lidToPhoneMap: new Map(),
};

function getAuthDir(): string {
  return path.join(app.getPath('userData'), AUTH_DIR_NAME);
}

function writeSetting(key: string, value: string): void {
  getDatabase().prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now());
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

/**
 * Resolve a user-supplied phone number to the JID WhatsApp actually uses for
 * it. Two-stage validation: libphonenumber-js normalizes the format (no
 * country-specific code — handles AR `9`, BR `0`, MX `1`, etc. via Google's
 * metadata), then socket.onWhatsApp() asks WhatsApp's own registry and
 * returns the canonical JID (which may be a LID or a different form than
 * the naive phone-JID). Only WhatsApp's server knows whether the number is
 * registered and which JID format it accepts.
 *
 * Returns null when the number is either unparseable or not on WhatsApp —
 * caller maps both to the `not_on_whatsapp` SendResult reason. Falls back
 * to the naive phone-JID if onWhatsApp throws (network blip); better to
 * attempt the send than block the cashier behind a transient error.
 */
async function resolveJid(phoneE164: string, sock: BaileysSocket): Promise<string | null> {
  let normalized: string;
  try {
    const pn = parsePhoneNumber(phoneE164);
    if (!pn?.isValid()) return null;
    normalized = pn.number;
  } catch {
    return null;
  }
  const naive = `${normalized.replace('+', '')}@s.whatsapp.net`;
  try {
    const results = (await sock.onWhatsApp(naive)) ?? [];
    return results[0]?.exists ? results[0].jid : null;
  } catch {
    return naive;
  }
}

/** Strip the device id and domain from a Baileys JID, leaving just the user. */
function userFromJid(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

/**
 * Resolve a Baileys JID (which may carry `@lid` instead of `@s.whatsapp.net`
 * under WhatsApp's new Local ID system) back to a phone JID. Tries in order:
 *   1. local cache (populated by inbound messages + lid-mapping.update events)
 *   2. the alt JID Baileys v7 attaches to every message
 *   3. signalRepository.lidMapping.getPNForLID (whatsapp's own resolver)
 * Falls back to the original JID if nothing resolves — better to record an
 * LID than to drop the message.
 */
async function translateJid(jid: string, altJid: string | undefined, sock: BaileysSocket): Promise<string> {
  if (!jid.endsWith('@lid')) return jid;
  const lidUser = userFromJid(jid);
  const cached = state.lidToPhoneMap.get(lidUser);
  if (cached) return cached;
  if (altJid && !altJid.endsWith('@lid')) {
    const phoneJid = altJid.includes('@') ? altJid : `${altJid}@s.whatsapp.net`;
    state.lidToPhoneMap.set(lidUser, phoneJid);
    return phoneJid;
  }
  try {
    const pn: string | null = await sock.signalRepository.lidMapping.getPNForLID(jid);
    if (pn) {
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
  const perHundred = Math.ceil(body.length / 100);
  const lower = TYPING_MIN_MS * perHundred;
  const upper = TYPING_MAX_PER_100_CHARS_MS * perHundred;
  return lower + Math.floor(Math.random() * (upper - lower));
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
  if (fresh.length > RECENT_BODIES_PER_PHONE_MAX) fresh.splice(0, fresh.length - RECENT_BODIES_PER_PHONE_MAX);
  state.recentBodies.set(phoneE164, fresh);
  return false;
}

function isBlocked(phoneE164: string): boolean {
  const row = getDatabase()
    .prepare('SELECT 1 FROM whatsapp_blocklist WHERE phone_e164 = ?')
    .get(phoneE164);
  return !!row;
}

function isOverRateLimit(phoneE164: string): { limited: boolean; retryAfterMs?: number } {
  const last = state.lastSendByPhone.get(phoneE164);
  if (last) {
    const gap = Date.now() - last;
    if (gap < RATE_LIMIT_MIN_GAP_MS) {
      return { limited: true, retryAfterMs: RATE_LIMIT_MIN_GAP_MS - gap };
    }
  }
  const db = getDatabase();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM whatsapp_messages
    WHERE phone_e164 = ? AND direction = 'outbound' AND queued_at >= ?
  `).get(phoneE164, oneHourAgo) as { c: number };
  if (row.c >= RATE_LIMIT_MAX_PER_HOUR) {
    return { limited: true };
  }
  return { limited: false };
}

function isInCooldown(): boolean {
  if (!state.cooldownUntil) return false;
  return new Date(state.cooldownUntil).getTime() > Date.now();
}

function triggerCooldown(reason: string, durationMs = 5 * 60 * 1000, reasonCode: string = 'cooldown'): void {
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
  customer_id?: number | null;
  created_by_user_id?: string | null;
  timestamp_field?: 'seen_at' | 'typing_at' | 'sent_at' | 'delivered_at' | 'read_at' | 'failed_at';
  external_id?: string;
}): number {
  const db = getDatabase();
  const tsField = row.timestamp_field;
  const baseTs = now();
  const result = db.prepare(`
    INSERT INTO whatsapp_messages (
      bill_id, customer_id, phone_e164, direction, kind, status,
      body, external_message_id, error, queued_at,
      seen_at, typing_at, sent_at, delivered_at, read_at, failed_at,
      created_by_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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

function updateMessageRow(id: number, patch: {
  status?: string;
  external_message_id?: string | null;
  error?: string | null;
  timestamp_field?: 'seen_at' | 'typing_at' | 'sent_at' | 'delivered_at' | 'read_at' | 'failed_at';
}): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: any[] = [];
  if (patch.status !== undefined) { fields.push('status = ?'); values.push(patch.status); }
  if (patch.external_message_id !== undefined) { fields.push('external_message_id = ?'); values.push(patch.external_message_id); }
  if (patch.error !== undefined) { fields.push('error = ?'); values.push(patch.error); }
  if (patch.timestamp_field) {
    fields.push(`${patch.timestamp_field} = ?`);
    values.push(now());
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE whatsapp_messages SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Advance a message's status and backfill any earlier-stage timestamps that
 * haven't fired yet (Baileys sometimes jumps straight to status=3 or 4
 * without an intermediate update). Without the COALESCE guard, a row ends up
 * with status='read' but only read_at populated — the stepper shows the row
 * at the end of the pipeline while the timeline shows a single
 * timestamp, which is what the operator sees as "the status didn't reach
 * the end".
 */
function advanceStatus(id: number, latest: 'sent' | 'delivered' | 'read'): void {
  const ts = now();
  const stamps = new Set<string>([latest]);
  if (latest === 'read') { stamps.add('delivered'); stamps.add('sent'); }
  else if (latest === 'delivered') { stamps.add('sent'); }
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

async function persistIncoming(msg: any, sock: BaileysSocket): Promise<void> {
  if (!msg?.message) return;
  const rawJid: string = msg.key?.remoteJid ?? '';
  if (!rawJid || rawJid === 'status@broadcast') return;
  // Resolve LID → phone JID. Group chats intentionally keep their @g.us JID
  // (not translated) because the group sender-key distribution depends on it,
  // but DMs/contacts come in carrying @lid from WhatsApp's new ID system.
  const resolvedJid = rawJid.endsWith('@g.us')
    ? rawJid
    : await translateJid(rawJid, msg.key?.remoteJidAlt, sock);
  const phone = '+' + userFromJid(resolvedJid);
  const body =
    msg.message?.conversation ??
    msg.message?.extendedTextMessage?.text ??
    msg.message?.imageMessage?.caption ??
    msg.message?.videoMessage?.caption ??
    '';
  if (!body) return;
  recordMessageRow({
    phone_e164: phone,
    direction: 'inbound',
    kind: 'manual_reply',
    status: 'delivered',
    body,
    external_message_id: msg.key?.id ?? null,
    created_by_user_id: null,
  });
}

function attachSocketHandlers(socket: BaileysSocket): void {
  socket.ev.on('connection.update', async (update: any) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      state.lastQr = qr;
      state.lastPairingCode = null;
      state.state = 'waiting_qr';
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
    } else if (connection === 'close') {
      const status = (lastDisconnect?.error as any)?.output?.statusCode as number | undefined;
      state.socket = null;
      state.lastQr = null;
      state.lastPairingCode = null;
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
        wipeAuthDir();
      } else if (!state.shuttingDown && state.enabled) {
        // Auto-reconnect on any transient failure (network blip, server
        // restart, etc). Don't penalize the operator for an infrastructure
        // blip — the cooldown only applies to explicit 429s on sends.
        state.state = 'connecting';
        state.lastError = `Connection closed (${status ?? 'unknown'}), reconnecting in ${RECONNECT_DELAY_MS / 1000}s…`;
        state.lastErrorReason = 'reconnecting';
        if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(() => {
          state.reconnectTimer = null;
          if (state.enabled && !state.shuttingDown) {
            void startSocket().catch((err) => {
              console.warn('[WhatsApp] Reconnect failed:', err?.message ?? err);
            });
          }
        }, RECONNECT_DELAY_MS);
      } else {
        state.state = 'disconnected';
      }
    }
  });

  socket.ev.on('creds.update', () => {});

  // Keep the LID→phone cache fresh. WhatsApp rotates these over time.
  socket.ev.on('lid-mapping.update', (update: any) => {
    const lid = update?.lid as string | undefined;
    const pn = update?.pn as string | undefined;
    if (!lid || !pn) return;
    const lidUser = userFromJid(lid);
    const phoneJid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
    state.lidToPhoneMap.set(lidUser, phoneJid);
  });

  socket.ev.on('messages.upsert', async ({ messages }: { messages: any[] }) => {
    const filterGroups = getSettingValue('whatsapp_filter_groups') === 'true';
    for (const msg of messages) {
      if (msg.key?.fromMe) continue;
      // No one asks Flo to deliver a paid bill into a group chat. When the
      // operator enables the group filter, drop inbound @g.us messages
      // before we persist them — the inbox stays clean and we never
      // process (translateJid / store) what we don't intend to handle.
      if (filterGroups && msg.key?.remoteJid?.endsWith('@g.us')) continue;
      await persistIncoming(msg, socket);
    }
  });

  socket.ev.on('messages.update', async (updates: any[]) => {
    for (const u of updates) {
      const id = u.key?.id;
      if (!id) continue;
      const stored = findMessageByExternalId(id);
      if (!stored) continue;
      const status = u.update?.status;
      if (status === undefined) continue;
      let field: 'sent_at' | 'delivered_at' | 'read_at' | null = null;
      // Baileys WAProto: PENDING=1, SERVER_ACK=2, DELIVERED=3, READ=4, PLAYED=5.
      // SERVER_ACK is the first server-side confirmation that WhatsApp
      // accepted the payload — that's the truthful 'sent' mark. Earlier
      // versions mapped 1→sent which silently promoted rows to 'delivered'
      // on the real confirmation and never marked anything 'sent' at all.
      if (status === 2) advanceStatus(stored.id, 'sent');
      else if (status === 3) advanceStatus(stored.id, 'delivered');
      else if (status === 4) advanceStatus(stored.id, 'read');
    }
  });
}

async function resolveWaWebVersion(): Promise<[number, number, number] | undefined> {
  // Baileys' built-in fetchLatestWaWebVersion scrapes sw.js which is
  // aggressively rate-limited (429). When it fails, Baileys falls back to
  // a hardcoded version that goes stale within weeks — WhatsApp rejects
  // connections with an expired buildHash (405 at Noise layer). Try the
  // wppconnect version tracker first (more reliable, but HTML scrape — no
  // JSON API), then Baileys as a fallback.
  try {
    const res = await fetch('https://wppconnect.io/whatsapp-versions/', {
      signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS),
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
    const { fetchLatestWaWebVersion } = await loadBaileys();
    const { version } = await fetchLatestWaWebVersion({});
    return version as [number, number, number];
  } catch {
    // fall through
  }
  // Let Baileys use its hardcoded fallback. Better than refusing to start.
  return undefined;
}

async function startSocket(): Promise<void> {
  if (!state.enabled) return;
  if (state.socket) return;
  const authDir = getAuthDir();
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  }
  const version = await resolveWaWebVersion();
  const { useMultiFileAuthState, makeWASocket, Browsers, proto } = await loadBaileys();
  const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
  const socket = makeWASocket({
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
      // Returning an empty message prevents Baileys from hanging on
      // "waiting for this message" when WhatsApp asks to re-encrypt a
      // message we've already sent (common around session restarts).
      return proto.Message.create({});
    },
  });
  attachSocketHandlers(socket);
  socket.ev.on('creds.update', saveCreds);
  state.socket = socket;
  state.state = 'connecting';
}

function wipeAuthDir(): void {
  try {
    fs.rmSync(getAuthDir(), { recursive: true, force: true });
  } catch (err) {
    console.warn('[WhatsApp] Failed to wipe auth dir:', err);
  }
}

export async function enable(userId: string): Promise<{ ok: boolean; error?: string }> {
  state.enabled = true;
  // Reset shutdown flag so the auto-reconnect-on-disconnect logic in the
  // close handler is active again after a previous disable() round.
  state.shuttingDown = false;
  writeSetting('whatsapp_enabled', 'true');
  writeSetting('whatsapp_activated_by_user_id', userId);
  writeSetting('whatsapp_activated_at', now());
  writeSetting('whatsapp_disclosure_version_acknowledged', '1');
  state.lastError = null;
  state.lastErrorReason = null;
  // Restore from creds.json if present — re-pairing while creds are still
  // valid is a WhatsApp ban risk. 401 from the server falls through to the
  // QR flow as usual.
  const credsPath = path.join(getAuthDir(), 'creds.json');
  if (fs.existsSync(credsPath)) {
    void startSocket().catch((err) => {
      console.warn('[WhatsApp] Auto-restore on enable failed:', err?.message ?? err);
    });
  }
  return { ok: true };
}

export function disable(): void {
  state.enabled = false;
  state.shuttingDown = true;
  writeSetting('whatsapp_enabled', 'false');
  writeSetting('whatsapp_connected_phone', '');
  if (state.socket) {
    try { state.socket.end(undefined); } catch { /* ignore */ }
    state.socket = null;
  }
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  state.state = 'disconnected';
  state.connectedPhone = null;
  state.lastQr = null;
  state.lastPairingCode = null;
  state.lastError = null;
  state.lastErrorReason = null;
  state.cooldownUntil = null;
  if (state.cooldownTimer) { clearTimeout(state.cooldownTimer); state.cooldownTimer = null; }
  wipeAuthDir();
}

export async function connectWithQr(): Promise<{ ok: boolean; qr?: string; error?: string }> {
  if (!state.enabled) return { ok: false, error: 'WhatsApp is not enabled.' };
  state.lastQr = null;
  state.lastPairingCode = null;
  await startSocket();
  // QR arrives asynchronously via connection.update
  return { ok: true };
}

export async function connectWithPairingCode(phone: string): Promise<{ ok: boolean; code?: string; error?: string }> {
  if (!state.enabled) return { ok: false, error: 'WhatsApp is not enabled.' };
  if (!state.socket) {
    await startSocket();
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!state.socket) return { ok: false, error: 'Socket not ready, try again.' };
  try {
    const code = await state.socket.requestPairingCode(phone.replace(/\D/g, ''));
    state.lastPairingCode = code;
    state.state = 'waiting_pairing';
    return { ok: true, code };
  } catch (err: any) {
    return { ok: false, error: err.message ?? 'Failed to request pairing code.' };
  }
}

export function disconnect(): void {
  // Match disable(): setting shuttingDown before ending the socket makes the
  // close handler take the disconnected branch instead of scheduling a
  // reconnect. Without this, every logout re-pops a pairing QR 5s later.
  state.shuttingDown = true;
  if (state.socket) {
    try { state.socket.logout(); } catch { /* ignore */ }
    try { state.socket.end(undefined); } catch { /* ignore */ }
    state.socket = null;
  }
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  state.state = 'disconnected';
  state.connectedPhone = null;
  state.lastQr = null;
  state.lastPairingCode = null;
  state.lastError = null;
  state.lastErrorReason = null;
  writeSetting('whatsapp_connected_phone', '');
  wipeAuthDir();
}

export interface SendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
  reason?:
    | 'feature_off'
    | 'no_phone'
    | 'blocked'
    | 'rate_limited'
    | 'cooldown'
    | 'not_connected'
    | 'not_on_whatsapp'
    | 'content_blocked'
    | 'send_failed';
}

export async function sendMessage(req: QueuedSend): Promise<SendResult> {
  if (!state.enabled) return { ok: false, error: 'WhatsApp is not enabled.', reason: 'feature_off' };
  if (!req.phoneE164) return { ok: false, error: 'Phone number required.', reason: 'no_phone' };
  if (state.state !== 'connected' || !state.socket) {
    return { ok: false, error: 'Flo is not connected to WhatsApp.', reason: 'not_connected' };
  }
  const socket = state.socket;
  const jid = await resolveJid(req.phoneE164, socket);
  if (!jid) {
    return { ok: false, error: 'This phone is not registered on WhatsApp.', reason: 'not_on_whatsapp' };
  }
  if (isInCooldown()) {
    return { ok: false, error: 'Send is temporarily paused.', reason: 'cooldown' };
  }
  if (isBlocked(req.phoneE164)) {
    return { ok: false, error: 'This number asked to stop receiving messages.', reason: 'blocked' };
  }
  const rate = isOverRateLimit(req.phoneE164);
  if (rate.limited) {
    return { ok: false, error: 'Rate limit reached for this number.', reason: 'rate_limited' };
  }
  const contentErr = hasShortenerOrNonHttps(req.body);
  if (contentErr) {
    return { ok: false, error: contentErr, reason: 'content_blocked' };
  }
  if (isDuplicateBody(req.phoneE164, req.body)) {
    return { ok: false, error: 'Identical message sent to this number recently.', reason: 'content_blocked' };
  }

  const db = getDatabase();
  const bill = req.billId
    ? db.prepare(`
        SELECT b.*, o.customer_id AS order_customer_id
        FROM bills b
        LEFT JOIN orders o ON o.id = b.order_id
        WHERE b.id = ?
      `).get(req.billId) as any
    : null;
  if (bill && bill.payment_status !== 'paid') {
    return { ok: false, error: 'Bill is not paid.', reason: 'send_failed' };
  }
  let resolvedKind = req.kind;
  let resolvedCustomerId = req.customerId;
  if (bill) {
    if (bill.customer_id && String(bill.customer_id) === String(bill.order_customer_id)) {
      resolvedKind = 'bill_receipt';
      resolvedCustomerId = bill.customer_id;
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

  try {
    if (resolvedKind === 'manual_reply') {
      try {
        await socket.readMessages([{ remoteJid: jid, id: req.phoneE164 } as any]);
        updateMessageRow(messageId, { status: 'seen', timestamp_field: 'seen_at' });
      } catch { /* best-effort */ }
    }
    await socket.presenceSubscribe(jid).catch(() => {});
    await socket.sendPresenceUpdate('composing', jid).catch(() => {});
    updateMessageRow(messageId, { status: 'typing', timestamp_field: 'typing_at' });
    await new Promise((r) => setTimeout(r, randomDelayMs(req.body)));
    await socket.sendPresenceUpdate('paused', jid).catch(() => {});
    const sent = await socket.sendMessage(jid, { text: req.body });
    // sendMessage() only resolves when Baileys hands the payload to its
    // local queue — not when WhatsApp's servers ACK it. Don't claim 'sent'
    // yet; the messages.update handler sets status='sent' + sent_at when
    // the server returns status=2 (SERVER_ACK). Without this guard, a
    // silently-dropped message (bad JID, network blip, server reject)
    // would mark the row 'sent' while the recipient never receives it.
    updateMessageRow(messageId, {
      external_message_id: sent?.key?.id ?? null,
    });
    // Cache the message body so Baileys's getMessage() can serve re-encrypt
    // requests for it (common around session restarts). Without this,
    // Baileys hangs on "waiting for this message" indefinitely.
    if (sent?.key?.id && sent?.message) {
      state.sentMessageCache.set(sent.key.id, sent.message);
      if (state.sentMessageCache.size > SENT_MESSAGE_CACHE_MAX) {
        const oldest = state.sentMessageCache.keys().next().value!;
        state.sentMessageCache.delete(oldest);
      }
    }
    state.lastSendByPhone.set(req.phoneE164, Date.now());
    return { ok: true, messageId };
  } catch (err: any) {
    const status = err?.output?.statusCode;
    updateMessageRow(messageId, {
      status: 'failed',
      error: err?.message ?? 'Send failed',
      timestamp_field: 'failed_at',
    });
    const statusCode = (err as any)?.output?.statusCode;
    if (typeof statusCode === 'number' && RATE_LIMITED_STATUS_CODES.has(statusCode)) {
      triggerCooldown(`Send rate-limited by WhatsApp (${statusCode}). Cooling down for 5 minutes.`, 5 * 60 * 1000, 'rate_limited');
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
  return getDatabase().prepare(`
    SELECT id, phone_e164, body, status, queued_at
    FROM whatsapp_messages
    WHERE direction = 'inbound'
    ORDER BY queued_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as InboxMessage[];
}

export interface SentMessageRow {
  id: number;
  phone_e164: string;
  bill_id: number | null;
  customer_id: number | null;
  direction: 'inbound' | 'outbound';
  kind: 'bill_receipt' | 'manual_reply' | 'auto_followup';
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
}

export function listMessages(opts: {
  direction?: 'inbound' | 'outbound';
  status?: string;
  phone?: string;
  billId?: number;
  limit: number;
  offset: number;
}): SentMessageRow[] {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.direction) { where.push('direction = ?'); params.push(opts.direction); }
  if (opts.status) { where.push('status = ?'); params.push(opts.status); }
  if (opts.phone) { where.push('phone_e164 = ?'); params.push(opts.phone); }
  if (opts.billId) { where.push('bill_id = ?'); params.push(opts.billId); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(opts.limit, opts.offset);
  return getDatabase().prepare(`
    SELECT id, phone_e164, bill_id, customer_id, direction, kind, status,
           body, error, queued_at, seen_at, typing_at, sent_at,
           delivered_at, read_at, failed_at, created_by_user_id
    FROM whatsapp_messages
    ${whereSql}
    ORDER BY queued_at DESC
    LIMIT ? OFFSET ?
  `).all(...params) as SentMessageRow[];
}

export interface BlocklistRow {
  phone_e164: string;
  reason: string | null;
  blocked_at: string;
  blocked_by_user_id: string | null;
}

export function listBlocklist(): BlocklistRow[] {
  return getDatabase()
    .prepare('SELECT phone_e164, reason, blocked_at, blocked_by_user_id FROM whatsapp_blocklist ORDER BY blocked_at DESC')
    .all() as BlocklistRow[];
}

export function addToBlocklist(phoneE164: string, reason: string, userId: string): void {
  getDatabase().prepare(`
    INSERT INTO whatsapp_blocklist (phone_e164, reason, blocked_at, blocked_by_user_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(phone_e164) DO UPDATE SET reason = excluded.reason, blocked_at = excluded.blocked_at
  `).run(phoneE164, reason, now(), userId);
}

export function removeFromBlocklist(phoneE164: string): boolean {
  const result = getDatabase().prepare('DELETE FROM whatsapp_blocklist WHERE phone_e164 = ?').run(phoneE164);
  return result.changes > 0;
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
  const v = getDatabase().prepare("SELECT value FROM settings WHERE key = 'whatsapp_enabled'").get() as { value: string | null } | undefined;
  state.enabled = v?.value === 'true';
  if (state.enabled) {
    void startSocket().catch((err) => {
      console.warn('[WhatsApp] Startup failed:', err?.message ?? err);
    });
  }
}

export function shutdown(): void {
  state.shuttingDown = true;
  if (state.cooldownTimer) { clearTimeout(state.cooldownTimer); state.cooldownTimer = null; }
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  if (state.socket) {
    try { state.socket.end(undefined); } catch { /* ignore */ }
    state.socket = null;
  }
}

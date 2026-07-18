/**
 * Outbound-only cloud bridge for FloCafe POS.
 *
 * The POS never opens a public listener. It registers with Blue over HTTPS,
 * pushes local events to an outbox endpoint, and polls a signed command queue
 * for whitelisted read-only requests such as reports and live orders.
 */

import * as crypto from 'crypto';
import * as os from 'os';
import log from 'electron-log';
import { WebSocket, type RawData } from 'ws';
import { getDatabase, now, parseItemJson, ensureCloudIdentity } from '../db';

export const DEFAULT_CLOUD_SERVER_URL = 'https://blue.flopos.com/';

const HEARTBEAT_INTERVAL_MS = 5 * 60_000;
const OUTBOX_INTERVAL_MS = 15_000;
const COMMAND_POLL_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_COMMAND_RANGE_DAYS = 370;

// Live-relay channel (commands + heartbeat): WSS primary, HTTP poll/POST fallback.
// See specs/architecture.md § Realtime channel and specs/floadmin.md § WSS /api/pos/relay.
const RELAY_PING_INTERVAL_MS = 25_000;
const RELAY_RECONNECT_BASE_MS = 1_000;
const RELAY_RECONNECT_MAX_MS = 60_000;
const RELAY_FALLBACK_THRESHOLD = 5;

// Zero-touch registration (register -> pending -> claim). See specs/floadmin.md § Zero-touch registration & claim.
const STATUS_POLL_INTERVAL_MS = 5 * 60_000;
const AUTO_REGISTER_MAX_BACKOFF_MS = 30 * 60_000;

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
};

type CloudCommand = {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
};

type OutboxRow = {
  id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: string;
  attempt_count: number;
};

type DateRange = {
  from: string;
  to: string;
};

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmacHex(secret: string, value: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  return `****${value.slice(-4)}`;
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
  // Split off any query string before assigning to base.pathname — the URL API's pathname
  // setter percent-encodes "?" instead of treating it as a delimiter, so a literal
  // "/api/pos/commands?limit=5" passed straight through silently mangles the query.
  const [rawPath, rawQuery] = apiPath(pathname).split('?');
  const adjustedPath = basePath.endsWith('/api') && rawPath.startsWith('/api/')
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
  try { return JSON.parse(value); } catch { return value; }
}

class CloudSyncService {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private commandTimer: ReturnType<typeof setInterval> | null = null;
  private settings: CloudSettings | null = null;
  private flushing = false;
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

  // Zero-touch registration state.
  private statusPollTimer: ReturnType<typeof setInterval> | null = null;
  private autoRegisterTimer: ReturnType<typeof setTimeout> | null = null;
  private autoRegisterAttempts = 0;

  start() {
    ensureCloudIdentity();
    this.reload();
    // First-run zero-touch: if this install has never registered (and hasn't been
    // explicitly rejected), announce itself with no staff action required. Only
    // done once at boot, not on every reload(), so saving an unrelated cloud
    // setting doesn't re-trigger it.
    // this.maybeAutoRegister(); // [Bankim] Re-enable this to restore zero-touch registration at boot
  }

  reload() {
    this.stop();
    const cfg = this.loadSettings();
    this.settings = cfg;
    if (!cfg) return;

    if (cfg.sync_enabled && cfg.api_key) {
      void this.flushOutbox();
      this.outboxTimer = setInterval(() => void this.flushOutbox(), OUTBOX_INTERVAL_MS);
    }

    this.maybeStartRelay();
    this.maybeStartStatusPoll();

    log.info('[CloudSync] started', {
      server: cfg.server_url,
      sync: cfg.sync_enabled,
      commands: cfg.command_polling_enabled,
      registered: Boolean(cfg.api_key),
    });
  }

  stop() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.outboxTimer) { clearInterval(this.outboxTimer); this.outboxTimer = null; }
    if (this.commandTimer) { clearInterval(this.commandTimer); this.commandTimer = null; }
    if (this.statusPollTimer) { clearInterval(this.statusPollTimer); this.statusPollTimer = null; }
    if (this.autoRegisterTimer) { clearTimeout(this.autoRegisterTimer); this.autoRegisterTimer = null; }
    this.httpFallbackActive = false;
    this.teardownRelay();
  }

  private teardownRelay() {
    if (this.relayReconnectTimer) { clearTimeout(this.relayReconnectTimer); this.relayReconnectTimer = null; }
    if (this.relayPingTimer) { clearInterval(this.relayPingTimer); this.relayPingTimer = null; }
    if (this.relayHeartbeatFrameTimer) { clearInterval(this.relayHeartbeatFrameTimer); this.relayHeartbeatFrameTimer = null; }
    if (this.relaySocket) {
      const socket = this.relaySocket;
      this.relaySocket = null;
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    }
    this.relayReconnectAttempts = 0;
    this.relayMode = 'disconnected';
  }

  getStatus() {
    const db = getDatabase();
    const s = this.readSettings(db);
    ensureCloudIdentity();
    const refreshed = this.readSettings(db);
    return {
      cloud_server_url: refreshed.cloud_server_url || DEFAULT_CLOUD_SERVER_URL,
      cloud_pos_hash: refreshed.cloud_pos_hash || null,
      cloud_pos_id: refreshed.cloud_pos_id || null,
      cloud_store_id: refreshed.cloud_store_id || null,
      cloud_pending_store_id: refreshed.cloud_pending_store_id || null,
      cloud_api_key: maskSecret(refreshed.cloud_api_key),
      cloud_sync_enabled: refreshed.cloud_sync_enabled === '1',
      cloud_orders_enabled: refreshed.cloud_orders_enabled === '1',
      cloud_reports_enabled: refreshed.cloud_reports_enabled === '1',
      cloud_command_polling_enabled: refreshed.cloud_command_polling_enabled === '1',
      cloud_registration_status: refreshed.cloud_registration_status || 'unregistered',
      cloud_connected: refreshed.cloud_connected === 'true',
      cloud_last_sync: refreshed.cloud_last_sync || null,
      cloud_last_heartbeat: refreshed.cloud_last_heartbeat || null,
      cloud_last_error: refreshed.cloud_last_error || null,
      cloud_relay_mode: this.relayMode,
      outbox_pending: this.countOutbox('pending'),
      outbox_failed: this.countOutbox('failed'),
      loaded: Boolean(s),
    };
  }

  async register(email?: string): Promise<Record<string, unknown>> {
    const db = getDatabase();
    const settings = this.readSettings(db);
    const { posHash, deviceSecret } = ensureCloudIdentity();
    const serverUrl = normalizeCloudServerUrl(settings.cloud_server_url || DEFAULT_CLOUD_SERVER_URL);
    const body = {
      pos_hash: posHash,
      device_secret_hash: sha256Hex(deviceSecret),
      device_name: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      app_version: require('../../package.json').version,
      store_type: 'cafe',
      business: {
        name: settings.business_name || '',
        phone: settings.business_phone || settings.phone || '',
        email: email || settings.email || '',
        country: settings.country || 'IN',
        timezone: settings.timezone || 'Asia/Kolkata',
      },
      requested_at: new Date().toISOString(),
    };

    try {
      const res = await fetch(endpoint(serverUrl, '/api/pos/register'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Flo-POS-Hash': posHash,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(String(data.error || `Registration failed (${res.status})`));
      }

      // Zero-touch target shape: no api_key yet, just an unclaimed pending row —
      // poll GET /api/pos/status until a human claims (or rejects) it.
      if (data.status === 'pending') {
        this.upsertSettings({
          cloud_server_url: serverUrl,
          cloud_pending_store_id: typeof data.pending_store_id === 'string' ? data.pending_store_id : '',
          cloud_registration_status: 'pending',
          cloud_connected: 'false',
          cloud_last_error: '',
        });
        this.reload();
        return this.getStatus();
      }

      const apiKey = typeof data.api_key === 'string' ? data.api_key : settings.cloud_api_key;
      if (!apiKey) throw new Error('Registration response did not include api_key');

      this.upsertSettings({
        cloud_server_url: serverUrl,
        cloud_api_key: apiKey,
        cloud_pos_id: typeof data.pos_id === 'string' ? data.pos_id : settings.cloud_pos_id,
        cloud_store_id: typeof data.store_id === 'string' ? data.store_id : settings.cloud_store_id,
        cloud_pending_store_id: '',
        cloud_registration_status: 'registered',
        cloud_connected: 'true',
        cloud_last_error: '',
        cloud_last_heartbeat: new Date().toISOString(),
      });
      this.reload();
      return this.getStatus();
    } catch (err) {
      const message = (err as Error).message;
      this.upsertSettings({
        cloud_registration_status: 'registration_failed',
        cloud_connected: 'false',
        cloud_last_error: message,
      });
      throw err;
    }
  }

  async testConnection(): Promise<Record<string, unknown>> {
    const res = await this.signedFetch('/api/pos/connection-test', { method: 'POST', body: '{}' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Cloud test failed (${res.status})`);
    this.upsertSettings({
      cloud_connected: 'true',
      cloud_last_error: '',
      cloud_last_heartbeat: new Date().toISOString(),
    });
    return { ok: true, data, status: this.getStatus() };
  }

  pushBill(bill: Record<string, unknown>) {
    this.enqueueEvent('bill.paid', 'bill', String(bill.id ?? bill.pos_bill_id ?? ''), bill);
  }

  recordBillPaid(billId: number | string) {
    try {
      const snapshot = this.buildBillSnapshot(billId);
      if (snapshot) this.enqueueEvent('bill.paid', 'bill', String(billId), snapshot);
    } catch (err) {
      log.warn('[CloudSync] bill snapshot failed', (err as Error).message);
    }
  }

  recordOrderChanged(orderId: number | string, eventType = 'order.updated') {
    try {
      const snapshot = this.buildOrderSnapshot(orderId);
      if (snapshot) this.enqueueEvent(eventType, 'order', String(orderId), snapshot);
    } catch (err) {
      log.warn('[CloudSync] order snapshot failed', (err as Error).message);
    }
  }

  sendOrderStatus(orderflowOrderId: string, status: string, note?: string) {
    this.enqueueEvent('order.status', 'order', orderflowOrderId, { orderflow_order_id: orderflowOrderId, status, note });
  }

  private buildHeartbeatPayload(cfg: CloudSettings) {
    const db = getDatabase();
    const activeOrders = db.prepare(`
      SELECT COUNT(*) as count FROM orders
      WHERE status IN ('pending', 'preparing', 'ready', 'served')
    `).get() as { count: number };
    const todaySales = db.prepare(`
      SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count
      FROM bills
      WHERE payment_status = 'paid' AND date(paid_at) = date('now')
    `).get() as { total: number; count: number };
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
    const cfg = this.settings;
    if (!cfg?.sync_enabled || !cfg.api_key) return;
    try {
      const body = this.buildHeartbeatPayload(cfg);
      const res = await this.signedFetch('/api/pos/heartbeat', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`heartbeat failed (${res.status})`);
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      this.upsertSettings({
        cloud_connected: 'true',
        cloud_last_error: '',
        cloud_last_heartbeat: new Date().toISOString(),
      });
      this.applyFeatures(data.features);
    } catch (err) {
      this.markError((err as Error).message);
    }
  }

  /** Primary path — heartbeat carried as a frame on the open relay connection. */
  private async sendRelayHeartbeat() {
    const cfg = this.settings;
    if (!cfg?.sync_enabled || !cfg.api_key || this.relaySocket?.readyState !== WebSocket.OPEN) return;
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
  }

  private enqueueEvent(eventType: string, entityType: string, entityId: string, payload: unknown) {
    const cfg = this.loadSettings();
    if (!cfg?.sync_enabled) return;
    const db = getDatabase();
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO cloud_sync_outbox
        (id, event_type, entity_type, entity_id, payload, status, attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(id, eventType, entityType, entityId || null, JSON.stringify(payload), now(), now());
    void this.flushOutbox();
  }

  private async flushOutbox() {
    const cfg = this.settings ?? this.loadSettings();
    if (!cfg?.sync_enabled || !cfg.api_key || this.flushing) return;
    this.flushing = true;
    try {
      const db = getDatabase();
      const rows = db.prepare(`
        SELECT * FROM cloud_sync_outbox
        WHERE status IN ('pending', 'failed')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at ASC
        LIMIT 50
      `).all(now()) as OutboxRow[];
      if (rows.length === 0) return;

      const events = rows.map((row) => ({
        id: row.id,
        type: row.event_type,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        payload: safeJsonParse(row.payload),
      }));

      db.prepare(`
        UPDATE cloud_sync_outbox SET status = 'sending', updated_at = ? WHERE id = ?
      `);

      for (const row of rows) {
        db.prepare(`UPDATE cloud_sync_outbox SET status = 'sending', updated_at = ? WHERE id = ?`).run(now(), row.id);
      }

      const res = await this.signedFetch('/api/pos/events', {
        method: 'POST',
        body: JSON.stringify({
          pos_hash: cfg.pos_hash,
          events,
          sent_at: new Date().toISOString(),
        }),
      });
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
      this.failSendingRows((err as Error).message);
    } finally {
      this.flushing = false;
    }
  }

  private failSendingRows(message: string) {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT id, attempt_count FROM cloud_sync_outbox WHERE status = 'sending'
    `).all() as { id: string; attempt_count: number }[];
    const stmt = db.prepare(`
      UPDATE cloud_sync_outbox
      SET status = 'failed', attempt_count = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `);
    for (const row of rows) {
      const attempts = row.attempt_count + 1;
      const delayMs = Math.min(30 * 60_000, Math.pow(2, Math.min(attempts, 8)) * 1000);
      stmt.run(attempts, new Date(Date.now() + delayMs).toISOString(), message, now(), row.id);
    }
    this.markError(message);
  }

  private async pollCommands() {
    const cfg = this.settings;
    if (!cfg?.command_polling_enabled || !cfg.api_key || this.pollingCommands) return;
    this.pollingCommands = true;
    try {
      const res = await this.signedFetch('/api/pos/commands?limit=5', { method: 'GET' });
      if (!res.ok) throw new Error(`command poll failed (${res.status})`);
      const data = await res.json().catch(() => ({})) as { commands?: CloudCommand[] };
      const commands = Array.isArray(data.commands) ? data.commands : [];
      for (const command of commands) {
        await this.executeCommand(command);
      }
    } catch (err) {
      this.markError((err as Error).message);
    } finally {
      this.pollingCommands = false;
    }
  }

  private async executeCommand(command: CloudCommand) {
    let body: Record<string, unknown>;
    try {
      const result = this.runCommand(command);
      body = { ok: true, result, completed_at: new Date().toISOString() };
    } catch (err) {
      body = { ok: false, error: (err as Error).message, completed_at: new Date().toISOString() };
    }

    const res = await this.signedFetch(`/api/pos/commands/${encodeURIComponent(command.id)}/result`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`command result failed (${res.status})`);
  }

  /** Same as executeCommand, but for a command pushed over the relay socket — result goes back as a frame, not a POST. */
  private async executeRelayCommand(command: CloudCommand) {
    let body: Record<string, unknown>;
    try {
      const result = this.runCommand(command);
      body = { ok: true, result, completed_at: new Date().toISOString() };
    } catch (err) {
      body = { ok: false, error: (err as Error).message, completed_at: new Date().toISOString() };
    }
    if (this.relaySocket?.readyState === WebSocket.OPEN) {
      this.relaySocket.send(JSON.stringify({ type: 'result', id: command.id, ...body }));
    }
  }

  // --- Zero-touch registration: pending status poll + first-run auto-register --------------

  private maybeStartStatusPoll() {
    const db = getDatabase();
    const status = this.readSettings(db).cloud_registration_status;
    if (status !== 'pending') return;
    void this.pollStatus();
    this.statusPollTimer = setInterval(() => void this.pollStatus(), STATUS_POLL_INTERVAL_MS);
  }

  /** GET /api/pos/status — unsigned, proof-of-possession via device_secret_hash. Polled while pending. */
  private async pollStatus() {
    const db = getDatabase();
    const s = this.readSettings(db);
    if (s.cloud_registration_status !== 'pending' || !s.cloud_pos_hash) return;
    try {
      const serverUrl = normalizeCloudServerUrl(s.cloud_server_url || DEFAULT_CLOUD_SERVER_URL);
      const { posHash, deviceSecret } = ensureCloudIdentity();
      const url = endpoint(
        serverUrl,
        `/api/pos/status?install_uuid=${encodeURIComponent(posHash)}&device_secret_hash=${encodeURIComponent(sha256Hex(deviceSecret))}`
      );
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) return; // keep polling — could be a transient error, not a definitive answer

      if (data.status === 'claimed') {
        const apiKey = typeof data.api_key === 'string' ? data.api_key : '';
        if (!apiKey) return;
        this.upsertSettings({
          cloud_api_key: apiKey,
          cloud_store_id: typeof data.store_id === 'string' ? data.store_id : s.cloud_store_id,
          cloud_pending_store_id: '',
          cloud_registration_status: 'registered',
          cloud_connected: 'true',
          cloud_last_error: '',
          cloud_last_heartbeat: new Date().toISOString(),
        });
        this.applyFeatures(data.features);
        this.reload();
      } else if (data.status === 'rejected') {
        this.upsertSettings({ cloud_registration_status: 'rejected', cloud_connected: 'false' });
        this.reload();
      }
      // status === 'pending' -> no-op, timer keeps polling
    } catch (err) {
      log.warn('[CloudSync] status poll failed', (err as Error).message);
    }
  }

  /**
   * Zero-touch: register automatically if this install has never successfully
   * announced itself. Retries a prior failure too (network down at last boot) —
   * only a definitive 'pending' (already announced, use the status poll instead),
   * 'registered', or a human's explicit 'rejected' stop this from trying again.
   */
  private maybeAutoRegister() {
    const db = getDatabase();
    const settings = this.readSettings(db);
    if (settings.cloud_sync_enabled !== '1') return;
    const status = settings.cloud_registration_status || 'unregistered';
    if (status !== 'unregistered' && status !== 'registration_failed') return;
    this.attemptAutoRegister();
  }

  private attemptAutoRegister() {
    if (this.autoRegisterTimer) return; // a retry is already scheduled
    void this.register()
      .then(() => { this.autoRegisterAttempts = 0; })
      .catch(() => {
        const delay = Math.min(AUTO_REGISTER_MAX_BACKOFF_MS, 2 ** this.autoRegisterAttempts * 1000);
        this.autoRegisterAttempts++;
        this.autoRegisterTimer = setTimeout(() => {
          this.autoRegisterTimer = null;
          this.attemptAutoRegister();
        }, delay);
      });
  }

  // --- Live-relay connection (WSS primary, HTTP fallback) ---------------------------------

  private maybeStartRelay() {
    const cfg = this.settings;
    if (!cfg?.api_key || !(cfg.sync_enabled || cfg.command_polling_enabled)) {
      this.teardownRelay();
      this.stopHttpFallback();
      return;
    }
    this.connectRelay();
  }

  private connectRelay() {
    const cfg = this.settings;
    if (!cfg?.api_key || !(cfg.sync_enabled || cfg.command_polling_enabled)) return;
    if (this.relaySocket && (this.relaySocket.readyState === WebSocket.OPEN || this.relaySocket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    let socket: WebSocket;
    try {
      const url = relayEndpoint(cfg.server_url);
      const headers = this.buildSignedHeaders(cfg.api_key, cfg.pos_hash, 'GET', '/api/pos/relay', '');
      socket = new WebSocket(url, { headers, handshakeTimeout: REQUEST_TIMEOUT_MS });
    } catch (err) {
      log.warn('[CloudSync] relay connect failed', (err as Error).message);
      this.scheduleRelayReconnect();
      return;
    }

    this.relaySocket = socket;
    socket.on('open', () => this.onRelayOpen());
    socket.on('message', (data) => this.onRelayMessage(data));
    socket.on('pong', () => { this.relayAwaitingPong = false; });
    socket.on('close', () => this.onRelayClosed());
    socket.on('error', (err) => log.warn('[CloudSync] relay error', (err as Error).message));
  }

  private onRelayOpen() {
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
      void this.sendRelayHeartbeat();
      this.relayHeartbeatFrameTimer = setInterval(() => void this.sendRelayHeartbeat(), HEARTBEAT_INTERVAL_MS);
    }

    this.upsertSettings({
      cloud_connected: 'true',
      cloud_last_error: '',
      cloud_last_heartbeat: new Date().toISOString(),
    });
    log.info('[CloudSync] relay connected');
  }

  private onRelayMessage(data: RawData) {
    let frame: any;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (frame?.type === 'command' && frame.id && frame.cmd) {
      void this.executeRelayCommand({ id: frame.id, type: frame.cmd, payload: frame.payload });
    } else if (frame?.type === 'heartbeat_ack') {
      this.applyFeatures(frame.features);
    }
  }

  private onRelayClosed() {
    if (this.relayPingTimer) { clearInterval(this.relayPingTimer); this.relayPingTimer = null; }
    if (this.relayHeartbeatFrameTimer) { clearInterval(this.relayHeartbeatFrameTimer); this.relayHeartbeatFrameTimer = null; }
    this.relaySocket = null;
    this.relayMode = 'disconnected';
    this.markError('relay connection closed');
    this.scheduleRelayReconnect();
  }

  private scheduleRelayReconnect() {
    const cfg = this.settings;
    if (!cfg?.api_key || !(cfg.sync_enabled || cfg.command_polling_enabled)) return;

    this.relayReconnectAttempts += 1;
    if (this.relayReconnectAttempts >= RELAY_FALLBACK_THRESHOLD && !this.httpFallbackActive) {
      this.startHttpFallback();
    }

    const backoff = Math.min(RELAY_RECONNECT_MAX_MS, RELAY_RECONNECT_BASE_MS * 2 ** this.relayReconnectAttempts);
    const jitter = backoff * (0.8 + Math.random() * 0.4);
    if (this.relayReconnectTimer) clearTimeout(this.relayReconnectTimer);
    this.relayReconnectTimer = setTimeout(() => this.connectRelay(), jitter);
  }

  /** Degraded mode — same HTTP command-poll/heartbeat behavior the POS shipped with before the relay existed. */
  private startHttpFallback() {
    const cfg = this.settings;
    if (!cfg?.api_key || this.httpFallbackActive) return;
    this.httpFallbackActive = true;
    this.relayMode = 'http_fallback';

    if (cfg.sync_enabled && !this.heartbeatTimer) {
      void this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    }
    if (cfg.command_polling_enabled && !this.commandTimer) {
      void this.pollCommands();
      this.commandTimer = setInterval(() => void this.pollCommands(), COMMAND_POLL_INTERVAL_MS);
    }
    log.warn('[CloudSync] relay unavailable, falling back to HTTP polling');
  }

  private stopHttpFallback() {
    if (!this.httpFallbackActive) return;
    this.httpFallbackActive = false;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.commandTimer) { clearInterval(this.commandTimer); this.commandTimer = null; }
  }

  /**
   * Only reload when a flag actually *changes* — Blue may reasonably send `features` on every
   * heartbeat_ack (not just when something changed), and reloading unconditionally would tear
   * down and reopen the relay connection every heartbeat cycle, which itself immediately re-sends
   * a heartbeat and can spiral into a reconnect storm.
   */
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
    switch (command.type) {
      case 'health.get':
        return this.healthPayload();
      case 'orders.live':
        return this.liveOrders(command.payload);
      case 'orders.get':
        return this.getOrder(command.payload);
      case 'report.sales':
        return this.salesReport(command.payload);
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
    const rawStatuses = Array.isArray(payload?.statuses) ? payload?.statuses : ['pending', 'preparing', 'ready', 'served'];
    const statuses = rawStatuses
      .map((status) => String(status))
      .filter((status) => ['pending', 'preparing', 'ready', 'served'].includes(status));
    if (statuses.length === 0) return { orders: [] };

    const placeholders = statuses.map(() => '?').join(',');
    const orders = db.prepare(`
      SELECT * FROM orders
      WHERE status IN (${placeholders})
      ORDER BY created_at ASC
      LIMIT 200
    `).all(...statuses) as any[];

    return { orders: orders.map((order) => this.decorateOrder(order)) };
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
    const range = dateRange(payload);
    const totals = db.prepare(`
      SELECT
        COUNT(*) as bill_count,
        COALESCE(SUM(total), 0) as gross_sales,
        COALESCE(SUM(subtotal), 0) as subtotal,
        COALESCE(SUM(tax_amount), 0) as tax_amount,
        COALESCE(SUM(discount_amount), 0) as discount_amount,
        COALESCE(SUM(paid_amount), 0) as paid_amount
      FROM bills
      WHERE payment_status = 'paid'
        AND COALESCE(paid_at, created_at) >= ?
        AND COALESCE(paid_at, created_at) <= ?
    `).get(range.from, range.to);

    const byDay = db.prepare(`
      SELECT date(COALESCE(paid_at, created_at)) as date,
        COUNT(*) as bill_count,
        COALESCE(SUM(total), 0) as gross_sales
      FROM bills
      WHERE payment_status = 'paid'
        AND COALESCE(paid_at, created_at) >= ?
        AND COALESCE(paid_at, created_at) <= ?
      GROUP BY date(COALESCE(paid_at, created_at))
      ORDER BY date ASC
    `).all(range.from, range.to);

    const topItems = db.prepare(`
      SELECT oi.product_id, oi.product_name,
        COALESCE(SUM(oi.quantity), 0) as quantity,
        COALESCE(SUM(oi.total), 0) as total
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN bills b ON b.order_id = o.id
      WHERE b.payment_status = 'paid'
        AND COALESCE(b.paid_at, b.created_at) >= ?
        AND COALESCE(b.paid_at, b.created_at) <= ?
      GROUP BY oi.product_id, oi.product_name
      ORDER BY total DESC
      LIMIT 20
    `).all(range.from, range.to);

    return { range, totals, by_day: byDay, top_items: topItems };
  }

  private buildOrderSnapshot(orderId: number | string) {
    const db = getDatabase();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
    if (!order) return null;
    return this.decorateOrder(order);
  }

  private buildBillSnapshot(billId: number | string) {
    const db = getDatabase();
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as any;
    if (!bill) return null;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(bill.order_id) as any;
    const customer = bill.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(bill.customer_id) : null;
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(bill.order_id).map(parseItemJson);
    return {
      bill: {
        ...bill,
        payment_details: safeJsonParse(bill.payment_details),
      },
      order: order ? this.decorateOrder(order, items) : null,
      customer,
    };
  }

  private decorateOrder(order: any, itemsOverride?: any[]) {
    const db = getDatabase();
    const items = itemsOverride ?? db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id).map(parseItemJson);
    const tableRow = order.table_id ? db.prepare('SELECT * FROM tables WHERE id = ?').get(order.table_id) as any : null;
    const customer = order.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id) : null;
    const bill = db.prepare('SELECT * FROM bills WHERE order_id = ?').get(order.id) as any;
    return {
      ...order,
      items,
      table: tableRow ? { ...tableRow, name: tableRow.number } : null,
      customer,
      bill: bill ? { ...bill, payment_details: safeJsonParse(bill.payment_details) } : null,
    };
  }

  /** Shared HMAC signing used by every signed HTTP call and the relay WS handshake — see floadmin.md § Identity & request signing. */
  private buildSignedHeaders(apiKey: string, posHash: string, method: string, signedPath: string, body: string): Record<string, string> {
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomUUID();
    const bodyHash = sha256Hex(body);
    const signatureBase = [method.toUpperCase(), signedPath, timestamp, nonce, bodyHash].join('\n');
    const signature = hmacHex(apiKey, signatureBase);
    return {
      'Authorization': `Bearer ${apiKey}`,
      'X-Flo-POS-Hash': posHash,
      'X-Flo-Timestamp': timestamp,
      'X-Flo-Nonce': nonce,
      'X-Flo-Body-SHA256': bodyHash,
      'X-Flo-Signature': `sha256=${signature}`,
    };
  }

  private async signedFetch(pathname: string, init: RequestInit): Promise<Response> {
    const cfg = this.settings ?? this.loadSettings();
    if (!cfg?.api_key) throw new Error('Cloud POS is not registered');

    const method = (init.method || 'GET').toUpperCase();
    const url = endpoint(cfg.server_url, pathname);
    const body = typeof init.body === 'string' ? init.body : '';
    const signedPath = `${url.pathname}${url.search}`;
    const signedHeaders = this.buildSignedHeaders(cfg.api_key, cfg.pos_hash, method, signedPath, body);

    return fetch(url, {
      ...init,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...signedHeaders,
        ...(init.headers || {}),
      },
      body: method === 'GET' ? undefined : body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private loadSettings(): CloudSettings | null {
    try {
      const db = getDatabase();
      ensureCloudIdentity();
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
      };
    } catch (err) {
      log.warn('[CloudSync] settings unavailable', (err as Error).message);
      return null;
    }
  }

  private readSettings(db: ReturnType<typeof getDatabase>): Record<string, string> {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const s: Record<string, string> = {};
    for (const row of rows) s[row.key] = row.value;
    return s;
  }

  private upsertSettings(entries: Record<string, string | undefined | null>) {
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
      const row = getDatabase().prepare('SELECT COUNT(*) as count FROM cloud_sync_outbox WHERE status = ?')
        .get(status) as { count: number };
      return row.count;
    } catch {
      return 0;
    }
  }

  private markError(message: string) {
    this.upsertSettings({
      cloud_connected: 'false',
      cloud_last_error: message,
    });
    log.warn('[CloudSync]', message);
  }
}

export const cloudSync = new CloudSyncService();

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
import { getDatabase, now, parseItemJson, attachEffectiveAddons, ensureCloudIdentity, isDiagnosticsConsentEnabled, isDatabaseMaintenanceActive, registerDatabaseMaintenanceEndListener, registerDatabaseMaintenanceStartListener, utcDayBounds, utcTodayDate, withDatabaseRequest } from '../db';

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

// Zero-touch registration creates the live store immediately.
const AUTO_REGISTER_MAX_BACKOFF_MS = 30 * 60_000;
const CLOUD_DELETION_BLOCKING_STATUSES = new Set([
  'pending', 'processing', 'approved', 'completed', 'deleted', 'failed', 'unknown',
]);
const CLOUD_DELETION_KNOWN_STATUSES = new Set([
  'pending', 'processing', 'approved', 'completed', 'deleted', 'cancelled', 'rejected',
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
  const requestId = typeof data?.request_id === 'string' && data.request_id.trim()
    ? data.request_id.trim() : fallbackRequestId;
  const statusToken = typeof data?.status_token === 'string' && data.status_token.trim()
    ? data.status_token.trim() : fallbackStatusToken;
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
};

/**
 * Tier 2 store-attributed diagnostics (specs/floadmin.md § 6.2). No names,
 * phones, addresses, or order payloads belong in message/metadata — this is
 * "which typed error, on which store," not a log dump.
 */
export type DiagnosticEventInput = {
  event_id: string;
  event_code: string;
  severity: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  correlation_id?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  occurred_at: string;
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

function sanitizeOrderSnapshot(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const snapshot = value as Record<string, unknown>;
  const safe = { ...snapshot };
  delete safe.customer;
  delete safe.customer_id;
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

class CloudSyncService {
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
  private relayCommandPromises = new Set<Promise<unknown>>();
  private shutdownPromise: Promise<void> | null = null;
  private shutdownRequested = false;

  // Zero-touch registration state.
  private autoRegisterTimer: ReturnType<typeof setTimeout> | null = null;
  private autoRegisterAttempts = 0;
  private autoRegisterInFlight = false;
  private runtimeStarted = false;

  start() {
    if (this.cloudDeletionInProgress) return;
    this.shutdownRequested = false;
    this.shutdownPromise = null;
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
    const persisted = this.loadSettings(false);
    this.settings = persisted;
    if (!persisted || isCloudDeletionBlocking(persisted.cloud_deletion_status)) return;
    const cfg = this.loadSettings(true);
    this.settings = cfg;
    if (!cfg) return;

    if (cfg.sync_enabled && cfg.api_key) {
      this.runBackground(this.flushOutbox(), 'outbox flush');
      this.outboxTimer = setInterval(() => this.runBackground(this.flushOutbox(), 'outbox flush'), OUTBOX_INTERVAL_MS);
      this.runBackground(this.flushSupportTicketOutbox(), 'support outbox flush');
      this.supportOutboxTimer = setInterval(() => this.runBackground(this.flushSupportTicketOutbox(), 'support outbox flush'), OUTBOX_INTERVAL_MS);
      this.runBackground(this.flushDiagnosticsOutbox(), 'diagnostics outbox flush');
      this.diagnosticsOutboxTimer = setInterval(() => this.runBackground(this.flushDiagnosticsOutbox(), 'diagnostics outbox flush'), OUTBOX_INTERVAL_MS);
    }

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

  stop() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.outboxTimer) { clearInterval(this.outboxTimer); this.outboxTimer = null; }
    if (this.supportOutboxTimer) { clearInterval(this.supportOutboxTimer); this.supportOutboxTimer = null; }
    if (this.diagnosticsOutboxTimer) { clearInterval(this.diagnosticsOutboxTimer); this.diagnosticsOutboxTimer = null; }
    if (this.commandTimer) { clearInterval(this.commandTimer); this.commandTimer = null; }
    if (this.autoRegisterTimer) { clearTimeout(this.autoRegisterTimer); this.autoRegisterTimer = null; }
    this.httpFallbackActive = false;
    this.teardownRelay();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownRequested = true;
    this.runtimeStarted = false;
    this.stop();
    const activeFlushes = [this.outboxFlushPromise, this.supportFlushPromise, this.diagnosticsFlushPromise]
      .filter((promise): promise is Promise<void> => promise !== null);
    const activeRelayCommands = [...this.relayCommandPromises];
    this.shutdownPromise = Promise.allSettled([...activeFlushes, ...activeRelayCommands])
      .then(() => this.waitForCloudNetworkIdle())
      .then(() => undefined);
    return this.shutdownPromise;
  }

  private teardownRelay() {
    if (this.relayReconnectTimer) { clearTimeout(this.relayReconnectTimer); this.relayReconnectTimer = null; }
    if (this.relayPingTimer) { clearInterval(this.relayPingTimer); this.relayPingTimer = null; }
    if (this.relayHeartbeatFrameTimer) { clearInterval(this.relayHeartbeatFrameTimer); this.relayHeartbeatFrameTimer = null; }
    if (this.relaySocket) {
      const socket = this.relaySocket;
      this.relaySocket = null;
      socket.removeAllListeners();
      // Terminating a still-CONNECTING socket makes `ws` synchronously emit
      // 'error' ("closed before the connection was established"). The real
      // listeners were just removed above, so with nothing left to catch it
      // that throws and crashes the process — swallow it, we're intentionally
      // discarding this socket.
      socket.on('error', () => {});
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    }
    this.relayReconnectAttempts = 0;
    this.relayMode = 'disconnected';
  }

  /**
   * Email preferences are an optional cloud-account feature. Keep callers
   * from attempting an outbound request when this install has no usable
   * cloud account or the owner explicitly stopped cloud services.
   */
  isCloudAccountAvailable(): boolean {
    const settings = this.readSettings(getDatabase());
    return settings.cloud_registration_status === 'registered'
      && Boolean(settings.cloud_api_key)
      && settings.cloud_services_disabled_by_user !== 'true'
      && !isCloudDeletionBlocking(settings.cloud_deletion_status);
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
        ? (refreshed.cloud_registration_status === 'registration_failed'
          ? 'Cloud registration failed'
          : refreshed.cloud_deletion_status === 'failed'
            ? 'Cloud deletion request failed'
            : 'Cloud service request failed')
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
  async register(): Promise<Record<string, unknown>> {
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    return withDatabaseRequest(async () => {
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    const db = getDatabase();
    const settings = this.readSettings(db);
    if (isCloudDeletionBlocking(settings.cloud_deletion_status)) {
      throw new Error('Cloud deletion is pending; cancel it before registering again');
    }
    const { posHash, deviceSecret } = ensureCloudIdentity();
    const serverUrl = normalizeCloudServerUrl(settings.cloud_server_url || DEFAULT_CLOUD_SERVER_URL);
    const owner = db.prepare(
      "SELECT name FROM users WHERE role = 'owner' AND is_active = 1 ORDER BY created_at ASC LIMIT 1"
    ).get() as { name?: string } | undefined;
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
        contact_name: owner?.name || '',
        email: settings.email || '',
        phone: settings.business_phone || settings.phone || '',
        country: settings.country || 'IN',
        timezone: settings.timezone || 'Asia/Kolkata',
        currency: settings.currency || 'INR',
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
      if (!res.ok) {
        throw new Error(String(data.error || `Registration failed (${res.status})`));
      }

      const apiKey = typeof data.api_key === 'string' ? data.api_key : settings.cloud_api_key;
      if (!apiKey) throw new Error('Registration response did not include api_key');

      this.upsertSettings({
        cloud_server_url: serverUrl,
        cloud_api_key: apiKey,
        cloud_pos_id: typeof data.pos_id === 'string' ? data.pos_id : settings.cloud_pos_id,
        cloud_store_id: typeof data.store_id === 'string' ? data.store_id : settings.cloud_store_id,
        cloud_registration_status: 'registered',
        cloud_connected: 'true',
        cloud_last_error: '',
        cloud_deletion_status: '', cloud_deletion_outcome: '',
        cloud_last_heartbeat: new Date().toISOString(),
      });
      this.reload();
      if (settings.cloud_verification_welcome_requested !== '1') {
        try {
          await this.requestEmailVerification({
            product_updates: settings.email_product_updates === 'true',
            marketing: settings.email_marketing === 'true',
            source: 'signup',
          });
          this.upsertSettings({ cloud_verification_welcome_requested: '1' });
        } catch (emailError) {
          log.warn('[CloudSync] welcome email request failed (registration remains valid)', (emailError as Error).message);
        }
      }
      return this.getStatus();
    } catch (err) {
      const currentSettings = this.readSettings(getDatabase());
      if (!this.cloudDeletionInProgress && currentSettings.cloud_services_disabled_by_user !== 'true') {
        this.upsertSettings({
          cloud_registration_status: 'registration_failed',
          cloud_connected: 'false',
          cloud_last_error: 'Cloud registration failed',
        });
      }
      throw err;
    }
    });
  }

  async testConnection(): Promise<Record<string, unknown>> {
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    const res = await this.signedFetch('/api/pos/connection-test', { method: 'POST', body: '{}' });
    await res.json().catch(() => ({}));
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    if (!res.ok) throw new Error(`Cloud test failed (${res.status})`);
    this.upsertSettings({
      cloud_connected: 'true',
      cloud_last_error: '',
      cloud_last_heartbeat: new Date().toISOString(),
    });
    return { ok: true, status: this.getStatus() };
  }

  async getEmailPreferences(): Promise<Record<string, unknown>> {
    const res = await this.signedFetch('/api/pos/email-preferences', { method: 'GET' });
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    if (!res.ok) throw new Error(String(data.error || `Email status failed (${res.status})`));
    this.upsertSettings({
      cloud_email_verified: data.verified ? 'true' : 'false',
      cloud_email_verification_sent_at: typeof data.verification_sent_at === 'string' ? data.verification_sent_at : '',
      email_product_updates: data.product_updates ? 'true' : 'false',
      email_marketing: data.marketing ? 'true' : 'false',
    });
    return data;
  }

  async updateEmailPreferences(preferences: { product_updates?: boolean; marketing?: boolean }): Promise<Record<string, unknown>> {
    const res = await this.signedFetch('/api/pos/email-preferences', { method: 'PUT', body: JSON.stringify(preferences) });
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    if (!res.ok) throw new Error(String(data.error || `Preference update failed (${res.status})`));
    await this.getEmailPreferences();
    return data;
  }

  async requestEmailVerification(preferences: { product_updates?: boolean; marketing?: boolean; source?: string } = {}): Promise<Record<string, unknown>> {
    const res = await this.signedFetch('/api/pos/email/verification', { method: 'POST', body: JSON.stringify(preferences) });
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    if (!res.ok) throw new Error(String(data.error || `Verification request failed (${res.status})`));
    this.upsertSettings({
      cloud_email_verified: data.verified ? 'true' : 'false',
      cloud_email_verification_sent_at: typeof data.verification_sent_at === 'string' ? data.verification_sent_at : '',
    });
    return data;
  }

  async stopAllCloudServices(): Promise<Record<string, unknown>> {
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    await this.setDiagnosticsConsent(false);
    this.stop();
    this.upsertSettings({
      cloud_sync_enabled: '0', cloud_orders_enabled: '0', cloud_reports_enabled: '0',
      cloud_command_polling_enabled: '0', diagnostics_consent: 'false', telemetry_enabled: 'false',
      anonymous_data_consent: 'false', cloud_services_disabled_by_user: 'true', cloud_connected: 'false',
    });
    this.reload();
    return this.getStatus();
  }

  async deleteCloudData(): Promise<Record<string, unknown>> {
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion already in progress');
    const currentSettings = this.readSettings(getDatabase());
    if (isCloudDeletionBlocking(currentSettings.cloud_deletion_status)
      && currentSettings.cloud_deletion_status !== 'failed') {
      throw new Error('Cloud deletion is already pending; resolve or retry it before submitting another request');
    }
    this.cloudDeletionInProgress = true;
    let deletionOutcome: 'unknown' | 'rejected' = 'unknown';
    return withDatabaseRequest(async () => {
    const activeFlushes = [this.outboxFlushPromise, this.supportFlushPromise, this.diagnosticsFlushPromise].filter((promise): promise is Promise<void> => promise !== null);
    this.stop();
    if (activeFlushes.length > 0) await Promise.allSettled(activeFlushes);
    await this.waitForCloudNetworkIdle();
    const db = getDatabase();
    // Persist the disabled/pending intent before the remote purge. If the
    // process dies after the server accepts the request, restart cannot
    // resume syncing or auto-register with the old credentials.
    db.transaction(() => {
      db.prepare("DELETE FROM cloud_sync_outbox").run();
      db.prepare("DELETE FROM support_ticket_outbox").run();
      db.prepare("DELETE FROM store_diagnostics_outbox").run();
      this.upsertSettings({
        cloud_registration_status: 'deletion_pending', cloud_connected: 'false',
        cloud_sync_enabled: '0', cloud_orders_enabled: '0', cloud_reports_enabled: '0',
        cloud_command_polling_enabled: '0', diagnostics_consent: 'false', telemetry_enabled: 'false',
        anonymous_data_consent: 'false', cloud_services_disabled_by_user: 'true',
        cloud_deletion_request_id: '', cloud_deletion_status_token: '',
        cloud_deletion_status: 'pending', cloud_deletion_outcome: '', cloud_last_error: '',
      }, true);
    })();
    const res = await this.signedFetch('/api/pos/cloud-data/delete', {
      method: 'POST', body: JSON.stringify({ confirmation: 'DELETE CLOUD DATA' }),
    }, true);
    const data = await res.json().catch(() => null) as Record<string, unknown> | null;
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
      cloud_connected: 'false', cloud_sync_enabled: '0', cloud_orders_enabled: '0', cloud_reports_enabled: '0',
      cloud_command_polling_enabled: '0', diagnostics_consent: 'false', telemetry_enabled: 'false',
      anonymous_data_consent: 'false', telemetry_anon_id: crypto.randomUUID(),
      cloud_services_disabled_by_user: 'true',
      cloud_deletion_request_id: deletionComplete ? '' : deletion.requestId,
      cloud_deletion_status_token: deletionComplete ? '' : deletion.statusToken,
      cloud_deletion_status: deletionStatus, cloud_deletion_outcome: '',
    };
    if (deletionComplete) Object.assign(deletionSettings, {
      cloud_api_key: '', cloud_store_id: '', cloud_pos_id: '', cloud_pos_hash: '', cloud_device_secret: '',
      cloud_device_created_at: '', cloud_email_verified: 'false', cloud_email_verification_sent_at: '',
      cloud_verification_welcome_requested: '0',
    });
    db.transaction(() => {
      db.prepare("DELETE FROM cloud_sync_outbox").run();
      db.prepare("DELETE FROM support_ticket_outbox").run();
      db.prepare("DELETE FROM store_diagnostics_outbox").run();
      this.upsertSettings(deletionSettings, true);
    })();
    this.stop();
    this.settings = this.loadSettings(false);
    return responseData;
    }).catch((error) => {
      if (!this.shutdownRequested) {
        this.upsertSettings({
          cloud_deletion_status: 'failed', cloud_deletion_outcome: deletionOutcome,
          cloud_connected: 'false', cloud_last_error: 'Cloud data deletion failed',
        }, true);
        this.settings = this.loadSettings(false);
      }
      throw error;
    }).finally(() => { this.cloudDeletionInProgress = false; });
  }

  async getDeletionRequestStatus(options: { allowRemote?: boolean } = {}): Promise<Record<string, unknown> | null> {
    return withDatabaseRequest(async () => {
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
    const serverUrl = normalizeCloudServerUrl(settings.cloud_server_url || DEFAULT_CLOUD_SERVER_URL);
    const url = endpoint(serverUrl, `/api/cloud-data/deletion-request/status?id=${encodeURIComponent(requestId)}&token=${encodeURIComponent(statusToken)}`);
    const res = await this.trackedFetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
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
        cloud_api_key: '', cloud_store_id: '', cloud_pos_id: '', cloud_pos_hash: '', cloud_device_secret: '',
        cloud_device_created_at: '', cloud_registration_status: 'deleted', cloud_email_verified: 'false',
        cloud_email_verification_sent_at: '', cloud_verification_welcome_requested: '0',
        cloud_deletion_request_id: '', cloud_deletion_status_token: '',
        cloud_deletion_outcome: '',
      });
      this.settings = this.loadSettings(false);
    } else if (['cancelled', 'rejected'].includes(status)) {
      this.upsertSettings({
        cloud_registration_status: 'registered',
        cloud_deletion_request_id: '', cloud_deletion_status_token: '', cloud_deletion_outcome: '',
      });
      this.settings = this.loadSettings(false);
    }
    return data;
    }).catch((error) => {
      if (!this.cloudDeletionInProgress && !this.shutdownRequested) {
        this.upsertSettings({
          cloud_deletion_status: 'failed', cloud_deletion_outcome: 'unknown',
          cloud_connected: 'false', cloud_last_error: 'Cloud deletion status check failed',
        });
        this.settings = this.loadSettings(false);
      }
      throw error;
    });
  }

  async cancelDeletionRequest(): Promise<Record<string, unknown>> {
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    return withDatabaseRequest(async () => {
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    const settings = this.readSettings(getDatabase());
    if (!settings.cloud_deletion_request_id) throw new Error('No pending deletion request');
    const res = await this.signedFetch('/api/pos/cloud-data/deletion-request/cancel', {
      method: 'POST', body: JSON.stringify({ request_id: settings.cloud_deletion_request_id }),
    }, true);
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (this.cloudDeletionInProgress) throw new Error('Cloud deletion in progress');
    if (!res.ok) throw new Error(String(data.error || `Cancellation failed (${res.status})`));
    this.upsertSettings({
      cloud_deletion_status: 'cancelled', cloud_registration_status: 'registered',
      cloud_deletion_request_id: '', cloud_deletion_status_token: '',
      cloud_deletion_outcome: '',
    });
    return { status: typeof data.status === 'string' ? data.status : 'cancelled' };
    });
  }

  /**
   * Tells FloAdmin the merchant's current Tier 2 diagnostics choice, so
   * `stores.diagnostics_consent` server-side matches the local toggle in both
   * directions (on AND off) — not just inferred from "an event arrived."
   * Best-effort: if the POS is offline or unregistered right now, the very
   * next reportDiagnostic() call (when back online) is gated locally anyway,
   * and the next successful call here will still bring the server in sync.
   */
  async setDiagnosticsConsent(enabled: boolean): Promise<void> {
    try {
      const res = await this.signedFetch('/api/pos/diagnostics-consent', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      });
      await this.drainResponse(res);
    } catch (err) {
      log.debug('[CloudSync] diagnostics consent sync failed (non-fatal):', (err as Error).message);
    }
  }

  /** Queue a support request durably; the caller can be offline. */
  async queueSupportTicket(input: SupportTicketInput): Promise<{ queued: boolean; client_ticket_id: string }> {
    if (this.cloudDeletionInProgress) return { queued: false, client_ticket_id: input.client_ticket_id };
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
    };
    return withDatabaseRequest(async () => {
      if (this.cloudDeletionInProgress) return { queued: false, client_ticket_id: input.client_ticket_id };
      const db = getDatabase();
      const timestamp = now();
      db.prepare(`
        INSERT OR IGNORE INTO support_ticket_outbox
          (client_ticket_id, payload, status, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?)
      `).run(input.client_ticket_id, JSON.stringify(payload), timestamp, timestamp);
      this.runBackground(this.flushSupportTicketOutbox(), 'support outbox flush');
      return { queued: true, client_ticket_id: input.client_ticket_id };
    });
  }

  private flushSupportTicketOutbox(): Promise<void> {
    if (this.cloudDeletionInProgress) return Promise.resolve();
    if (this.supportFlushPromise) return this.supportFlushPromise;
    const run = withDatabaseRequest(async () => {
    if (this.cloudDeletionInProgress) return;
    const cfg = this.settings ?? this.loadSettings();
    if (!cfg?.sync_enabled || !cfg.api_key || this.supportFlushing) return;
    this.supportFlushing = true;
    try {
    const db = getDatabase();
    db.prepare("UPDATE support_ticket_outbox SET status = 'failed', next_attempt_at = ?, updated_at = ? WHERE status = 'sending'").run(now(), now());
    const rows = db.prepare(`
      SELECT * FROM support_ticket_outbox
       WHERE status IN ('pending', 'failed')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC LIMIT 10
    `).all(now()) as Array<{ client_ticket_id: string; payload: string; attempt_count: number }>;
    if (rows.length === 0) return;

    try {
      for (const row of rows) {
        db.prepare(`UPDATE support_ticket_outbox SET status = 'sending', updated_at = ? WHERE client_ticket_id = ?`)
          .run(now(), row.client_ticket_id);
        const res = await this.signedFetch('/api/pos/support-ticket', {
          method: 'POST',
          body: row.payload,
        });
        const data = await res.json().catch(() => ({})) as { support_code?: string };
        if (this.cloudDeletionInProgress) return;
        if (!res.ok) throw new Error(`support ticket submission failed (${res.status})`);
        db.prepare(`
          UPDATE support_ticket_outbox
             SET status = 'delivered', support_code = ?, delivered_at = ?, updated_at = ?, last_error = NULL
           WHERE client_ticket_id = ?
        `).run(data.support_code || null, now(), now(), row.client_ticket_id);
      }
      this.upsertSettings({ cloud_connected: 'true', cloud_last_error: '' });
    } catch (err) {
      const message = (err as Error).message;
      const rowsToFail = db.prepare(`SELECT client_ticket_id, attempt_count FROM support_ticket_outbox WHERE status = 'sending'`).all() as Array<{ client_ticket_id: string; attempt_count: number }>;
      for (const row of rowsToFail) {
        const attempts = row.attempt_count + 1;
        const delayMs = Math.min(30 * 60_000, Math.pow(2, Math.min(attempts, 8)) * 1000);
        // Space form, same as now() — the flush query compares
        // `next_attempt_at <= now()`, and an ISO-Z value would sort after
        // every space-form row of the same day, deferring retries by up to a day.
        const nextAttemptAt = new Date(Date.now() + delayMs).toISOString().replace('T', ' ').replace(/\..*$/, '');
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
    this.supportFlushPromise = run.finally(() => { this.supportFlushPromise = null; });
    return this.supportFlushPromise;
  }

  /**
   * Queue a Tier 2 store-attributed diagnostic event durably. No-ops silently
   * when the merchant hasn't given the separate diagnostics_consent opt-in —
   * callers should not need to check this themselves before every call site.
   */
  reportDiagnostic(input: DiagnosticEventInput): void {
    if (this.cloudDeletionInProgress || this.shutdownRequested) return;
    this.runBackground(withDatabaseRequest(() => {
      if (this.cloudDeletionInProgress || !isDiagnosticsConsentEnabled()) return;
      const db = getDatabase();
      const timestamp = now();
      db.prepare(`
        INSERT OR IGNORE INTO store_diagnostics_outbox
          (event_id, payload, status, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?)
      `).run(input.event_id, JSON.stringify(input), timestamp, timestamp);
      this.runBackground(this.flushDiagnosticsOutbox(), 'diagnostics outbox flush');
    }), 'diagnostic enqueue', (error) => this.markError((error as Error).message));
  }

  private flushDiagnosticsOutbox(): Promise<void> {
    if (this.cloudDeletionInProgress) return Promise.resolve();
    if (this.diagnosticsFlushPromise) return this.diagnosticsFlushPromise;
    const run = withDatabaseRequest(async () => {
    if (this.cloudDeletionInProgress || !isDiagnosticsConsentEnabled()) return;
    const cfg = this.settings ?? this.loadSettings();
    if (!cfg?.sync_enabled || !cfg.api_key || this.diagnosticsFlushing) return;
    this.diagnosticsFlushing = true;
    try {
    const db = getDatabase();
    db.prepare("UPDATE store_diagnostics_outbox SET status = 'failed', next_attempt_at = ?, updated_at = ? WHERE status = 'sending'").run(now(), now());
    const rows = db.prepare(`
      SELECT * FROM store_diagnostics_outbox
       WHERE status IN ('pending', 'failed')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC LIMIT 20
    `).all(now()) as Array<{ event_id: string; payload: string; attempt_count: number }>;
    if (rows.length === 0) return;

    try {
      for (const row of rows) {
        db.prepare(`UPDATE store_diagnostics_outbox SET status = 'sending', updated_at = ? WHERE event_id = ?`)
          .run(now(), row.event_id);
        const res = await this.signedFetch('/api/pos/diagnostics', {
          method: 'POST',
          body: row.payload,
        });
        await this.drainResponse(res);
        if (this.cloudDeletionInProgress) return;
        if (!res.ok) throw new Error(`diagnostic event submission failed (${res.status})`);
        db.prepare(`
          UPDATE store_diagnostics_outbox
             SET status = 'delivered', delivered_at = ?, updated_at = ?, last_error = NULL
           WHERE event_id = ?
        `).run(now(), now(), row.event_id);
      }
    } catch (err) {
      const message = (err as Error).message;
      const rowsToFail = db.prepare(`SELECT event_id, attempt_count FROM store_diagnostics_outbox WHERE status = 'sending'`).all() as Array<{ event_id: string; attempt_count: number }>;
      for (const row of rowsToFail) {
        const attempts = row.attempt_count + 1;
        const delayMs = Math.min(30 * 60_000, Math.pow(2, Math.min(attempts, 8)) * 1000);
        // Space form, same as now() — the flush query compares
        // `next_attempt_at <= now()`, and an ISO-Z value would sort after
        // every space-form row of the same day, deferring retries by up to a day.
        const nextAttemptAt = new Date(Date.now() + delayMs).toISOString().replace('T', ' ').replace(/\..*$/, '');
        db.prepare(`
          UPDATE store_diagnostics_outbox
             SET status = 'failed', attempt_count = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
           WHERE event_id = ?
        `).run(attempts, nextAttemptAt, message, now(), row.event_id);
      }
      // Non-fatal, same as support tickets: diagnostics must never surface a
      // connectivity error as if it were a cloud-sync problem to the merchant.
    }
    } finally {
      this.diagnosticsFlushing = false;
    }
    });
    this.diagnosticsFlushPromise = run.finally(() => { this.diagnosticsFlushPromise = null; });
    return this.diagnosticsFlushPromise;
  }

  /**
   * Generate (or, with revoke=true, explicitly rotate) the RevFlo pairing
   * code for this store. revoke=true also disconnects every already-paired
   * device — only the explicit "Generate new code" action in Settings should
   * pass it; a plain cache-miss refetch must not silently kick anyone off.
   * See specs/floadmin.md § Device pairing.
   */
  async generatePairingCode(revoke: boolean): Promise<{ code: string; expires_at: string }> {
    const res = await this.signedFetch('/api/pos/pairing-code', {
      method: 'POST',
      body: JSON.stringify({ revoke_devices: revoke }),
    });
    const data = await res.json().catch(() => ({})) as { code?: string; expires_at?: string };
    if (!res.ok) throw new Error(`Pairing code request failed (${res.status})`);
    return data as { code: string; expires_at: string };
  }

  /** Devices (RevFlo installs) currently paired to this store. */
  async listPairedDevices(): Promise<Record<string, unknown>[]> {
    const res = await this.signedFetch('/api/pos/devices', { method: 'GET' });
    const data = (await res.json().catch(() => ({ devices: [] }))) as { devices?: Record<string, unknown>[] };
    if (!res.ok) throw new Error(`Device list request failed (${res.status})`);
    return Array.isArray(data.devices) ? data.devices : [];
  }

  // No customer data (name/phone/email) is ever sent to the cloud either —
  // storing customer PII centrally is unnecessary liability with no upside
  // for this business, on top of bills/orders/payments already never being
  // pushed. There used to be a customer-upsert call here piggybacked on
  // bill payment; removed entirely, not replaced with anything.

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
    this.enqueueEvent('order.status', 'order', orderflowOrderId, { orderflow_order_id: orderflowOrderId, status, note });
  }

  private buildHeartbeatPayload(cfg: CloudSettings) {
    const db = getDatabase();
    const activeOrders = db.prepare(`
      SELECT COUNT(*) as count FROM orders
      WHERE status IN ('pending', 'preparing', 'ready', 'served')
    `).get() as { count: number };
    // #208: UTC "today" via the new idx_bills_paid_status_paid_at
    // instead of date() on every row.
    const [ts, te] = utcDayBounds(utcTodayDate());
    const todaySales = db.prepare(`
      SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count
      FROM bills
      WHERE payment_status = 'paid' AND paid_at >= ? AND paid_at < ?
    `).get(ts, te) as { total: number; count: number };
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
    return withDatabaseRequest(async () => {
    if (this.cloudDeletionInProgress) return;
    const cfg = this.settings;
    if (!cfg?.sync_enabled || !cfg.api_key) return;
    try {
      const body = this.buildHeartbeatPayload(cfg);
      const res = await this.signedFetch('/api/pos/heartbeat', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (this.cloudDeletionInProgress) return;
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
    return withDatabaseRequest(async () => {
    if (this.cloudDeletionInProgress) return;
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
    });
  }

  private enqueueEvent(eventType: string, entityType: string, entityId: string, payload: unknown) {
    if (this.cloudDeletionInProgress || this.shutdownRequested) return;
    this.runBackground(withDatabaseRequest(async () => {
      if (this.cloudDeletionInProgress) return;
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
    }), 'event enqueue', (error) => this.markError((error as Error).message));
  }

  private flushOutbox(): Promise<void> {
    if (this.cloudDeletionInProgress || this.outboxFlushPromise) return this.outboxFlushPromise || Promise.resolve();
    const run = withDatabaseRequest(async () => {
    if (this.cloudDeletionInProgress) return;
    const cfg = this.settings ?? this.loadSettings();
    if (!cfg?.sync_enabled || !cfg.api_key || this.flushing) return;
    this.flushing = true;
    try {
      const db = getDatabase();
      db.prepare("UPDATE cloud_sync_outbox SET status = 'failed', next_attempt_at = ?, updated_at = ? WHERE status = 'sending'").run(now(), now());
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
        payload: row.entity_type === 'order' ? sanitizeOrderSnapshot(safeJsonParse(row.payload)) : safeJsonParse(row.payload),
      }));

      const updateStmt = db.prepare(`UPDATE cloud_sync_outbox SET status = 'sending', updated_at = ? WHERE id = ?`);
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
      if (this.cloudDeletionInProgress) return;
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
    });
    this.outboxFlushPromise = run.finally(() => { this.outboxFlushPromise = null; });
    return this.outboxFlushPromise;
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
      // Space form, same as now() — `next_attempt_at <= now()` in the flush
      // query compares like-for-like (an ISO-Z value would sort after space
      // rows of the same day and delay retries by up to a day).
      const nextAttemptAt = new Date(Date.now() + delayMs).toISOString().replace('T', ' ').replace(/\..*$/, '');
      stmt.run(attempts, nextAttemptAt, message, now(), row.id);
    }
    this.markError(message);
  }

  private async pollCommands() {
    return withDatabaseRequest(async () => {
    if (this.cloudDeletionInProgress) return;
    const cfg = this.settings;
    if (!cfg?.command_polling_enabled || !cfg.api_key || this.pollingCommands) return;
    this.pollingCommands = true;
    try {
      const res = await this.signedFetch('/api/pos/commands?limit=5', { method: 'GET' });
      const data = await res.json().catch(() => ({})) as { commands?: CloudCommand[] };
      if (this.cloudDeletionInProgress) return;
      if (!res.ok) throw new Error(`command poll failed (${res.status})`);
      const commands = Array.isArray(data.commands) ? data.commands : [];
      for (const command of commands) {
        if (this.cloudDeletionInProgress) return;
        await this.executeCommand(command);
      }
    } catch (err) {
      this.markError((err as Error).message);
    } finally {
      this.pollingCommands = false;
    }
    });
  }

  private async executeCommand(command: CloudCommand) {
    if (this.cloudDeletionInProgress) return;
    let body: Record<string, unknown>;
    try {
      const result = this.runCommand(command);
      body = { version: 1, correlation_id: command.correlation_id || command.id, ok: true, result, completed_at: new Date().toISOString() };
    } catch (err) {
      body = { version: 1, correlation_id: command.correlation_id || command.id, ok: false, error: (err as Error).message, completed_at: new Date().toISOString() };
    }

    const res = await this.signedFetch(`/api/pos/commands/${encodeURIComponent(command.id)}/result`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    await this.drainResponse(res);
    if (this.cloudDeletionInProgress) return;
    if (!res.ok) throw new Error(`command result failed (${res.status})`);
  }

  /** Same as executeCommand, but for a command pushed over the relay socket — result goes back as a frame, not a POST. */
  private async executeRelayCommand(command: CloudCommand) {
    return withDatabaseRequest(async () => {
    if (this.cloudDeletionInProgress || this.shutdownRequested) return;
    let body: Record<string, unknown>;
    try {
      const result = this.runCommand(command);
      body = { version: 1, correlation_id: command.correlation_id || command.id, ok: true, result, completed_at: new Date().toISOString() };
    } catch (err) {
      body = { version: 1, correlation_id: command.correlation_id || command.id, ok: false, error: (err as Error).message, completed_at: new Date().toISOString() };
    }
    if (!this.cloudDeletionInProgress && !this.shutdownRequested && this.relaySocket?.readyState === WebSocket.OPEN) {
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

  /**
   * Register on every boot so FloAdmin receives refreshed store metadata
   * (name, contact, country, version) after setup changes. The server's
   * create-or-find endpoint preserves the installation identity and API key.
   */
  private maybeAutoRegister() {
    const db = getDatabase();
    const settings = this.readSettings(db);
    if (isCloudDeletionBlocking(settings.cloud_deletion_status)
      || settings.cloud_sync_enabled !== '1' || settings.cloud_services_disabled_by_user === 'true') return;
    // initDatabase() runs before first-run setup. Registering seeded defaults at
    // that point creates a permanent-looking blank row in FloAdmin. Setup always
    // writes a non-empty business name (falling back to "Store"), so wait for it.
    if (!settings.business_name?.trim()) return;
    this.attemptAutoRegister();
  }

  /** Refresh FloAdmin after setup or store-profile settings change. */
  refreshRegistrationProfile() {
    // Routes are also imported by isolated tests and backend-only tooling where
    // the desktop runtime was never started. Do not create background network
    // retries in those processes.
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
    if (this.cloudDeletionInProgress || isCloudDeletionBlocking(settings.cloud_deletion_status)
      || settings.cloud_sync_enabled !== '1' || settings.cloud_services_disabled_by_user === 'true') return;
    if (this.autoRegisterTimer || this.autoRegisterInFlight) return;
    this.autoRegisterInFlight = true;
    this.runBackground(this.register()
      .then(() => {
        this.autoRegisterAttempts = 0;
        this.autoRegisterInFlight = false;
      })
      .catch(() => {
        this.autoRegisterInFlight = false;
        if (this.shutdownRequested) return;
        const currentSettings = this.readSettings(getDatabase());
        if (this.cloudDeletionInProgress || isCloudDeletionBlocking(currentSettings.cloud_deletion_status)
          || currentSettings.cloud_sync_enabled !== '1' || currentSettings.cloud_services_disabled_by_user === 'true') return;
        const delay = Math.min(AUTO_REGISTER_MAX_BACKOFF_MS, 2 ** this.autoRegisterAttempts * 1000);
        this.autoRegisterAttempts++;
        this.autoRegisterTimer = setTimeout(() => {
          this.autoRegisterTimer = null;
          if (!this.shutdownRequested) this.attemptAutoRegister();
        }, delay);
      }), 'auto-registration');
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
      this.relayHeartbeatFrameTimer = setInterval(() => this.runBackground(this.sendRelayHeartbeat(), 'relay heartbeat'), HEARTBEAT_INTERVAL_MS);
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
      const commandPayload = envelope.version === 1 && envelope.payload && typeof envelope.payload === 'object'
        ? envelope.payload : envelope;
      this.trackRelayCommand(this.executeRelayCommand({
        id: frame.id,
        type: frame.cmd,
        payload: commandPayload,
        correlation_id: typeof envelope.correlation_id === 'string' ? envelope.correlation_id : frame.id,
      }));
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
    if (this.shutdownRequested) return;
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
    if (this.cloudDeletionInProgress || this.shutdownRequested) return;
    const cfg = this.settings;
    if (!cfg?.api_key || this.httpFallbackActive) return;
    this.httpFallbackActive = true;
    this.relayMode = 'http_fallback';

    if (cfg.sync_enabled && !this.heartbeatTimer) {
      this.runBackground(this.sendHeartbeat(), 'heartbeat');
      this.heartbeatTimer = setInterval(() => this.runBackground(this.sendHeartbeat(), 'heartbeat'), HEARTBEAT_INTERVAL_MS);
    }
    if (cfg.command_polling_enabled && !this.commandTimer) {
      this.runBackground(this.pollCommands(), 'command polling');
      this.commandTimer = setInterval(() => this.runBackground(this.pollCommands(), 'command polling'), COMMAND_POLL_INTERVAL_MS);
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
    if (command.payload && command.payload.version === 1 && command.payload.payload && typeof command.payload.payload === 'object') {
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
        COALESCE(SUM(CASE WHEN b.split_group_id IS NULL THEN oi.quantity ELSE bi.quantity END), 0) as quantity,
        COALESCE(SUM(CASE WHEN b.split_group_id IS NULL THEN oi.total ELSE oi.total * bi.quantity / oi.quantity END), 0) as total
      FROM bills b JOIN orders o ON o.id = b.order_id JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN bill_items bi ON bi.bill_id = b.id AND bi.order_item_id = oi.id
      WHERE b.payment_status = 'paid'
        AND (b.split_group_id IS NULL OR bi.bill_id IS NOT NULL)
        AND COALESCE(b.paid_at, b.created_at) >= ?
        AND COALESCE(b.paid_at, b.created_at) <= ?
      GROUP BY oi.product_id, oi.product_name
      ORDER BY total DESC
      LIMIT 20
    `).all(range.from, range.to);

    return {
      range,
      totals,
      data: (byDay as any[]).map((row) => ({ period: row.date, total: row.gross_sales, bill_count: row.bill_count })),
      top_items: topItems,
    };
  }

  private dashboardReport(payload?: Record<string, unknown>) {
    const range = dateRange({ from: payload?.date, to: payload?.date });
    const db = getDatabase();
    const totals = db.prepare(`
      SELECT COUNT(*) AS bill_count, COALESCE(SUM(total), 0) AS total_sales,
             COALESCE(SUM(tax_amount), 0) AS total_tax,
             COALESCE(SUM(discount_amount), 0) AS total_discount
        FROM bills
       WHERE payment_status = 'paid' AND date(COALESCE(paid_at, created_at)) BETWEEN date(?) AND date(?)
    `).get(range.from, range.to) as any;
    const topItems = db.prepare(`
      SELECT oi.product_name AS name, COALESCE(SUM(CASE WHEN b.split_group_id IS NULL THEN oi.quantity ELSE bi.quantity END), 0) AS qty,
             COALESCE(SUM(CASE WHEN b.split_group_id IS NULL THEN oi.total ELSE oi.total * bi.quantity / oi.quantity END), 0) AS revenue,
             COALESCE(AVG(oi.unit_price), 0) AS price
        FROM bills b JOIN orders o ON o.id = b.order_id JOIN order_items oi ON oi.order_id = o.id
        LEFT JOIN bill_items bi ON bi.bill_id = b.id AND bi.order_item_id = oi.id
       WHERE b.payment_status = 'paid' AND date(COALESCE(b.paid_at, b.created_at)) BETWEEN date(?) AND date(?)
         AND (b.split_group_id IS NULL OR bi.bill_id IS NOT NULL)
       GROUP BY oi.product_id, oi.product_name ORDER BY revenue DESC LIMIT 5
    `).all(range.from, range.to);
    const paymentRows = this.paymentBreakdown(range);
    const totalSales = Number(totals.total_sales || 0);
    return {
      ...totals,
      avg_order_value: totals.bill_count ? totalSales / Number(totals.bill_count) : 0,
      payment_breakdown: Object.fromEntries((paymentRows as any[]).map((row) => [String(row.method || 'other').toLowerCase(), row.amount])),
      top_items: topItems,
    };
  }

  private hourlyReport(payload?: Record<string, unknown>) {
    const range = dateRange({ from: payload?.date, to: payload?.date });
    const rows = getDatabase().prepare(`
      SELECT strftime('%H', COALESCE(paid_at, created_at)) AS hour,
             COALESCE(SUM(total), 0) AS sales, COUNT(*) AS bills
        FROM bills
       WHERE payment_status = 'paid' AND date(COALESCE(paid_at, created_at)) BETWEEN date(?) AND date(?)
       GROUP BY hour ORDER BY hour
    `).all(range.from, range.to) as any[];
    const byHour = new Map(rows.map((row) => [String(row.hour).padStart(2, '0'), row]));
    return { hours: Array.from({ length: 24 }, (_, hour) => {
      const row = byHour.get(String(hour).padStart(2, '0'));
      return { hour: `${String(hour).padStart(2, '0')}:00`, sales: row?.sales || 0, bills: row?.bills || 0 };
    }) };
  }

  private itemsReport(payload?: Record<string, unknown>) {
    const range = dateRange(payload);
    const requestedLimit = Number(payload?.limit);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
    const items = getDatabase().prepare(`
      SELECT oi.product_name AS name, COALESCE(SUM(CASE WHEN b.split_group_id IS NULL THEN oi.quantity ELSE bi.quantity END), 0) AS qty_sold,
             COALESCE(SUM(CASE WHEN b.split_group_id IS NULL THEN oi.total ELSE oi.total * bi.quantity / oi.quantity END), 0) AS revenue
        FROM bills b JOIN orders o ON o.id = b.order_id JOIN order_items oi ON oi.order_id = o.id
        LEFT JOIN bill_items bi ON bi.bill_id = b.id AND bi.order_item_id = oi.id
       WHERE b.payment_status = 'paid' AND date(COALESCE(b.paid_at, b.created_at)) BETWEEN date(?) AND date(?)
         AND (b.split_group_id IS NULL OR bi.bill_id IS NOT NULL)
       GROUP BY oi.product_id, oi.product_name ORDER BY revenue DESC LIMIT ?
    `).all(range.from, range.to, limit);
    return { items };
  }

  private paymentsReport(payload?: Record<string, unknown>) {
    const range = dateRange(payload);
    const rows = this.paymentBreakdown(range) as any[];
    const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    return {
      total,
      breakdown: rows.map((row) => ({ method: row.method || 'Other', amount: row.amount || 0, count: row.count || 0, percent: total ? Number(row.amount || 0) / total * 100 : 0 })),
    };
  }

  private paymentBreakdown(range: DateRange) {
    return getDatabase().prepare(`
      SELECT COALESCE(pm.name, json_extract(je.value, '$.method')) AS method,
             COUNT(*) AS count, COALESCE(SUM(json_extract(je.value, '$.amount')), 0) AS amount
        FROM bills b, json_each(b.payment_details) je
        LEFT JOIN payment_methods pm ON pm.id = CAST(json_extract(je.value, '$.payment_method_id') AS INTEGER)
       WHERE b.payment_details IS NOT NULL
         AND date(COALESCE(json_extract(je.value, '$.timestamp'), b.paid_at, b.created_at)) BETWEEN date(?) AND date(?)
       GROUP BY COALESCE(pm.name, json_extract(je.value, '$.method')) ORDER BY amount DESC
    `).all(range.from, range.to);
  }

  private buildOrderSnapshot(orderId: number | string) {
    const db = getDatabase();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
    if (!order) return null;
    return this.decorateOrder(order);
  }

  private decorateOrder(order: any, itemsOverride?: any[]) {
    const db = getDatabase();
    const items = itemsOverride ?? attachEffectiveAddons(db, db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id).map(parseItemJson) as any[]);
    const tableRow = order.table_id ? db.prepare('SELECT * FROM tables WHERE id = ?').get(order.table_id) as any : null;
    const bills = db.prepare('SELECT * FROM bills WHERE order_id = ? ORDER BY id').all(order.id) as any[];
    const bill = bills.find((row) => row.payment_status !== 'paid') || bills[0] || null;
    return sanitizeOrderSnapshot({
      ...order,
      items,
      table: tableRow ? { ...tableRow, name: tableRow.number } : null,
      bill: bill ? { ...bill, payment_details: safeJsonParse(bill.payment_details) } : null,
      bills: bills.map((row) => ({ ...row, payment_details: safeJsonParse(row.payment_details) })),
    });
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

  private async signedFetch(pathname: string, init: RequestInit, allowDuringDeletion = false): Promise<Response> {
    if (this.cloudDeletionInProgress && !allowDuringDeletion) throw new Error('Cloud deletion in progress');
    const persistedSettings = this.readSettings(getDatabase());
    if (isCloudDeletionBlocking(persistedSettings.cloud_deletion_status) && !allowDuringDeletion) {
      throw new Error('Cloud deletion is unresolved; retry or cancel it before using cloud services');
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
    const signedHeaders = this.buildSignedHeaders(cfg.api_key, cfg.pos_hash, method, signedPath, body);

    return this.trackedFetch(url, {
      ...init,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...signedHeaders,
        ...(init.headers || {}),
      },
      body: method === 'GET' ? undefined : body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, allowDuringDeletion);
  }

  private runBackground<T>(operation: Promise<T>, label: string, onError?: (error: unknown) => void): void {
    void operation.catch((error) => {
      if (this.shutdownRequested || (error as { code?: unknown })?.code === 'ERR_SHUTDOWN_ABORTED') return;
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
  }

  private async trackedFetch(url: string | URL, init: RequestInit, allowDuringDeletion = false): Promise<Response> {
    if (this.cloudDeletionInProgress && !allowDuringDeletion) throw new Error('Cloud deletion in progress');
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
      const response = await fetch(url, init);
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
              try { return await original(...args); } finally { release(); }
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
    try { await response.arrayBuffer(); } catch { }
  }

  private waitForCloudNetworkIdle(): Promise<void> {
    if (this.cloudNetworkOperations === 0) return Promise.resolve();
    return new Promise((resolve) => this.cloudNetworkIdleWaiters.push(resolve));
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
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const s: Record<string, string> = {};
    for (const row of rows) s[row.key] = row.value;
    return s;
  }

  private upsertSettings(entries: Record<string, string | undefined | null>, allowDuringDeletion = false) {
    if (this.shutdownRequested || (this.cloudDeletionInProgress && !allowDuringDeletion)) return;
    if (isDatabaseMaintenanceActive()) {
      this.runBackground(withDatabaseRequest(() => this.upsertSettings(entries, allowDuringDeletion)), 'settings update');
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
      const row = getDatabase().prepare('SELECT COUNT(*) as count FROM cloud_sync_outbox WHERE status = ?')
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

/**
 * Optional Google Drive integration for automated, off-device DB backups (#129).
 *
 * Follows the same explicit-opt-in shape as cloud-sync.ts: nothing in this
 * module ever talks to Google until the owner clicks "Connect" in
 * Settings > Integrations > Google Drive. Until then `start()` only arms a
 * timer that no-ops (readTokens() returns null) — no network call, no
 * background request.
 *
 * OAuth: standard "installed app" loopback flow (Google's recommended
 * pattern for desktop apps) — open the consent screen in the system browser
 * via shell.openExternal and catch the redirect on a local HTTP server bound
 * to a random port, rather than embedding a webview. Scope is restricted to
 * `drive.file` (least privilege — the app only ever sees files it created).
 *
 * Tokens are OS-encrypted via Electron's safeStorage (same pattern as
 * master-pin.ts) and stored in their own file — never in the SQLite DB.
 *
 * Backups reuse `createBackup()` from db.ts unmodified — no second export
 * path that could skip the redaction already applied to /api/db/export.
 */

import { app, shell, safeStorage } from 'electron';
import { isSafeExternalUrl } from '../security/url-allowlist';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import log from 'electron-log';
import { google } from 'googleapis';
import { getDatabase, now, createBackup } from '../db';
import { SHUTDOWN_TIMEOUT_MS } from '../shutdown';

// googleapis bundles its own internal copy of google-auth-library — use its
// re-exported OAuth2 client (google.auth.OAuth2) rather than depending on
// the standalone `google-auth-library` package directly, which can resolve
// to a different version than the one googleapis' Drive client expects and
// trips up structural typing between the two copies.
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_BACKUP_FOLDER_NAME = 'FloCafe Backups';

const DEFAULT_RETENTION = 10;
const MIN_RETENTION = 1;
const MAX_RETENTION = 100;
const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;
const SCHEDULE_CHECK_INTERVAL_MS = 60 * 60_000; // hourly, same cadence as telemetry's daily-ping check
const LOOPBACK_TIMEOUT_MS = 5 * 60_000;
const DRIVE_REQUEST_TIMEOUT_MS = 10_000;

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function createDriveShutdownError(label: string, timedOut = false): Error & { code: string } {
  const error = new Error(`${label} ${timedOut ? 'timed out' : 'cancelled'} during shutdown`) as Error & { code: string };
  error.code = timedOut ? 'ERR_SHUTDOWN_TIMEOUT' : 'ERR_SHUTDOWN_ABORTED';
  return error;
}

function isExpectedShutdownCancellation(error: unknown): boolean {
  const candidate = error as { code?: unknown; name?: unknown } | null;
  return candidate?.code === 'ERR_SHUTDOWN_ABORTED'
    || candidate?.code === 'ABORT_ERR'
    || candidate?.name === 'AbortError';
}

function waitForDriveOperation<T>(operation: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(createDriveShutdownError(label));
    onAbort = abort;
    if (signal?.aborted) {
      abort();
      return;
    }
    if (signal) signal.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => reject(createDriveShutdownError(label, true)), timeoutMs);
  });
  return Promise.race([operation, cancellation]).finally(() => {
    if (timeout) clearTimeout(timeout);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  });
}

export type BackupFrequency = 'daily' | 'weekly';

export type GoogleDriveStatus = {
  configured: boolean;
  secure_storage_available: boolean;
  connected: boolean;
  account_email: string | null;
  frequency: BackupFrequency;
  retention_count: number;
  last_backup_at: string | null;
  last_backup_status: 'success' | 'error' | null;
  last_backup_filename: string | null;
  last_error: string | null;
};

interface StoredTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  token_type?: string | null;
  id_token?: string | null;
  scope?: string;
}

function getTokenFilePath(): string {
  return path.join(app.getPath('userData'), 'google-drive-token.enc');
}

/** Reads GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET — set at build/run time by whoever ships this build. See docs/google-drive-setup.md. */
function getClientCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function isGoogleDriveConfigured(): boolean {
  return getClientCredentials() !== null;
}

function isSecureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Pure retention math, split out from applyRetention() so it's unit
 * testable without a real Drive client: given the app-folder's files
 * (oldest-first) and how many to keep, returns the ids to delete.
 */
export function computeFilesToDelete(
  files: { id: string; createdTime: string }[],
  retentionCount: number
): string[] {
  const sorted = [...files].sort((a, b) => a.createdTime.localeCompare(b.createdTime));
  if (sorted.length <= retentionCount) return [];
  return sorted.slice(0, sorted.length - retentionCount).map((f) => f.id);
}

/**
 * Pure scheduling check, split out for unit testing: is a new Drive backup
 * due given the last successful backup time and the configured frequency?
 */
export function isBackupDue(lastBackupAtIso: string | null, frequency: BackupFrequency, nowMs = Date.now()): boolean {
  if (!lastBackupAtIso) return true;
  const last = new Date(lastBackupAtIso).getTime();
  if (Number.isNaN(last)) return true;
  const intervalMs = frequency === 'weekly' ? WEEK_MS : DAY_MS;
  return nowMs - last >= intervalMs;
}

class GoogleDriveService {
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;
  private backingUp = false;
  private backupPromise: Promise<GoogleDriveStatus> | null = null;
  private backupAbortController: AbortController | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  /** Arms the hourly schedule check. Never makes a network call by itself — see module doc comment. */
  start(): void {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    this.stopping = false;
    this.stopPromise = null;
    this.scheduleTimer = setInterval(() => void this.maybeRunScheduled(), SCHEDULE_CHECK_INTERVAL_MS);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.backupAbortController?.abort();
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    if (!this.backupPromise) {
      this.stopPromise = Promise.resolve();
      return this.stopPromise;
    }
    const backup = this.backupPromise;
    void backup.catch(() => {});
    this.stopPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.backupAbortController?.abort();
        const error = new Error(`Google Drive shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms`) as Error & { code: string };
        error.code = 'ERR_SHUTDOWN_TIMEOUT';
        reject(error);
      }, SHUTDOWN_TIMEOUT_MS);
      backup.then(
        () => { clearTimeout(timeout); resolve(); },
        (error) => {
          clearTimeout(timeout);
          if (this.stopping && isExpectedShutdownCancellation(error)) resolve();
          else reject(error);
        },
      );
    });
    return this.stopPromise;
  }

  private async maybeRunScheduled(): Promise<void> {
    if (this.stopping) return;
    const tokens = this.readTokens();
    if (!tokens) return; // never connected, or disconnected — stay silent
    const settings = this.readSettings();
    const frequency: BackupFrequency = settings.google_drive_frequency === 'weekly' ? 'weekly' : 'daily';
    if (!isBackupDue(settings.google_drive_last_backup_at || null, frequency)) return;
    try {
      await this.backupNow();
    } catch (err) {
      log.warn('[GoogleDrive] scheduled backup failed', (err as Error).message);
    }
  }

  getStatus(): GoogleDriveStatus {
    const settings = this.readSettings();
    const tokens = this.readTokens();
    return {
      configured: isGoogleDriveConfigured(),
      secure_storage_available: isSecureStorageAvailable(),
      connected: Boolean(tokens),
      account_email: settings.google_drive_account_email || null,
      frequency: settings.google_drive_frequency === 'weekly' ? 'weekly' : 'daily',
      retention_count: this.retentionFromSettings(settings),
      last_backup_at: settings.google_drive_last_backup_at || null,
      last_backup_status: (settings.google_drive_last_backup_status as 'success' | 'error') || null,
      last_backup_filename: settings.google_drive_last_backup_filename || null,
      last_error: settings.google_drive_last_error || null,
    };
  }

  updatePreferences(input: { frequency?: string; retention_count?: number | string }): GoogleDriveStatus {
    const updates: Record<string, string> = {};
    if (input.frequency !== undefined) {
      if (input.frequency !== 'daily' && input.frequency !== 'weekly') {
        throw new Error('frequency must be "daily" or "weekly"');
      }
      updates.google_drive_frequency = input.frequency;
    }
    if (input.retention_count !== undefined) {
      const n = Number(input.retention_count);
      if (!Number.isInteger(n) || n < MIN_RETENTION || n > MAX_RETENTION) {
        throw new Error(`retention_count must be an integer between ${MIN_RETENTION} and ${MAX_RETENTION}`);
      }
      updates.google_drive_retention_count = String(n);
    }
    this.upsertSettings(updates);
    return this.getStatus();
  }

  /**
   * Explicit opt-in entry point: user clicked "Connect" in Settings. Opens
   * the consent screen in the system browser and waits for the loopback
   * redirect. Throws with a user-facing message if this build has no
   * client credentials configured, or secure storage isn't available.
   */
  async connect(signal?: AbortSignal): Promise<GoogleDriveStatus> {
    const creds = getClientCredentials();
    if (!creds) {
      throw new Error('Google Drive integration is not configured for this build');
    }
    if (!isSecureStorageAvailable()) {
      throw new Error('Secure storage is not available on this device — cannot safely store the Google Drive connection');
    }

    const { code, redirectUri } = await this.runLoopbackFlow(creds, signal);
    if (signal?.aborted) throw new Error('Google Drive connection cancelled during shutdown');
    const client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, redirectUri);
    const { tokens } = await waitForDriveOperation(client.getToken(code), signal, DRIVE_REQUEST_TIMEOUT_MS, 'Google Drive token exchange');
    if (signal?.aborted) throw new Error('Google Drive connection cancelled during shutdown');
    if (!tokens.refresh_token) {
      // Google only issues a refresh_token on first consent (or with prompt=consent,
      // which we always pass) — without it we can't run unattended scheduled backups.
      throw new Error('Google did not return a refresh token. Revoke FloCafe access at myaccount.google.com/permissions and try connecting again.');
    }
    this.writeTokens(tokens);

    client.setCredentials(tokens);
    let email: string | null = null;
    try {
      email = await this.fetchAccountEmail(client, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      log.warn('[GoogleDrive] could not fetch account email', (err as Error).message);
    }

    let folderId: string | null = null;
    try {
      const drive = google.drive({ version: 'v3', auth: client });
      folderId = await this.ensureAppFolder(drive, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      log.warn('[GoogleDrive] could not prepare app folder', (err as Error).message);
    }

    if (signal?.aborted) throw new Error('Google Drive connection cancelled during shutdown');

    this.upsertSettings({
      google_drive_account_email: email || '',
      google_drive_folder_id: folderId || '',
      google_drive_last_error: '',
    });
    return this.getStatus();
  }

  /** Revokes the token with Google (not just local state) and deletes the encrypted blob. */
  async disconnect(): Promise<GoogleDriveStatus> {
    const tokens = this.readTokens();
    if (tokens) {
      const tokenToRevoke = tokens.refresh_token || tokens.access_token;
      if (tokenToRevoke) {
        try {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokenToRevoke)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            signal: AbortSignal.timeout(8_000),
          });
        } catch (err) {
          // Local disconnect must still proceed even if Google's revoke endpoint
          // is unreachable — the encrypted token is deleted below regardless.
          log.warn('[GoogleDrive] revoke request failed (disconnecting locally anyway)', (err as Error).message);
        }
      }
    }
    this.deleteTokens();
    this.upsertSettings({
      google_drive_account_email: '',
      google_drive_folder_id: '',
      google_drive_last_backup_at: '',
      google_drive_last_backup_status: '',
      google_drive_last_backup_filename: '',
      google_drive_last_error: '',
    });
    return this.getStatus();
  }

  /** Manual "Back up to Drive now" action, and the scheduled path. Reuses createBackup() — no second export path. */
  async backupNow(signal?: AbortSignal): Promise<GoogleDriveStatus> {
    if (this.stopping) throw new Error('Google Drive is stopping');
    if (this.backingUp) return this.getStatus();
    this.backingUp = true;
    const abortController = new AbortController();
    this.backupAbortController = abortController;
    const operationSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;
    const operation = this.runBackup(operationSignal);
    this.backupPromise = operation;
    try {
      return await operation;
    } finally {
      this.backingUp = false;
      this.backupPromise = null;
      if (this.backupAbortController === abortController) this.backupAbortController = null;
    }
  }

  private async runBackup(signal: AbortSignal): Promise<GoogleDriveStatus> {
    try {
      const client = await this.getAuthorizedClient(signal);
      this.throwIfStopping(signal);
      const drive = google.drive({ version: 'v3', auth: client });
      const folderId = await this.ensureAppFolder(drive, signal);

      this.throwIfStopping(signal);
      const { path: backupPath } = await waitForDriveOperation(
        createBackup(undefined, signal),
        signal,
        SHUTDOWN_TIMEOUT_MS,
        'Google Drive local backup',
      );
      const fileName = path.basename(backupPath);

      await drive.files.create({
        requestBody: { name: fileName, parents: [folderId] },
        media: { mimeType: 'application/x-sqlite3', body: fs.createReadStream(backupPath) },
        fields: 'id',
      }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });

      await this.applyRetention(drive, folderId, signal);

      this.throwIfStopping(signal);
      this.upsertSettings({
        google_drive_folder_id: folderId,
        google_drive_last_backup_at: new Date().toISOString(),
        google_drive_last_backup_status: 'success',
        google_drive_last_backup_filename: fileName,
        google_drive_last_error: '',
      });
      return this.getStatus();
    } catch (err) {
      if (this.stopping) throw err;
      const message = (err as Error).message;
      this.upsertSettings({
        google_drive_last_backup_status: 'error',
        google_drive_last_error: message,
      });
      throw err;
    }
  }

  // ── Drive helpers ──────────────────────────────────────────────────────

  private async getAuthorizedClient(signal?: AbortSignal): Promise<OAuth2Client> {
    if (signal?.aborted) throw createDriveShutdownError('Google Drive operation');
    const creds = getClientCredentials();
    if (!creds) throw new Error('Google Drive integration is not configured for this build');
    const tokens = this.readTokens();
    if (!tokens) throw new Error('Google Drive is not connected');

    const client = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
    client.setCredentials(tokens);
    // google-auth-library refreshes the access token transparently using the
    // refresh_token when it's expired; persist whatever it hands back so the
    // next scheduled run doesn't have to refresh again.
    client.on('tokens', (refreshed) => {
      const merged = { ...this.readTokens(), ...refreshed };
      this.writeTokens(merged);
    });
    return client;
  }

  private async fetchAccountEmail(client: OAuth2Client, signal?: AbortSignal): Promise<string | null> {
    const accessToken = (await waitForDriveOperation(client.getAccessToken(), signal, DRIVE_REQUEST_TIMEOUT_MS, 'Google Drive access token refresh')).token;
    if (!accessToken) return null;
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: requestSignal(signal, 8_000),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { email?: string };
    return data.email || null;
  }

  private async ensureAppFolder(drive: ReturnType<typeof google.drive>, signal?: AbortSignal): Promise<string> {
    this.throwIfStopping(signal);
    const existingId = this.readSettings().google_drive_folder_id;
    if (existingId) {
      // Confirm it still exists / is still visible to this scope before reusing it.
      try {
        const res = await drive.files.get({ fileId: existingId, fields: 'id, trashed' }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });
        if (res.data.id && !res.data.trashed) return res.data.id;
      } catch {
        // fall through and re-resolve / recreate below
      }
    }

    const found = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${DRIVE_BACKUP_FOLDER_NAME}' and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive',
      pageSize: 1,
    }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });
    const existing = found.data.files?.[0]?.id;
    if (existing) return existing;

    const created = await drive.files.create({
      requestBody: { name: DRIVE_BACKUP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id',
    }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });
    if (!created.data.id) throw new Error('Google Drive did not return a folder id');
    return created.data.id;
  }

  private async applyRetention(drive: ReturnType<typeof google.drive>, folderId: string, signal: AbortSignal): Promise<void> {
    this.throwIfStopping(signal);
    const retention = this.retentionFromSettings(this.readSettings());
    const files: { id: string; createdTime: string }[] = [];
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id, name, createdTime)',
        orderBy: 'createdTime',
        pageSize: 1000,
        pageToken,
        spaces: 'drive',
      }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });
      files.push(...(res.data.files || [])
        .filter((f): f is { id: string; name?: string | null; createdTime: string } => Boolean(f.id && f.createdTime))
        .map((f) => ({ id: f.id, createdTime: f.createdTime })));
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
    const toDelete = computeFilesToDelete(files, retention);
    // Keep a small bounded concurrency window: retention can involve many
    // files, but serial deletion needlessly prolongs backup completion.
    for (let i = 0; i < toDelete.length; i += 5) {
      await Promise.all(toDelete.slice(i, i + 5).map(async (id) => {
        try {
          await drive.files.delete({ fileId: id }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });
        } catch (err) {
          log.warn('[GoogleDrive] retention delete failed', id, (err as Error).message);
        }
      }));
    }
  }

  private retentionFromSettings(settings: Record<string, string>): number {
    const parsed = parseInt(settings.google_drive_retention_count || '', 10);
    if (Number.isInteger(parsed) && parsed >= MIN_RETENTION && parsed <= MAX_RETENTION) return parsed;
    return DEFAULT_RETENTION;
  }

  private throwIfStopping(signal?: AbortSignal): void {
    if (signal?.aborted || this.stopping) {
      throw createDriveShutdownError('Google Drive operation');
    }
  }

  // ── Loopback OAuth flow ────────────────────────────────────────────────

  private runLoopbackFlow(creds: { clientId: string; clientSecret: string }, signal?: AbortSignal): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      const state = crypto.randomBytes(16).toString('hex');
      let settled = false;
      let redirectUri = '';
      let abort: () => void = () => {};

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        try { server.close(); } catch { /* already closing */ }
        fn();
      };

      abort = () => finish(() => reject(new Error('Google Drive connection cancelled during shutdown')));

      const server = http.createServer((req, res) => {
        let reqUrl: URL;
        try {
          reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
        } catch {
          res.writeHead(400).end();
          return;
        }
        if (reqUrl.pathname !== '/oauth2callback') {
          res.writeHead(404).end();
          return;
        }

        const error = reqUrl.searchParams.get('error');
        const code = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          error || !code || returnedState !== state
            ? '<html><body>Google Drive connection failed. You can close this window and try again in Flo Cafe.</body></html>'
            : '<html><body>Google Drive connected. You can close this window and return to Flo Cafe.</body></html>'
        );

        if (error) return finish(() => reject(new Error(`Google authorization failed: ${error}`)));
        if (!code || returnedState !== state) return finish(() => reject(new Error('Invalid Google OAuth callback')));
        finish(() => resolve({ code, redirectUri }));
      });

      const timeout = setTimeout(() => {
        finish(() => reject(new Error('Timed out waiting for Google authorization')));
      }, LOOPBACK_TIMEOUT_MS);

      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });

      server.on('error', (err) => finish(() => reject(err)));

      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

        const authClient = new google.auth.OAuth2(creds.clientId, creds.clientSecret, redirectUri);
        const authUrl = authClient.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: [DRIVE_FILE_SCOPE],
          state,
        });

        if (!isSafeExternalUrl(authUrl)) {
          return finish(() => reject(new Error('Generated OAuth URL uses an unsafe protocol')));
        }
        shell.openExternal(authUrl).catch((err) => finish(() => reject(err)));
      });
    });
  }

  // ── Encrypted token storage (safeStorage, same pattern as master-pin.ts) ─

  private readTokens(): StoredTokens | null {
    try {
      const filePath = getTokenFilePath();
      if (!fs.existsSync(filePath)) return null;
      const encrypted = fs.readFileSync(filePath);
      const decrypted = safeStorage.decryptString(encrypted);
      const tokens = JSON.parse(decrypted) as StoredTokens;
      if (!tokens || (!tokens.access_token && !tokens.refresh_token)) return null;
      return tokens;
    } catch {
      return null;
    }
  }

  private writeTokens(tokens: StoredTokens): void {
    const encrypted = safeStorage.encryptString(JSON.stringify(tokens));
    fs.writeFileSync(getTokenFilePath(), encrypted, { mode: 0o600 });
  }

  private deleteTokens(): void {
    try {
      const filePath = getTokenFilePath();
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      log.warn('[GoogleDrive] failed to delete stored token', (err as Error).message);
    }
  }

  // ── Settings (non-secret prefs only — tokens never touch the DB) ────────

  private readSettings(): Record<string, string> {
    const db = getDatabase();
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const s: Record<string, string> = {};
    for (const row of rows) s[row.key] = row.value;
    return s;
  }

  private upsertSettings(entries: Record<string, string | undefined>): void {
    if (Object.keys(entries).length === 0) return;
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    for (const [key, value] of Object.entries(entries)) {
      if (value !== undefined) stmt.run(key, value, now());
    }
  }
}

export const googleDrive = new GoogleDriveService();

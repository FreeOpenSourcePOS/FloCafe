/** Optional Google Drive integration for automated, off-device DB backups via OAuth loopback. */

import { app, shell, safeStorage } from 'electron';
import { isSafeExternalUrl } from '../security/url-allowlist';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import log from 'electron-log';
import { auth as googleAuth, drive } from '@googleapis/drive';
import { getDatabase, now, createBackup } from '../db';
import { SHUTDOWN_TIMEOUT_MS } from '../shutdown';

// Use OAuth2 constructor from @googleapis/drive to avoid version mismatches.
type OAuth2Client = InstanceType<typeof googleAuth.OAuth2>;

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
  if (error instanceof AggregateError) {
    return error.errors.length > 0 && error.errors.every((nested) => isExpectedShutdownCancellation(nested));
  }
  const candidate = error as { code?: unknown; name?: unknown } | null;
  return candidate?.code === 'ERR_SHUTDOWN_ABORTED'
    || candidate?.code === 'ABORT_ERR'
    || candidate?.name === 'AbortError';
}

function cancelDriveOperation(operation: Promise<unknown>): void {
  const cancellable = operation as Promise<unknown> & { cancel?: () => void; abort?: () => void };
  try {
    if (typeof cancellable.cancel === 'function') cancellable.cancel();
    else if (typeof cancellable.abort === 'function') cancellable.abort();
  } catch { }
}

function waitForDriveOperation<T>(
  operationFactory: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
  trackOperation?: (operation: Promise<unknown>) => void,
  joinOnCancellation: () => boolean = () => false,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(createDriveShutdownError(label));
  const operationController = new AbortController();
  const operationSignal = signal ? AbortSignal.any([signal, operationController.signal]) : operationController.signal;
  let operation: Promise<T>;
  try {
    operation = operationFactory(operationSignal);
  } catch (error) {
    return Promise.reject(error);
  }
  trackOperation?.(operation);
  let timeout: NodeJS.Timeout | undefined;
  let cancellationTimeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  let operationSettled = false;
  let cancellationStarted = false;
  void operation.then(
    () => { operationSettled = true; },
    () => { operationSettled = true; },
  );
  void operation.catch(() => {});
  const cancellation = new Promise<never>((_resolve, reject) => {
    const rejectAfterOperation = (error: Error & { code: string }) => {
      if (cancellationStarted || operationSettled) return;
      cancellationStarted = true;
      operationController.abort();
      cancelDriveOperation(operation);
      if (!joinOnCancellation()) {
        reject(error);
        return;
      }
      const settleCancellation = () => {
        if (cancellationTimeout) clearTimeout(cancellationTimeout);
        reject(error);
      };
      cancellationTimeout = setTimeout(settleCancellation, timeoutMs);
      void operation.then(settleCancellation, settleCancellation);
    };
    const abort = () => rejectAfterOperation(createDriveShutdownError(label));
    onAbort = abort;
    if (signal?.aborted) {
      abort();
      return;
    }
    if (signal) signal.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => {
      rejectAfterOperation(createDriveShutdownError(label, true));
    }, timeoutMs);
  });
  return Promise.race([operation, cancellation]).finally(() => {
    if (timeout) clearTimeout(timeout);
    if (cancellationTimeout) clearTimeout(cancellationTimeout);
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

/** Computes which file IDs to delete based on retention limit and file timestamps. */
export function computeFilesToDelete(
  files: { id: string; createdTime: string }[],
  retentionCount: number
): string[] {
  const sorted = [...files].sort((a, b) => a.createdTime.localeCompare(b.createdTime));
  if (sorted.length <= retentionCount) return [];
  return sorted.slice(0, sorted.length - retentionCount).map((f) => f.id);
}

/** Determines if a scheduled backup is due based on interval and last backup timestamp. */
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
  private stopSettled = true;
  private terminalCleanup = false;
  private activeDriveOperations = new Set<Promise<unknown>>();
  private shutdownController = new AbortController();

  /** Arms the hourly schedule check. Never makes a network call by itself — see module doc comment. */
  start(): void {
    if (this.terminalCleanup || !this.stopSettled) return;
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    this.stopping = false;
    this.stopPromise = null;
    this.shutdownController = new AbortController();
    this.scheduleTimer = setInterval(() => void this.maybeRunScheduled(), SCHEDULE_CHECK_INTERVAL_MS);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopSettled = false;
    this.shutdownController.abort();
    this.backupAbortController?.abort();
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    if (!this.backupPromise && this.activeDriveOperations.size === 0) {
      this.stopSettled = true;
      this.stopPromise = Promise.resolve();
      return this.stopPromise;
    }
    const waitForWork = async (): Promise<void> => {
      const errors: unknown[] = [];
      while (this.backupPromise || this.activeDriveOperations.size > 0) {
        const work: Promise<unknown>[] = [...this.activeDriveOperations];
        if (this.backupPromise) work.push(this.backupPromise);
        const results = await Promise.allSettled(work);
        for (const result of results) {
          if (result.status === 'rejected') errors.push(result.reason);
        }
      }
      if (errors.length > 0) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Google Drive work failed');
    };
    const backup = waitForWork();
    void backup.catch(() => {});
    this.stopPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        this.terminalCleanup = true;
        this.backupAbortController?.abort();
        this.cancelActiveDriveOperations();
        settled = true;
        clearTimeout(timeout);
        const timeoutError = new Error(`Google Drive shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms`) as Error & { code: string };
        timeoutError.code = 'ERR_SHUTDOWN_TIMEOUT';
        reject(timeoutError);
      }, SHUTDOWN_TIMEOUT_MS);
      backup.then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.stopSettled = true;
          resolve();
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.stopSettled = true;
          if (this.stopping && isExpectedShutdownCancellation(error)) resolve();
          else reject(error);
        },
      );
    });
    return this.stopPromise;
  }

  private trackDriveOperation(operation: Promise<unknown>): void {
    this.activeDriveOperations.add(operation);
    void operation.finally(() => {
      this.activeDriveOperations.delete(operation);
      if (this.terminalCleanup && !this.backupPromise && this.activeDriveOperations.size === 0) this.stopSettled = true;
    }).catch(() => {});
  }

  private cancelActiveDriveOperations(): void {
    for (const operation of this.activeDriveOperations) cancelDriveOperation(operation);
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

  /** Connects to Google Drive using a loopback browser OAuth flow. */
  async connect(signal?: AbortSignal): Promise<GoogleDriveStatus> {
    if (this.stopping) throw new Error('Google Drive is stopping');
    const operationSignal = signal
      ? AbortSignal.any([signal, this.shutdownController.signal])
      : this.shutdownController.signal;
    const operation = this.connectInternal(operationSignal);
    this.trackDriveOperation(operation);
    return operation;
  }

  private async connectInternal(signal: AbortSignal): Promise<GoogleDriveStatus> {
    const creds = getClientCredentials();
    if (!creds) {
      throw new Error('Google Drive integration is not configured for this build');
    }
    if (!isSecureStorageAvailable()) {
      throw new Error('Secure storage is not available on this device — cannot safely store the Google Drive connection');
    }

    const { code, redirectUri } = await this.runLoopbackFlow(creds, signal);
    this.throwIfStopping(signal);
    const client = new googleAuth.OAuth2(creds.clientId, creds.clientSecret, redirectUri);
    const { tokens } = await waitForDriveOperation(() => client.getToken(code), signal, DRIVE_REQUEST_TIMEOUT_MS, 'Google Drive token exchange', (operation) => this.trackDriveOperation(operation), () => this.stopping);
    this.throwIfStopping(signal);
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
      if (this.stopping || signal.aborted) throw err;
      log.warn('[GoogleDrive] could not fetch account email', (err as Error).message);
    }

    let folderId: string | null = null;
    try {
      const driveClient = drive({ version: 'v3', auth: client });
      folderId = await this.ensureAppFolder(driveClient, signal);
    } catch (err) {
      if (this.stopping || signal.aborted) throw err;
      log.warn('[GoogleDrive] could not prepare app folder', (err as Error).message);
    }

    this.throwIfStopping(signal);

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
      if (this.terminalCleanup && this.activeDriveOperations.size === 0) this.stopSettled = true;
    }
  }

  private async runBackup(signal: AbortSignal): Promise<GoogleDriveStatus> {
    try {
      const client = await this.getAuthorizedClient(signal);
      this.throwIfStopping(signal);
      const driveClient = drive({ version: 'v3', auth: client });
      const folderId = await this.ensureAppFolder(driveClient, signal);

      this.throwIfStopping(signal);
      const { path: backupPath } = await waitForDriveOperation(
        (operationSignal) => createBackup(undefined, operationSignal),
        signal,
        SHUTDOWN_TIMEOUT_MS,
        'Google Drive local backup',
        (operation) => this.trackDriveOperation(operation),
        () => this.stopping,
      );
      const fileName = path.basename(backupPath);

      this.throwIfStopping(signal);
      await driveClient.files.create({
        requestBody: { name: fileName, parents: [folderId] },
        media: { mimeType: 'application/x-sqlite3', body: fs.createReadStream(backupPath) },
        fields: 'id',
      }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });
      this.throwIfStopping(signal);

      await this.applyRetention(driveClient, folderId, signal);

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

    const client = new googleAuth.OAuth2(creds.clientId, creds.clientSecret);
    client.setCredentials(tokens);
    // Persist refreshed OAuth tokens emitted transparently by google-auth-library.
    client.on('tokens', (refreshed) => {
      if (this.stopping || this.terminalCleanup || signal?.aborted) return;
      const merged = { ...this.readTokens(), ...refreshed };
      this.writeTokens(merged);
    });
    return client;
  }

  private async fetchAccountEmail(client: OAuth2Client, signal?: AbortSignal): Promise<string | null> {
    const accessToken = (await waitForDriveOperation(() => client.getAccessToken(), signal, DRIVE_REQUEST_TIMEOUT_MS, 'Google Drive access token refresh', (operation) => this.trackDriveOperation(operation), () => this.stopping)).token;
    if (!accessToken) return null;
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: requestSignal(signal, 8_000),
    });
    this.throwIfStopping(signal);
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { email?: string };
    this.throwIfStopping(signal);
    return data.email || null;
  }

  private async ensureAppFolder(driveClient: ReturnType<typeof drive>, signal?: AbortSignal): Promise<string> {
    this.throwIfStopping(signal);
    const existingId = this.readSettings().google_drive_folder_id;
    if (existingId) {
      // Confirm it still exists / is still visible to this scope before reusing it.
      try {
        const res = await driveClient.files.get({ fileId: existingId, fields: 'id, trashed' }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });
        this.throwIfStopping(signal);
        if (res.data.id && !res.data.trashed) return res.data.id;
      } catch {
        // fall through and re-resolve / recreate below
      }

      this.throwIfStopping(signal);
    }

    const found = await driveClient.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${DRIVE_BACKUP_FOLDER_NAME}' and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive',
      pageSize: 1,
    }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });
    this.throwIfStopping(signal);
    const existing = found.data.files?.[0]?.id;
    if (existing) return existing;

    const created = await driveClient.files.create({
      requestBody: { name: DRIVE_BACKUP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id',
    }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });
    this.throwIfStopping(signal);
    if (!created.data.id) throw new Error('Google Drive did not return a folder id');
    return created.data.id;
  }

  private async applyRetention(driveClient: ReturnType<typeof drive>, folderId: string, signal: AbortSignal): Promise<void> {
    this.throwIfStopping(signal);
    const retention = this.retentionFromSettings(this.readSettings());
    const files: { id: string; createdTime: string }[] = [];
    let pageToken: string | undefined;
    do {
      const res = await driveClient.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id, name, createdTime)',
        orderBy: 'createdTime',
        pageSize: 1000,
        pageToken,
        spaces: 'drive',
      }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });
      this.throwIfStopping(signal);
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
          this.throwIfStopping(signal);
          await driveClient.files.delete({ fileId: id }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });
        } catch (err) {
          if (this.stopping || signal.aborted) throw err;
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
    if (signal?.aborted || this.stopping || this.terminalCleanup) {
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

      abort = () => finish(() => reject(createDriveShutdownError('Google Drive connection')));

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

        const authClient = new googleAuth.OAuth2(creds.clientId, creds.clientSecret, redirectUri);
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

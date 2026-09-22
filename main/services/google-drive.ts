/** Optional Google Drive integration for offline-first, off-device DB backups. */

import { app, shell, safeStorage } from 'electron';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { once } from 'node:events';
import { auth as googleAuth, drive } from '@googleapis/drive';
import { isSafeExternalUrl } from '../security/url-allowlist';
import {
  abortDatabaseReplacementJournal,
  finalizeDatabaseReplacementJournal,
  getDatabaseReplacementJournal,
  createBackup,
  clearGoogleDriveRestoreBinding,
  getBackupMetadata,
  getCurrentSchemaVersion,
  getDatabase,
  isManagedBackupFile,
  now,
  restoreBackup,
  upsertSettings,
  withDatabaseMaintenanceLock,
} from '../db';
import type { DatabaseReplacementJournalHandle } from '../db';
import { SHUTDOWN_TIMEOUT_MS } from '../shutdown';
import { clearInMemoryRevokedTokens, clearUserAuthCache } from '../middleware/security';
import { clearJWTSecretCache } from '../routes/auth';

type OAuth2Client = InstanceType<typeof googleAuth.OAuth2>;
type DriveClient = ReturnType<typeof drive>;

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_BACKUP_FOLDER_NAME = 'FloCafe Backups';
export const DRIVE_RESTORE_CONFIRMATION = 'RESTORE GOOGLE DRIVE BACKUP';
export const DRIVE_WARNING_SETTING = 'google_drive_warning_acknowledged';

const DEFAULT_RETENTION = 7;
const MIN_RETENTION = 1;
const MAX_RETENTION = 100;
const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;
const SCHEDULE_CHECK_INTERVAL_MS = 60 * 60_000;
const LOOPBACK_TIMEOUT_MS = 5 * 60_000;
const DRIVE_REQUEST_TIMEOUT_MS = 30_000;
const GOOGLE_DRIVE_SNAPSHOT_TIMEOUT_MS = 30 * 60_000;
const STAGING_CLEANUP_RETRY_MS = 50;
const BACKUP_RETRY_BASE_MS = 5 * 60_000;
const BACKUP_RETRY_MAX_MS = 60 * 60_000;
const RESTORE_RECOVERY_RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;
const RETENTION_RETRY_BASE_MS = 5 * 60_000;
const RETENTION_RETRY_MAX_MS = 60 * 60_000;
const TOKEN_ENVELOPE_VERSION = 2;
const MARKER_VERSION = '1';

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
  cancellationTimeoutMs = timeoutMs,
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
  void operation.then(() => { operationSettled = true; }, () => { operationSettled = true; });
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
      cancellationTimeout = setTimeout(settleCancellation, cancellationTimeoutMs);
      void operation.then(settleCancellation, settleCancellation);
    };
    onAbort = () => rejectAfterOperation(createDriveShutdownError(label));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => rejectAfterOperation(createDriveShutdownError(label, true)), timeoutMs);
  });
  return Promise.race([operation, cancellation]).finally(() => {
    if (timeout) clearTimeout(timeout);
    if (cancellationTimeout) clearTimeout(cancellationTimeout);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  });
}

export type BackupFrequency = 'daily' | 'weekly';
export type BackupKind = 'automatic' | 'manual';
export type DriveJobState = 'queued' | 'snapshot_created' | 'uploading' | 'succeeded' | 'retention_pending' | 'failed' | 'offline_pending' | 'cancelled' | 'restoring';
export type DriveErrorCode =
  | 'configuration_unavailable'
  | 'secure_storage_unavailable'
  | 'not_connected'
  | 'reauth_required'
  | 'warning_acknowledgement_required'
  | 'destination_required'
  | 'destination_invalid'
  | 'permission_denied'
  | 'offline'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'local_snapshot_failed'
  | 'local_file_missing'
  | 'upload_failed'
  | 'duplicate_upload'
  | 'preferences_invalid'
  | 'restore_validation_failed'
  | 'restore_failed'
  | 'retention_pending'
  | 'conflict'
  | 'cancelled'
  | 'unknown';

export type GoogleDriveJob = {
  id: string;
  operation: 'backup' | 'restore';
  kind?: BackupKind;
  state: DriveJobState;
  bytes_sent?: number;
  total_bytes?: number;
  remote_id?: string;
  error_code?: DriveErrorCode;
  updated_at: string;
};

export type DatabaseReplacementCompletion = {
  committed: true;
  cleanupPending: boolean;
};

export type GoogleDriveStatus = {
  configured: boolean;
  secure_storage_available: boolean;
  connected: boolean;
  auth_state: 'configuration_unavailable' | 'storage_unavailable' | 'disconnected' | 'connected' | 'reauth_required';
  account_email: string | null;
  frequency: BackupFrequency;
  retention_count: number;
  destination_folder_id: string | null;
  destination_folder_name: string | null;
  last_backup_at: string | null;
  last_backup_status: 'success' | 'error' | null;
  last_error: DriveErrorCode | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_success_kind: BackupKind | null;
  next_retry_at: string | null;
  retention_status: 'ok' | 'pending' | 'error' | null;
  revoke_status: 'confirmed' | 'unconfirmed' | null;
  warning_acknowledged: boolean;
  warning_required: boolean;
  job: GoogleDriveJob | null;
};

export type GoogleDriveRemoteBackup = {
  id: string;
  name: string;
  kind: BackupKind;
  created_at: string;
  bytes: number;
  sha256: string;
  schema_version: number;
  app_version: string;
  destination_folder_id: string;
  compatible: boolean;
};

interface StoredTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  token_type?: string | null;
  id_token?: string | null;
  scope?: string;
}

interface StoredTokenEnvelope extends StoredTokens {
  version?: number;
  installation_id?: string;
  account_subject?: string;
  client_id_fingerprint?: string;
}

interface PendingUpload {
  run_id: string;
  kind: BackupKind;
  local_path: string;
  sha256: string;
  byte_count: number;
  schema_version: number;
  app_version: string;
  backup_created_at: string;
  destination_folder_id: string;
  attempt_count: number;
  next_retry_at: string | null;
}

interface SnapshotDescriptor {
  path: string;
  fileName: string;
  sha256: string;
  byteCount: number;
  schemaVersion: number;
  appVersion: string;
  backupCreatedAt: string;
}

type DriveError = Error & { code: DriveErrorCode; retryable?: boolean; destination_missing?: boolean };

const SAFE_ERROR_MESSAGES: Record<DriveErrorCode, string> = {
  configuration_unavailable: 'configuration_unavailable',
  secure_storage_unavailable: 'secure_storage_unavailable',
  not_connected: 'not_connected',
  reauth_required: 'reauth_required',
  warning_acknowledgement_required: 'warning_acknowledgement_required',
  destination_required: 'destination_required',
  destination_invalid: 'destination_invalid',
  permission_denied: 'permission_denied',
  offline: 'offline',
  rate_limited: 'rate_limited',
  quota_exceeded: 'quota_exceeded',
  local_snapshot_failed: 'local_snapshot_failed',
  local_file_missing: 'local_file_missing',
  upload_failed: 'upload_failed',
  duplicate_upload: 'duplicate_upload',
  preferences_invalid: 'preferences_invalid',
  restore_validation_failed: 'restore_validation_failed',
  restore_failed: 'restore_failed',
  retention_pending: 'retention_pending',
  conflict: 'conflict',
  cancelled: 'cancelled',
  unknown: 'unknown',
};

function createDriveError(code: DriveErrorCode, retryable = false): DriveError {
  const error = new Error(SAFE_ERROR_MESSAGES[code]) as DriveError;
  error.code = code;
  error.retryable = retryable;
  return error;
}

function providerStatus(error: unknown): number | null {
  const candidate = error as { response?: { status?: unknown }; status?: unknown } | null;
  const status = candidate?.response?.status ?? candidate?.status;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

function isMissingDestinationError(error: unknown): boolean {
  const candidate = error as { destination_missing?: unknown } | null;
  return candidate?.destination_missing === true || providerStatus(error) === 404;
}

function nextBackupRetryAt(attemptCount: number): string {
  const attempt = Number.isSafeInteger(attemptCount) && attemptCount > 0 ? attemptCount : 1;
  return new Date(Date.now() + Math.min(BACKUP_RETRY_MAX_MS, BACKUP_RETRY_BASE_MS * attempt)).toISOString();
}

export function getGoogleDriveErrorCode(error: unknown): DriveErrorCode {
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  if (candidate?.code && typeof candidate.code === 'string' && candidate.code in SAFE_ERROR_MESSAGES) return candidate.code as DriveErrorCode;
  if (candidate?.code === 'ERR_SHUTDOWN_ABORTED' || candidate?.name === 'AbortError') return 'cancelled';
  if (candidate?.code === 'ECONNRESET' || candidate?.code === 'ETIMEDOUT' || candidate?.code === 'EAI_AGAIN' || candidate?.code === 'ENETUNREACH' || candidate?.code === 'ENOTFOUND') return 'offline';
  const status = providerStatus(error);
  if (status === 401) return 'reauth_required';
  if (status === 429) return 'rate_limited';
  if (status === 507) return 'quota_exceeded';
  const message = typeof candidate?.message === 'string' ? candidate.message.toLowerCase() : '';
  const responseData = (error as { response?: { data?: unknown } } | null)?.response?.data;
  let providerMessage = '';
  try { providerMessage = JSON.stringify(responseData ?? '').toLowerCase(); } catch { }
  if (message.includes('invalid_grant') || message.includes('revoked')) return 'reauth_required';
  if (message.includes('quota') || message.includes('storage') || providerMessage.includes('quota') || providerMessage.includes('storage') || providerMessage.includes('dailylimit') || providerMessage.includes('ratelimit')) return 'quota_exceeded';
  if (status === 403) return 'permission_denied';
  if (message.includes('timeout') || message.includes('econn') || message.includes('enotfound') || message.includes('network')) return 'offline';
  return 'unknown';
}

function classifyDriveError(error: unknown): DriveError {
  if (isExpectedShutdownCancellation(error)) return createDriveError('cancelled');
  const status = providerStatus(error);
  const code = getGoogleDriveErrorCode(error);
  const retryable = (error as { retryable?: unknown } | null)?.retryable === true
    || code === 'offline'
    || code === 'rate_limited'
    || (status !== null && [408, 500, 502, 503, 504].includes(status));
  return createDriveError(code, retryable);
}

function getTokenFilePath(): string { return path.join(app.getPath('userData'), 'google-drive-token.enc'); }
function getInstallationMarkerPath(): string { return path.join(app.getPath('userData'), 'google-drive-installation.marker'); }
function getStagingDir(): string { return path.join(app.getPath('userData'), 'google-drive-staging'); }
function getRestoreInvalidationIntentPath(): string { return path.join(app.getPath('userData'), 'google-drive-restore.pending'); }
function getRestoreJobResultPath(): string { return path.join(app.getPath('userData'), 'google-drive-restore-result.json'); }

function syncRestoreIntentDirectory(directoryPath: string): boolean {
  try {
    const fd = fs.openSync(directoryPath, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return true;
  } catch {
    return false;
  }
}

function syncTokenFile(filePath: string): void {
  const fd = fs.openSync(filePath, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function persistRestoreJobResult(job: GoogleDriveJob): void {
  const resultPath = getRestoreJobResultPath();
  const tempPath = `${resultPath}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, JSON.stringify(job), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, resultPath);
    if (!syncRestoreIntentDirectory(path.dirname(resultPath)) && process.platform !== 'win32') throw new Error('Could not durably record restore job result');
  } catch (error) {
    if (fd !== null) try { fs.closeSync(fd); } catch { }
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { }
    throw error;
  }
}

function readRestoreJobResult(): GoogleDriveJob | null {
  try { return parseJob(fs.readFileSync(getRestoreJobResultPath(), 'utf8')); } catch { return null; }
}

function clearRestoreJobResult(): void {
  try {
    if (fs.existsSync(getRestoreJobResultPath())) fs.unlinkSync(getRestoreJobResultPath());
  } catch { }
}

function readCommittedRestoreJobResult(): GoogleDriveJob | null {
  if (!fs.existsSync(getRestoreInvalidationIntentPath())) return null;
  const replacement = getDatabaseReplacementJournal();
  if (replacement?.phase !== 'committed') return null;
  try {
    const intent = parseJson<{ job_id?: unknown }>(fs.readFileSync(getRestoreInvalidationIntentPath(), 'utf8'));
    const jobId = intent?.job_id;
    if (!safeId(jobId)) return null;
    return { id: jobId, operation: 'restore', state: 'succeeded', updated_at: new Date().toISOString() };
  } catch {
    return null;
  }
}

function getClientCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET?.trim();
  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  }

  if (process.env.ELECTRON_RUN_AS_NODE !== '1') {
    try {
      const configPath = path.join(__dirname, '../../google-drive-client.json');
      if (fs.existsSync(configPath)) {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (parsed.clientId?.trim() && parsed.clientSecret?.trim()) {
          return { clientId: parsed.clientId.trim(), clientSecret: parsed.clientSecret.trim() };
        }
      }
    } catch {
      // Fall through to null on read or parse error
    }
  }

  return null;
}

export function isGoogleDriveConfigured(): boolean { return getClientCredentials() !== null; }

function isSecureStorageAvailable(): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const backend = typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : null;
    return !backend || !['basic_text', ''].includes(backend);
  } catch { return false; }
}

export function isBackupDue(lastBackupAtIso: string | null, frequency: BackupFrequency, nowMs = Date.now()): boolean {
  if (!lastBackupAtIso) return true;
  const last = new Date(lastBackupAtIso).getTime();
  if (Number.isNaN(last)) return true;
  return nowMs - last >= (frequency === 'weekly' ? WEEK_MS : DAY_MS);
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

function isSafeGoogleAuthorizationUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return isSafeExternalUrl(rawUrl) && parsed.protocol === 'https:' && parsed.hostname === 'accounts.google.com'
      && parsed.pathname === '/o/oauth2/v2/auth' && !parsed.username && !parsed.password && !parsed.port;
  } catch { return false; }
}

function compareAppVersions(left: string, right: string): number | null {
  const parse = (value: string): number[] | null => {
    const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value.trim());
    return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return left === right ? 0 : null;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

function safeId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value); }

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function parseJob(value: string | undefined): GoogleDriveJob | null {
  const parsed = parseJson<GoogleDriveJob>(value);
  return parsed && typeof parsed.id === 'string' && typeof parsed.operation === 'string' && typeof parsed.state === 'string' ? parsed : null;
}

function parsePending(value: string | undefined): PendingUpload | null {
  const parsed = parseJson<PendingUpload>(value);
  if (!parsed || !safeId(parsed.run_id) || !['automatic', 'manual'].includes(parsed.kind) || typeof parsed.local_path !== 'string'
    || !/^[a-f0-9]{64}$/.test(parsed.sha256) || !Number.isSafeInteger(parsed.byte_count)
    || (parsed.destination_folder_id !== '' && !safeId(parsed.destination_folder_id))) return null;
  return parsed;
}

function isDriveStagingFile(filePath: string, prefix: 'upload' | 'download'): boolean {
  if (typeof filePath !== 'string') return false;
  const fileName = path.basename(filePath);
  if (!fileName.startsWith(`${prefix}-`) || !fileName.endsWith('.db')) return false;
  try {
    const resolved = fs.realpathSync(filePath);
    const stagingDir = fs.realpathSync(getStagingDir());
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() && resolved.startsWith(stagingDir + path.sep);
  } catch { return false; }
}

function isUploadStagingFile(filePath: string): boolean { return isDriveStagingFile(filePath, 'upload'); }
function isDownloadStagingFile(filePath: string): boolean { return isDriveStagingFile(filePath, 'download'); }

function createUploadStagingPath(): string {
  fs.mkdirSync(getStagingDir(), { recursive: true, mode: 0o700 });
  return path.join(getStagingDir(), `upload-${crypto.randomUUID()}.db`);
}

function removeStagingFile(filePath: string): void {
  if (!isUploadStagingFile(filePath) && !isDownloadStagingFile(filePath)) return;
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    try { if (fs.existsSync(candidate)) fs.unlinkSync(candidate); } catch { }
  }
}

async function removeDownloadStagingFileWithRetry(filePath: string): Promise<void> {
  if (!isDownloadStagingFile(filePath)) return;
  const candidates = [filePath, `${filePath}-wal`, `${filePath}-shm`];
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (true) {
    for (const candidate of candidates) {
      try { if (fs.existsSync(candidate)) fs.unlinkSync(candidate); } catch { }
    }
    if (!candidates.some((candidate) => fs.existsSync(candidate)) || Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, STAGING_CLEANUP_RETRY_MS));
  }
}

async function hashBackupFile(filePath: string): Promise<{ sha256: string; byteCount: number }> {
  if (!isManagedBackupFile(filePath) && !isUploadStagingFile(filePath)) throw createDriveError('local_file_missing');
  const entry = fs.lstatSync(filePath);
  if (entry.isSymbolicLink() || !entry.isFile() || fs.existsSync(`${filePath}-wal`) || fs.existsSync(`${filePath}-shm`)) throw createDriveError('local_file_missing');
  const initial = fs.statSync(filePath);
  const hash = crypto.createHash('sha256');
  let byteCount = 0;
  const stream = fs.createReadStream(filePath, { flags: 'r' });
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteCount += buffer.byteLength;
      hash.update(buffer);
    }
  } finally { stream.destroy(); }
  const final = fs.statSync(filePath);
  if (initial.size !== final.size || initial.mtimeMs !== final.mtimeMs || byteCount !== final.size) throw createDriveError('local_file_missing');
  return { sha256: hash.digest('hex'), byteCount };
}

class GoogleDriveService {
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private backingUp = false;
  private backupPromise: Promise<GoogleDriveStatus> | null = null;
  private backupAbortController: AbortController | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private stopSettled = true;
  private terminalCleanup = false;
  private operationRunning = false;
  private operationTail: Promise<void> = Promise.resolve();
  private queuedOperationControllers = new Set<AbortController>();
  private activeDriveOperations = new Set<Promise<unknown>>();
  private activeJobs = new Set<Promise<unknown>>();
  private jobControllers = new Map<string, AbortController>();
  private shutdownController = new AbortController();
  private databaseRestorePending = false;
  private restoreInvalidationCleanupPending = false;
  private restoreRecoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreRecoveryRetryCount = 0;
  private tokenReadIssue: 'corrupt' | 'persistence_ambiguous' | null = null;

  private restoreInvalidationIntentExists(): boolean {
    try { return fs.existsSync(getRestoreInvalidationIntentPath()); } catch { return true; }
  }

  private persistRestoreInvalidationIntent(jobId?: string): void {
    const intentPath = getRestoreInvalidationIntentPath();
    const tempPath = `${intentPath}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    const baseline = this.databaseAccountSubject();
    const intent = {
      phase: 'prepared',
      ...(jobId ? { job_id: jobId } : {}),
      ...(baseline.known ? { database_account_subject: baseline.value } : {}),
    };
    let fd: number | null = null;
    try {
      fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      fs.writeFileSync(fd, JSON.stringify(intent), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tempPath, intentPath);
      if (!syncRestoreIntentDirectory(path.dirname(intentPath)) && process.platform !== 'win32') throw new Error('Could not durably record restore invalidation intent');
    } catch (error) {
      if (fd !== null) try { fs.closeSync(fd); } catch { }
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { }
      throw error;
    }
  }

  private clearRestoreInvalidationIntent(): void {
    const intentPath = getRestoreInvalidationIntentPath();
    try {
      if (fs.existsSync(intentPath)) fs.unlinkSync(intentPath);
      if (!syncRestoreIntentDirectory(path.dirname(intentPath)) && process.platform !== 'win32') throw new Error('Could not durably clear restore invalidation intent');
    } catch (error) {
      this.restoreInvalidationCleanupPending = true;
      this.scheduleRestoreRecoveryRetry();
      throw error;
    }
    this.restoreInvalidationCleanupPending = false;
    if (this.restoreRecoveryRetryTimer) clearTimeout(this.restoreRecoveryRetryTimer);
    this.restoreRecoveryRetryTimer = null;
    this.restoreRecoveryRetryCount = 0;
  }

  private restoreInvalidationActive(): boolean {
    if (this.databaseRestorePending || this.restoreInvalidationCleanupPending) return true;
    if (!this.restoreInvalidationIntentExists()) return false;
    this.databaseRestorePending = true;
    return true;
  }

  private scheduleRestoreRecoveryRetry(): void {
    if (this.restoreRecoveryRetryTimer || this.restoreRecoveryRetryCount >= RESTORE_RECOVERY_RETRY_DELAYS_MS.length || this.stopping) return;
    const delay = RESTORE_RECOVERY_RETRY_DELAYS_MS[this.restoreRecoveryRetryCount++];
    this.restoreRecoveryRetryTimer = setTimeout(() => {
      this.restoreRecoveryRetryTimer = null;
      this.recoverDatabaseRestoreInvalidation();
      if (this.restoreInvalidationActive()) this.scheduleRestoreRecoveryRetry();
      else this.start();
    }, delay);
    this.restoreRecoveryRetryTimer.unref?.();
  }

  private databaseRestoreRecoveryDecision(): 'committed' | 'recovered' | 'ambiguous' {
    if (this.tokenReadIssue === 'persistence_ambiguous') return 'ambiguous';
    let tokenFilePresent = false;
    try { tokenFilePresent = fs.existsSync(getTokenFilePath()); } catch { return 'ambiguous'; }
    const envelope = this.readTokenEnvelope();
    if (!tokenFilePresent) return 'recovered';
    if (this.tokenReadIssue === 'corrupt' || !envelope) return 'ambiguous';
    const tokenState = envelope.account_subject && envelope.installation_id ? 'bound' : 'legacy';
    const current = this.databaseAccountSubject();
    if (!current.known) return 'ambiguous';
    const intent = this.restoreInvalidationIntent();
    if (intent.known) {
      if (intent.value === null) return 'ambiguous';
      return current.value === intent.value ? 'recovered' : 'committed';
    }
    if (tokenState === 'legacy') return current.value ? 'recovered' : 'ambiguous';
    return current.value === envelope.account_subject ? 'recovered' : 'ambiguous';
  }

  private databaseAccountSubject(): { known: boolean; value: string | null } {
    try {
      const row = getDatabase().prepare("SELECT value FROM settings WHERE key = 'google_drive_account_subject'").get() as { value?: unknown } | undefined;
      return { known: true, value: typeof row?.value === 'string' && row.value.trim() ? row.value : null };
    } catch {
      return { known: false, value: null };
    }
  }

  private restoreInvalidationIntent(): { known: boolean; value: string | null } {
    try {
      const parsed = parseJson<{ database_account_subject?: unknown }>(fs.readFileSync(getRestoreInvalidationIntentPath(), 'utf8'));
      if (!parsed || !Object.prototype.hasOwnProperty.call(parsed, 'database_account_subject')) return { known: false, value: null };
      if (parsed.database_account_subject !== null && typeof parsed.database_account_subject !== 'string') return { known: false, value: null };
      return { known: true, value: parsed.database_account_subject };
    } catch {
      return { known: false, value: null };
    }
  }

  private activateDatabaseRestoreInvalidation(jobId?: string): void {
    this.databaseRestorePending = true;
    this.restoreInvalidationCleanupPending = false;
    try {
      this.persistRestoreInvalidationIntent(jobId);
    } catch (error) {
      if (!this.restoreInvalidationIntentExists()) this.databaseRestorePending = false;
      else {
        this.restoreInvalidationCleanupPending = true;
        this.scheduleRestoreRecoveryRetry();
      }
      throw error;
    }
  }

  private recoverDatabaseRestoreInvalidation(): void {
    const replacement = getDatabaseReplacementJournal();
    const intentExists = this.restoreInvalidationIntentExists();
    if (!intentExists && replacement?.phase !== 'committed' && !this.restoreInvalidationCleanupPending) return;
    this.databaseRestorePending = true;
    try {
      if (replacement?.phase === 'committed') {
        this.invalidateAfterDatabaseRestore(replacement);
        return;
      }
      const decision = this.databaseRestoreRecoveryDecision();
      if (decision === 'committed') this.invalidateAfterDatabaseRestore(null);
      else if (decision === 'recovered') this.clearDatabaseRestoreInvalidation();
      else {
        this.restoreInvalidationCleanupPending = true;
        this.scheduleRestoreRecoveryRetry();
      }
    } catch (error) {
      console.error('[Google Drive] Restore invalidation recovery failed:', error);
      this.restoreInvalidationCleanupPending = true;
      this.scheduleRestoreRecoveryRetry();
    }
  }

  private reconcilePersistedJob(): void {
    const settings = this.readSettings();
    const job = parseJob(settings.google_drive_job);
    if (!job || !['queued', 'snapshot_created', 'uploading', 'retention_pending', 'restoring'].includes(job.state)) return;
    if (job.operation === 'backup') {
      const pending = parsePending(settings.google_drive_pending_upload);
      const paused = ['destination_required', 'destination_invalid', 'reauth_required', 'permission_denied', 'duplicate_upload'].includes(settings.google_drive_last_error_code);
      if (job.state === 'retention_pending') {
        if (settings.google_drive_retention_status !== 'pending') upsertSettings({ google_drive_retention_status: 'pending', google_drive_next_retry_at: '', google_drive_last_error_code: 'retention_pending' });
        return;
      }
      if (pending) {
        const storedRetryAt = pending.next_retry_at || settings.google_drive_next_retry_at || '';
        const retryAt = paused
          ? null
          : Number.isFinite(Date.parse(storedRetryAt))
            ? storedRetryAt
            : nextBackupRetryAt(pending.attempt_count || 1);
        pending.next_retry_at = retryAt;
        upsertSettings({ google_drive_pending_upload: JSON.stringify(pending), google_drive_next_retry_at: retryAt || '' });
        this.writeJob({ ...job, state: paused ? 'failed' : 'offline_pending', error_code: paused ? settings.google_drive_last_error_code as DriveErrorCode : 'unknown', updated_at: now() });
      } else {
        this.writeJob({ ...job, state: 'failed', error_code: 'unknown', updated_at: now() });
      }
      return;
    }
    const completedRestore = readRestoreJobResult() || readCommittedRestoreJobResult();
    this.writeJob(completedRestore?.id === job.id ? completedRestore : { ...job, state: 'failed', error_code: 'restore_failed', updated_at: now() });
  }

  private armScheduling(): void {
    if (this.scheduleTimer || this.stopping || this.terminalCleanup || !this.stopSettled) return;
    this.scheduleTimer = setInterval(() => { void this.maybeRunScheduled().catch(() => {}); }, SCHEDULE_CHECK_INTERVAL_MS);
    this.scheduleTimer.unref?.();
    this.cleanupStaging();
    this.startupTimer = setTimeout(() => { this.startupTimer = null; void this.maybeRunScheduled().catch(() => {}); }, 0);
    this.startupTimer.unref?.();
  }

  start(): void {
    if (this.terminalCleanup || !this.stopSettled) return;
    if (this.scheduleTimer) { clearInterval(this.scheduleTimer); this.scheduleTimer = null; }
    if (this.startupTimer) { clearTimeout(this.startupTimer); this.startupTimer = null; }
    if (this.restoreRecoveryRetryTimer) clearTimeout(this.restoreRecoveryRetryTimer);
    this.restoreRecoveryRetryTimer = null;
    this.stopping = false;
    this.stopPromise = null;
    this.shutdownController = new AbortController();
    this.reconcilePersistedJob();
    this.recoverDatabaseRestoreInvalidation();
    if (this.restoreInvalidationActive()) return;
    this.armScheduling();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopSettled = false;
    this.shutdownController.abort();
    this.backupAbortController?.abort();
    this.abortQueuedDriveOperations();
    for (const controller of this.jobControllers.values()) controller.abort();
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.restoreRecoveryRetryTimer) clearTimeout(this.restoreRecoveryRetryTimer);
    this.restoreRecoveryRetryTimer = null;
    this.scheduleTimer = null;
    this.startupTimer = null;
    if (!this.backupPromise && this.queuedOperationControllers.size === 0 && this.activeDriveOperations.size === 0 && this.activeJobs.size === 0) {
      this.stopSettled = true;
      this.stopPromise = Promise.resolve();
      return this.stopPromise;
    }
    const waitForWork = async (): Promise<void> => {
      const errors: unknown[] = [];
      while (this.backupPromise || this.queuedOperationControllers.size > 0 || this.activeDriveOperations.size > 0 || this.activeJobs.size > 0) {
        const work: Promise<unknown>[] = [...this.activeDriveOperations, ...this.activeJobs];
        if (this.backupPromise) work.push(this.backupPromise);
        if (this.queuedOperationControllers.size > 0) work.push(this.operationTail);
        const results = await Promise.allSettled(work);
        for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
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
        this.abortQueuedDriveOperations();
        this.cancelActiveDriveOperations();
        settled = true;
        this.stopSettled = true;
        reject(createDriveShutdownError('Google Drive shutdown', true));
      }, SHUTDOWN_TIMEOUT_MS);
      backup.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.stopSettled = true;
        resolve();
      }, (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.stopSettled = true;
        if (this.stopping && isExpectedShutdownCancellation(error)) resolve();
        else reject(error);
      });
    });
    return this.stopPromise;
  }

  private trackDriveOperation(operation: Promise<unknown>): void {
    this.activeDriveOperations.add(operation);
    void operation.finally(() => this.activeDriveOperations.delete(operation)).catch(() => {});
  }

  private trackJob(operation: Promise<unknown>): void {
    this.activeJobs.add(operation);
    void operation.finally(() => this.activeJobs.delete(operation)).catch(() => {});
  }

  private cancelActiveDriveOperations(): void { for (const operation of this.activeDriveOperations) cancelDriveOperation(operation); }

  private abortQueuedDriveOperations(): void { for (const controller of this.queuedOperationControllers) controller.abort(); }

  private async abortAndAwaitActiveDriveOperations(): Promise<void> {
    while (this.activeDriveOperations.size > 0) {
      const operations = [...this.activeDriveOperations];
      this.cancelActiveDriveOperations();
      await Promise.allSettled(operations);
    }
  }

  private queueOperation<T>(operation: (signal: AbortSignal) => Promise<T>, allowDuringStop = false, allowDuringRestore = false, jobId?: string): Promise<T> {
    const controller = new AbortController();
    this.queuedOperationControllers.add(controller);
    const run = this.operationTail.catch(() => {}).then(async () => {
      if (this.restoreInvalidationActive() && !allowDuringRestore) throw createDriveError('conflict');
      if (this.stopping && !allowDuringStop) throw createDriveShutdownError('Google Drive operation');
      if (controller.signal.aborted) throw createDriveShutdownError('Google Drive operation');
      this.operationRunning = true;
      try { return await operation(controller.signal); } finally { this.operationRunning = false; }
    });
    this.operationTail = run.then(() => undefined, () => undefined);
    void run.catch((error) => {
      if (jobId) this.finalizeQueuedJob(jobId, error);
    }).finally(() => this.queuedOperationControllers.delete(controller)).catch(() => {});
    return run;
  }

  private finalizeQueuedJob(jobId: string, error: unknown): void {
    try {
      const job = parseJob(this.readSettings().google_drive_job);
      if (!job || job.id !== jobId || job.state !== 'queued') return;
      const classified = classifyDriveError(error);
      this.writeJob({ ...job, state: classified.code === 'cancelled' ? 'cancelled' : 'failed', error_code: classified.code, updated_at: now() });
    } catch { }
  }

  private async maybeRunScheduled(): Promise<void> {
    if (this.stopping || this.restoreInvalidationActive() || this.operationRunning || this.backingUp || this.activeJobs.size > 0) return;
    const settings = this.readSettings();
    if (settings.google_drive_revoke_status === 'unconfirmed') return;
    const tokenEnvelope = this.readTokenEnvelope();
    if (!settings.google_drive_account_subject || this.tokenReadIssue || !tokenEnvelope?.refresh_token) return;
    const pending = parsePending(settings.google_drive_pending_upload);
    if (pending) {
      if (settings.google_drive_retention_status === 'pending') {
        try { await this.backupNow(undefined, pending.kind); } catch { }
        return;
      }
      if (['destination_required', 'destination_invalid', 'reauth_required', 'permission_denied', 'duplicate_upload'].includes(settings.google_drive_last_error_code)) return;
      const retryAt = Date.parse(settings.google_drive_next_retry_at || pending.next_retry_at || '');
      if (!Number.isFinite(retryAt)) {
        const nextRetryAt = nextBackupRetryAt(pending.attempt_count);
        pending.next_retry_at = nextRetryAt;
        upsertSettings({ google_drive_pending_upload: JSON.stringify(pending), google_drive_next_retry_at: nextRetryAt });
        return;
      }
      if (retryAt > Date.now()) return;
      try { await this.backupNow(undefined, pending.kind); } catch { }
      return;
    }
    if (settings.google_drive_retention_status === 'pending') {
      const retryAt = Date.parse(settings.google_drive_next_retry_at || '');
      if (!Number.isFinite(retryAt) || retryAt <= Date.now()) {
        try { await this.retryPendingRetention(); } catch { }
        return;
      }
    }
    const frequency: BackupFrequency = settings.google_drive_frequency === 'weekly' ? 'weekly' : 'daily';
    if (!isBackupDue(settings.google_drive_last_automatic_backup_at || null, frequency)) return;
    try { await this.backupNow(undefined, 'automatic'); } catch { }
  }

  getStatus(): GoogleDriveStatus {
    const settings = this.readSettings();
    const configured = isGoogleDriveConfigured();
    const secureStorage = isSecureStorageAvailable();
    const marker = this.ensureInstallationMarker();
    const envelope = this.readTokenEnvelope();
    const tokenPresent = Boolean(envelope && (envelope.refresh_token || envelope.access_token));
    const tokenConnected = Boolean(envelope?.refresh_token && envelope.installation_id === marker);
    const credentials = getClientCredentials();
    const clientIdFingerprint = credentials ? crypto.createHash('sha256').update(credentials.clientId).digest('hex').slice(0, 16) : '';
    const accountBound = Boolean(tokenConnected && envelope?.account_subject && settings.google_drive_account_subject && envelope.account_subject === settings.google_drive_account_subject && envelope.client_id_fingerprint === clientIdFingerprint);
    const revocationPending = settings.google_drive_revoke_status === 'unconfirmed';
    const reauthRequired = settings.google_drive_last_error_code === 'reauth_required';
    const restoreRecoveryPending = this.restoreInvalidationCleanupPending;
    const connected = tokenConnected && accountBound && !reauthRequired && !revocationPending && !restoreRecoveryPending;
    const authState: GoogleDriveStatus['auth_state'] = !configured ? 'configuration_unavailable' : !secureStorage ? 'storage_unavailable' : restoreRecoveryPending || this.tokenReadIssue || reauthRequired || (tokenPresent && !accountBound) ? 'reauth_required' : revocationPending ? 'disconnected' : connected ? 'connected' : 'disconnected';
    const retention = this.retentionFromSettings(settings);
    const lastBackupStatus = settings.google_drive_last_backup_status === 'success' || settings.google_drive_last_backup_status === 'error' ? settings.google_drive_last_backup_status : null;
    const lastBackupAt = lastBackupStatus === 'error'
      ? settings.google_drive_last_attempt_at || settings.google_drive_last_success_at || settings.google_drive_last_backup_at || null
      : settings.google_drive_last_success_at || settings.google_drive_last_backup_at || null;
    return {
      configured,
      secure_storage_available: secureStorage,
      connected,
      auth_state: authState,
      account_email: settings.google_drive_account_email || null,
      frequency: settings.google_drive_frequency === 'weekly' ? 'weekly' : 'daily',
      retention_count: retention,
      destination_folder_id: settings.google_drive_destination_folder_id || settings.google_drive_folder_id || null,
      destination_folder_name: settings.google_drive_destination_folder_name || (connected ? this.resolveBackupFolderName() : null),
      last_backup_at: lastBackupAt,
      last_backup_status: lastBackupStatus,
      last_error: (settings.google_drive_last_error_code as DriveErrorCode) || null,
      last_attempt_at: settings.google_drive_last_attempt_at || null,
      last_success_at: settings.google_drive_last_success_at || null,
      last_success_kind: settings.google_drive_last_success_kind === 'automatic' || settings.google_drive_last_success_kind === 'manual' ? settings.google_drive_last_success_kind : null,
      next_retry_at: settings.google_drive_next_retry_at || null,
      retention_status: settings.google_drive_retention_status === 'pending' ? 'pending' : settings.google_drive_retention_status === 'error' ? 'error' : settings.google_drive_last_success_at ? 'ok' : null,
      revoke_status: settings.google_drive_revoke_status === 'confirmed' || settings.google_drive_revoke_status === 'unconfirmed' ? settings.google_drive_revoke_status : null,
      warning_acknowledged: settings[DRIVE_WARNING_SETTING] === 'true',
      warning_required: settings[DRIVE_WARNING_SETTING] !== 'true',
      job: parseJob(settings.google_drive_job) || readRestoreJobResult() || readCommittedRestoreJobResult(),
    };
  }

  private statusWithJobFallback(job: GoogleDriveJob, fallback: GoogleDriveStatus | null): GoogleDriveStatus {
    if (fallback) {
      return this.restoreInvalidationCleanupPending
        ? { ...fallback, connected: false, auth_state: fallback.configured ? fallback.secure_storage_available ? 'reauth_required' : fallback.auth_state : fallback.auth_state, job }
        : { ...fallback, job };
    }
    return {
      configured: isGoogleDriveConfigured(),
      secure_storage_available: isSecureStorageAvailable(),
      connected: false,
      auth_state: 'disconnected',
      account_email: null,
      frequency: 'daily',
      retention_count: DEFAULT_RETENTION,
      destination_folder_id: null,
      destination_folder_name: null,
      last_backup_at: null,
      last_backup_status: null,
      last_error: null,
      last_attempt_at: null,
      last_success_at: null,
      last_success_kind: null,
      next_retry_at: null,
      retention_status: null,
      revoke_status: null,
      warning_acknowledged: false,
      warning_required: true,
      job,
    };
  }

  updatePreferences(input: { frequency?: string; retention_count?: number | string }): GoogleDriveStatus {
    if (this.operationRunning) throw createDriveError('conflict');
    const updates: Record<string, string> = {};
    if (input.frequency !== undefined) {
      if (input.frequency !== 'daily' && input.frequency !== 'weekly') throw createDriveError('preferences_invalid');
      updates.google_drive_frequency = input.frequency;
    }
    const rawRetention = input.retention_count;
    if (rawRetention !== undefined) {
      const n = Number(rawRetention);
      if (!Number.isInteger(n) || n < MIN_RETENTION || n > MAX_RETENTION) throw createDriveError('preferences_invalid');
      updates.google_drive_retention_count = String(n);
    }
    upsertSettings(updates);
    return this.getStatus();
  }

  acknowledgeWarning(): GoogleDriveStatus {
    upsertSettings({ [DRIVE_WARNING_SETTING]: 'true' });
    return this.getStatus();
  }

  async connect(signal?: AbortSignal, allowSwitch = false, warningAcknowledged = false): Promise<GoogleDriveStatus> {
    if (signal?.aborted) throw createDriveShutdownError('Google Drive connection');
    const allowRestoreRecovery = this.restoreInvalidationCleanupPending;
    return this.queueOperation((operationSignal) => this.connectInternal(signal ? AbortSignal.any([signal, operationSignal]) : operationSignal, allowSwitch, warningAcknowledged, allowRestoreRecovery), false, allowRestoreRecovery);
  }

  private async connectInternal(signal: AbortSignal | undefined, allowSwitch: boolean, warningAcknowledged: boolean, allowRestoreRecovery: boolean): Promise<GoogleDriveStatus> {
    const creds = getClientCredentials();
    if (!creds) throw createDriveError('configuration_unavailable');
    if (!isSecureStorageAvailable()) throw createDriveError('secure_storage_unavailable');
    if (!warningAcknowledged && this.readSettings()[DRIVE_WARNING_SETTING] !== 'true') throw createDriveError('warning_acknowledgement_required');
    const current = this.readTokenEnvelope();
    const settings = this.readSettings();
    if (settings.google_drive_revoke_status === 'unconfirmed') throw createDriveError('not_connected');
    const reauthRequired = settings.google_drive_last_error_code === 'reauth_required';
    if (current && (current.refresh_token || current.access_token) && current.account_subject && settings.google_drive_account_subject && !allowSwitch && !reauthRequired) throw createDriveError('conflict');
    const marker = this.ensureInstallationMarker();
    const { code, redirectUri, verifier } = await this.runLoopbackFlow(creds, signal);
    this.throwIfStopping(signal);
    const client = new googleAuth.OAuth2(creds.clientId, creds.clientSecret, redirectUri);
    const tokenResult = await waitForDriveOperation(() => (client as OAuth2Client & { getToken: (options: unknown) => Promise<{ tokens: StoredTokens }> }).getToken({ code, codeVerifier: verifier }), signal, DRIVE_REQUEST_TIMEOUT_MS, 'Google Drive token exchange');
    const tokens = tokenResult.tokens;
    if (!tokens.refresh_token) throw createDriveError('reauth_required');
    client.setCredentials(tokens);
    const identity = await this.fetchAccountIdentity(client, signal);
    if (!identity.subject) throw createDriveError('reauth_required');
    const candidateDrive = drive({ version: 'v3', auth: client });
    const existingSubjects = [current?.account_subject, settings.google_drive_account_subject].filter((subject): subject is string => typeof subject === 'string' && subject.length > 0);
    if (!allowSwitch && existingSubjects.some((subject) => subject !== identity.subject)) throw createDriveError('reauth_required');
    const preservedDestinations = this.readOwnedDestinations();
    const destinationCandidates = [...new Set([
      settings.google_drive_destination_folder_id || settings.google_drive_folder_id,
      ...preservedDestinations,
    ].filter((value): value is string => Boolean(value) && safeId(value)))];
    let destination: { id: string; name: string; owned: boolean } | null = null;
    for (const folderId of destinationCandidates) {
      try {
        destination = await this.validateDestination(candidateDrive, folderId, marker, signal);
        break;
      } catch (error) {
        this.throwIfStopping(signal);
        const classified = classifyDriveError(error);
        if (classified.code !== 'destination_invalid' && !isMissingDestinationError(error)) throw classified;
      }
    }
    if (!destination) {
      destination = await this.findExistingAppFolder(candidateDrive, marker, signal);
    }
    if (!destination) {
      destination = await this.createAppFolder(candidateDrive, marker, signal);
    }
    if (allowRestoreRecovery) {
      const replacement = getDatabaseReplacementJournal();
      if (replacement?.phase === 'prepared') {
        this.restoreInvalidationCleanupPending = true;
        this.scheduleRestoreRecoveryRetry();
        throw new Error('Prepared database replacement recovery remains pending');
      }
      if (replacement?.phase === 'committed') {
        try {
          finalizeDatabaseReplacementJournal(replacement);
        } catch (error) {
          this.restoreInvalidationCleanupPending = true;
          this.scheduleRestoreRecoveryRetry();
          throw error;
        }
      }
    }
    this.throwIfStopping(signal);
    this.writeTokens({ ...tokens, version: TOKEN_ENVELOPE_VERSION, installation_id: marker, account_subject: identity.subject, client_id_fingerprint: crypto.createHash('sha256').update(creds.clientId).digest('hex').slice(0, 16) });
    this.tokenReadIssue = null;
    upsertSettings({ [DRIVE_WARNING_SETTING]: warningAcknowledged ? 'true' : settings[DRIVE_WARNING_SETTING] || 'false', google_drive_account_subject: identity.subject, google_drive_account_email: identity.email || '', google_drive_destination_folder_id: destination.id, google_drive_destination_folder_name: destination.name, google_drive_folder_id: destination.id, google_drive_last_error_code: '', google_drive_revoke_status: '' });
    this.rememberDestination(destination.id);
    if (allowRestoreRecovery) {
      this.clearRestoreInvalidationIntent();
      this.databaseRestorePending = false;
      this.armScheduling();
    }
    return this.getStatus();
  }

  async disconnect(): Promise<GoogleDriveStatus> {
    return this.queueOperation(async (signal) => {
      const settings = this.readSettings();
      const cleanupPending = settings.google_drive_revoke_cleanup_pending === 'true';
      const envelope = this.readTokenEnvelope();
      if (this.tokenReadIssue && !cleanupPending) throw createDriveError('reauth_required');
      if (cleanupPending) this.tokenReadIssue = null;
      const pending = parsePending(settings.google_drive_pending_upload);
      let revokeStatus: 'confirmed' | 'unconfirmed' = 'confirmed';
      const token = envelope?.refresh_token || envelope?.access_token;
      if (token && !cleanupPending) {
        try {
          const response = await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString(), signal: requestSignal(signal, 8_000) });
          revokeStatus = response.ok ? 'confirmed' : 'unconfirmed';
        } catch (error) { if (signal.aborted) throw error; revokeStatus = 'unconfirmed'; }
      }
      if (revokeStatus === 'unconfirmed' && !cleanupPending) {
        upsertSettings({ google_drive_revoke_status: 'unconfirmed', google_drive_revoke_cleanup_pending: '' });
        return this.getStatus();
      }
      upsertSettings({ google_drive_revoke_status: 'unconfirmed', google_drive_revoke_cleanup_pending: 'true', google_drive_last_error_code: 'reauth_required' });
      if (pending) removeStagingFile(pending.local_path);
      this.deleteTokens();
      clearRestoreJobResult();
      upsertSettings({ google_drive_account_email: '', google_drive_last_backup_at: '', google_drive_last_backup_status: '', google_drive_last_automatic_backup_at: '', google_drive_last_attempt_at: '', google_drive_last_success_at: '', google_drive_last_success_kind: '', google_drive_next_retry_at: '', google_drive_retention_status: '', google_drive_retention_retry_count: '', google_drive_last_error_code: '', google_drive_pending_upload: '', google_drive_job: '', google_drive_revoke_status: revokeStatus, google_drive_revoke_cleanup_pending: '' });
      return this.getStatus();
    }, true);
  }

  async prepareForDatabaseRestore(): Promise<void> {
    if (this.restoreInvalidationActive()) throw createDriveError('conflict');
    this.databaseRestorePending = true;
    this.backupAbortController?.abort();
    this.abortQueuedDriveOperations();
    for (const controller of this.jobControllers.values()) controller.abort();
    await this.abortAndAwaitActiveDriveOperations();
    await this.operationTail;
    await this.abortAndAwaitActiveDriveOperations();
    this.activateDatabaseRestoreInvalidation();
  }

  async beginDatabaseRestoreInvalidation(jobId?: string): Promise<void> {
    if (this.restoreInvalidationActive()) throw createDriveError('conflict');
    this.databaseRestorePending = true;
    await this.abortAndAwaitActiveDriveOperations();
    this.activateDatabaseRestoreInvalidation(jobId);
  }

  releaseDatabaseRestore(): void {
    if (this.restoreInvalidationCleanupPending) return;
    const replacement = getDatabaseReplacementJournal();
    if (this.restoreInvalidationIntentExists() || replacement?.phase === 'prepared') {
      try {
        this.clearDatabaseRestoreInvalidation();
      } catch (error) {
        console.error('[Google Drive] Restore cancellation cleanup deferred:', error);
      }
      return;
    }
    this.databaseRestorePending = false;
  }

  clearDatabaseRestoreInvalidation(): void {
    const replacement = getDatabaseReplacementJournal();
    if (replacement?.phase === 'committed') {
      this.invalidateAfterDatabaseRestore(replacement);
      return;
    }
    const decision = this.databaseRestoreRecoveryDecision();
    if (!replacement && decision === 'committed') {
      this.invalidateAfterDatabaseRestore(null);
      return;
    }
    if (decision === 'ambiguous') {
      this.restoreInvalidationCleanupPending = true;
      this.scheduleRestoreRecoveryRetry();
      throw new Error('Database replacement outcome is ambiguous');
    }
    if (replacement?.phase === 'prepared') {
      if (decision === 'committed') {
        this.restoreInvalidationCleanupPending = true;
        this.scheduleRestoreRecoveryRetry();
        throw new Error('Prepared database replacement recovery remains pending');
      }
      try {
        abortDatabaseReplacementJournal(replacement);
      } catch (error) {
        this.restoreInvalidationCleanupPending = true;
        this.scheduleRestoreRecoveryRetry();
        throw error;
      }
    }
    this.clearRestoreInvalidationIntent();
    this.databaseRestorePending = false;
    this.armScheduling();
  }

  completeDatabaseRestore(): DatabaseReplacementCompletion {
    const replacement = getDatabaseReplacementJournal();
    if (!replacement) {
      const decision = this.databaseRestoreRecoveryDecision();
      if (decision === 'committed') {
        try {
          this.invalidateAfterDatabaseRestore(null);
          return { committed: true, cleanupPending: false };
        } catch (error) {
          console.error('[Google Drive] Post-restore cleanup deferred:', error);
        }
      } else if (decision === 'recovered') {
        try {
          this.clearDatabaseRestoreInvalidation();
          return { committed: true, cleanupPending: false };
        } catch (error) {
          console.error('[Google Drive] Post-restore boundary cleanup deferred:', error);
        }
      }
      return { committed: true, cleanupPending: this.restoreInvalidationCleanupPending || this.restoreInvalidationIntentExists() };
    }
    try {
      this.invalidateAfterDatabaseRestore();
      return { committed: true, cleanupPending: false };
    } catch (error) {
      console.error('[Google Drive] Post-restore cleanup deferred:', error);
      return { committed: true, cleanupPending: true };
    }
  }

  invalidateAfterDatabaseRestore(replacement: DatabaseReplacementJournalHandle | null = getDatabaseReplacementJournal()): void {
    if (getDatabaseReplacementJournal()?.phase === 'prepared') {
      this.restoreInvalidationCleanupPending = true;
      this.scheduleRestoreRecoveryRetry();
      throw new Error('Prepared database replacement recovery remains pending');
    }
    const committedReplacement = replacement?.phase === 'committed' ? replacement : null;
    if (!committedReplacement && this.databaseRestoreRecoveryDecision() !== 'committed') throw new Error('Database replacement is not committed');
    try {
      for (const fileName of fs.readdirSync(getStagingDir())) removeStagingFile(path.join(getStagingDir(), fileName));
    } catch { }
    this.deleteTokens();
    this.tokenReadIssue = null;
    clearGoogleDriveRestoreBinding();
    if (committedReplacement) finalizeDatabaseReplacementJournal(committedReplacement);
    this.clearRestoreInvalidationIntent();
    clearRestoreJobResult();
    this.databaseRestorePending = false;
    this.armScheduling();
  }

  async setDestination(folderId: string): Promise<GoogleDriveStatus> {
    if (!safeId(folderId)) throw createDriveError('destination_invalid');
    return this.queueOperation(async (signal) => {
      const client = await this.getAuthorizedClient(signal);
      const destination = await this.validateDestination(drive({ version: 'v3', auth: client }), folderId, this.ensureInstallationMarker(), signal);
      this.rememberDestination(destination.id);
      upsertSettings({ google_drive_destination_folder_id: destination.id, google_drive_destination_folder_name: destination.name, google_drive_folder_id: destination.id, google_drive_last_error_code: '' });
      return this.getStatus();
    });
  }

  async listDestinations(): Promise<{ id: string; name: string; current: boolean }[]> {
    return this.queueOperation(async (signal) => {
      const client = await this.getAuthorizedClient(signal);
      const marker = this.ensureInstallationMarker();
      const settings = this.readSettings();
      const current = settings.google_drive_destination_folder_id || settings.google_drive_folder_id;
      const ids = [...new Set([current, ...this.readOwnedDestinations()].filter((value): value is string => Boolean(value)))];
      const result: { id: string; name: string; current: boolean }[] = [];
      for (const id of ids) {
        try {
          const destination = await this.validateDestination(drive({ version: 'v3', auth: client }), id, marker, signal);
          result.push({ id: destination.id, name: destination.name, current: destination.id === current });
        } catch (error) {
          const classified = classifyDriveError(error);
          if (classified.code !== 'destination_invalid' && !isMissingDestinationError(error)) throw classified;
        }
      }
      return result;
    });
  }

  async createDestination(): Promise<GoogleDriveStatus> {
    return this.queueOperation(async (signal) => {
      const client = await this.getAuthorizedClient(signal);
      const marker = this.ensureInstallationMarker();
      const driveClient = drive({ version: 'v3', auth: client });
      let destination = await this.findExistingAppFolder(driveClient, marker, signal);
      if (!destination) {
        destination = await this.createAppFolder(driveClient, marker, signal);
      }
      this.rememberDestination(destination.id);
      upsertSettings({ google_drive_destination_folder_id: destination.id, google_drive_destination_folder_name: destination.name, google_drive_folder_id: destination.id, google_drive_last_error_code: '' });
      return this.getStatus();
    });
  }

  async backupNow(signal?: AbortSignal, kind: BackupKind = 'manual'): Promise<GoogleDriveStatus> {
    if (signal?.aborted) throw createDriveShutdownError('Google Drive backup');
    if (this.restoreInvalidationActive()) throw createDriveError('conflict');
    if (this.readSettings().google_drive_revoke_status === 'unconfirmed') throw createDriveError('not_connected');
    if (kind === 'manual' && parsePending(this.readSettings().google_drive_pending_upload)?.kind === 'automatic') throw createDriveError('conflict');
    if (this.backingUp) return this.getStatus();
    this.backingUp = true;
    const abortController = new AbortController();
    this.backupAbortController = abortController;
    const operationSignal = signal ? AbortSignal.any([signal, abortController.signal, this.shutdownController.signal]) : AbortSignal.any([abortController.signal, this.shutdownController.signal]);
    const operation = this.queueOperation((queueSignal) => this.runBackup(AbortSignal.any([operationSignal, queueSignal]), kind));
    this.backupPromise = operation;
    try { return await operation; } finally { this.backingUp = false; this.backupPromise = null; if (this.backupAbortController === abortController) this.backupAbortController = null; }
  }

  startBackupJob(kind: BackupKind = 'manual', warningAcknowledged = false): GoogleDriveStatus {
    if (this.restoreInvalidationActive()) throw createDriveError('conflict');
    if (this.readSettings().google_drive_revoke_status === 'unconfirmed') throw createDriveError('not_connected');
    if (this.operationRunning || this.activeJobs.size > 0) throw createDriveError('conflict');
    if (kind === 'manual' && !warningAcknowledged && this.readSettings()[DRIVE_WARNING_SETTING] !== 'true') throw createDriveError('warning_acknowledgement_required');
    if (kind === 'manual' && parsePending(this.readSettings().google_drive_pending_upload)?.kind === 'automatic') throw createDriveError('conflict');
    if (warningAcknowledged) this.acknowledgeWarning();
    const jobId = crypto.randomUUID();
    const controller = new AbortController();
    this.jobControllers.set(jobId, controller);
    this.writeJob({ id: jobId, operation: 'backup', kind, state: 'queued', updated_at: now() });
    const job = this.queueOperation((queueSignal) => this.runBackup(AbortSignal.any([controller.signal, queueSignal]), kind, jobId), false, false, jobId);
    this.trackJob(job);
    void job.finally(() => this.jobControllers.delete(jobId)).catch(() => {});
    return this.getStatus();
  }

  getJob(jobId: string): GoogleDriveJob | null {
    try {
      const job = parseJob(this.readSettings().google_drive_job);
      if (job?.id === jobId) return job;
    } catch { }
    const fallback = readRestoreJobResult() || readCommittedRestoreJobResult();
    return fallback?.id === jobId ? fallback : null;
  }

  cancelJob(jobId: string): GoogleDriveStatus {
    const controller = this.jobControllers.get(jobId);
    const job = parseJob(this.readSettings().google_drive_job);
    if (!job || job.id !== jobId) throw createDriveError('unknown');
    if (!['queued', 'snapshot_created', 'uploading', 'restoring'].includes(job.state)) throw createDriveError('conflict');
    const pending = parsePending(this.readSettings().google_drive_pending_upload);
    controller?.abort();
    if (job.state === 'queued' || !controller) this.writeJob({ ...job, state: 'cancelled', error_code: 'cancelled', updated_at: now() });
    else if (job.operation === 'backup' && pending) {
      pending.next_retry_at = nextBackupRetryAt(pending.attempt_count || 1);
      upsertSettings({ google_drive_pending_upload: JSON.stringify(pending), google_drive_next_retry_at: pending.next_retry_at, google_drive_last_backup_status: 'error', google_drive_last_error_code: 'cancelled' });
      this.writeJob({ ...job, state: 'offline_pending', error_code: 'cancelled', updated_at: now() });
    } else {
      this.writeJob({ ...job, state: 'cancelled', error_code: 'cancelled', updated_at: now() });
    }
    return this.getStatus();
  }

  async listRemoteBackups(): Promise<GoogleDriveRemoteBackup[]> {
    return this.queueOperation(async (signal) => {
      const marker = this.ensureInstallationMarker();
      const envelope = this.readTokenEnvelope();
      if (envelope?.installation_id && envelope.installation_id !== marker) throw createDriveError('reauth_required');
      const client = await this.getAuthorizedClient(signal);
      const settings = this.readSettings();
      const current = settings.google_drive_destination_folder_id || settings.google_drive_folder_id;
      const result: GoogleDriveRemoteBackup[] = [];
      for (const folderId of [...new Set([current, ...this.readOwnedDestinations()].filter((value): value is string => Boolean(value)))]) {
        try {
          const files = await this.listFilesInDestination(drive({ version: 'v3', auth: client }), folderId, signal, { query: `appProperties has { key='flo_marker_version' and value='${MARKER_VERSION}' } and appProperties has { key='flo_installation_id' and value='${marker}' }` });
          for (const file of files) {
            const backup = this.toRemoteBackup(file, folderId);
            if (backup) result.push(backup);
          }
        } catch (error) {
          const classified = classifyDriveError(error);
          if (classified.code === 'destination_invalid' || isMissingDestinationError(error)) continue;
          throw classified;
        }
      }
      return result.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    });
  }

  startRestoreJob(input: { fileId: string; expectedSha256?: string; confirmation: string }): GoogleDriveStatus {
    if (input.confirmation !== DRIVE_RESTORE_CONFIRMATION || !safeId(input.fileId)) throw createDriveError('restore_validation_failed');
    if (this.restoreInvalidationActive()) throw createDriveError('conflict');
    if (this.readSettings().google_drive_revoke_status === 'unconfirmed') throw createDriveError('not_connected');
    if (this.operationRunning || this.activeJobs.size > 0) throw createDriveError('conflict');
    const jobId = crypto.randomUUID();
    const controller = new AbortController();
    this.jobControllers.set(jobId, controller);
    this.writeJob({ id: jobId, operation: 'restore', state: 'queued', updated_at: now() });
    const job = this.queueOperation((queueSignal) => this.runRestore(AbortSignal.any([controller.signal, queueSignal]), jobId, input), false, false, jobId);
    this.trackJob(job);
    void job.finally(() => this.jobControllers.delete(jobId)).catch(() => {});
    return this.getStatus();
  }

  private async runBackup(signal: AbortSignal, kind: BackupKind, jobId?: string): Promise<GoogleDriveStatus> {
    upsertSettings({ google_drive_last_attempt_at: new Date().toISOString(), google_drive_last_error_code: '', google_drive_next_retry_at: '' });
    let pending = parsePending(this.readSettings().google_drive_pending_upload);
    const persistedJob = parseJob(this.readSettings().google_drive_job);
    const trackedJobId = jobId || (persistedJob?.operation === 'backup' && ['offline_pending', 'retention_pending'].includes(persistedJob.state) ? persistedJob.id : undefined);
    const backupKind = pending?.kind || kind;
    let stagedPath = '';
    try {
      let snapshot: SnapshotDescriptor;
      if (pending) {
        if (pending.kind === 'automatic' && kind === 'manual') throw createDriveError('conflict');
        snapshot = await this.snapshotFromPending(pending, signal);
      } else {
        if (jobId) this.writeJob({ id: jobId, operation: 'backup', kind: backupKind, state: 'snapshot_created', updated_at: now() });
        stagedPath = createUploadStagingPath();
        const result = await waitForDriveOperation((operationSignal) => createBackup(stagedPath, operationSignal, { stagingDirectory: path.dirname(stagedPath) }), signal, GOOGLE_DRIVE_SNAPSHOT_TIMEOUT_MS, 'Google Drive local backup', (operation) => this.trackDriveOperation(operation), () => this.stopping, SHUTDOWN_TIMEOUT_MS);
        const metadata = getBackupMetadata(result.path);
        if (metadata.schemaVersion === null || !metadata.appVersion || !metadata.backupCreatedAt) {
          removeStagingFile(result.path);
          throw createDriveError('local_snapshot_failed');
        }
        let hash: { sha256: string; byteCount: number };
        try { hash = await hashBackupFile(result.path); } catch (error) { removeStagingFile(result.path); throw error; }
        snapshot = { path: result.path, fileName: path.basename(result.path), sha256: hash.sha256, byteCount: hash.byteCount, schemaVersion: metadata.schemaVersion, appVersion: metadata.appVersion, backupCreatedAt: metadata.backupCreatedAt };
        const nextRetryAt = nextBackupRetryAt(1);
        pending = { run_id: crypto.randomUUID(), kind: backupKind, local_path: result.path, sha256: snapshot.sha256, byte_count: snapshot.byteCount, schema_version: snapshot.schemaVersion, app_version: snapshot.appVersion, backup_created_at: snapshot.backupCreatedAt, destination_folder_id: this.readSettings().google_drive_destination_folder_id || this.readSettings().google_drive_folder_id || '', attempt_count: 0, next_retry_at: nextRetryAt };
        upsertSettings({ google_drive_pending_upload: JSON.stringify(pending), google_drive_next_retry_at: nextRetryAt });
      }
      this.throwIfStopping(signal);
      if (jobId) this.writeJob({ id: jobId, operation: 'backup', kind: backupKind, state: 'uploading', bytes_sent: 0, total_bytes: snapshot.byteCount, updated_at: now() });
      const client = await this.getAuthorizedClient(signal);
      const driveClient = drive({ version: 'v3', auth: client });
      const destinationId = await this.resolveDestinationForUpload(driveClient, signal);
      if (!pending) throw createDriveError('unknown');
      pending.destination_folder_id = destinationId;
      pending.attempt_count += 1;
      pending.next_retry_at = nextBackupRetryAt(pending.attempt_count);
      upsertSettings({ google_drive_pending_upload: JSON.stringify(pending), google_drive_next_retry_at: pending.next_retry_at });
      const remote = await this.uploadSnapshot(driveClient, snapshot, pending, signal, jobId);
      this.throwIfStopping(signal);
      if (jobId) {
        const currentJob = parseJob(this.readSettings().google_drive_job);
        if (!currentJob || currentJob.id !== jobId || currentJob.state !== 'uploading') throw createDriveError('cancelled');
      }
      const successAt = new Date().toISOString();
      upsertSettings({ google_drive_destination_folder_id: destinationId, google_drive_folder_id: destinationId, google_drive_last_backup_at: successAt, google_drive_last_success_at: successAt, google_drive_last_automatic_backup_at: backupKind === 'automatic' ? successAt : this.readSettings().google_drive_last_automatic_backup_at || '', google_drive_last_success_kind: backupKind, google_drive_last_backup_status: 'success', google_drive_last_error_code: 'retention_pending', google_drive_next_retry_at: '', google_drive_retention_status: 'pending', google_drive_retention_retry_count: '' });
      if (trackedJobId) this.writeJob({ id: trackedJobId, operation: 'backup', kind: backupKind, state: 'retention_pending', remote_id: remote.id, bytes_sent: snapshot.byteCount, total_bytes: snapshot.byteCount, updated_at: now() });
      removeStagingFile(snapshot.path);
      upsertSettings({ google_drive_pending_upload: '' });
      let retentionPending = false;
      try {
        await this.applyRetention(driveClient, signal);
        upsertSettings({ google_drive_retention_status: '', google_drive_retention_retry_count: '', google_drive_next_retry_at: '', google_drive_last_error_code: '' });
      } catch (error) {
        const classified = classifyDriveError(error);
        if (classified.code === 'cancelled') throw classified;
        if (classified.retryable) {
          retentionPending = true;
          this.scheduleRetentionRetry();
        } else {
          upsertSettings({ google_drive_retention_status: 'error', google_drive_retention_retry_count: '', google_drive_next_retry_at: '', google_drive_last_error_code: classified.code });
        }
      }
      if (trackedJobId) this.writeJob({ id: trackedJobId, operation: 'backup', kind: backupKind, state: retentionPending ? 'retention_pending' : 'succeeded', remote_id: remote.id, bytes_sent: snapshot.byteCount, total_bytes: snapshot.byteCount, updated_at: now() });
      return this.getStatus();
    } catch (error) {
      const missingDestination = isMissingDestinationError(error);
      const classified = missingDestination ? createDriveError('destination_required') : classifyDriveError(error);
      if (classified.code === 'cancelled' && this.stopping) throw createDriveShutdownError('Google Drive backup');
      pending = parsePending(this.readSettings().google_drive_pending_upload);
      if (!pending) removeStagingFile(stagedPath);
      const discardPending = classified.code === 'local_file_missing';
      if (pending && discardPending) {
        removeStagingFile(pending.local_path);
        upsertSettings({ google_drive_pending_upload: '' });
      }
      const cancelledWithPending = classified.code === 'cancelled' && Boolean(pending);
      const retryPaused = missingDestination || classified.code === 'destination_invalid' || classified.code === 'reauth_required' || classified.code === 'permission_denied' || classified.code === 'duplicate_upload';
      const nextRetry = retryPaused ? '' : (classified.retryable || cancelledWithPending) ? nextBackupRetryAt(pending?.attempt_count || 1) : '';
      if (pending && retryPaused) {
        pending.next_retry_at = null;
        upsertSettings({ google_drive_pending_upload: JSON.stringify(pending) });
      }
      if (pending && (classified.retryable || cancelledWithPending)) {
        pending.next_retry_at = nextRetry;
        upsertSettings({ google_drive_pending_upload: JSON.stringify(pending) });
      }
      upsertSettings({ google_drive_last_backup_status: 'error', google_drive_last_error_code: classified.code, google_drive_next_retry_at: nextRetry });
      if (trackedJobId) this.writeJob({ id: trackedJobId, operation: 'backup', kind, state: cancelledWithPending || classified.retryable ? 'offline_pending' : classified.code === 'cancelled' ? 'cancelled' : 'failed', error_code: classified.code, updated_at: now() });
      if (classified.code === 'cancelled' || classified.code === 'conflict') throw classified;
      return this.getStatus();
    }
  }

  private async snapshotFromPending(pending: PendingUpload, signal: AbortSignal): Promise<SnapshotDescriptor> {
    this.throwIfStopping(signal);
    if (!isManagedBackupFile(pending.local_path) && !isUploadStagingFile(pending.local_path)) { upsertSettings({ google_drive_pending_upload: '', google_drive_last_error_code: 'local_file_missing' }); throw createDriveError('local_file_missing'); }
    const metadata = getBackupMetadata(pending.local_path);
    const hash = await hashBackupFile(pending.local_path);
    if (metadata.schemaVersion === null || !metadata.appVersion || !metadata.backupCreatedAt || metadata.schemaVersion !== pending.schema_version || metadata.appVersion !== pending.app_version || hash.sha256 !== pending.sha256 || hash.byteCount !== pending.byte_count) throw createDriveError('local_file_missing');
    return { path: pending.local_path, fileName: path.basename(pending.local_path), sha256: hash.sha256, byteCount: hash.byteCount, schemaVersion: metadata.schemaVersion, appVersion: metadata.appVersion, backupCreatedAt: metadata.backupCreatedAt };
  }

  private scheduleRetentionRetry(): void {
    const settings = this.readSettings();
    const previousAttempt = Number.parseInt(settings.google_drive_retention_retry_count || '', 10);
    const attempt = Number.isSafeInteger(previousAttempt) && previousAttempt >= 0 ? previousAttempt + 1 : 1;
    const delay = Math.min(RETENTION_RETRY_MAX_MS, RETENTION_RETRY_BASE_MS * (2 ** Math.min(attempt - 1, 8)));
    upsertSettings({ google_drive_retention_status: 'pending', google_drive_retention_retry_count: String(attempt), google_drive_next_retry_at: new Date(Date.now() + delay).toISOString(), google_drive_last_error_code: 'retention_pending' });
  }

  private retryPendingRetention(): Promise<void> {
    return this.queueOperation(async (signal) => {
      try {
        const operationSignal = AbortSignal.any([this.shutdownController.signal, signal]);
        const client = await this.getAuthorizedClient(operationSignal);
        await this.applyRetention(drive({ version: 'v3', auth: client }), operationSignal);
        const job = parseJob(this.readSettings().google_drive_job);
        if (job?.state === 'retention_pending') this.writeJob({ ...job, state: 'succeeded', updated_at: now() });
        upsertSettings({ google_drive_retention_status: '', google_drive_retention_retry_count: '', google_drive_next_retry_at: '', google_drive_last_error_code: '' });
      } catch (error) {
        if (this.stopping || signal.aborted) throw error;
        const classified = classifyDriveError(error);
        if (classified.retryable) {
          this.scheduleRetentionRetry();
          return;
        }
        const job = parseJob(this.readSettings().google_drive_job);
        if (job?.state === 'retention_pending') this.writeJob({ ...job, state: 'succeeded', error_code: undefined, updated_at: now() });
        upsertSettings({ google_drive_retention_status: 'error', google_drive_retention_retry_count: '', google_drive_next_retry_at: '', google_drive_last_error_code: classified.code });
      }
    });
  }

  private async uploadSnapshot(driveClient: DriveClient, snapshot: SnapshotDescriptor, pending: PendingUpload, signal: AbortSignal, jobId?: string): Promise<{ id: string }> {
    const marker = this.ensureInstallationMarker();
    const matching = await this.findMatchingUploads(driveClient, pending.destination_folder_id, pending.run_id, marker, signal);
    if (matching.length > 1) throw createDriveError('duplicate_upload');
    if (matching.length === 1) {
      if (this.remoteMatchesSnapshot(matching[0], snapshot, pending)) return { id: String(matching[0].id) };
      throw createDriveError('duplicate_upload');
    }
    const appProperties = { flo_marker_version: MARKER_VERSION, flo_installation_id: marker, flo_backup_run_id: pending.run_id, flo_backup_kind: pending.kind, flo_payload_version: 'sqlite-full-v1', flo_schema_version: String(snapshot.schemaVersion), flo_app_version: snapshot.appVersion, flo_backup_created_at: snapshot.backupCreatedAt, flo_byte_count: String(snapshot.byteCount), flo_sha256: snapshot.sha256, flo_destination_folder_id: pending.destination_folder_id };
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      this.throwIfStopping(signal);
      try {
        const stream = fs.createReadStream(snapshot.path, { flags: 'r' });
        const remoteFileName = this.resolveRemoteFileName(snapshot, pending.kind);
        const response = await driveClient.files.create({ requestBody: { name: remoteFileName, parents: [pending.destination_folder_id], appProperties, mimeType: 'application/x-sqlite3' }, media: { mimeType: 'application/x-sqlite3', body: stream }, fields: 'id,appProperties,size,createdTime,name,parents,trashed,mimeType' }, { resumable: true, signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS, onUploadProgress: (event: { bytesRead?: number }) => { if (jobId) { const job = parseJob(this.readSettings().google_drive_job); if (job?.id === jobId) this.writeJob({ ...job, state: 'uploading', bytes_sent: Math.min(snapshot.byteCount, event.bytesRead || 0), total_bytes: snapshot.byteCount, updated_at: now() }); } } } as never);
        const id = String((response.data as { id?: string }).id || '');
        if (safeId(id)) return { id };
        const reconciled = await this.findMatchingUploads(driveClient, pending.destination_folder_id, pending.run_id, marker, signal);
        if (reconciled.length === 1 && this.remoteMatchesSnapshot(reconciled[0], snapshot, pending)) return { id: String(reconciled[0].id) };
        throw createDriveError('upload_failed', true);
      } catch (error) {
        lastError = error;
        const reconciled = await this.findMatchingUploads(driveClient, pending.destination_folder_id, pending.run_id, marker, signal).catch((reconciliationError) => {
          if (isMissingDestinationError(reconciliationError)) {
            const missing = createDriveError('destination_invalid');
            missing.destination_missing = true;
            throw missing;
          }
          return [];
        });
        if (reconciled.length === 1 && this.remoteMatchesSnapshot(reconciled[0], snapshot, pending)) return { id: String(reconciled[0].id) };
        const classified = classifyDriveError(error);
        if (!classified.retryable || attempt === 2) throw classified;
        await this.delayWithSignal(250 * (2 ** attempt), signal);
      }
    }
    throw classifyDriveError(lastError);
  }

  private async applyRetention(driveClient: DriveClient, signal: AbortSignal): Promise<void> {
    const marker = this.ensureInstallationMarker();
    const retentionCount = this.retentionFromSettings(this.readSettings());
    const newest: { id: string; createdTime: string }[] = [];
    let retryPending = false;
    for (const folderId of this.readOwnedDestinations()) {
      try {
        await this.listFilesInDestination(driveClient, folderId, signal, {
          query: `appProperties has { key='flo_marker_version' and value='${MARKER_VERSION}' } and appProperties has { key='flo_installation_id' and value='${marker}' } and appProperties has { key='flo_backup_kind' and value='automatic' } and appProperties has { key='flo_destination_folder_id' and value='${folderId}' }`,
          onFile: async (file) => {
            const properties = this.appProperties(file);
            if (properties.flo_installation_id !== marker || properties.flo_backup_kind !== 'automatic' || properties.flo_destination_folder_id !== folderId || !safeId(String(file.id || ''))) return;
            newest.push({ id: String(file.id), createdTime: String(file.createdTime || properties.flo_backup_created_at || '') });
            newest.sort((a, b) => b.createdTime.localeCompare(a.createdTime) || b.id.localeCompare(a.id));
            if (newest.length > retentionCount) {
              const fileId = newest.pop()?.id;
              if (!fileId) return;
              this.throwIfStopping(signal);
              try { await driveClient.files.update({ fileId, requestBody: { trashed: true }, fields: 'id,trashed' }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS }); }
              catch (error) {
                const classified = classifyDriveError(error);
                if (classified.code === 'reauth_required' || classified.code === 'permission_denied') throw classified;
                throw createDriveError('retention_pending', true);
              }
            }
          },
        });
      } catch (error) {
        const classified = classifyDriveError(error);
        if (classified.code === 'retention_pending' || classified.code === 'cancelled') throw classified;
        if (isMissingDestinationError(error)) continue;
        else if (classified.code === 'permission_denied' || classified.code === 'reauth_required') throw classified;
        else if (classified.retryable) retryPending = true;
        else throw classified;
      }
    }
    if (retryPending) throw createDriveError('retention_pending', true);
  }

  private async runRestore(signal: AbortSignal, jobId: string, input: { fileId: string; expectedSha256?: string }): Promise<GoogleDriveStatus> {
    let stagingPath = '';
    let restoreInvalidationStarted = false;
    let committedJob: GoogleDriveJob | null = null;
    let statusFallback: GoogleDriveStatus | null = null;
    try {
      try { statusFallback = this.getStatus(); } catch { }
      this.writeJob({ id: jobId, operation: 'restore', state: 'restoring', updated_at: now() });
      const marker = this.ensureInstallationMarker();
      const client = await this.getAuthorizedClient(signal);
      const driveClient = drive({ version: 'v3', auth: client });
      const remote = await this.getRemoteFile(driveClient, input.fileId, marker, signal);
      if (!remote) throw createDriveError('restore_validation_failed');
      const properties = this.appProperties(remote);
      const expectedHash = input.expectedSha256 || properties.flo_sha256;
      const expectedSize = Number(properties.flo_byte_count || remote.size || 0);
      const remoteSchema = Number(properties.flo_schema_version);
      const remoteAppVersion = properties.flo_app_version;
      if (remote.mimeType !== 'application/x-sqlite3' || !expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash) || properties.flo_sha256 !== expectedHash || !Number.isSafeInteger(expectedSize) || expectedSize <= 0 || !Number.isSafeInteger(remoteSchema) || !remoteAppVersion || !['automatic', 'manual'].includes(properties.flo_backup_kind)) throw createDriveError('restore_validation_failed');
      const versionComparison = compareAppVersions(remoteAppVersion, app.getVersion());
      if (versionComparison === null || versionComparison > 0 || remoteSchema > getCurrentSchemaVersion()) throw createDriveError('restore_validation_failed');
      stagingPath = await this.downloadRemoteFile(driveClient, input.fileId, expectedSize, signal, jobId);
      const hash = await hashStagedFile(stagingPath);
      if (hash.byteCount !== expectedSize || hash.sha256 !== expectedHash) throw createDriveError('restore_validation_failed');
      const metadata = getBackupMetadata(stagingPath);
      if (metadata.schemaVersion !== remoteSchema || metadata.appVersion !== remoteAppVersion || metadata.schemaVersion === null) throw createDriveError('restore_validation_failed');
      const forceDirect = remoteSchema === getCurrentSchemaVersion();
      await this.beginDatabaseRestoreInvalidation(jobId);
      restoreInvalidationStarted = true;
      const restoreResult = await withDatabaseMaintenanceLock(async (maintenanceSignal) => {
        const result = restoreBackup(stagingPath, forceDirect, maintenanceSignal);
        if (result.success) {
          const cleanup = this.completeDatabaseRestore();
          if (!cleanup.cleanupPending) restoreInvalidationStarted = false;
        }
        return result;
      }, signal);
      if (!restoreResult.success) { this.writeJob({ id: jobId, operation: 'restore', state: 'failed', error_code: 'restore_failed', updated_at: now() }); return this.getStatus(); }
      committedJob = { id: jobId, operation: 'restore', state: 'succeeded', updated_at: now() };
      const cleanupPending = restoreResult.cleanupPending === true || restoreInvalidationStarted;
      if (cleanupPending) persistRestoreJobResult(committedJob);
      try {
        clearUserAuthCache();
        clearInMemoryRevokedTokens();
        clearJWTSecretCache();
        upsertSettings({ google_drive_pending_upload: '', google_drive_job: '' });
        this.writeJob(committedJob);
        clearRestoreJobResult();
        return this.getStatus();
      } catch {
        try { persistRestoreJobResult(committedJob); } catch (persistError) { console.error('[Google Drive] Committed restore job persistence failed:', persistError); }
        return this.statusWithJobFallback(committedJob, statusFallback);
      }
    } catch (error) {
      if (committedJob) {
        try { persistRestoreJobResult(committedJob); } catch (persistError) { console.error('[Google Drive] Committed restore job persistence failed:', persistError); }
        return this.statusWithJobFallback(committedJob, statusFallback);
      }
      const classified = classifyDriveError(error);
      if (classified.code === 'cancelled') this.writeJob({ id: jobId, operation: 'restore', state: 'cancelled', error_code: 'cancelled', updated_at: now() });
      if (classified.code === 'cancelled' && this.stopping) throw createDriveShutdownError('Google Drive restore');
      if (classified.code !== 'cancelled') this.writeJob({ id: jobId, operation: 'restore', state: 'failed', error_code: classified.code, updated_at: now() });
      return this.getStatus();
    } finally {
      if (restoreInvalidationStarted) {
        try {
          this.clearDatabaseRestoreInvalidation();
          restoreInvalidationStarted = false;
        } catch (cleanupError) {
          console.error('[Google Drive] Restore invalidation cleanup failed:', cleanupError);
        }
      }
      if (stagingPath) await removeDownloadStagingFileWithRetry(stagingPath);
    }
  }

  private async downloadRemoteFile(driveClient: DriveClient, fileId: string, expectedSize: number, signal: AbortSignal, jobId: string): Promise<string> {
    fs.mkdirSync(getStagingDir(), { recursive: true, mode: 0o700 });
    const stagingPath = path.join(getStagingDir(), `download-${crypto.randomUUID()}.db`);
    const response = await driveClient.files.get({ fileId, alt: 'media' }, { responseType: 'stream', signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS } as never);
    const output = fs.createWriteStream(stagingPath, { flags: 'wx', mode: 0o600 });
    const outputError = new Promise<never>((_, reject) => output.once('error', reject));
    void outputError.catch(() => {});
    let bytes = 0;
    try {
      for await (const chunk of response.data as AsyncIterable<Uint8Array>) {
        this.throwIfStopping(signal);
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > expectedSize) throw createDriveError('restore_validation_failed');
        if (!output.write(buffer)) await Promise.race([once(output, 'drain'), outputError]);
        const job = parseJob(this.readSettings().google_drive_job);
        if (job?.id === jobId) this.writeJob({ ...job, state: 'restoring', bytes_sent: bytes, total_bytes: expectedSize, updated_at: now() });
      }
      output.end();
      await Promise.race([once(output, 'close'), outputError]);
      if (bytes !== expectedSize) throw createDriveError('restore_validation_failed');
      return stagingPath;
    } catch (error) {
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Google Drive restore stream close timed out')), SHUTDOWN_TIMEOUT_MS);
          output.destroy();
          clearTimeout(timeout);
          resolve();
        });
      } catch { }
      await removeDownloadStagingFileWithRetry(stagingPath);
      throw error;
    }
  }

  private async getRemoteFile(driveClient: DriveClient, fileId: string, marker: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    if (!safeId(fileId)) throw createDriveError('restore_validation_failed');
    try {
      const response = await driveClient.files.get({ fileId, fields: 'id,name,createdTime,size,mimeType,parents,trashed,appProperties' }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });
      const file = response.data as Record<string, unknown>;
      const properties = this.appProperties(file);
      const folderId = String(properties.flo_destination_folder_id || '');
      if (file.trashed || properties.flo_installation_id !== marker || !safeId(folderId) || !this.readOwnedDestinations().includes(folderId)) return null;
      return file;
    } catch (error) {
      const classified = classifyDriveError(error);
      if (classified.code !== 'unknown' || classified.retryable) throw classified;
      throw createDriveError('restore_validation_failed');
    }
  }

  private async resolveDestinationForUpload(driveClient: DriveClient, signal: AbortSignal): Promise<string> {
    const settings = this.readSettings();
    const folderId = settings.google_drive_destination_folder_id || settings.google_drive_folder_id;
    const marker = this.ensureInstallationMarker();
    if (folderId && safeId(folderId)) {
      try {
        const destination = await this.validateDestination(driveClient, folderId, marker, signal);
        if (destination.id === folderId) return destination.id;
      } catch (error) {
        if (!isMissingDestinationError(error) && classifyDriveError(error).code !== 'destination_invalid') {
          throw error;
        }
      }
    }
    let destination = await this.findExistingAppFolder(driveClient, marker, signal);
    if (!destination) {
      destination = await this.createAppFolder(driveClient, marker, signal);
    }
    this.rememberDestination(destination.id);
    upsertSettings({
      google_drive_destination_folder_id: destination.id,
      google_drive_destination_folder_name: destination.name,
      google_drive_folder_id: destination.id,
      google_drive_last_error_code: '',
    });
    return destination.id;
  }

  private async validateDestination(driveClient: DriveClient, folderId: string, marker: string, signal?: AbortSignal): Promise<{ id: string; name: string; owned: boolean }> {
    if (!safeId(folderId)) throw createDriveError('destination_invalid');
    try {
      const response = await driveClient.files.get({ fileId: folderId, fields: 'id,name,mimeType,trashed,capabilities,appProperties' }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });
      const file = response.data as { id?: string; name?: string; mimeType?: string; trashed?: boolean; capabilities?: { canAddChildren?: boolean }; appProperties?: Record<string, string> };
      const owned = file.appProperties?.flo_installation_id === marker || this.readOwnedDestinations().includes(folderId);
      if (file.trashed) {
        const missing = createDriveError('destination_invalid');
        missing.destination_missing = true;
        throw missing;
      }
      if (!file.id || file.mimeType !== 'application/vnd.google-apps.folder' || file.capabilities?.canAddChildren === false || !owned) throw createDriveError('destination_invalid');
      return { id: file.id, name: file.name || DRIVE_BACKUP_FOLDER_NAME, owned };
    } catch (error) {
      if (isMissingDestinationError(error)) throw error;
      if (providerStatus(error) === 404) {
        const missing = createDriveError('destination_invalid');
        missing.destination_missing = true;
        throw missing;
      }
      const classified = classifyDriveError(error);
      if (classified.retryable || classified.code === 'permission_denied' || classified.code === 'destination_invalid') throw classified;
      throw createDriveError('destination_required');
    }
  }

  private async findExistingAppFolder(driveClient: DriveClient, marker: string, signal?: AbortSignal): Promise<{ id: string; name: string; owned: boolean } | null> {
    if (!safeId(marker)) return null;
    try {
      const escapedMarker = marker.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const response = await driveClient.files.list({
        q: `mimeType = 'application/vnd.google-apps.folder' and trashed = false and appProperties has { key='flo_installation_id' and value='${escapedMarker}' }`,
        fields: 'files(id,name,mimeType,trashed,capabilities,appProperties)',
        pageSize: 10,
      }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });
      const files = response.data.files || [];
      for (const file of files) {
        if (file.id && safeId(file.id) && file.capabilities?.canAddChildren !== false) {
          return { id: file.id, name: file.name || this.resolveBackupFolderName(), owned: true };
        }
      }
      const folderName = this.resolveBackupFolderName();
      const escapedName = folderName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const nameResponse = await driveClient.files.list({
        q: `mimeType = 'application/vnd.google-apps.folder' and trashed = false and name = '${escapedName}'`,
        fields: 'files(id,name,mimeType,trashed,capabilities,appProperties)',
        pageSize: 10,
      }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });
      const nameFiles = nameResponse.data.files || [];
      for (const file of nameFiles) {
        if (file.id && safeId(file.id) && file.capabilities?.canAddChildren !== false) {
          return { id: file.id, name: file.name || folderName, owned: true };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private resolveBackupFolderName(): string {
    const businessName = this.readSettings().business_name;
    const sanitized = (businessName || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return sanitized ? `${sanitized}_flocafe_backups` : 'flocafe_backups';
  }

  private resolveRemoteFileName(snapshot: SnapshotDescriptor, kind: BackupKind): string {
    const businessName = this.readSettings().business_name;
    const sanitized = (businessName || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const prefix = sanitized ? `${sanitized}_backup` : 'flo_backup';
    const timestamp = (snapshot.backupCreatedAt || new Date().toISOString())
      .replace(/[:.]/g, '-')
      .replace(/Z$/, '');
    return `${prefix}_${timestamp}_${kind}.db`;
  }

  private async createAppFolder(driveClient: DriveClient, marker: string, signal?: AbortSignal): Promise<{ id: string; name: string; owned: boolean }> {
    try {
      const folderName = this.resolveBackupFolderName();
      const response = await driveClient.files.create({ requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', appProperties: { flo_marker_version: MARKER_VERSION, flo_installation_id: marker, flo_destination_kind: 'flocafe' } }, fields: 'id,name,mimeType,trashed,capabilities,appProperties' }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });
      const file = response.data as { id?: string; name?: string };
      if (!file.id || !safeId(file.id)) throw createDriveError('destination_required');
      return { id: file.id, name: file.name || folderName, owned: true };
    } catch (error) {
      const classified = classifyDriveError(error);
      if (classified.retryable) throw classified;
      throw classified.code === 'unknown' ? createDriveError('destination_required') : classified;
    }
  }

  private async fetchAccountIdentity(client: OAuth2Client, signal?: AbortSignal): Promise<{ subject: string | null; email: string | null }> {
    try {
      const accessToken = (await waitForDriveOperation(() => client.getAccessToken(), signal, DRIVE_REQUEST_TIMEOUT_MS, 'Google Drive access token refresh')).token;
      if (!accessToken) throw createDriveError('reauth_required');
      const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` }, signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS) });
      if (!response.ok) {
        const error = new Error('Google account identity request failed') as Error & { status: number };
        error.status = response.status;
        throw error;
      }
      const data = await response.json() as { sub?: unknown; email?: unknown };
      return { subject: typeof data.sub === 'string' ? data.sub : null, email: typeof data.email === 'string' ? data.email : null };
    } catch (error) { throw classifyDriveError(error); }
  }

  private async getAuthorizedClient(signal?: AbortSignal): Promise<OAuth2Client> {
    if (signal?.aborted) throw createDriveShutdownError('Google Drive operation');
    const creds = getClientCredentials();
    if (!creds) throw createDriveError('configuration_unavailable');
    if (!isSecureStorageAvailable()) throw createDriveError('secure_storage_unavailable');
    const envelope = this.readTokenEnvelope();
    const marker = this.ensureInstallationMarker();
    if (!envelope) throw createDriveError('not_connected');
    if (this.tokenReadIssue) throw createDriveError('reauth_required');
    if (!envelope.refresh_token) throw createDriveError('reauth_required');
    const settings = this.readSettings();
    if (settings.google_drive_revoke_status === 'unconfirmed') throw createDriveError('not_connected');
    if (settings.google_drive_last_error_code === 'reauth_required') throw createDriveError('reauth_required');
    const clientIdFingerprint = crypto.createHash('sha256').update(creds.clientId).digest('hex').slice(0, 16);
    if (envelope.installation_id !== marker || !envelope.account_subject || !settings.google_drive_account_subject || envelope.account_subject !== settings.google_drive_account_subject || envelope.client_id_fingerprint !== clientIdFingerprint) throw createDriveError('reauth_required');
    const client = new googleAuth.OAuth2(creds.clientId, creds.clientSecret);
    client.setCredentials(envelope);
    let latestEnvelope: StoredTokenEnvelope = { ...envelope };
    client.on('tokens', (refreshed) => {
      if (!this.stopping && !this.terminalCleanup && !signal?.aborted) {
        latestEnvelope = { ...latestEnvelope, ...refreshed, version: TOKEN_ENVELOPE_VERSION, installation_id: marker, account_subject: envelope.account_subject };
        this.writeTokens(latestEnvelope);
      }
    });
    return client;
  }

  private async listFilesInDestination(driveClient: DriveClient, folderId: string, signal?: AbortSignal, options: { query?: string; limit?: number; onFile?: (file: Record<string, unknown>) => Promise<void> } = {}): Promise<Record<string, unknown>[]> {
    if (!safeId(folderId)) throw createDriveError('destination_invalid');
    const files: Record<string, unknown>[] = [];
    let pageToken: string | undefined;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    do {
      const pageSize = Number.isFinite(limit) ? Math.min(1000, Math.max(1, limit - files.length)) : 1000;
      const response = await driveClient.files.list({ q: [`'${folderId}' in parents and trashed=false`, options.query || ''].filter(Boolean).join(' and '), fields: 'nextPageToken,files(id,name,createdTime,size,mimeType,parents,trashed,appProperties)', spaces: 'drive', pageSize, pageToken, ...(options.query ? { orderBy: 'createdTime desc' } : {}) }, { signal: requestSignal(signal, DRIVE_REQUEST_TIMEOUT_MS), timeout: DRIVE_REQUEST_TIMEOUT_MS });
      const pageFiles = (response.data as { files?: Record<string, unknown>[] }).files || [];
      if (options.onFile) {
        for (const file of pageFiles) await options.onFile(file);
      } else {
        files.push(...pageFiles);
      }
      pageToken = (response.data as { nextPageToken?: string }).nextPageToken || undefined;
    } while (pageToken && (Boolean(options.onFile) || files.length < limit));
    return files.slice(0, limit);
  }

  private async findMatchingUploads(driveClient: DriveClient, folderId: string, runId: string, marker: string, signal: AbortSignal): Promise<Record<string, unknown>[]> {
    return (await this.listFilesInDestination(driveClient, folderId, signal, { query: `appProperties has { key='flo_installation_id' and value='${marker}' } and appProperties has { key='flo_backup_run_id' and value='${runId}' }`, limit: 2 })).filter((file) => { const properties = this.appProperties(file); return properties.flo_installation_id === marker && properties.flo_backup_run_id === runId; });
  }

  private remoteMatchesSnapshot(file: Record<string, unknown>, snapshot: SnapshotDescriptor, pending: PendingUpload): boolean {
    const properties = this.appProperties(file);
    return safeId(String(file.id || '')) && properties.flo_marker_version === MARKER_VERSION && properties.flo_backup_kind === pending.kind && properties.flo_destination_folder_id === pending.destination_folder_id && properties.flo_sha256 === snapshot.sha256 && properties.flo_byte_count === String(snapshot.byteCount) && properties.flo_schema_version === String(snapshot.schemaVersion) && properties.flo_app_version === snapshot.appVersion && String(file.size || properties.flo_byte_count) === String(snapshot.byteCount);
  }

  private appProperties(file: Record<string, unknown>): Record<string, string> {
    const raw = file.appProperties;
    if (!raw || typeof raw !== 'object') return {};
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  }

  private toRemoteBackup(file: Record<string, unknown>, folderId: string): GoogleDriveRemoteBackup | null {
    const properties = this.appProperties(file);
    if (!safeId(String(file.id || '')) || properties.flo_marker_version !== MARKER_VERSION || !['automatic', 'manual'].includes(properties.flo_backup_kind) || properties.flo_destination_folder_id !== folderId) return null;
    const schemaVersion = Number(properties.flo_schema_version);
    const bytes = Number(properties.flo_byte_count || file.size);
    const fileSize = file.size === undefined ? null : Number(file.size);
    if (file.mimeType !== 'application/x-sqlite3' || !Number.isSafeInteger(schemaVersion) || !Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isSafeInteger(fileSize ?? bytes) || (fileSize !== null && fileSize !== bytes) || !/^[a-f0-9]{64}$/.test(properties.flo_sha256 || '') || !properties.flo_app_version) return null;
    const versionComparison = compareAppVersions(properties.flo_app_version, app.getVersion());
    const compatible = file.mimeType === 'application/x-sqlite3' && /^[a-f0-9]{64}$/.test(properties.flo_sha256) && versionComparison !== null && versionComparison <= 0 && schemaVersion <= getCurrentSchemaVersion() && (fileSize === null || fileSize === bytes);
    return { id: String(file.id), name: String(file.name || 'FloCafe backup'), kind: properties.flo_backup_kind as BackupKind, created_at: String(file.createdTime || properties.flo_backup_created_at || ''), bytes, sha256: properties.flo_sha256, schema_version: schemaVersion, app_version: properties.flo_app_version, destination_folder_id: folderId, compatible };
  }

  private writeJob(job: GoogleDriveJob): void { upsertSettings({ google_drive_job: JSON.stringify(job) }); }

  private retentionFromSettings(settings: Record<string, string>): number {
    const parsed = Number.parseInt(settings.google_drive_retention_count || '', 10);
    const retention = Number.isInteger(parsed) && parsed >= MIN_RETENTION && parsed <= MAX_RETENTION ? parsed : DEFAULT_RETENTION;
    if (settings.google_drive_retention_count !== String(retention)) upsertSettings({ google_drive_retention_count: String(retention) });
    return retention;
  }

  private readOwnedDestinations(): string[] {
    const settings = this.readSettings();
    const parsed = parseJson<string[]>(settings.google_drive_owned_destinations);
    const current = settings.google_drive_destination_folder_id || settings.google_drive_folder_id;
    const values = Array.isArray(parsed) ? parsed.filter((value): value is string => safeId(value)) : [];
    return [...new Set([current, ...values].filter((value): value is string => Boolean(value)))];
  }

  private rememberDestination(folderId: string): void {
    if (!safeId(folderId)) return;
    upsertSettings({ google_drive_owned_destinations: JSON.stringify([folderId, ...this.readOwnedDestinations()].filter((value, index, array) => array.indexOf(value) === index)) });
  }

  private readSettings(): Record<string, string> {
    const rows = getDatabase().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  private ensureInstallationMarker(): string {
    const markerPath = getInstallationMarkerPath();
    try { const marker = fs.readFileSync(markerPath, 'utf8').trim(); if (safeId(marker)) return marker; } catch { }
    const marker = crypto.randomUUID();
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    const tempPath = `${markerPath}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(tempPath, marker, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tempPath, markerPath);
    } catch (error) {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { }
      throw error;
    }
    const persistedMarker = fs.readFileSync(markerPath, 'utf8').trim();
    if (!safeId(persistedMarker) || persistedMarker !== marker) throw new Error('Google Drive installation marker persistence failed');
    return persistedMarker;
  }

  private readTokenEnvelope(): StoredTokenEnvelope | null {
    const tokenPath = getTokenFilePath();
    this.recoverTokenRollbackArtifacts();
    try {
      if (!fs.existsSync(tokenPath)) {
        if (this.tokenReadIssue !== 'persistence_ambiguous') this.tokenReadIssue = null;
        return null;
      }
      const parsed = JSON.parse(safeStorage.decryptString(fs.readFileSync(tokenPath))) as StoredTokenEnvelope;
      if (!parsed || (!parsed.access_token && !parsed.refresh_token)) throw new Error('invalid token');
      if (this.tokenReadIssue !== 'persistence_ambiguous') this.tokenReadIssue = null;
      return parsed;
    } catch {
      if (this.tokenReadIssue !== 'persistence_ambiguous') this.tokenReadIssue = fs.existsSync(tokenPath) ? 'corrupt' : null;
      return null;
    }
  }

  private recoverTokenRollbackArtifacts(): void {
    const tokenPath = getTokenFilePath();
    const tokenDirectory = path.dirname(tokenPath);
    const tokenName = path.basename(tokenPath);
    let restorePaths: string[];
    try {
      restorePaths = fs.readdirSync(tokenDirectory)
        .filter((name) => name.startsWith(`${tokenName}.restore-`))
        .map((name) => path.join(tokenDirectory, name))
        .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.tokenReadIssue = 'persistence_ambiguous';
      return;
    }
    if (restorePaths.length === 0) return;
    const recoveryPath = restorePaths[0];
    try {
      const recoveryStat = fs.lstatSync(recoveryPath);
      if (recoveryStat.isSymbolicLink() || !recoveryStat.isFile()) throw new Error('Token rollback evidence must be a regular file');
      const previousToken = fs.readFileSync(recoveryPath);
      if (previousToken.length === 0) {
        if (fs.existsSync(tokenPath)) {
          const tokenStat = fs.lstatSync(tokenPath);
          if (tokenStat.isSymbolicLink() || !tokenStat.isFile()) throw new Error('Token file must be a regular file');
          fs.unlinkSync(tokenPath);
        }
      } else {
        if (fs.existsSync(tokenPath)) {
          const tokenStat = fs.lstatSync(tokenPath);
          if (tokenStat.isSymbolicLink() || !tokenStat.isFile()) throw new Error('Token file must be a regular file');
          fs.unlinkSync(tokenPath);
        }
        fs.copyFileSync(recoveryPath, tokenPath, fs.constants.COPYFILE_EXCL);
        syncTokenFile(tokenPath);
      }
      if (!syncRestoreIntentDirectory(tokenDirectory) && process.platform !== 'win32') throw new Error('Could not durably recover Google Drive token');
      for (const restorePath of restorePaths) {
        if (fs.existsSync(restorePath)) fs.unlinkSync(restorePath);
      }
      if (!syncRestoreIntentDirectory(tokenDirectory) && process.platform !== 'win32') throw new Error('Could not durably clear Google Drive token rollback evidence');
      this.tokenReadIssue = null;
      this.clearStaleReauthAfterTokenRollback(previousToken);
    } catch {
      this.tokenReadIssue = 'persistence_ambiguous';
    }
  }

  // A completed rollback restores a bound credential, so a reauth latch recorded for ambiguous token persistence is stale.
  private clearStaleReauthAfterTokenRollback(rollbackBytes: Buffer): void {
    if (rollbackBytes.length === 0) return;
    let envelope: StoredTokenEnvelope | null = null;
    try { envelope = JSON.parse(safeStorage.decryptString(rollbackBytes)) as StoredTokenEnvelope; } catch { return; }
    if (!envelope?.refresh_token || !envelope.installation_id || !envelope.account_subject) return;
    const settings = this.readSettings();
    if (settings.google_drive_last_error_code !== 'reauth_required') return;
    if (envelope.installation_id !== this.ensureInstallationMarker()) return;
    if (!settings.google_drive_account_subject || envelope.account_subject !== settings.google_drive_account_subject) return;
    try { upsertSettings({ google_drive_last_error_code: '' }); } catch { }
  }

  private writeTokens(tokens: StoredTokenEnvelope): void {
    const tokenPath = getTokenFilePath();
    const tokenDirectory = path.dirname(tokenPath);
    const tempPath = `${tokenPath}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    const restorePath = `${tokenPath}.restore-${crypto.randomBytes(4).toString('hex')}`;
    const encrypted = safeStorage.encryptString(JSON.stringify(tokens));
    let previousToken: Buffer | null = null;
    let hadPreviousToken = false;
    let fd: number | null = null;
    let renamed = false;
    let replacementDurable = false;
    try {
      if (fs.existsSync(tokenPath)) {
        hadPreviousToken = true;
        const tokenStat = fs.lstatSync(tokenPath);
        if (tokenStat.isSymbolicLink() || !tokenStat.isFile()) throw new Error('Token file must be a regular file');
        previousToken = fs.readFileSync(tokenPath);
      }
      fs.writeFileSync(restorePath, previousToken ?? Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
      syncTokenFile(restorePath);
      fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      fs.writeFileSync(fd, encrypted);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tempPath, tokenPath);
      renamed = true;
      if (!syncRestoreIntentDirectory(tokenDirectory) && process.platform !== 'win32') throw new Error('Could not durably store Google Drive token');
      replacementDurable = true;
      if (fs.existsSync(restorePath)) {
        fs.unlinkSync(restorePath);
        if (!syncRestoreIntentDirectory(tokenDirectory) && process.platform !== 'win32') throw new Error('Could not durably remove token rollback evidence');
      }
      this.tokenReadIssue = null;
    } catch (error) {
      if (fd !== null) try { fs.closeSync(fd); } catch { }
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { }
      if (!renamed) try { if (fs.existsSync(restorePath)) fs.unlinkSync(restorePath); } catch { }
      if (renamed && !replacementDurable) {
        if (!fs.existsSync(restorePath)) {
          try {
            fs.writeFileSync(restorePath, previousToken ?? Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
            syncTokenFile(restorePath);
          } catch { }
        }
        let rolledBack = false;
        try {
          if (hadPreviousToken) {
            if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
            fs.copyFileSync(restorePath, tokenPath, fs.constants.COPYFILE_EXCL);
            syncTokenFile(tokenPath);
          } else {
            if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
          }
          if (!syncRestoreIntentDirectory(tokenDirectory) && process.platform !== 'win32') throw new Error('Could not durably roll back token replacement');
          rolledBack = true;
        } catch { rolledBack = false; }
        if (!rolledBack) {
          this.tokenReadIssue = 'persistence_ambiguous';
          try { upsertSettings({ google_drive_last_error_code: 'reauth_required' }); } catch { }
          throw new Error('Token persistence is ambiguous; rollback evidence was retained', { cause: error });
        }
      } else if (renamed) {
        this.tokenReadIssue = 'persistence_ambiguous';
        try { upsertSettings({ google_drive_last_error_code: 'reauth_required' }); } catch { }
        throw new Error('Token persistence cleanup is ambiguous', { cause: error });
      }
      throw error;
    }
  }

  private deleteTokens(): void {
    const tokenPath = getTokenFilePath();
    if (!fs.existsSync(tokenPath)) return;
    fs.unlinkSync(tokenPath);
    if (!syncRestoreIntentDirectory(path.dirname(tokenPath)) && process.platform !== 'win32') throw new Error('Could not durably delete stored Google Drive tokens');
  }

  private throwIfStopping(signal?: AbortSignal): void { if (signal?.aborted || this.stopping || this.terminalCleanup) throw createDriveShutdownError('Google Drive operation'); }

  private async delayWithSignal(milliseconds: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      const abort = () => { clearTimeout(timer); reject(createDriveError('cancelled')); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  }

  private runLoopbackFlow(creds: { clientId: string; clientSecret: string }, signal?: AbortSignal): Promise<{ code: string; redirectUri: string; verifier: string }> {
    return new Promise((resolve, reject) => {
      const state = crypto.randomBytes(32).toString('base64url');
      const pkce = createPkcePair();
      let settled = false;
      let redirectUri = '';
      let abort = () => {};
      let server: http.Server;
      const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort); try { server.close(); } catch { } fn(); };
      abort = () => finish(() => reject(createDriveShutdownError('Google Drive connection')));
      server = http.createServer((req, res) => {
        let requestUrl: URL;
        try { requestUrl = new URL(req.url || '/', 'http://127.0.0.1'); } catch { res.writeHead(400).end(); return; }
        if (req.method !== 'GET' || requestUrl.pathname !== '/oauth2callback') { res.writeHead(404).end(); return; }
        const returnedState = requestUrl.searchParams.get('state') || '';
        const code = requestUrl.searchParams.get('code');
        const error = requestUrl.searchParams.get('error');
        const stateMatches = returnedState.length === state.length && crypto.timingSafeEqual(Buffer.from(returnedState), Buffer.from(state));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(error || !code || !stateMatches ? '<html><body>Google Drive connection failed. Close this window and return to FloCafe.</body></html>' : '<html><body>Google Drive connected. Close this window and return to FloCafe.</body></html>');
        if (error) return finish(() => reject(createDriveError('reauth_required')));
        if (!code || !stateMatches) return finish(() => reject(createDriveError('reauth_required')));
        finish(() => resolve({ code, redirectUri, verifier: pkce.verifier }));
      });
      const timeout = setTimeout(() => finish(() => reject(createDriveError('reauth_required'))), LOOPBACK_TIMEOUT_MS);
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      server.on('error', () => finish(() => reject(createDriveError('offline'))));
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
        const client = new googleAuth.OAuth2(creds.clientId, creds.clientSecret, redirectUri);
        const authUrl = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [DRIVE_FILE_SCOPE, 'openid', 'email'], state, code_challenge: pkce.challenge, code_challenge_method: 'S256' as never });
        if (!isSafeGoogleAuthorizationUrl(authUrl)) return finish(() => reject(createDriveError('reauth_required')));
        shell.openExternal(authUrl).catch(() => finish(() => reject(createDriveError('offline'))));
      });
    });
  }

  private cleanupStaging(): void {
    try {
      fs.mkdirSync(getStagingDir(), { recursive: true, mode: 0o700 });
      const pending = parsePending(this.readSettings().google_drive_pending_upload);
      const pendingPath = pending?.local_path ? path.resolve(pending.local_path) : '';
      for (const fileName of fs.readdirSync(getStagingDir())) {
        const fullPath = path.join(getStagingDir(), fileName);
        try { if (path.resolve(fullPath) !== pendingPath && Date.now() - fs.statSync(fullPath).mtimeMs > 24 * 60 * 60_000) fs.rmSync(fullPath, { recursive: true, force: true }); } catch { }
      }
    } catch { }
  }
}

async function hashStagedFile(filePath: string): Promise<{ sha256: string; byteCount: number }> {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw createDriveError('restore_validation_failed');
  const hash = crypto.createHash('sha256');
  let byteCount = 0;
  const stream = fs.createReadStream(filePath, { flags: 'r' });
  try {
    for await (const chunk of stream) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); byteCount += buffer.byteLength; hash.update(buffer); }
  } finally { stream.destroy(); }
  return { sha256: hash.digest('hex'), byteCount };
}

export const googleDrive = new GoogleDriveService();

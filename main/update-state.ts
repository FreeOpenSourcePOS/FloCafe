/** Update-state model and error classification for the app self-updater. */

/** Every state the updater can be in. Do not add states beyond this list without an approved issue. */
export const UPDATE_STATES = [
  'not-checked-yet',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'ready-to-install',
  'check-failed',
  'offline',
  'store-managed',
  'linux-managed',
  'dev-mode',
] as const;

export type UpdateState = (typeof UPDATE_STATES)[number];

export interface RuntimeArtifactDescriptor {
  defaultApp: boolean;
  packaged: boolean;
  unpackedMarker: boolean;
}

export function isDevelopmentOrUnpackedArtifact(artifact: RuntimeArtifactDescriptor): boolean {
  return artifact.defaultApp || !artifact.packaged || artifact.unpackedMarker;
}

/** Why a check or download failed, when known. */
export type UpdateFailureReason = 'manifest-missing' | 'download-failed' | 'unknown';

/** Phase in which an error occurred to disambiguate check vs download errors. */
export type UpdateErrorPhase = 'check' | 'download';

export interface StoredUpdateStatus {
  status: UpdateState;
  /** Version of the available/downloaded update (not the running version). */
  version?: string;
  releaseDate?: string;
  releaseNotes?: unknown;
  percent?: number;
  reason?: UpdateFailureReason;
  /** Raw error detail; renderers show it only as a secondary details line. */
  error?: string;
}

export interface ClassifiedUpdateError {
  state: Extract<UpdateState, 'check-failed' | 'offline'>;
  reason: UpdateFailureReason;
  /** Human-readable raw error message for the details line / main.log. */
  detail: string;
}

/** Node/network error codes indicating an unreachable update server. */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_TIMED_OUT',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_PROXY_CONNECTION_FAILED',
]);

const NETWORK_ERROR_CODE_PATTERN = /^(?:ERR_NETWORK_|ERR_INTERNET_|ERR_CONNECTION_)/;

/** electron-updater-specific code for a missing/unreachable latest.yml channel manifest. */
const CHANNEL_FILE_NOT_FOUND = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND';
const MISSING_UPDATE_CONFIG_PATTERN = /(?:\bENOENT\b|no such file|file not found|cannot find).*app-update\.yml|app-update\.yml.*(?:\bENOENT\b|no such file|file not found)/i;

function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return String(err);
}

export function isMissingUpdateConfigError(err: unknown): boolean {
  return errorCode(err) === 'ENOENT';
}

/** Classify an electron-updater error into an honest user-facing state. */
export function classifyUpdateError(err: unknown, phase: UpdateErrorPhase = 'check'): ClassifiedUpdateError {
  const detail = errorMessage(err);
  const code = errorCode(err);

  // Network class: DNS/routing/timeouts mean offline, not a broken build.
  if (
    (code !== undefined && (NETWORK_ERROR_CODES.has(code) || NETWORK_ERROR_CODE_PATTERN.test(code))) ||
    /ENOTFOUND|ERR_NETWORK_[A-Z_]+|ERR_INTERNET_[A-Z_]+|ERR_CONNECTION_[A-Z_]+|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_PROXY_CONNECTION_FAILED|getaddrinfo|network.*(unreachable|timeout)|socket hang up/i.test(detail)
  ) {
    return { state: 'offline', reason: 'unknown', detail };
  }

  if (phase === 'download') {
    return { state: 'check-failed', reason: 'download-failed', detail };
  }

  // Manifest-missing class: no channel file (latest.yml) or no release
  // artifacts published for this channel yet.
  if (
    code === CHANNEL_FILE_NOT_FOUND ||
    code === 'ENOENT' ||
    /\b404\b|Cannot find latest/i.test(detail) ||
    MISSING_UPDATE_CONFIG_PATTERN.test(detail)
  ) {
    return { state: 'check-failed', reason: 'manifest-missing', detail };
  }

  return { state: 'check-failed', reason: 'unknown', detail };
}

/** Initial stored state before any check has ever run. */
export function initialUpdateState(): StoredUpdateStatus {
  return { status: 'not-checked-yet' };
}

const ONE_SHOT_STATES = ['store-managed', 'linux-managed', 'dev-mode'] as const;

export type OneShotUpdateState = (typeof ONE_SHOT_STATES)[number];

export function isOneShotUpdateState(state: UpdateState): state is OneShotUpdateState {
  return (ONE_SHOT_STATES as readonly string[]).includes(state);
}

/** Build stored state for a one-shot startup detection that persists across reloads. */
export function oneShotUpdateState(state: OneShotUpdateState): StoredUpdateStatus {
  return { status: state };
}

export function missingUpdateConfigState(isDevelopmentArtifact: boolean, detail: string): StoredUpdateStatus {
  return isDevelopmentArtifact
    ? oneShotUpdateState('dev-mode')
    : { status: 'check-failed', reason: 'manifest-missing', error: detail };
}

export function isInstallReady(stored: StoredUpdateStatus, stagedUpdateReady: boolean): boolean {
  return stagedUpdateReady || stored.status === 'ready-to-install';
}

export function isUpdateCheckInFlight(stored: StoredUpdateStatus, phase: UpdateErrorPhase): boolean {
  return stored.status === 'checking' || phase === 'download';
}

/** Payload shape returned by the `get-update-status` IPC handler. */
export interface IpcUpdateStatusPayload {
  status: StoredUpdateStatus['status'];
  version?: string;
  percent?: number;
  reason?: UpdateFailureReason;
  error?: string;
  info: { version: string };
}

/** Derives the IPC response payload from the stored update state. */
export function toIpcUpdateStatus(stored: StoredUpdateStatus, currentVersion: string): IpcUpdateStatusPayload {
  return {
    status: stored.status,
    ...(stored.version !== undefined ? { version: stored.version } : {}),
    ...(stored.percent !== undefined ? { percent: stored.percent } : {}),
    ...(stored.reason !== undefined ? { reason: stored.reason } : {}),
    ...(stored.error !== undefined ? { error: stored.error } : {}),
    info: { version: currentVersion },
  };
}

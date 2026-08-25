import log from 'electron-log/main';

export const TRANSIENT_LOAD_ERRORS = [-102, -105, -106, -118] as const;
export const MAX_LOAD_RETRIES = 10;
export const BASE_RETRY_DELAY_MS = 250;
export const MAX_RETRY_DELAY_MS = 2000;
export const BACKOFF_FACTOR = 1.5;

export function calculateRetryDelay(
  attempt: number,
  baseDelayMs: number = BASE_RETRY_DELAY_MS,
  maxDelayMs: number = MAX_RETRY_DELAY_MS,
  factor: number = BACKOFF_FACTOR,
): number {
  return Math.min(baseDelayMs * Math.pow(factor, attempt), maxDelayMs);
}

export function isTransientLoadError(errorCode: number): boolean {
  return (TRANSIENT_LOAD_ERRORS as readonly number[]).includes(errorCode);
}

export interface WindowLoadRetryLogger {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface WindowLoadRetryOptions {
  maxRetries?: number;
  transientErrors?: readonly number[];
  getRetryDelay?: (attempt: number) => number;
  log?: WindowLoadRetryLogger;
}

import type { BrowserWindow } from 'electron';

export interface RetryableWebContentsLike {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
}

export interface RetryableWindowLike {
  isDestroyed: () => boolean;
  loadURL: (url: string) => Promise<void> | void;
  webContents: RetryableWebContentsLike;
}

export type RetryableWindow = BrowserWindow | RetryableWindowLike;

export interface WindowLoadRetryController {
  getRetries: () => number;
  getPendingTimer: () => NodeJS.Timeout | null;
  cancel: () => void;
  reset: () => void;
}

/**
 * Attaches auto-retry listeners to a window's webContents to recover from transient
 * connection errors (e.g. ERR_CONNECTION_REFUSED (-102), ERR_NAME_NOT_RESOLVED (-105),
 * ERR_INTERNET_DISCONNECTED (-106), ERR_CONNECTION_TIMED_OUT (-118)) during fast restarts
 * or updater relaunches before the embedded server finishes socket binding.
 */
export function setupWindowLoadRetry(
  window: RetryableWindow,
  getTargetUrl: () => string,
  options?: WindowLoadRetryOptions,
): WindowLoadRetryController {
  let loadRetries = 0;
  let loadRetryTimer: NodeJS.Timeout | null = null;

  const maxRetries = options?.maxRetries ?? MAX_LOAD_RETRIES;
  const transientErrors = options?.transientErrors ?? TRANSIENT_LOAD_ERRORS;
  const getDelay = options?.getRetryDelay ?? calculateRetryDelay;
  const logger = options?.log ?? log;

  const handleFinishLoad = () => {
    loadRetries = 0;
    if (loadRetryTimer) {
      clearTimeout(loadRetryTimer);
      loadRetryTimer = null;
    }
  };

  const handleFailLoad = (
    _event: unknown,
    errorCode: number,
    errorDescription: string,
    validatedURL?: string,
  ) => {
    logger.error('[Window] Failed to load:', errorCode, errorDescription, validatedURL);
    console.error('[Window] Failed to load:', errorCode, errorDescription, validatedURL);

    // Auto-retry transient network errors (e.g. -102 ERR_CONNECTION_REFUSED when
    // Squirrel.Mac or OS relaunch fires before the embedded server finishes socket binding).
    if (transientErrors.includes(errorCode) && loadRetries < maxRetries) {
      loadRetries++;
      const delay = getDelay(loadRetries);
      logger.info(`[Window] Retrying loadURL in ${delay}ms (attempt ${loadRetries}/${maxRetries})...`);
      if (loadRetryTimer) clearTimeout(loadRetryTimer);
      loadRetryTimer = setTimeout(() => {
        if (window && !window.isDestroyed()) {
          window.loadURL(getTargetUrl());
        }
      }, delay);
    }
  };

  const webContents = window.webContents as unknown as {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
  };
  webContents.on('did-finish-load', handleFinishLoad);
  webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    handleFailLoad(
      event,
      typeof errorCode === 'number' ? errorCode : 0,
      String(errorDescription),
      typeof validatedURL === 'string' ? validatedURL : undefined,
    );
  });

  return {
    getRetries: () => loadRetries,
    getPendingTimer: () => loadRetryTimer,
    cancel: () => {
      if (loadRetryTimer) {
        clearTimeout(loadRetryTimer);
        loadRetryTimer = null;
      }
    },
    reset: () => {
      loadRetries = 0;
      if (loadRetryTimer) {
        clearTimeout(loadRetryTimer);
        loadRetryTimer = null;
      }
    },
  };
}

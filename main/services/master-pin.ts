import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as bcrypt from 'bcryptjs';

const PIN_REGEX = /^\d{4}$/;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

interface MasterPinBlob {
  hash: string;
  createdAt: string;
  updatedAt: string;
}

function getMasterPinFilePath(): string {
  return path.join(app.getPath('userData'), 'master-pin.enc');
}

export function isMasterPinAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function isMasterPinSet(): boolean {
  return fs.existsSync(getMasterPinFilePath());
}

function readBlob(): MasterPinBlob | null {
  try {
    const encrypted = fs.readFileSync(getMasterPinFilePath());
    const decrypted = safeStorage.decryptString(encrypted);
    const blob = JSON.parse(decrypted) as MasterPinBlob;
    if (!blob?.hash) return null;
    return blob;
  } catch {
    return null;
  }
}

function writeBlob(blob: MasterPinBlob): void {
  const encrypted = safeStorage.encryptString(JSON.stringify(blob));
  fs.writeFileSync(getMasterPinFilePath(), encrypted, { mode: 0o600 });
}

function savePin(pin: string): void {
  if (!PIN_REGEX.test(pin)) {
    throw new Error('Master PIN must be exactly 4 digits');
  }
  const existing = readBlob();
  const now = new Date().toISOString();
  writeBlob({
    hash: bcrypt.hashSync(pin, 10),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

/** Sets the master PIN for the first time (first-run setup). */
export function setMasterPin(pin: string): void {
  savePin(pin);
}

/** Overwrites the master PIN for first-run setup or authenticated owner recovery. */
export function resetMasterPin(pin: string): void {
  savePin(pin);
}

export function verifyMasterPin(pin: string): boolean {
  const blob = readBlob();
  if (!blob) return false;
  return bcrypt.compareSync(pin, blob.hash);
}

const pinAttempts = new Map<string, { count: number; resetAt: number }>();

export function isMasterPinRateLimited(key: string): boolean {
  const nowMs = Date.now();
  const entry = pinAttempts.get(key);
  if (!entry) return false;
  if (nowMs > entry.resetAt) {
    pinAttempts.delete(key);
    return false;
  }
  return entry.count >= RATE_LIMIT_MAX_ATTEMPTS;
}

export function recordMasterPinFailedAttempt(key: string): boolean {
  const nowMs = Date.now();
  const entry = pinAttempts.get(key);
  if (!entry || nowMs > entry.resetAt) {
    pinAttempts.set(key, { count: 1, resetAt: nowMs + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX_ATTEMPTS) return false;
  entry.count++;
  return true;
}

export function resetMasterPinRateLimit(key: string): void {
  pinAttempts.delete(key);
}

export function checkMasterPinRateLimit(key: string): boolean {
  return recordMasterPinFailedAttempt(key);
}

export type MasterPinAuthResult =
  | { ok: true; status?: undefined; error?: undefined }
  | { ok: false; status: number; error: string };

/** Authorizes master PIN for Express middleware and ipcMain handlers. */
export function authorizeMasterPin(pin: string | undefined, rateLimitKey: string): MasterPinAuthResult {
  if (!isMasterPinAvailable()) {
    // Block operations when OS-backed encryption is unavailable to prevent bypasses.
    return {
      ok: false,
      status: 503,
      error: 'Master PIN is not available on this device (OS encryption unavailable). ' +
             'Master PIN-gated operations require a desktop environment with keyring support.',
    };
  }

  if (!isMasterPinSet()) {
    return { ok: false, status: 409, error: 'Master PIN is not set on this device yet. Set one in Settings first.' };
  }

  if (isMasterPinRateLimited(rateLimitKey)) {
    return { ok: false, status: 429, error: 'Too many incorrect Master PIN attempts. Try again later.' };
  }

  if (!pin || typeof pin !== 'string' || !PIN_REGEX.test(pin)) {
    return { ok: false, status: 403, error: 'Invalid Master PIN' };
  }

  if (!verifyMasterPin(pin)) {
    recordMasterPinFailedAttempt(rateLimitKey);
    if (isMasterPinRateLimited(rateLimitKey)) {
      return { ok: false, status: 429, error: 'Too many incorrect Master PIN attempts. Try again later.' };
    }
    return { ok: false, status: 403, error: 'Invalid Master PIN' };
  }

  resetMasterPinRateLimit(rateLimitKey);
  return { ok: true };
}

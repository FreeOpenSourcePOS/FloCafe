/** Daily automatic database backups kept outside the app's data folder. */

import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackup, getDatabase, getSettingValue, upsertSettings } from '../db';

export const LOCAL_BACKUP_SETTING_KEY = 'local_backup_enabled';
export const LOCAL_BACKUP_RETENTION = 5;

const DAY_MS = 24 * 60 * 60_000;
const CHECK_INTERVAL_MS = 60 * 60_000;
const STARTUP_DELAY_MS = 2 * 60_000;
const BACKUP_FILE_PATTERN =
  /^flo-backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z\.db$/;

export function getLocalBackupDir(): string {
  try {
    return path.join(app.getPath('documents'), 'FloCafe', 'Backups');
  } catch {
    return path.join(app.getPath('userData'), 'FloCafe', 'Backups');
  }
}

export function isLocalBackupEnabled(): boolean {
  return getSettingValue(LOCAL_BACKUP_SETTING_KEY) !== 'false';
}

export function setLocalBackupEnabled(enabled: boolean): void {
  upsertSettings({ [LOCAL_BACKUP_SETTING_KEY]: enabled ? 'true' : 'false' });
  if (!enabled) {
    localBackup.cancel();
  }
}

export function localBackupFileName(at: Date): string {
  return `flo-backup-${at.toISOString().replace(/[:.]/g, '-')}.db`;
}

export function parseLocalBackupTime(fileName: string): number | null {
  const match = BACKUP_FILE_PATTERN.exec(fileName);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms = '0'] = match;
  const time = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Number(ms),
  );
  return Number.isNaN(time) ? null : time;
}

let lastPublish = { wallMs: 0, stampMs: 0 };

function currentNowMs(): number {
  const now = Date.now();
  return now >= lastPublish.wallMs ? Math.max(now, lastPublish.stampMs) : now;
}

/**
 * Newest first. Files dated ahead of the clock sort last: their time cannot be trusted.
 * Only files this service wrote are ever listed.
 */
export function listLocalBackups(
  dir: string = getLocalBackupDir(),
  nowMs = currentNowMs(),
): string[] {
  try {
    return fs
      .readdirSync(dir)
      .map((name) => ({ name, time: parseLocalBackupTime(name) }))
      .filter((entry): entry is { name: string; time: number } => entry.time !== null)
      .sort(
        (a, b) =>
          Number(a.time > nowMs) - Number(b.time > nowMs) ||
          b.time - a.time ||
          b.name.localeCompare(a.name),
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function getLastLocalBackupAt(dir?: string): string | null {
  const newest = listLocalBackups(dir)[0];
  return newest ? new Date(parseLocalBackupTime(newest) as number).toISOString() : null;
}

export function isLocalBackupDue(
  newestFileName: string | undefined,
  nowMs = currentNowMs(),
): boolean {
  if (!newestFileName) return true;
  const last = parseLocalBackupTime(newestFileName);
  return last === null || last > nowMs || nowMs - last >= DAY_MS;
}

/** Keeps the newest backups by listing order; `justWritten` is always kept. */
export function pruneLocalBackups(
  dir: string,
  keep: number = LOCAL_BACKUP_RETENTION,
  justWritten?: string,
): string[] {
  const listed = listLocalBackups(dir);
  const ranked =
    justWritten && listed.includes(justWritten)
      ? [justWritten, ...listed.filter((name) => name !== justWritten)]
      : listed;
  const removed: string[] = [];
  for (const name of ranked.slice(keep)) {
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch (error) {
      console.warn(`[LocalBackup] Could not remove old backup ${name}:`, error);
    }
  }
  return removed;
}

function removeQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup failure
  }
}

function stagingPath(dir: string): string {
  return path.join(dir, `.flo-backup-${randomUUID()}.tmp`);
}

/** Links a staged file in under the first free backup name; never replaces an existing file. */
function publishBackup(stagedPath: string, dir: string): string {
  const wallMs = Date.now();
  const startStamp = wallMs >= lastPublish.wallMs ? Math.max(wallMs, lastPublish.stampMs) : wallMs;
  for (let stamp = startStamp; ; stamp++) {
    const name = localBackupFileName(new Date(stamp));
    try {
      fs.linkSync(stagedPath, path.join(dir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    lastPublish = { wallMs, stampMs: stamp };
    removeQuietly(stagedPath);
    return name;
  }
}

/** Copies a finished backup into the local backup folder and applies retention. Best effort. */
export function retainBackupLocally(sourcePath: string): string | null {
  if (!isLocalBackupEnabled()) return null;
  let tempTarget: string | null = null;
  try {
    const dir = getLocalBackupDir();
    fs.mkdirSync(dir, { recursive: true });
    tempTarget = stagingPath(dir);
    fs.copyFileSync(sourcePath, tempTarget);
    const name = publishBackup(tempTarget, dir);
    tempTarget = null;
    pruneLocalBackups(dir, LOCAL_BACKUP_RETENTION, name);
    return path.join(dir, name);
  } catch (error) {
    if (tempTarget) removeQuietly(tempTarget);
    console.warn('[LocalBackup] Could not keep a copy of the backup:', error);
    return null;
  }
}

/** A never-used database is not worth a slot: it would push real backups out of retention. */
function hasBusinessData(): boolean {
  const db = getDatabase();
  return ['orders', 'products', 'customers'].some(
    (table) => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined,
  );
}

class LocalBackupService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private stopping = false;

  start(): void {
    this.stopping = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.runIfDue(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
    this.startupTimer = setTimeout(() => void this.runIfDue(), STARTUP_DELAY_MS);
    this.startupTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.timer = null;
    this.startupTimer = null;
    this.abortController?.abort();
    await this.running?.catch(() => {});
  }

  cancel(): void {
    this.abortController?.abort();
  }

  abort(): void {
    this.cancel();
  }

  runIfDue(): Promise<void> {
    if (this.running || this.stopping) return this.running ?? Promise.resolve();
    this.running = this.backupIfDue()
      .catch((error) => console.warn('[LocalBackup] Backup skipped:', error))
      .finally(() => {
        this.running = null;
        this.abortController = null;
      });
    return this.running;
  }

  private async backupIfDue(): Promise<void> {
    if (!isLocalBackupEnabled()) return;
    const dir = getLocalBackupDir();
    if (!isLocalBackupDue(listLocalBackups(dir)[0])) return;
    if (!hasBusinessData()) return;

    fs.mkdirSync(dir, { recursive: true });
    this.abortController = new AbortController();
    const staged = stagingPath(dir);
    let name: string;
    try {
      await createBackup(staged, this.abortController.signal);
      if (this.stopping || this.abortController?.signal.aborted || !isLocalBackupEnabled()) {
        removeQuietly(staged);
        return;
      }
      name = publishBackup(staged, dir);
    } catch (error) {
      removeQuietly(staged);
      throw error;
    }
    pruneLocalBackups(dir, LOCAL_BACKUP_RETENTION, name);
  }
}

export const localBackup = new LocalBackupService();

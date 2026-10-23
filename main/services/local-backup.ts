/** Daily automatic database backups kept outside the app's data folder. */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackup, getDatabase, getSettingValue, upsertSettings } from '../db';

export const LOCAL_BACKUP_SETTING_KEY = 'local_backup_enabled';
export const LOCAL_BACKUP_RETENTION = 5;

const DAY_MS = 24 * 60 * 60_000;
const CHECK_INTERVAL_MS = 60 * 60_000;
const STARTUP_DELAY_MS = 2 * 60_000;
const BACKUP_FILE_PATTERN = /^flo-backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.db$/;

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
}

export function localBackupFileName(at: Date): string {
  return `flo-backup-${at
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-')}.db`;
}

export function parseLocalBackupTime(fileName: string): number | null {
  const match = BACKUP_FILE_PATTERN.exec(fileName);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const time = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isNaN(time) ? null : time;
}

/** Newest first. Only files this service wrote are ever listed. */
export function listLocalBackups(dir: string = getLocalBackupDir()): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => parseLocalBackupTime(name) !== null)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function getLastLocalBackupAt(dir?: string): string | null {
  const newest = listLocalBackups(dir)[0];
  return newest ? new Date(parseLocalBackupTime(newest) as number).toISOString() : null;
}

export function isLocalBackupDue(newestFileName: string | undefined, nowMs = Date.now()): boolean {
  if (!newestFileName) return true;
  const last = parseLocalBackupTime(newestFileName);
  return last === null || last > nowMs || nowMs - last >= DAY_MS;
}

export function pruneLocalBackups(dir: string, keep: number = LOCAL_BACKUP_RETENTION): string[] {
  const removed: string[] = [];
  for (const name of listLocalBackups(dir).slice(keep)) {
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch (error) {
      console.warn(`[LocalBackup] Could not remove old backup ${name}:`, error);
    }
  }
  return removed;
}

/** Copies a finished backup into the local backup folder and applies retention. Best effort. */
export function retainBackupLocally(sourcePath: string): string | null {
  if (!isLocalBackupEnabled()) return null;
  let tempTarget: string | null = null;
  try {
    const dir = getLocalBackupDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, localBackupFileName(new Date()));
    tempTarget = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.copyFileSync(sourcePath, tempTarget);
    fs.renameSync(tempTarget, target);
    tempTarget = null;
    pruneLocalBackups(dir);
    return target;
  } catch (error) {
    if (tempTarget) {
      try {
        fs.unlinkSync(tempTarget);
      } catch {
        // Ignore cleanup failure
      }
    }
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
    const target = path.join(dir, localBackupFileName(new Date()));
    await createBackup(target, this.abortController.signal);
    pruneLocalBackups(dir);
  }
}

export const localBackup = new LocalBackupService();

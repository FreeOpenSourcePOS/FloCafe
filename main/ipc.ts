import { ipcMain, dialog, app, BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import * as path from 'path';
import * as fs from 'fs';
import { getDatabase, createBackup, restoreBackup, now, getCurrentSchemaVersion, getSchemaVersionFromBackup, resetDatabaseWithBackup, withDatabaseMaintenanceLock, withDatabaseRequest, isManagedBackupFile } from './db';
import { clearInMemoryRevokedTokens, clearUserAuthCache } from './middleware/security';
import { getLocalIP } from './server';
import { clearJWTSecretCache } from './routes/auth';
import { getKdsPort } from './kds-server';
import { authorizeMasterPin, isMasterPinAvailable, isMasterPinSet } from './services/master-pin';
import { runHealthCheck, applySafeFixes } from './services/schema-health';
import { getStatus as getWhatsAppStatus } from './services/whatsapp';
import { createKdsWindow, applyWindowControlAction } from './window-options';
import {
  isCurrentRendererFrame,
  markWindowRendererReady,
  registerRendererDocument,
} from './window-readiness';

// Settings keys the renderer is allowed to write via IPC.
// Must stay in sync with routes/settings.ts ALLOWED_WILDCARD_KEYS.
// Sensitive keys (jwt_secret, cloud_api_key, cloud_*, tax_registration_number, etc.) are excluded.
const ALLOWED_IPC_KEYS = new Set([
  'business_name', 'timezone', 'currency', 'country',
  'state_code', 'business_address', 'business_phone',
  'billing_type', 'bill_show_name', 'bill_show_address',
  'bill_show_phone', 'bill_show_tax_id', 'bill_show_tax_breakdown',
  'bill_show_customer_name', 'bill_show_customer_phone', 'bill_show_table_number',
  'tax_scheme',
  'loyalty_enabled',
  'printer_method', 'paper_size', 'bill_template', 'bill_footer_message',
  'telemetry_enabled',
]);

const SENSITIVE_SETTING_KEYS = new Set([
  'jwt_secret',
  'cloud_api_key',
  'cloud_device_secret',
  'cloud_deletion_status_token',
  'cloud_last_error',
]);

function maskSetting(key: string, value: string): string {
  if (key === 'cloud_last_error') return value ? 'Cloud service request failed' : '';
  if (!SENSITIVE_SETTING_KEYS.has(key)) return value;
  return value ? `****${value.slice(-4)}` : '';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The only window permitted to invoke privileged IPC is the main POS renderer,
 * which the embedded server serves from localhost/127.0.0.1. The KDS window is
 * LAN-served HTTP content and must not reach these handlers, so non-PIN-gated
 * handlers verify the sender's origin before doing anything.
 */
function isTrustedSender(event: Pick<Electron.IpcMainInvokeEvent, 'sender'>): boolean {
  try {
    const url = event.sender?.getURL?.() ?? '';
    return url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:');
  } catch {
    return false;
  }
}

type MainWindowGetter = () => BrowserWindow | null;
type IpcHandler<Args extends unknown[] = unknown[]> =
  (event: Electron.IpcMainInvokeEvent, ...args: Args) => unknown | Promise<unknown>;

interface IpcPrinterInput {
  id?: string;
  name: string;
  connection_type: 'network' | 'usb' | 'webusb';
  ip_address?: string | null;
  port?: number | null;
  is_default?: boolean | number;
}

/**
 * The preload can run before Chromium has committed the localhost URL. In
 * that narrow interval origin is unavailable, so accept only the expected
 * POS BrowserWindow (and still require the current top-level frame below).
 * Every other pre-navigation sender fails closed; once a URL exists the
 * normal localhost origin check remains mandatory.
 */
function isEarlyMainWindowSender(
  event: Pick<Electron.IpcMainEvent, 'sender'>,
  getMainWindow?: MainWindowGetter,
): boolean {
  if (!getMainWindow) return false;
  try {
    const url = event.sender?.getURL?.() ?? '';
    if (url !== '' && url !== 'about:blank') return false;
    const expectedWindow = getMainWindow();
    return Boolean(
      expectedWindow
      && !expectedWindow.isDestroyed()
      && BrowserWindow.fromWebContents(event.sender) === expectedWindow,
    );
  } catch {
    return false;
  }
}

function handle<Args extends unknown[]>(channel: string, listener: IpcHandler<Args>): void {
  ipcMain.handle(channel, (event: Electron.IpcMainInvokeEvent, ...args: Args) => {
    if (!isTrustedSender(event)) return { error: 'Unauthorized sender' };
    return listener(event, ...args);
  });
}

export function registerIpcHandlers(
  shutdownSignal?: AbortSignal,
  getMainWindow?: MainWindowGetter,
): void {
  ipcMain.on('window-document', (event, documentNonce: unknown) => {
    let currentFrame: Electron.WebFrameMain | null = null;
    try {
      currentFrame = event.sender.mainFrame;
    } catch {
      event.returnValue = { success: false, error: 'Invalid document registration' };
      return;
    }
    if (!isCurrentRendererFrame(event.senderFrame, currentFrame)) {
      event.returnValue = { success: false, error: 'Invalid document registration' };
      return;
    }
    if (!isTrustedSender(event) && !isEarlyMainWindowSender(event, getMainWindow)) {
      event.returnValue = { error: 'Unauthorized sender' };
      return;
    }
    event.returnValue = registerRendererDocument(documentNonce)
      ? { success: true }
      : { success: false, error: 'Invalid document nonce' };
  });

  // Database backup/restore
  ipcMain.handle('backup-database', async (event, pin?: string) => {
    const auth = authorizeMasterPin(pin, 'ipc:backup');
    if (!auth.ok) return { success: false, error: auth.error };

    try {
      console.log('[IPC] backup-database: Starting...');

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const result = await dialog.showSaveDialog({
        defaultPath: path.join(app.getPath('documents'), `flo-backup-${timestamp}.db`),
        filters: [{ name: 'SQLite Database', extensions: ['db'] }],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, error: 'Cancelled' };
      }

      const { path: backupPath, schemaVersion } = await createBackup(result.filePath, shutdownSignal);

      console.log('[IPC] backup-database: Complete:', backupPath);
      return {
        success: true,
        path: backupPath,
        schemaVersion,
        message: `Backup saved (Schema v${schemaVersion})`
      };
    } catch (error: unknown) {
      console.error('[IPC] backup-database: Error:', error);
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('restore-backup', async (event, pin?: string, presetBackupPath?: string) => {
    const auth = authorizeMasterPin(pin, 'ipc:restore');
    if (!auth.ok) return { success: false, error: auth.error };

    try {
      // A specific backup (e.g. picked from the Backup History list, #120)
      // skips the native file picker entirely.
      let backupPath = presetBackupPath;
      if (!backupPath) {
        const result = await dialog.showOpenDialog({
          filters: [{ name: 'SQLite Database', extensions: ['db'] }],
          properties: ['openFile'],
        });

        if (result.canceled || !result.filePaths.length) {
          return { success: false, error: 'Cancelled' };
        }
        backupPath = result.filePaths[0];
      } else if (!fs.existsSync(backupPath)) {
        return { success: false, error: 'Backup file no longer exists' };
      } else if (!isManagedBackupFile(backupPath)) {
        return { success: false, error: 'Restore source must be a Flo-managed backup file' };
      }

      const backupVersion = getSchemaVersionFromBackup(backupPath);

      if (backupVersion === null) {
        return {
          success: false,
          error: 'Invalid backup file: missing schema version metadata. This backup may have been created with an older version of FloDesktop.'
        };
      }

      const versionMismatch = backupVersion !== getCurrentSchemaVersion();

      if (versionMismatch) {
        const confirmResult = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Restore Anyway', 'Cancel'],
          defaultId: 1,
          title: 'Schema Version Mismatch',
          message: `Backup was created with Schema v${backupVersion}`,
          detail: `Current database uses Schema v${getCurrentSchemaVersion()}.\n\nRestoring will import data only (common fields) to preserve new database structure.\n\nDo you want to continue?`
        });

        if (confirmResult.response !== 0) {
          return { success: false, error: 'Cancelled' };
        }

        const restoreResult = await withDatabaseMaintenanceLock(
          (signal) => restoreBackup(backupPath, false, signal),
          shutdownSignal,
        );
        clearUserAuthCache();
        clearInMemoryRevokedTokens();
        clearJWTSecretCache();
        return {
          success: restoreResult.success,
          mode: restoreResult.mode,
          backupVersion,
          currentVersion: getCurrentSchemaVersion(),
          tablesRestored: restoreResult.tablesRestored,
          message: restoreResult.success
            ? `Restored ${restoreResult.tablesRestored} tables (data-only mode due to version mismatch)`
            : `Restore failed: ${restoreResult.error}`,
          error: restoreResult.error
        };
      }

      const restoreResult = await withDatabaseMaintenanceLock(
        (signal) => restoreBackup(backupPath, true, signal),
        shutdownSignal,
      );
      clearUserAuthCache();
      clearInMemoryRevokedTokens();
      clearJWTSecretCache();
      return {
        success: restoreResult.success,
        mode: restoreResult.mode,
        backupVersion,
        currentVersion: getCurrentSchemaVersion(),
        tablesRestored: restoreResult.tablesRestored,
        message: restoreResult.success ? 'Database restored successfully' : `Restore failed: ${restoreResult.error}`,
        error: restoreResult.error
      };
    } catch (error: unknown) {
      console.error('[IPC] restore-backup: Error:', error);
      return { success: false, error: getErrorMessage(error) };
    }
  });

  // DB health check / master PIN / initialize (menu + tray triggered)
  handle('db-health-check', async () => {
    return withDatabaseRequest(async () => {
    try {
      return runHealthCheck();
    } catch (error: unknown) {
      return { error: getErrorMessage(error) };
    }
    });
  });

  handle('db-apply-safe-fixes', async (event, findingIds?: string[]) => {
    return withDatabaseRequest(async () => {
    try {
      return applySafeFixes(findingIds);
    } catch (error: unknown) {
      return { applied: [], skipped: [], errors: [{ id: 'all', error: getErrorMessage(error) }] };
    }
    });
  });

  handle('master-pin-status', async () => {
    return { available: isMasterPinAvailable(), isSet: isMasterPinSet() };
  });

  ipcMain.handle('db-initialize', async (event, { pin, confirmationPhrase }: { pin?: string; confirmationPhrase?: string }) => {
    const auth = authorizeMasterPin(pin, 'ipc:initialize');
    if (!auth.ok) return { success: false, error: auth.error };
    if (confirmationPhrase !== 'INITIALIZE') {
      return { success: false, error: 'Confirmation phrase does not match' };
    }

    try {
      const { backupPath } = await resetDatabaseWithBackup(shutdownSignal);
      clearUserAuthCache();
      clearInMemoryRevokedTokens();
      clearJWTSecretCache();
      return { success: true, backupPath };
    } catch (error: unknown) {
      console.error('[IPC] db-initialize: Error:', error);
      return { success: false, error: getErrorMessage(error) };
    }
  });

  // Narrow window-control surface for the renderer title bar's HTML fallback
  // controls (only mounted when main reports 'html-fallback'). The trusted-
  // sender wrapper above already restricts this to the localhost-served POS
  // renderer; KDS/print popups carry no preload bridge. 'close' routes through
  // BrowserWindow.close() so it fires the same event as the native caption
  // button and honors close-to-tray behavior.
  handle('window-action', (event, action: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { error: 'Window unavailable' };
    return applyWindowControlAction(win, action);
  });

  handle('window-ready', (event, payload: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { error: 'Window unavailable' };
    let currentFrame: Electron.WebFrameMain | null = null;
    try {
      currentFrame = event.sender.mainFrame;
    } catch {
      return { success: false, error: 'Stale or invalid readiness report' };
    }
    if (!isCurrentRendererFrame(event.senderFrame, currentFrame)) {
      return { success: false, error: 'Stale or invalid readiness report' };
    }
    // Reports are bound to the readiness epoch of the document that sent them
    // (see main/window-readiness.ts). Stale or malformed reports are ignored:
    // a previous document must never mark the current one ready.
    const reported = payload as { epoch?: unknown; documentNonce?: unknown } | null | undefined;
    if (!markWindowRendererReady(reported?.epoch, reported?.documentNonce)) {
      return { success: false, error: 'Stale or invalid readiness report' };
    }
    win.show();
    return { success: true };
  });

  // Settings
  handle('get-settings', async () => {
    return withDatabaseRequest(async () => {
    try {
      const db = getDatabase();
      const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
      const settings: Record<string, string> = {};
      rows.forEach((row) => {
        settings[row.key] = maskSetting(row.key, row.value);
      });
      return settings;
    } catch (error: unknown) {
      return { error: getErrorMessage(error) };
    }
    });
  });

  handle('set-setting', async (event, key: string, value: string) => {
    return withDatabaseRequest(async () => {
    try {
      if (typeof key !== 'string' || typeof value !== 'string' || value.length > 10_000) {
        return { success: false, error: 'Invalid setting value' };
      }
      if (!ALLOWED_IPC_KEYS.has(key)) {
        return { success: false, error: 'Setting not allowed via IPC' };
      }
      const db = getDatabase();
      db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run(key, value, now());
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: getErrorMessage(error) };
    }
    });
  });

  // WhatsApp status snapshot for renderer polling on app focus
  handle('whatsapp-get-status', async () => withDatabaseRequest(async () => {
    try {
      return getWhatsAppStatus();
    } catch (err: unknown) {
      return { error: getErrorMessage(err) };
    }
  }));

  // Module-level reference to ensure single instance
  let activeKdsWindow: BrowserWindow | null = null;

  // KDS info
  handle('get-kds-info', async () => {
    const localIP = getLocalIP();
    const port = getKdsPort();
    return {
      url: `http://${localIP}:${port}/kds`,
      wsUrl: `ws://${localIP}:${port}/kds`,
      localIP,
      port,
    };
  });

  // Window management
  handle('open-kds-window', async () => {
    if (activeKdsWindow && !activeKdsWindow.isDestroyed()) {
      activeKdsWindow.focus();
      return;
    }

    const port = getKdsPort();
    const localIP = getLocalIP();
    const kdsOrigin = `http://${localIP}:${port}`;

    activeKdsWindow = createKdsWindow(BrowserWindow);

    activeKdsWindow.on('closed', () => {
      activeKdsWindow = null;
    });

    // Confine the KDS window to its own origin and deny new windows so a
    // modified or unexpected document cannot navigate away and reach other
    // local services or content.
    activeKdsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    activeKdsWindow.webContents.on('will-navigate', (event, url) => {
      let allowed = false;
      try {
        allowed = new URL(url).origin === kdsOrigin;
      } catch {
        allowed = false;
      }
      if (!allowed) event.preventDefault();
    });

    activeKdsWindow.loadURL(`${kdsOrigin}/kds`);
  });

  handle('get-app-info', async () => {
    return {
      version: app.getVersion(),
      name: app.getName(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
    };
  });

  // Printers
  handle('get-printers', async () => {
    return withDatabaseRequest(async () => {
    try {
      const db = getDatabase();
      const printers = db.prepare('SELECT * FROM printers ORDER BY name').all();
      return printers;
    } catch (error: unknown) {
      return { error: getErrorMessage(error) };
    }
    });
  });

  handle('save-printer', async (event, printer: IpcPrinterInput) => {
    return withDatabaseRequest(async () => {
    try {
      // Validate printer name — reject names with shell metacharacters (command injection defense)
      const PRINTER_NAME_REGEX = /^[a-zA-Z0-9\s\-_.()]+$/;
      if (printer.name && !PRINTER_NAME_REGEX.test(printer.name)) {
        return { success: false, error: 'Printer name contains invalid characters' };
      }
      const db = getDatabase();
      const port = printer.port === null ? null : (printer.port || 9100);
      if (printer.id) {
        db.prepare(`
          UPDATE printers SET name = ?, connection_type = ?, ip_address = ?,
            port = ?, is_default = ?, updated_at = ?
          WHERE id = ?
        `).run(printer.name, printer.connection_type, printer.ip_address ?? null,
          port, printer.is_default ? 1 : 0, now(), printer.id);
      } else {
        db.prepare(`
          INSERT INTO printers (id, name, connection_type, ip_address, port, is_default, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), printer.name, printer.connection_type, printer.ip_address ?? null,
          port, printer.is_default ? 1 : 0, now(), now());
      }
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: getErrorMessage(error) };
    }
    });
  });

  // Reports
  handle('get-daily-summary', async () => {
    return withDatabaseRequest(async () => {
    try {
      const db = getDatabase();
      const today = new Date().toISOString().slice(0, 10);

      const bills = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM bills WHERE date(paid_at) = date(?)) as bill_count,
          COALESCE((SELECT SUM(paid_amount) FROM bills WHERE date(paid_at) = date(?)), 0)
          - COALESCE((SELECT SUM(amount_cents) / 100.0 FROM refunds WHERE date(created_at) = date(?)), 0) as revenue
      `).get(today, today, today) as { bill_count: number; revenue: number };

      const covers = db.prepare(`
        SELECT COALESCE(SUM(guest_count), 0) as covers FROM orders
        WHERE date(created_at) = date(?) AND status != 'cancelled'
      `).get(today) as { covers: number };

      const pendingOrders = db.prepare(`
        SELECT COUNT(*) as count FROM orders WHERE status IN ('pending', 'preparing')
      `).get() as { count: number };

      return {
        date: today,
        revenue: bills.revenue,
        bill_count: bills.bill_count,
        covers: covers.covers,
        pending_orders: pendingOrders.count,
      };
    } catch (error: unknown) {
      return { error: getErrorMessage(error) };
    }
    });
  });

  console.log('[IPC] Handlers registered');
}

import { ipcMain, dialog, app, BrowserWindow, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getDatabase, createBackup, restoreBackup, now, getCurrentSchemaVersion, getSchemaVersionFromBackup, resetDatabaseWithBackup, withDatabaseMaintenanceLock, withDatabaseRequest } from './db';
import { clearInMemoryRevokedTokens, clearUserAuthCache } from './middleware/security';
import { getLocalIP } from './server';
import { clearJWTSecretCache } from './routes/auth';
import { getKdsPort } from './kds-server';
import { authorizeMasterPin, isMasterPinAvailable, isMasterPinSet } from './services/master-pin';
import { runHealthCheck, applySafeFixes } from './services/schema-health';
import { getStatus as getWhatsAppStatus } from './services/whatsapp';

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

export function registerIpcHandlers(shutdownSignal?: AbortSignal): void {
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
    } catch (error: any) {
      console.error('[IPC] backup-database: Error:', error);
      return { success: false, error: error.message };
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
    } catch (error: any) {
      console.error('[IPC] restore-backup: Error:', error);
      return { success: false, error: error.message };
    }
  });

  // DB health check / master PIN / initialize (menu + tray triggered)
  ipcMain.handle('db-health-check', async () => {
    return withDatabaseRequest(async () => {
    try {
      return runHealthCheck();
    } catch (error: any) {
      return { error: error.message };
    }
    });
  });

  ipcMain.handle('db-apply-safe-fixes', async (event, findingIds?: string[]) => {
    return withDatabaseRequest(async () => {
    try {
      return applySafeFixes(findingIds);
    } catch (error: any) {
      return { applied: [], skipped: [], errors: [{ id: 'all', error: error.message }] };
    }
    });
  });

  ipcMain.handle('master-pin-status', async () => {
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
    } catch (error: any) {
      console.error('[IPC] db-initialize: Error:', error);
      return { success: false, error: error.message };
    }
  });

  // Settings
  ipcMain.handle('get-settings', async () => {
    return withDatabaseRequest(async () => {
    try {
      const db = getDatabase();
      const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
      const settings: Record<string, string> = {};
      rows.forEach((row) => {
        settings[row.key] = maskSetting(row.key, row.value);
      });
      return settings;
    } catch (error: any) {
      return { error: error.message };
    }
    });
  });

  ipcMain.handle('set-setting', async (event, key: string, value: string) => {
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
    } catch (error: any) {
      return { success: false, error: error.message };
    }
    });
  });

  // WhatsApp status snapshot for renderer polling on app focus
  ipcMain.handle('whatsapp-get-status', async () => withDatabaseRequest(async () => {
    try {
      return getWhatsAppStatus();
    } catch (err: any) {
      return { error: err.message };
    }
  }));

  // Module-level reference to ensure single instance
  let activeKdsWindow: BrowserWindow | null = null;

  // KDS info
  ipcMain.handle('get-kds-info', async () => {
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
  ipcMain.handle('open-kds-window', async () => {
    if (activeKdsWindow && !activeKdsWindow.isDestroyed()) {
      activeKdsWindow.focus();
      return;
    }

    const port = getKdsPort();
    activeKdsWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      title: 'Flo - Kitchen Display',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    activeKdsWindow.on('closed', () => {
      activeKdsWindow = null;
    });

    const localIP = getLocalIP();
    activeKdsWindow.loadURL(`http://${localIP}:${port}/kds`);
  });

  ipcMain.handle('get-app-info', async () => {
    return {
      version: app.getVersion(),
      name: app.getName(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
    };
  });

  // Printers
  ipcMain.handle('get-printers', async () => {
    return withDatabaseRequest(async () => {
    try {
      const db = getDatabase();
      const printers = db.prepare('SELECT * FROM printers ORDER BY name').all();
      return printers;
    } catch (error: any) {
      return { error: error.message };
    }
    });
  });

  ipcMain.handle('save-printer', async (event, printer: any) => {
    return withDatabaseRequest(async () => {
    try {
      // Validate printer name — reject names with shell metacharacters (command injection defense)
      const PRINTER_NAME_REGEX = /^[a-zA-Z0-9\s\-_.()]+$/;
      if (printer.name && !PRINTER_NAME_REGEX.test(printer.name)) {
        return { success: false, error: 'Printer name contains invalid characters' };
      }
      const db = getDatabase();
      if (printer.id) {
        db.prepare(`
          UPDATE printers SET name = ?, type = ?, connection_type = ?, ip_address = ?,
            port = ?, usb_vendor_id = ?, usb_product_id = ?, is_default = ?, updated_at = ?
          WHERE id = ?
        `).run(printer.name, printer.type, printer.connection_type, printer.ip_address,
          printer.port || 9100, printer.usb_vendor_id, printer.usb_product_id,
          printer.is_default ? 1 : 0, now(), printer.id);
      } else {
        db.prepare(`
          INSERT INTO printers (name, type, connection_type, ip_address, port, usb_vendor_id, usb_product_id, is_default, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(printer.name, printer.type, printer.connection_type, printer.ip_address,
          printer.port || 9100, printer.usb_vendor_id, printer.usb_product_id,
          printer.is_default ? 1 : 0, now(), now());
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
    });
  });

  // Reports
  ipcMain.handle('get-daily-summary', async () => {
    return withDatabaseRequest(async () => {
    try {
      const db = getDatabase();
      const today = new Date().toISOString().slice(0, 10);

      const bills = db.prepare(`
        SELECT COUNT(*) as bill_count, COALESCE(SUM(total), 0) as revenue
        FROM bills WHERE date(created_at) = date(?) AND payment_status = 'paid'
      `).get(today) as { bill_count: number; revenue: number };

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
    } catch (error: any) {
      return { error: error.message };
    }
    });
  });

  console.log('[IPC] Handlers registered');
}

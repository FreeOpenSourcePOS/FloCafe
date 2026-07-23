const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  backupDatabase: (pin?: string) => ipcRenderer.invoke('backup-database', pin),
  restoreBackup: (pin?: string, backupPath?: string) => ipcRenderer.invoke('restore-backup', pin, backupPath),
  dbHealthCheck: () => ipcRenderer.invoke('db-health-check'),
  dbApplySafeFixes: (findingIds?: string[]) => ipcRenderer.invoke('db-apply-safe-fixes', findingIds),
  dbInitialize: (pin: string, confirmationPhrase: string) => ipcRenderer.invoke('db-initialize', { pin, confirmationPhrase }),
  getMasterPinStatus: () => ipcRenderer.invoke('master-pin-status'),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('set-setting', key, value),

  getKdsInfo: () => ipcRenderer.invoke('get-kds-info'),
  openKdsWindow: () => ipcRenderer.invoke('open-kds-window'),

  getAppInfo: () => ipcRenderer.invoke('get-app-info'),

  getStatus: () => ipcRenderer.invoke('get-status'),

  getPrinters: () => ipcRenderer.invoke('get-printers'),
  savePrinter: (printer: any) => ipcRenderer.invoke('save-printer', printer),

  getDailySummary: () => ipcRenderer.invoke('get-daily-summary'),

  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onUpdateStatus: (callback: (status: any) => void) => {
    const handler = (_event: any, status: any) => callback(status);
    ipcRenderer.on('update-status', handler);
    return () => { ipcRenderer.removeListener('update-status', handler); };
  },

  onMenuAction: (callback: (channel: string) => void) => {
    const channels = [
      'new-order', 'quick-search', 'backup-database', 'restore-backup',
      'view-orders', 'report-daily', 'report-sales', 'report-x', 'report-z',
      'settings-business', 'settings-tax', 'settings-printer', 'settings-kitchen',
      'menu-db-health-check', 'menu-db-initialize', 'menu-master-pin',
    ];
    const handlers: (() => void)[] = [];
    channels.forEach((channel) => {
      const handler = () => callback(channel);
      ipcRenderer.on(channel, handler);
      handlers.push(() => ipcRenderer.removeListener(channel, handler));
    });
    return () => { handlers.forEach((remove) => remove()); };
  },

  platform: process.platform,
});
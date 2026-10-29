import * as fs from 'fs';
import * as path from 'path';
import type { dialog as ElectronDialog, shell as ElectronShell } from 'electron';
import type {
  CompatibleDowngradeBackup,
  DowngradeBackupDiscovery,
  DowngradeRestoreOptions,
  DowngradeRestoreResult,
  SchemaVersionMismatchError,
} from './db';

export const FLOCAFE_RELEASES_URL = 'https://github.com/FreeOpenSourcePOS/FloCafe/releases';

const BACKUP_PAGE_SIZE = 5;

export interface DowngradeRecoveryLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface DowngradeRecoveryDeps {
  appVersion: string;
  dialog: Pick<typeof ElectronDialog, 'showMessageBox'>;
  shell: Pick<typeof ElectronShell, 'openExternal' | 'openPath'>;
  log: DowngradeRecoveryLogger;
  isShutdownRequested: () => boolean;
  discoverBackups: () => Promise<DowngradeBackupDiscovery>;
  planPreservedArchivePath: (newerDbVersion: number) => string;
  restoreBackup: (
    backupPath: string,
    options?: DowngradeRestoreOptions,
  ) => Promise<DowngradeRestoreResult>;
  getBackupDir: () => string;
  getDbPath: () => string;
}

export type DowngradeRecoveryOutcome =
  | { outcome: 'exit' }
  | { outcome: 'opened_releases'; url: string }
  | { outcome: 'restored'; result: DowngradeRestoreResult };

function formatKindLabel(kind: CompatibleDowngradeBackup['kind']): string {
  if (kind === 'pre-upgrade') return 'Pre-upgrade backup';
  if (kind === 'pre-restore') return 'Pre-restore backup';
  return 'Backup';
}

function formatBackupTimestamp(backup: CompatibleDowngradeBackup): string {
  return backup.backupCreatedAt || backup.createdAt;
}

function formatBackupSummaryLine(backup: CompatibleDowngradeBackup, index: number): string {
  const appMeta = backup.appVersion ? `Flo Cafe v${backup.appVersion}` : 'app version not recorded';
  const timeMeta = formatBackupTimestamp(backup);
  return `${index}. ${formatKindLabel(backup.kind)} - schema v${backup.schemaVersion}, ${appMeta}, ${timeMeta} (${backup.fileName})`;
}

function formatBackupButtonLabel(backup: CompatibleDowngradeBackup, index: number): string {
  const versionPart = backup.appVersion
    ? `v${backup.appVersion} (schema v${backup.schemaVersion})`
    : `schema v${backup.schemaVersion}`;
  return `${index}. Restore ${formatKindLabel(backup.kind)} - ${versionPart}`;
}

function buildNoCompatibleBackupsDetail(discovery: DowngradeBackupDiscovery): string {
  const lines: string[] = [
    `Backups folder: ${discovery.backupDir}`,
    `Supported database schema: up to v${discovery.maxSupportedSchemaVersion}`,
    '',
  ];

  if (discovery.incompatibleNewer.length === 0 && discovery.corruptOrInvalid.length === 0) {
    lines.push('No backup database files were found in the backups folder.');
  } else {
    if (discovery.incompatibleNewer.length > 0) {
      lines.push(
        `${discovery.incompatibleNewer.length} backup(s) require a newer Flo Cafe version:`,
      );
      for (const item of discovery.incompatibleNewer.slice(0, 3)) {
        const versionMeta = item.appVersion ? `, Flo Cafe v${item.appVersion}` : '';
        const schemaMeta = item.schemaVersion !== null ? `schema v${item.schemaVersion}` : 'newer';
        lines.push(`  - ${item.fileName} (${schemaMeta}${versionMeta})`);
      }
      if (discovery.incompatibleNewer.length > 3) {
        lines.push(`  - ...and ${discovery.incompatibleNewer.length - 3} more`);
      }
      lines.push('');
    }
    if (discovery.corruptOrInvalid.length > 0) {
      lines.push(
        `${discovery.corruptOrInvalid.length} file(s) failed integrity or schema validation:`,
      );
      for (const item of discovery.corruptOrInvalid.slice(0, 3)) {
        lines.push(`  - ${item.fileName}: ${item.detail}`);
      }
      if (discovery.corruptOrInvalid.length > 3) {
        lines.push(`  - ...and ${discovery.corruptOrInvalid.length - 3} more`);
      }
      lines.push('');
    }
  }

  lines.push('No database or backup files were modified.');
  return lines.join('\n');
}

function isShutdownAbortError(error: unknown): boolean {
  const details = error as { code?: unknown; name?: unknown } | null;
  return (
    details?.code === 'ERR_SHUTDOWN_ABORTED' ||
    details?.code === 'ABORT_ERR' ||
    details?.name === 'AbortError'
  );
}

async function openReleasesPage(deps: DowngradeRecoveryDeps): Promise<boolean> {
  try {
    await deps.shell.openExternal(FLOCAFE_RELEASES_URL);
    return true;
  } catch (error: unknown) {
    if (deps.isShutdownRequested() || isShutdownAbortError(error)) return false;
    deps.log.error('[Recovery] Failed to open Flo Cafe releases page:', error);
    const errorMessage = error instanceof Error ? error.message : 'unknown error';
    await deps.dialog.showMessageBox({
      type: 'error',
      title: 'Cannot Open Download Page',
      message: 'Could not open the Flo Cafe releases page in your browser.',
      detail: `Open this address manually to download the latest Flo Cafe release:\n${FLOCAFE_RELEASES_URL}\n\nError: ${errorMessage}`,
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return false;
  }
}

async function revealBackupsFolder(deps: DowngradeRecoveryDeps): Promise<void> {
  let backupDir = '(backups folder)';
  try {
    backupDir = deps.getBackupDir();
    const fallbackDir = path.dirname(deps.getDbPath());
    const targetDir = fs.existsSync(backupDir)
      ? backupDir
      : fs.existsSync(fallbackDir)
        ? fallbackDir
        : backupDir;
    const openError = await deps.shell.openPath(targetDir);
    if (deps.isShutdownRequested()) return;
    if (openError) {
      deps.log.warn('[Recovery] shell.openPath reported an error:', openError);
      await deps.dialog.showMessageBox({
        type: 'warning',
        title: 'Cannot Open Backups Folder',
        message: 'Could not open the backups folder automatically.',
        detail: `Backups location:\n${backupDir}\n\nSystem message: ${openError}`,
        buttons: ['OK'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
    }
  } catch (error: unknown) {
    if (deps.isShutdownRequested() || isShutdownAbortError(error)) return;
    deps.log.error('[Recovery] Failed to open backups folder:', error);
    const errorMessage = error instanceof Error ? error.message : 'unknown error';
    await deps.dialog.showMessageBox({
      type: 'warning',
      title: 'Cannot Open Backups Folder',
      message: 'Could not open the backups folder automatically.',
      detail: `Backups location:\n${backupDir}\n\nError: ${errorMessage}`,
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  }
}

async function presentRestoreStepErrorDialog(
  deps: DowngradeRecoveryDeps,
  options: {
    title: string;
    message: string;
    error: unknown;
    fallbackErrorText: string;
    recoveryGuidance: string;
  },
): Promise<'retry' | 'exit'> {
  const errorMessage =
    options.error instanceof Error && options.error.message
      ? options.error.message
      : options.fallbackErrorText;
  const errorChoice = await deps.dialog.showMessageBox({
    type: 'error',
    title: options.title,
    message: options.message,
    detail: [errorMessage, '', options.recoveryGuidance].join('\n'),
    buttons: ['Back to Recovery Options', 'Open Backups Folder', 'Exit'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });

  if (deps.isShutdownRequested()) return 'exit';
  if (errorChoice.response === 0) return 'retry';
  if (errorChoice.response === 1) {
    await revealBackupsFolder(deps);
    return deps.isShutdownRequested() ? 'exit' : 'retry';
  }
  return 'exit';
}

async function selectCompatibleBackup(
  discovery: DowngradeBackupDiscovery,
  deps: DowngradeRecoveryDeps,
): Promise<CompatibleDowngradeBackup | null> {
  let page = 0;
  const totalPages = Math.max(1, Math.ceil(discovery.compatible.length / BACKUP_PAGE_SIZE));

  while (!deps.isShutdownRequested()) {
    const start = page * BACKUP_PAGE_SIZE;
    const pageItems = discovery.compatible.slice(start, start + BACKUP_PAGE_SIZE);

    const detailLines: string[] = [
      `Validated compatible backups (schema <= v${discovery.maxSupportedSchemaVersion}):`,
      '',
      ...pageItems.map((backup, idx) => formatBackupSummaryLine(backup, start + idx + 1)),
    ];

    if (discovery.incompatibleNewer.length > 0 || discovery.corruptOrInvalid.length > 0) {
      detailLines.push('');
      const excludedParts: string[] = [];
      if (discovery.incompatibleNewer.length > 0) {
        excludedParts.push(`${discovery.incompatibleNewer.length} newer incompatible`);
      }
      if (discovery.corruptOrInvalid.length > 0) {
        excludedParts.push(`${discovery.corruptOrInvalid.length} invalid/corrupt`);
      }
      detailLines.push(`Excluded after SQLite validation: ${excludedParts.join(', ')}.`);
    }

    const buttons = pageItems.map((backup, idx) =>
      formatBackupButtonLabel(backup, start + idx + 1),
    );
    let prevButtonIndex = -1;
    let nextButtonIndex = -1;
    if (page > 0) {
      prevButtonIndex = buttons.length;
      buttons.push('Previous Backups');
    }
    if (page + 1 < totalPages) {
      nextButtonIndex = buttons.length;
      buttons.push('More Backups...');
    }
    const cancelButtonIndex = buttons.length;
    buttons.push('Cancel');

    const selection = await deps.dialog.showMessageBox({
      type: 'question',
      title: 'Select Compatible Backup',
      message: 'Choose a validated compatible backup to restore',
      detail: detailLines.join('\n'),
      buttons,
      defaultId: 0,
      cancelId: cancelButtonIndex,
      noLink: true,
    });

    if (deps.isShutdownRequested()) return null;
    if (selection.response === cancelButtonIndex) return null;
    if (selection.response === prevButtonIndex) {
      page -= 1;
      continue;
    }
    if (selection.response === nextButtonIndex) {
      page += 1;
      continue;
    }
    const chosen = pageItems[selection.response];
    return chosen ?? null;
  }

  return null;
}

export async function runDowngradeRecoveryFlow(
  mismatch: SchemaVersionMismatchError,
  deps: DowngradeRecoveryDeps,
): Promise<DowngradeRecoveryOutcome> {
  const dbAppMeta = mismatch.dbAppVersion ? ` (Flo Cafe v${mismatch.dbAppVersion})` : '';

  while (!deps.isShutdownRequested()) {
    const mainDetail = [
      `Current database schema: v${mismatch.dbVersion}${dbAppMeta}`,
      `Running Flo Cafe version: v${deps.appVersion} (supports up to schema v${mismatch.appVersion})`,
      '',
      'Opening a newer database with an older version of Flo Cafe is blocked so your data is never altered or lost.',
      '',
      'Choose how to continue:',
      '- Get Latest Version: download and install the latest Flo Cafe release (recommended).',
      '- Open Backups Folder: view your local backups in the file manager.',
      '- Restore Compatible Backup: restore an earlier compatible backup and preserve the newer database aside.',
      '- Exit: close Flo Cafe safely without changing any files.',
    ].join('\n');

    const mainChoice = await deps.dialog.showMessageBox({
      type: 'warning',
      title: 'Newer Database Detected',
      message: 'This database was created or upgraded by a newer version of Flo Cafe.',
      detail: mainDetail,
      buttons: ['Get Latest Version', 'Open Backups Folder', 'Restore Compatible Backup', 'Exit'],
      defaultId: 0,
      cancelId: 3,
      noLink: true,
    });

    if (deps.isShutdownRequested()) return { outcome: 'exit' };

    if (mainChoice.response === 0) {
      const opened = await openReleasesPage(deps);
      if (deps.isShutdownRequested()) return { outcome: 'exit' };
      if (opened) return { outcome: 'opened_releases', url: FLOCAFE_RELEASES_URL };
      continue;
    }

    if (mainChoice.response === 1) {
      await revealBackupsFolder(deps);
      continue;
    }

    if (mainChoice.response === 2) {
      let discovery: DowngradeBackupDiscovery;
      try {
        discovery = await deps.discoverBackups();
      } catch (discoveryError: unknown) {
        if (deps.isShutdownRequested() || isShutdownAbortError(discoveryError)) {
          return { outcome: 'exit' };
        }
        deps.log.error('[Recovery] Compatible backup discovery failed:', discoveryError);
        const action = await presentRestoreStepErrorDialog(deps, {
          title: 'Backup Inspection Failed',
          message: 'Flo Cafe could not inspect local backups.',
          error: discoveryError,
          fallbackErrorText: 'An unexpected error occurred while inspecting backups.',
          recoveryGuidance:
            'No database or backup files were modified. You can update Flo Cafe to the latest version, inspect the backups folder, try again, or exit safely.',
        });
        if (action === 'retry') continue;
        return { outcome: 'exit' };
      }
      if (deps.isShutdownRequested()) return { outcome: 'exit' };
      if (discovery.compatible.length === 0) {
        const emptyChoice = await deps.dialog.showMessageBox({
          type: 'warning',
          title: 'No Compatible Backup Available',
          message: 'No compatible, valid backup was found to restore.',
          detail: buildNoCompatibleBackupsDetail(discovery),
          buttons: ['Get Latest Version', 'Open Backups Folder', 'Exit'],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        });

        if (deps.isShutdownRequested()) return { outcome: 'exit' };
        if (emptyChoice.response === 0) {
          const opened = await openReleasesPage(deps);
          if (deps.isShutdownRequested()) return { outcome: 'exit' };
          if (opened) return { outcome: 'opened_releases', url: FLOCAFE_RELEASES_URL };
          continue;
        }
        if (emptyChoice.response === 1) {
          await revealBackupsFolder(deps);
          continue;
        }
        return { outcome: 'exit' };
      }

      const selectedBackup = await selectCompatibleBackup(discovery, deps);
      if (deps.isShutdownRequested()) return { outcome: 'exit' };
      if (!selectedBackup) continue;

      let plannedArchivePath: string;
      try {
        plannedArchivePath = deps.planPreservedArchivePath(mismatch.dbVersion);
      } catch (planError: unknown) {
        if (deps.isShutdownRequested() || isShutdownAbortError(planError)) {
          return { outcome: 'exit' };
        }
        deps.log.error(
          '[Recovery] Failed to plan preserved newer-database archive path:',
          planError,
        );
        const action = await presentRestoreStepErrorDialog(deps, {
          title: 'Backup Restore Failed',
          message: 'Flo Cafe could not prepare the archive path for the newer database.',
          error: planError,
          fallbackErrorText: 'An unexpected error occurred while preparing the archive path.',
          recoveryGuidance:
            'No database or backup files were modified. You can update Flo Cafe to the latest version, inspect the backups folder, try again, or exit safely.',
        });
        if (action === 'retry') continue;
        return { outcome: 'exit' };
      }
      const selectedAppMeta = selectedBackup.appVersion
        ? `Flo Cafe v${selectedBackup.appVersion}`
        : 'not recorded';
      const confirmDetail = [
        `Selected backup: ${selectedBackup.fileName}`,
        `Backup schema: v${selectedBackup.schemaVersion} (app version: ${selectedAppMeta})`,
        `Backup timestamp: ${formatBackupTimestamp(selectedBackup)}`,
        '',
        'Important: Any orders, payments, inventory changes, or settings recorded since this backup was created will NOT be present in the restored database.',
        '',
        `Your newer database (schema v${mismatch.dbVersion}) and any -wal/-shm sidecar files will NOT be deleted. They will be preserved at:`,
        plannedArchivePath,
      ].join('\n');

      const confirmation = await deps.dialog.showMessageBox({
        type: 'warning',
        title: 'Confirm Backup Restore',
        message: 'Restore this compatible backup and preserve the newer database aside?',
        detail: confirmDetail,
        buttons: ['Restore Compatible Backup', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });

      if (deps.isShutdownRequested()) return { outcome: 'exit' };
      if (confirmation.response !== 0) {
        deps.log.info('[Recovery] User cancelled compatible backup restore confirmation');
        continue;
      }

      try {
        const result = await deps.restoreBackup(selectedBackup.path, {
          newerDbVersion: mismatch.dbVersion,
          archivePath: plannedArchivePath,
        });
        deps.log.info(
          `[Recovery] Restored compatible backup ${result.restoredBackupPath} (v${result.backupSchemaVersion} -> v${result.restoredSchemaVersion}); preserved newer database at ${result.preservedDbPath}`,
        );
        return { outcome: 'restored', result };
      } catch (restoreError: unknown) {
        if (deps.isShutdownRequested() || isShutdownAbortError(restoreError)) {
          return { outcome: 'exit' };
        }
        deps.log.error('[Recovery] Compatible backup restore failed:', restoreError);
        const action = await presentRestoreStepErrorDialog(deps, {
          title: 'Backup Restore Failed',
          message: 'Flo Cafe could not restore the selected backup.',
          error: restoreError,
          fallbackErrorText: 'An unexpected error occurred while restoring the backup.',
          recoveryGuidance:
            'Your newer database remains recoverable. You can update Flo Cafe to the latest version, inspect the backups folder, try another compatible backup, or exit safely.',
        });
        if (action === 'retry') continue;
        return { outcome: 'exit' };
      }
    }

    return { outcome: 'exit' };
  }

  return { outcome: 'exit' };
}

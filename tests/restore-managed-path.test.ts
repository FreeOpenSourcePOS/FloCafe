import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-restore-managed-'));

const ipcHandlers = new Map<string, Function>();

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      ipcMain: {
        on: () => {},
        handle: (channel: string, handler: Function) => {
          ipcHandlers.set(channel, handler);
        },
        removeHandler: (channel: string) => {
          ipcHandlers.delete(channel);
        },
      },
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: true, filePath: '' }),
        showMessageBox: async () => ({ response: 0 }),
      },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
      shell: { openExternal: () => Promise.resolve() },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

import { isManagedBackupFile } from '../main/db';
import { registerIpcHandlers } from '../main/ipc';
import { setMasterPin } from '../main/services/master-pin';

async function run(): Promise<void> {
  setMasterPin('1234');
  const backupDir = path.join(testDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const managed = path.join(backupDir, 'flo-backup-2026-08-15T00-00-00-000Z-abc123.db');
  fs.writeFileSync(managed, 'sqlite-bytes');
  assert.equal(isManagedBackupFile(managed), true, 'managed backup file is accepted');

  const outside = path.join(testDir, 'outside.db');
  fs.writeFileSync(outside, 'sqlite-bytes');
  assert.equal(isManagedBackupFile(outside), false, 'file outside backups/ is rejected');

  const wrongName = path.join(backupDir, 'evil.db');
  fs.writeFileSync(wrongName, 'sqlite-bytes');
  assert.equal(isManagedBackupFile(wrongName), false, 'non-backup-named file inside backups/ is rejected');

  if (process.platform !== 'win32') {
    const link = path.join(backupDir, 'flo-backup-link.db');
    fs.symlinkSync(outside, link);
    assert.equal(isManagedBackupFile(link), false, 'symlink escaping backups/ is rejected');
  }

  assert.equal(isManagedBackupFile(path.join(backupDir, 'flo-backup-missing.db')), false, 'missing file is rejected');
  assert.equal(isManagedBackupFile(''), false, 'empty path is rejected');
  assert.equal(isManagedBackupFile(123 as unknown as string), false, 'non-string path is rejected');

  // Verify IPC 'restore-backup' handler enforces the boundary on renderer-preset paths
  registerIpcHandlers();
  const restoreHandler = ipcHandlers.get('restore-backup');
  assert.ok(restoreHandler, 'restore-backup IPC handler registered');

  // Attempt to restore unmanaged external database path
  const unmanagedResult = await restoreHandler({} as any, '1234', outside);
  assert.deepEqual(unmanagedResult, {
    success: false,
    error: 'Restore source must be a Flo-managed backup file',
  }, 'IPC rejects unmanaged external database path');

  // Attempt to restore file with invalid name inside backup dir
  const invalidNameResult = await restoreHandler({} as any, '1234', wrongName);
  assert.deepEqual(invalidNameResult, {
    success: false,
    error: 'Restore source must be a Flo-managed backup file',
  }, 'IPC rejects unmanaged filename inside backups directory');

  // Attempt to restore symlink escaping backup dir
  if (process.platform !== 'win32') {
    const symlinkResult = await restoreHandler({} as any, '1234', path.join(backupDir, 'flo-backup-link.db'));
    assert.deepEqual(symlinkResult, {
      success: false,
      error: 'Restore source must be a Flo-managed backup file',
    }, 'IPC rejects symlink escaping backups directory');
  }

  // Attempt to restore missing file
  const missingResult = await restoreHandler({} as any, '1234', path.join(backupDir, 'flo-backup-missing.db'));
  assert.deepEqual(missingResult, {
    success: false,
    error: 'Backup file no longer exists',
  }, 'IPC rejects missing preset file');

  // Attempt to restore managed file (passes boundary check and reaches schema validation)
  const managedResult = await restoreHandler({} as any, '1234', managed);
  assert.deepEqual(managedResult, {
    success: false,
    error: 'Invalid backup file: missing schema version metadata. This backup may have been created with an older version of FloDesktop.',
  }, 'IPC allows managed backup path past the boundary to schema inspection');

  console.log('✅ Restore managed-path boundary and IPC tests passed');
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

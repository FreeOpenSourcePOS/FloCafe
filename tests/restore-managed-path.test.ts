import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-restore-managed-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
      shell: { openExternal: () => Promise.resolve() },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

import { isManagedBackupFile } from '../main/db';

function run(): void {
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

  console.log('✅ Restore managed-path boundary tests passed');
}

try {
  run();
} finally {
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
}

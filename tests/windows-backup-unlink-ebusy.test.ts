import * as assert from 'node:assert/strict';
const fs = require('node:fs');
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-win-unlink-ebusy-'));

const mockApp = {
  isPackaged: true,
  getPath: () => testDir,
  getVersion: () => '3.0.5',
};

const mockSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp, safeStorage: mockSafeStorage };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-win-unlink-ebusy';

const Database = require('better-sqlite3');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const {
  initDatabase,
  getDatabase,
  closeDatabase,
  createBackup,
  getCurrentSchemaVersion,
} = require('../main/db');
const { authRoutes, getJWTSecret } = require('../main/routes/auth');
const { databaseRoutes } = require('../main/routes/database');
const { setMasterPin } = require('../main/services/master-pin');

let passed = 0;
let failed = 0;
let total = 0;

function check(condition: boolean, message: string) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

async function runTests() {
  console.log('Testing Windows backup temp-file unlink EBUSY/EPERM tolerance...');
  console.log('='.repeat(60));

  initDatabase();
  const db = getDatabase();
  setMasterPin('1234');

  const originalPlatform = process.platform;
  const originalUnlinkSync = fs.unlinkSync;
  const originalWarn = console.warn;

  const setPlatform = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
      writable: true,
    });
  };

  try {
    // ── Test 1: Win32 with EBUSY error on tempPath unlink ──────────────────
    console.log('\nTest 1: Windows EBUSY on tempPath unlink is tolerated');
    {
      setPlatform('win32');
      let unlinkAttempted = false;
      let warnLogged = false;

      console.warn = (...args: any[]) => {
        if (args.some((a) => typeof a === 'string' && a.includes('Windows file lock'))) {
          warnLogged = true;
        }
        originalWarn.apply(console, args);
      };

      const customTarget = path.join(testDir, 'custom-backup-ebusy.db');

      fs.unlinkSync = function (targetFile: fs.PathLike) {
        const filePath = String(targetFile);
        if (filePath.includes('flo-backup-') && !filePath.includes('custom-backup-ebusy.db') && !filePath.endsWith('.tmp')) {
          unlinkAttempted = true;
          const err: any = new Error('resource busy or locked');
          err.code = 'EBUSY';
          throw err;
        }
        return originalUnlinkSync.call(fs, targetFile);
      };

      const result = await createBackup(customTarget);
      check(unlinkAttempted, 'fs.unlinkSync was called for the temp backup file');
      check(result.path === customTarget, `createBackup returned the custom target path (got ${result.path})`);
      check(fs.existsSync(customTarget), 'final backup file exists on disk');
      check(warnLogged, 'warning log was emitted explaining the Windows file lock');

      // Verify the backup is a valid SQLite DB with the schema version intact
      const backupDb = new Database(customTarget);
      const metaVersion = backupDb.prepare("SELECT value FROM _flo_meta WHERE key = 'schema_version'").get() as { value: string };
      check(Number(metaVersion.value) === getCurrentSchemaVersion(), `backup DB contains correct schema_version (got ${metaVersion.value})`);
      backupDb.close();
    }

    // ── Test 2: Win32 with EPERM error on tempPath unlink ──────────────────
    console.log('\nTest 2: Windows EPERM on tempPath unlink is tolerated');
    {
      setPlatform('win32');
      let unlinkAttempted = false;
      let warnLogged = false;

      console.warn = (...args: any[]) => {
        if (args.some((a) => typeof a === 'string' && a.includes('Windows file lock'))) {
          warnLogged = true;
        }
        originalWarn.apply(console, args);
      };

      const customTarget = path.join(testDir, 'custom-backup-eperm.db');

      fs.unlinkSync = function (targetFile: fs.PathLike) {
        const filePath = String(targetFile);
        if (filePath.includes('flo-backup-') && !filePath.includes('custom-backup-eperm.db') && !filePath.endsWith('.tmp')) {
          unlinkAttempted = true;
          const err: any = new Error('operation not permitted');
          err.code = 'EPERM';
          throw err;
        }
        return originalUnlinkSync.call(fs, targetFile);
      };

      const result = await createBackup(customTarget);
      check(unlinkAttempted, 'fs.unlinkSync was called for the temp backup file');
      check(result.path === customTarget, `createBackup returned the custom target path (got ${result.path})`);
      check(fs.existsSync(customTarget), 'final backup file exists on disk');
      check(warnLogged, 'warning log was emitted for EPERM');

      const backupDb = new Database(customTarget);
      const metaVersion = backupDb.prepare("SELECT value FROM _flo_meta WHERE key = 'schema_version'").get() as { value: string };
      check(Number(metaVersion.value) === getCurrentSchemaVersion(), `backup DB contains correct schema_version (got ${metaVersion.value})`);
      backupDb.close();
    }

    // ── Test 3: Non-Windows platform re-throws EBUSY ───────────────────────
    console.log('\nTest 3: Non-Windows platform re-throws EBUSY');
    {
      setPlatform('darwin');
      const customTarget = path.join(testDir, 'custom-backup-darwin-ebusy.db');

      fs.unlinkSync = function (targetFile: fs.PathLike) {
        const filePath = String(targetFile);
        if (filePath.includes('flo-backup-') && !filePath.includes('custom-backup-darwin-ebusy.db') && !filePath.endsWith('.tmp')) {
          const err: any = new Error('resource busy or locked');
          err.code = 'EBUSY';
          throw err;
        }
        return originalUnlinkSync.call(fs, targetFile);
      };

      let threw = false;
      try {
        await createBackup(customTarget);
      } catch (err: any) {
        threw = true;
        check(err?.code === 'EBUSY', `re-threw EBUSY on non-Windows platform (got code: ${err?.code})`);
      }
      check(threw, 'createBackup threw on non-Windows platform when tempPath unlink failed');
    }

    // ── Test 4: Windows platform re-throws other unexpected errors (e.g. EIO) ───
    console.log('\nTest 4: Windows platform re-throws unexpected error codes');
    {
      setPlatform('win32');
      const customTarget = path.join(testDir, 'custom-backup-win-eio.db');

      fs.unlinkSync = function (targetFile: fs.PathLike) {
        const filePath = String(targetFile);
        if (filePath.includes('flo-backup-') && !filePath.includes('custom-backup-win-eio.db') && !filePath.endsWith('.tmp')) {
          const err: any = new Error('I/O error');
          err.code = 'EIO';
          throw err;
        }
        return originalUnlinkSync.call(fs, targetFile);
      };

      let threw = false;
      try {
        await createBackup(customTarget);
      } catch (err: any) {
        threw = true;
        check(err?.code === 'EIO', `re-threw EIO on Windows (got code: ${err?.code})`);
      }
      check(threw, 'createBackup threw on Windows when tempPath unlink threw non-EBUSY/EPERM error');
    }

    // ── Test 5: End-to-end HTTP API with simulated Windows EBUSY ─────────
    console.log('\nTest 5: POST /api/db/backup and POST /api/db/import succeed on Windows under EBUSY');
    {
      setPlatform('win32');
      fs.unlinkSync = function (targetFile: fs.PathLike) {
        const filePath = String(targetFile);
        if (filePath.includes('flo-backup-') && !filePath.endsWith('.tmp')) {
          const err: any = new Error('resource busy or locked');
          err.code = 'EBUSY';
          throw err;
        }
        return originalUnlinkSync.call(fs, targetFile);
      };

      const app = express();
      app.use(express.json());
      const ownerToken = jwt.sign({ userId: 'owner-1', email: 'owner@flo.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });
      app.use((req: any, res: any, next: any) => {
        const auth = req.headers.authorization;
        if (auth?.startsWith('Bearer ')) {
          req.user = jwt.verify(auth.split(' ')[1], getJWTSecret());
        }
        next();
      });
      app.use('/api/auth', authRoutes);
      app.use('/api/db', databaseRoutes);

      const backupRes = await request(app)
        .post('/api/db/backup')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ master_pin: '1234' });

      check(backupRes.status === 200, `POST /api/db/backup succeeded (got ${backupRes.status})`);
      check(Boolean(backupRes.body.path), `response contains path (got ${backupRes.body.path})`);
      check(fs.existsSync(backupRes.body.path), 'backup file created by API exists');

      // Now test POST /api/db/import which triggers auto-backup before import
      const importRes = await request(app)
        .post('/api/db/import')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          master_pin: '1234',
          overwrite: false,
          data: {
            schema_version: String(getCurrentSchemaVersion() + 1), // mismatch triggers safety backup
            data: { settings: [], categories: [{ id: 'win-import-cat', name: 'Win Category' }], products: [], users: [] },
          },
        });

      check(importRes.status === 200, `POST /api/db/import with schema mismatch succeeded under EBUSY (got ${importRes.status})`);
      const imported = db.prepare("SELECT COUNT(*) AS count FROM categories WHERE id = 'win-import-cat'").get() as { count: number };
      check(imported.count === 1, 'imported data was committed to database');
    }
  } finally {
    setPlatform(originalPlatform);
    fs.unlinkSync = originalUnlinkSync;
    console.warn = originalWarn;
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

runTests();

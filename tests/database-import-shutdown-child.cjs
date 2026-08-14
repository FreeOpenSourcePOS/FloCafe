const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-db-import-shutdown-'));
const originalLoad = Module._load;
const mockApp = {
  isPackaged: true,
  getPath: () => testDir,
  getVersion: () => 'test',
};

Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: mockApp,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString(),
      },
      shell: { openExternal: () => Promise.resolve() },
    };
  }
  return originalLoad.apply(this, arguments);
};

require('ts-node').register({
  transpileOnly: true,
  project: path.join(__dirname, 'tsconfig.json'),
});

const express = require('express');
const request = require('supertest');
const Database = require('better-sqlite3');
const dbModule = require('../main/db');
const {
  createShutdownCoordinator,
  createShutdownEntrypoints,
  installHttpShutdownTracking,
} = require('../main/shutdown');
const { setMasterPin } = require('../main/services/master-pin');

const mode = process.argv[2] || 'import';

async function run() {
  dbModule.initDatabase();
  const db = dbModule.getDatabase();
  const { databaseRoutes } = require('../main/routes/database');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 'owner', role: 'owner' };
    next();
  });
  app.use('/api/db', databaseRoutes);
  app.use('/api/db-tools', require('../main/routes/database-tools').databaseToolsRoutes);

  const server = http.createServer(app);
  installHttpShutdownTracking(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const shutdownCoordinator = createShutdownCoordinator(() => [
    { name: 'database admission', run: () => dbModule.beginDatabaseShutdown() },
  ]);
  const shutdownEntrypoints = createShutdownEntrypoints({
    app: { on() {}, quit() {}, exit() {} },
    process: { on() {}, exit() {} },
    cleanup: shutdownCoordinator,
    setQuitting() {},
    destroyWindow() {},
  });

  const originalPrepare = Database.prototype.prepare;
  const originalExec = Database.prototype.exec;
  let foreignKeyChecks = 0;
  let commitSeen = false;
  Database.prototype.prepare = function (sql, ...params) {
    const statement = originalPrepare.call(this, sql, ...params);
    if (mode === 'import' && sql === 'PRAGMA foreign_key_check' && ++foreignKeyChecks === 2) {
      void shutdownEntrypoints.runCleanup();
    }
    return statement;
  };
  Database.prototype.exec = function (sql, ...params) {
    if (String(sql).trim() === 'COMMIT') commitSeen = true;
    return originalExec.call(this, sql, ...params);
  };

  const originalUnlinkSync = fs.unlinkSync;
  const resetDatabasePath = dbModule.getDbPath();
  let resetShutdownTriggered = false;
  fs.unlinkSync = function (filePath, ...args) {
    const result = originalUnlinkSync.call(this, filePath, ...args);
    if (mode === 'reset' && !resetShutdownTriggered && String(filePath) === resetDatabasePath) {
      resetShutdownTriggered = true;
      void shutdownEntrypoints.runCleanup();
    }
    return result;
  };

  try {
    let response;
    if (mode === 'import') {
      response = await request(server).post('/api/db/import').send({
        overwrite: false,
        data: {
          schema_version: String(dbModule.getCurrentSchemaVersion()),
          data: {
            settings: [],
            categories: [{ id: 'shutdown-import-category', name: 'Shutdown import' }],
            products: [],
            users: [],
          },
        },
      });
    } else {
      setMasterPin('1234');
      db.prepare("INSERT INTO categories (id, name) VALUES ('reset-survivor', 'Reset survivor')").run();
      response = await request(server).post('/api/db-tools/initialize').send({
        master_pin: '1234',
        confirmation_phrase: 'INITIALIZE',
      });
    }
    if (response.status !== 500) throw new Error(`expected ${mode} cancellation response, got ${response.status}`);
    if (mode === 'import' && commitSeen) throw new Error('database import committed after shutdown cancellation');
    if (mode === 'reset' && !resetShutdownTriggered) throw new Error('reset cancellation did not reach the database replacement boundary');
    const survivorId = mode === 'import' ? 'shutdown-import-category' : 'reset-survivor';
    const recoveredDatabase = new Database(dbModule.getDbPath(), { readonly: true, fileMustExist: true });
    const count = recoveredDatabase.prepare('SELECT COUNT(*) AS count FROM categories WHERE id = ?').get(survivorId).count;
    recoveredDatabase.close();
    if (mode === 'import' && count !== 0) throw new Error('cancelled database import left committed rows');
    if (mode === 'reset' && count !== 1) throw new Error('cancelled reset removed live database data');
    await shutdownEntrypoints.runCleanup();
    const backupFiles = fs.readdirSync(path.join(testDir, 'backups')).filter((file) => file.endsWith('.db'));
    if (backupFiles.length === 0) throw new Error('database import did not execute its safety backup');
    if (mode === 'reset' && backupFiles.some((file) => file.includes('flo-reset-recovery-'))) {
      throw new Error('cancelled reset left replacement artifacts');
    }
  } finally {
    fs.unlinkSync = originalUnlinkSync;
    Database.prototype.prepare = originalPrepare;
    Database.prototype.exec = originalExec;
    dbModule.closeDatabase();
    await new Promise((resolve) => server.close(() => resolve()));
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const fs = require('node:fs');
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
        isEncryptionAvailable: () => false,
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

  const originalPrepare = Database.prototype.prepare;
  const originalExec = Database.prototype.exec;
  let foreignKeyChecks = 0;
  let commitSeen = false;
  Database.prototype.prepare = function (sql, ...params) {
    const statement = originalPrepare.call(this, sql, ...params);
    if (sql === 'PRAGMA foreign_key_check' && ++foreignKeyChecks === 2) {
      dbModule.beginDatabaseShutdown();
    }
    return statement;
  };
  Database.prototype.exec = function (sql, ...params) {
    if (String(sql).trim() === 'COMMIT') commitSeen = true;
    return originalExec.call(this, sql, ...params);
  };

  try {
    const response = await request(app).post('/api/db/import').send({
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
    if (response.status !== 500) throw new Error(`expected import cancellation response, got ${response.status}`);
    if (commitSeen) throw new Error('database import committed after shutdown cancellation');
    const count = db.prepare("SELECT COUNT(*) AS count FROM categories WHERE id = 'shutdown-import-category'").get().count;
    if (count !== 0) throw new Error('cancelled database import left committed rows');
    const backupFiles = fs.readdirSync(path.join(testDir, 'backups')).filter((file) => file.endsWith('.db'));
    if (backupFiles.length === 0) throw new Error('database import did not execute its safety backup');
  } finally {
    Database.prototype.prepare = originalPrepare;
    Database.prototype.exec = originalExec;
    dbModule.closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

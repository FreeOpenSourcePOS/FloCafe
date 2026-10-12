#!/usr/bin/env node
/**
 * Standalone Isolated Demo Server for FloCafe End-User Documentation & Screenshot Capture.
 *
 * Runs Express API + Static Frontend on PORT (default: 3101),
 * Standalone KDS on KDS_PORT (default: 3102),
 * and Server App on SERVER_APP_PORT (default: 3103)
 * with a fully isolated SQLite database seeded with "Blue Harbor Café".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const demoDir = path.join(os.tmpdir(), 'flocafe-demo-docs-' + Date.now());
fs.mkdirSync(demoDir, { recursive: true });

process.env.PORT = process.env.PORT || '3101';
process.env.KDS_PORT = process.env.KDS_PORT || '3102';
process.env.SERVER_APP_PORT = process.env.SERVER_APP_PORT || '3103';

process.env.JWT_SECRET = 'flocafe-docs-demo-secret-key-2026';
process.env.FLO_AUTH_RATE_LIMIT_MAX = '10000';
process.env.FLO_SETTINGS_READ_RATE_LIMIT_MAX = '100000';
process.env.FLO_SETTINGS_WRITE_RATE_LIMIT_MAX = '10000';
process.env.FLO_WHATSAPP_SOCKET_DISABLED = '1';
process.env.NODE_ENV = 'test';

// Mock electron app paths to point to isolated demo directory
const originalLoad = Module._load;
Module._load = function (request, _parent, _isMain) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => demoDir,
        getVersion: () => '3.12.88',
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const { initDatabase, closeDatabase } = require('../../dist/main/db');
const { startServer, stopServer, getServerPort } = require('../../dist/main/server');
const { startKdsServer, stopKdsServer, getKdsPort } = require('../../dist/main/kds-server');
const { startServerApp, stopServerApp, getServerAppPort } = require('../../dist/main/server-app');
const { seedBlueHarborCafe } = require('./seed-blue-harbor.cjs');

async function run() {
  console.log('='.repeat(60));
  console.log('Starting FloCafe Documentation Demo Server');
  console.log(`Isolated Data Directory: ${demoDir}`);
  console.log('='.repeat(60));

  initDatabase();
  seedBlueHarborCafe();

  await startServer();
  await startKdsServer();
  await startServerApp();

  const apiPort = getServerPort();
  const kdsPort = getKdsPort();
  const serverPort = getServerAppPort();

  console.log('------------------------------------------------------------');
  console.log(`FloCafe POS & Back Office: http://localhost:${apiPort}`);
  console.log(`Kitchen Display System:    http://localhost:${kdsPort}`);
  console.log(`Server Companion App:      http://localhost:${serverPort}`);
  console.log('------------------------------------------------------------');
  console.log('Owner Login:   owner@blueharbor.local   / DemoPassword123! (PIN: 1234)');
  console.log('Manager Login: manager@blueharbor.local / DemoPassword123! (PIN: 2345)');
  console.log('Cashier Login: cashier@blueharbor.local / DemoPassword123! (PIN: 3456)');
  console.log('Server Login:  server@blueharbor.local  / DemoPassword123! (PIN: 4567)');
  console.log('Chef Login:    chef@blueharbor.local    / DemoPassword123! (PIN: 5678)');
  console.log('------------------------------------------------------------');

  const shutdown = async () => {
    console.log('\nShutting down demo server...');
    try {
      await stopServerApp();
    } catch {}
    try {
      await stopKdsServer();
    } catch {}
    try {
      await stopServer();
    } catch {}
    try {
      closeDatabase();
    } catch {}
    try {
      fs.rmSync(demoDir, { recursive: true, force: true });
    } catch {}
    console.log('Demo server stopped cleanly.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (process.send) {
    process.send({ status: 'ready', apiPort, kdsPort, serverPort });
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Failed to start demo server:', err);
    process.exit(1);
  });
}

module.exports = { run };

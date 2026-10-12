'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { createServer } = require('node:net');

const testDir = path.join(os.tmpdir(), 'flo-showcase-env');
if (fs.existsSync(testDir)) {
  fs.rmSync(testDir, { recursive: true, force: true });
}
fs.mkdirSync(testDir, { recursive: true });

process.env.PORT = process.env.PORT || '3001';
process.env.KDS_PORT = process.env.KDS_PORT || '3002';
process.env.SERVER_APP_PORT = process.env.SERVER_APP_PORT || '3003';
process.env.JWT_SECRET = 'showcase-secret-key-123';
process.env.FLO_AUTH_RATE_LIMIT_MAX = '10000';
process.env.FLO_SETTINGS_READ_RATE_LIMIT_MAX = '100000';
process.env.FLO_SETTINGS_WRITE_RATE_LIMIT_MAX = '10000';
process.env.FLO_WHATSAPP_SOCKET_DISABLED = '1';
process.env.NODE_ENV = 'test';

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '3.12.88' } };
  }
  return originalLoad.apply(this, arguments);
};

const {
  initDatabase,
  getDatabase,
  closeDatabase,
  beginDatabaseShutdown,
  waitForDatabaseRequests,
} = require('../../dist/main/db');
const { startServer, stopServer, getServerPort } = require('../../dist/main/server');
const { startKdsServer, stopKdsServer, getKdsPort } = require('../../dist/main/kds-server');
const { startServerApp, stopServerApp, getServerAppPort } = require('../../dist/main/server-app');
const { startStandaloneServers } = require('../../dist/main/standalone-startup');
const { seedHarborBean } = require('./seed-harbor-bean.cjs');

async function seedActiveOrders() {
  const jwt = require('jsonwebtoken');
  const token = jwt.sign(
    { userId: 'user-manager', email: 'manager@harborbean.local', role: 'manager' },
    process.env.JWT_SECRET,
    { expiresIn: '2h' },
  );

  const http = require('http');
  function postOrder(body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: Number(process.env.PORT),
          path: '/api/orders',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            Authorization: `Bearer ${token}`,
          },
        },
        (res) => {
          let resBody = '';
          res.on('data', (c) => (resBody += c));
          res.on('end', () =>
            resolve({ status: res.statusCode, data: JSON.parse(resBody || '{}') }),
          );
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  try {
    // 1. Order for Table T2 (Occupied in Main Dining, for table management & split demo)
    await postOrder({
      type: 'dine_in',
      table_id: 'tab-2',
      guest_count: 2,
      items: [
        { product_id: 'prod-cold-brew', quantity: 2 },
        { product_id: 'prod-toast', quantity: 1 },
      ],
    });

    // 2. Order for KDS display in Waiting state
    await postOrder({
      type: 'dine_in',
      table_id: 'tab-1',
      guest_count: 2,
      special_instructions: 'No ice in Cold Brew',
      items: [
        { product_id: 'prod-cold-brew', quantity: 1 },
        { product_id: 'prod-croissant', quantity: 2 },
      ],
    });

    console.log('[Showcase Server] Seeded active dining & KDS orders.');
  } catch (err) {
    console.warn('[Showcase Server] Notice: Could not pre-seed orders via API:', err.message);
  }
}

let shutdownRequested = false;

async function start() {
  await startStandaloneServers({
    initializeDatabase: () => {
      initDatabase();
      seedHarborBean(getDatabase());
    },
    prepare: () => {},
    startServer,
    startKdsServer,
    startServerApp,
    isShutdownRequested: () => shutdownRequested,
  });

  console.log(`[Showcase Server] Main API listening at http://127.0.0.1:${getServerPort()}`);
  console.log(`[Showcase Server] KDS listening at http://127.0.0.1:${getKdsPort()}`);
  console.log(`[Showcase Server] Server App listening at http://127.0.0.1:${getServerAppPort()}`);

  await seedActiveOrders();
  console.log('[Showcase Server] All services ready for capture.');
}

async function stop() {
  if (shutdownRequested) return;
  shutdownRequested = true;
  console.log('[Showcase Server] Shutting down...');
  try {
    await stopServerApp();
  } catch (e) {}
  try {
    await stopServer();
  } catch (e) {}
  try {
    await stopKdsServer();
  } catch (e) {}
  try {
    beginDatabaseShutdown();
    await waitForDatabaseRequests();
  } catch (e) {}
  try {
    closeDatabase();
  } catch (e) {}
  process.exit(0);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

if (require.main === module) {
  start().catch((err) => {
    console.error('[Showcase Server] Failed to start:', err);
    process.exit(1);
  });
}

module.exports = { start, stop };

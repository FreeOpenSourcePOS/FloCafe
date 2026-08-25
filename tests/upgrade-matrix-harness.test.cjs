'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');
const { WebSocketServer } = require('ws');

const state = {
  setupBody: null,
  requests: [],
  updatePolls: 0,
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

let apiServer;
let cdpServer;
let cdpPort;
let harness;

test.before(async () => {
  apiServer = http.createServer(async (request, response) => {
    const bodyText = await readBody(request);
    const body = bodyText ? JSON.parse(bodyText) : null;
    state.requests.push({ method: request.method, path: request.url, body });

    if (request.method === 'GET' && request.url === '/api/auth/setup/status') {
      return sendJson(response, 200, { needsSetup: true });
    }
    if (request.method === 'POST' && request.url === '/api/auth/setup/initialize') {
      state.setupBody = body;
      return sendJson(response, 200, { success: true });
    }
    if (request.method === 'POST' && request.url === '/api/auth/login') {
      return sendJson(response, 200, { access_token: 'matrix-test-token' });
    }
    if (request.method === 'POST' && request.url === '/api/products') {
      return sendJson(response, 200, { product: { id: 'product-1' } });
    }
    if (request.method === 'POST' && request.url === '/api/orders') {
      return sendJson(response, 200, { order: { id: 'order-1' } });
    }
    if (request.method === 'POST' && request.url === '/api/printers') {
      return sendJson(response, 200, { printer: { id: 'printer-1' } });
    }
    if (request.method === 'GET' && request.url === '/api/orders/order-1') {
      return sendJson(response, 200, {
        order: { id: 'order-1', special_instructions: 'survives the 468 upgrade' },
      });
    }
    if (request.method === 'GET' && request.url === '/api/printers') {
      return sendJson(response, 200, { printers: [{ id: 'printer-1' }] });
    }
    return sendJson(response, 404, { error: 'not found' });
  });

  cdpServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  cdpServer.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method !== 'Runtime.evaluate') return;

      let value;
      if (message.params.expression.includes('getAppInfo')) {
        value = { version: '3.3.1-beta.1' };
      } else if (message.params.expression.includes('getBetaChannel')) {
        value = true;
      } else if (message.params.expression.includes('getUpdateStatus')) {
        state.updatePolls += 1;
        value = state.updatePolls === 1
          ? { status: 'checking' }
          : { status: 'ready-to-install', version: '3.3.1-beta.1' };
      } else {
        value = null;
      }
      socket.send(JSON.stringify({
        id: message.id,
        result: { result: { value } },
      }));
    });
  });

  const apiPort = await listen(apiServer);
  await new Promise((resolve) => {
    if (cdpServer.address()) resolve();
    else cdpServer.once('listening', resolve);
  });
  cdpPort = cdpServer.address().port;
  process.env.FLO_API_PORT = String(apiPort);

  cdpServer.httpServer = http.createServer((request, response) => {
    if (request.url !== '/json') return response.writeHead(404).end();
    sendJson(response, 200, [{
      type: 'page',
      title: 'Flo Cafe',
      webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}`,
    }]);
  });
  await listen(cdpServer.httpServer);
  process.env.FLO_DEBUG_PORT = String(cdpServer.httpServer.address().port);
  harness = require('../scripts/upgrade-matrix/harness.cjs');
});

test.after(async () => {
  await new Promise((resolve) => apiServer.close(resolve));
  await new Promise((resolve) => cdpServer.httpServer.close(resolve));
  await new Promise((resolve) => cdpServer.close(resolve));
});

test('setupAndSeed sends the required first-run data through the public API', async () => {
  const seeds = await harness.setupAndSeed({
    email: 'matrix@example.invalid',
    password: 'matrix-password',
    masterPin: '4681',
  });

  assert.deepEqual(seeds, {
    token: 'matrix-test-token',
    productId: 'product-1',
    orderId: 'order-1',
    printerId: 'printer-1',
  });
  assert.deepEqual(state.setupBody, {
    name: 'Upgrade Matrix Bot',
    email: 'matrix@example.invalid',
    password: 'matrix-password',
    business_name: 'Matrix Test Store',
    store_name: 'Matrix Test Store',
    terms_accepted: true,
    master_pin: '4681',
    country: 'IN',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    cloud_server_url: 'http://127.0.0.1:9',
  });
  assert.ok(state.requests.some(({ method, path }) => method === 'POST' && path === '/api/orders'));
  assert.ok(state.requests.some(({ method, path }) => method === 'POST' && path === '/api/printers'));
});

test('waitReadyToInstall and verifySeeds observe staged version and persistence', async () => {
  const staged = await harness.waitReadyToInstall({
    expectedVersion: '3.3.1-beta.1',
    timeoutMs: 3000,
  });
  assert.deepEqual(staged, { status: 'ready-to-install', version: '3.3.1-beta.1' });

  const evidence = await harness.verifySeeds({
    token: 'matrix-test-token',
    orderId: 'order-1',
    printerId: 'printer-1',
  }, '3.3.1-beta.1');
  assert.deepEqual(evidence, { version: '3.3.1-beta.1', betaCheck: 'PASS' });
});

test('cdpEval bounds target discovery and websocket handshakes', async () => {
  const stalledSockets = new Set();
  const stalledTarget = net.createServer((socket) => {
    stalledSockets.add(socket);
    socket.once('close', () => stalledSockets.delete(socket));
  });
  const targetPort = await listen(stalledTarget);
  const targetServer = http.createServer((request, response) => {
    if (request.url !== '/json') return response.writeHead(404).end();
    sendJson(response, 200, [{
      type: 'page',
      title: 'Flo Cafe',
      webSocketDebuggerUrl: `ws://127.0.0.1:${targetPort}`,
    }]);
  });
  const targetServerPort = await listen(targetServer);
  const stalledDiscoveryServer = http.createServer(() => {});
  const stalledDiscoveryPort = await listen(stalledDiscoveryServer);

  try {
    await assert.rejects(
      harness.cdpEval(targetServerPort, 'true', 50),
      /CDP websocket handshake timed out after 50ms/
    );
    await assert.rejects(
      harness.cdpEval(stalledDiscoveryPort, 'true', 50),
      /CDP target discovery timed out after 50ms/
    );
  } finally {
    for (const socket of stalledSockets) socket.destroy();
    await new Promise((resolve) => targetServer.close(resolve));
    await new Promise((resolve) => stalledDiscoveryServer.close(resolve));
    await new Promise((resolve) => stalledTarget.close(resolve));
  }
});

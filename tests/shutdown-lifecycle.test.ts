import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import {
  closeServerResources,
  createShutdownCoordinator,
} from '../main/shutdown';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-shutdown-lifecycle-'));

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function testCoordinatorOrderingAndIdempotency(): Promise<void> {
  const events: string[] = [];
  const shutdown = createShutdownCoordinator(() => [
    {
      name: 'http',
      run: async () => {
        events.push('http:start');
        await delay(10);
        events.push('http:end');
      },
    },
    { name: 'websocket', run: () => { events.push('websocket'); } },
    { name: 'database', run: () => { events.push('database'); } },
  ]);

  const first = shutdown();
  const second = shutdown();
  assert.strictEqual(first, second, 'concurrent shutdown callers share one promise');
  await Promise.all([first, second]);
  assert.deepEqual(events, ['http:start', 'http:end', 'websocket', 'database']);
  assert.strictEqual(shutdown(), first, 'repeated shutdown returns the settled promise');

  const startupFailure = new Error('startup failed');
  const failureEvents: string[] = [];
  const failingShutdown = createShutdownCoordinator(() => [
    { name: 'failed listener', run: () => { failureEvents.push('listener'); throw startupFailure; } },
    { name: 'database', run: () => { failureEvents.push('database'); } },
  ]);
  await assert.rejects(failingShutdown(), (error: unknown) => {
    return error instanceof AggregateError && error.errors.includes(startupFailure);
  });
  assert.deepEqual(failureEvents, ['listener', 'database'], 'later cleanup still runs after startup failure');
}

async function testActiveHttpAndWebSocketDrain(): Promise<void> {
  let releaseHeldResponse: (() => void) | null = null;
  const requestStarted = new Promise<void>((resolve) => {
    releaseHeldResponse = resolve;
  });
  let heldResponse: http.ServerResponse | null = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/hold') {
      heldResponse = res;
      releaseHeldResponse?.();
      return;
    }
    res.end('ok');
  });
  const wss = new (await import('ws')).WebSocketServer({ server });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const port = address.port;

  const wsClient = new WebSocket(`ws://127.0.0.1:${port}`);
  wsClient.on('error', () => {});
  await once(wsClient, 'open');

  const heldRequest = http.get({ host: '127.0.0.1', port, path: '/hold' }, (response) => {
    response.resume();
  });
  heldRequest.on('error', () => {});
  await requestStarted;

  let shutdownSettled = false;
  const shutdown = closeServerResources(server, wss, 'lifecycle test').then(() => {
    shutdownSettled = true;
  });
  await delay(50);
  assert.equal(shutdownSettled, false, 'shutdown waits for the active HTTP request');
  if (wsClient.readyState !== WebSocket.CLOSED) await once(wsClient, 'close');
  assert.equal(wsClient.readyState, WebSocket.CLOSED, 'shutdown closes WebSocket clients before the HTTP listener');

  heldResponse?.end('drained');
  await shutdown;
  heldRequest.destroy();
}

async function testOwnedServerStopEntrypoints(): Promise<void> {
  process.env.PORT = '0';
  process.env.KDS_PORT = '0';

  // Keep this test independent of a real Electron app while still exercising
  // the owned server entrypoints and their better-sqlite3-backed lifecycle.
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: true,
          getPath: () => testDir,
          getVersion: () => 'test',
        },
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

  try {
    const { initDatabase, closeDatabase } = await import('../main/db');
    const mainServer = await import('../main/server');
    const kdsServer = await import('../main/kds-server');

    await mainServer.stopServer();
    await kdsServer.stopKdsServer();
    initDatabase();
    await mainServer.startServer();
    await kdsServer.startKdsServer();

    // Verify the listeners through their kernel-assigned ephemeral ports and
    // keep resource-level WebSocket coverage in the previous phase.
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        const request = http.get({ host: '127.0.0.1', port: mainServer.getServerPort(), path: '/api/health' }, (response) => {
          response.resume();
          response.once('end', resolve);
        });
        request.once('error', reject);
      }),
      new Promise<void>((resolve, reject) => {
        const request = http.get({ host: '127.0.0.1', port: kdsServer.getKdsPort(), path: '/api/health' }, (response) => {
          response.resume();
          response.once('end', resolve);
        });
        request.once('error', reject);
      }),
    ]);

    const firstMainStop = mainServer.stopServer();
    assert.strictEqual(firstMainStop, mainServer.stopServer(), 'main stop is idempotent while draining');
    await firstMainStop;
    assert.equal(mainServer.isServerRunning(), false);

    const firstKdsStop = kdsServer.stopKdsServer();
    assert.strictEqual(firstKdsStop, kdsServer.stopKdsServer(), 'KDS stop is idempotent while draining');
    await firstKdsStop;
    assert.equal(kdsServer.isKdsServerRunning(), false);

    await mainServer.stopServer();
    await kdsServer.stopKdsServer();
    closeDatabase();
  } finally {
    Module._load = originalLoad;
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { }
  }
}

(async () => {
  console.log('phase coordinator');
  await testCoordinatorOrderingAndIdempotency();
  console.log('phase resources');
  await testActiveHttpAndWebSocketDrain();
  console.log('phase owned servers');
  await testOwnedServerStopEntrypoints();
  console.log('Shutdown lifecycle tests passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

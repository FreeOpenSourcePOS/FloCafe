import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import {
  closeServerResources,
  createExitCodeAwareShutdown,
  createShutdownCoordinator,
  createShutdownEntrypoints,
  installHttpShutdownTracking,
  trackHttpRequestWork,
} from '../main/shutdown';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-shutdown-lifecycle-'));

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class AppDouble {
  private listeners = new Map<string, Array<(...args: any[]) => void>>();
  quitCount = 0;
  exitCodes: number[] = [];

  on(event: string, listener: (...args: any[]) => void): void {
    const listeners = this.listeners.get(event) || [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) || []) listener(...args);
  }

  quit(): void {
    this.quitCount++;
  }

  exit(code = 0): void {
    this.exitCodes.push(code);
  }
}

class ProcessDouble {
  private listeners = new Map<string, Array<(...args: any[]) => void>>();
  exitCodes: number[] = [];

  once(event: string, listener: (...args: any[]) => void): void {
    const wrapped = (...args: any[]) => {
      const listeners = this.listeners.get(event) || [];
      this.listeners.set(event, listeners.filter((candidate) => candidate !== wrapped));
      listener(...args);
    };
    const listeners = this.listeners.get(event) || [];
    listeners.push(wrapped);
    this.listeners.set(event, listeners);
  }

  emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) || [])]) listener();
  }

  exit(code = 0): void {
    this.exitCodes.push(code);
  }
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
  assert.equal(wsClient.readyState, WebSocket.CLOSED, 'shutdown closes WebSocket clients while HTTP drains');

  heldResponse?.end('drained');
  await shutdown;
  heldRequest.destroy();
}

async function testHttpStopsAcceptingBeforeSlowWebSocketDrain(): Promise<void> {
  const server = http.createServer((_request, response) => response.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  let websocketDrainFinished = false;
  const slowWss = {
    clients: new Set([{
      readyState: WebSocket.OPEN,
      close: () => {},
      once: (event: string, listener: () => void) => { if (event === 'close') setTimeout(listener, 100); },
      off: () => {},
      terminate: () => {},
    }]),
    close: (callback: () => void) => {
      setTimeout(() => {
        websocketDrainFinished = true;
        callback();
      }, 100);
    },
  } as any;

  try {
    const shutdown = closeServerResources(server, slowWss, 'slow WebSocket test');
    await delay(20);
    assert.equal(server.listening, false, 'HTTP stops accepting before a slow WebSocket drain finishes');
    assert.equal(websocketDrainFinished, false, 'the WebSocket drain is still pending');
    await shutdown;
  } finally {
    if (server.listening) server.close();
  }
}

async function testTrackedHttpHandlerDrain(): Promise<void> {
  let releaseHandler: (() => void) | null = null;
  let requestStarted: (() => void) | null = null;
  const handlerStarted = new Promise<void>((resolve) => { requestStarted = resolve; });
  const handlerWork = new Promise<void>((resolve) => { releaseHandler = resolve; });
  const server = http.createServer((request, response) => {
    requestStarted?.();
    void trackHttpRequestWork(request, handlerWork).then(() => response.end('done'));
  });
  installHttpShutdownTracking(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const heldRequest = http.get({ host: '127.0.0.1', port: address.port, path: '/' });
  heldRequest.on('error', () => {});
  await handlerStarted;

  let settled = false;
  const shutdown = closeServerResources(server, null, 'tracked HTTP handler test').then(() => { settled = true; });
  await delay(20);
  assert.equal(settled, false, 'shutdown waits for tracked handler work after listener close');
  releaseHandler?.();
  await shutdown;
  heldRequest.destroy();
}

async function testPendingHttpListenIsCancelled(): Promise<void> {
  const server = http.createServer((_request, response) => response.end('ok'));
  server.listen(0, '127.0.0.1');
  await closeServerResources(server, null, 'pending HTTP listen test');
  await delay(20);
  assert.equal(server.listening, false, 'shutdown cancels an HTTP listener that has not finished starting');
}

async function testEntrypointCoverage(): Promise<void> {
  const runScenario = async (signal: 'SIGTERM' | 'SIGINT'): Promise<void> => {
    const app = new AppDouble();
    const process = new ProcessDouble();
    let cleanupCalls = 0;
    let windowDestroyCalls = 0;
    let quittingCalls = 0;
    const entrypoints = createShutdownEntrypoints({
      app,
      process,
      cleanup: async () => {
        cleanupCalls++;
        await delay(5);
      },
      setQuitting: () => { quittingCalls++; },
      destroyWindow: () => { windowDestroyCalls++; },
    });

    const cleanupPromise = entrypoints.runCleanup();
    assert.strictEqual(cleanupPromise, entrypoints.runCleanup(), 'repeated shutdown calls share one cleanup promise');
    process.emit(signal);
    await cleanupPromise;
    await delay(0);
    assert.equal(cleanupCalls, 1, `${signal} runs cleanup once`);
    assert.deepEqual(process.exitCodes, [0], `${signal} exits after cleanup`);
    assert.equal(quittingCalls, 1, `${signal} marks the app as quitting`);
    assert.equal(windowDestroyCalls, 0, `${signal} does not destroy the window through the quit path`);
  };

  for (const [label, trayQuit] of [['normal quit', false], ['tray quit', true]] as const) {
    const app = new AppDouble();
    const process = new ProcessDouble();
    let cleanupCalls = 0;
    let windowDestroyCalls = 0;
    let quittingCalls = 0;
    const entrypoints = createShutdownEntrypoints({
      app,
      process,
      cleanup: async () => {
        cleanupCalls++;
        await delay(5);
      },
      setQuitting: () => { quittingCalls++; },
      destroyWindow: () => { windowDestroyCalls++; },
    });
    const firstWillQuit = { prevented: false, preventDefault: () => { firstWillQuit.prevented = true; } };
    app.emit('before-quit');
    if (trayQuit) quittingCalls++;
    app.emit('will-quit', firstWillQuit);
    await entrypoints.runCleanup();
    await delay(0);
    assert.equal(firstWillQuit.prevented, true, `${label} waits for cleanup`);
    assert.equal(app.quitCount, 1, `${label} resumes Electron quit after cleanup`);
    assert.equal(cleanupCalls, 1, `${label} runs cleanup once`);
    assert.equal(quittingCalls, trayQuit ? 3 : 2, `${label} marks both quit entrypoints as quitting`);
    assert.equal(windowDestroyCalls, 1, `${label} destroys the window after cleanup`);

    const secondWillQuit = { prevented: false, preventDefault: () => { secondWillQuit.prevented = true; } };
    app.emit('will-quit', secondWillQuit);
    assert.equal(secondWillQuit.prevented, false, `${label} allows the resumed quit`);
  }

  await runScenario('SIGTERM');
  await runScenario('SIGINT');

  const startupFailure = new Error('startup failed');
  const failingEntrypoints = createShutdownEntrypoints({
    app: new AppDouble(),
    process: new ProcessDouble(),
    cleanup: async () => { throw startupFailure; },
    setQuitting: () => {},
    destroyWindow: () => {},
  });
  await assert.rejects(failingEntrypoints.runCleanup(), (error: unknown) => error === startupFailure);
}

async function testExitCodeEscalation(): Promise<void> {
  let releaseCleanup: (() => void) | null = null;
  const cleanupStarted = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const shutdown = createExitCodeAwareShutdown(async () => {
    await cleanupStarted;
    return 0;
  });

  const first = shutdown(0);
  const second = shutdown(1);
  assert.strictEqual(first, second, 'exit-code callers share one cleanup promise');
  releaseCleanup?.();
  assert.equal(await first, 1, 'a later fatal shutdown caller escalates the exit code');
}

async function testStandaloneDevServerShutdown(): Promise<void> {
  const devServerDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-dev-server-shutdown-'));
  const child = spawn(process.execPath, ['dev-server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: '0',
      KDS_PORT: '0',
      SERVER_APP_PORT: '0',
      FLO_DEV_USER_DATA: devServerDataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dev-server did not start: ${output}`)), 20_000);
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('Server App running')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (code !== null || signal !== null) {
        clearTimeout(timer);
        reject(new Error(`dev-server exited before ready (${code ?? signal}): ${output}`));
      }
    });
  });

  try {
    await ready;
    child.kill('SIGTERM');
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`dev-server did not exit: ${output}`)), 20_000);
      child.once('exit', (exitCode, exitSignal) => {
        clearTimeout(timer);
        resolve([exitCode, exitSignal]);
      });
    });
    assert.equal(signal, null, 'standalone dev-server exits through its shutdown handler');
    assert.equal(code, 0, `standalone dev-server exits successfully: ${output}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(devServerDataDir, { recursive: true, force: true });
  }
}

async function testStartupEntrypoint(startupRace = false): Promise<void> {
  const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  if (startupRace) childEnv.FLO_STARTUP_RACE = '1';
  else delete childEnv.FLO_STARTUP_RACE;
  const child = spawn(process.execPath, [
    require.resolve('ts-node/dist/bin.js'),
    '--transpile-only',
    '-P',
    path.join(__dirname, 'tsconfig.json'),
    path.join(__dirname, 'startup-failure-child.cjs'),
  ], {
    cwd: path.resolve(__dirname, '..'),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup-failure child timed out: ${output}`)), 20_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (exitCode, exitSignal) => {
      clearTimeout(timer);
      resolve([exitCode, exitSignal]);
    });
  });
  assert.equal(signal, null, `startup-failure child exited by signal: ${output}`);
  assert.equal(code, 0, `${startupRace ? 'startup cancellation' : 'startup failure'} entrypoint coverage failed: ${output}`);
  const resultLine = output.trim().split('\n').at(-1) || '';
  assert.equal(JSON.parse(resultLine).passed, true, output);
}

async function testOwnedServerStopEntrypoints(): Promise<void> {
  process.env.PORT = '0';
  process.env.KDS_PORT = '0';
  process.env.SERVER_APP_PORT = '0';

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
    const {
      initDatabase,
      closeDatabase,
      beginDatabaseShutdown,
      waitForDatabaseRequests,
      withDatabaseRequest,
      withDatabaseMaintenanceLock,
    } = await import('../main/db');
    const mainServer = await import('../main/server');
    const kdsServer = await import('../main/kds-server');
    const serverApp = await import('../main/server-app');
    const cloudSync = await import('../main/services/cloud-sync');

    await mainServer.stopServer();
    await kdsServer.stopKdsServer();
    await serverApp.stopServerApp();
    initDatabase();

    let releaseFirstMaintenance: (() => void) | null = null;
    let releaseSecondMaintenance: (() => void) | null = null;
    const firstMaintenance = withDatabaseMaintenanceLock(() => new Promise<void>((resolve) => {
      releaseFirstMaintenance = resolve;
    }));
    const secondMaintenance = withDatabaseMaintenanceLock(() => new Promise<void>((resolve) => {
      releaseSecondMaintenance = resolve;
    }));
    const maintenanceDrain = waitForDatabaseRequests();
    let maintenanceDrainSettled = false;
    void maintenanceDrain.then(() => { maintenanceDrainSettled = true; });
    await delay(10);
    assert.equal(maintenanceDrainSettled, false, 'the database barrier waits for queued maintenance');
    releaseFirstMaintenance?.();
    await delay(10);
    assert.equal(maintenanceDrainSettled, false, 'the database barrier waits for the active queued operation');
    releaseSecondMaintenance?.();
    await Promise.all([firstMaintenance, secondMaintenance, maintenanceDrain]);

    let releaseDatabaseRequest: (() => void) | null = null;
    const activeDatabaseRequest = withDatabaseRequest(() => new Promise<void>((resolve) => {
      releaseDatabaseRequest = resolve;
    }));
    const cloudShutdown = cloudSync.cloudSync.shutdown();
    assert.strictEqual(cloudShutdown, cloudSync.cloudSync.shutdown(), 'cloud shutdown is idempotent');
    await cloudShutdown;
    const databaseDrain = waitForDatabaseRequests();
    let cloudShutdownSettled = false;
    void cloudShutdown.then(() => { cloudShutdownSettled = true; });
    await delay(10);
    assert.equal(cloudShutdownSettled, true, 'cloud shutdown settles without waiting for HTTP database work');
    let databaseDrainSettled = false;
    void databaseDrain.then(() => { databaseDrainSettled = true; });
    await delay(10);
    assert.equal(databaseDrainSettled, false, 'the final database barrier waits for in-flight work');
    releaseDatabaseRequest?.();
    await activeDatabaseRequest;
    await databaseDrain;

    await mainServer.startServer();
    await kdsServer.startKdsServer();
    await serverApp.startServerApp();

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
      new Promise<void>((resolve, reject) => {
        const request = http.get({ host: '127.0.0.1', port: serverApp.getServerAppPort(), path: '/api/health' }, (response) => {
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

    const firstServerAppStop = serverApp.stopServerApp();
    assert.strictEqual(firstServerAppStop, serverApp.stopServerApp(), 'server app stop is idempotent while draining');
    await firstServerAppStop;
    assert.equal(serverApp.isServerAppRunning(), false);

    await mainServer.stopServer();
    await kdsServer.stopKdsServer();
    await serverApp.stopServerApp();
    beginDatabaseShutdown();
    let lateDatabaseOperationRan = false;
    await assert.rejects(
      withDatabaseRequest(() => { lateDatabaseOperationRan = true; }),
      (error: any) => error?.code === 'ERR_SHUTDOWN_ABORTED',
      'late database requests are rejected after shutdown admission closes',
    );
    assert.equal(lateDatabaseOperationRan, false, 'late database operations never enter SQLite');
    let lateMaintenanceRan = false;
    await assert.rejects(
      withDatabaseMaintenanceLock(() => { lateMaintenanceRan = true; }),
      (error: any) => error?.code === 'ERR_SHUTDOWN_ABORTED',
      'late maintenance requests are rejected after shutdown admission closes',
    );
    assert.equal(lateMaintenanceRan, false, 'late maintenance never enters SQLite');
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
  await testHttpStopsAcceptingBeforeSlowWebSocketDrain();
  await testTrackedHttpHandlerDrain();
  await testPendingHttpListenIsCancelled();
  console.log('phase entrypoints');
  await testEntrypointCoverage();
  await testExitCodeEscalation();
  await testStartupEntrypoint();
  await testStartupEntrypoint(true);
  await testStandaloneDevServerShutdown();
  console.log('phase owned servers');
  await testOwnedServerStopEntrypoints();
  console.log('Shutdown lifecycle tests passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

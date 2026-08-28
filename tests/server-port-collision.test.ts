import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-port-collision-'));

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

async function run(): Promise<void> {
  const { startServer, stopServer, getServerPort } = await import('../main/server');
  const { startKdsServer, stopKdsServer, getKdsPort } = await import('../main/kds-server');
  const { startServerApp, stopServerApp, getServerAppPort } = await import('../main/server-app');
  const { initDatabase, closeDatabase } = await import('../main/db');

  function simulateEaccesOnce() {
    const origListen = http.Server.prototype.listen;
    let failed = false;
    http.Server.prototype.listen = function (this: http.Server, ...args: any[]) {
      if (!failed) {
        failed = true;
        process.nextTick(() => {
          const err: NodeJS.ErrnoException = new Error('listen EACCES: permission denied 0.0.0.0');
          err.code = 'EACCES';
          err.syscall = 'listen';
          this.emit('error', err);
        });
        return this;
      }
      return origListen.apply(this, args);
    };
    return () => {
      http.Server.prototype.listen = origListen;
    };
  }

  function simulateEaccesAlways(maxFails = 12) {
    const origListen = http.Server.prototype.listen;
    let count = 0;
    http.Server.prototype.listen = function (this: http.Server, ...args: any[]) {
      if (count < maxFails) {
        count++;
        process.nextTick(() => {
          const err: NodeJS.ErrnoException = new Error('listen EACCES: permission denied 0.0.0.0');
          err.code = 'EACCES';
          err.syscall = 'listen';
          this.emit('error', err);
        });
        return this;
      }
      return origListen.apply(this, args);
    };
    return () => {
      http.Server.prototype.listen = origListen;
    };
  }

  try {
    initDatabase();

    // ── 1. API Server (main/server.ts) ──────────────────────────────────
    console.log('[Test] Testing API server...');

    // Ephemeral port
    process.env.PORT = '0';
    await startServer();
    const ephemeralPort = getServerPort();
    assert.equal(typeof ephemeralPort, 'number', 'the active port is a number');
    assert.ok(ephemeralPort > 0, 'getServerPort() reports a real bound port, not the configured 0');
    const ephemStatus = await new Promise<number>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: ephemeralPort, path: '/api/health' }, (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode ?? 0));
      });
      req.once('error', reject);
    });
    assert.equal(ephemStatus, 200, 'health check responds on ephemeral port');
    await stopServer().catch(() => {});
    console.log('✅ API Server ephemeral port passed');

    // EADDRINUSE collision fallback
    const dummyServer1 = http.createServer((_, res) => res.end('occupied'));
    const occupiedPort1 = await new Promise<number>((resolve) => {
      dummyServer1.listen(0, '0.0.0.0', () => {
        const addr = dummyServer1.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    process.env.PORT = String(occupiedPort1);
    await startServer();
    const collidedPort1 = getServerPort();
    assert.equal(collidedPort1, occupiedPort1 + 1, 'API Server incremented past occupied port');
    const collidedStatus1 = await new Promise<number>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: collidedPort1, path: '/api/health' }, (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode ?? 0));
      });
      req.once('error', reject);
    });
    assert.equal(collidedStatus1, 200, 'API Server health check responds on EADDRINUSE fallback port');
    dummyServer1.close();
    await stopServer().catch(() => {});
    console.log('✅ API Server EADDRINUSE collision fallback passed');

    // EACCES fallback
    const restoreEacces1 = simulateEaccesOnce();
    const basePort1 = 34500;
    process.env.PORT = String(basePort1);
    await startServer();
    restoreEacces1();
    const eaccesPort1 = getServerPort();
    assert.equal(eaccesPort1, basePort1 + 1, 'API Server incremented past EACCES port');
    const eaccesStatus1 = await new Promise<number>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: eaccesPort1, path: '/api/health' }, (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode ?? 0));
      });
      req.once('error', reject);
    });
    assert.equal(eaccesStatus1, 200, 'API Server health check responds on EACCES fallback port');
    await stopServer().catch(() => {});
    console.log('✅ API Server EACCES fallback passed');

    // Retry exhaustion
    const restoreExhaust1 = simulateEaccesAlways(12);
    process.env.PORT = '35000';
    await assert.rejects(
      startServer(),
      (err: Error) => err.message.includes('Failed to bind to any port after 10 attempts starting from 35000'),
      'API Server fails after 10 failed attempts',
    );
    restoreExhaust1();
    await stopServer().catch(() => {});
    console.log('✅ API Server retry exhaustion passed');

    // ── 2. KDS Server (main/kds-server.ts) ───────────────────────────────
    console.log('[Test] Testing KDS server...');

    // EADDRINUSE collision fallback
    const dummyServer2 = http.createServer((_, res) => res.end('occupied'));
    const occupiedPort2 = await new Promise<number>((resolve) => {
      dummyServer2.listen(0, '0.0.0.0', () => {
        const addr = dummyServer2.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    process.env.KDS_PORT = String(occupiedPort2);
    await startKdsServer();
    const collidedPort2 = getKdsPort();
    assert.equal(collidedPort2, occupiedPort2 + 1, 'KDS Server incremented past occupied port');
    dummyServer2.close();
    await stopKdsServer().catch(() => {});
    console.log('✅ KDS Server EADDRINUSE collision fallback passed');

    // EACCES fallback
    const restoreEacces2 = simulateEaccesOnce();
    const basePort2 = 36500;
    process.env.KDS_PORT = String(basePort2);
    await startKdsServer();
    restoreEacces2();
    const eaccesPort2 = getKdsPort();
    assert.equal(eaccesPort2, basePort2 + 1, 'KDS Server incremented past EACCES port');
    await stopKdsServer().catch(() => {});
    console.log('✅ KDS Server EACCES fallback passed');

    // Retry exhaustion
    const restoreExhaust2 = simulateEaccesAlways(12);
    process.env.KDS_PORT = '37000';
    await assert.rejects(
      startKdsServer(),
      (err: Error) => err.message.includes('Failed to bind to any port after 10 attempts starting from 37000'),
      'KDS Server fails after 10 failed attempts',
    );
    restoreExhaust2();
    await stopKdsServer().catch(() => {});
    console.log('✅ KDS Server retry exhaustion passed');

    // ── 3. Server App (main/server-app.ts) ───────────────────────────────
    console.log('[Test] Testing Server App...');

    // EADDRINUSE collision fallback
    const dummyServer3 = http.createServer((_, res) => res.end('occupied'));
    const occupiedPort3 = await new Promise<number>((resolve) => {
      dummyServer3.listen(0, '0.0.0.0', () => {
        const addr = dummyServer3.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    process.env.SERVER_APP_PORT = String(occupiedPort3);
    await startServerApp();
    const collidedPort3 = getServerAppPort();
    assert.equal(collidedPort3, occupiedPort3 + 1, 'Server App incremented past occupied port');
    const collidedStatus3 = await new Promise<number>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: collidedPort3, path: '/api/health' }, (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode ?? 0));
      });
      req.once('error', reject);
    });
    assert.equal(collidedStatus3, 200, 'Server App health check responds on fallback port');
    dummyServer3.close();
    await stopServerApp().catch(() => {});
    console.log('✅ Server App EADDRINUSE collision fallback passed');

    // EACCES fallback
    const restoreEacces3 = simulateEaccesOnce();
    const basePort3 = 38500;
    process.env.SERVER_APP_PORT = String(basePort3);
    await startServerApp();
    restoreEacces3();
    const eaccesPort3 = getServerAppPort();
    assert.equal(eaccesPort3, basePort3 + 1, 'Server App incremented past EACCES port');
    const eaccesStatus3 = await new Promise<number>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: eaccesPort3, path: '/api/health' }, (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode ?? 0));
      });
      req.once('error', reject);
    });
    assert.equal(eaccesStatus3, 200, 'Server App health check responds on EACCES fallback port');
    await stopServerApp().catch(() => {});
    console.log('✅ Server App EACCES fallback passed');

    // Retry exhaustion
    const restoreExhaust3 = simulateEaccesAlways(12);
    process.env.SERVER_APP_PORT = '39000';
    await assert.rejects(
      startServerApp(),
      (err: Error) => err.message.includes('Failed to bind to any port after 10 attempts starting from 39000'),
      'Server App fails after 10 failed attempts',
    );
    restoreExhaust3();
    await stopServerApp().catch(() => {});
    console.log('✅ Server App retry exhaustion passed');

    console.log('\n🎉 ALL PORT COLLISION & EACCES FALLBACK TESTS PASSED!');
  } finally {
    await stopServer().catch(() => {});
    await stopKdsServer().catch(() => {});
    await stopServerApp().catch(() => {});
    closeDatabase();
  }
}

run()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

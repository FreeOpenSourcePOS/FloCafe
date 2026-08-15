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
  // PORT=0 asks the OS for an ephemeral port. The configured value (0) can
  // never equal the actual bound port, so this deterministically exercises the
  // same divergence as a collision-selected port: getServerPort() must report
  // the real bound port, not the configured one.
  process.env.PORT = '0';

  // Imported after PORT is set so server.ts captures the ephemeral port.
  const { startServer, stopServer, getServerPort } = await import('../main/server');
  const { initDatabase, closeDatabase } = await import('../main/db');

  try {
    initDatabase();
    await startServer();

    const activePort = getServerPort();
    assert.equal(typeof activePort, 'number', 'the active port is a number');
    assert.ok(activePort > 0, 'getServerPort() reports a real bound port, not the configured 0');

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: activePort, path: '/api/health' }, (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode ?? 0));
      });
      req.once('error', reject);
    });
    assert.equal(status, 200, 'health check responds on the port reported by getServerPort()');

    // Guard the actual fix: the Electron main window must load and validate
    // against getServerPort(), not a stale module-local PORT constant.
    const indexPath = path.join(__dirname, '..', 'main', 'index.ts');
    const indexSource = fs.readFileSync(indexPath, 'utf8');
    assert.match(indexSource, /getServerPort/, 'index.ts imports/uses getServerPort()');
    assert.doesNotMatch(indexSource, /const PORT = parseInt/, 'index.ts no longer defines a stale PORT constant');
    assert.doesNotMatch(indexSource, /loadURL\(`http:\/\/localhost:\$\{PORT\}`\)/, 'loadURL no longer uses the stale PORT constant');
    assert.doesNotMatch(indexSource, /isAllowedLocalWindowUrl\(url, PORT,/, 'local-window validation no longer uses the stale PORT constant');

    console.log('✅ Server port-collision tests passed');
  } finally {
    await stopServer().catch(() => {});
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

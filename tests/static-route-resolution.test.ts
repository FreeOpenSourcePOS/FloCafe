const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert').strict;

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-static-routes-'));
Object.defineProperty(process, 'resourcesPath', { value: testDir, configurable: true });

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, closeDatabase } = require('../main/db');
const { resolveStaticPage, startServer, stopServer, getServerPort } = require('../main/server');

const fixture = path.join(testDir, 'frontend-out');
fs.mkdirSync(fixture, { recursive: true });
fs.writeFileSync(path.join(fixture, 'index.html'), 'root');
fs.mkdirSync(path.join(fixture, 'whatsapp'));
fs.writeFileSync(path.join(fixture, 'whatsapp', 'index.html'), 'whatsapp');
fs.mkdirSync(path.join(fixture, 'kds-standalone'));
fs.writeFileSync(path.join(fixture, 'kds-standalone', 'index.html'), 'kds-standalone');

assert.equal(resolveStaticPage(fixture, '/whatsapp'), path.join(fixture, 'whatsapp', 'index.html'));
assert.equal(resolveStaticPage(fixture, '/whatsapp/'), path.join(fixture, 'whatsapp', 'index.html'));
assert.equal(
  resolveStaticPage(fixture, '/kds-standalone'),
  path.join(fixture, 'kds-standalone', 'index.html'),
);
assert.equal(
  resolveStaticPage(fixture, '/kds-standalone/'),
  path.join(fixture, 'kds-standalone', 'index.html'),
);
assert.equal(resolveStaticPage(fixture, '/unknown'), path.join(fixture, 'index.html'));
assert.equal(resolveStaticPage(fixture, '/../outside'), path.join(fixture, 'index.html'));

async function getFreeTcpPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error: Error | undefined) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function main() {
  process.env.PORT = String(await getFreeTcpPort());
  initDatabase();
  await startServer();
  const baseUrl = `http://127.0.0.1:${getServerPort()}`;

  try {
    const whatsappRes = await fetch(`${baseUrl}/whatsapp`);
    assert.equal(whatsappRes.status, 200);
    assert.equal(await whatsappRes.text(), 'whatsapp');

    const kdsStandaloneRes = await fetch(`${baseUrl}/kds-standalone`);
    assert.equal(kdsStandaloneRes.status, 200);
    assert.equal(await kdsStandaloneRes.text(), 'kds-standalone');

    const kdsStandaloneSlashRes = await fetch(`${baseUrl}/kds-standalone/`);
    assert.equal(kdsStandaloneSlashRes.status, 200);
    assert.equal(await kdsStandaloneSlashRes.text(), 'kds-standalone');

    const kdsExactRes = await fetch(`${baseUrl}/kds`);
    assert.equal(kdsExactRes.status, 404);

    const kdsSubpathRes = await fetch(`${baseUrl}/kds/orders`);
    assert.equal(kdsSubpathRes.status, 404);

    const apiUnknownRes = await fetch(`${baseUrl}/api/auth/nonexistent`);
    assert.equal(apiUnknownRes.status, 404);
  } finally {
    await stopServer();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  console.log('✅ Static route resolution tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

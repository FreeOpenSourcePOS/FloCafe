/**
 * Proves that fronting the real POS, KDS and Server App listeners with in-process TLS keeps
 * every loopback-trust and per-client-IP decision correct: a LAN device reaching FloCafe over
 * HTTPS is seen with its real address, so it can never pass the POS-computer-only guards and
 * cannot lock out another device.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

process.env.FLO_AUTH_RATE_LIMIT_MAX = '100';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-secure-network-integrity-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

async function getFreeTcpPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function lanAddress(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (
        entry.family === 'IPv4' &&
        !entry.internal &&
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address)
      ) {
        return entry.address;
      }
    }
  }
  return null;
}

function httpsJson(
  port: number,
  ca: string,
  method: string,
  pathName: string,
  options: { address: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = https.request(
      {
        host: options.address,
        port,
        path: pathName,
        method,
        ca,
        agent: false,
        servername: net.isIP(options.address) ? undefined : options.address,
        headers: {
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          ...options.headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let body: unknown = data;
          try {
            body = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  console.log('Secure Network client-address integrity suite');
  const lan = lanAddress();
  if (!lan) {
    console.log('  not run: this machine has no private LAN interface to act as a second device');
    return;
  }

  process.env.PORT = String(await getFreeTcpPort());
  process.env.KDS_PORT = String(await getFreeTcpPort());
  process.env.SERVER_APP_PORT = String(await getFreeTcpPort());

  const bcrypt = require('bcryptjs');
  const {
    initDatabase,
    getDatabase,
    closeDatabase,
    now,
    createDatabaseMaintenanceHandoff,
    consumeDatabaseMaintenanceHandoff,
  } = await import('../main/db');
  const { clearLoginRateLimits, clearInMemoryRevokedTokens } =
    await import('../main/middleware/security');
  const {
    startServer,
    stopServer,
    getServerPort,
    getHttpServer: mainHttp,
  } = await import('../main/server');
  const {
    startKdsServer,
    stopKdsServer,
    getKdsPort,
    getHttpServer: kdsHttp,
  } = await import('../main/kds-server');
  const {
    startServerApp,
    stopServerApp,
    getServerAppPort,
    getHttpServer: appHttp,
  } = await import('../main/server-app');
  const { configureSecureNetwork, clearSecureNetworkForTests } =
    await import('../main/security/lan-tls/secure-network');

  initDatabase();
  const db = getDatabase();
  const passwordHash = bcrypt.hashSync('CorrectPassword123!', 10);
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('user-owner', 'Owner', 'owner@test.com', passwordHash, 'owner', 1, now(), now());
  const upsert = (key: string, value: string) =>
    db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  upsert('server_app_enabled', 'true');
  upsert('kds_enabled', 'true');

  await startServer();
  await startKdsServer();
  await startServerApp();

  const ports: Record<string, number | null> = { main: null, kds: null, serverApp: null };
  const service = configureSecureNetwork({
    directory: path.join(testDir, 'secure-network'),
    storage: {
      isAvailable: () => true,
      encrypt: (plain: string) => Buffer.from(Buffer.from(plain).toString('base64')),
      decrypt: (buf: Buffer) => Buffer.from(buf.toString('utf8'), 'base64').toString('utf8'),
    },
    getLanIPs: () => [lan],
    bindHost: '0.0.0.0',
    log: () => {},
    surfaces: [
      {
        id: 'main',
        label: 'POS',
        getHttpServer: mainHttp,
        getHttpPort: getServerPort,
        getCandidatePorts: () => [0],
        setHttpsPort: (p: number | null) => (ports.main = p),
      },
      {
        id: 'kds',
        label: 'KDS',
        getHttpServer: kdsHttp,
        getHttpPort: getKdsPort,
        getCandidatePorts: () => [0],
        setHttpsPort: (p: number | null) => (ports.kds = p),
      },
      {
        id: 'serverApp',
        label: 'Server App',
        getHttpServer: appHttp,
        getHttpPort: getServerAppPort,
        getCandidatePorts: () => [0],
        setHttpsPort: (p: number | null) => (ports.serverApp = p),
      },
    ],
  });
  await service.start();

  try {
    assert.equal(service.getStatus().state, 'running');
    const ca = service.getPublicCa()!.pem;

    // 1. Initial-setup / local-only guard: a LAN device over HTTPS is refused, the POS computer is not.
    clearLoginRateLimits();
    const fromLan = await httpsJson(ports.main!, ca, 'POST', '/api/auth/recover-password', {
      address: lan,
      body: {},
    });
    assert.equal(fromLan.status, 403, 'LAN device over HTTPS cannot reach local-only recovery');
    assert.match(
      String(fromLan.body.error),
      /POS computer/,
      'refusal explains the POS computer rule',
    );
    const fromLoopback = await httpsJson(ports.main!, ca, 'POST', '/api/auth/recover-password', {
      address: '127.0.0.1',
      body: {},
    });
    assert.ok(
      !String(fromLoopback.body?.error ?? '').includes('POS computer'),
      'the POS computer itself passes the guard (control: the probe can tell the two apart)',
    );

    // 2. Maintenance handoff header is honoured only for real loopback sockets.
    let released = false;
    const reservation = {
      isReleased: () => released,
      retain: () => true,
      release: () => {
        released = true;
      },
    } as any;
    const lanToken = createDatabaseMaintenanceHandoff(reservation)!;
    await httpsJson(ports.main!, ca, 'GET', '/api/health', {
      address: lan,
      headers: { 'x-flo-maintenance-handoff': lanToken },
    });
    const survived = consumeDatabaseMaintenanceHandoff(lanToken);
    assert.ok(survived, 'a LAN request over HTTPS did not consume the loopback-only handoff token');
    const loopbackToken = createDatabaseMaintenanceHandoff(reservation)!;
    await httpsJson(ports.main!, ca, 'GET', '/api/health', {
      address: '127.0.0.1',
      headers: { 'x-flo-maintenance-handoff': loopbackToken },
    });
    assert.equal(
      consumeDatabaseMaintenanceHandoff(loopbackToken),
      null,
      'control: a loopback request over HTTPS does consume it',
    );

    // 3. Login lockout is keyed by the real client address, across all three HTTPS surfaces.
    clearLoginRateLimits();
    const surfaces: Array<[string, number]> = [
      ['main', ports.main!],
      ['kds', ports.kds!],
      ['serverApp', ports.serverApp!],
      ['main', ports.main!],
      ['kds', ports.kds!],
    ];
    for (const [name, port] of surfaces) {
      const attempt = await httpsJson(port, ca, 'POST', '/api/auth/login', {
        address: lan,
        body: { email: 'owner@test.com', password: 'WrongPassword1' },
      });
      assert.equal(attempt.status, 401, `${name}: failed login recorded`);
    }
    const locked = await httpsJson(ports.main!, ca, 'POST', '/api/auth/login', {
      address: lan,
      body: { email: 'owner@test.com', password: 'CorrectPassword123!' },
    });
    assert.equal(locked.status, 429, 'the abusive LAN device is locked out');
    const till = await httpsJson(ports.main!, ca, 'POST', '/api/auth/login', {
      address: '127.0.0.1',
      body: { email: 'owner@test.com', password: 'CorrectPassword123!' },
    });
    assert.equal(
      till.status,
      200,
      'the owner at the till (another source address) is not locked out',
    );

    // 4. Only the public CA is reachable without a login; everything else still needs auth.
    const publicBase = `http://127.0.0.1:${getServerPort()}`;
    const unauth = await fetch(`${publicBase}/api/secure-network/status`);
    assert.equal(unauth.status, 401, 'status requires authentication');
    const trustInfo = await fetch(`${publicBase}/api/secure-network/trust-info`);
    assert.equal(trustInfo.status, 200, 'trust-info is reachable without a login');
    const trustBody = (await trustInfo.json()) as { fingerprint_sha256: string };
    assert.equal(trustBody.fingerprint_sha256, service.getPublicCa()!.fingerprints.sha256);
    const cer = await fetch(`${publicBase}/api/secure-network/ca.cer`);
    assert.equal(cer.status, 200);
    assert.equal(cer.headers.get('content-type'), 'application/x-x509-ca-cert');
    const cerBytes = Buffer.from(await cer.arrayBuffer());
    assert.deepEqual(
      cerBytes,
      service.getPublicCa()!.der,
      'the download is exactly the public CA certificate',
    );
    assert.ok(
      !cerBytes.toString('latin1').includes('PRIVATE KEY'),
      'no key material is ever served',
    );
    const reset = await fetch(`${publicBase}/api/secure-network/reset`, { method: 'POST' });
    assert.equal(reset.status, 401, 'reset requires authentication');
    const enable = await fetch(`${publicBase}/api/secure-network/enabled`, { method: 'PUT' });
    assert.equal(enable.status, 401, 'toggle requires authentication');
  } finally {
    clearInMemoryRevokedTokens();
    await service.stop();
    clearSecureNetworkForTests();
    await stopServerApp();
    await stopKdsServer();
    await stopServer();
    closeDatabase();
  }
  console.log('Secure Network client-address integrity suite passed');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

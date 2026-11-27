import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as os from 'node:os';
import * as tls from 'node:tls';
import * as path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { SecretStorage } from '../main/security/lan-tls/ca-store';
import { isAllowedHostHeader } from '../main/security/lan-tls/https-front';
import { buildSurfaceAddresses } from '../main/routes/secure-network';
import {
  SecureNetworkService,
  type SurfaceDefinition,
  type SurfaceId,
} from '../main/security/lan-tls/secure-network';
import {
  caTrustAnchorPemForNodeTls,
  derFromPem,
  generateKeyPair,
  issueCaCertificate,
  issueLeafCertificate,
} from '../main/security/lan-tls/x509';

const storage: SecretStorage = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from(Buffer.from(plain, 'utf8').toString('base64')),
  decrypt: (encrypted) => Buffer.from(encrypted.toString('utf8'), 'base64').toString('utf8'),
};

interface TestSurface {
  definition: SurfaceDefinition;
  http: http.Server;
  httpsPort: number | null;
  wss: WebSocketServer;
}

function listen(server: http.Server | net.Server, host = '127.0.0.1', port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as net.AddressInfo).port));
  });
}

async function makeSurface(id: SurfaceId, candidatePorts: number[] = [0]): Promise<TestSurface> {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        surface: id,
        remote: req.socket.remoteAddress,
        encrypted: Boolean((req.socket as { encrypted?: boolean }).encrypted),
        host: req.headers.host,
      }),
    );
  });
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => {
    ws.send(JSON.stringify({ remote: req.socket.remoteAddress }));
  });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  const httpPort = await listen(server);
  const surface: TestSurface = {
    http: server,
    httpsPort: null,
    wss,
    definition: {
      id,
      label: id,
      getHttpServer: () => server,
      getHttpPort: () => httpPort,
      getCandidatePorts: () => candidatePorts,
      setHttpsPort: (port) => {
        surface.httpsPort = port;
      },
    },
  };
  return surface;
}

function trustAnchor(caPem: string): string {
  return caTrustAnchorPemForNodeTls(derFromPem(caPem));
}

function request(
  port: number,
  options: {
    ca?: string;
    host?: string;
    servername?: string;
    address?: string;
    path?: string;
  } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const address = options.address ?? '127.0.0.1';
    const req = https.request(
      {
        host: address,
        port,
        path: options.path ?? '/',
        headers: options.host ? { Host: options.host } : undefined,
        ca: options.ca ? trustAnchor(options.ca) : undefined,
        servername: options.servername,
        agent: false,
        timeout: 5000,
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
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flo-secure-network-svc-'));
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

async function expectConnectionFailure(promise: Promise<unknown>, message: string) {
  await assert.rejects(
    promise,
    (error: NodeJS.ErrnoException) => {
      return /certificate|self.signed|unable to verify|ECONNREFUSED/i.test(
        `${error.code ?? ''} ${error.message}`,
      );
    },
    message,
  );
}

async function main() {
  console.log('Secure Network service suite');
  const cleanups: Array<() => Promise<void> | void> = [];

  // ── Host header policy ─────────────────────────────────────────────────────
  assert.equal(isAllowedHostHeader('flo.local'), true);
  assert.equal(isAllowedHostHeader('FLO.LOCAL:3441'), true);
  assert.equal(isAllowedHostHeader('localhost:443'), true);
  assert.equal(isAllowedHostHeader('192.168.1.20:443'), true);
  assert.equal(isAllowedHostHeader('[::1]:443'), true);
  assert.equal(isAllowedHostHeader('evil.example.com'), false, 'arbitrary DNS names are refused');
  assert.equal(isAllowedHostHeader('8.8.8.8'), false, 'public IPs are refused');
  assert.equal(
    isAllowedHostHeader('localhost; script-src *'),
    false,
    'malformed hosts are refused',
  );
  assert.equal(isAllowedHostHeader(undefined), false, 'a missing Host is refused');

  // ── Start: three surfaces, real TLS ────────────────────────────────────────
  const main = await makeSurface('main');
  const kds = await makeSurface('kds');
  const serverApp = await makeSurface('serverApp');
  cleanups.push(() => new Promise<void>((r) => main.http.close(() => r())));
  cleanups.push(() => new Promise<void>((r) => kds.http.close(() => r())));
  cleanups.push(() => new Promise<void>((r) => serverApp.http.close(() => r())));

  let lanIps = ['192.168.1.20', '100.64.0.15', '8.8.8.8'];
  const directory = tempDir();
  const service = new SecureNetworkService({
    directory,
    storage,
    getLanIPs: () => lanIps,
    surfaces: [main.definition, kds.definition, serverApp.definition],
    bindHost: '127.0.0.1',
    log: () => {},
    getFirewallState: async () => ({
      supported: true,
      ruleInstalled: true,
      networkProfile: 'private',
    }),
  });
  await service.start();
  cleanups.push(() => service.stop());

  let status = service.getStatus();
  assert.equal(status.state, 'running', 'all three surfaces are serving HTTPS');
  assert.ok(
    main.httpsPort && kds.httpsPort && serverApp.httpsPort,
    'live HTTPS ports are published via accessors',
  );
  assert.equal(
    new Set([main.httpsPort, kds.httpsPort, serverApp.httpsPort]).size,
    3,
    'ports are distinct',
  );
  assert.deepEqual(status.lan_ips, ['192.168.1.20'], 'only private LAN addresses are certified');

  const ca = service.getPublicCa();
  assert.ok(ca, 'the public CA is available');
  const trusted = ca!.pem;

  // Trusted client succeeds; an untrusting client must fail validation (no bypass anywhere).
  const ok = await request(main.httpsPort!, { ca: trusted, servername: 'localhost' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.encrypted, true, 'the handler sees a TLS connection');
  await expectConnectionFailure(
    request(main.httpsPort!, { servername: 'localhost' }),
    'an untrusting client rejects the certificate',
  );

  // Each surface answers from its own HTTP server.
  for (const [surface, expected] of [
    [main, 'main'],
    [kds, 'kds'],
    [serverApp, 'serverApp'],
  ] as const) {
    const response = await request(surface.httpsPort!, { ca: trusted, servername: 'localhost' });
    assert.equal(
      response.body.surface,
      expected,
      `${expected} HTTPS reaches the ${expected} handlers`,
    );
  }

  // Host validation.
  const badHost = await request(main.httpsPort!, {
    ca: trusted,
    servername: 'localhost',
    host: 'evil.example.com',
  });
  assert.equal(badHost.status, 421, 'unexpected Host headers are rejected');
  const lanHost = await request(main.httpsPort!, {
    ca: trusted,
    servername: 'localhost',
    host: '192.168.1.20:443',
  });
  assert.equal(lanHost.status, 200, 'LAN IP Host headers are accepted');

  // ── Client address integrity ───────────────────────────────────────────────
  const loopbackSeen = (await request(main.httpsPort!, { ca: trusted, servername: 'localhost' }))
    .body.remote;
  assert.match(loopbackSeen, /127\.0\.0\.1$/, 'loopback clients are seen as loopback');

  const lan = lanAddress();
  if (lan) {
    const lanService = new SecureNetworkService({
      directory: tempDir(),
      storage,
      getLanIPs: () => [lan],
      surfaces: [
        (
          await (async () => {
            const surface = await makeSurface('main');
            cleanups.push(() => new Promise<void>((r) => surface.http.close(() => r())));
            return surface;
          })()
        ).definition,
      ],
      bindHost: '0.0.0.0',
      log: () => {},
    });
    await lanService.start();
    cleanups.push(() => lanService.stop());
    const lanPort = lanService.getStatus().surfaces[0].https_port!;
    const lanCa = lanService.getPublicCa()!.pem;
    const seen = await request(lanPort, { ca: lanCa, address: lan });
    assert.equal(
      seen.body.remote.replace('::ffff:', ''),
      lan,
      'a LAN connection keeps its real source address',
    );
    assert.ok(
      !/^127\./.test(seen.body.remote.replace('::ffff:', '')),
      'a LAN connection is never presented as loopback',
    );
  } else {
    console.log('  note: no private LAN interface found, real-LAN-source check not run');
  }

  // ── wss through the front ──────────────────────────────────────────────────
  const message = await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${main.httpsPort}/kds`, {
      ca: trustAnchor(trusted),
    });
    socket.once('message', (data) => {
      resolve(String(data));
      socket.close();
    });
    socket.once('error', reject);
  });
  assert.match(
    JSON.parse(message).remote,
    /127\.0\.0\.1$/,
    'wss upgrades reach the existing handler with the real address',
  );
  await new Promise<void>((resolve) => {
    const socket = new WebSocket(`wss://127.0.0.1:${main.httpsPort}/kds`, {
      headers: { Host: 'evil.example.com' },
      ca: trustAnchor(trusted),
    });
    socket.once('error', () => resolve());
    socket.once('unexpected-response', (_req, res) => {
      assert.equal(res.statusCode, 421, 'upgrades with a bad Host are refused');
      resolve();
    });
    socket.once('open', () => assert.fail('upgrade with a bad Host must not open'));
  });

  // An upgrade request to a surface with no WebSocket handler is refused, never left hanging.
  const plain = http.createServer((_req, res) => res.end('ok'));
  const plainPort = await listen(plain);
  cleanups.push(() => new Promise<void>((r) => plain.close(() => r())));
  let plainHttps: number | null = null;
  const plainService = new SecureNetworkService({
    directory: tempDir(),
    storage,
    getLanIPs: () => [],
    bindHost: '127.0.0.1',
    log: () => {},
    surfaces: [
      {
        id: 'serverApp',
        label: 'plain',
        getHttpServer: () => plain,
        getHttpPort: () => plainPort,
        getCandidatePorts: () => [0],
        setHttpsPort: (p) => {
          plainHttps = p;
        },
      },
    ],
  });
  await plainService.start();
  cleanups.push(() => plainService.stop());
  const refusal = await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${plainHttps}/`, {
      ca: trustAnchor(plainService.getPublicCa()!.pem),
      handshakeTimeout: 3000,
    });
    socket.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    socket.once('open', () => reject(new Error('must not open')));
    socket.once('error', reject);
  });
  assert.equal(refusal, 404, 'a surface without a WebSocket handler answers upgrades with 404');

  assert.deepEqual(
    service.getCertifiedLanIps(),
    ['192.168.1.20'],
    'only addresses in the active certificate are published',
  );

  // ── Diagnostics ────────────────────────────────────────────────────────────
  const checks = await service.runDiagnostics();
  const failing = checks.filter((c) => c.status === 'fail');
  assert.deepEqual(failing, [], 'a healthy install has no failing diagnostics');
  for (const id of [
    'lan_ip',
    'ports',
    'https_service',
    'backend',
    'websocket',
    'certificate',
    'firewall',
    'network_profile',
  ]) {
    assert.ok(
      checks.some((c) => c.id === id),
      `diagnostics include ${id}`,
    );
  }

  // ── LAN IP change reissues only the leaf ───────────────────────────────────
  const caBefore = service.getPublicCa()!.fingerprints.sha256;
  lanIps = ['192.168.1.77'];
  assert.equal(
    (await service.runDiagnostics()).find((c) => c.id === 'lan_ip')?.code,
    'lan_ip_changed',
  );
  assert.equal(
    await service.refresh(),
    true,
    'refresh reissues the leaf when the address set changes',
  );
  assert.equal(await service.refresh(), false, 'refresh is idempotent');
  assert.equal(
    service.getPublicCa()!.fingerprints.sha256,
    caBefore,
    'the CA is unchanged, so no device re-trusts',
  );
  status = service.getStatus();
  assert.deepEqual(status.ip_change?.current, ['127.0.0.1', '192.168.1.77']);
  assert.ok(status.ip_change?.previous.includes('192.168.1.20'));
  const presented = await new Promise<crypto.X509Certificate>((resolve, reject) => {
    const socket = tls.connect({
      host: '127.0.0.1',
      port: main.httpsPort!,
      ca: trustAnchor(trusted),
      servername: 'localhost',
    });
    socket.once('secureConnect', () => {
      resolve(new crypto.X509Certificate(socket.getPeerCertificate(true).raw));
      socket.end();
    });
    socket.on('error', reject);
  });
  assert.ok(presented.checkIP('192.168.1.77'), 'the new leaf covers the new address');
  assert.equal(presented.checkIP('192.168.1.20'), undefined, 'the old address is dropped');
  assert.ok(
    presented.verify(new crypto.X509Certificate(ca!.der).publicKey),
    'the new leaf chains to the same CA',
  );

  // ── Disable / enable ───────────────────────────────────────────────────────
  const oldPort = main.httpsPort!;
  await service.setEnabled(false);
  const disabledStatus = service.getStatus();
  assert.equal(disabledStatus.state, 'disabled');
  assert.equal(
    disabledStatus.certificate.ca_fingerprint_sha256,
    null,
    'disabling clears cached CA fingerprint from status',
  );
  assert.deepEqual(service.getCertifiedLanIps(), [], 'disabling clears cached certified LAN IPs');
  assert.equal(service.getPublicCa(), null, 'disabling clears the public CA');
  assert.equal(main.httpsPort, null, 'the published HTTPS port is cleared');
  await expectConnectionFailure(
    request(oldPort, { ca: trusted, servername: 'localhost' }),
    'the HTTPS listener is closed',
  );
  assert.equal(
    (await fetch(`http://127.0.0.1:${main.definition.getHttpPort()}/`)).status,
    200,
    'plain HTTP keeps working while disabled',
  );
  assert.equal((await service.runDiagnostics())[0].status, 'skipped');
  await service.setEnabled(true);
  assert.equal(service.getStatus().state, 'running', 're-enabling restores HTTPS');
  assert.equal(
    service.getPublicCa()!.fingerprints.sha256,
    caBefore,
    're-enabling keeps the same CA',
  );

  // ── Reset replaces the CA ──────────────────────────────────────────────────
  await service.resetAuthority();
  assert.notEqual(service.getPublicCa()!.fingerprints.sha256, caBefore, 'reset issues a new CA');
  assert.equal(
    service.getStatus().ca_regenerated,
    null,
    'a reset the owner started raises no warning',
  );
  assert.equal(service.getStatus().state, 'running');

  // ── Repair and crash recovery ──────────────────────────────────────────────
  main.httpsPort &&
    (await request(main.httpsPort, { ca: service.getPublicCa()!.pem, servername: 'localhost' }));
  await service.repair();
  assert.equal(service.getStatus().state, 'running', 'repair restarts the fronts');

  // A config-write failure while recording an address change must not desync the published addresses.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const roDir = tempDir();
    const roSurface = await makeSurface('main');
    cleanups.push(() => new Promise<void>((r) => roSurface.http.close(() => r())));
    let roIps = ['192.168.1.30'];
    const roService = new SecureNetworkService({
      directory: roDir,
      storage,
      getLanIPs: () => roIps,
      surfaces: [roSurface.definition],
      bindHost: '127.0.0.1',
      log: () => {},
    });
    await roService.start();
    cleanups.push(() => roService.stop());
    fs.chmodSync(path.join(roDir, 'config.json'), 0o444);
    roIps = ['192.168.1.31'];
    assert.equal(await roService.refresh(), true, 'refresh still applies the new certificate');
    assert.deepEqual(
      roService.getCertifiedLanIps(),
      ['192.168.1.31'],
      'published addresses follow the presented certificate',
    );
    assert.equal(await roService.refresh(), false, 'the applied change is not repeated');
  }

  // A failure part-way through swapping the certificate restores every front and keeps addresses consistent.
  const pfA = await makeSurface('main');
  const pfB = await makeSurface('kds');
  cleanups.push(() => new Promise<void>((r) => pfA.http.close(() => r())));
  cleanups.push(() => new Promise<void>((r) => pfB.http.close(() => r())));
  let pfIps = ['192.168.1.40'];
  const pf = new SecureNetworkService({
    directory: tempDir(),
    storage,
    getLanIPs: () => pfIps,
    surfaces: [pfA.definition, pfB.definition],
    bindHost: '127.0.0.1',
    log: () => {},
  });
  await pf.start();
  cleanups.push(() => pf.stop());
  const pfFronts = (
    pf as unknown as { fronts: Map<string, { setCredentials: (c: unknown) => void }> }
  ).fronts;
  const secondFront = pfFronts.get('kds')!;
  const originalSet = secondFront.setCredentials.bind(secondFront);
  let failNext = true;
  secondFront.setCredentials = (credentials) => {
    if (failNext) {
      failNext = false;
      throw new Error('context rejected');
    }
    originalSet(credentials);
  };
  const presentedFor = async (port: number) =>
    new Promise<crypto.X509Certificate>((resolve, reject) => {
      const socket = tls.connect({
        host: '127.0.0.1',
        port,
        ca: trustAnchor(pf.getPublicCa()!.pem),
        servername: 'localhost',
      });
      socket.once('secureConnect', () => {
        resolve(new crypto.X509Certificate(socket.getPeerCertificate(true).raw));
        socket.end();
      });
      socket.on('error', reject);
    });
  pfIps = ['192.168.1.41'];
  await assert.rejects(() => pf.refresh(), /context rejected/);
  assert.deepEqual(
    pf.getCertifiedLanIps(),
    ['192.168.1.40'],
    'published addresses stay on the previous set',
  );
  for (const surface of [pfA, pfB]) {
    assert.ok(
      (await presentedFor(surface.httpsPort!)).checkIP('192.168.1.40'),
      'every front still presents the previous certificate',
    );
  }
  assert.equal(await pf.refresh(), true, 'the next refresh retries and succeeds');
  assert.deepEqual(pf.getCertifiedLanIps(), ['192.168.1.41']);
  for (const surface of [pfA, pfB]) {
    assert.ok(
      (await presentedFor(surface.httpsPort!)).checkIP('192.168.1.41'),
      'every front presents the new certificate',
    );
  }

  // If restoring an earlier front also fails, that front is stopped rather than left mismatched.
  const rbA = await makeSurface('main');
  const rbB = await makeSurface('kds');
  cleanups.push(() => new Promise<void>((r) => rbA.http.close(() => r())));
  cleanups.push(() => new Promise<void>((r) => rbB.http.close(() => r())));
  let rbIps = ['192.168.1.50'];
  const rb = new SecureNetworkService({
    directory: tempDir(),
    storage,
    getLanIPs: () => rbIps,
    surfaces: [rbA.definition, rbB.definition],
    bindHost: '127.0.0.1',
    log: () => {},
  });
  await rb.start();
  cleanups.push(() => rb.stop());
  const rbFronts = (
    rb as unknown as { fronts: Map<string, { setCredentials: (c: unknown) => void }> }
  ).fronts;
  const rbFirst = rbFronts.get('main')!;
  const rbSecond = rbFronts.get('kds')!;
  const firstSet = rbFirst.setCredentials.bind(rbFirst);
  let firstCalls = 0;
  rbFirst.setCredentials = (credentials) => {
    firstCalls += 1;
    if (firstCalls === 2) throw new Error('restore rejected');
    firstSet(credentials);
  };
  rbSecond.setCredentials = () => {
    throw new Error('update rejected');
  };
  const firstPort = rbA.httpsPort!;
  rbIps = ['192.168.1.51'];
  await assert.rejects(() => rb.refresh(), /update rejected/);
  assert.equal(rbA.httpsPort, null, 'the front that could not be restored is unpublished');
  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: '127.0.0.1',
        port: firstPort,
        ca: trustAnchor(rb.getPublicCa()!.pem),
        servername: 'localhost',
      });
      socket.once('secureConnect', () => resolve(socket.end()));
      socket.on('error', reject);
    }),
    'the unrestorable front no longer accepts connections',
  );
  assert.deepEqual(
    rb.getCertifiedLanIps(),
    ['192.168.1.50'],
    'published addresses stay on the previous set',
  );
  assert.equal(rb.getStatus().surfaces.find((s) => s.id === 'main')?.listening, false);

  // A failed CA reset still restarts HTTPS and reports the first failure.
  const flakyStorage: SecretStorage = { ...storage };
  const flakySurface = await makeSurface('main');
  cleanups.push(() => new Promise<void>((r) => flakySurface.http.close(() => r())));
  const flaky = new SecureNetworkService({
    directory: tempDir(),
    storage: flakyStorage,
    getLanIPs: () => [],
    surfaces: [flakySurface.definition],
    bindHost: '127.0.0.1',
    log: () => {},
  });
  await flaky.start();
  cleanups.push(() => flaky.stop());
  const caBeforeFailure = flaky.getPublicCa()!.fingerprints.sha256;
  flakyStorage.encrypt = () => {
    throw new Error('disk full');
  };
  await assert.rejects(
    () => flaky.resetAuthority(),
    /disk full/,
    'the reset failure is the one reported',
  );
  flakyStorage.encrypt = storage.encrypt;
  assert.equal(flaky.getStatus().state, 'running', 'HTTPS is back up after a failed reset');
  assert.equal(
    flaky.getPublicCa()!.fingerprints.sha256,
    caBeforeFailure,
    'the previous CA keeps serving',
  );

  // ── Port conflicts fall through the ladder ─────────────────────────────────
  const blocker = net.createServer();
  const blockedPort = await listen(blocker, '127.0.0.1');
  cleanups.push(() => new Promise<void>((r) => blocker.close(() => r())));
  const ladderSurface = await makeSurface('main', [blockedPort, 0]);
  cleanups.push(() => new Promise<void>((r) => ladderSurface.http.close(() => r())));
  const ladderService = new SecureNetworkService({
    directory: tempDir(),
    storage,
    getLanIPs: () => [],
    surfaces: [ladderSurface.definition],
    bindHost: '127.0.0.1',
    log: () => {},
  });
  await ladderService.start();
  cleanups.push(() => ladderService.stop());
  assert.ok(
    ladderSurface.httpsPort && ladderSurface.httpsPort !== blockedPort,
    'a taken port falls through to the next candidate',
  );

  const exhaustedSurface = await makeSurface('main', [blockedPort]);
  cleanups.push(() => new Promise<void>((r) => exhaustedSurface.http.close(() => r())));
  const exhausted = new SecureNetworkService({
    directory: tempDir(),
    storage,
    getLanIPs: () => [],
    surfaces: [exhaustedSurface.definition],
    bindHost: '127.0.0.1',
    log: () => {},
  });
  await exhausted.start();
  assert.equal(
    exhausted.getStatus().state,
    'unavailable',
    'no free port degrades to unavailable without throwing',
  );
  assert.equal(exhausted.getStatus().surfaces[0].error_code, 'port_unavailable');
  assert.equal(
    (await fetch(`http://127.0.0.1:${exhaustedSurface.definition.getHttpPort()}/`)).status,
    200,
    'HTTP is unaffected by an HTTPS failure',
  );
  assert.equal(
    (await exhausted.runDiagnostics()).find((c) => c.id === 'ports')?.code,
    'port_unavailable',
  );

  // ── Missing OS encryption never blocks startup ─────────────────────────────
  const unprotectedSurface = await makeSurface('main');
  cleanups.push(() => new Promise<void>((r) => unprotectedSurface.http.close(() => r())));
  const unprotected = new SecureNetworkService({
    directory: tempDir(),
    storage: { ...storage, isAvailable: () => false },
    getLanIPs: () => [],
    surfaces: [unprotectedSurface.definition],
    log: () => {},
  });
  await unprotected.start();
  assert.equal(unprotected.getStatus().state, 'unavailable');
  assert.equal(unprotected.getStatus().error_code, 'secure_storage_unavailable');
  assert.equal(unprotected.getPublicCa(), null, 'no CA is exposed when it could not be created');

  // ── Corrupt CA key after a restore: regenerate, do not fail ────────────────
  const restoredDir = tempDir();
  const first = new SecureNetworkService({
    directory: restoredDir,
    storage,
    getLanIPs: () => [],
    surfaces: [],
    log: () => {},
  });
  await first.start();
  fs.writeFileSync(path.join(restoredDir, 'ca.key.enc'), 'corrupt');
  const restoredSurface = await makeSurface('main');
  cleanups.push(() => new Promise<void>((r) => restoredSurface.http.close(() => r())));
  const restored = new SecureNetworkService({
    directory: restoredDir,
    storage,
    getLanIPs: () => [],
    surfaces: [restoredSurface.definition],
    bindHost: '127.0.0.1',
    log: () => {},
  });
  await restored.start();
  cleanups.push(() => restored.stop());
  assert.equal(
    restored.getStatus().state,
    'running',
    'an unreadable CA key does not prevent HTTPS',
  );
  assert.equal(
    restored.getStatus().ca_regenerated?.reason,
    'key-unreadable',
    'the owner is told devices must trust again',
  );

  // ── Pinned loopback verification, surface ports, domain profile, state resets ──
  // Live negative checks: loopback diagnostics reject both a rogue-CA server and a mismatched leaf
  // signed by the same CA, while keeping native TLS certificate validation enabled.
  {
    const otherCaKeys = generateKeyPair();
    const otherCaCert = issueCaCertificate(otherCaKeys, {
      commonName: 'Other CA',
      organization: 'Other',
    });
    const rogueKeys = generateKeyPair();
    const rogueServerLeaf = issueLeafCertificate(
      rogueKeys,
      { dnsNames: ['localhost'], ipAddresses: ['127.0.0.1'] },
      { certificateDer: otherCaCert.der, privateKey: otherCaKeys.privateKey },
    );
    const rogueServer = https.createServer(
      {
        key: rogueKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
        cert: rogueServerLeaf.pem,
      },
      (_req, res) => res.end('rogue'),
    );
    const rogueWss = new WebSocketServer({ server: rogueServer });
    const roguePort = await listen(rogueServer);
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          rogueWss.close(() => rogueServer.close(() => r()));
        }),
    );
    const internal = service as unknown as {
      ca: { certificateDer: Buffer; privateKey: crypto.KeyObject };
      selfRequest: (
        port: number,
        requestPath: string,
        useTls: boolean,
      ) => Promise<{ status: number }>;
      websocketCheck: (port: number) => Promise<'open' | 'rejected' | 'failed'>;
    };
    await assert.rejects(
      () => internal.selfRequest(roguePort, '/api/health', true),
      'loopback HTTPS diagnostic rejects a rogue-CA TLS certificate',
    );
    assert.equal(
      await internal.websocketCheck(roguePort),
      'failed',
      'loopback WebSocket diagnostic rejects a rogue-CA TLS certificate',
    );

    const otherLeafKeys = generateKeyPair();
    const otherLeaf = issueLeafCertificate(
      otherLeafKeys,
      { dnsNames: ['localhost'], ipAddresses: ['127.0.0.1'] },
      { certificateDer: internal.ca.certificateDer, privateKey: internal.ca.privateKey },
    );
    const otherLeafServer = https.createServer(
      {
        key: otherLeafKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
        cert: otherLeaf.pem,
      },
      (_req, res) => res.end('other-leaf'),
    );
    const otherLeafWss = new WebSocketServer({ server: otherLeafServer });
    const otherLeafPort = await listen(otherLeafServer);
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          otherLeafWss.close(() => otherLeafServer.close(() => r()));
        }),
    );
    await assert.rejects(
      () => internal.selfRequest(otherLeafPort, '/api/health', true),
      /does not match expected leaf/,
      'loopback HTTPS diagnostic rejects a mismatched leaf signed by the same CA',
    );
    assert.equal(
      await internal.websocketCheck(otherLeafPort),
      'failed',
      'loopback WebSocket diagnostic rejects a mismatched leaf signed by the same CA',
    );
  }

  // buildSurfaceAddresses preserves http_port on every surface.
  {
    const addresses = buildSurfaceAddresses(service.getStatus(), service.getCertifiedLanIps());
    assert.equal(addresses.length, 3);
    assert.equal(
      addresses.find((s) => s.id === 'main')?.http_port,
      main.definition.getHttpPort(),
      'main surface address includes http_port',
    );
    assert.equal(
      addresses.find((s) => s.id === 'kds')?.http_port,
      kds.definition.getHttpPort(),
      'kds surface address includes http_port',
    );
    assert.equal(
      addresses.find((s) => s.id === 'serverApp')?.http_port,
      serverApp.definition.getHttpPort(),
      'serverApp surface address includes http_port',
    );
  }

  // Domain Windows Firewall profile emits warn/network_profile_domain; unknown emits skipped/network_profile_unknown.
  {
    const domainSurface = await makeSurface('main');
    cleanups.push(() => new Promise<void>((r) => domainSurface.http.close(() => r())));
    let profile: 'domain' | 'unknown' = 'domain';
    const domainService = new SecureNetworkService({
      directory: tempDir(),
      storage,
      getLanIPs: () => ['192.168.1.25'],
      surfaces: [domainSurface.definition],
      bindHost: '127.0.0.1',
      log: () => {},
      getFirewallState: async () => ({
        supported: true,
        ruleInstalled: true,
        networkProfile: profile,
      }),
    });
    await domainService.start();
    cleanups.push(() => domainService.stop());
    const domainCheck = (await domainService.runDiagnostics()).find(
      (c) => c.id === 'network_profile',
    );
    assert.deepEqual(
      domainCheck,
      { id: 'network_profile', status: 'warn', code: 'network_profile_domain' },
      'Domain profile warns instead of falsely reporting Private',
    );
    profile = 'unknown';
    const unknownCheck = (await domainService.runDiagnostics()).find(
      (c) => c.id === 'network_profile',
    );
    assert.deepEqual(
      unknownCheck,
      { id: 'network_profile', status: 'skipped', code: 'network_profile_unknown' },
      'unknown profile is skipped with network_profile_unknown',
    );
  }

  // Unwritable config.json on startup IP change still starts HTTPS fronts, and cert failures clear CA state.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const roStartDir = tempDir();
    const roStartSurface = await makeSurface('main');
    cleanups.push(() => new Promise<void>((r) => roStartSurface.http.close(() => r())));
    const seedService = new SecureNetworkService({
      directory: roStartDir,
      storage,
      getLanIPs: () => ['192.168.1.80'],
      surfaces: [roStartSurface.definition],
      bindHost: '127.0.0.1',
      log: () => {},
    });
    await seedService.start();
    await seedService.stop();
    const configPath = path.join(roStartDir, 'config.json');
    fs.chmodSync(configPath, 0o444);
    cleanups.push(() => {
      try {
        fs.chmodSync(configPath, 0o600);
      } catch {}
    });

    const restartedOnNewIp = new SecureNetworkService({
      directory: roStartDir,
      storage,
      getLanIPs: () => ['192.168.1.81'],
      surfaces: [roStartSurface.definition],
      bindHost: '127.0.0.1',
      log: () => {},
    });
    await restartedOnNewIp.start();
    cleanups.push(() => restartedOnNewIp.stop());
    assert.equal(
      restartedOnNewIp.getStatus().state,
      'running',
      'read-only config.json on IP change does not abort HTTPS startup',
    );
    assert.equal(restartedOnNewIp.getStatus().error_code, null);
    assert.deepEqual(restartedOnNewIp.getCertifiedLanIps(), ['192.168.1.81']);
  }

  {
    const failLeafSurface = await makeSurface('main');
    cleanups.push(() => new Promise<void>((r) => failLeafSurface.http.close(() => r())));
    const failLeafService = new SecureNetworkService({
      directory: tempDir(),
      storage,
      getLanIPs: () => ['192.168.1.90'],
      surfaces: [failLeafSurface.definition],
      bindHost: '127.0.0.1',
      log: () => {},
    });
    (failLeafService as unknown as { issueLeaf: () => void }).issueLeaf = () => {
      throw new Error('simulated leaf failure');
    };
    await failLeafService.start();
    assert.equal(failLeafService.getStatus().state, 'unavailable');
    assert.equal(failLeafService.getStatus().error_code, 'certificate_failed');
    assert.equal(
      failLeafService.getPublicCa(),
      null,
      'failed certificate provisioning does not leave a public CA exposed',
    );
    assert.equal(failLeafService.getStatus().certificate.ca_fingerprint_sha256, null);
    assert.deepEqual(failLeafService.getCertifiedLanIps(), []);
  }

  // ── Shutdown ───────────────────────────────────────────────────────────────
  await service.stop();
  assert.equal(main.httpsPort, null);
  assert.equal(kds.httpsPort, null);
  assert.equal(serverApp.httpsPort, null);

  // Public status never includes private key material.
  const serialised = JSON.stringify(service.getStatus());
  assert.ok(!/PRIVATE KEY/.test(serialised), 'status output never carries key material');

  for (const cleanup of cleanups.reverse()) await cleanup();
  console.log('Secure Network service suite passed');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

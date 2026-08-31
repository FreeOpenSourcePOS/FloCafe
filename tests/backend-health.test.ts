/**
 * probeBackendHealth verification.
 *
 * Confirms the real HTTP health probe used to gate Dock activation actually
 * catches the failure mode issue #548 was about: isServerRunning()-style
 * non-null checks stay true even after a server's HTTP listener has silently
 * died, since none of the three owned servers attach an 'error' listener.
 * probeBackendHealth() must instead reflect real liveness.
 *
 * Run: ts-node --transpile-only -P tests/tsconfig.json tests/backend-health.test.ts
 */

import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { probeBackendHealth } from '../main/backend-health';

function startHealthyServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

// Returns a port the OS just handed out and then released, instead of
// guessing one via arithmetic offsets from a live port (which is not
// guaranteed to be closed and can collide with something else listening).
// Nothing else can claim it between the close() below and the probe running
// immediately after, which is deterministic enough for a test.
function getDeterministicallyClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function run(): Promise<void> {
  console.log('[Step 1] All three services healthy...');
  const main = await startHealthyServer();
  const kds = await startHealthyServer();
  const serverApp = await startHealthyServer();
  try {
    const healthy = await probeBackendHealth({ server: main.port, kds: kds.port, serverApp: serverApp.port });
    assert.equal(healthy, true, 'probeBackendHealth reports healthy when all three /api/health endpoints respond ok');
    console.log('  ✓ Reports healthy when all three services answer.');
  } finally {
    await Promise.all([main.close(), kds.close(), serverApp.close()]);
  }

  console.log('\n[Step 2] KDS silently dead (port closed, connection refused)...');
  {
    const main2 = await startHealthyServer();
    const serverApp2 = await startHealthyServer();
    // Simulates the exact reported bug: a server that has died but whose
    // isServerRunning()-style reference would still be non-null. A port the
    // OS just freed reproduces the same "nobody answers" behavior a dead
    // listener produces, without needing a real process crash.
    const deadKdsPort = await getDeterministicallyClosedPort();
    try {
      const healthy = await probeBackendHealth(
        { server: main2.port, kds: deadKdsPort, serverApp: serverApp2.port },
        500,
      );
      assert.equal(healthy, false, 'probeBackendHealth reports unhealthy when the KDS endpoint is unreachable');
      console.log('  ✓ Reports unhealthy when the KDS endpoint does not answer.');
    } finally {
      await Promise.all([main2.close(), serverApp2.close()]);
    }
  }

  console.log('\n[Step 3] Server App silently dead (port closed, connection refused)...');
  {
    const main3 = await startHealthyServer();
    const kds3 = await startHealthyServer();
    // Independently exercises the third endpoint — Step 2 only ever proved
    // the KDS check works; a bug that always treated serverApp as healthy
    // would previously slip through since serverApp reused an already-healthy
    // port in this test rather than one known to be dead.
    const deadServerAppPort = await getDeterministicallyClosedPort();
    try {
      const healthy = await probeBackendHealth(
        { server: main3.port, kds: kds3.port, serverApp: deadServerAppPort },
        500,
      );
      assert.equal(healthy, false, 'probeBackendHealth reports unhealthy when the Server App endpoint is unreachable');
      console.log('  ✓ Reports unhealthy when the Server App endpoint does not answer.');
    } finally {
      await Promise.all([main3.close(), kds3.close()]);
    }
  }

  console.log('\n[Step 4] Non-ok HTTP response counts as unhealthy...');
  const server3 = http.createServer((_req, res) => { res.writeHead(503); res.end(); });
  await new Promise<void>((resolve) => server3.listen(0, '127.0.0.1', () => resolve()));
  const address3 = server3.address();
  const port3 = typeof address3 === 'object' && address3 ? address3.port : 0;
  try {
    const healthy = await probeBackendHealth({ server: port3, kds: port3, serverApp: port3 }, 500);
    assert.equal(healthy, false, 'a non-2xx /api/health response is treated as unhealthy');
    console.log('  ✓ A 503 response from /api/health is treated as unhealthy.');
  } finally {
    await new Promise<void>((resolve) => server3.close(() => resolve()));
  }

  console.log('\n✅ ALL BACKEND HEALTH PROBE CHECKS PASSED (4/4)');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

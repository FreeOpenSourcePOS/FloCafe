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

  console.log('\n[Step 2] One service silently dead (port closed, connection refused)...');
  const main2 = await startHealthyServer();
  const kds2 = await startHealthyServer();
  // Simulates the exact reported bug: a server that has died but whose
  // isServerRunning()-style reference would still be non-null. Using a
  // closed port here reproduces the same "nobody answers" behavior a dead
  // listener produces, without needing a real process crash.
  const deadPort = kds2.port + 10_000 > 65535 ? kds2.port - 100 : kds2.port + 10_000;
  try {
    const healthy = await probeBackendHealth({ server: main2.port, kds: deadPort, serverApp: main2.port }, 500);
    assert.equal(healthy, false, 'probeBackendHealth reports unhealthy when any one endpoint is unreachable');
    console.log('  ✓ Reports unhealthy when one of the three services does not answer.');
  } finally {
    await Promise.all([main2.close(), kds2.close()]);
  }

  console.log('\n[Step 3] Non-ok HTTP response counts as unhealthy...');
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

  console.log('\n✅ ALL BACKEND HEALTH PROBE CHECKS PASSED (3/3)');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

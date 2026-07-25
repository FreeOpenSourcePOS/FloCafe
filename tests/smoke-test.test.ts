import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-smoke-test-'));

Module._load = function (requestName: string, parent: unknown, isMain: boolean) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

import { startServer, stopServer } from '../main/server';
import { startKdsServer, stopKdsServer, getKdsPort } from '../main/kds-server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';

async function run() {
  console.log('Testing Dual-Server Application Smoke Test...');
  
  const assert = (condition: boolean, msg: string) => {
    if (!condition) {
      throw new Error(`Assertion failed: ${msg}`);
    }
  };

  initDatabase();
  await startServer();
  await startKdsServer();

  try {
    // 1. Health checks on both ports
    const res1 = await request('http://127.0.0.1:3001').get('/api/health');
    assert(res1.status === 200, 'Primary API health check responds with 200');
    assert(res1.body.status === 'ok', 'Primary API health check body is ok');

    const kdsPort = getKdsPort();
    const res2 = await request(`http://127.0.0.1:${kdsPort}`).get('/api/health');
    assert(res2.status === 200, 'KDS Server health check responds with 200');
    assert(res2.body.status === 'ok', 'KDS Server health check body is ok');

    // 2. Seed owner user and test setup/auth state on Main API
    const db = getDatabase();
    const bcrypt = require('bcryptjs');
    const hashed = bcrypt.hashSync('OwnerPass123!', 10);
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active)
      VALUES ('user-owner-1', 'Owner User', 'owner@flo.local', ?, 'owner', 1)
    `).run(hashed);

    const loginRes = await request('http://127.0.0.1:3001')
      .post('/api/auth/login')
      .send({ email: 'owner@flo.local', password: 'OwnerPass123!' });
    assert(loginRes.status === 200, 'Main API owner login succeeds with token');
    assert(!!loginRes.body.access_token, 'Main API returns access_token for authed owner');

    console.log('✅ Dual-Server Smoke tests passed!');
  } finally {
    stopServer();
    stopKdsServer();
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch { }
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

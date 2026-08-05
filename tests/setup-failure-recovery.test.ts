import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-setup-failure-'));
let encryptionShouldFail = false;

const mockSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => {
    if (encryptionShouldFail) throw new Error('simulated keyring failure');
    return Buffer.from(value, 'utf8');
  },
  decryptString: (value: Buffer) => value.toString('utf8'),
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      safeStorage: mockSafeStorage,
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const express = require('express');
const request = require('supertest');
import { closeDatabase, getDatabase, initDatabase } from '../main/db';
import { authRoutes } from '../main/routes/auth';
import { cloudSync } from '../main/services/cloud-sync';
import { isMasterPinSet, verifyMasterPin } from '../main/services/master-pin';

async function run() {
  initDatabase();
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);

  const setupPayload = {
    name: 'Recovery Owner',
    email: 'recovery-owner@example.com',
    password: 'TestPass123',
    business_type: 'restaurant',
    setup_profile: 'empty',
    service_model: 'qsr',
    terms_accepted: true,
    master_pin: '1234',
  };

  const originalReload = cloudSync.reload.bind(cloudSync);
  const originalRefresh = cloudSync.refreshRegistrationProfile.bind(cloudSync);

  try {
    encryptionShouldFail = true;
    const pinFailure = await request(app).post('/api/auth/setup/initialize').send(setupPayload);
    assert.equal(pinFailure.status, 500, 'setup reports Master PIN persistence failure');
    assert.equal((getDatabase().prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 0, 'PIN failure rolls back the owner transaction');
    assert.equal(isMasterPinSet(), false, 'failed PIN persistence does not create a PIN file');

    encryptionShouldFail = false;
    cloudSync.reload = (() => { throw new Error('simulated cloud reload failure'); }) as typeof cloudSync.reload;
    cloudSync.refreshRegistrationProfile = (() => { throw new Error('simulated cloud profile failure'); }) as typeof cloudSync.refreshRegistrationProfile;

    const cloudFailure = await request(app).post('/api/auth/setup/initialize').send(setupPayload);
    assert.equal(cloudFailure.status, 200, 'cloud initialization failure does not make local setup appear to fail');
    assert.equal((getDatabase().prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 1, 'owner is committed exactly once');
    assert.equal(isMasterPinSet(), true, 'Master PIN remains available after successful local setup');
    assert.equal(verifyMasterPin('1234'), true, 'persisted Master PIN verifies after setup');

    const retry = await request(app).post('/api/auth/setup/initialize').send({
      ...setupPayload,
      email: 'second-owner@example.com',
    });
    assert.equal(retry.status, 403, 'setup cannot be replayed after local success');

    console.log('✅ Setup post-commit failure tests passed');
  } finally {
    cloudSync.reload = originalReload;
    cloudSync.refreshRegistrationProfile = originalRefresh;
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  try { closeDatabase(); } catch { }
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});

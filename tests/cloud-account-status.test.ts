/**
 * Cloud account status route tests.
 *
 * The account status is optional cloud metadata. An unregistered or explicitly
 * stopped cloud service must not turn a normal dashboard navigation into a 502
 * or attempt an outbound request to FloAdmin.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cloud-account-status-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const request = require('supertest');
const {
  initTestDb,
  seedOwnerUser,
  seedManagerUser,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  getDatabase,
  now,
  createApp,
} = require('./helpers/test-setup');
const { settingsRoutes } = require('../main/routes/settings');
const { cloudSync } = require('../main/services/cloud-sync');

function setSettings(entries: Record<string, string>) {
  const db = getDatabase();
  for (const [key, value] of Object.entries(entries)) {
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now());
  }
}

async function run() {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;

  try {
    initTestDb();
    const db = getDatabase();
    const owner = seedOwnerUser(db);
    const manager = seedManagerUser(db);
    const app = createApp({ '/api/settings': settingsRoutes });

    const managerAccount = await request(app)
      .get('/api/settings/cloud/account')
      .set(manager.authHeader);
    assertEqual(managerAccount.status, 403, 'non-owner cannot read cloud account status');

    globalThis.fetch = (async () => {
      upstreamCalls++;
      throw new Error('unexpected outbound cloud request');
    }) as typeof fetch;

    console.log('Cloud account status route tests');
    console.log('='.repeat(50));

    setSettings({
      cloud_api_key: 'stale-api-key',
      cloud_registration_status: 'unregistered',
      cloud_services_disabled_by_user: 'false',
      cloud_deletion_request_id: '',
      cloud_deletion_status_token: '',
      cloud_deletion_status: '',
      cloud_last_error: 'legacy-upstream-token-reflection',
    });
    const publicCloudStatus = await request(app)
      .get('/api/settings/cloud')
      .set(owner.authHeader);
    assertEqual(publicCloudStatus.body.cloud_last_error, 'Cloud service request failed', 'legacy cloud errors are normalized in cloud status');
    const publicSettings = await request(app)
      .get('/api/settings')
      .set(owner.authHeader);
    assert(!JSON.stringify(publicSettings.body).includes('legacy-upstream-token-reflection'), 'legacy cloud errors are not exposed in generic settings');
    const unregistered = await request(app)
      .get('/api/settings/cloud/account')
      .set(owner.authHeader);
    assertEqual(unregistered.status, 200, 'unregistered cloud account status is not an error');
    assertEqual(unregistered.body.cloud_account_available, false, 'unregistered response marks account unavailable');
    assertEqual(unregistered.body.email, null, 'unregistered response has no cloud email');
    assertEqual(upstreamCalls, 0, 'unregistered account status does not call FloAdmin');

    upstreamCalls = 0;
    setSettings({
      cloud_api_key: 'registered-api-key',
      cloud_pos_hash: 'registered-pos-hash',
      cloud_registration_status: 'registered',
      cloud_services_disabled_by_user: 'true',
      cloud_deletion_request_id: 'deletion-id',
      cloud_deletion_status_token: 'deletion-status-token',
      cloud_deletion_status: 'pending',
    });
    const stopped = await request(app)
      .get('/api/settings/cloud/account')
      .set(owner.authHeader);
    assertEqual(stopped.status, 200, 'stopped cloud account status is not an error');
    assertEqual(stopped.body.cloud_account_available, false, 'stopped response marks account unavailable');
    assertEqual(stopped.body.deletion_request?.id, 'deletion-id', 'stopped response preserves local deletion request ID');
    assert(!('status_token' in (stopped.body.deletion_request || {})), 'stopped response does not expose deletion status token');
    assertEqual(upstreamCalls, 0, 'stopped account status does not call FloAdmin');

    const directToken = await request(app)
      .get('/api/settings/cloud_deletion_status_token')
      .set(owner.authHeader);
    assertEqual(directToken.status, 403, 'deletion status token cannot be read through the settings API');
    const allSettings = await request(app)
      .get('/api/settings')
      .set(owner.authHeader);
    assert(!JSON.stringify(allSettings.body).includes('deletion-status-token'), 'settings list does not expose the deletion status token');

    const stoppedPreferences = await request(app)
      .put('/api/settings/cloud/account/preferences')
      .set(owner.authHeader)
      .send({ product_updates: true });
    assertEqual(stoppedPreferences.status, 409, 'stopped cloud preferences are rejected locally');
    const stoppedVerification = await request(app)
      .post('/api/settings/cloud/account/verification')
      .set(owner.authHeader);
    assertEqual(stoppedVerification.status, 409, 'stopped cloud verification is rejected locally');
    const stoppedRegister = await request(app)
      .post('/api/settings/cloud/register')
      .set(owner.authHeader)
      .send({});
    assertEqual(stoppedRegister.status, 409, 'stopped cloud registration preflight is rejected locally');
    setSettings({ cloud_deletion_request_id: '', cloud_deletion_status_token: '' });
    const stoppedRegisterWithoutDeletion = await request(app)
      .post('/api/settings/cloud/register')
      .set(owner.authHeader)
      .send({});
    assertEqual(stoppedRegisterWithoutDeletion.status, 409, 'stopped registration without a deletion request is rejected locally');
    assertEqual(upstreamCalls, 0, 'stopped registration never calls FloAdmin without a deletion request');
    setSettings({ cloud_deletion_request_id: 'deletion-id', cloud_deletion_status_token: 'deletion-status-token', cloud_deletion_status: 'pending' });

    globalThis.fetch = (async () => {
      upstreamCalls++;
      return new Response(JSON.stringify({ status: 'approved', request_id: 'deletion-id', status_token: 'new-status-token' }), { status: 200 });
    }) as typeof fetch;
    const refreshedDeletion = await request(app)
      .get('/api/settings/cloud/delete-data/status')
      .set(owner.authHeader);
    assertEqual(refreshedDeletion.status, 200, 'explicit deletion status refresh succeeds');
    assertEqual(refreshedDeletion.body.deletion_request?.status, 'approved', 'explicit refresh returns the latest deletion status');
    assert(!('status_token' in (refreshedDeletion.body.deletion_request || {})), 'explicit refresh does not expose deletion status token');
    assertEqual(upstreamCalls, 1, 'explicit deletion status refresh is the only stopped-state outbound call');

    globalThis.fetch = (async () => {
      upstreamCalls++;
      return new Response(JSON.stringify({
        email: 'owner@example.com',
        verified: true,
        product_updates: true,
        marketing: false,
        status_token: 'must-not-leak',
        unexpected: 'must-not-leak',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    upstreamCalls = 0;
    setSettings({
      cloud_api_key: 'registered-api-key',
      cloud_pos_hash: 'registered-pos-hash',
      cloud_registration_status: 'registered',
      cloud_services_disabled_by_user: 'false',
      cloud_deletion_request_id: '',
      cloud_deletion_status_token: '',
      cloud_deletion_status: '',
      cloud_deletion_outcome: '',
    });
    cloudSync.reload();
    const registered = await request(app)
      .get('/api/settings/cloud/account')
      .set(owner.authHeader);
    assertEqual(registered.status, 200, 'registered cloud account status succeeds');
    assertEqual(registered.body.cloud_account_available, true, 'registered response marks account available');
    assertEqual(registered.body.email, 'owner@example.com', 'registered response preserves account data');
    assert(!('status_token' in registered.body), 'registered response does not expose deletion status token');
    assert(!('unexpected' in registered.body), 'registered response allowlists account fields');
    assertEqual(upstreamCalls, 1, 'registered account status calls FloAdmin');

    globalThis.fetch = (async () => {
      upstreamCalls++;
      throw new Error('simulated cloud outage');
    }) as typeof fetch;
    const unavailableUpstream = await request(app)
      .get('/api/settings/cloud/account')
      .set(owner.authHeader);
    assertEqual(unavailableUpstream.status, 502, 'registered cloud outage remains distinguishable as a gateway error');
    assertEqual(upstreamCalls, 2, 'registered cloud outage attempts the upstream request');

    const results = getResults();
    if (results.failed > 0) throw new Error(`${results.failed} cloud account status assertions failed`);
    console.log('✅ Cloud account status tests passed');
  } finally {
    globalThis.fetch = originalFetch;
    cloudSync.stop();
    try { closeDatabase(); } catch { }
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

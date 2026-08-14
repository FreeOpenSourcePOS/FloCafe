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

    // Stop All disables every cloud feature. Re-enabling the single Cloud
    // Services control must restore the order relay as well as sync.
    setSettings({
      cloud_api_key: 'registered-api-key',
      cloud_pos_hash: 'registered-pos-hash',
      cloud_registration_status: 'registered',
      cloud_services_disabled_by_user: 'true',
      cloud_deletion_request_id: '',
      cloud_deletion_status_token: '',
      cloud_deletion_status: '',
    });
    await cloudSync.stopAllCloudServices();
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    const reenabledCloud = await request(app)
      .put('/api/settings/cloud')
      .set(owner.authHeader)
      .send({ cloud_sync_enabled: true, cloud_orders_enabled: false });
    assertEqual(reenabledCloud.status, 200, 're-enabling Cloud Services succeeds');
    for (const key of ['cloud_sync_enabled', 'cloud_orders_enabled', 'cloud_reports_enabled', 'cloud_command_polling_enabled']) {
      assertEqual((db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string }).value, '1', `${key} is restored when Cloud Services resume`);
    }
    const orderId = Number(db.prepare(`
      INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
      VALUES ('cloud-reenable-order', 'takeaway', 'pending', 10, 10, datetime('now'), datetime('now'))
    `).run().lastInsertRowid);
    cloudSync.recordOrderChanged(orderId);
    await new Promise((resolve) => setImmediate(resolve));
    assert((db.prepare("SELECT COUNT(*) AS count FROM cloud_sync_outbox WHERE entity_type = 'order' AND entity_id = ?").get(String(orderId)) as { count: number }).count > 0, 'order changes enter the cloud outbox after Cloud Services resume');
    cloudSync.stop();

    upstreamCalls = 0;
    setSettings({ cloud_deletion_request_id: 'deletion-id', cloud_deletion_status_token: 'deletion-status-token', cloud_deletion_status: 'pending', cloud_registration_status: 'deletion_pending', cloud_services_disabled_by_user: 'true' });
    let remoteDeletionStatus: 'cancelled' | 'rejected' | 'approved' = 'cancelled';
    globalThis.fetch = (async () => {
      upstreamCalls++;
      return new Response(JSON.stringify({ status: remoteDeletionStatus, request_id: 'deletion-id', status_token: 'new-status-token' }), { status: 200 });
    }) as typeof fetch;
    const cancelledDeletion = await request(app)
      .get('/api/settings/cloud/delete-data/status')
      .set(owner.authHeader);
    assertEqual(cancelledDeletion.status, 200, 'remote cancelled deletion status refresh succeeds');
    assertEqual((db.prepare("SELECT value FROM settings WHERE key = 'cloud_registration_status'").get() as { value: string }).value, 'registered', 'remote cancellation restores registered state');
    assertEqual((db.prepare("SELECT value FROM settings WHERE key = 'cloud_services_disabled_by_user'").get() as { value: string }).value, 'true', 'remote cancellation keeps services stopped');

    setSettings({ cloud_deletion_request_id: 'deletion-id', cloud_deletion_status_token: 'deletion-status-token', cloud_deletion_status: 'pending', cloud_registration_status: 'deletion_pending', cloud_services_disabled_by_user: 'true' });
    remoteDeletionStatus = 'rejected';
    const rejectedDeletion = await request(app)
      .get('/api/settings/cloud/delete-data/status')
      .set(owner.authHeader);
    assertEqual(rejectedDeletion.status, 200, 'remote rejected deletion status refresh succeeds');
    assertEqual((db.prepare("SELECT value FROM settings WHERE key = 'cloud_registration_status'").get() as { value: string }).value, 'registered', 'remote rejection restores registered state');
    assertEqual((db.prepare("SELECT value FROM settings WHERE key = 'cloud_services_disabled_by_user'").get() as { value: string }).value, 'true', 'remote rejection keeps services stopped');

    setSettings({ cloud_deletion_request_id: 'deletion-id', cloud_deletion_status_token: 'deletion-status-token', cloud_deletion_status: 'pending', cloud_registration_status: 'deletion_pending', cloud_services_disabled_by_user: 'true' });
    remoteDeletionStatus = 'approved';
    upstreamCalls = 0;
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

    const service = cloudSync as any;
    service.settings = {
      server_url: 'https://blue.flopos.com/',
      api_key: 'registered-api-key',
      pos_hash: 'registered-pos-hash',
      command_polling_enabled: false,
      sync_enabled: false,
    };
    const originalPreferencesFetch = globalThis.fetch;
    let preferencesFetchStarted!: () => void;
    const preferencesFetchStartedPromise = new Promise<void>((resolve) => { preferencesFetchStarted = resolve; });
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      preferencesFetchStarted();
      const signal = init?.signal as AbortSignal;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })) as typeof fetch;
    try {
      const requestSignal = new AbortController();
      const preferencesRequest = cloudSync.updateEmailPreferences({ product_updates: true }, requestSignal.signal);
      await preferencesFetchStartedPromise;
      requestSignal.abort();
      let preferencesCancelled = false;
      try { await preferencesRequest; } catch { preferencesCancelled = true; }
      assert(preferencesCancelled, 'cloud preference updates honor request cancellation');
    } finally {
      globalThis.fetch = originalPreferencesFetch;
    }

    setSettings({
      cloud_deletion_request_id: 'deletion-id',
      cloud_deletion_status_token: 'deletion-status-token',
      cloud_deletion_status: 'pending',
    });
    const originalDeletionStatusFetch = globalThis.fetch;
    let deletionStatusFetchStarted!: () => void;
    const deletionStatusFetchStartedPromise = new Promise<void>((resolve) => { deletionStatusFetchStarted = resolve; });
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      deletionStatusFetchStarted();
      const signal = init?.signal as AbortSignal;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })) as typeof fetch;
    try {
      const requestSignal = new AbortController();
      const deletionStatusRequest = cloudSync.getDeletionRequestStatus({ allowRemote: true, signal: requestSignal.signal });
      await deletionStatusFetchStartedPromise;
      requestSignal.abort();
      let deletionStatusCancelled = false;
      try { await deletionStatusRequest; } catch { deletionStatusCancelled = true; }
      assert(deletionStatusCancelled, 'cloud account status honors request cancellation');
    } finally {
      globalThis.fetch = originalDeletionStatusFetch;
    }

    setSettings({
      cloud_api_key: 'registered-api-key',
      cloud_pos_hash: 'registered-pos-hash',
      cloud_registration_status: 'registered',
      cloud_services_disabled_by_user: 'false',
      cloud_deletion_status: '',
      cloud_command_polling_enabled: '1',
      cloud_sync_enabled: '0',
    });
    service.settings = {
      server_url: 'https://blue.flopos.com/',
      api_key: 'registered-api-key',
      pos_hash: 'registered-pos-hash',
      command_polling_enabled: true,
      sync_enabled: false,
    };
    const originalPollingFetch = globalThis.fetch;
    let pollingStarted!: () => void;
    const pollingStartedPromise = new Promise<void>((resolve) => { pollingStarted = resolve; });
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      pollingStarted();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        const rejectOnAbort = () => reject(signal.reason || new Error('poll cancelled'));
        if (signal.aborted) rejectOnAbort();
        else signal.addEventListener('abort', rejectOnAbort, { once: true });
      });
    }) as typeof fetch;
    try {
      service.trackCommandPoll(service.pollCommands());
      await pollingStartedPromise;
      const pollingShutdown = cloudSync.shutdown();
      const settled = await Promise.race([
        pollingShutdown.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      assertEqual(settled, true, 'cloud shutdown cancels and awaits an active command poll');
      await pollingShutdown;
    } finally {
      globalThis.fetch = originalPollingFetch;
    }

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

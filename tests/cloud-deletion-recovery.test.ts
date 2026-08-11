import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cloud-deletion-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

import { closeDatabase, getDatabase, initDatabase } from '../main/db';
import { cloudSync } from '../main/services/cloud-sync';

async function run() {
  const originalFetch = globalThis.fetch;
  let deleteMode: 'rejected' | 'accepted' | 'transport' | 'pending-missing' | 'unknown' = 'rejected';
  let statusMode: 'valid' | 'pending-missing' | 'unknown' = 'valid';
  try {
    initDatabase();
    const db = getDatabase();
    const settings = [
      ['cloud_server_url', 'http://127.0.0.1:39999'],
      ['cloud_api_key', 'old-api-key'],
      ['cloud_pos_hash', 'old-pos-hash'],
      ['cloud_device_secret', 'old-device-secret'],
      ['cloud_registration_status', 'registered'],
      ['cloud_sync_enabled', '1'],
      ['cloud_orders_enabled', '1'],
      ['cloud_reports_enabled', '1'],
      ['cloud_command_polling_enabled', '1'],
      ['cloud_services_disabled_by_user', 'false'],
      ['cloud_verification_welcome_requested', '1'],
    ];
    for (const [key, value] of settings) {
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
    }

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/api/cloud-data/deletion-request/status')) {
        if (statusMode === 'pending-missing') return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
        if (statusMode === 'unknown') return new Response(JSON.stringify({ status: 'queued' }), { status: 200 });
        return new Response(JSON.stringify({ status: 'pending', request_id: 'status-id', status_token: 'status-token' }), { status: 200 });
      }
      if (url.endsWith('/api/pos/cloud-data/delete')) {
        if (deleteMode === 'transport') throw new Error('simulated connection drop after upstream accepted the request');
        if (deleteMode === 'accepted') return new Response(JSON.stringify({ status: 'deleted', status_token: 'must-not-leak' }), { status: 200 });
        if (deleteMode === 'pending-missing') return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
        if (deleteMode === 'unknown') return new Response(JSON.stringify({ status: 'queued', request_id: 'queued-id', status_token: 'queued-token' }), { status: 200 });
        return new Response(JSON.stringify({ error: 'simulated upstream failure' }), { status: 503 });
      }
      if (url.endsWith('/api/pos/register')) {
        return new Response(JSON.stringify({ api_key: 'new-api-key', pos_id: 'new-pos', store_id: 'new-store' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await assert.rejects(() => cloudSync.deleteCloudData(), /simulated upstream failure/);
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cloud_deletion_status'").get() as { value: string }).value, 'failed');
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cloud_connected'").get() as { value: string }).value, 'false');
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cloud_services_disabled_by_user'").get() as { value: string }).value, 'true');
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cloud_deletion_outcome'").get() as { value: string }).value, 'rejected');
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cloud_last_error'").get() as { value: string }).value, 'Cloud data deletion failed');
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cloud_deletion_request_id'").get() as { value?: string } | undefined)?.value || '', '');

    // Missing tracking details and unknown statuses become a blocked but
    // retryable local failure rather than silently creating an unrecoverable
    // pending state or removing the safety fence.
    deleteMode = 'pending-missing';
    await assert.rejects(() => cloudSync.deleteCloudData(), /tracking details/);
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cloud_deletion_status'").get() as { value: string }).value, 'failed');
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cloud_deletion_outcome'").get() as { value: string }).value, 'unknown');
    deleteMode = 'unknown';
    await assert.rejects(() => cloudSync.deleteCloudData(), /unknown or missing status/);
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cloud_deletion_status'").get() as { value: string }).value, 'failed');

    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('cloud_deletion_request_id', 'status-id', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('cloud_deletion_status_token', 'status-token', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    statusMode = 'pending-missing';
    const pendingStatus = await cloudSync.getDeletionRequestStatus();
    assert.equal((pendingStatus as any).status, 'pending', 'status lookup may use the locally persisted tracking details');
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cloud_deletion_status'").get() as { value: string }).value, 'pending');
    statusMode = 'unknown';
    await assert.rejects(() => cloudSync.getDeletionRequestStatus(), /unknown or missing status/);
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cloud_deletion_outcome'").get() as { value: string }).value, 'unknown');

    // A failed request remains blocked; retrying the deletion is the safe recovery.
    await assert.rejects(() => cloudSync.register(), /Cloud deletion/);
    await assert.rejects(() => cloudSync.testConnection(), /Cloud deletion is unresolved/);
    // A lost response is indeterminate and must not restart cloud activity.
    deleteMode = 'transport';
    await assert.rejects(() => cloudSync.deleteCloudData(), /simulated connection drop/);
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cloud_deletion_outcome'").get() as { value: string }).value, 'unknown');
    await assert.rejects(() => cloudSync.register(), /Cloud deletion is pending/);

    deleteMode = 'accepted';
    const deletionResult = await cloudSync.deleteCloudData();
    assert.equal((deletionResult as any).status, 'deleted');
    assert.equal(!('status_token' in (deletionResult as any)), true, 'cloud deletion result does not expose the status token');
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cloud_deletion_status'").get() as { value: string }).value, 'deleted');
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cloud_api_key'").get() as { value: string }).value, '');
    console.log('✅ Cloud deletion failure recovery tests passed');
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

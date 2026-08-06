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
      if (url.endsWith('/api/pos/cloud-data/delete')) {
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
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cloud_deletion_request_id'").get() as { value?: string } | undefined)?.value || '', '');

    // A failed request must not permanently strand explicit re-registration.
    const registered = await cloudSync.register();
    assert.equal((registered as any).cloud_registration_status, 'registered');
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'cloud_api_key'").get() as { value: string }).value, 'new-api-key');
    console.log('✅ Cloud deletion failure recovery tests passed');
  } finally {
    globalThis.fetch = originalFetch;
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

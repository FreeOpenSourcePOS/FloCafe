/** Behavioral coverage for issues #245 and #246: add-on validation and identity preservation. */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-addon-groups-245-246-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  api,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { addonGroupRoutes } = require('../main/routes/addon-groups');

async function main() {
  console.log('Integration Test: Issues #245/#246 add-on group invariants');
  console.log('='.repeat(62));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  const app = createApp({ '/api/addon-groups': addonGroupRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n─── Server-side validation ───');
    let res = await api(baseUrl, '/api/addon-groups', {
      method: 'POST',
      headers: authHeader,
      body: {
        name: 'Invalid Addons',
        min_selection: 0,
        max_selection: 1,
        addons: [{ name: '   ', price: -1 }],
      },
    });
    assertEqual(res.status, 400, 'blank add-on names and negative prices are rejected');
    assert(res.data.errors['addons.0.name'], 'blank add-on name has a field error');
    assert(res.data.errors['addons.0.price'], 'negative add-on price has a field error');

    res = await api(baseUrl, '/api/addon-groups', {
      method: 'POST',
      headers: authHeader,
      body: {
        name: 'Numeric Inactive Bounds',
        min_selection: 1,
        max_selection: 1,
        addons: [{ name: 'Inactive Numeric Zero', price: 0, is_active: 0 }],
      },
    });
    assertEqual(res.status, 400, 'numeric is_active: 0 is treated as inactive for selection bounds');

    res = await api(baseUrl, '/api/addon-groups', {
      method: 'POST',
      headers: authHeader,
      body: {
        name: 'Bulk Active State',
        min_selection: 0,
        max_selection: 2,
        addons: [
          { name: 'Shown', price: 1, is_active: true },
          { name: 'Hidden', price: 2, is_active: 0 },
        ],
      },
    });
    assertEqual(res.status, 201, 'valid add-on group is created');
    const bulkGroupId = res.data.addon_group.id;
    const hidden = db.prepare('SELECT is_active FROM addons WHERE addon_group_id = ? AND name = ?').get(bulkGroupId, 'Hidden') as any;
    assertEqual(hidden.is_active, 0, 'bulk create persists submitted inactive child state');

    console.log('\n─── Group edits preserve add-on identities ───');
    const createdAt = '2026-08-09 10:00:00';
    db.prepare(`
      INSERT INTO addon_groups (id, name, min_selection, max_selection, is_active, created_at, updated_at)
      VALUES (?, ?, 1, 2, 1, ?, ?)
    `).run('group-246', 'Stable Extras', createdAt, createdAt);
    db.prepare(`
      INSERT INTO addons (id, addon_group_id, name, price, is_active, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 0, ?, ?)
    `).run('addon-246-keep', 'group-246', 'Old Name', 5, createdAt, createdAt);
    db.prepare(`
      INSERT INTO addons (id, addon_group_id, name, price, is_active, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 1, ?, ?)
    `).run('addon-246-omit', 'group-246', 'Omitted', 7, now(), now());

    res = await api(baseUrl, '/api/addon-groups/group-246', {
      method: 'PUT',
      headers: authHeader,
      body: {
        name: 'Stable Extras Updated',
        addons: [
          { id: 'addon-246-keep', name: 'New Name', price: 6, is_active: true },
          { name: 'Brand New', price: 8, is_active: true },
        ],
      },
    });
    assertEqual(res.status, 200, 'bulk group edit succeeds');
    const kept = db.prepare('SELECT id, name, price, created_at, is_active FROM addons WHERE id = ?').get('addon-246-keep') as any;
    assertEqual(kept.name, 'New Name', 'existing add-on row is updated in place');
    assertEqual(kept.price, 6, 'existing add-on price is updated');
    assertEqual(kept.created_at, createdAt, 'existing add-on created_at is preserved');
    assertEqual(kept.is_active, 1, 'existing add-on stays active');
    const omitted = db.prepare('SELECT is_active FROM addons WHERE id = ?').get('addon-246-omit') as any;
    assertEqual(omitted.is_active, 0, 'omitted child is soft-deactivated instead of deleted');
    const newAddon = db.prepare('SELECT id FROM addons WHERE addon_group_id = ? AND name = ?').get('group-246', 'Brand New') as any;
    assert(Boolean(newAddon?.id), 'new child is inserted when no id is supplied');

    res = await api(baseUrl, '/api/addon-groups/group-246', {
      method: 'PUT',
      headers: authHeader,
      body: { addons: [{ id: 'missing-addon', name: 'Nope', price: 1 }] },
    });
    assertEqual(res.status, 400, 'bulk group edit rejects foreign or unknown child ids');

    console.log('\n─── Inactive group child policy ───');
    db.prepare('UPDATE addon_groups SET is_active = 0 WHERE id = ?').run('group-246');
    res = await api(baseUrl, '/api/addon-groups/group-246/addons', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Should Not Mutate', price: 1 },
    });
    assertEqual(res.status, 400, 'child create is rejected for inactive groups');
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(62));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

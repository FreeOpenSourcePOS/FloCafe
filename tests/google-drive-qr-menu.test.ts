import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-qr-menu-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString('utf8'),
      },
      shell: { openExternal: async () => {} },
    };
  return originalLoad.apply(this, arguments as any);
};

const dbModule = require('../main/db');
const driveModule = require('../main/services/google-drive');

async function main(): Promise<void> {
  console.log('🧪 Google Drive QR Menu Tests');
  dbModule.initDatabase();
  const db = dbModule.getDatabase();
  const set = db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  set.run('business_name', 'Sunrise Cafe', dbModule.now());

  const invalidCode = (code: string) => (error: unknown) =>
    (error as { code?: string })?.code === code;
  await assert.rejects(
    driveModule.googleDrive.publishQrMenuPdf({ pdfBuffer: Buffer.alloc(0), source: 'uploaded' }),
    invalidCode('menu_pdf_invalid'),
  );
  await assert.rejects(
    driveModule.googleDrive.publishQrMenuPdf({
      pdfBuffer: Buffer.from('not-pdf'),
      source: 'uploaded',
    }),
    invalidCode('menu_pdf_invalid'),
  );
  await assert.rejects(
    driveModule.googleDrive.publishQrMenuPdf({
      pdfBuffer: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(15 * 1024 * 1024)]),
      source: 'uploaded',
    }),
    invalidCode('menu_pdf_too_large'),
  );
  console.log('   ✓ custom PDF magic header and 15 MB cap fail before Drive access');

  const service = driveModule.googleDrive as any;
  service.getAuthorizedClient = async () => ({});
  const files = new Map<string, any>();
  const permissions = new Map<string, Array<{ id: string; type: string; role: string }>>();
  const calls = {
    creates: [] as any[],
    updates: [] as any[],
    permissionCreates: [] as any[],
    permissionDeletes: [] as any[],
  };
  const fakeDrive = {
    files: {
      list: async () => ({ data: { files: [] } }),
      get: async ({ fileId }: { fileId: string }) => ({ data: files.get(fileId) }),
      create: async (request: any) => {
        calls.creates.push(request);
        if (request.requestBody.mimeType === 'application/vnd.google-apps.folder') {
          const folder = {
            id: 'menu-folder',
            mimeType: request.requestBody.mimeType,
            trashed: false,
            capabilities: { canAddChildren: true },
            appProperties: request.requestBody.appProperties,
          };
          files.set(folder.id, folder);
          return { data: folder };
        }
        const file = {
          id: 'menu-file',
          mimeType: 'application/pdf',
          trashed: false,
          parents: request.requestBody.parents,
          appProperties: request.requestBody.appProperties,
          name: request.requestBody.name,
        };
        files.set(file.id, file);
        return { data: file };
      },
      update: async (request: any) => {
        calls.updates.push(request);
        const current = files.get(request.fileId);
        files.set(request.fileId, {
          ...current,
          name: request.requestBody.name,
          appProperties: request.requestBody.appProperties,
        });
        return { data: files.get(request.fileId) };
      },
    },
    permissions: {
      list: async ({ fileId }: { fileId: string }) => ({
        data: { permissions: permissions.get(fileId) || [] },
      }),
      create: async (request: any) => {
        calls.permissionCreates.push(request);
        const permission = { id: 'anyone-reader', ...request.requestBody };
        permissions.set(request.fileId, [permission]);
        return { data: permission };
      },
      delete: async (request: any) => {
        calls.permissionDeletes.push(request);
        permissions.set(request.fileId, []);
        return { data: {} };
      },
    },
  };
  driveModule.setQrMenuDriveClientFactoryForTests(() => fakeDrive);

  const prefs = {
    template: 'mobile-cafe',
    pageSize: 'A4',
    includeDescriptions: true,
    includeModifiers: true,
    includePhotos: false,
    includeOutOfStock: false,
    includeInactive: false,
    includeHidden: false,
  };
  const first = await service.publishQrMenuPdf({
    pdfBuffer: Buffer.from('%PDF-test'),
    source: 'generated',
    generatorPrefs: prefs,
  });
  assert.equal(first.file_id, 'menu-file');
  assert.equal(first.sharing_enabled, true);
  assert.match(first.file_name, /^Sunrise Cafe - Menu \([a-z0-9]{6}\)\.pdf$/);
  assert.equal(calls.permissionCreates.length, 1);
  assert.equal(calls.permissionCreates[0].fileId, 'menu-file');
  assert.equal(
    calls.creates.filter(
      (call) => call.requestBody.mimeType === 'application/vnd.google-apps.folder',
    ).length,
    1,
  );
  assert.equal(
    calls.permissionCreates.some((call) => call.fileId === 'menu-folder'),
    false,
    'folder is never shared',
  );
  console.log('   ✓ first publish creates an isolated menu folder and shares only the PDF');

  const firstLink = first.web_view_link;
  const shortId = db
    .prepare("SELECT value FROM settings WHERE key = 'google_drive_menu_short_id'")
    .get().value;
  set.run('business_name', 'Renamed Cafe', dbModule.now());
  const second = await service.publishQrMenuPdf({
    pdfBuffer: Buffer.from('%PDF-replacement'),
    source: 'uploaded',
  });
  assert.equal(second.file_id, 'menu-file');
  assert.equal(second.web_view_link, firstLink);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].fileId, 'menu-file');
  assert.equal(second.file_name, `Renamed Cafe - Menu (${shortId}).pdf`);
  console.log(
    '   ✓ generated/custom replacements and store renames preserve the same file ID and URL',
  );

  const paused = await service.setQrMenuSharing(false);
  assert.equal(paused.file_id, 'menu-file');
  assert.equal(paused.sharing_enabled, false);
  assert.equal(calls.permissionDeletes[0].fileId, 'menu-file');
  const resumed = await service.setQrMenuSharing(true);
  assert.equal(resumed.file_id, 'menu-file');
  assert.equal(resumed.sharing_enabled, true);
  assert.equal(calls.permissionCreates.at(-1).fileId, 'menu-file');
  console.log('   ✓ pause/resume changes file permission without changing the file ID');

  files.set('menu-file', { ...files.get('menu-file'), mimeType: 'application/x-sqlite3' });
  const updatesBeforeGuard = calls.updates.length;
  const permissionsBeforeGuard = calls.permissionCreates.length;
  await assert.rejects(
    service.publishQrMenuPdf({ pdfBuffer: Buffer.from('%PDF-guard'), source: 'uploaded' }),
    invalidCode('menu_file_invalid'),
  );
  assert.equal(calls.updates.length, updatesBeforeGuard);
  assert.equal(calls.permissionCreates.length, permissionsBeforeGuard);
  console.log('   ✓ preflight refuses invalid stored file bindings before overwrite or sharing');

  const backupCandidate = await service.findExistingAppFolder(
    {
      files: {
        list: async () => ({
          data: {
            files: [
              {
                id: 'menu-folder',
                capabilities: { canAddChildren: true },
                appProperties: { flo_destination_kind: 'flocafe_menu' },
              },
              {
                id: 'backup-folder',
                capabilities: { canAddChildren: true },
                appProperties: { flo_destination_kind: 'flocafe' },
              },
            ],
          },
        }),
      },
    },
    service.ensureInstallationMarker(),
    new AbortController().signal,
  );
  assert.equal(backupCandidate.id, 'backup-folder');
  console.log('   ✓ backup discovery ignores the dedicated QR menu folder');

  for (const key of dbModule.GOOGLE_DRIVE_PRIVATE_SETTING_KEYS)
    if (key.startsWith('google_drive_menu_')) set.run(key, 'stale', dbModule.now());
  dbModule.clearGoogleDriveRestoreBinding();
  const remainingPrivateMenuKeys = db
    .prepare(
      "SELECT key FROM settings WHERE key LIKE 'google_drive_menu_%' AND key != 'google_drive_menu_short_id' AND key != 'google_drive_menu_generator_prefs'",
    )
    .all();
  assert.deepEqual(remainingPrivateMenuKeys, []);
  console.log('   ✓ database restore cleanup removes every Drive-bound menu setting');

  driveModule.setQrMenuDriveClientFactoryForTests(null);
  dbModule.closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

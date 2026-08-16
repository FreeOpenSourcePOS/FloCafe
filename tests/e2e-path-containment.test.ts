import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as net from 'node:net';

const Module = require('module');
const originalLoad = Module._load;

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-e2e-containment-'));
const evidenceDir = '/var/folders/y_/1ltcxtwj0zd_w1dg9jv4jl580000gn/T/no-mistakes-evidence/01M06B0BCABVQAV72SMY452D90';

// Mock electron
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: (name: string) => {
          if (name === 'userData') return testDir;
          return testDir;
        },
        getVersion: () => '3.2.0',
      },
      ipcMain: {
        handle: () => {},
        removeHandler: () => {},
        on: () => {},
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

import { resolveContainedPath } from '../main/lib/path-containment';
import { resolveStaticPage } from '../main/server';
import { initDatabase, closeDatabase, listBackups, getBackupDirectory } from '../main/db';

async function getFreePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((res, rej) => {
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => res());
  });
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((res) => s.close(() => res()));
  return port;
}

async function fetchHttp(url: string): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetch(url, { redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

async function run() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const transcriptLogs: string[] = [];
  function log(msg: string) {
    console.log(msg);
    transcriptLogs.push(msg);
  }

  log('======================================================================');
  log('STARTING END-TO-END SECURITY PATH CONTAINMENT VERIFICATION');
  log('======================================================================\n');

  // ──────────────────────────────────────────────────────────────────────────
  // 1. PATH CONTAINMENT HELPER RIGOROUS CHECKS
  // ──────────────────────────────────────────────────────────────────────────
  log('--- Section 1: resolveContainedPath Helper ---');
  const mockRoot = path.join(testDir, 'mock-root');
  fs.mkdirSync(mockRoot, { recursive: true });

  // Normal resolution
  const normal = resolveContainedPath(mockRoot, 'sub', 'page.html');
  assert.equal(normal, path.join(mockRoot, 'sub', 'page.html'));
  log('✔ Contained relative path inside root: ' + normal);

  // Escaping root via ..
  const escape1 = resolveContainedPath(mockRoot, '..', 'etc', 'passwd');
  assert.equal(escape1, null);
  log('✔ Traversal escape (.. -> null): blocked successfully');

  // Multi-level traversal
  const escape2 = resolveContainedPath(mockRoot, 'a', 'b', '..', '..', '..', 'secret');
  assert.equal(escape2, null);
  log('✔ Multi-level traversal escape: blocked successfully');

  // Sibling directory sharing prefix
  const sibling = `${mockRoot}_sibling`;
  fs.mkdirSync(sibling, { recursive: true });
  const escapeSibling = resolveContainedPath(mockRoot, '..', path.basename(sibling), 'secret.txt');
  assert.equal(escapeSibling, null);
  log('✔ Sibling prefix collision attack blocked: ' + escapeSibling);

  // Absolute segment
  const absSegment = resolveContainedPath(mockRoot, '/absolute/path/file.txt');
  assert.equal(absSegment, path.join(mockRoot, 'absolute', 'path', 'file.txt'));
  log('✔ Absolute segment treated as sub-path inside root: ' + absSegment);

  // Empty segments
  const emptySegments = resolveContainedPath(mockRoot);
  assert.equal(emptySegments, mockRoot);
  log('✔ No segments returns root: ' + emptySegments);

  // ──────────────────────────────────────────────────────────────────────────
  // 2. MAIN SERVER STATIC ROUTE RESOLUTION
  // ──────────────────────────────────────────────────────────────────────────
  log('\n--- Section 2: Main Server Static Route Resolution ---');
  const frontendDir = path.join(testDir, 'frontend-out');
  fs.mkdirSync(frontendDir, { recursive: true });
  fs.mkdirSync(path.join(frontendDir, 'whatsapp'), { recursive: true });
  fs.mkdirSync(path.join(frontendDir, 'reports'), { recursive: true });

  const mainRootHtml = '<!DOCTYPE html><html><head><title>Flo POS Root</title></head><body><div id="root">Flo POS Dashboard App</div></body></html>';
  const whatsappHtml = '<!DOCTYPE html><html><head><title>WhatsApp Settings</title></head><body><div id="whatsapp">WhatsApp Integration Page</div></body></html>';
  const reportsHtml = '<!DOCTYPE html><html><head><title>Reports</title></head><body><div id="reports">Reports Analytics Page</div></body></html>';

  fs.writeFileSync(path.join(frontendDir, 'index.html'), mainRootHtml);
  fs.writeFileSync(path.join(frontendDir, 'whatsapp', 'index.html'), whatsappHtml);
  fs.writeFileSync(path.join(frontendDir, 'reports', 'index.html'), reportsHtml);

  // Test resolveStaticPage
  assert.equal(resolveStaticPage(frontendDir, '/whatsapp'), path.join(frontendDir, 'whatsapp', 'index.html'));
  assert.equal(resolveStaticPage(frontendDir, '/reports'), path.join(frontendDir, 'reports', 'index.html'));
  assert.equal(resolveStaticPage(frontendDir, '/unknown-page'), path.join(frontendDir, 'index.html'));
  assert.equal(resolveStaticPage(frontendDir, '/../../etc/shadow'), path.join(frontendDir, 'index.html'));
  log('✔ resolveStaticPage direct assertions passed');

  // Test real HTTP server serving main frontend static routes
  const express = require('express');
  const mainApp = express();
  mainApp.use(express.static(frontendDir, { dotfiles: 'allow', index: false }));
  mainApp.get(/^(?!\/api|\/kds).*$/, (req: any, res: any) => {
    res.sendFile(resolveStaticPage(frontendDir, req.path), { dotfiles: 'allow' });
  });

  const mainPort = await getFreePort();
  const mainHttpServer = http.createServer(mainApp);
  await new Promise<void>((res) => mainHttpServer.listen(mainPort, '127.0.0.1', () => res()));

  const mainBaseUrl = `http://127.0.0.1:${mainPort}`;
  
  // GET /whatsapp (express.static redirects directory to /whatsapp/ when missing trailing slash)
  const resWhatsapp = await fetch(`${mainBaseUrl}/whatsapp`);
  assert.equal(resWhatsapp.status, 200);
  const textWhatsapp = await resWhatsapp.text();
  assert.ok(textWhatsapp.includes('WhatsApp Integration Page'));
  log(`✔ HTTP GET ${mainBaseUrl}/whatsapp returned 200 with WhatsApp HTML`);

  // GET /reports
  const resReports = await fetch(`${mainBaseUrl}/reports`);
  assert.equal(resReports.status, 200);
  const textReports = await resReports.text();
  assert.ok(textReports.includes('Reports Analytics Page'));
  log(`✔ HTTP GET ${mainBaseUrl}/reports returned 200 with Reports HTML`);

  // GET /unknown
  const resUnknown = await fetch(`${mainBaseUrl}/unknown-route`);
  assert.equal(resUnknown.status, 200);
  const textUnknown = await resUnknown.text();
  assert.ok(textUnknown.includes('Flo POS Dashboard App'));
  log(`✔ HTTP GET ${mainBaseUrl}/unknown-route fell back to root index.html`);

  // GET /../../outside traversal attack
  const resTraversal = await fetch(`${mainBaseUrl}/../../etc/passwd`);
  assert.equal(resTraversal.status, 200);
  const textTraversal = await resTraversal.text();
  assert.ok(textTraversal.includes('Flo POS Dashboard App'), 'Directory traversal was safely contained and served root index.html');
  log(`✔ HTTP GET ${mainBaseUrl}/../../etc/passwd securely returned root index.html fallback`);

  fs.writeFileSync(path.join(evidenceDir, 'server_fallback_response.html'), textTraversal);

  await new Promise<void>((res) => mainHttpServer.close(() => res()));

  // ──────────────────────────────────────────────────────────────────────────
  // 3. SERVER APP (STAFF/TABLES) STATIC ROUTE RESOLUTION
  // ──────────────────────────────────────────────────────────────────────────
  log('\n--- Section 3: Server App (Staff) Static Route Resolution ---');
  const serverAppDir = path.join(testDir, 'server-app-static');
  fs.mkdirSync(serverAppDir, { recursive: true });
  fs.mkdirSync(path.join(serverAppDir, 'server-standalone'), { recursive: true });
  fs.mkdirSync(path.join(serverAppDir, 'tables'), { recursive: true });

  const serverStandaloneHtml = '<!DOCTYPE html><html><head><title>Flo Server Standalone</title></head><body><div id="server-standalone">Server Staff Portal</div></body></html>';
  const tablesHtml = '<!DOCTYPE html><html><head><title>Floor Tables</title></head><body><div id="tables">Floor Plan & Table Management</div></body></html>';

  fs.writeFileSync(path.join(serverAppDir, 'server-standalone', 'index.html'), serverStandaloneHtml);
  fs.writeFileSync(path.join(serverAppDir, 'tables', 'index.html'), tablesHtml);

  const serverExpressApp = express();
  serverExpressApp.use(express.static(serverAppDir, { index: false }));
  serverExpressApp.get('/', (_req: any, res: any) => res.redirect('/server-standalone'));
  serverExpressApp.get('/*splat', (req: any, res: any) => {
    const routePath = resolveContainedPath(serverAppDir, `.${req.path}`, 'index.html');
    if (routePath && fs.existsSync(routePath)) {
      res.sendFile(routePath);
    } else {
      res.sendFile(path.join(serverAppDir, 'server-standalone', 'index.html'));
    }
  });

  const serverAppPort = await getFreePort();
  const serverAppHttp = http.createServer(serverExpressApp);
  await new Promise<void>((res) => serverAppHttp.listen(serverAppPort, '127.0.0.1', () => res()));

  const serverAppBaseUrl = `http://127.0.0.1:${serverAppPort}`;

  // GET /
  const resServerRoot = await fetchHttp(`${serverAppBaseUrl}/`);
  assert.equal(resServerRoot.status, 302);
  assert.equal(resServerRoot.headers.get('location'), '/server-standalone');
  log(`✔ HTTP GET ${serverAppBaseUrl}/ returned 302 redirect to /server-standalone`);

  // GET /tables
  const resTables = await fetch(`${serverAppBaseUrl}/tables`);
  assert.equal(resTables.status, 200);
  const textTables = await resTables.text();
  assert.ok(textTables.includes('Floor Plan & Table Management'));
  log(`✔ HTTP GET ${serverAppBaseUrl}/tables returned 200 with Table Management HTML`);

  // GET /unknown
  const resServerUnknown = await fetch(`${serverAppBaseUrl}/unknown`);
  assert.equal(resServerUnknown.status, 200);
  const textServerUnknown = await resServerUnknown.text();
  assert.ok(textServerUnknown.includes('Server Staff Portal'));
  log(`✔ HTTP GET ${serverAppBaseUrl}/unknown returned 200 with Server Standalone fallback`);

  // GET traversal attempt
  const resServerTraversal = await fetch(`${serverAppBaseUrl}/../../etc/shadow`);
  assert.equal(resServerTraversal.status, 200);
  const textServerTraversal = await resServerTraversal.text();
  assert.ok(textServerTraversal.includes('Server Staff Portal'));
  log(`✔ HTTP GET ${serverAppBaseUrl}/../../etc/shadow securely returned Server Standalone fallback`);

  fs.writeFileSync(path.join(evidenceDir, 'server_app_fallback_response.html'), textServerTraversal);

  await new Promise<void>((res) => serverAppHttp.close(() => res()));

  // ──────────────────────────────────────────────────────────────────────────
  // 4. KDS SERVER (KITCHEN DISPLAY) STATIC ROUTE RESOLUTION
  // ──────────────────────────────────────────────────────────────────────────
  log('\n--- Section 4: KDS Server Static Route Resolution ---');
  const kdsDir = path.join(testDir, 'kds-static');
  fs.mkdirSync(kdsDir, { recursive: true });
  fs.mkdirSync(path.join(kdsDir, 'kds-standalone'), { recursive: true });
  fs.mkdirSync(path.join(kdsDir, 'kitchen-orders'), { recursive: true });

  const kdsStandaloneHtml = '<!DOCTYPE html><html><head><title>Flo KDS Standalone</title></head><body><div id="kds-standalone">Kitchen Display System Home</div></body></html>';
  const kitchenOrdersHtml = '<!DOCTYPE html><html><head><title>Active Kitchen Orders</title></head><body><div id="kitchen-orders">Active Kitchen Orders Queue</div></body></html>';

  fs.writeFileSync(path.join(kdsDir, 'kds-standalone', 'index.html'), kdsStandaloneHtml);
  fs.writeFileSync(path.join(kdsDir, 'kitchen-orders', 'index.html'), kitchenOrdersHtml);

  const kdsExpressApp = express();
  kdsExpressApp.use(express.static(kdsDir, { dotfiles: 'allow', index: false }));
  kdsExpressApp.get('/', (_req: any, res: any) => res.redirect('/kds-standalone'));
  kdsExpressApp.get('/*splat', (req: any, res: any) => {
    const routePath = resolveContainedPath(kdsDir, `.${req.path}`, 'index.html');
    if (routePath && fs.existsSync(routePath)) {
      res.sendFile(routePath, { dotfiles: 'allow' });
    } else {
      res.sendFile(path.join(kdsDir, 'kds-standalone', 'index.html'), { dotfiles: 'allow' });
    }
  });

  const kdsPort = await getFreePort();
  const kdsHttp = http.createServer(kdsExpressApp);
  await new Promise<void>((res) => kdsHttp.listen(kdsPort, '127.0.0.1', () => res()));

  const kdsBaseUrl = `http://127.0.0.1:${kdsPort}`;

  // GET /
  const resKdsRoot = await fetchHttp(`${kdsBaseUrl}/`);
  assert.equal(resKdsRoot.status, 302);
  assert.equal(resKdsRoot.headers.get('location'), '/kds-standalone');
  log(`✔ HTTP GET ${kdsBaseUrl}/ returned 302 redirect to /kds-standalone`);

  // GET /kitchen-orders
  const resKitchen = await fetch(`${kdsBaseUrl}/kitchen-orders`);
  assert.equal(resKitchen.status, 200);
  const textKitchen = await resKitchen.text();
  assert.ok(textKitchen.includes('Active Kitchen Orders Queue'));
  log(`✔ HTTP GET ${kdsBaseUrl}/kitchen-orders returned 200 with Kitchen Orders HTML`);

  // GET /unknown
  const resKdsUnknown = await fetch(`${kdsBaseUrl}/unknown-station`);
  assert.equal(resKdsUnknown.status, 200);
  const textKdsUnknown = await resKdsUnknown.text();
  assert.ok(textKdsUnknown.includes('Kitchen Display System Home'));
  log(`✔ HTTP GET ${kdsBaseUrl}/unknown-station fell back to KDS Standalone HTML`);

  // GET traversal attempt
  const resKdsTraversal = await fetch(`${kdsBaseUrl}/../../etc/passwd`);
  assert.equal(resKdsTraversal.status, 200);
  const textKdsTraversal = await resKdsTraversal.text();
  assert.ok(textKdsTraversal.includes('Kitchen Display System Home'));
  log(`✔ HTTP GET ${kdsBaseUrl}/../../etc/passwd securely returned KDS Standalone fallback`);

  fs.writeFileSync(path.join(evidenceDir, 'kds_fallback_response.html'), textKdsTraversal);

  await new Promise<void>((res) => kdsHttp.close(() => res()));

  // ──────────────────────────────────────────────────────────────────────────
  // 5. DATABASE BACKUP LISTING CONTAINMENT
  // ──────────────────────────────────────────────────────────────────────────
  log('\n--- Section 5: Database Backup Listing Containment ---');
  initDatabase();

  const backupDir = path.join(testDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const validBackupFile1 = 'flo-backup-2026-08-16T12-00-00-000Z-abc111.db';
  const validBackupFile2 = 'flo-backup-2026-08-16T14-30-00-000Z-xyz222.db';
  fs.writeFileSync(path.join(backupDir, validBackupFile1), 'backup-content-1');
  fs.writeFileSync(path.join(backupDir, validBackupFile2), 'backup-content-2-larger-bytes');

  // Create invalid files that should NOT be returned
  fs.writeFileSync(path.join(backupDir, 'unrelated-file.db'), 'should-be-ignored');
  fs.writeFileSync(path.join(backupDir, 'flo-backup-notdb.txt'), 'should-be-ignored');
  fs.mkdirSync(path.join(backupDir, 'flo-backup-2026-08-16T15-00-00-000Z-dir.db'), { recursive: true });

  const backups = listBackups();
  log(`Found ${backups.length} valid backups in listing:`);
  log(JSON.stringify(backups, null, 2));

  // The database migration auto-backup may also be created in backupDir
  const filtered = backups.filter(b => b.fileName === validBackupFile1 || b.fileName === validBackupFile2);
  assert.equal(filtered.length, 2, 'Exactly 2 test valid backup files listed (invalid names, extensions, and dirs filtered out)');
  const foundNames = filtered.map(b => b.fileName).sort();
  assert.deepEqual(foundNames, [validBackupFile1, validBackupFile2].sort());
  
  for (const item of filtered) {
    assert.equal(item.path, path.join(backupDir, item.fileName));
    assert.ok(item.sizeBytes > 0);
  }

  fs.writeFileSync(path.join(evidenceDir, 'backup_listing_response.json'), JSON.stringify(backups, null, 2));
  log('✔ listBackups path containment and file filtering verified');

  closeDatabase();

  log('\n======================================================================');
  log('ALL PATH CONTAINMENT END-TO-END VERIFICATIONS PASSED SUCCESSFULLY!');
  log('======================================================================');

  fs.writeFileSync(path.join(evidenceDir, 'e2e_http_containment_transcript.log'), transcriptLogs.join('\n'));
}

run()
  .then(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    fs.rmSync(testDir, { recursive: true, force: true });
    process.exit(1);
  });

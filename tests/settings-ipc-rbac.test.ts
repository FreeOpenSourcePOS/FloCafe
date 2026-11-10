/**
 * Settings & Update IPC RBAC Tests
 *
 * Verifies defense-in-depth authorization across Electron IPC write channels:
 *   - `set-setting` (`theme_mode`, `orders_layout`) in `main/ipc.ts`
 *   - `updates:set-auto-check` and `updates:set-beta-channel` in `main/update-ipc.ts`
 *   - `main/preload.ts` renderer token forwarding when `window.localStorage` holds a JWT
 *
 * Run: npm run test:settings-ipc-rbac
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import jwt from 'jsonwebtoken';

const Module = require('module');
const originalLoad = Module._load;

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-settings-ipc-rbac-'));
process.env.JWT_SECRET = 'ipc-rbac-unit-test-secret';

const registered = new Map<string, (...args: unknown[]) => unknown>();
const mockApp = {
  isPackaged: true,
  getPath: () => testDir,
  getName: () => 'FloCafe',
  getVersion: () => '0.0.0-test',
};
const mainFrame = { frameToken: 'frame-main', detached: false, url: 'http://localhost:3001/' };

class MockBrowserWindow {
  loadURL() {}
  on() {}
  isDestroyed() {
    return false;
  }
  setBackgroundColor() {}
  webContents = { send: () => {}, on: () => {}, mainFrame };
  static fromWebContents(sender: { ownerWindow?: MockBrowserWindow | null } | null | undefined) {
    return sender?.ownerWindow ?? null;
  }
}

const mainWin = new MockBrowserWindow();

function makeSenderEvent(_storageToken?: unknown) {
  return {
    sender: {
      ownerWindow: mainWin,
      mainFrame,
      getURL: () => 'http://localhost:3001/',
    },
    senderFrame: mainFrame,
  };
}

const preloadCalls: Array<{ channel: string; args: unknown[] }> = [];
let exposedPreloadApi: Record<string, (...args: unknown[]) => Promise<unknown>> | undefined;
let testingPreload = true;
let staleHelper:
  | ((iat: number | undefined, tokensValidAfter: string | null | undefined) => boolean)
  | undefined;

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    if (testingPreload) {
      return {
        contextBridge: {
          exposeInMainWorld: (
            _name: string,
            api: Record<string, (...args: unknown[]) => Promise<unknown>>,
          ) => {
            exposedPreloadApi = api;
          },
        },
        ipcRenderer: {
          sendSync: () => ({ success: true }),
          invoke: (channel: string, ...args: unknown[]) => {
            preloadCalls.push({ channel, args });
            return Promise.resolve({ success: true });
          },
          on: () => {},
          removeListener: () => {},
        },
      };
    }
    return {
      app: mockApp,
      ipcMain: {
        on: () => {},
        handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
          registered.set(channel, listener);
        },
      },
      dialog: {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showMessageBox: async () => ({ response: 1 }),
      },
      BrowserWindow: MockBrowserWindow,
    };
  }
  if (request === './middleware/security' || request === '../middleware/security') {
    return {
      clearInMemoryRevokedTokens: () => {},
      clearUserAuthCache: () => {},
      isTokenStale: (iat: number | undefined, tokensValidAfter: string | null | undefined) =>
        staleHelper ? staleHelper(iat, tokensValidAfter) : false,
    };
  }
  if (request === './server') return { getLocalIP: () => '127.0.0.1' };
  if (request === './kds-server') return { getKdsPort: () => 3002 };
  if (request === './services/master-pin') {
    return {
      authorizeMasterPin: () => ({ ok: false, error: 'Invalid master PIN' }),
      isMasterPinAvailable: () => true,
      isMasterPinSet: () => true,
    };
  }
  if (request === './services/schema-health') {
    return {
      runHealthCheck: () => ({ status: 'healthy', findings: [] }),
      applySafeFixes: () => ({ applied: [], skipped: [], errors: [] }),
    };
  }
  if (request === './services/whatsapp') return { getStatus: () => ({ connected: false }) };
  if (request === './window-options') {
    return { createKdsWindow: () => ({}), applyWindowControlAction: () => ({ success: true }) };
  }
  return originalLoad.apply(this, [request, parent, isMain]);
};

// 1. Preload forwards token from window.localStorage when available
{
  const globalWithWindow = globalThis as {
    window?: { localStorage?: { getItem: (key: string) => string | null } };
  };
  let currentBrowserToken: string | null = 'preload-test-jwt';
  globalWithWindow.window = {
    localStorage: {
      getItem: (key: string) => (key === 'token' ? currentBrowserToken : null),
    },
  };
  try {
    require('../main/preload');
    assert.ok(exposedPreloadApi, 'preload must expose electronAPI');

    exposedPreloadApi.setSetting('theme_mode', 'dark');
    exposedPreloadApi.setBetaChannel(true);
    exposedPreloadApi.setAutoUpdateCheck(false);
    assert.deepEqual(preloadCalls, [
      { channel: 'set-setting', args: ['theme_mode', 'dark', 'preload-test-jwt'] },
      { channel: 'updates:set-beta-channel', args: [true, 'preload-test-jwt'] },
      { channel: 'updates:set-auto-check', args: [false, 'preload-test-jwt'] },
    ]);

    currentBrowserToken = null;
    preloadCalls.length = 0;
    exposedPreloadApi.setSetting('theme_mode', 'light');
    exposedPreloadApi.setBetaChannel(false);
    exposedPreloadApi.setAutoUpdateCheck(true);
    assert.deepEqual(preloadCalls, [
      { channel: 'set-setting', args: ['theme_mode', 'light'] },
      { channel: 'updates:set-beta-channel', args: [false] },
      { channel: 'updates:set-auto-check', args: [true] },
    ]);
  } finally {
    testingPreload = false;
    delete globalWithWindow.window;
    try {
      delete require.cache[require.resolve('electron')];
    } catch {}
  }
}

const { isTokenStale } = require('../main/middleware/security');
staleHelper = isTokenStale;

function mintToken(userId: string, role: string, iatOffsetSeconds = 0): string {
  const iat = Math.floor(Date.now() / 1000) + iatOffsetSeconds;
  return jwt.sign(
    { userId, email: `${userId}@flo.local`, role, iat, exp: iat + 3600 },
    process.env.JWT_SECRET!,
    { algorithm: 'HS256' },
  );
}

async function main() {
  const {
    initDatabase,
    getDatabase,
    closeDatabase,
    withDatabaseRequest,
    now,
  } = require('../main/db');
  const { registerIpcHandlers } = require('../main/ipc');
  const { createDirectUpdateIpcHandlers } = require('../main/update-ipc');

  try {
    initDatabase();
  } catch (e: unknown) {
    if ((e as Error)?.message?.includes('ABI')) {
      console.log('  Skipping: better-sqlite3 ABI mismatch (run via Electron)');
      process.exit(77);
    }
    throw e;
  }

  try {
    // Register IPC and Direct Update handlers
    registerIpcHandlers(undefined, () => mainWin as never);
    const setSettingHandler = registered.get('set-setting')!;
    assert.equal(typeof setSettingHandler, 'function');

    let autoCheckPersisted = true;
    let betaChannelPersisted = false;
    let updateChecksTriggered = 0;

    const updateHandlers = createDirectUpdateIpcHandlers({
      ipcMain: { handle: () => {} },
      getMainWindow: () => mainWin as never,
      getServerPort: () => 3001,
      getStoredUpdateStatus: () => ({ state: 'idle' }) as never,
      getStagedUpdateReady: () => false,
      getUpdaterPhase: () => 'idle',
      getAppVersion: () => '3.13.23',
      checkForUpdates: () => {
        updateChecksTriggered += 1;
      },
      downloadUpdate: () => ({ success: true }),
      readAutoUpdateCheckEnabled: () => autoCheckPersisted,
      writeAutoUpdateCheckEnabled: (enabled: boolean) => {
        autoCheckPersisted = enabled;
      },
      readBetaChannelEnabled: () => betaChannelPersisted,
      writeBetaChannelEnabled: (enabled: boolean) => {
        betaChannelPersisted = enabled;
      },
      enqueueBetaChannelTransition: (action) => action(),
      configureAutoUpdaterChannel: () => {},
      setUpdateStatus: () => {},
      restartAndInstallHandler: async () => ({ success: false, error: 'PIN required' }),
      isServerRunning: () => true,
      isKdsServerRunning: () => true,
      isServerAppRunning: () => true,
      getResolvedTitleBarMode: () => 'native-overlay',
      getRendererReadinessEpoch: () => 1,
      getRendererDocumentNonce: () => 'nonce',
      getCurrentEffectiveIsDark: () => false,
      setCurrentEffectiveIsDark: () => {},
      applyTitleBarOverlayTheme: () => {},
      resolveTitleBarOverlayColors: () => ({ color: '#fff', symbolColor: '#000' }),
      withDatabaseRequest,
    });

    // 2. Pre-setup (0 users): theme_mode allowed, orders_layout and update channel toggles require auth
    {
      const unauthEvent = makeSenderEvent(null);
      const preTheme = await setSettingHandler(unauthEvent, 'theme_mode', 'dark');
      assert.deepEqual(preTheme, { success: true });

      const preLayout = await setSettingHandler(unauthEvent, 'orders_layout', 'cards');
      assert.deepEqual(preLayout, { success: false, error: 'Authentication required' });

      const preAuto = await updateHandlers['updates:set-auto-check'](unauthEvent, false);
      assert.deepEqual(preAuto, { success: false, error: 'Authentication required' });
      assert.equal(autoCheckPersisted, true);

      const preBeta = await updateHandlers['updates:set-beta-channel'](unauthEvent, true);
      assert.deepEqual(preBeta, { success: false, error: 'Authentication required' });
      assert.equal(betaChannelPersisted, false);
    }

    // Seed all 5 roles
    const db = getDatabase();
    const ts = now();
    for (const [id, role] of [
      ['u-owner', 'owner'],
      ['u-manager', 'manager'],
      ['u-cashier', 'cashier'],
      ['u-server', 'server'],
      ['u-chef', 'chef'],
    ] as const) {
      db.prepare(
        'INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      ).run(id, `Test ${role}`, `${id}@flo.local`, 'unused', role, ts, ts);
    }

    const ownerToken = mintToken('u-owner', 'owner');
    const managerToken = mintToken('u-manager', 'manager');
    const cashierToken = mintToken('u-cashier', 'cashier');
    const serverToken = mintToken('u-server', 'server');
    const chefToken = mintToken('u-chef', 'chef');

    // 3. Post-setup: unauthenticated, forged, revoked, inactive, and stale tokens fail closed
    {
      const unauthEvent = makeSenderEvent(null);
      assert.deepEqual(await setSettingHandler(unauthEvent, 'theme_mode', 'light'), {
        success: false,
        error: 'Authentication required',
      });
      assert.deepEqual(await updateHandlers['updates:set-auto-check'](unauthEvent, false, ''), {
        success: false,
        error: 'Authentication required',
      });

      const forgedToken = jwt.sign({ userId: 'u-owner', role: 'owner' }, 'wrong-secret', {
        algorithm: 'HS256',
      });
      assert.deepEqual(
        await updateHandlers['updates:set-beta-channel'](unauthEvent, true, forgedToken),
        { success: false, error: 'Authentication required' },
      );

      // Revoked token
      const revocableOwnerToken = mintToken('u-owner', 'owner', 1);
      const tokenHash = createHash('sha256').update(revocableOwnerToken).digest('hex');
      db.prepare(
        'INSERT INTO revoked_tokens (token_hash, expires_at, revoked_at) VALUES (?, ?, ?)',
      ).run(tokenHash, Date.now() + 60_000, now());
      assert.deepEqual(
        await updateHandlers['updates:set-auto-check'](unauthEvent, false, revocableOwnerToken),
        { success: false, error: 'Authentication required' },
      );

      // Stale token (tokens_valid_after newer than token iat)
      const staleToken = mintToken('u-manager', 'manager', -120);
      db.prepare('UPDATE users SET tokens_valid_after = ? WHERE id = ?').run(now(), 'u-manager');
      assert.deepEqual(await setSettingHandler(unauthEvent, 'theme_mode', 'dark', staleToken), {
        success: false,
        error: 'Authentication required',
      });
      db.prepare('UPDATE users SET tokens_valid_after = NULL WHERE id = ?').run('u-manager');

      // Inactive user
      db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run('u-owner');
      assert.deepEqual(
        await updateHandlers['updates:set-beta-channel'](unauthEvent, true, ownerToken),
        { success: false, error: 'Authentication required' },
      );
      db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run('u-owner');
    }

    // 4. Non-admin roles (cashier, server, chef) are rejected on explicit token; missing token fails closed
    for (const [label, token] of [
      ['cashier', cashierToken],
      ['server', serverToken],
      ['chef', chefToken],
    ] as const) {
      const senderEvent = makeSenderEvent();
      assert.deepEqual(
        await setSettingHandler(senderEvent, 'theme_mode', 'light', token),
        { success: false, error: 'Insufficient permissions' },
        `${label} explicit token must be rejected on set-setting(theme_mode)`,
      );
      assert.deepEqual(
        await setSettingHandler(senderEvent, 'orders_layout', 'cards', token),
        { success: false, error: 'Insufficient permissions' },
        `${label} explicit token must be rejected on set-setting(orders_layout)`,
      );
      assert.deepEqual(
        await updateHandlers['updates:set-auto-check'](senderEvent, false, token),
        { success: false, error: 'Insufficient permissions' },
        `${label} explicit token must be rejected on updates:set-auto-check`,
      );
      assert.deepEqual(
        await updateHandlers['updates:set-beta-channel'](senderEvent, true, token),
        { success: false, error: 'Insufficient permissions' },
        `${label} explicit token must be rejected on updates:set-beta-channel`,
      );
    }

    // Missing token fails closed with 'Authentication required'
    {
      const senderEvent = makeSenderEvent();
      assert.deepEqual(
        await setSettingHandler(senderEvent, 'orders_layout', 'cards'),
        { success: false, error: 'Authentication required' },
        'omitted token must fail closed on set-setting(orders_layout)',
      );
      assert.deepEqual(
        await updateHandlers['updates:set-auto-check'](senderEvent, false),
        { success: false, error: 'Authentication required' },
        'omitted token must fail closed on updates:set-auto-check',
      );
      assert.deepEqual(
        await updateHandlers['updates:set-beta-channel'](senderEvent, true),
        { success: false, error: 'Authentication required' },
        'omitted token must fail closed on updates:set-beta-channel',
      );
    }
    assert.equal(autoCheckPersisted, true);
    assert.equal(betaChannelPersisted, false);
    assert.equal(updateChecksTriggered, 0);

    // 5. Owner and manager succeed
    {
      const freshManagerToken = mintToken('u-manager', 'manager', 5);
      const ownerEvent = makeSenderEvent(ownerToken);
      const managerEvent = makeSenderEvent(freshManagerToken);

      assert.deepEqual(await setSettingHandler(ownerEvent, 'theme_mode', 'light', ownerToken), {
        success: true,
      });
      assert.deepEqual(
        await setSettingHandler(managerEvent, 'orders_layout', 'cards', freshManagerToken),
        {
          success: true,
        },
      );
      assert.deepEqual(
        await updateHandlers['updates:set-auto-check'](ownerEvent, false, ownerToken),
        { success: true },
      );
      assert.equal(autoCheckPersisted, false);

      assert.deepEqual(
        await updateHandlers['updates:set-beta-channel'](managerEvent, true, freshManagerToken),
        { success: true },
      );
      assert.equal(betaChannelPersisted, true);
      assert.equal(updateChecksTriggered, 1);
    }

    // 6. Custom user permission overrides (cashier granted settings.manage; manager denied settings.manage)
    {
      db.prepare(
        'INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run('u-cashier', 'settings.manage', 'allow', 'u-owner', now());
      db.prepare(
        'INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run('u-manager', 'settings.manage', 'deny', 'u-owner', now());

      const freshManagerToken = mintToken('u-manager', 'manager', 10);
      const cashierEvent = makeSenderEvent(cashierToken);
      const managerEvent = makeSenderEvent(freshManagerToken);

      assert.deepEqual(
        await updateHandlers['updates:set-auto-check'](cashierEvent, true, cashierToken),
        { success: true },
        'cashier with settings.manage=allow override must succeed',
      );
      assert.equal(autoCheckPersisted, true);

      assert.deepEqual(
        await updateHandlers['updates:set-beta-channel'](managerEvent, false, freshManagerToken),
        { success: false, error: 'Insufficient permissions' },
        'manager with settings.manage=deny override must be rejected',
      );
      assert.equal(betaChannelPersisted, true);
    }

    console.log('All Settings & Update IPC RBAC tests passed.');
  } finally {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

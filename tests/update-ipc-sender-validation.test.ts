import * as assert from 'node:assert/strict';
import { isTrustedLoopbackUrl, isTrustedMainWindowSender } from '../main/ipc';
import {
  createDirectUpdateIpcHandlers,
  registerDirectUpdateIpcHandlers,
  type DirectUpdateIpcOptions,
} from '../main/update-ipc';
import { createMainWindowWillNavigateHandler } from '../main/window-options';
import { createRestartAndInstallHandler } from '../main/updater-shutdown';
import { isAllowedLocalWindowUrl, isSafeExternalUrl } from '../main/security/url-allowlist';
import type { StoredUpdateStatus, UpdateErrorPhase } from '../main/update-state';

// ── Helpers & Test Doubles ──────────────────────────────────────────────────

class FakeWebFrameMain {
  constructor(
    public frameToken: string = 'main-frame-token-1',
    public detached: boolean = false,
    public url: string = 'http://localhost:3001/',
  ) {}
}

class FakeWebContents {
  public frame: FakeWebFrameMain;
  public url: string;

  constructor(
    public ownerWindow: FakeBrowserWindow | null,
    url: string = 'http://localhost:3001/',
    frameToken: string = 'main-frame-token-1',
  ) {
    this.url = url;
    this.frame = new FakeWebFrameMain(frameToken, false, url);
  }

  get mainFrame() {
    return this.frame;
  }

  getURL() {
    return this.url;
  }
}

class FakeBrowserWindow {
  public destroyed: boolean = false;
  public webContents: FakeWebContents;
  public titleBarThemeApplied?: { isDark: boolean; platform: NodeJS.Platform };
  public backgroundColor?: string;

  constructor(url: string = 'http://localhost:3001/', frameToken: string = 'main-frame-token-1') {
    this.webContents = new FakeWebContents(this, url, frameToken);
  }

  isDestroyed() {
    return this.destroyed;
  }

  setBackgroundColor(color: string) {
    this.backgroundColor = color;
  }
}

const FakeBrowserWindowClass = {
  fromWebContents(sender: any): FakeBrowserWindow | null {
    return sender?.ownerWindow ?? null;
  },
};

function createMockEvent(options: {
  window: FakeBrowserWindow | null;
  url?: string;
  frameToken?: string;
  senderFrameToken?: string;
  detached?: boolean;
  senderFrameUrl?: string;
  omitSender?: boolean;
  omitSenderFrame?: boolean;
}) {
  if (options.omitSender) {
    return {} as any;
  }
  const url = options.url ?? 'http://localhost:3001/';
  const mainToken = options.frameToken ?? 'main-frame-token-1';
  const senderToken = options.senderFrameToken ?? mainToken;
  const webContents = new FakeWebContents(options.window, url, mainToken);

  let senderFrame: any = undefined;
  if (!options.omitSenderFrame) {
    senderFrame = {
      frameToken: senderToken,
      detached: options.detached ?? false,
      url: options.senderFrameUrl ?? url,
    };
  }

  return {
    sender: webContents,
    senderFrame,
  };
}

async function runTests() {
  console.log('--- Testing isTrustedLoopbackUrl ---');

  // Valid loopback URLs
  assert.equal(isTrustedLoopbackUrl('http://localhost:3001/', 3001), true);
  assert.equal(isTrustedLoopbackUrl('http://localhost:3001/orders?tab=active', 3001), true);
  assert.equal(isTrustedLoopbackUrl('http://127.0.0.1:3001/', 3001), true);
  assert.equal(isTrustedLoopbackUrl('http://127.0.0.1:3001/pos', 3001), true);
  assert.equal(isTrustedLoopbackUrl('http://[::1]:3001/', 3001), true);
  assert.equal(isTrustedLoopbackUrl('http://localhost:80/', 80), true);

  // Invalid schemes
  assert.equal(isTrustedLoopbackUrl('https://localhost:3001/', 3001), false);
  assert.equal(isTrustedLoopbackUrl('file:///etc/passwd', 3001), false);
  assert.equal(isTrustedLoopbackUrl('javascript:alert(1)', 3001), false);
  assert.equal(isTrustedLoopbackUrl('about:blank', 3001), false);
  assert.equal(isTrustedLoopbackUrl('data:text/html,test', 3001), false);

  // Wrong hostnames
  assert.equal(isTrustedLoopbackUrl('http://attacker.invalid:3001/', 3001), false);
  assert.equal(isTrustedLoopbackUrl('http://example.com:3001/', 3001), false);
  assert.equal(isTrustedLoopbackUrl('http://192.168.1.50:3001/', 3001), false);
  assert.equal(isTrustedLoopbackUrl('http://10.0.0.1:3001/', 3001), false);

  // Wrong ports
  assert.equal(isTrustedLoopbackUrl('http://localhost:3002/', 3001), false);
  assert.equal(isTrustedLoopbackUrl('http://localhost:80/', 3001), false);
  assert.equal(isTrustedLoopbackUrl('http://127.0.0.1:8080/', 3001), false);

  // Credentials
  assert.equal(isTrustedLoopbackUrl('http://user:pass@localhost:3001/', 3001), false);
  assert.equal(isTrustedLoopbackUrl('http://admin@127.0.0.1:3001/', 3001), false);

  // Invalid port arguments
  assert.equal(isTrustedLoopbackUrl('http://localhost:3001/', 0), false);
  assert.equal(isTrustedLoopbackUrl('http://localhost:3001/', -1), false);
  assert.equal(isTrustedLoopbackUrl('http://localhost:3001/', NaN), false);
  assert.equal(isTrustedLoopbackUrl('http://localhost:3001/', 3001.5), false);
  assert.equal(isTrustedLoopbackUrl('invalid-url', 3001), false);

  console.log('✓ isTrustedLoopbackUrl passes all boundary checks');

  console.log('--- Testing isTrustedMainWindowSender ---');

  const mainWindow = new FakeBrowserWindow('http://localhost:3001/', 'token-pos');
  const validEvent = createMockEvent({
    window: mainWindow,
    url: 'http://localhost:3001/',
    frameToken: 'token-pos',
    senderFrameToken: 'token-pos',
  });

  // Legitimate sender
  assert.equal(
    isTrustedMainWindowSender(validEvent, () => mainWindow as any, 3001, FakeBrowserWindowClass as any),
    true,
  );
  assert.equal(
    isTrustedMainWindowSender(validEvent, mainWindow as any, 3001, FakeBrowserWindowClass as any),
    true,
  );

  // Destroyed mainWindow
  const destroyedWindow = new FakeBrowserWindow('http://localhost:3001/', 'token-pos');
  destroyedWindow.destroyed = true;
  assert.equal(
    isTrustedMainWindowSender(validEvent, () => destroyedWindow as any, 3001, FakeBrowserWindowClass as any),
    false,
  );

  // Null/undefined window getter
  assert.equal(
    isTrustedMainWindowSender(validEvent, () => null, 3001, FakeBrowserWindowClass as any),
    false,
  );

  // Different window (e.g. KDS window or popup)
  const otherWindow = new FakeBrowserWindow('http://localhost:3001/', 'token-kds');
  const otherWindowEvent = createMockEvent({
    window: otherWindow,
    url: 'http://localhost:3001/',
    frameToken: 'token-kds',
    senderFrameToken: 'token-kds',
  });
  assert.equal(
    isTrustedMainWindowSender(otherWindowEvent, () => mainWindow as any, 3001, FakeBrowserWindowClass as any),
    false,
  );

  // Detached senderFrame
  const detachedEvent = createMockEvent({
    window: mainWindow,
    url: 'http://localhost:3001/',
    frameToken: 'token-pos',
    senderFrameToken: 'token-pos',
    detached: true,
  });
  assert.equal(
    isTrustedMainWindowSender(detachedEvent, () => mainWindow as any, 3001, FakeBrowserWindowClass as any),
    false,
  );

  // Stale or mismatched frame token (e.g. iframe)
  const subframeEvent = createMockEvent({
    window: mainWindow,
    url: 'http://localhost:3001/',
    frameToken: 'token-pos',
    senderFrameToken: 'token-iframe',
  });
  assert.equal(
    isTrustedMainWindowSender(subframeEvent, () => mainWindow as any, 3001, FakeBrowserWindowClass as any),
    false,
  );

  // Remote URL on webContents
  const remoteUrlEvent = createMockEvent({
    window: mainWindow,
    url: 'https://attacker.invalid/',
    frameToken: 'token-pos',
    senderFrameToken: 'token-pos',
  });
  assert.equal(
    isTrustedMainWindowSender(remoteUrlEvent, () => mainWindow as any, 3001, FakeBrowserWindowClass as any),
    false,
  );

  // Untrusted senderFrame URL
  const untrustedFrameUrlEvent = createMockEvent({
    window: mainWindow,
    url: 'http://localhost:3001/',
    frameToken: 'token-pos',
    senderFrameToken: 'token-pos',
    senderFrameUrl: 'https://evil.com/',
  });
  assert.equal(
    isTrustedMainWindowSender(untrustedFrameUrlEvent, () => mainWindow as any, 3001, FakeBrowserWindowClass as any),
    false,
  );

  // Wrong port
  assert.equal(
    isTrustedMainWindowSender(validEvent, () => mainWindow as any, 3002, FakeBrowserWindowClass as any),
    false,
  );

  // Missing senderFrame or sender
  const missingFrameEvent = createMockEvent({
    window: mainWindow,
    omitSenderFrame: true,
  });
  assert.equal(
    isTrustedMainWindowSender(missingFrameEvent, () => mainWindow as any, 3001, FakeBrowserWindowClass as any),
    false,
  );

  const missingSenderEvent = createMockEvent({
    window: mainWindow,
    omitSender: true,
  });
  assert.equal(
    isTrustedMainWindowSender(missingSenderEvent, () => mainWindow as any, 3001, FakeBrowserWindowClass as any),
    false,
  );

  console.log('✓ isTrustedMainWindowSender enforces window identity, frame token, and loopback origin');

  console.log('--- Testing Direct Update IPC Handlers ---');

  let checkUpdatesCalled = false;
  let downloadUpdateCalled = false;
  let autoUpdateCheckEnabled = true;
  let autoUpdateWriteCalled = false;
  let betaChannelEnabled = false;
  let betaChannelWriteCalled = false;
  let configuredChannel: boolean | null = null;
  let currentThemeIsDark = false;
  let restartAndInstallCalled = false;
  let restartAndInstallPin: unknown = null;

  const mockStatus: StoredUpdateStatus = {
    status: 'idle',
    lastCheckedAt: 123456789,
    channel: 'stable',
  };

  const createOptions = (customSenderValidator?: (event: unknown) => boolean): DirectUpdateIpcOptions => ({
    ipcMain: { handle: () => {} } as any,
    getMainWindow: () => mainWindow as any,
    getServerPort: () => 3001,
    getStoredUpdateStatus: () => mockStatus,
    getStagedUpdateReady: () => false,
    getUpdaterPhase: () => 'check' as UpdateErrorPhase,
    getAppVersion: () => '3.13.0',
    checkForUpdates: () => {
      checkUpdatesCalled = true;
    },
    downloadUpdate: () => {
      downloadUpdateCalled = true;
      return Promise.resolve({ success: true });
    },
    readAutoUpdateCheckEnabled: () => autoUpdateCheckEnabled,
    writeAutoUpdateCheckEnabled: (enabled: boolean) => {
      autoUpdateWriteCalled = true;
      autoUpdateCheckEnabled = enabled;
    },
    readBetaChannelEnabled: () => betaChannelEnabled,
    writeBetaChannelEnabled: (enabled: boolean) => {
      betaChannelWriteCalled = true;
      betaChannelEnabled = enabled;
    },
    enqueueBetaChannelTransition: async (action) => action(),
    configureAutoUpdaterChannel: (enabled: boolean) => {
      configuredChannel = enabled;
    },
    setUpdateStatus: () => {},
    restartAndInstallHandler: async (event, pin) => {
      restartAndInstallCalled = true;
      restartAndInstallPin = pin;
      return { success: true };
    },
    isServerRunning: () => true,
    isKdsServerRunning: () => true,
    isServerAppRunning: () => true,
    getResolvedTitleBarMode: () => 'native-overlay',
    getRendererReadinessEpoch: () => 42,
    getRendererDocumentNonce: () => 'nonce-xyz',
    getCurrentEffectiveIsDark: () => currentThemeIsDark,
    setCurrentEffectiveIsDark: (isDark: boolean) => {
      currentThemeIsDark = isDark;
    },
    applyTitleBarOverlayTheme: (win: any, isDark: boolean, platform: NodeJS.Platform) => {
      win.titleBarThemeApplied = { isDark, platform };
    },
    resolveTitleBarOverlayColors: (isDark: boolean) => ({
      color: isDark ? '#111111' : '#ffffff',
      symbolColor: isDark ? '#ffffff' : '#000000',
    }),
    withDatabaseRequest: async (action) => action(),
    validateSender: customSenderValidator,
  });

  const testUntrustedSenders = async (handlers: Record<string, (event: any, ...args: any[]) => any>) => {
    const invalidEvents = [
      { name: 'remote URL', event: createMockEvent({ window: mainWindow, url: 'https://attacker.invalid/' }) },
      { name: 'wrong host', event: createMockEvent({ window: mainWindow, url: 'http://evil.com:3001/' }) },
      { name: 'wrong port', event: createMockEvent({ window: mainWindow, url: 'http://localhost:3002/' }) },
      { name: 'other window', event: createMockEvent({ window: otherWindow, url: 'http://localhost:3001/' }) },
      { name: 'detached frame', event: createMockEvent({ window: mainWindow, detached: true }) },
      { name: 'subframe mismatch', event: createMockEvent({ window: mainWindow, senderFrameToken: 'iframe-tok' }) },
      { name: 'missing frame', event: createMockEvent({ window: mainWindow, omitSenderFrame: true }) },
    ];

    const channels = [
      'get-update-status',
      'check-for-updates',
      'download-update',
      'updates:get-auto-check',
      'updates:set-auto-check',
      'updates:get-beta-channel',
      'updates:set-beta-channel',
      'restart-and-install',
      'get-status',
      'set-theme-effective',
    ];

    for (const { name, event } of invalidEvents) {
      for (const channel of channels) {
        checkUpdatesCalled = false;
        downloadUpdateCalled = false;
        autoUpdateWriteCalled = false;
        betaChannelWriteCalled = false;
        restartAndInstallCalled = false;
        currentThemeIsDark = false;

        const res: any = await handlers[channel](event, true);
        assert.equal(
          res?.error,
          'Unauthorized sender',
          `${channel} rejected ${name} with Unauthorized sender`,
        );

        if (['updates:set-auto-check', 'updates:set-beta-channel', 'restart-and-install', 'set-theme-effective'].includes(channel)) {
          assert.equal(res?.success, false, `${channel} set success: false for ${name}`);
        }

        // Downstream guard assertion: NO action taken
        assert.equal(checkUpdatesCalled, false, `checkForUpdates not called on ${name} via ${channel}`);
        assert.equal(downloadUpdateCalled, false, `downloadUpdate not called on ${name} via ${channel}`);
        assert.equal(autoUpdateWriteCalled, false, `autoUpdate write not called on ${name} via ${channel}`);
        assert.equal(betaChannelWriteCalled, false, `betaChannel write not called on ${name} via ${channel}`);
        assert.equal(restartAndInstallCalled, false, `restartAndInstall not called on ${name} via ${channel}`);
        assert.equal(currentThemeIsDark, false, `theme dark not mutated on ${name} via ${channel}`);
      }
    }
  };

  const handlersWithValidator = createDirectUpdateIpcHandlers(
    createOptions((event) =>
      isTrustedMainWindowSender(event as any, () => mainWindow as any, 3001, FakeBrowserWindowClass as any),
    ),
  );

  await testUntrustedSenders(handlersWithValidator);
  console.log('✓ All 10 handlers reject remote, wrong-host, wrong-port, other-window, and stale-frame senders');

  // Test legitimate sender execution and argument validation
  console.log('--- Testing legitimate sender execution & arguments ---');

  // 1. get-update-status
  const statusRes: any = await handlersWithValidator['get-update-status'](validEvent);
  assert.equal(statusRes.status, 'idle');
  assert.equal(statusRes.info.version, '3.13.0');

  // 2. check-for-updates
  checkUpdatesCalled = false;
  await handlersWithValidator['check-for-updates'](validEvent);
  assert.equal(checkUpdatesCalled, true, 'checkForUpdates invoked');

  // 3. download-update
  downloadUpdateCalled = false;
  const dlRes: any = await handlersWithValidator['download-update'](validEvent);
  assert.equal(dlRes.success, true);
  assert.equal(downloadUpdateCalled, true, 'downloadUpdate invoked');

  // 4. updates:get-auto-check
  const autoCheckRes: any = await handlersWithValidator['updates:get-auto-check'](validEvent);
  assert.equal(autoCheckRes, true);

  // 5. updates:set-auto-check argument validation & success
  autoUpdateWriteCalled = false;
  const invalidAutoCheckRes: any = await handlersWithValidator['updates:set-auto-check'](validEvent, 'not-a-boolean');
  assert.deepEqual(invalidAutoCheckRes, { success: false, error: 'enabled must be a boolean' });
  assert.equal(autoUpdateWriteCalled, false, 'writeAutoUpdateCheckEnabled not called on invalid arg');

  const validAutoCheckRes: any = await handlersWithValidator['updates:set-auto-check'](validEvent, false);
  assert.deepEqual(validAutoCheckRes, { success: true });
  assert.equal(autoUpdateWriteCalled, true);
  assert.equal(autoUpdateCheckEnabled, false);

  // 6. updates:get-beta-channel
  const betaRes: any = await handlersWithValidator['updates:get-beta-channel'](validEvent);
  assert.equal(betaRes, false);

  // 7. updates:set-beta-channel argument validation & success
  betaChannelWriteCalled = false;
  const invalidBetaRes: any = await handlersWithValidator['updates:set-beta-channel'](validEvent, 123);
  assert.deepEqual(invalidBetaRes, { success: false, error: 'enabled must be a boolean' });
  assert.equal(betaChannelWriteCalled, false, 'writeBetaChannelEnabled not called on invalid arg');

  const validBetaRes: any = await handlersWithValidator['updates:set-beta-channel'](validEvent, true);
  assert.deepEqual(validBetaRes, { success: true });
  assert.equal(betaChannelWriteCalled, true);
  assert.equal(betaChannelEnabled, true);
  assert.equal(configuredChannel, true);

  // 8. restart-and-install
  restartAndInstallCalled = false;
  const restartRes: any = await handlersWithValidator['restart-and-install'](validEvent, '1234');
  assert.deepEqual(restartRes, { success: true });
  assert.equal(restartAndInstallCalled, true);
  assert.equal(restartAndInstallPin, '1234');

  // 9. get-status
  const appStatus: any = await handlersWithValidator['get-status'](validEvent);
  assert.equal(appStatus.server, 'running');
  assert.equal(appStatus.kdsServer, 'running');
  assert.equal(appStatus.serverApp, 'running');
  assert.equal(appStatus.port, 3001);
  assert.equal(appStatus.titleBarMode, 'native-overlay');
  assert.equal(appStatus.titleBarEpoch, 42);
  assert.equal(appStatus.titleBarDocumentNonce, 'nonce-xyz');
  assert.equal(typeof appStatus.memory.heapUsed, 'number');

  // 10. set-theme-effective argument validation & success
  const invalidThemeRes: any = await handlersWithValidator['set-theme-effective'](validEvent, 'dark');
  assert.deepEqual(invalidThemeRes, { success: false, error: 'isDark must be boolean' });

  const validThemeRes: any = await handlersWithValidator['set-theme-effective'](validEvent, true);
  assert.deepEqual(validThemeRes, { success: true });
  assert.equal(currentThemeIsDark, true);
  assert.equal(mainWindow.backgroundColor, '#111111');
  assert.equal(mainWindow.titleBarThemeApplied?.isDark, true);

  console.log('✓ All 10 handlers succeed for legitimate senders and reject malformed arguments');

  console.log('--- Testing restartAndInstallHandler sender & readiness & PIN guards ---');

  let isReady = false;
  let pinAuthorized = false;
  let cleanupRun = false;
  let quitAndInstallRun = false;
  let warnMessages: string[] = [];

  const restartHandler = createRestartAndInstallHandler({
    validateSender: (event) =>
      isTrustedMainWindowSender(event as any, () => mainWindow as any, 3001, FakeBrowserWindowClass as any),
    isInstallReady: () => isReady,
    authorize: (pin) => {
      if (pin === 'master-1234') {
        pinAuthorized = true;
        return { ok: true };
      }
      return { ok: false, error: 'Invalid master PIN' };
    },
    runCleanup: async () => {
      cleanupRun = true;
    },
    quitAndInstall: () => {
      quitAndInstallRun = true;
    },
    updateState: {
      setInstallingUpdate: () => {},
      setQuitting: () => {},
    },
    onInstallFailure: () => {},
    warn: (msg) => warnMessages.push(msg),
    error: () => {},
  });

  // Untrusted sender
  const untrustedRestartRes = await restartHandler(remoteUrlEvent, 'master-1234');
  assert.deepEqual(untrustedRestartRes, { success: false, error: 'Unauthorized sender' });
  assert.equal(pinAuthorized, false, 'PIN not evaluated on untrusted sender');
  assert.equal(cleanupRun, false);
  assert.equal(quitAndInstallRun, false);

  // Trusted sender, but not ready
  isReady = false;
  const notReadyRes = await restartHandler(validEvent, 'master-1234');
  assert.deepEqual(notReadyRes, { success: false, error: 'No downloaded update is ready to install.' });
  assert.equal(pinAuthorized, false, 'PIN not evaluated when not ready');
  assert.equal(cleanupRun, false);
  assert.equal(quitAndInstallRun, false);

  // Trusted sender, ready, but invalid PIN
  isReady = true;
  const badPinRes = await restartHandler(validEvent, 'wrong-pin');
  assert.deepEqual(badPinRes, { success: false, error: 'Invalid master PIN' });
  assert.equal(cleanupRun, false);
  assert.equal(quitAndInstallRun, false);

  // Trusted sender, ready, valid PIN
  isReady = true;
  const authorizedRes = await restartHandler(validEvent, 'master-1234');
  assert.deepEqual(authorizedRes, { success: true });
  assert.equal(pinAuthorized, true);
  assert.equal(cleanupRun, true);
  assert.equal(quitAndInstallRun, true);

  console.log('✓ restartAndInstallHandler sender, readiness, and PIN guards enforce proper precedence');

  console.log('--- Testing registerDirectUpdateIpcHandlers registration ---');

  const registeredChannels = new Set<string>();
  registerDirectUpdateIpcHandlers({
    ...createOptions(),
    ipcMain: {
      handle: (channel: string) => {
        registeredChannels.add(channel);
      },
    } as any,
  });

  const expectedChannels = [
    'get-update-status',
    'check-for-updates',
    'download-update',
    'updates:get-auto-check',
    'updates:set-auto-check',
    'updates:get-beta-channel',
    'updates:set-beta-channel',
    'restart-and-install',
    'get-status',
    'set-theme-effective',
  ];
  for (const ch of expectedChannels) {
    assert.equal(registeredChannels.has(ch), true, `Channel ${ch} registered on ipcMain`);
  }
  assert.equal(registeredChannels.size, 10, 'Exactly 10 direct IPC channels registered');

  console.log('✓ registerDirectUpdateIpcHandlers wires all 10 channels');

  console.log('--- Testing createMainWindowWillNavigateHandler ---');

  let navPrevented = false;
  let openedExternalUrl: string | null = null;
  const navWarnings: string[] = [];

  const willNavigate = createMainWindowWillNavigateHandler(
    isAllowedLocalWindowUrl,
    () => 3001,
    () => '192.168.1.50',
    isSafeExternalUrl,
    async (url) => {
      openedExternalUrl = url;
    },
    (msg, ...args) => {
      navWarnings.push([msg, ...args].join(' '));
    },
  );

  const mockNavEvent = {
    preventDefault: () => {
      navPrevented = true;
    },
  };

  // Local app URL
  navPrevented = false;
  openedExternalUrl = null;
  willNavigate(mockNavEvent, 'http://localhost:3001/dashboard');
  assert.equal(navPrevented, false, 'local app navigation permitted');
  assert.equal(openedExternalUrl, null);

  // Local IP URL
  navPrevented = false;
  openedExternalUrl = null;
  willNavigate(mockNavEvent, 'http://192.168.1.50:3001/orders');
  assert.equal(navPrevented, false, 'local IP app navigation permitted');
  assert.equal(openedExternalUrl, null);

  // Safe external HTTPS URL -> prevented in-window, opened externally
  navPrevented = false;
  openedExternalUrl = null;
  willNavigate(mockNavEvent, 'https://github.com/FreeOpenSourcePOS/FloCafe');
  assert.equal(navPrevented, true, 'external HTTPS navigation prevented');
  assert.equal(openedExternalUrl, 'https://github.com/FreeOpenSourcePOS/FloCafe');

  // Safe external HTTP URL -> prevented in-window, opened externally
  navPrevented = false;
  openedExternalUrl = null;
  willNavigate(mockNavEvent, 'http://example.com/docs');
  assert.equal(navPrevented, true, 'external HTTP navigation prevented');
  assert.equal(openedExternalUrl, 'http://example.com/docs');

  // Unsafe javascript URL -> prevented in-window, NOT opened externally, warned
  navPrevented = false;
  openedExternalUrl = null;
  navWarnings.length = 0;
  willNavigate(mockNavEvent, 'javascript:alert(1)');
  assert.equal(navPrevented, true, 'javascript URL prevented');
  assert.equal(openedExternalUrl, null, 'javascript URL not opened externally');
  assert.equal(navWarnings.some((w) => w.includes('Blocked unsafe navigation URL')), true);

  // Unsafe file URL -> prevented in-window, NOT opened externally, warned
  navPrevented = false;
  openedExternalUrl = null;
  navWarnings.length = 0;
  willNavigate(mockNavEvent, 'file:///etc/passwd');
  assert.equal(navPrevented, true, 'file URL prevented');
  assert.equal(openedExternalUrl, null, 'file URL not opened externally');
  assert.equal(navWarnings.some((w) => w.includes('Blocked unsafe navigation URL')), true);

  // Unsafe data URL -> prevented in-window, NOT opened externally, warned
  navPrevented = false;
  openedExternalUrl = null;
  navWarnings.length = 0;
  willNavigate(mockNavEvent, 'data:text/html,<h1>attack</h1>');
  assert.equal(navPrevented, true, 'data URL prevented');
  assert.equal(openedExternalUrl, null, 'data URL not opened externally');
  assert.equal(navWarnings.some((w) => w.includes('Blocked unsafe navigation URL')), true);

  console.log('✓ createMainWindowWillNavigateHandler confines local app navigation and delegates external URLs safely');

  console.log('\n✅ All update IPC sender validation and window navigation tests passed successfully.');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

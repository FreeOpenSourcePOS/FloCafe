import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, chromium, type Browser, type ElectronApplication, type Page } from 'playwright';

const require = createRequire(__filename);
const electronPath = require('electron') as string;
const repoRoot = path.resolve(__dirname, '../../../');
const seedScript = path.join(repoRoot, 'tests/native-e2e-fixture.cjs');
const GRACEFUL_CLOSE_TIMEOUT_MS = 15_000;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const PORT_CLOSE_TIMEOUT_MS = 5_000;

export interface NativeServicePorts {
  main: number;
  kds: number;
  serverApp: number;
  devTools: number;
}

export interface NativeElectronHarness {
  app: ElectronApplication;
  page: Page;
  ports: NativeServicePorts;
  profileDir: string;
  setActivePage: (page: Page) => void;
  authenticateDashboard: () => Promise<void>;
  simulateTerminalRuntimeLoss: () => Promise<void>;
  relaunchAndWaitForPage: () => Promise<Page>;
  close: () => Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    const finish = (available: boolean): void => {
      server.removeAllListeners();
      resolve(available);
    };
    server.once('error', () => finish(false));
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => finish(!error));
    });
  });
}

async function findServicePorts(): Promise<NativeServicePorts> {
  const workerIndex = Number(process.env.PW_TEST_WORKER_INDEX || 0);
  const firstCandidate = 31_000 + ((process.pid + workerIndex * 101) % 900) * 3;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const main = firstCandidate + attempt * 3;
    const candidate = { main, kds: main + 1, serverApp: main + 2, devTools: main + 3 };
    if ((await Promise.all(Object.values(candidate).map(isPortAvailable))).every(Boolean)) return candidate;
  }
  throw new Error(`Unable to reserve a native E2E service port set near ${firstCandidate}`);
}

function runSeed(env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const seedEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' } as unknown as NodeJS.ProcessEnv;
    const child = spawn(electronPath, [seedScript], {
      cwd: repoRoot,
      env: seedEnv,
      stdio: 'pipe',
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Native E2E fixture seed failed (code=${code}, signal=${signal}): ${output.trim()}`));
    });
  });
}

async function waitForHealth(ports: NativeServicePorts): Promise<void> {
  const endpoints = [
    `http://127.0.0.1:${ports.main}/api/health`,
    `http://127.0.0.1:${ports.kds}/api/health`,
    `http://127.0.0.1:${ports.serverApp}/api/health`,
  ];
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const responses = await Promise.all(endpoints.map((endpoint) => fetch(endpoint)));
      if (responses.every((response) => response.ok)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Native E2E services did not become healthy: ${String(lastError || 'unexpected health response')}`);
}

async function waitForRendererServices(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const running = await page.evaluate(async () => {
      const status = await window.electronAPI?.getStatus();
      return status?.server === 'running'
        && status.kdsServer === 'running'
        && status.serverApp === 'running';
    });
    if (running) return;
    await delay(100);
  }
  throw new Error('Native E2E renderer did not report all services running');
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
    await delay(100);
  }
  return false;
}

async function waitForPortClosed(port: number): Promise<boolean> {
  const deadline = Date.now() + PORT_CLOSE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const closed = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      const finish = (value: boolean): void => {
        socket.destroy();
        resolve(value);
      };
      socket.once('connect', () => finish(false));
      socket.once('error', (error: NodeJS.ErrnoException) => {
        finish(error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET');
      });
    });
    if (closed) return true;
    await delay(100);
  }
  return false;
}

async function waitForRelaunchedPid(pidFile: string, previousPid: number): Promise<number> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
      if (Number.isInteger(pid) && pid > 0 && pid !== previousPid) return pid;
    } catch {
    }
    await delay(100);
  }
  throw new Error(`Relaunched Electron process PID was not written to ${pidFile}`);
}

async function connectToRelaunchedPage(devToolsPort: number, mainPort: number): Promise<{ browser: Browser; page: Page }> {
  const endpoint = `http://127.0.0.1:${devToolsPort}`;
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    let browser: Browser | undefined;
    try {
      browser = await chromium.connectOverCDP(endpoint);
      const page = browser.contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => {
          try { return new URL(candidate.url()).port === String(mainPort); } catch { return false; }
      });
      if (page) return { browser, page };
      await browser.close();
    } catch (error) {
      lastError = error;
      if (browser) await browser.close().catch(() => {});
    }
    await delay(100);
  }
  throw new Error(`Relaunched Electron page did not become available: ${String(lastError || 'unexpected CDP state')}`);
}

function forceTerminate(pid: number): boolean {
  try {
    process.kill(pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function requestProcessExit(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function boundedGracefulClose(
  app: ElectronApplication,
  ports: NativeServicePorts,
  profileDir: string,
): Promise<void> {
  const pid = app.process().pid;
  if (!pid) throw new Error('Native Electron process did not expose a PID');

  let gracefulError: unknown;
  try {
    const cleanupComplete = new Promise<void>((resolve) => {
      app.on('console', (message) => {
        if (message.text() === '[Flo] Goodbye!') resolve();
      });
    });
    // Request quit through Electron so close-to-tray is honored, wait for the
    // app's own cleanup marker, then let Playwright close its Node/CDP
    // connection. Closing that connection only after cleanup avoids both a
    // hidden window masquerading as process exit and a connection-held process.
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await Promise.race([
      cleanupComplete,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(
        `Electron graceful close exceeded ${GRACEFUL_CLOSE_TIMEOUT_MS}ms`,
      )), GRACEFUL_CLOSE_TIMEOUT_MS)),
    ]);
    await app.close();
  } catch (error) {
    gracefulError = error;
  }

  let exited = await waitForProcessExit(pid);
  let forcedCleanup = false;
  if (!exited) {
    forcedCleanup = forceTerminate(pid);
    exited = await waitForProcessExit(pid);
  }

  const portsClosed = (await Promise.all(Object.values(ports).map(waitForPortClosed))).every(Boolean);
  let profileCleanupError: unknown;
  if (exited) {
    try { rmSync(profileDir, { recursive: true, force: true }); } catch (error) { profileCleanupError = error; }
  }

  if (gracefulError || forcedCleanup || !exited || !portsClosed || profileCleanupError) {
    throw new Error([
      'Native Electron teardown failed',
      gracefulError ? `graceful=${String(gracefulError)}` : '',
      forcedCleanup ? 'forced_cleanup=true' : '',
      `pid_exited=${exited}`,
      `ports_closed=${portsClosed}`,
      profileCleanupError ? `profile=${String(profileCleanupError)}` : '',
    ].filter(Boolean).join('; '));
  }
}

async function boundedRelaunchClose(
  app: ElectronApplication,
  browser: Browser | null,
  pid: number,
  ports: NativeServicePorts,
  profileDir: string,
): Promise<void> {
  if (browser) await browser.close().catch(() => {});
  try { await app.close(); } catch {}

  let exited = await waitForProcessExit(pid);
  let forcedCleanup = false;
  if (!exited) {
    requestProcessExit(pid);
    exited = await waitForProcessExit(pid);
  }
  if (!exited) {
    forcedCleanup = forceTerminate(pid);
    exited = await waitForProcessExit(pid);
  }

  const portsClosed = (await Promise.all(Object.values(ports).map(waitForPortClosed))).every(Boolean);
  let profileCleanupError: unknown;
  if (exited) {
    try { rmSync(profileDir, { recursive: true, force: true }); } catch (error) { profileCleanupError = error; }
  }

  if (forcedCleanup || !exited || !portsClosed || profileCleanupError) {
    throw new Error([
      'Native Electron relaunch teardown failed',
      forcedCleanup ? 'forced_cleanup=true' : '',
      `pid_exited=${exited}`,
      `ports_closed=${portsClosed}`,
      profileCleanupError ? `profile=${String(profileCleanupError)}` : '',
    ].filter(Boolean).join('; '));
  }
}

export async function createNativeElectronHarness(): Promise<NativeElectronHarness> {
  const profileDir = mkdtempSync(path.join(tmpdir(), 'flo-native-e2e-'));
  const ports = await findServicePorts();
  const pidFile = path.join(profileDir, 'electron.pid');
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const env: Record<string, string> = {
    ...inheritedEnv,
    NODE_ENV: 'test',
    JWT_SECRET: randomBytes(32).toString('hex'),
    FLO_E2E_OWNER_EMAIL: `native-e2e-owner-${randomBytes(8).toString('hex')}@flo.local`,
    FLO_E2E_OWNER_PASSWORD: `${randomBytes(24).toString('base64url')}Aa1!`,
    FLO_E2E_SKIP_OPTIONAL_NETWORK: '1',
    FLO_MATRIX_OFFLINE: '1',
    FLO_E2E_USER_DATA_DIR: profileDir,
    FLO_E2E_DB_PATH: path.join(profileDir, 'flo.db'),
    FLO_E2E_PID_FILE: pidFile,
    PORT: String(ports.main),
    KDS_PORT: String(ports.kds),
    SERVER_APP_PORT: String(ports.serverApp),
  };

  let app: ElectronApplication | undefined;
  let relaunchedBrowser: Browser | null = null;
  let relaunchedPid: number | null = null;
  try {
    await runSeed(env);
    app = await electron.launch({ cwd: repoRoot, args: ['.', `--remote-debugging-port=${ports.devTools}`], env });
    app.on('console', (message) => console.log(`[Native Electron] ${message.text()}`));
    let activePage = await app.firstWindow();
    await activePage.waitForURL((url) => url.port === String(ports.main), { timeout: 30_000 });
    await waitForHealth(ports);
    await waitForRendererServices(activePage);

    const actualPorts = await activePage.evaluate(async () => {
      const status = await window.electronAPI?.getStatus();
      const kds = await window.electronAPI?.getKdsInfo();
      return { main: status?.port, kds: kds && 'port' in kds ? kds.port : undefined };
    });
    if (actualPorts.main !== ports.main || actualPorts.kds !== ports.kds) {
      throw new Error(`Native E2E service port mismatch: expected ${JSON.stringify(ports)}, got ${JSON.stringify(actualPorts)}`);
    }

    // The app's root export is a redirect boundary, so drive the renderer to a
    // concrete public route before any test asserts route-owned UI state.
    await activePage.goto(`http://localhost:${ports.main}/auth/login`, { waitUntil: 'domcontentloaded' });

    return {
      app,
      get page() { return activePage; },
      ports,
      profileDir,
      setActivePage: (page) => { activePage = page; },
      authenticateDashboard: async () => {
        const currentPath = new URL(activePage.url()).pathname.replace(/\/+$/, '') || '/';
        if (currentPath !== '/auth/login' && currentPath !== '/pos') {
          throw new Error(`Native E2E expected a stable auth route, got ${activePage.url()}`);
        }
        if (currentPath !== '/pos') {
          await activePage.locator('#email').fill(env.FLO_E2E_OWNER_EMAIL);
          await activePage.locator('#password').fill(env.FLO_E2E_OWNER_PASSWORD);
          await activePage.locator('button[type="submit"]').click();
          await activePage.waitForURL((url) => url.pathname.replace(/\/+$/, '') === '/pos', { timeout: 30_000 });
        }
        const activeOrigin = new URL(activePage.url()).origin;
        await app!.evaluate(({ app: electronApp, BrowserWindow }, origin) => {
          electronApp.focus({ steal: true });
          BrowserWindow.getAllWindows().find((window) => {
            try { return new URL(window.webContents.getURL()).origin === origin; } catch { return false; }
          })?.focus();
        }, activeOrigin);
        await activePage.waitForFunction(() => document.hasFocus() && document.documentElement.dataset.floWindowFocused === 'true');
        await activePage.waitForFunction(() => document.documentElement.dataset.floDesktopTitlebar === 'true');
      },
      simulateTerminalRuntimeLoss: async () => {
        await app!.evaluate(async () => {
          type MainModule = { require: (request: string) => unknown };
          const mainModule = (process as NodeJS.Process & { mainModule?: MainModule }).mainModule;
          if (!mainModule) throw new Error('Native E2E could not access the Electron main module');
          const mainServer = mainModule.require('./server') as { stopServer: () => Promise<void> };
          const kdsServer = mainModule.require('./kds-server') as { stopKdsServer: () => Promise<void> };
          const serverApp = mainModule.require('./server-app') as { stopServerApp: () => Promise<void> };
          await Promise.all([mainServer.stopServer(), kdsServer.stopKdsServer(), serverApp.stopServerApp()]);
        });
      },
      relaunchAndWaitForPage: async () => {
        const previousPid = app!.process().pid;
        if (!previousPid) throw new Error('Native Electron process did not expose a PID');
        if (!await waitForProcessExit(previousPid)) {
          throw new Error(`Original Electron process ${previousPid} did not exit after relaunch`);
        }
        relaunchedPid = await waitForRelaunchedPid(pidFile, previousPid);
        const connection = await connectToRelaunchedPage(ports.devTools, ports.main);
        relaunchedBrowser = connection.browser;
        activePage = connection.page;
        return connection.page;
      },
      close: async () => {
        if (relaunchedPid) {
          await boundedRelaunchClose(app!, relaunchedBrowser, relaunchedPid, ports, profileDir);
          return;
        }
        await boundedGracefulClose(app!, ports, profileDir);
      },
    };
  } catch (error) {
    if (app) {
      try {
        await boundedGracefulClose(app, ports, profileDir);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Native E2E startup and teardown failed');
      }
    } else if (existsSync(profileDir)) {
      rmSync(profileDir, { recursive: true, force: true });
    }
    throw error;
  }
}

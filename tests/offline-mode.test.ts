/**
 * Offline mode: owner-only switch that closes every optional outbound connection.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/offline-mode.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-offline-mode-'));
Module._load = function (request: string) {
  if (request === 'electron')
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (v: string) => Buffer.from(v, 'utf8'),
        decryptString: (b: Buffer) => b.toString('utf8'),
      },
    };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-offline-mode';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  resetCounters,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { settingsRoutes } = require('../main/routes/settings');
const { productRoutes, fetchPinnedHttps } = require('../main/routes/products');
const { databaseRoutes } = require('../main/routes/database');
const {
  isOfflineMode,
  assertOnlineAllowed,
  notifyOfflineModeEnabled,
} = require('../main/services/offline-mode');
const {
  fetchRemoteTaxPackCatalog,
  downloadAndVerifyTaxPack,
} = require('../main/tax-packs/catalog');
const {
  isTelemetrySuppressed,
  isTelemetryDailyTimerActive,
  sendEvent,
  sendAnonymousDiagnosticReport,
  telemetry,
  TELEMETRY_URL,
} = require('../main/services/telemetry');
const { postHogEnvironment } = require('../main/services/posthog-config');
const {
  syncPostHogIdentity,
  capturePostHogUsage,
  stopPostHog,
} = require('../main/services/posthog');
const { cloudSync } = require('../main/services/cloud-sync');
const {
  createBackup,
  restoreBackup,
  getCurrentSchemaVersion,
  getSettingValue,
  upsertSettings,
} = require('../main/db');
const { resetMasterPin } = require('../main/services/master-pin');
const { canAcceptUpdateCheckResult } = require('../main/update-state');
const {
  createAutoUpdaterErrorHandler,
  createSuspendUpdaterForOfflineMode,
  createUpdateCheckTracker,
} = require('../main/updater-shutdown');
const net = require('net');

function seedUser(db: any, id: string, role: string) {
  const email = `${id}@test.local`;
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, id, email, bcrypt.hashSync('testpass123', 10), role, now(), now());
  return {
    Authorization: `Bearer ${jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
}

async function main() {
  console.log('Offline mode');
  console.log('='.repeat(60));
  resetCounters();
  delete process.env.FLO_MATRIX_OFFLINE;
  const db = initTestDb();
  const ownerAuth = seedUser(db, 'owner-om', 'owner');
  const managerAuth = seedUser(db, 'mgr-om', 'manager');

  const app = createApp({
    '/api/settings': settingsRoutes,
    '/api/products': productRoutes,
    '/api/database': databaseRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    assertEqualOrThrow(isOfflineMode(), false, 'online by default');
    assertEqualOrThrow(
      (await api(baseUrl, '/api/settings/offline-mode', { headers: managerAuth })).data
        .offline_mode,
      false,
      'the state is readable by settings viewers',
    );

    const refused = await api(baseUrl, '/api/settings/offline-mode', {
      method: 'PUT',
      body: { offline_mode: true },
      headers: managerAuth,
    });
    assertEqualOrThrow(refused.status, 403, 'a manager cannot switch Offline mode');
    assertEqualOrThrow(isOfflineMode(), false, 'a refused change leaves the mode unchanged');

    const invalid = await api(baseUrl, '/api/settings/offline-mode', {
      method: 'PUT',
      body: { offline_mode: 'yes' },
      headers: ownerAuth,
    });
    assertEqualOrThrow(invalid.status, 400, 'a non-boolean value is rejected');

    const on = await api(baseUrl, '/api/settings/offline-mode', {
      method: 'PUT',
      body: { offline_mode: true },
      headers: ownerAuth,
    });
    assertEqualOrThrow(on.status, 200, 'the owner switches Offline mode on');
    assertEqualOrThrow(on.data.offline_mode, true, 'the response reports the new state');
    assertEqualOrThrow(isOfflineMode(), true, 'the service reads the persisted setting');

    console.log('\n--- Gated connections ---');
    let blocked = '';
    try {
      assertOnlineAllowed('Cloud sync');
    } catch (error: any) {
      blocked = error.code;
    }
    assertEqualOrThrow(blocked, 'offline_mode', 'network guards throw while Offline mode is on');
    let catalogError = '';
    try {
      await fetchRemoteTaxPackCatalog();
    } catch (error: any) {
      catalogError = error.code;
    }
    assertEqualOrThrow(catalogError, 'offline_mode', 'the tax pack catalog download is refused');
    assertEqualOrThrow(isTelemetrySuppressed(), true, 'telemetry is suppressed');
    assertEqualOrThrow(postHogEnvironment(), null, 'product analytics never connects');
    const imageImport = await api(baseUrl, '/api/products/fetch-url', {
      method: 'POST',
      body: { url: 'https://example.com/a.png' },
      headers: ownerAuth,
    });
    assertEqualOrThrow(imageImport.status, 503, 'web image import is refused');

    const off = await api(baseUrl, '/api/settings/offline-mode', {
      method: 'PUT',
      body: { offline_mode: false },
      headers: ownerAuth,
    });
    assertEqualOrThrow(off.data.offline_mode, false, 'the owner switches it back off');
    assertEqualOrThrow(isOfflineMode(), false, 'connections are allowed again');
    assertOrThrow(
      (
        await api(baseUrl, '/api/products/fetch-url', {
          method: 'POST',
          body: { url: 'http://insecure.example/a.png' },
          headers: ownerAuth,
        })
      ).status === 400,
      'image import is reachable again',
    );

    console.log('\n--- 1. Backup restore and import preserve offline_mode ---');
    {
      await api(baseUrl, '/api/settings/offline-mode', {
        method: 'PUT',
        body: { offline_mode: false },
        headers: ownerAuth,
      });
      const preOfflineBackup = await createBackup();
      assertOrThrow(Boolean(preOfflineBackup.path), 'backup created before Offline mode');

      await api(baseUrl, '/api/settings/offline-mode', {
        method: 'PUT',
        body: { offline_mode: true },
        headers: ownerAuth,
      });
      assertEqualOrThrow(isOfflineMode(), true, 'Offline mode enabled after backup');

      const directRestore = await restoreBackup(preOfflineBackup.path, true);
      assertEqualOrThrow(directRestore.success, true, 'direct restore succeeds');
      assertEqualOrThrow(
        isOfflineMode(),
        true,
        'direct restore preserves offline_mode=true from current device',
      );

      const dataOnlyBackupPath = path.join(testDir, 'pre-offline-older-schema.db');
      fs.copyFileSync(preOfflineBackup.path, dataOnlyBackupPath);
      const Database = require('better-sqlite3');
      const olderDb = new Database(dataOnlyBackupPath);
      const olderVersion = getCurrentSchemaVersion() - 1;
      olderDb.pragma(`user_version = ${olderVersion}`);
      olderDb
        .prepare("UPDATE _flo_meta SET value = ? WHERE key = 'schema_version'")
        .run(String(olderVersion));
      olderDb.close();

      const dataOnlyRestore = await restoreBackup(dataOnlyBackupPath, false);
      assertEqualOrThrow(dataOnlyRestore.success, true, 'data-only restore succeeds');
      assertEqualOrThrow(dataOnlyRestore.mode, 'data_only', 'older backup uses data-only restore');
      assertEqualOrThrow(
        isOfflineMode(),
        true,
        'data-only restore preserves offline_mode=true from current device',
      );

      resetMasterPin('1234');
      const importPayload = {
        schema_version: String(getCurrentSchemaVersion()),
        data: {
          settings: [{ key: 'offline_mode', value: 'false', updated_at: now() }],
          categories: [],
          products: [],
          users: [],
        },
      };
      const importOverwrite = await api(baseUrl, '/api/database/import', {
        method: 'POST',
        headers: ownerAuth,
        body: {
          overwrite: true,
          master_pin: '1234',
          data: importPayload,
        },
      });
      assertEqualOrThrow(importOverwrite.status, 200, 'overwrite database import succeeds');
      assertEqualOrThrow(
        isOfflineMode(),
        true,
        'overwrite database import preserves offline_mode=true',
      );

      const importMerge = await api(baseUrl, '/api/database/import', {
        method: 'POST',
        headers: ownerAuth,
        body: {
          overwrite: false,
          data: importPayload,
        },
      });
      assertEqualOrThrow(importMerge.status, 200, 'non-overwrite database import succeeds');
      assertEqualOrThrow(
        isOfflineMode(),
        true,
        'non-overwrite database import preserves offline_mode=true',
      );

      await api(baseUrl, '/api/settings/offline-mode', {
        method: 'PUT',
        body: { offline_mode: false },
        headers: ownerAuth,
      });
    }

    console.log('\n--- 2. PostHog stops without flushing when Offline mode turns on ---');
    {
      const savedNodeEnv = process.env.NODE_ENV;
      const savedCi = process.env.CI;
      const savedPostHogDev = process.env.FLO_POSTHOG_DEV;
      const savedProcessType = (process as any).type;
      const savedFetch = globalThis.fetch;
      let posthogFetchCount = 0;
      let posthogSignalAborted = false;
      let releaseInFlightFetch: (() => void) | null = null;
      const posthogFetchStarted = new Promise<void>((resolve) => {
        globalThis.fetch = (async (input: any, init?: RequestInit) => {
          if (new URL(String(input)).hostname === 'posthog.example') {
            posthogFetchCount += 1;
            init?.signal?.addEventListener(
              'abort',
              () => {
                posthogSignalAborted = true;
              },
              { once: true },
            );
            resolve();
            await new Promise<void>((done) => {
              releaseInFlightFetch = done;
              init?.signal?.addEventListener('abort', () => done(), { once: true });
            });
            if (init?.signal?.aborted) {
              const abortErr = new Error('The operation was aborted');
              abortErr.name = 'AbortError';
              throw abortErr;
            }
            return new Response(null, { status: 200 });
          }
          return savedFetch(input, init);
        }) as typeof fetch;
      });

      try {
        delete process.env.NODE_ENV;
        delete process.env.CI;
        process.env.FLO_POSTHOG_DEV = '1';
        (process as any).type = 'browser';
        upsertSettings({
          posthog_project_token: 'phc_offline_test_token',
          posthog_host: 'https://posthog.example',
          product_analytics_level: 'anonymous',
          telemetry_enabled: 'true',
        });

        syncPostHogIdentity();
        await posthogFetchStarted;
        assertEqualOrThrow(posthogFetchCount, 1, 'PostHog starts an outbound send while online');

        await api(baseUrl, '/api/settings/offline-mode', {
          method: 'PUT',
          body: { offline_mode: true },
          headers: ownerAuth,
        });
        assertEqualOrThrow(
          posthogSignalAborted,
          true,
          'enabling Offline mode aborts in-flight PostHog request',
        );
        const countAtToggle = posthogFetchCount;
        capturePostHogUsage('feature_used', { feature: 'pos' });
        await new Promise((resolve) => setTimeout(resolve, 30));
        assertEqualOrThrow(
          posthogFetchCount,
          countAtToggle,
          'PostHog does not flush or retry after Offline mode is enabled',
        );
      } finally {
        (releaseInFlightFetch as (() => void) | null)?.();
        await stopPostHog({ flush: false });
        globalThis.fetch = savedFetch;
        if (savedProcessType === undefined) delete (process as any).type;
        else (process as any).type = savedProcessType;
        if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = savedNodeEnv;
        if (savedCi === undefined) delete process.env.CI;
        else process.env.CI = savedCi;
        if (savedPostHogDev === undefined) delete process.env.FLO_POSTHOG_DEV;
        else process.env.FLO_POSTHOG_DEV = savedPostHogDev;
        await api(baseUrl, '/api/settings/offline-mode', {
          method: 'PUT',
          body: { offline_mode: false },
          headers: ownerAuth,
        });
      }
    }

    console.log(
      '\n--- 3. Pending image, tax-pack, and telemetry requests abort on Offline mode ---',
    );
    {
      // 3a. fetchPinnedHttps aborts when Offline mode turns on mid-connection.
      const sockets = new Set<any>();
      let serverEnteredHold: (() => void) | null = null;
      const serverHolding = new Promise<void>((resolve) => {
        serverEnteredHold = resolve;
      });
      const hangingServer = net.createServer((socket: any) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        serverEnteredHold?.();
      });
      await new Promise<void>((resolve) => hangingServer.listen(0, '127.0.0.1', resolve));
      const port = (hangingServer.address() as any).port;
      try {
        const pendingImage = fetchPinnedHttps(
          `https://example.com:${port}/slow.png`,
          '127.0.0.1',
        ).then(
          () => '',
          (err: any) => err?.code ?? '',
        );
        await serverHolding;
        await api(baseUrl, '/api/settings/offline-mode', {
          method: 'PUT',
          body: { offline_mode: true },
          headers: ownerAuth,
        });
        const imageErrorCode = await pendingImage;
        assertEqualOrThrow(
          imageErrorCode,
          'offline_mode',
          'in-flight fetchPinnedHttps aborts with offline_mode when Offline mode turns on',
        );

        await api(baseUrl, '/api/settings/offline-mode', {
          method: 'PUT',
          body: { offline_mode: false },
          headers: ownerAuth,
        });
        const preAbortedErrorName = await fetchPinnedHttps(
          `https://example.com:${port}/slow.png`,
          '127.0.0.1',
          AbortSignal.abort(),
        ).then(
          () => '',
          (err: any) => err?.name ?? '',
        );
        assertEqualOrThrow(
          preAbortedErrorName,
          'AbortError',
          'fetchPinnedHttps with a pre-aborted signal rejects cleanly with AbortError',
        );
      } finally {
        for (const s of sockets) s.destroy();
        await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
        await api(baseUrl, '/api/settings/offline-mode', {
          method: 'PUT',
          body: { offline_mode: false },
          headers: ownerAuth,
        });
      }

      // 3b. Tax-pack catalog and download abort in-flight and before follow-up steps.
      let taxPackFetchCalls = 0;
      let catalogSignalAborted = false;
      const pendingCatalog = fetchRemoteTaxPackCatalog(async (_url: any, init?: RequestInit) => {
        taxPackFetchCalls += 1;
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              catalogSignalAborted = true;
              const err = new Error('Aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
          notifyOfflineModeEnabled();
        });
        return new Response('[]', { status: 200 });
      });
      let taxCatalogErrCode = '';
      try {
        await pendingCatalog;
      } catch (err: any) {
        taxCatalogErrCode = err?.code ?? '';
      }
      assertEqualOrThrow(
        catalogSignalAborted,
        true,
        'tax-pack catalog fetch signal aborted on Offline mode',
      );
      assertEqualOrThrow(
        taxCatalogErrCode,
        'offline_mode',
        'aborted tax-pack catalog throws OfflineModeError',
      );
      assertEqualOrThrow(
        taxPackFetchCalls,
        1,
        'tax-pack catalog made no follow-up requests after abort',
      );

      let stepTwoCalled = false;
      const multiStepCatalog = fetchRemoteTaxPackCatalog(async (url: any) => {
        if (new URL(String(url)).pathname.endsWith('/releases')) {
          upsertSettings({ offline_mode: 'true' });
          return new Response(
            JSON.stringify([
              {
                tag_name: 'tax-pack-official-india-v1.0.0',
                html_url: 'https://github.com/FreeOpenSourcePOS/FloCafe-Plugins/releases/tag/v1',
                draft: false,
                assets: [
                  {
                    name: 'catalog.json',
                    browser_download_url:
                      'https://github.com/FreeOpenSourcePOS/FloCafe-Plugins/releases/download/tax-pack-official-india-v1.0.0/catalog.json',
                  },
                ],
              },
            ]),
            { status: 200 },
          );
        }
        stepTwoCalled = true;
        return new Response('{}', { status: 200 });
      });
      let multiStepErrCode = '';
      try {
        await multiStepCatalog;
      } catch (err: any) {
        multiStepErrCode = err?.code ?? '';
      } finally {
        upsertSettings({ offline_mode: 'false' });
      }
      assertEqualOrThrow(
        multiStepErrCode,
        'offline_mode',
        'tax-pack catalog re-checks Offline mode before downloading asset',
      );
      assertEqualOrThrow(
        stepTwoCalled,
        false,
        'tax-pack catalog skips second download step once Offline mode is on',
      );

      let packDownloadAborted = false;
      const validEntry = {
        id: 'official-india',
        publisher: 'FreeOpenSourcePOS',
        country: 'IN',
        jurisdiction: 'India GST',
        version: '1.0.0',
        publishedAt: '2026-01-01T00:00:00Z',
        minFloVersion: '1.0.0',
        digest: 'a'.repeat(64),
        downloadUrl:
          'https://github.com/FreeOpenSourcePOS/FloCafe-Plugins/releases/download/tax-pack-official-india-v1.0.0/pack.json',
        signatureUrl:
          'https://github.com/FreeOpenSourcePOS/FloCafe-Plugins/releases/download/tax-pack-official-india-v1.0.0/pack.json.sig',
      };
      let downloadPackErrCode = '';
      try {
        await downloadAndVerifyTaxPack(validEntry, async (_url: any, init?: RequestInit) => {
          await new Promise<void>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                packDownloadAborted = true;
                const err = new Error('Aborted');
                err.name = 'AbortError';
                reject(err);
              },
              { once: true },
            );
            notifyOfflineModeEnabled();
          });
          return new Response('{}', { status: 200 });
        });
      } catch (err: any) {
        downloadPackErrCode = err?.code ?? '';
      }
      assertEqualOrThrow(
        packDownloadAborted,
        true,
        'tax-pack artifact download signal aborts on Offline mode',
      );
      assertEqualOrThrow(
        downloadPackErrCode,
        'offline_mode',
        'aborted tax-pack download throws OfflineModeError',
      );

      // 3c. Anonymous telemetry sendEvent and sendAnonymousDiagnosticReport abort on Offline mode.
      const savedNodeEnv = process.env.NODE_ENV;
      const savedCi = process.env.CI;
      const savedTelemetryDev = process.env.FLO_TELEMETRY_DEV;
      const savedFetch = globalThis.fetch;
      try {
        delete process.env.NODE_ENV;
        delete process.env.CI;
        process.env.FLO_TELEMETRY_DEV = '1';
        upsertSettings({
          telemetry_enabled: 'true',
          diagnostics_consent: 'enabled',
          diagnostics_transmission_enabled: 'true',
          diagnostics_settings_explicit: '1',
        });

        let telemetryAborted = false;
        globalThis.fetch = (async (_input: any, init?: RequestInit) => {
          await new Promise<void>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                telemetryAborted = true;
                const err = new Error('Aborted');
                err.name = 'AbortError';
                reject(err);
              },
              { once: true },
            );
            notifyOfflineModeEnabled();
          });
          return new Response(null, { status: 204 });
        }) as typeof fetch;

        const sent = await sendEvent('feature_used', { feature: 'pos' });
        assertEqualOrThrow(
          telemetryAborted,
          true,
          'in-flight telemetry sendEvent aborts on Offline mode',
        );
        assertEqualOrThrow(sent, false, 'aborted telemetry sendEvent resolves to false');

        let diagAborted = false;
        globalThis.fetch = (async (_input: any, init?: RequestInit) => {
          await new Promise<void>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                diagAborted = true;
                const err = new Error('Aborted');
                err.name = 'AbortError';
                reject(err);
              },
              { once: true },
            );
            notifyOfflineModeEnabled();
          });
          return new Response(null, { status: 200 });
        }) as typeof fetch;

        const diagResult = await sendAnonymousDiagnosticReport({
          schema_version: 2,
          report_id: '11111111-1111-4111-8111-111111111111',
          reason_code: 'storage.retry_state_unavailable',
          classification: 'unexpected_failure',
          operation: 'order.create',
          stage: 'local_storage',
          outcome: 'not_applied',
          capture_point: 'fc.frontend.pos.order.create.retry_storage',
          count: 1,
          window_start: '2026-01-01T00:00:00Z',
          first_occurred_at: '2026-01-01T00:10:00Z',
          last_occurred_at: '2026-01-01T00:10:00Z',
          app_version: '1.0.0',
          app_build: 'test',
          platform: 'darwin',
          facts: {},
          examples: [{ correlation_id: '22222222-2222-4222-8222-222222222222' }],
        });
        assertEqualOrThrow(
          diagAborted,
          true,
          'in-flight anonymous diagnostic report aborts on Offline mode',
        );
        assertEqualOrThrow(
          diagResult.disposition,
          'network_error',
          'aborted anonymous diagnostic report returns network_error',
        );
      } finally {
        globalThis.fetch = savedFetch;
        if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = savedNodeEnv;
        if (savedCi === undefined) delete process.env.CI;
        else process.env.CI = savedCi;
        if (savedTelemetryDev === undefined) delete process.env.FLO_TELEMETRY_DEV;
        else process.env.FLO_TELEMETRY_DEV = savedTelemetryDev;
      }
    }

    console.log('\n--- 4. Leaving Offline mode re-arms telemetry and PostHog daily checks ---');
    {
      const savedNodeEnv = process.env.NODE_ENV;
      const savedCi = process.env.CI;
      const savedTelemetryDev = process.env.FLO_TELEMETRY_DEV;
      const savedFetch = globalThis.fetch;
      const telemetryEvents: string[] = [];
      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        if (String(input) === TELEMETRY_URL) {
          try {
            const parsed = JSON.parse(String(init?.body || '{}'));
            if (typeof parsed.event_type === 'string') telemetryEvents.push(parsed.event_type);
          } catch {}
          return new Response(null, { status: 204 });
        }
        return savedFetch(input, init);
      }) as typeof fetch;
      try {
        delete process.env.NODE_ENV;
        delete process.env.CI;
        process.env.FLO_TELEMETRY_DEV = '1';
        upsertSettings({ offline_mode: 'true', telemetry_enabled: 'true' });
        telemetry.start();
        assertEqualOrThrow(
          isTelemetryDailyTimerActive(),
          false,
          'launching with Offline mode saved does not arm dailyPingTimer',
        );

        await api(baseUrl, '/api/settings/offline-mode', {
          method: 'PUT',
          body: { offline_mode: false },
          headers: ownerAuth,
        });
        assertEqualOrThrow(
          isTelemetryDailyTimerActive(),
          true,
          'turning Offline mode off re-arms dailyPingTimer via telemetry.resumeDailyChecks()',
        );
        assertEqualOrThrow(
          telemetryEvents.includes('app_launch'),
          false,
          'leaving Offline mode does not send duplicate app_launch events',
        );

        await api(baseUrl, '/api/settings/offline-mode', {
          method: 'PUT',
          body: { offline_mode: false },
          headers: ownerAuth,
        });
        assertEqualOrThrow(
          telemetryEvents.includes('app_launch'),
          false,
          'writing offline_mode=false while already online does not send app_launch',
        );

        await api(baseUrl, '/api/settings/offline-mode', {
          method: 'PUT',
          body: { offline_mode: true },
          headers: ownerAuth,
        });
        assertEqualOrThrow(
          isTelemetryDailyTimerActive(),
          false,
          'turning Offline mode back on stops dailyPingTimer',
        );
      } finally {
        await telemetry.stop();
        globalThis.fetch = savedFetch;
        if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = savedNodeEnv;
        if (savedCi === undefined) delete process.env.CI;
        else process.env.CI = savedCi;
        if (savedTelemetryDev === undefined) delete process.env.FLO_TELEMETRY_DEV;
        else process.env.FLO_TELEMETRY_DEV = savedTelemetryDev;
        await api(baseUrl, '/api/settings/offline-mode', {
          method: 'PUT',
          body: { offline_mode: false },
          headers: ownerAuth,
        });
      }
    }

    console.log('\n--- 5. Offline mode stops cloud auto-registration retry loop ---');
    {
      const originalRegister = cloudSync.register.bind(cloudSync);
      const prevRuntimeStarted = (cloudSync as any).runtimeStarted;
      let registerCalls = 0;
      let notifyRegisterStarted: (() => void) | null = null;
      const registerStarted = new Promise<void>((resolve) => {
        notifyRegisterStarted = resolve;
      });
      let rejectRegister: ((err: Error) => void) | null = null;

      cloudSync.register = (() => {
        registerCalls += 1;
        notifyRegisterStarted?.();
        return new Promise((_resolve, reject) => {
          rejectRegister = reject;
        });
      }) as any;

      try {
        upsertSettings({
          offline_mode: 'false',
          cloud_sync_enabled: '1',
          cloud_services_disabled_by_user: 'false',
          business_name: 'Offline Retry Test Cafe',
          cloud_registration_status: '',
        });
        (cloudSync as any).runtimeStarted = true;
        (cloudSync as any).autoRegisterAttempts = 0;
        cloudSync.refreshRegistrationProfile();
        await registerStarted;
        assertEqualOrThrow(registerCalls, 1, 'auto-registration starts while online');

        await api(baseUrl, '/api/settings/offline-mode', {
          method: 'PUT',
          body: { offline_mode: true },
          headers: ownerAuth,
        });
        (rejectRegister as ((err: Error) => void) | null)?.(new Error('Aborted for offline mode'));
        await new Promise((resolve) => setTimeout(resolve, 30));

        assertEqualOrThrow(
          (cloudSync as any).autoRegisterTimer,
          null,
          'aborted registration does not schedule a retry timer while Offline mode is on',
        );
        assertEqualOrThrow(
          registerCalls,
          1,
          'attemptAutoRegister is not re-entered while Offline mode is on',
        );
        assertEqualOrThrow(
          getSettingValue('cloud_registration_status') ?? '',
          '',
          'intentional Offline mode does not record registration_failed',
        );
      } finally {
        cloudSync.register = originalRegister;
        (cloudSync as any).runtimeStarted = prevRuntimeStarted;
        if ((cloudSync as any).autoRegisterTimer) {
          clearTimeout((cloudSync as any).autoRegisterTimer);
          (cloudSync as any).autoRegisterTimer = null;
        }
        (cloudSync as any).autoRegisterInFlight = false;
        await api(baseUrl, '/api/settings/offline-mode', {
          method: 'PUT',
          body: { offline_mode: false },
          headers: ownerAuth,
        });
      }
    }

    console.log(
      '\n--- 6. Updater suspends in-flight checks and ignores late results in Offline mode ---',
    );
    {
      let phase: 'check' | 'download' = 'check';
      let status: any = { status: 'checking' };
      let offline = false;
      let downloadCancelled = false;
      let settleFirstCheck: (() => void) | null = null;
      let secondCheckStarted = false;

      const tracker = createUpdateCheckTracker({
        shouldRunDeferredCheck: () => !offline,
      });
      const firstCheckId = tracker.beginCheck(
        () =>
          new Promise<void>((resolve) => {
            settleFirstCheck = resolve;
          }),
      );
      assertEqualOrThrow(firstCheckId, 1, 'initial online update check starts immediately');

      const suspendUpdater = createSuspendUpdaterForOfflineMode({
        getPhase: () => phase,
        setPhase: (next) => {
          phase = next;
        },
        getStatus: () => status,
        setUpdateStatus: (next) => {
          status = next;
        },
        cancelDownload: () => {
          downloadCancelled = true;
        },
        invalidateCheck: () => {
          tracker.invalidateActiveCheck();
        },
      });

      offline = true;
      suspendUpdater();
      assertEqualOrThrow(
        status.status,
        'offline',
        'enabling Offline mode during an in-flight check transitions status to offline',
      );
      assertEqualOrThrow(
        downloadCancelled,
        false,
        'suspending during a check invalidates the check without touching download token',
      );
      assertEqualOrThrow(
        canAcceptUpdateCheckResult(status, phase, offline, tracker.canAcceptCheckEvent()),
        false,
        'late update-available/update-not-available result is rejected while Offline mode is on',
      );

      const handleError = createAutoUpdaterErrorHandler({
        getPhase: () => phase,
        setPhase: (next) => {
          phase = next;
        },
        isInstallReady: () => false,
        isInstallingUpdate: () => false,
        isOfflineSuppressed: () => offline,
        isStaleCheckSuppressed: () => phase === 'check' && !tracker.canAcceptCheckEvent(),
        setUpdateStatus: (next) => {
          status = next;
        },
        onInstallFailure: () => {},
        logInfo: () => {},
      });
      handleError(new Error('HTTP 500 from update feed'));
      assertEqualOrThrow(
        status.status,
        'offline',
        'late error from invalidated check preserves offline status instead of check-failed',
      );

      // Reconnect and start another check while the pre-offline check is still pending.
      offline = false;
      phase = 'check';
      status = { status: 'checking' };
      const queuedCheckId = tracker.beginCheck(() => {
        secondCheckStarted = true;
        return Promise.resolve();
      });
      assertEqualOrThrow(
        queuedCheckId,
        null,
        'new check after reconnect waits for the invalidated check to settle',
      );
      assertEqualOrThrow(
        canAcceptUpdateCheckResult(status, phase, offline, tracker.canAcceptCheckEvent()),
        false,
        'late result from pre-offline check is blocked even after reconnecting and starting a new check',
      );
      handleError(new Error('Stale check error after reconnect'));
      assertEqualOrThrow(
        status.status,
        'checking',
        'stale error from pre-offline check does not clobber the new check status after reconnect',
      );

      (settleFirstCheck as (() => void) | null)?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assertEqualOrThrow(
        secondCheckStarted,
        true,
        'queued check starts once the invalidated pre-offline check settles',
      );
      assertEqualOrThrow(
        canAcceptUpdateCheckResult(status, phase, offline, tracker.canAcceptCheckEvent()),
        true,
        'new check result is accepted after the invalidated check settles',
      );
    }
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`\n${results.passed}/${results.total} passed`);
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});

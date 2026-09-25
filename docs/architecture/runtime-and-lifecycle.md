# Runtime and lifecycle

The main process owns startup, shutdown, and recovery. This page describes the order each phase
runs in and the rules that make a partially-started runtime safe to observe.

The relevant code is [`main/index.ts`](../../main/index.ts) (orchestration),
[`main/runtime-recovery.ts`](../../main/runtime-recovery.ts) (the pure decision functions), and
[`main/shutdown.ts`](../../main/shutdown.ts) (drain and timeout primitives).

## Runtime state

`runtimeState` is one of `starting`, `ready`, `stopping`, or `failed`, and it is only ever set in
`main/index.ts`. Two pure functions in `main/runtime-recovery.ts` read it:

- `isRuntimeHealthy(state, services, shutdownRequested)` is true only when the state is `ready`,
  shutdown has not been requested, and all three servers report running. The `services` argument is
  built by `getRuntimeServices()`, which asks `isServerRunning()`, `isKdsServerRunning()`, and
  `isServerAppRunning()`. A server that is still binding therefore makes the runtime unhealthy.
- `decideRuntimeActivationAction(...)` maps state onto one of `show`, `create`, `wait`,
  `relaunch`, or `ignore`.

Both functions are deliberately pure and exported, and the suite in `tests/` exercises them without
booting Electron.

## Startup order

`initialize()` runs once, from `app.whenReady()`. Every step checks the shutdown flag before
continuing, so a quit during startup unwinds instead of half-starting:

1. `initDatabase()`.
2. `await startServer()` - the main API on `:3001`.
3. `cloudSync.start()`, `telemetry.start()`, `googleDrive.start()`. These are launched without
   `await`: no optional network service may delay or fail startup.
4. `await startKdsServer()` - the KDS server on `:3002`.
5. `await startServerApp()` - the server app on `:3003`.
6. `startMdns()`, unless `FLO_E2E_SKIP_OPTIONAL_NETWORK` is `1`.
7. `await initPrinter()`.
8. IPC handler registration.
9. `runtimeState = 'ready'`, and the relaunch guard is marked recovered.
10. `createWindow()`, then power-monitor recovery, child-process crash telemetry, the tray, and the
    application menu.
11. On a non-store build, the auto-updater is configured and a delayed update check runs. Store
    builds report a `store-managed` one-shot status instead.

If any step throws, the state becomes `failed`, the error is reported to telemetry on a best-effort
basis, cleanup runs, and the process exits with code 1. A `SchemaVersionMismatchError` adds the
database and application schema versions to that report. A shutdown that interrupts startup is not
treated as a failure.

## No window without a healthy runtime

`createWindow()` returns early and requests a relaunch unless `isRuntimeHealthy()` holds. The rule
is deliberate: a window whose data plane is not listening would show a broken POS, and the app
would have no way to recover from it. The same guard runs in `showMainWindow()` and in
`recoverFailedWindow()`.

## Activation

`handleMainWindowActivation()` asks `decideRuntimeActivationAction` what to do, and the mapping is
the whole policy:

| Situation | Action |
| --- | --- |
| Shutdown requested, or state is `stopping` | `ignore` |
| State is `failed` | `relaunch` |
| State is `starting` | `wait` |
| Not healthy, for any other reason | `relaunch` |
| Healthy and a window exists | `show` |
| Healthy and no window exists | `create` |

If the user activates the app while startup is still running, the request is recorded as pending and
replayed when `initialize()` settles. If startup fails while an activation is pending, a relaunch is
requested instead.

## Relaunch gating

Relaunches are gated on three levels so a broken install cannot loop.

1. **Within a process.** `createRelaunchGate` returns a one-shot function; every later call in the
   same process is ignored.
2. **Across process restarts.** `RUNTIME_RELAUNCH_ATTEMPT_FLAG` is appended to the relaunch argv.
   `hasRelaunchAttemptFlag` detects it on the next boot.
3. **Until recovery.** `createRelaunchAttemptGuard` treats the attempt as exhausted only while the
   process has not yet recovered. `markRuntimeRecovered()` is called the moment the runtime reaches
   `ready`, so a later, genuine failure can still relaunch.

When the gate reports exhaustion, `showRuntimeStuckDialog` presents the service states, the last
window load error if there was one, and the platform and version, and offers a diagnostic report
that carries no order, customer, or business data.

`performAppRelaunch` preserves the flags a relaunch depends on: `--disable-gpu` when GPU fallback
was triggered, and `--no-sandbox` and `--disable-dev-shm-usage` when they were already set, so
Playwright and CI runs survive the restart.

## Window load failures

A window whose document URL has become `chrome-error://` is treated as a failed load.
`recoverFailedWindow` rebuilds the window once, guarded by `windowLoadRecoveryAttempted`. A second
failure, or a runtime that is not healthy, requests a relaunch rather than looping.

## Shutdown order

`createShutdownCoordinator` runs an ordered step list exactly once and shares a single promise
across all callers, so `before-quit`, `will-quit`, `SIGINT`, and `SIGTERM` cannot run cleanup twice.

The steps run in this order, which drains dependents before the things they depend on:

| # | Step | Blocks the database |
| --- | --- | --- |
| 1 | tray | no |
| 2 | shared raster renderer surface | no |
| 3 | Server App | yes |
| 4 | Main server | yes |
| 5 | KDS server | yes |
| 6 | cloud sync | yes |
| 7 | telemetry | yes |
| 8 | Google Drive | yes |
| 9 | WhatsApp | yes |
| 10 | Bonjour / mDNS | no |
| 11 | HTTP handler drain | yes |
| 12 | database admission | yes |
| 13 | database request drain | yes |
| 14 | close the database | close step |

Every HTTP listener is stopped before the database so that no handler can begin new database work
after the drain starts. The close step is skipped if any earlier step that blocks the database
failed, which leaves the file handle open rather than closing it under an in-flight request.

Each step is bounded by `SHUTDOWN_TIMEOUT_MS` (10 seconds). A timeout is fatal: the coordinator
calls `onFatalTimeout` and rethrows. The app exits with code 1 on a fatal timeout, except during
update installation or a relaunch, where the caller still needs the process alive.

Closing the main window does not quit the app. The window `close` handler calls `preventDefault()`
and hides the window unless quitting, so a hidden POS keeps serving. `window-all-closed` quits on
every platform except macOS, and even then only when no window recovery is in progress.

## `node dev-server.js` diverges from the packaged app

`dev-server.js` is the supported way to run the backend without Electron, and it is useful for API
work. It is **not** a faithful subset of startup: a developer debugging against it sees a
materially different service set than a packaged install.

`dev-server.js` mocks the `electron` module and then calls `startStandaloneServers` from
[`main/standalone-startup.ts`](../../main/standalone-startup.ts), which does exactly this:

1. `initDatabase()`
2. `startServer()`
3. `startKdsServer()`
4. `startServerApp()`

Everything else that `initialize()` starts is absent:

| Service | Started by `dev-server.js`? |
| --- | --- |
| Main API, KDS, Server App, database | yes |
| cloud sync, telemetry, Google Drive | no |
| mDNS advertisement | no |
| Printer initialization | no |
| Electron windows, tray, menu, auto-updater, power-monitor recovery | no, there is no Electron runtime |

Its shutdown path is a hand-written sequence that mirrors the drain order but skips the tray, raster
surface, cloud sync, telemetry, Google Drive, and mDNS steps, because those services were never
started.

**Practical rule:** reproduce a cloud-sync, backup, printer, or LAN-discovery bug against a packaged
build, not against `dev-server.js`. If a behaviour only appears under `npm run dev`, check whether
`initialize()` does something `startStandaloneServers` does not.

## Uncaught failures outside the lifecycle

`uncaughtException` and `unhandledRejection` are logged and reported to telemetry. They do not by
themselves trigger cleanup; the shutdown entrypoints decide whether the process is exiting.

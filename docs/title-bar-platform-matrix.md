# Title-bar platform test matrix

**Status:** CURRENT verification record for epic #457 / issue #462 remainder

**Date:** 2026-08-24
**Related changes:** #505 (sidebar offset), #508 (overlay color tokens), #509 (Linux fallback controls and `windowAction` IPC)

This record uses assertion and log evidence first. The Linux XWD capture is supplementary evidence; no screenshot is required for a cell to pass.

## Evidence index

| Evidence | What it covers |
| --- | --- |
| [`tests/platform-titlebar-runtime-probe.cjs`](../tests/platform-titlebar-runtime-probe.cjs) | Cross-platform Electron mode resolution, window option shape, 40 DIP overlay configuration, fallback gating, and window-action validation. |
| [`tests/titlebar-window-options.test.ts`](../tests/titlebar-window-options.test.ts) | Main-window option and fallback decision contract. |
| [`tests/window-readiness.test.ts`](../tests/window-readiness.test.ts) | Epoch/nonce-bound renderer readiness and fail-safe contract. |
| [`tests/electron-api-contract.test.ts`](../tests/electron-api-contract.test.ts) | Preload `windowAction` and `windowReady` contract. |
| [`frontend/e2e/title-bar-platform.spec.ts`](../frontend/e2e/title-bar-platform.spec.ts) | Browser/LAN multi-viewport and #504 sidebar regression checks. |
| [`frontend/e2e/layout-integrity.spec.ts`](../frontend/e2e/layout-integrity.spec.ts) | Existing browser/LAN geometry and zero-title-bar checks. |
| [`docs/images/title-bar-platform-matrix/linux-runtime-probe.log`](images/title-bar-platform-matrix/linux-runtime-probe.log) | Debian 13 GNOME, Electron 43.4.1, Xvfb: 9/9 probe checks passed; WM-dependent action round-trip explicitly skipped because Xvfb had no WM. |
| [`docs/images/title-bar-platform-matrix/appimage-run-summary.log`](images/title-bar-platform-matrix/appimage-run-summary.log) | Current-branch packaged AppImage startup under dedicated Xvfb display. |
| [`docs/images/title-bar-platform-matrix/health-response.json`](images/title-bar-platform-matrix/health-response.json) | Fresh packaged-AppImage `/api/health` assertion: `status=ok`, `db=ok`. |
| [`docs/images/title-bar-platform-matrix/gnome-button-layout.txt`](images/title-bar-platform-matrix/gnome-button-layout.txt) | Real Debian GNOME `button-layout='appmenu:close'` observation. |
| [`docs/images/title-bar-platform-matrix/linux-appimage-root.xwd`](images/title-bar-platform-matrix/linux-appimage-root.xwd) | Supplementary Xvfb root-window capture from the packaged-AppImage run. |
| [title-bar phase 1/2 note](title-bar-phase1.md) | Existing GNOME hardware verification, native overlay safe-area behavior, and close-only default context. |

## Matrix

### 1. Windows (`windows-latest`)

The workflow is [`.github/workflows/title-bar-platform-matrix.yml`](../.github/workflows/title-bar-platform-matrix.yml). The runtime probe is designed to run in the hosted Windows desktop session; the pull-request check is the authoritative runner evidence.

| Cell | Result | Evidence / reason |
| --- | --- | --- |
| Overlay renders | **NOT-RUN** | The hosted Windows probe is assertion-based and creates a hidden window, so it verifies constructor configuration but does not observe visible native overlay pixels. A visible shell-rendering session was not captured. |
| Drag regions work | **NOT-RUN** | Requires physical pointer interaction with the native caption/drag region. The renderer contract is covered by `DesktopDragSurface` and the browser/LAN test proves the surface is absent outside Electron. |
| Snap Layouts hover on maximize | **NOT-RUN** | Requires a real Windows shell pointer hover over the native maximize button. Native overlay delegates caption buttons to Windows, so this is not reproducible in the cross-platform Electron probe. |
| Double-click maximize | **NOT-RUN** | Requires a real double-click on the native caption/drag region; no synthetic shell input is used. The `toggle-maximize` verb is covered separately by the runtime probe where the window manager permits it. |
| 100/125/150/175% DPI bar height | **PASS-verified (configuration)** | Overlay height is asserted as **40 device-independent pixels**. Windows applies monitor scale to DIPs; the hosted runner does not provide four independent physical-DPI sessions, so per-scale visual interaction is **NOT-RUN**. |

### 2. Linux packaged AppImage under Xvfb (Debian 13 GNOME machine)

The AppImage was built from this branch with `electron-builder --linux AppImage --publish never`, then launched with `--appimage-extract-and-run` on a dedicated `:77` Xvfb display. No sudo, package installation, or desktop-session interaction was used.

| Cell | Result | Evidence / reason |
| --- | --- | --- |
| Native-overlay vs HTML-fallback decision | **PASS-verified** | [`linux-runtime-probe.log`](images/title-bar-platform-matrix/linux-runtime-probe.log) reports `platform=linux`, `overlayApiPresent=true`, `resolved=native-overlay`, and separately verifies missing API, pre-33, and unknown-platform inputs fail closed to `html-fallback`. |
| Native overlay option is 40px high | **PASS-verified** | Probe asserts the actual constructor option: `titleBarOverlay={color:#ffffff,symbolColor:#0a0a0a,height:40}`. Electron's Linux getter is unsupported and is logged as such; constructor options are the authoritative assertion. |
| Packaged AppImage starts and serves | **PASS-verified** | [`appimage-run-summary.log`](images/title-bar-platform-matrix/appimage-run-summary.log) records the packaged server, KDS, IPC registration, window creation, and `Flo Ready` startup path. A fresh health assertion is preserved in [`health-response.json`](images/title-bar-platform-matrix/health-response.json): `status=ok`, `db=ok`. |
| Fallback min/max/close through `windowAction` IPC | **NOT-RUN (end-to-end)** | The narrow action contract is **PASS-verified** by the helper and preload tests, but this run did not invoke the registered main IPC handler from a live fallback renderer; Linux Xvfb also has no window manager for a real state round-trip. The probe records that environment skip rather than overstating direct-helper coverage as IPC proof. |
| GNOME close-only default | **PASS-verified** | `gsettings` on the real Debian GNOME machine reports `button-layout='appmenu:close'`; the existing GNOME hardware observation is also recorded in [`title-bar-phase1.md`](title-bar-phase1.md). |
| X11 | **PASS-verified** | The packaged run and runtime probe ran on X11/Xvfb (`DISPLAY=:77`). |
| Wayland | **NOT-RUN** | The safety boundary forbids touching the existing GNOME desktop session; a separate Wayland compositor/session was not started. Existing hardware notes describe GNOME behavior but do not claim a Wayland-specific run. |
| Visual screenshot | **NOT-RUN (supplementary capture only)** | [`linux-appimage-root.xwd`](images/title-bar-platform-matrix/linux-appimage-root.xwd) is retained as a supplementary Xvfb root capture; it is not used as the authoritative visual assertion. Logs/assertions are authoritative. |

### 3. macOS local

The local runtime is macOS with Electron 43.4.1. `npx electron tests/platform-titlebar-runtime-probe.cjs --fullscreen-check` completed **14/14** checks.

| Cell | Result | Evidence / reason |
| --- | --- | --- |
| `hiddenInset` and traffic-light centering in 40px bar | **PASS-verified (runtime configuration)** | The probe constructs a real Electron `BrowserWindow` through an observing constructor and asserts `titleBarStyle=hiddenInset` plus `trafficLightPosition={x:16,y:14}`; `(40-12)/2=14` centers the 12px traffic lights. Pixel-level visual capture was not independently performed. macOS resolves to `native-overlay` via native traffic lights and never needs HTML fallback caption buttons. |
| Fullscreen enter/exit | **PASS-verified** | The local `--fullscreen-check` probe entered and exited native fullscreen and asserted both states. |
| Kiosk mode | **NOT-RUN** | No kiosk codepath or `setKiosk` usage exists in the current FloCafe source. This is a product-scope finding, not an unverified claim. |
| RTL/Persian (`fa`) logical-property layout | **PASS-verified** | `tests/rtl-foundation.test.ts`, `tests/rtl-dashboard-pos-common.test.ts`, `tests/rtl-setup-auth-settings.test.ts`, and the corresponding existing Playwright coverage pass. Title-bar CSS uses logical inline/block properties; no physical left/right fallback-control placement was added. |

### 4. Browser/LAN at multiple viewports

**PASS-verified.** `cd frontend && npx playwright test title-bar-platform layout-integrity` ran 4/4 tests successfully. The new spec checks 1024x768, 1440x900, and 1920x1080 across POS, settings, and KDS, asserting no Electron API, title-bar markup, drag surface, fallback controls, or desktop CSS flag. It also checks the fixed sidebar geometry in expanded and collapsed states.

### 5. Sidebar-offset regression (#504/#505)

**PASS-verified.** The same Playwright run checks expanded and collapsed/rail states on POS and settings at all three md+ viewports, plus the KDS and browser/LAN route geometry in the existing layout-integrity test. Browser mode remains at viewport top (`0px`); forcing the Electron capability flag moves the sidebar to the 40px title-bar boundary.

## Findings

1. **Packaged Electron hydration failure on Linux first-run/auth routes.** In the packaged AppImage under Xvfb, the renderer loaded `/setup/` and `/auth/login/` with `window.electronAPI.getStatus` and `windowReady` present, but React error #418 (hydration text mismatch) aborted client hydration. Consequently `DesktopDragSurface`/`WindowControls` did not mount and the readiness fail-safe logged after 10 seconds: `the renderer never confirmed its window-control surface`. The fail-safe made the window visible rather than leaving it hidden, but end-to-end renderer-control readiness on these routes is not verified by the AppImage run. Plain browser/LAN loading did not reproduce the error. This is recorded for the PR rather than silently expanding scope.
2. **Linux `getTitleBarOverlay()` is not a usable assertion.** Electron 43 returned `undefined` on Linux even though the real window was constructed with the overlay options. The probe therefore asserts Linux constructor options and logs the getter limitation; this is an Electron API/platform limitation, not treated as a product failure.
3. **Kiosk mode is absent.** The macOS kiosk cell is explicitly NOT-RUN because there is no implementation to exercise.
4. **WM-dependent Linux actions are environment-limited.** Xvfb was intentionally run without a window manager to avoid touching the captain's GNOME desktop session; minimize/maximize state transitions are consequently recorded as SKIP in the probe while IPC verb validation remains PASS.

No product behavior was changed in response to these findings; the matrix deliberately downgrades unobserved visual/IPC cells to NOT-RUN and keeps the contract evidence separate.

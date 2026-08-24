# Native-controls title bar - Phase 1

**Status: CURRENT implementation note (Refs #457)**

**Phase 2 update (#458):** the overlay colors now resolve from shared tokens in `main/title-bar-theme.ts` instead of inline constants, a `nativeTheme` listener applies light/dark overlay updates at runtime on macOS/Windows (no-op elsewhere), and macOS traffic lights sit vertically centered in the 40px bar via `trafficLightPosition`.

Phase 1 gives the main POS Electron window a small native-controls title-bar foundation without removing the OS window frame:

- macOS uses `hiddenInset`; Windows and Linux use `hidden`.
- Native-overlay mode uses an explicit 40px `titleBarOverlay` height with opaque colors. Electron supplies the native caption buttons in that mode, preserving platform accessibility and Windows Snap Layout behavior; fallback mode drops the overlay and supplies equivalent HTML controls from the root renderer chrome.
- The renderer `TitleBar` component is mounted only by the dashboard layout and only after the existing `window.electronAPI?.getStatus` capability is present. Detection is capability-based rather than user-agent-based, so LAN/browser clients receive no Electron-only title-bar markup.
- When that Electron capability is present, the fixed desktop dashboard sidebar starts below the same 40px title bar and its height is reduced accordingly. The capability flag is CSS-only; browser/LAN layouts keep the sidebar pinned to the viewport top, while mobile uses the existing sheet path.
- A root-level Electron-only drag surface keeps auth, setup, and loading screens draggable without adding normal-flow height or changing browser/LAN layout geometry.
- The bar displays the current store and staff context and reuses the existing update badge. Its layout uses Window Controls Overlay safe-area environment variables, logical spacing, and explicit drag/no-drag regions for interactive content.
- The existing `StatusBar` remains the dashboard footer because its server, port, memory, and uptime metrics are a wider footer contract; the title bar does not duplicate it. `UpdateBadge` is reused because its compact native update action fits the bar. The POS-only `PrinterStatus` toolbar component is not mounted here: it owns WebUSB/API printer state rather than a title-bar capability, so Phase 1 adds no printer polling or new printer IPC.

## Phase 2: Linux verification and HTML fallback controls

### Native overlay verification evidence (2026-08-24)

The captain verified the native `titleBarOverlay` on Debian + GNOME on real hardware with Electron 43.4.0: the window renders with native caption buttons, no control-less hidden bar, and the renderer bar's safe-area spacing correctly excludes the button strip.

Two GNOME-specific behaviors are worth recording:

- **Close-only default layout.** GNOME's default `button-layout` for decorations is close-only. Electron 43+ respects the desktop environment's button layout when drawing overlay caption buttons, so on stock GNOME the overlay shows only a close button. This is correct platform behavior, not a bug; users who customize `button-layout` via gnome-tweaks get their configured buttons in the overlay.
- **Safe-area behavior.** Chromium reports the WCO safe-area environment variables (`titlebar-area-*`) consumed by `.flo-title-bar__safe-area`; they exclude the overlay button strip and update on `geometrychange`. On GNOME the strip width reflects the DE-configured button set, so content padding adapts automatically.

### Runtime fallback gating

Phase 2 adds a defensive runtime decision so no platform can end up hidden-with-no-controls if the overlay is unavailable or broken:

1. `main/window-options.ts` exports `resolveTitleBarMode({ platform, electronVersion, overlayApiPresent })`. It resolves to `'native-overlay'` only when the platform is darwin/win32/linux, the Electron major version is >= 33 (the point where WCO-style overlays became dependable across supported platforms), and a runtime probe confirms `BrowserWindow.prototype.setTitleBarOverlay` exists. Anything else resolves to `'html-fallback'` - unknown platforms, old runtimes, and missing APIs all fail closed.
2. `createWindow()` in `main/index.ts` resolves the mode once per window creation using `process.platform`, `process.versions.electron`, and the live prototype probe, then builds the window without `titleBarOverlay` options in fallback mode (the frame stays intact with `titleBarStyle: 'hidden'`; only the overlay is dropped).
3. Main reports the resolved mode to the renderer through the existing `get-status` payload as `titleBarMode`. The renderer type keeps this field optional so a newer renderer remains compatible with an older main, which continues its Phase 1 behavior.
4. The root renderer chrome (`frontend/src/components/layout/WindowControls.tsx`, mounted from `DesktopDragSurface` on every route) reads `titleBarMode` from `getStatus()` and mounts minimal min/max/close buttons. Readiness is fail-safe: the one-shot `windowReady()` signal fires immediately on mount and again from a 3s fail-safe timer, independent of mode resolution, so `getStatus()` rejecting, hanging, or returning an unknown shape can never leave the hidden-frame window invisible indefinitely. The mode defaults to `'html-fallback'` and only upgrades to `'native-overlay'` when main explicitly confirms it - failure always falls toward visible controls, never a control-less hidden bar. The buttons are pinned to the trailing edge, styled with logical CSS properties (RTL-safe), and invoke one narrow IPC verb: `windowAction('minimize' | 'toggle-maximize' | 'close')` exposed via `main/preload.ts`. Context isolation is unchanged.
5. Fallback `close` routes through `BrowserWindow.close()`, firing the same `close` event as the native caption button, so close-to-tray behavior in `main/index.ts` is identical in both modes.
6. Renderer readiness is per-document: main resets its readiness flag on every window creation and on each `did-start-loading` navigation (manual reloads included), so a reload that fails to re-mount the root chrome re-evaluates readiness instead of inheriting a stale ready flag while the caption controls are gone.

Contract coverage lives in `tests/titlebar-window-options.test.ts` (mode resolution matrix, fallback window options, window-action verb validation) and `tests/electron-api-contract.test.ts` (preload surface includes `windowAction` and `windowReady`).

### Follow-up (not implemented)

A manually-triggered `workflow_dispatch` CI job that launches the packaged Linux AppImage under xvfb on ubuntu-latest and captures screenshots of both overlay and fallback modes as artifacts remains follow-up work; it needs a packaged-build runner and xvfb setup that does not fit this slice.

The renderer `ElectronAPI` declaration stays in parity with the preload surface, including settings, KDS, printer, and daily-summary methods plus the narrow `windowAction` control and `windowReady` readiness methods. The `titleBarMode` capability remains part of the `get-status` payload rather than a separate renderer gate. The KDS window, print receipt/local popup windows, native dialogs, and browser/LAN layouts remain on their existing paths. Context isolation, disabled Node integration, and the preload API are unchanged.

## Explicit exclusions

Phase 1 did not add HTML window-control buttons or broad window-control IPC, clock/cloud-sync indicators, title-bar printer/server polling, vibrancy/transparency, dynamic theme synchronization, or cross-platform manual validation. Phase 2 delivered the HTML fallback controls over one narrow `windowAction` IPC channel; broad window-control IPC, cloud-sync indicators, printer/server polling, vibrancy/transparency, and dynamic theme synchronization remain bounded follow-up work if platform testing identifies a need.

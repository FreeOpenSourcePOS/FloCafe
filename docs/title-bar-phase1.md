# Native-controls title bar - Phase 1

**Status: CURRENT implementation note (Refs #457)**

**Phase 2 update (#458):** the overlay colors now resolve from shared tokens in `main/title-bar-theme.ts` instead of inline constants, a `nativeTheme` listener applies light/dark overlay updates at runtime on macOS/Windows (no-op elsewhere), and macOS traffic lights sit vertically centered in the 40px bar via `trafficLightPosition`.

Phase 1 gives the main POS Electron window a small native-controls title-bar foundation without removing the OS window frame:

- macOS uses `hiddenInset`; Windows and Linux use `hidden`.
- Every main-window platform uses an explicit 40px `titleBarOverlay` height with opaque colors. Electron supplies the native caption buttons, preserving platform accessibility and Windows Snap Layout behavior.
- The renderer `TitleBar` component is mounted only by the dashboard layout and only after the existing `window.electronAPI?.getStatus` capability is present. Detection is capability-based rather than user-agent-based, so LAN/browser clients receive no Electron-only title-bar markup.
- When that Electron capability is present, the fixed desktop dashboard sidebar starts below the same 40px title bar and its height is reduced accordingly. The capability flag is CSS-only; browser/LAN layouts keep the sidebar pinned to the viewport top, while mobile uses the existing sheet path.
- A root-level Electron-only drag surface keeps auth, setup, and loading screens draggable without adding normal-flow height or changing browser/LAN layout geometry.
- The bar displays the current store and staff context and reuses the existing update badge. Its layout uses Window Controls Overlay safe-area environment variables, logical spacing, and explicit drag/no-drag regions for interactive content.
- The existing `StatusBar` remains the dashboard footer because its server, port, memory, and uptime metrics are a wider footer contract; the title bar does not duplicate it. `UpdateBadge` is reused because its compact native update action fits the bar. The POS-only `PrinterStatus` toolbar component is not mounted here: it owns WebUSB/API printer state rather than a title-bar capability, so Phase 1 adds no printer polling or new printer IPC.

The renderer `ElectronAPI` declaration stays in parity with the existing preload surface, including settings, KDS, printer, and daily-summary methods; no new bridge methods are added. The KDS window, print receipt/local popup windows, native dialogs, and browser/LAN layouts remain on their existing paths. Context isolation, disabled Node integration, and the preload API are unchanged.

## Explicit Phase 2 exclusions

Phase 1 does not add HTML window-control buttons or broad window-control IPC, Linux HTML fallback controls, clock/cloud-sync indicators, title-bar printer/server polling, vibrancy/transparency, or cross-platform manual validation. Those remain bounded follow-up work if platform testing identifies a need.

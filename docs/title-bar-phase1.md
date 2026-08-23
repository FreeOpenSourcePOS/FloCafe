# Native-controls title bar - Phase 1

**Status: CURRENT implementation note (Refs #457)**

Phase 1 gives the main POS Electron window a small native-controls title-bar foundation without removing the OS window frame:

- macOS uses `hiddenInset`; Windows and Linux use `hidden`.
- Every main-window platform uses an explicit 40px `titleBarOverlay` height with opaque colors. Electron supplies the native caption buttons, preserving platform accessibility and Windows Snap Layout behavior.
- The renderer `TitleBar` component is mounted only by the dashboard layout and only after the existing `window.electronAPI?.getStatus` capability is present. Detection is capability-based rather than user-agent-based, so LAN/browser clients receive no Electron-only title-bar markup.
- A root-level Electron-only drag surface keeps auth, setup, and loading screens draggable without adding normal-flow height or changing browser/LAN layout geometry.
- The bar displays the current store and staff context and reuses the existing update badge. Its layout uses Window Controls Overlay safe-area environment variables, logical spacing, and explicit drag/no-drag regions for interactive content.

The KDS window, print receipt/local popup windows, native dialogs, and browser/LAN layouts remain on their existing paths. Context isolation, disabled Node integration, and the preload API are unchanged.

## Explicit Phase 2 exclusions

Phase 1 does not add HTML window-control buttons or broad window-control IPC, Linux HTML fallback controls, clock/cloud-sync indicators, vibrancy/transparency, dynamic theme synchronization, or cross-platform manual validation. Those remain bounded follow-up work if platform testing identifies a need.

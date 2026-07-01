# In-App Auto-Update — Cross-Platform Design

**Date:** 2026-06-30
**Status:** Approved
**Approach:** Minimal (Approach A) — flip existing electron-updater config + add in-app notification badge

---

## Goal

Enable silent background downloads with an in-app notification badge across all platforms (macOS, Windows, Linux AppImage). Replace native OS dialogs with a subtle UI indicator. Enable Linux auto-update which is currently disabled.

## Current State

- `electron-updater` ^6.8.3 already integrated in `main/index.ts`
- GitHub Releases as publish provider (`FreeOpenSourcePOS/FloCafe`)
- macOS (DMG) and Windows (NSIS) auto-update works but requires user to confirm download via native dialog
- Linux explicitly skipped (`if (process.platform === 'linux') return;`)
- Store builds (MAS, MSIX) correctly skip auto-updater
- Preload already exposes `getUpdateStatus()`, `checkForUpdates()`, `onUpdateStatus()` to renderer

## What Changes

| Area | Before | After |
|------|--------|-------|
| Download trigger | User clicks "Download" in native dialog | Silent, automatic on update detection |
| Download progress | Shown in console only | Sent to renderer via IPC, shown in badge |
| Update ready prompt | Native dialog with "Restart Now" / "Later" | In-app badge with dropdown |
| Linux (AppImage) | Skipped entirely | Works via electron-updater self-update |
| Store builds | Skipped | Still skipped (unchanged) |
| Dev mode | Skipped | Still skipped (unchanged) |

---

## Architecture

### Update Flow

```
App launch
  → 5s delay
  → checkForUpdates()
      ├─ Store build? → send 'store' status, stop
      ├─ Dev mode? → send 'dev-mode' status, stop
      └─ Production → autoUpdater.checkForUpdates()
          ├─ No update → send 'up-to-date', stop
          └─ Update found → autoDownload kicks in silently
              → 'download-progress' events → renderer badge shows %
              → Download complete → send 'ready' event
              → Renderer badge shows "ready" dot
              → User clicks badge → dropdown with version + "Restart Now"
              → User clicks restart → autoUpdater.quitAndInstall()
```

### IPC Channels

| Channel | Direction | Payload | Purpose |
|---------|-----------|---------|---------|
| `update-status` | main → renderer | `{ status, version?, percent?, error? }` | Existing channel, extended with new states |
| `get-update-status` | renderer → main | — | Returns `{ updateAvailable, updateDownloaded, version }` |
| `check-for-updates` | renderer → main | — | Triggers manual check |
| `update-download-progress` | main → renderer | `{ percent, bytesPerSecond, total }` | Granular download progress |
| `update-ready` | main → renderer | `{ version }` | Download complete, ready to install |

### Update Status States

```
'idle'          → No check running
'checking'      → Fetching latest.yml from GitHub
'up-to-date'    → Current version is latest
'downloading'   → Update found, downloading in background (with percent)
'ready'         → Download complete, restart to install
'error'         → Check or download failed (logged, not shown to user unless critical)
'store'         → Store build, updates handled by platform
'dev-mode'      → Development mode, no updates
```

---

## Implementation Phases

### Phase 1: Main Process — Enable Silent Download + Linux

**File:** `main/index.ts`

#### 1a. Enable autoDownload

```typescript
// Line 42: change from
autoUpdater.autoDownload = false;
// to
autoUpdater.autoDownload = true;
```

#### 1b. Remove download confirmation dialog

In `setupAutoUpdater()`, the `update-available` handler (lines 50-71) currently shows a `dialog.showMessageBox` asking the user to confirm download. Remove the dialog — autoDownload will handle it automatically. Keep the IPC status send.

```typescript
// Lines 50-71: simplify to
autoUpdater.on('update-available', (info) => {
  console.log('[Update] Update available:', info.version);
  updateAvailable = true;
  mainWindow?.webContents.send('update-status', {
    status: 'available',
    version: info.version,
    releaseDate: info.releaseDate,
    releaseNotes: info.releaseNotes
  });
  // autoDownload is true — download starts automatically
});
```

#### 1c. Remove restart confirmation dialog

In `update-downloaded` handler (lines 86-106), remove the `dialog.showMessageBox`. The renderer will handle the restart prompt via the notification badge.

```typescript
// Lines 86-106: simplify to
autoUpdater.on('update-downloaded', (info) => {
  console.log('[Update] Download complete:', info.version);
  updateDownloaded = true;
  mainWindow?.webContents.send('update-status', {
    status: 'ready',
    version: info.version
  });
  // Don't show dialog — renderer badge handles restart
});
```

#### 1d. Add granular progress IPC

The existing `download-progress` handler (lines 78-84) already sends status to the renderer. Add a dedicated channel for granular progress:

```typescript
autoUpdater.on('download-progress', (progress) => {
  console.log(`[Update] Download progress: ${progress.percent.toFixed(1)}%`);
  mainWindow?.webContents.send('update-download-progress', {
    percent: progress.percent,
    bytesPerSecond: progress.bytesPerSecond,
    total: progress.transferred
  });
});
```

#### 1e. Enable Linux auto-update

Remove the Linux skip in `checkForUpdates()` (line 126):

```typescript
// Remove this line:
// if (process.platform === 'linux') return;

// Replace with AppImage-specific handling:
function checkForUpdates(): void {
  // Linux: only AppImage supports self-update via electron-updater.
  // Other formats (deb, rpm, snap) are managed by their respective package managers.
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    log.debug('[Update] Linux non-AppImage build — updates managed by package manager');
    mainWindow?.webContents.send('update-status', { status: 'linux-managed' });
    return;
  }

  if (isStoreBuild) { ... }  // unchanged
  if (!isDev) { ... }        // unchanged
}
```

#### 1f. Enable auto-updater initialization on Linux

Update the initialization block (lines 577-582):

```typescript
// Before:
if (!isStoreBuild && process.platform !== 'linux') {
  setupAutoUpdater();
  setTimeout(() => checkForUpdates(), 5000);
}

// After:
if (!isStoreBuild) {
  setupAutoUpdater();
  setTimeout(() => checkForUpdates(), 5000);
}
```

#### 1g. Add restart IPC handler

Add a handler so the renderer can trigger restart:

```typescript
ipcMain.handle('restart-and-install', () => {
  isQuitting = true;
  autoUpdater.quitAndInstall();
});
```

---

### Phase 2: Preload — Expose New IPC Channels

**File:** `main/preload.ts`

Add to the `contextBridge.exposeInMainWorld` block:

```typescript
// Existing (keep):
getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
onUpdateStatus: (callback) => {
  ipcRenderer.on('update-status', (_event, status) => callback(status));
},

// New:
restartAndInstall: () => ipcRenderer.invoke('restart-and-install'),
onUpdateProgress: (callback) => {
  ipcRenderer.on('update-download-progress', (_event, progress) => callback(progress));
},
onUpdateReady: (callback) => {
  ipcRenderer.on('update-status', (_event, status) => {
    if (status.status === 'ready') callback(status);
  });
},
```

---

### Phase 3: Renderer — Notification Badge Component

**File:** `frontend/` (FloUI submodule — changes go to FloUI repo)

#### Component: `<UpdateBadge />`

A small indicator in the app header/toolbar area.

**Behavior:**
- Hidden when no update activity
- Shows "↓ 43%" pill when downloading
- Shows animated dot/bell when update is ready
- Clicking opens a small dropdown with version info + "Restart Now" button

**States:**

| State | Visual | Interaction |
|-------|--------|-------------|
| Idle / up-to-date | Nothing shown | — |
| Checking | Small spinner (optional, 1-2s) | — |
| Downloading | Pill: "↓ {percent}%" | Hover shows speed |
| Ready | Pulsing dot or bell icon | Click opens dropdown |
| Dropdown open | Card with version + restart button | "Restart Now" calls `restartAndInstall()`, "Later" closes |

**Styling:** Subtle, non-intrusive. A POS app needs screen real estate — the badge should be small (24-32px) and only visible when there's something to show. Use the app's existing design tokens.

**Location:** App shell header, likely near the settings/help menu area.

#### Hook: `useUpdateStatus()`

A React hook that manages update state from IPC events:

```typescript
function useUpdateStatus() {
  const [status, setStatus] = useState<'idle' | 'checking' | 'downloading' | 'ready' | 'error'>('idle');
  const [progress, setProgress] = useState(0);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    window.electronAPI.onUpdateStatus((s) => {
      setStatus(s.status === 'ready' ? 'ready' : s.status === 'available' ? 'downloading' : s.status);
      if (s.version) setVersion(s.version);
    });
    window.electronAPI.onUpdateProgress((p) => {
      setProgress(p.percent);
    });
  }, []);

  const checkForUpdates = () => window.electronAPI.checkForUpdates();
  const restartAndInstall = () => window.electronAPI.restartAndInstall();

  return { status, progress, version, checkForUpdates, restartAndInstall };
}
```

---

## Files Changed

| File | Change |
|------|--------|
| `main/index.ts` | Enable autoDownload, remove dialogs, enable Linux, add restart handler |
| `main/preload.ts` | Add `restartAndInstall`, `onUpdateProgress`, `onUpdateReady` |
| `frontend/` (FloUI) | New `<UpdateBadge />` component + `useUpdateStatus()` hook |

## Files NOT Changed

| File | Why |
|------|-----|
| `package.json` build config | Publish provider, targets, all unchanged |
| `.github/workflows/release.yml` | CI already builds and uploads all formats |
| `main/ipc.ts` | Update IPC stays in `main/index.ts` where it already lives |

---

## Testing

### Manual Testing Matrix

| Platform | Format | Test |
|----------|--------|------|
| macOS | DMG (x64) | Publish a test release → verify silent download → badge shows → restart installs |
| macOS | DMG (arm64) | Same as above on Apple Silicon |
| macOS | MAS | Verify auto-update is skipped (store status) |
| Windows | NSIS (x64) | Publish a test release → verify silent download → badge shows → restart installs |
| Windows | MSIX | Verify auto-update is skipped (store status) |
| Linux | AppImage | Set `APPIMAGE` env var → verify download → badge → restart |
| Linux | deb | Verify "linux-managed" status, no error noise |
| Linux | snap | Verify snap's own auto-update handles it |
| All | Dev mode | Verify "dev-mode" status, no update check |
| All | No release | Verify 404 graceful handling → "up-to-date" |

### Edge Cases

- App launched with no internet → check fails silently, no error UI
- Download interrupted → electron-updater retries, status stays "downloading"
- User clicks "Restart Now" while download is in progress → should be disabled/hidden until ready
- Multiple monitors → badge visible on focused window only (or all, depending on implementation)

---

## Rollout

1. Bump version to 1.8.0 (feature release)
2. Build all platforms locally to verify
3. Tag and push → CI builds and publishes to GitHub Releases
4. Existing users on macOS/Windows get in-app update prompt (now silent download)
5. Linux AppImage users get in-app updates for the first time
6. deb/rpm/snap users continue using their package managers

---

## Future Improvements (Not in Scope)

- **Approach B:** Full custom update manager with changelog panel, "what's new" modal
- **Approach C:** Version skip tracking, scheduled installs, beta channels
- **Delta updates:** electron-updater supports delta downloads for smaller payloads
- **Staged rollouts:** Percentage-based rollout via GitHub Releases or custom server

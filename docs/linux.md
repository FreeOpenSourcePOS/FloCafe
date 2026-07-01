# Flo Cafe — Linux Notes

---

## Packages

| Format | For |
|--------|-----|
| **AppImage** (`Flo-Cafe-*.AppImage`) | Any distro — no install needed |
| **deb** (`flo-cafe_*.deb`) | Debian / Ubuntu and derivatives |

Both are `x86_64` only.

```bash
# deb
sudo dpkg -i flo-cafe_*.deb && sudo apt-get install -f

# AppImage
chmod +x Flo-Cafe-*.AppImage && ./Flo-Cafe-*.AppImage
```

---

## AppImage — FUSE

AppImage needs FUSE to mount at runtime.

```bash
# Ubuntu 22.04 / Debian 12
sudo apt install libfuse2

# Ubuntu 24.04+
sudo apt install libfuse2t64
```

No FUSE? Run extracted:

```bash
./Flo-Cafe-*.AppImage --appimage-extract
./squashfs-root/AppRun
```

---

## Updates

**No auto-update on Linux.** Download the new release manually from
[GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases) and
replace the AppImage or re-run `dpkg -i`.

`electron-updater` doesn't support deb (apt manages it) and requires the
`APPIMAGE` env var for AppImage (not always set). The updater is disabled on
Linux at the source level — no error noise.

---

## Thermal Printing

| Capability | Status |
|------------|--------|
| Network (TCP port 9100) | ✅ Works |
| USB via CUPS (`lp`) | ✅ Works — needs CUPS |
| Auto-detect make/model | ⚠ Returns Generic for everything |

```bash
# Install CUPS
sudo apt install cups && sudo systemctl enable --now cups

# Add yourself to the lp group if USB access is denied
sudo usermod -aG lp $USER
```

Add/configure printers at `http://localhost:631`.

---

## System Tray

Window close hides the app — use the tray to get it back or quit.

| Action | Result |
|--------|--------|
| Click **×** | Window hides |
| Left-click tray / **Show** | Window shows |
| **Quit** | Clean shutdown (DB, servers, mDNS) |

> If the tray icon doesn't appear (i3, Sway, bare WMs), install `trayer` or
> `stalonetray`. Alternatively use **File → Exit** inside the app.

---

## Known Issues / TODO

_(None currently open — all items resolved as of 2025-06.)_

## Resolved

- **System Tray "Quit"** — Extracted cleanup to idempotent `runCleanup()` with try/catch per service. Added `tray.destroy()` to prevent ghost icons on X11. Added `SIGTERM`/`SIGINT` handlers. Moved cleanup to `will-quit` with retry fallback. See `main/index.ts`.
- **Printer make/model** — `detectLinuxPrinters()` now parses CUPS Device URI (`usb://Make/Model`) and falls back to sysfs vendor ID lookup with a known thermal printer vendor table. See `main/printers/thermal.ts`.
- **Debian `.deb` metadata** — Added `assets/com.flo.desktop.metainfo.xml` with AppStream metadata and desktop file fields in `package.json`. The `.deb` now shows proper description in GNOME Software.
- **Window menu zoom/front** — Wrapped `{ role: 'zoom' }` and `{ role: 'front' }` in `process.platform === 'darwin'` check. No longer a no-op on Linux/Windows.
- **Single-instance locking on AppImage** — Custom PID file lock implemented at `~/.config/flo-desktop/singleton.lock` with `/proc/<pid>` existence check.
- **Auto-updater** — Disabled on Linux at source level. No error noise. Manual re-download from [GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases) for now.




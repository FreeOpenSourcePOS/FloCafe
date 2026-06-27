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

- **Window menu zoom/front** — macOS-only roles, no-ops on Linux. Cosmetic. See `TODO(linux)` in `main/index.ts`.
- **Printer make/model** — `detectLinuxPrinters()` always returns Generic. Needs `lpoptions`/`lsusb` integration. Medium effort. See `main/printers/thermal.ts`.
- **Auto-updater** — manual re-download for now. Future: apt repo, Flatpak, or [AppImageUpdate](https://github.com/AppImageCommunity/AppImageUpdate).
- **Single-instance locking on AppImage (Custom PID File Lock)** — Resolved by implementing a custom lock file containing the running process PID written to a persistent user data path (`~/.config/flo-desktop/singleton.lock`), checking process existence via `/proc/<pid>`.
- **System Tray "Quit" menu item** — The "Quit" context menu item on the tray does not fully close the app in some environments, requiring investigation of `isQuitting` state lifecycle, event order, and DB/server tear-down sequence.
- **Debian Package (`.deb`) App Store Metadata** — The built `.deb` lacks standard AppStream metadata (no screenshots, description, or age rating, showing "potentially unsafe" warnings in software centers). Requires adding an AppStream `.metainfo.xml` file and configuring the `desktop` file fields in the packaging configuration.




# Linux installation and support

FloCafe runs on current Linux distributions through AppImage, deb, rpm, and Snap packages. Choose the format your distribution supports best.

## Packages

| Format | For |
|--------|-----|
| **AppImage** (`flocafe-*.appimage`) | Any distro — no install needed |
| **deb** (`flocafe-*.deb`) | Debian / Ubuntu and derivatives |
| **rpm** (`flocafe-*.rpm`) | Fedora, RHEL-family, and compatible distributions |
| **Snap** (`flocafe-*.snap`) | Snap-enabled distributions |

AppImage, deb, rpm, and Snap releases are built for x64 and arm64. Linux
release jobs run on Ubuntu 24.04 runners for x64 and arm64 respectively.

```bash
# deb
sudo dpkg -i flocafe-*.deb && sudo apt-get install -f

# AppImage
chmod +x flocafe-*.appimage && ./flocafe-*.appimage
```

---

## AppImage and FUSE

AppImage needs FUSE to mount at runtime.

```bash
# Ubuntu 22.04 / Debian 12
sudo apt install libfuse2

# Ubuntu 24.04+
sudo apt install libfuse2t64
```

No FUSE? Run extracted:

```bash
./flocafe-*.appimage --appimage-extract
./squashfs-root/AppRun
```

---

## Updates

FloCafe's in-app updater is available only when the application is launched
from a downloaded AppImage (`APPIMAGE` is set). It is not used for an extracted
AppImage, deb, or rpm installation. Update deb and rpm installations with the
package manager for your distribution. Snap installations are updated by snapd
from the Snap Store.

If an AppImage update is unavailable, download the replacement from [GitHub
Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases). See [Desktop
release process](release-process.md) for stable, beta, and nightly channel
behavior.

---

## Printing

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

## System tray

Window close hides the app — use the tray to get it back or quit.

| Action | Result |
|--------|--------|
| Click **×** | Window hides |
| Left-click tray / **Show** | Window shows |
| **Quit** | Clean shutdown (DB, servers, mDNS) |

> If the tray icon doesn't appear (i3, Sway, bare WMs), install `trayer` or
> `stalonetray`. Alternatively use **File → Exit** inside the app.

---

## Get help

Include your FloCafe version, Linux distribution/version, package format, and relevant app logs when reporting a problem. Do not delete your local database to diagnose a startup issue; create or restore a backup first.

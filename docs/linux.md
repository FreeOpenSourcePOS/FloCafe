# Linux installation and support

FloCafe runs on current Linux distributions through AppImage, deb, rpm, and Snap packages. Choose
the format your distribution supports best.

## Packages

| Format | For |
| --- | --- |
| **AppImage** (`flocafe-*.appimage`) | Any distribution, with no install step |
| **deb** (`flocafe-*.deb`) | Debian, Ubuntu, and derivatives |
| **rpm** (`flocafe-*.rpm`) | Fedora, the RHEL family, and compatible distributions |
| **Snap** (`flocafe-*.snap`) | Snap-enabled distributions |

Every format is built for both `x64` and `arm64`.

```bash
# deb
sudo dpkg -i flocafe-*.deb && sudo apt-get install -f

# AppImage
chmod +x flocafe-*.appimage && ./flocafe-*.appimage
```

## AppImage and FUSE

An AppImage needs FUSE to mount at runtime. Which package provides it depends on the distribution
release.

```bash
# Ubuntu 22.04, Debian 12
sudo apt install libfuse2

# Ubuntu 24.04 and later
sudo apt install libfuse2t64
```

If FUSE is unavailable or the AppImage will not mount, run it extracted:

```bash
./flocafe-*.appimage --appimage-extract
./squashfs-root/AppRun
```

## Updates

The in-app updater is available only when the app is launched from a downloaded AppImage, because
that is the only case where FloCafe can see `APPIMAGE` in its environment. It is not used for an
extracted AppImage, a deb, or an rpm installation.

Update deb and rpm installations with your distribution's package manager. Snap installations are
updated by snapd from the Snap Store, and a beta install follows the Snap Store `edge` channel
rather than `stable`.

If an AppImage update is unavailable, download the replacement from
[GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases). For the channel model and
what a beta build follows, see [desktop releases](maintainers/releases.md).

## Printing

| Capability | Behaviour |
| --- | --- |
| Network, TCP port 9100 | Works |
| USB via CUPS (`lp`) | Works, and needs CUPS installed |
| Auto-detect make and model | Matches Xprinter XP-V320M/XP-V330M and Epson TM series names to real profiles; anything unmatched falls back to a generic profile chosen by paper width |

```bash
# Install CUPS
sudo apt install cups && sudo systemctl enable --now cups

# Add yourself to the lp group if USB access is denied
sudo usermod -aG lp $USER
```

Add and configure printers at `http://localhost:631`. Log out and back in after adding yourself to
the `lp` group, because group membership is applied at login.

For how profiles are resolved and what a generic profile will and will not print, see
[printer setup](printers.md#printer-profiles-and-paper-width).

## System tray

On Linux the window close hides the app rather than quitting it. Use the tray to bring it back or to
quit cleanly.

| Action | Result |
| --- | --- |
| Click the window close button | The window hides |
| Left-click the tray icon, or choose **Show** | The window shows and takes focus |
| Choose **Quit** | Clean shutdown of the database, servers, and mDNS |

Quitting destroys the tray icon explicitly before calling `app.quit()`, which releases the
AppIndicator lock so a later launch can take it again. The quit action is deferred by a short delay
so an open context menu can close first, because quitting while the menu is open can deadlock on
Debian and other AppIndicator desktops.

If the tray icon does not appear, as on i3, Sway, or a bare window manager, install a tray host such
as `trayer` or `stalonetray`. Alternatively use **File > Exit** inside the app.

## Get help

Include your FloCafe version, Linux distribution and version, package format, and the relevant app
logs when reporting a problem. Do not delete your local database to diagnose a startup issue. Create
or restore a backup first.

# Flo Cafe Release Artifacts
*Date: July 2026*

This documents what a Flo Cafe release is supposed to produce — the artifact matrix `release.yml` builds for every `v*` tag — so it's obvious at a glance whether a release is complete or something's missing.

---

## The matrix

| Platform | Artifacts | Architectures | Notes |
|---|---|---|---|
| **macOS** | `.dmg`, `.zip` | Intel (x64), Apple Silicon (arm64) | Code-signed (Developer ID Application) and notarized. `.zip` + `latest-mac.yml` are required for auto-update (electron-updater's `MacUpdater` fetches those, not the DMG). |
| **Windows** | `.exe` (NSIS installer) | x64 | Installer only — **no portable build**. `latest.yml` + the installer's `.blockmap` are required for auto-update. |
| **Linux** | `AppImage`, `.deb`, `.rpm`, snap | x64, arm64 | `.deb`/AppImage cover Ubuntu directly. Snap is published to the Snap Store under `flocafe`. |

Every release ships **both architectures for macOS and Linux**. Windows is x64-only (no arm64 Windows target is configured, and there is no ARM64 Windows userbase to justify one yet).

## Why no Windows portable build

electron-builder can produce a portable (no-install, single `.exe`) Windows target alongside or instead of NSIS. Flo Cafe intentionally only builds the NSIS installer:

- The installer gives users Start Menu/Desktop shortcuts and a real uninstaller (`uninstall-windows.ps1` ships separately for anyone who needs to force-clean).
- A portable build doesn't get auto-update wiring the same way NSIS does (no `latest.yml` story), so it would silently drift from every other release.
- No one has asked for it. Add it back (`build.win.target`) only if there's an actual request — it's a config addition, not a re-architecture.

## Why macOS ships both `.dmg` and `.zip`

- `.dmg` is what a human downloads and drags to Applications.
- `.zip` (+ `latest-mac.yml`) is what `electron-updater`'s `MacUpdater` actually fetches to check for and apply silent updates. Shipping only the DMG means auto-update is broken for Mac users even though the release "looks" complete.

`release.yml`'s "Verify macOS release assets" step fails the job loudly if either is missing, specifically because this shipped broken silently once already (auto-update 404'd from v1.6.7 through 2.0.9 before that check existed).

## Signing status by platform

| Platform | Signed | Notarized |
|---|---|---|
| macOS | Yes (Developer ID Application, Codify Apps Private Limited) | Yes |
| Windows | No | N/A |
| Linux | N/A (no code-signing convention for Linux packages) | N/A |

Windows code signing was evaluated and deliberately deferred — an EV cert has an ongoing cost, and Azure Trusted Signing / Microsoft Store submission are the free-tier options worth revisiting if SmartScreen warnings become a real support burden.

## Verifying a release is complete

For each `v*` tag, the release should have exactly:

- `flo-desktop-<version>-x64.dmg`, `-arm64.dmg`
- `flo-desktop-<version>-x64.zip`, `-arm64.zip`, `latest-mac.yml`, matching `.zip.blockmap` files
- `Flo Cafe Setup <version>.exe`, `latest.yml`, matching `.exe.blockmap`
- `flocafe-<version>-x86_64.AppImage`, `-arm64.AppImage`
- `flocafe-<version>-amd64.deb`, `-arm64.deb`
- `flocafe-<version>-x86_64.rpm`, `-arm64.rpm`
- A `flocafe` snap revision published under both `amd64` and `arm64` on the Snap Store `stable` channel

If any of the above is missing, check the corresponding `release-mac` / `release-windows` / `release-linux` job in Actions before assuming the release is good.

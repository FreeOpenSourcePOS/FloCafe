#!/bin/bash
# Sanity-checks the Electron dev binary that `npm install` just downloaded
# into node_modules/electron/dist. Runs on every install (see package.json's
# "postinstall") so a broken runtime is caught right there instead of surfacing
# later as a Gatekeeper dialog when someone runs `npm run dev`.
#
# What this does NOT do: assert that `codesign --verify --deep --strict` or
# `spctl -a` pass against node_modules/electron/dist/Electron.app. They can't —
# the npm `electron` package ships an ad-hoc-signed, unnotarized dev binary
# with no sealed resources by design (verified on 2026-07-28 by installing
# electron@43.2.0 fresh into an empty directory: identical
# "code has no resources but signature indicates they must be present"
# failure). That binary is never what end users receive; electron-builder
# re-signs the real thing from scratch during `release-mac`, which is where
# the strict codesign/spctl/notarization checks belong (see release.yml).
#
# What this DOES check: whether this specific download looks intact —
# no stray quarantine flag (a plain `npm install` shouldn't set one; its
# presence plus the ad-hoc signature above is what actually produces the
# "Electron has been blocked" dialog) and a binary that's at least signed
# in the expected ad-hoc shape rather than missing/corrupted outright.

set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

ELECTRON_DIR="node_modules/electron"
if [ ! -d "$ELECTRON_DIR" ]; then
  exit 0
fi

APP=$(find "$ELECTRON_DIR/dist" -maxdepth 1 -type d -name '*.app' -print -quit 2>/dev/null || true)

fail() {
  echo "::error::$1" >&2
  echo "" >&2
  echo "Do NOT run 'spctl --master-disable' or otherwise disable Gatekeeper system-wide to work around this." >&2
  echo "Approved remediation: rm -rf node_modules/electron && npm install" >&2
  echo "If a clean reinstall still fails, this is a real problem with the electron package — open an issue" >&2
  echo "instead of bypassing Gatekeeper. See CONTRIBUTING.md's 'macOS Gatekeeper & the Electron dev binary' section." >&2
  exit 1
}

if [ -z "$APP" ]; then
  fail "$ELECTRON_DIR is installed but no dist/*.app bundle was found — the download is incomplete or corrupted."
fi

QUARANTINE=$(xattr -p com.apple.quarantine "$APP" 2>/dev/null || true)
if [ -n "$QUARANTINE" ]; then
  fail "$APP is marked com.apple.quarantine ($QUARANTINE). A plain npm install shouldn't set this — something in the download path tagged it, and combined with Electron's ad-hoc dev signature this is exactly what triggers the 'Electron has been blocked' dialog."
fi

if ! codesign -dv "$APP" >/dev/null 2>&1; then
  fail "$APP has no code signature at all (expected an ad-hoc dev signature) — the binary is likely corrupted."
fi

echo "verify-electron-runtime: $APP present, unquarantined, ad-hoc signed as expected."

# Mac App Store submission

This maintainer guide covers shipping FloCafe to the Mac App Store (MAS). It
covers what Apple requires, what features of Flo conflict with MAS rules, what
certificates/profiles to create in the Apple Developer portal, and the end-to-end
build + upload flow.

> **Status:** in progress. The repo now has a `mas` electron-builder target and
> sandbox entitlements, but the App Store Connect record, provisioning profile,
> and distribution certificates must still be created manually by the developer.

---

## 1. High-level constraints

The Mac App Store is **not** the same channel as the notarized-DMG distribution
Flo already ships. Different certs, different entitlements, different review,
different update mechanism.

Hard MAS rules that affect Flo:

1. **App must be sandboxed.** `com.apple.security.app-sandbox` is mandatory.
2. **No third-party auto-update.** `electron-updater` / Squirrel / Sparkle are
   all forbidden. The App Store handles updates.
3. **No raw USB/serial access** without a special Apple-granted entitlement
   (`com.apple.developer.driverkit.*`). Thermal printer drivers that talk to
   USB directly will be rejected. Network printers (IPP / raw 9100) are fine.
4. **Local network servers are allowed but restricted.** Binding TCP with
   `com.apple.security.network.server` is fine; Bonjour/mDNS advertising is
   fine with the multicast entitlement but often flagged at review if the user
   value is not explained.
5. **File writes outside the container require `files.user-selected.*`**
   entitlements and must be user-initiated (NSOpenPanel / NSSavePanel). DB files
   live in `~/Library/Containers/com.flo.desktop/Data/…` automatically.
6. **Hardened runtime** is implied. Sandbox is stricter than hardened-only.
7. **Bundle ID must match** the App Store Connect record exactly.
8. **Provisioning profile must be embedded** inside the `.app`.

## 2. What breaks in Flo and how it is handled

| Feature | MAS-compatible? | What we do in the MAS build |
| --- | --- | --- |
| `electron-updater` (GitHub releases) | No | Disabled at runtime when `MAS_BUILD=1`. App Store does updates. |
| `node-thermal-printer` over USB | No | Disabled in MAS build. Only network (TCP) printers supported. |
| `node-thermal-printer` over TCP | Yes | Allowed with `network.client`. |
| Express server on `:3001` + KDS on `:3002` | Yes | Allowed with `network.server`. |
| `bonjour-service` (mDNS) | Yes, with caveat | Needs `com.apple.security.network.server` + multicast. Kept on, but we should be ready to explain the POS/KDS pairing flow in the review notes. |
| `better-sqlite3` (native) | Yes | Must be signed with hardened runtime + sandbox. DB path moves into the container. |
| Backup/restore to user-chosen location | Yes | Must use `dialog.showSaveDialog` / `showOpenDialog` — already does. Requires `files.user-selected.read-write`. |
| Tray icon | Yes | No entitlement needed. |
| DevTools / JIT | Yes | Sandboxed Electron apps still need `com.apple.security.cs.allow-jit` + `allow-unsigned-executable-memory` in the inherited entitlements for the helper processes. |

## 3. Apple Developer portal checklist (manual)

Do these in a browser while logged in as the team agent of
**Codify Apps Private Limited (BKDY677XJA)**.

### 3a. Certificates (Certificates, IDs & Profiles → Certificates)

Create/download and install into login keychain:

1. **Mac App Distribution** — signs the `.app` bundle.
   - Also called *3rd Party Mac Developer Application* in older UIs.
2. **Mac Installer Distribution** — signs the outer `.pkg` uploaded to Apple.
   - Also called *3rd Party Mac Developer Installer*.
3. Keep the existing **Developer ID Application** cert for the DMG channel.

After installing, confirm with:

```sh
security find-identity -v -p codesigning | grep -E "3rd Party Mac|Mac App"
```

You should see one `Mac App Distribution` (or `3rd Party Mac Developer Application`)
and one `Mac Installer Distribution` (or `3rd Party Mac Developer Installer`)
identity with the team ID `BKDY677XJA`.

### 3b. App ID (Identifiers)

1. Create an **App ID** with bundle ID `com.flo.desktop` (must match
   `build.appId` in package.json exactly).
2. Enable any capabilities we actually use. For now:
   - App Sandbox (implied for MAS)
   - (nothing exotic — no iCloud, no Push, no HealthKit, no DriverKit)

### 3c. Provisioning profile (Profiles)

1. Create a **Mac App Store** distribution provisioning profile bound to the
   `com.flo.desktop` App ID and the **Mac App Distribution** certificate.
2. Download it and save it at the repo root (or anywhere) as
   `build/flo.provisionprofile`. electron-builder will embed it automatically
   if `mac.provisioningProfile` is set.

### 3d. App Store Connect

1. In **App Store Connect → My Apps → “+”** create a new macOS app.
2. Platform: macOS. Bundle ID: `com.flo.desktop`. SKU: `flo-desktop`.
3. Fill metadata (name, subtitle, category = Business, pricing, screenshots).
4. Create the first version, e.g. `1.5.6`, matching `package.json`.

### 3e. App Store Connect API key (recommended for CLI upload)

1. **Users and Access → Integrations → App Store Connect API**.
2. Generate a key with role **Developer** (or App Manager).
3. Download the `.p8` file and note the **Key ID** and **Issuer ID**.
4. Store locally, never commit:
   ```
   ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
   ```
5. Export env vars when uploading:
   ```sh
   export APPLE_API_KEY_ID=<KEY_ID>
   export APPLE_API_ISSUER=<ISSUER_ID>
   export APPLE_API_KEY=~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
   ```

Alternative: use an **app-specific password** (Apple ID → Sign-In and Security →
App-Specific Passwords) with `xcrun altool --upload-app -u ... -p ...`. The
API key is preferred.

## 4. Build configuration in this repo

### 4a. electron-builder `mas` target

Added to `package.json` under `build.mac.target` as a separate
entry, with its own entitlements:

- `build/entitlements.mas.plist` — applied to the main `.app`.
- `build/entitlements.mas.inherit.plist` — applied to all Electron helper
  processes (Renderer, GPU, Plugin). Required; without it the helpers crash
  under sandbox.
- `build.mac.provisioningProfile = "build/flo.provisionprofile"`.

### 4b. Conditional code path

A new env var `MAS_BUILD=1` is passed at build time. The main process reads
it and:

- Does not call `setupAutoUpdater()` or `checkForUpdates()`.
- Does not initialize the thermal printer driver over USB.
- Hides the “Check for Updates” menu item.

This keeps a single codebase but two very different binaries.

### 4c. Scripts

```sh
npm run build:mas     # builds & signs a .pkg ready for App Store Connect
```

Output lands in `release/mas/Flo-<version>.pkg`.

### 4d. Uploading the build

After `build:mas` completes:

```sh
xcrun altool --upload-app \
  --type macos \
  --file "release/mas/Flo-1.5.6.pkg" \
  --apiKey "$APPLE_API_KEY_ID" \
  --apiIssuer "$APPLE_API_ISSUER"
```

Or, the GUI path: open **Transporter.app** (from the Mac App Store), drag in
the `.pkg`, click **Deliver**.

Build shows up in App Store Connect → TestFlight tab within ~15–60 minutes
after processing. Attach it to the version in the App Store tab and submit
for review.

## 4e. Export compliance (encryption)

Flo uses only **exempt** cryptography:

- `bcryptjs` — password hashing (a hash, not encryption — exempt).
- `jsonwebtoken` — HMAC-SHA256 signing for auth tokens (authentication-only, exempt under 15 CFR §742.15(b)(4)).
- No proprietary crypto, no user-data encryption for transport/storage beyond what the OS provides.

The MAS build sets `ITSAppUsesNonExemptEncryption = false` in `Info.plist`
(via `mac.extendInfo` in `package.json`), so App Store Connect will **not**
prompt for the Export Compliance form on every upload.

If crypto usage ever changes (e.g. adding TLS with custom protocols, or
encrypting user data at rest with a proprietary scheme), this flag must be
re-evaluated and possibly removed; an annual self-classification report to
the US Bureau of Industry and Security may be required.

## 5. First-submission gotchas

- **Bundle version sync**: App Store Connect requires each upload to have a
  strictly higher `CFBundleVersion`. electron-builder uses `package.json`
  `version` for both `CFBundleShortVersionString` and `CFBundleVersion`.
  Bump `version` before every re-upload or Apple rejects the `.pkg`.
- **Private APIs**: Apple’s static analyzer will reject builds that import
  unexported symbols. Electron itself is clean, but any new native addon
  should be vetted.
- **Crash on launch in sandbox**: usually means a helper is missing the
  inherited entitlements or trying to write outside the container. Check
  `~/Library/Logs/DiagnosticReports/Flo-*.ips`.
- **“No matching provisioning profiles found”**: the cert the profile was
  created with must match the cert electron-builder uses to sign. Both must
  be under team `BKDY677XJA`.
- **Review time**: first submission 24–72h typical. Rejections are common
  for POS apps — be ready to explain the local-network/KDS feature in the
  App Review notes.

## 6. What the developer still needs to do manually

- [ ] Create the two MAS distribution certs (§3a) and install to keychain.
- [ ] Create `com.flo.desktop` App ID (§3b).
- [ ] Create and download the MAS provisioning profile, save as
      `build/flo.provisionprofile` (§3c).
- [ ] Create the App Store Connect app record for `com.flo.desktop` (§3d).
- [ ] Create an App Store Connect API key and export the env vars (§3e).
- [ ] Run `npm run build:mas`, then upload with `xcrun altool` or
      Transporter.app (§4c, §4d).
- [ ] Submit for review inside App Store Connect.

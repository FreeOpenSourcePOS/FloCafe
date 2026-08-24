# Runtime upgrade support matrix (#468)

**Verification window:** 2026-08-24
**N:** `3.3.0`
**N+1:** `3.3.1-beta.1` (GitHub prerelease, beta channel)
**Stable feed:** unchanged; GitHub Latest remained `3.3.0` throughout.

This matrix records real installed-artifact runs, not unit tests or artifact-only
checks. A row is marked **PASS-verified** only when the installed N process
seeded data, the app's updater downloaded and applied N+1, and a relaunch
verified version and persistence. **NOT-RUN** is explicit and includes the
reason; no unobserved behavior is inferred.

## Release evidence

- Beta release: [3.3.1-beta.1](https://github.com/FreeOpenSourcePOS/FloCafe/releases/tag/3.3.1-beta.1)
  - `draft=false`, `prerelease=true`
  - `releases/latest` remained `3.3.0`
  - [successful release workflow run 32749694533](https://github.com/FreeOpenSourcePOS/FloCafe/actions/runs/32749694533)
  - Windows, macOS, Linux x64, and Linux arm64 packaging jobs passed; GitHub
    draft manifest/artifact verification and release publication passed.
- The release verifier was exercised against the real beta draft. It found and
  fixed two latent release-pipeline assumptions: draft releases are not
  addressable by `GET /releases/tags/{tag}`, and Linux updater manifests contain
  the AppImage plus deb/rpm entries from the same electron-builder invocation.

## Matrix

| Row | N artifact / target | Result | Evidence / reason |
|---|---|---|---|
| Windows NSIS x64 | `flocafe-3.3.0-win-x64.exe` -> `3.3.1-beta.1` | **PASS-verified** | [Run 32775289667](https://github.com/FreeOpenSourcePOS/FloCafe/actions/runs/32775289667), artifact `evidence-windows-nsis-x64`. |
| macOS DMG/ZIP arm64 | `flocafe-3.3.0-mac-arm64.dmg` -> `3.3.1-beta.1` | **NOT-RUN** | [Signed fixture limitation](#macos-arm64-dmgzip) |
| macOS DMG/ZIP x64 | `flocafe-3.3.0-mac-x64.dmg` -> `3.3.1-beta.1` | **NOT-RUN** | No Intel Mac available locally; no remote macOS execution was used for this row. |
| Linux AppImage x64 | `flocafe-3.3.0-x86_64.AppImage` -> `3.3.1-beta.1` | **PASS-verified** | [Real Debian 13 GNOME machine evidence](#linux-appimage-x64) |
| Linux AppImage arm64 | `flocafe-3.3.0-arm64.AppImage` -> `3.3.1-beta.1` | **NOT-RUN** | The approved real Linux machine is x86_64; no arm64 Linux machine was available in this run. The arm64 beta artifact did build and publish. |
| Older cohort Windows NSIS x64 | `Flo.Cafe.Setup.2.9.7.exe` -> stable `3.3.0` | **PASS-verified** | [Run 32775289667](https://github.com/FreeOpenSourcePOS/FloCafe/actions/runs/32775289667), artifact `evidence-older-cohort-windows`. |
| Linux managed: deb | `flocafe-3.3.0-amd64.deb` | **PASS-verified** | [Live `linux-managed` IPC event](#linux-managed-gating) |
| Linux managed: rpm | `flocafe-3.3.0-x86_64.rpm` | **NOT-RUN** | No system package installation was permitted on the real Debian box; the same main-process gate is covered by the deb row. |
| Linux managed: snap | `flocafe-3.3.0-amd64.snap` | **NOT-RUN** | No snapd/system mutation was permitted on the real Debian box. Beta Snap Store publishing was also blocked by the repository macaroon's `stable, edge` channel restriction; the `.snap` GitHub asset still published. |
| Windows SmartScreen interactive prompt | Unsigned NSIS | **NOT-RUN** | GitHub-hosted headless execution cannot observe the interactive SmartScreen UI. The release build logs explicitly identify the installer as unsigned when signing credentials are absent. |

## Windows NSIS x64

**Result: PASS-verified.** [Run 32775289667](https://github.com/FreeOpenSourcePOS/FloCafe/actions/runs/32775289667)
installed the released N artifact on `windows-latest`, applied the isolated
pre-toggle beta fixture, seeded an owner/order/printer, staged beta.1, and
completed the real staged NSIS handoff. The evidence JSON reports version,
order, and printer persistence PASS; the process evidence reports one root
process after relaunch. The uploaded artifact is
[`evidence-windows-nsis-x64`](https://github.com/FreeOpenSourcePOS/FloCafe/actions/runs/32775289667/artifacts/9537745436).

The updater log recorded:

```text
Differential download: .../3.3.1-beta.1/flocafe-3.3.1-beta.1-win-x64.exe
status transitions: up-to-date -> available -> ready-to-install
root processes: 1
```

The first two hosted attempts exposed an assisted-NSIS/UI handoff problem.
The bounded `complete-nsis-install.ps1` helper captured the staged process,
stopped only that UI-blocked handoff, reran the same staged installer with
`/S`, checked its exit code, and relaunched with CDP. The successful run proves
the updater assertions after that handoff; interactive SmartScreen remains
NOT-RUN as recorded in the table.

## macOS arm64 DMG/ZIP

**Result: NOT-RUN (reason recorded, no false PASS).** The released N DMG was
installed into an isolated temporary app directory and independently passed:

```text
codesign -dv: Identifier=com.flo.desktop
TeamIdentifier=BKDY677XJA
spctl: accepted
source=Notarized Developer ID
origin=Developer ID Application: Codify Apps Private Limited (BKDY677XJA)
```

The released N+1 ZIP was also independently checked with `codesign --verify
--deep --strict` and `spctl`; it was valid and notarized with the same Developer
ID identity.

The released `3.3.0` client has no `setBetaChannel` IPC because #507 landed
after that release. The approved pre-toggle fixture was tried by patching the
installed copy's updater setup to the exact beta opt-in state. That invalidates
the current app bundle's Developer ID sealed resources; native Squirrel.Mac
then correctly rejected the staged update with:

```text
Code signature at URL .../Flo Cafe.app/ did not pass validation:
code failed to satisfy specified code requirement(s)
```

A `NODE_OPTIONS=--require` external hook was also tested, but packaged
Electron ignores it. No keychain bypass, ad-hoc signature acceptance, or
captain credentials were used. Therefore the actual signed DMG/ZIP runtime
upgrade is **NOT-RUN**, while the independent N/N+1 signature checks remain
PASS evidence. This is the real-world pre-toggle/fixture-signature finding,
not a claimed product upgrade pass.

## Linux AppImage x64

**Result: PASS-verified on the captain-approved Debian 13 GNOME machine**
(`x86_64`, headless `xvfb-run`, isolated HOME/userData and private DBus
session). The test used the real released 3.3.0 AppImage with the same
pre-toggle updater fixture, then the real beta AppImage payload.

The post-relaunch evidence JSON was:

```json
{
  "row": "linux-appimage-x64-real",
  "to_version": "3.3.1-beta.1",
  "checks": {
    "version_after_relaunch": "PASS",
    "order_persisted": "PASS",
    "printer_config_persisted": "PASS",
    "settings_persisted": "SKIP (pre-toggle fixture; N predates beta preference)"
  }
}
```

The updater log records the actual download path:

```text
Found version 3.3.1-beta.1 (...linux-x64.appimage, ...linux-x64.deb, ...linux-x64.rpm)
Downloading update from ...linux-x64.appimage, ...linux-x64.deb, ...linux-x64.rpm
Cannot download differentially, fallback to full download: Error: EBADF: bad file descriptor, close
New version 3.3.1-beta.1 has been downloaded .../pending/flocafe-3.3.1-beta.1-linux-x64.appimage
Install on explicit quitAndInstall
Executing: .../flocafe-3.3.1-beta.1-linux-x64.appimage
```

Thus the row proves a real full-download fallback and records the differential
attempt. The runtime needed `--appimage-extract-and-run` for the manual
post-install relaunch on this host; the updater itself swapped and executed
the N+1 file. The differential `EBADF` fallback is a product finding for a
future issue; this mission did not silently expand scope to change updater
behavior.

## Older cohort

**Result: PASS-verified.** [Run 32775289667](https://github.com/FreeOpenSourcePOS/FloCafe/actions/runs/32775289667)
installed the released 2.9.7 NSIS artifact, seeded the same markers, followed
the stable feed to 3.3.0, and completed the bounded staged-NSIS handoff. The
evidence JSON reports `to_version: 3.3.0`, version/order/printer persistence
PASS, and the uploaded artifact is
[`evidence-older-cohort-windows`](https://github.com/FreeOpenSourcePOS/FloCafe/actions/runs/32775289667/artifacts/9537742761).

## Linux managed gating

**Result: PASS-verified for deb.** On the real Debian machine, the 3.3.0 deb
was extracted and launched without system mutation, with a separate HOME and
ports. A live CDP listener captured the main-process event after requesting a
check:

```text
EVENT:{"status":"linux-managed"}
updater fetch attempts in app stdout: 0
```

This proves a package-manager installation does not call the self-updater.
The old 3.3.0 client broadcasts this one-shot state without persisting it in
`get-update-status`; the evidence therefore captures the event itself rather
than incorrectly polling a default `up-to-date` value.

## Findings and scoped fixes

1. **Pre-toggle reachability gap:** 3.3.0 cannot opt into beta because #507 was
   released after it. The matrix uses an explicitly labelled test-only updater
   fixture for Windows/Linux and does not claim beta-preference persistence for
   N. The macOS signed-fixture barrier is recorded above.
2. **Updater fallback:** the real AppImage row encountered `EBADF` during the
   differential attempt and succeeded via full download. This is recorded as a
   product finding; no unrelated updater refactor was made.
3. **Windows NSIS handoff:** the first hosted attempts stopped after the
   updater handed off to the assisted NSIS installer, which waited for UI and
   left the old process alive. The bounded helper now captures the staged
   process, reruns that exact installer silently, checks exit status, and
   relaunches with CDP. This is a scoped test-harness fix; SmartScreen trust
   behavior remains separately NOT-RUN.
4. **Release pipeline:** the first real beta build exposed pwsh argument
   parsing, draft-release lookup, an over-strict Linux manifest allow-list, and
   a Snap Store macaroon restricted to stable/edge. Scoped fixes are in the
   release workflow/verifier; Snap restriction is a loud warning while GitHub
   artifacts remain publishable. The store credential still needs owner
   rotation to enable beta publishing.
5. **CI log hygiene:** the initial Windows workflow exposed fixture
   credential-like environment values through Actions' automatic step env dump.
   The current workflow keeps those values as step-local shell variables so
   future logs do not print a credential-like env block. The fixtures are
   synthetic test values, not production credentials; no real secret was
   entered or captured.

No screenshots were captured, per the evidence-only/log-based test instruction.

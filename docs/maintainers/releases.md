# Desktop releases

FloCafe desktop releases use one electron-builder pipeline and publish to GitHub Releases for
Windows (NSIS), macOS (DMG and ZIP), and Linux (AppImage, deb, rpm, Snap). AppX and Mac App Store
packages are produced by the same tag build and uploaded as GitHub release assets; they are not
consumed by `electron-updater` and are not submitted to their stores by this pipeline. Snap Store
uploads are separate from the GitHub release.

## Channels

The default install is the stable channel. There are exactly two channels, `stable` and `beta`.

| | Stable | Beta |
| --- | --- | --- |
| Package version | `X.Y.Z` | `X.Y.Z-beta.N` |
| Updater manifest prefix | `latest` | `beta` |
| Manifests emitted | `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, `latest-linux-arm64.yml` | `beta.yml`, `beta-mac.yml`, `beta-linux.yml`, `beta-linux-arm64.yml` |
| GitHub prerelease | no | yes |
| GitHub Latest pointer | eligible after promotion | never |
| Snap Store channel | `stable` | `edge` |

The manifest prefix is computed once in the release metadata step and passed to every
electron-builder invocation, so a build emits exactly one channel's manifest set. A beta build
cannot emit a `latest*.yml` manifest and a stable build cannot emit a `beta*.yml` manifest: the two
feeds are structurally isolated rather than separated by a runtime check.

Any other channel value is rejected at the release metadata step, which fails the workflow before
anything is built. A version stamped with an unsupported prerelease identifier, such as a local
alpha, is treated as beta and follows the beta feed.

A stable install leaves the updater channel unset and follows the stable feed. It can opt in to
beta updates through the in-app switch in **Settings > Updates**, which reads and writes
`updates.beta_channel_enabled` in the SQLite settings store through the
`updates:get-beta-channel` and `updates:set-beta-channel` IPC pair. Opting out returns an install to
the stable feed. A beta-stamped install that opts out does not downgrade immediately: it holds its
version until the next matching or newer stable release is published, then graduates without a
database schema rollback.

When a downloaded update is ready, restarting from Settings or the update badge requires manager or
owner Master PIN approval in the main process. The confirmation warns that POS, KDS, printing, and
reports are unavailable while the update installs, that the service returns after restart, and that
installation should not be started during business hours. Cancelling the prompt or failing PIN
approval leaves the app running.

## Snap Store publication

Each Linux architecture publishes its own snap, tagged separately, and the Snap Store keeps
multiple per-architecture revisions under the one snap name.

| Release channel | Snap Store channel |
| --- | --- |
| `stable` | `stable` |
| `beta` | `edge` |

Beta publishes to `edge` because the Snap Store credential macaroon in use is scoped to the
`stable` and `edge` channels. This keeps a prerelease out of the stable package-manager channel.

Publication evidence is asymmetric by design. A stable release requires a sanitized publication
marker for both `x64` and `arm64`; missing or invalid markers block draft verification and block
promotion. A beta release does not require the markers, because beta Snap publication is
permission-limited, and an upload denied with `invalid-channel-permission` is downgraded to a
warning rather than failing the release. The GitHub release still carries the full snap artifact
set.

The Snap Store credential check is at runtime rather than in an `if:` condition, because GitHub
Actions does not allow `secrets` in `if:` expressions. A missing credential is a release failure,
not a skipped channel.

## Artifact naming

Every published release must carry this exact inventory.
[`scripts/verify-release-assets.cjs`](../../scripts/verify-release-assets.cjs) requires all of these
names and no substitutes.

| Platform | Artifact names, where `<version>` is the release version |
| --- | --- |
| Windows | `flocafe-<version>-win-x64.exe`, `flocafe-<version>-win-x64.exe.blockmap`, `flocafe-<version>-win-x64.appx`, `flocafe-<version>-win-arm64.appx` |
| macOS | `flocafe-<version>-mac-x64.dmg`, `flocafe-<version>-mac-arm64.dmg`, `flocafe-<version>-mac-x64.zip`, `flocafe-<version>-mac-arm64.zip`, `flocafe-<version>-mac-x64.zip.blockmap`, `flocafe-<version>-mac-arm64.zip.blockmap` |
| Linux | `flocafe-<version>-linux-x64.appimage`, `flocafe-<version>-linux-arm64.appimage`, `flocafe-<version>-linux-x64.deb`, `flocafe-<version>-linux-arm64.deb`, `flocafe-<version>-linux-x64.rpm`, `flocafe-<version>-linux-arm64.rpm`, `flocafe-<version>-linux-x64.snap`, `flocafe-<version>-linux-arm64.snap` |

Plus the two uninstaller scripts `uninstall-macos.sh` and `uninstall-windows.ps1`.

The architecture token is `x64` or `arm64`. electron-builder's own target spellings
(`x86_64`, `amd64`, `aarch64`) are not used in release asset names, and a release using them fails
verification. [`scripts/assert-release-artifact-names.cjs`](../../scripts/assert-release-artifact-names.cjs) additionally requires every
filename in `release/` to match `[a-z0-9.-]+`.

Older releases, before the naming contract was enforced, used the electron-builder spellings, such
as `flocafe-3.3.0-x86_64.AppImage`. The upgrade matrix falls back to those names when fetching a
release N, but nothing produces them today.

## Promotion to GitHub Latest

Promotion is two separate jobs with deliberately different guards.

`promote-stable` runs inside the tag workflow and has a backward guard. Before moving the Latest
pointer it compares the candidate tag against the current Latest with `sort -V` and refuses to
promote if the current Latest is newer. It also refuses a draft release and refuses a prerelease.

`promote-release` is a manual dispatch for promoting an already-published historical stable
release, for example one that was held back. It has no ordering guard. That asymmetry is
intentional: the automatic path runs on a tag that CI has just built and verified, so moving
Latest backward there is always a mistake worth failing on. The manual path exists for the
recovery case where a release is promoted after a gap, and there the operator is making an
explicit, informed choice about a tag that was verified when it was built. It still refuses a
non-stable channel, a draft, and a prerelease.

Both jobs require `promote_stable=true`, which the release metadata step refuses for any channel
other than stable.

## Release evidence

Each published release carries a `release-summary.json` asset, and sanitized candidate evidence is
retained as a workflow artifact for 90 days. That release asset is the durable index. A
documentation page is not.

`release-summary.json` is built by
[`scripts/release-gate/evidence.cjs`](../../scripts/release-gate/evidence.cjs) and deliberately has a
fixed schema. It rejects credential-bearing field names and credential-shaped values rather than
trying to clean arbitrary logs after the fact, so a summary can never contain a password, PIN,
token, or private key.

Every status in the summary is one of `PASS`, `FAIL`, or `NOT-RUN`. The distinction is the point:

- **`PASS` means a check ran and the thing it checks was verified.** A Snap row reads `PASS (x64
  and arm64 publication evidence recorded)` only when both per-architecture markers exist.
- **`NOT-RUN` means nobody checked, and is not a pass.** The manual and residual-risk rows are
  always `NOT-RUN`, including `windowsSmartScreen`, `desktopCompositor`, `physicalPrinters`,
  `masReview`, and `microsoftStore`.
- **`FAIL` blocks.** A stable release with incomplete Snap publication evidence summarizes as
  `FAIL` and promotion is blocked.

Windows direct-download signing is always recorded as an explicit status. A build explicitly
marked unsigned is summarized as `UNSIGNED (accepted residual risk)`, and a build whose signing
status was never verified is summarized as `NOT-VERIFIED`. Neither is signing or SmartScreen
evidence.

The Windows installer ships unsigned, so users see the SmartScreen "Windows protected your PC"
prompt, and SmartScreen reputation is an interactive Windows behaviour that hosted runners cannot
observe.

## Manual pre-release QA

CI covers Chromium in Electron and the packaged desktop app. The standalone server app on port
`3003` is the one surface FloCafe does not control the runtime for: staff reach it from whatever
browser their device has. Before promoting a stable release, check it on:

- **Safari on iOS**, current major version.
- **An older Android WebView**, the default in-app browser on a device that has not been updated to
  the current Chrome or WebView release.

Check that the page loads and renders the store's regional currency and timezone rather than
fallback values, that order creation and the payment flow complete, and that live updates do not
silently stall. Record the device, OS, and browser you tested in the release notes or the release
pull request.

## Cutting a release

### Beta

1. Pick the version as `X.Y.Z-beta.N`, counting `N` up within the same `X.Y.Z`. Bump
   `package.json`. CI generates release notes with `git-cliff`, falling back to `CHANGELOG.md`.
2. Commit the version bump to `main`, tag exactly `X.Y.Z-beta.N`, and push the tag.
3. Run **Actions > Release > Run workflow** from that tag with `release_tag=X.Y.Z-beta.N`,
   `channel=beta`, and `promote_stable=false`.
4. The workflow builds every platform against the beta manifest prefix, verifies the draft against
   the beta manifests and their referenced artifacts, creates the immutable
   `candidate-manifest.json` and the sanitized `release-summary.json`, then publishes as a
   prerelease with `make_latest=false`.

A beta never becomes GitHub Latest, and the stable feed is unchanged by a beta publication. A
propagation check confirms that the beta artifacts are reachable and that stable Latest did not
move.

### Stable

1. Follow the same steps with an `X.Y.Z` version, `channel=stable`, and `promote_stable=false`.
2. Verify the draft, the installed-artifact upgrade matrix, and the manual server app checklist.
3. Run a second dispatch of the same workflow with `promote_stable=true` to move the verified
   release to GitHub Latest.

The candidate gate workflow consumes only a published beta, and only when given the exact
candidate manifest asset ID and SHA-256. It verifies propagation and that stable Latest is
unchanged. It does not publish or promote.

## Tag and branch lifecycle

Beta-prep branches are temporary working branches. Release tags and GitHub Releases are the
authoritative history: commit the version bump to `main`, create an annotated signed tag from that
`main` history, and push the exact `X.Y.Z-beta.N` or `X.Y.Z` tag.

Repository administrators must additionally protect numeric release tags from arbitrary creation,
deletion, and force-updates, and require signed commits and signed tags for the release actors. The
workflow's own gate is the repository-code control. The GitHub rules are the platform-level control
that stops an unauthorized tag push from reaching the workflow at all.

# Desktop release process

FloCafe desktop releases use one electron-builder pipeline and GitHub Releases for
NSIS/Windows, macOS DMG+ZIP, and Linux AppImage/deb/rpm/Snap artifacts. Microsoft
Store (AppX) and Mac App Store (MAS) packages are submitted to their stores and
are not consumed by `electron-updater`. Snap Store uploads map the release
channel to a channel the configured macaroon permits (#468): stable releases
publish to the `stable` channel and beta releases publish to the `edge`
(opt-in) channel; an upload denied with `invalid-channel-permission` is
downgraded to a warning and the GitHub release remains publishable. Stable
draft verification requires both per-architecture Snap publication markers.
Snap installations are updated by snapd rather than `electron-updater`.

Nightly releases are explicitly rejected (#503): beta is the only prerelease
distribution channel, and no nightly publish path exists anywhere in the
release pipeline. A version stamped with any other prerelease identifier (an
old nightly build, a local alpha) gets stable updates only.

## Release channels

The default install is the **stable** channel. A stable build uses the
`latest.yml`, `latest-mac.yml`, and `latest-linux.yml` manifests. The Linux ARM64
build also emits `latest-linux-arm64.yml`.

Beta builds are opt-in distributions. Their package versions use a semver
prerelease component (`3.3.1-beta.1`) and the release workflow passes the
matching channel explicitly to electron-builder. They publish `beta*.yml`
manifests including the platform suffix (`beta.yml`, `beta-mac.yml`,
`beta-linux.yml`, `beta-linux-arm64.yml`). Because electron-builder generates
exactly one channel manifest set per GitHub publish config, a beta build can
never emit a stable (`latest*.yml`) manifest and vice versa - the stable feed
is structurally isolated from betas.

A beta installation enables beta updates by default; a stable installation
leaves `autoUpdater.channel` unset by default but can opt in through the in-app
switch exposed as the IPC pair `updates:get-beta-channel` / `updates:set-beta-channel`
(persisted in the SQLite settings store under `updates.beta_channel_enabled`,
resolved in `main/update-channel.ts`). An opted-in install follows the beta manifest.
Opting out returns the updater to the stable feed (`latest.yml`). A beta-stamped
build that opts out does not downgrade immediately; instead, it safely waits on
its current version until the next matching or newer stable release is published,
graduating to stable without database schema rollbacks or corruption.

Desktop builds that expose the beta-channel IPC contract provide a beta
pre-release toggle in **Settings > Updates**. The toggle reads and persists its
state through the main process; older builds without that contract show the
control as disabled with an explanation. When a downloaded update is ready,
restarting from Settings or the update badge requires manager or owner Master
PIN approval in the main process. The confirmation warns that POS, KDS,
printing, and reports are unavailable while the update installs, that the
service returns automatically after restart, and that installation should not
be started during business hours. Cancelling or failing PIN approval leaves the
app running.

GitHub's `Latest` release pointer and electron-updater's channel manifests are
separate concepts. Every release is created with `--draft --latest=false`.
After all platform uploads have completed, CI downloads each manifest and every
artifact it references from the same draft release, checks HTTP success, and
recomputes the manifest SHA-512 values. Only the separate `publish-release` job
can then publish it. Stable tag pushes publish without moving GitHub's `Latest`
pointer. To promote an already verified stable release, dispatch the workflow
from that exact tag with `release_tag` set to the same tag,
`channel=stable`, `promote_stable=true`, and the candidate manifest asset ID
and SHA-256 from the verified release; the promotion-only job checks that the
release is already published before selecting it. Beta releases never move
that pointer: they stay prerelease-flagged with `make_latest=false`, which is
what keeps them invisible to stable installs (electron-updater's stable path
follows GitHub's Latest pointer and ignores prereleases entirely).
Promotion from beta to stable is always a deliberate human action; there is no
automatic promotion path.

This follows electron-builder's channel model: GitHub publishing requires an
explicit `publish.channel`, while prerelease versions select prerelease releases
for opted-in clients. `autoUpdater.channel` enables a beta-channel client and
implicitly permits channel transitions; FloCafe enables `allowDowngrade` only
for beta builds remaining on the beta feed. Opting out or following stable disables
`allowPrerelease` and `allowDowngrade` so installs safely wait for the next matching
or newer stable release without database rollbacks.

## Release gates

1. The tag and `package.json` version must match (`X.Y.Z` or `X.Y.Z-beta.N`).
2. Each platform builds with `--publish never` and passes
   `scripts/assert-release-artifact-names.cjs`. Produced filenames must match
   `[a-z0-9.-]+`. electron-builder's generic `${arch}` macro uses target
   spellings such as `x86_64`, `amd64`, and `aarch64`, so the Linux release
   command explicitly uses the safe matrix labels `x64` and `arm64` for every
   artifact (including AppImage); artifacts are not renamed after creation.
3. Each self-updating platform job asserts that its local updater manifest
   and representative installer exist before upload. Platform jobs upload
   installers, update manifests, blockmaps, and required store packages to the
   draft release. Microsoft Store AppX submission runs only for stable tag
   pushes. Beta AppX packages remain outside the Store submission
   path because their four-part MSIX versions would otherwise collide with
   stable and with later prereleases.
4. `scripts/verify-release-assets.cjs` fetches the draft release metadata, then
   downloads manifests and every referenced asset back through the GitHub API.
   It parses each manifest as YAML, requires every referenced asset to resolve
   to HTTP 200 in that same release, and recomputes the manifest SHA-512 for
   every self-updating artifact. Missing or malformed manifests, unavailable
   references, and checksum mismatches fail the workflow. It also checks the
   expected installer/store/uninstaller inventory and HTTP availability for
   uploaded assets that are not referenced by an updater manifest. Those
non-manifest assets are checked for positive size and HTTP availability; their
SHA-512 is not independently recomputed because GitHub/electron-builder does
not publish a second expected SHA-512 for them.
5. The dedicated publish job changes `draft` to false. It sets `make_latest`
   false for every normal release. A separate explicit stable-promotion dispatch
   is the only path that changes GitHub's `Latest` pointer.
6. After all platform uploads, the workflow creates and attaches the immutable
   candidate manifest and sanitized release summary defined in the [release
   evidence index](release-evidence-index.md). The candidate manifest is made
   from bytes fetched back from the draft, and a rerun refuses to overwrite
   different manifest or summary bytes.
7. Each Linux job uploads a per-architecture Snap marker only after
   `snapcraft upload` succeeds. The [release evidence index](release-evidence-index.md)
   defines the stable and beta Snap evidence boundaries; stable draft
   verification and promotion both fail closed on missing or invalid markers.
8. `release-candidate-gate.yml` consumes only a published beta with the exact
   candidate manifest asset ID and SHA-256. It verifies propagation and that
   Stable Latest is unchanged, then retains the sanitized JSON evidence defined
   by the [release evidence index](release-evidence-index.md) for 90 days. It
   does not publish or promote a release.

For a beta release, use the exact `X.Y.Z-beta.N` prerelease tag, set
`release_tag` to that tag, and choose `channel=beta`. For a stable build, leave
`promote_stable=false`; use a second dispatch with `promote_stable=true` only
when the already verified release should become the default update target.

## Branch and tag lifecycle

Beta-prep branches are temporary working branches; release tags and GitHub
Releases are the authoritative history. Cut each future beta from `main` with
an exact `X.Y.Z-beta.N` tag. Stable promotion creates a new `X.Y.Z` stable
release and uses the explicit `promote_stable` step. A beta is never moved
directly to GitHub `Latest`.

## Cutting a beta release

1. Pick the next version as `X.Y.Z-beta.N` (`N` counts up within the same
   `X.Y.Z`: `3.3.1-beta.1`, then `3.3.1-beta.2`, ...). Bump `package.json`
   and ensure conventional commits exist or update `CHANGELOG.md` via
   `npm run changelog:generate` (CI generates release notes via `git-cliff`,
   falling back to `CHANGELOG.md`).
2. Commit to `main`, tag exactly `X.Y.Z-beta.N`, and push the tag.
3. Run **Actions > Release > Run workflow** from that tag:
   `release_tag=X.Y.Z-beta.N`, `channel=beta`, `promote_stable=false`.
4. The workflow builds all platforms against the beta manifest prefix,
   verifies the draft (`beta.yml`, `beta-mac.yml`, `beta-linux.yml`,
   `beta-linux-arm64.yml` plus referenced artifacts), creates the immutable
   candidate manifest and permanent sanitized summary, then publishes it as a
   **prerelease** with `make_latest=false`. A propagation check confirms every
   bound asset is downloadable and Stable Latest is unchanged. Snap Store
   packages go to the `stable` or `edge` snap channel (release channel →
   store channel mapping, #468); a channel-permission warning does not block
   GitHub release publication.
5. Run **Actions > Release candidate confidence gate** with the exact published
   beta tag, commit, candidate-manifest asset ID/SHA-256, Stable Latest tag, and
   the exact stable `from_version` installed as N by the runtime matrix.
   Set `run_installed_matrix=true` when the exact installed-artifact rows should
   run. The matrix verifies the immutable candidate manifest immediately before
   seeding the installed N client, then waits for the real update flow. Set it
   to `false` when those rows are intentionally omitted; the gate records them
   as explicit **NOT-RUN** rather than claiming a pass. The gate dispatches the
   existing matrix and waits for its result; it never starts a competing
   upgrade harness. Final retained evidence records the matrix as `PASS`,
   `FAIL`, or `NOT-RUN` after that result is known.
6. Sanity-check from a beta-enabled install (or an opted-in stable one):
   Check for Updates should offer `X.Y.Z-beta.N` via `beta.yml`.

## Promoting a beta (or any verified release) to stable

There is no automatic promotion. Promoting a beta means cutting the real
stable release:

1. Decide the final stable version `X.Y.Z`, bump `package.json` (dropping the
   prerelease suffix), update `CHANGELOG.md` via `npm run changelog:generate` if needed, commit to `main`,
   tag `X.Y.Z`, and push the tag.
2. Let the tag push run the full stable release. It publishes with
   `make_latest=false` like every release.
3. To make it the default update target, dispatch **Release** once more from
   that exact tag with `release_tag=X.Y.Z`, `channel=stable`,
   `promote_stable=true`, plus the candidate-manifest asset ID and SHA-256. The
   promotion-only job revalidates that immutable manifest against every current
   release asset and first requires the permanent candidate summary and both
   stable Snap publication markers, then refuses anything unpublished or
   prerelease-flagged before selecting it as
   GitHub Latest. Stable installs see it on their next update check.

Betas also act as the N+1 update source for runtime upgrade matrix testing
(#468): a client pinned to a given Electron runtime validates the next
runtime by updating through a beta before the stable cut.

References: [electron-builder release channels](https://www.electron.build/docs/tutorials/release-using-channels/),
[electron-updater channel and downgrade options](https://www.electron.build/docs/api/electron-updater.class.baseupdater/),
and [GitHub release `make_latest`](https://docs.github.com/en/rest/releases/releases).

# Desktop release process

FloCafe desktop releases use one electron-builder pipeline and GitHub Releases for
NSIS/Windows, macOS DMG+ZIP, and Linux AppImage/deb/rpm/Snap artifacts. Microsoft
Store (AppX) and Mac App Store (MAS) packages are submitted to their stores and
are not consumed by `electron-updater`. Snap Store uploads use stable, beta, or
edge for the matching FloCafe channel and are updated by snapd rather than
`electron-updater`.

## Release channels

The default install is the **stable** channel. A stable build uses the
`latest.yml`, `latest-mac.yml`, and `latest-linux.yml` manifests. The Linux ARM64
build also emits `latest-linux-arm64.yml`.

Beta and nightly builds are opt-in distributions. Their package versions use a
semver prerelease component (`3.3.0-beta.1` or `3.3.0-nightly.20260823`) and the
release workflow passes the matching channel explicitly to electron-builder.
They publish `beta*.yml` or `nightly*.yml` manifests, including the platform
suffix. A beta/nightly installation derives its channel from its version in
`main/index.ts`; a stable installation leaves `autoUpdater.channel` unset and
therefore follows only GitHub's selected stable release.
Beta and nightly installations are intentionally isolated from stable: if their
channel has no published release, electron-updater reports no channel update
instead of silently falling back to stable.

GitHub's `Latest` release pointer and electron-updater's channel manifests are
separate concepts. Every release is created with `--draft --latest=false`.
After all platform uploads have completed, CI downloads each manifest and every
artifact it references from the same draft release, checks HTTP success, and
recomputes the manifest SHA-512 values. Only the separate `publish-release` job
can then publish it. Stable tag pushes publish without moving GitHub's `Latest`
pointer. To promote an already verified stable release, dispatch the workflow
from that exact tag with `release_tag` set to the same tag,
`channel=stable`, and `promote_stable=true`; the promotion-only job checks that
the release is already published before selecting it. Beta and nightly releases
never move that pointer.

This follows electron-builder's channel model: GitHub publishing requires an
explicit `publish.channel`, while prerelease versions select prerelease releases
for opted-in clients. `autoUpdater.channel` enables a non-stable client and
implicitly permits channel transitions; FloCafe sets `allowDowngrade` explicitly
because returning from a prerelease to stable can be a lower semver comparison.
Stable clients keep `allowPrerelease` and `allowDowngrade` disabled.

## Release gates

1. The tag and `package.json` version must match (`X.Y.Z`, `X.Y.Z-beta.N`, or
   `X.Y.Z-nightly.N`).
2. Each platform builds with `--publish never` and passes
   `scripts/assert-release-artifact-names.cjs`. Produced filenames must match
   `[a-z0-9.-]+`; Linux release jobs use the safe matrix labels `x64` and
   `arm64` in the electron-builder template, and artifacts are not renamed
   after electron-builder creates them.
3. Platform jobs upload installers, update manifests, blockmaps, and required
   store packages to the draft release.
   Microsoft Store AppX submission runs only for stable tag pushes. Beta and
   nightly AppX packages remain outside the Store submission path because their
   four-part MSIX versions would otherwise collide with stable and with later
   prereleases.
4. `scripts/verify-release-assets.cjs` fetches manifests and referenced assets
   back through the GitHub API and verifies their SHA-512 values. It also checks
   the expected installer/store/uninstaller inventory and HTTP availability for
   uploaded assets that are not referenced by an updater manifest. Those
non-manifest assets are checked for positive size and HTTP availability; their
SHA-512 is not independently recomputed because GitHub/electron-builder does
not publish a second expected SHA-512 for them.
5. The dedicated publish job changes `draft` to false. It sets `make_latest`
   false for every normal release. A separate explicit stable-promotion dispatch
   is the only path that changes GitHub's `Latest` pointer.

Run **Actions > Release > Run workflow** from the exact matching prerelease tag,
set `release_tag` to that tag, and choose `channel=beta` or `channel=nightly`.
For a stable build, leave `promote_stable=false`; use a second dispatch with
`promote_stable=true` only when the already verified release should become the
default update target.

References: [electron-builder release channels](https://www.electron.build/docs/tutorials/release-using-channels/),
[electron-updater channel and downgrade options](https://www.electron.build/docs/api/electron-updater.class.baseupdater/),
and [GitHub release `make_latest`](https://docs.github.com/en/rest/releases/releases).

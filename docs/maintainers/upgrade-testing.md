# Runtime upgrade testing

A release build is only proven upgradeable by installing a real released artifact as N, letting it
stage a real N+1 through the product's own update path, applying it, and checking that the data
before the upgrade is intact afterwards. This page describes that harness and what each kind of row
can honestly claim.

The harness is
[`.github/workflows/upgrade-matrix.yml`](../../.github/workflows/upgrade-matrix.yml), which is
dispatched per release gate with the candidate tag, the candidate commit, the candidate manifest
asset ID and SHA-256, the version to install as N, and a dispatch correlation ID. The driver is
[`scripts/upgrade-matrix/run-upgrade.cjs`](../../scripts/upgrade-matrix/run-upgrade.cjs) with shared
helpers in [`harness.cjs`](../../scripts/upgrade-matrix/harness.cjs).

## What a row does

Every row runs the same two phases.

**Seed**, while release N is running: complete first-run setup, create identifiable data through the
app's own API (an order with a marker note, printer configuration, and settings), opt into the
update channel, wait for the update to be staged, then invoke the same Master-PIN-gated
`restart-and-install` IPC that the **Restart Now** button uses. The row exits once the app begins
quitting to install.

**Verify**, after the upgraded build has launched again: assert the running version equals the
expected N+1, that every seeded record survived, and that the persisted channel preference
survived. On success it prints an evidence JSON document.

Seeding through the app's own API rather than writing to the database directly is what makes the
result meaningful. It proves the data is reachable through the API after the upgrade, not merely
that rows are still present in a SQLite file.

The candidate manifest is verified immediately before the seed phase, so a row cannot pass against
a candidate that is not the one the release gate admitted.

## What each kind of row proves

The matrix has four jobs, and they do not all claim the same thing.

### Self-updating rows: Windows NSIS and Linux AppImage

`windows-nsis-x64` and `linux-appimage` (x64 and arm64) install a real released artifact, upgrade it
through `electron-updater`, and verify version and data. These are the rows that prove a genuine
installed-artifact N to N+1 upgrade. `older-cohort-windows` repeats the Windows row from a much
older N to catch upgrade paths that a single-step test would miss.

A self-updating row must show the old process exiting before the new one is started, and the new
build reaching API readiness. A build that exits before readiness, or stays alive after reporting
ready, fails the row.

### Managed-package gating rows: deb and Snap

`linux-managed-gating` covers deb and Snap, and it is a **gating** check, not an upgrade test.

On Linux, a package-manager install has no in-app update path. The app detects this in
`main/index.ts` and reports an update status of `linux-managed` or `store-managed` instead of
staging anything. The row asserts exactly that: the updater reports a managed status, and the log
contains no `Downloading update`, `beta.yml`, or `latest.yml` line.

This is a bounded check on one branch of the updater's decision. It proves the app correctly
declines to self-update on a managed install. It is **not** evidence that `apt` or `snapd` can
perform the upgrade, and it is not evidence that the database survives one. The Snap row is
additionally marked experimental, so its failure does not fail the matrix.

Do not read a green `linux-managed-gating` row as package-manager upgrade coverage. That would be a
stronger claim than the check makes.

### Platform coverage and the macOS gap

The hosted workflow has no macOS row. macOS rows are run locally, outside this workflow, because
instrumenting a macOS installed build to point it at a candidate release invalidates the app
bundle's Developer ID sealed resources, and the native Squirrel.Mac updater then rejects the staged
update on signature validation. The hosted runners cannot produce that result on demand, so macOS
upgrade evidence comes from a manual run and is recorded against the release rather than produced
by the matrix.

When a manual macOS row is run, it must meet the same bar as a hosted row: a real released N, the
real update path, and a version plus persistence check afterwards.

## Download path and evidence

The updater may reach N+1 by a differential download or by a full download. A differential attempt
that fails and falls back to a full download is still a successful upgrade: what the row asserts is
the resulting version and the surviving data, not which path the bytes took. The AppImage and
Windows rows record which path the updater reported, so a fallback is visible in the evidence
without failing the row.

A differential failure that always falls back is a product finding about the updater, not an
upgrade failure, and it belongs in an issue rather than in this page.

Each job uploads its evidence artifact, and the release summary records the matrix as a single
status. When the matrix is not run, the status is `NOT-RUN` and must not be described as an upgrade
pass. See [releases](releases.md) for how a `NOT-RUN` row is summarized.

## Running the matrix

Dispatch the workflow with:

| Input | Meaning |
| --- | --- |
| `from_version` | The released version to install as N. |
| `candidate_tag` | The exact beta candidate tag to install and test as N+1. |
| `candidate_commit` | The exact commit the candidate manifest binds. |
| `candidate_manifest_asset_id` | Asset ID of `candidate-manifest.json`. |
| `candidate_manifest_sha256` | SHA-256 of the manifest bytes. |
| `to_version` | The expected version after the upgrade. |
| `matrix_dispatch_id` | Correlation ID matching the release gate dispatch. |
| `run_linux` | Whether to run the Linux rows. |

The Windows and Snap rows fetch release N by URL. For a release predating the current naming
contract, they fall back to the older artifact name before failing.

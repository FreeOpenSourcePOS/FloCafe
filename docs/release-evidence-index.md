# Release evidence index

This file defines the permanent, sanitized release summary contract. Each
published desktop release carries a `release-summary.json` asset produced by
`release.yml`; detailed hosted-runner evidence is retained for 90 days by
`release-candidate-gate.yml`. The release asset is the durable index and must
never contain credentials, passwords, PINs, tokens, or raw credential-bearing
logs.

## Automated rows

- Candidate tag, exact commit, asset IDs/names, platform/architecture, SHA-256,
  SHA-512, and signing status: `candidate-manifest.json`.
- Draft inventory, manifests, downloadability, and update-artifact hashes:
  `scripts/verify-release-assets.cjs`.
- Beta publication, propagation, and Stable Latest immutability:
  `scripts/release-gate/published-readiness.cjs`.
- Stable Snap publication: one sanitized marker per architecture, checked by
  `scripts/release-gate/verify-stable-promotion.cjs`.
- Beta Snap Store permission denial: explicitly degraded/NOT-RUN; beta draft
  verification does not treat missing permission-denied markers as a pass.

## Explicit external/manual boundaries

The following are **NOT-RUN**, not passes, unless separately evidenced by an
approved manual release record:

- Windows SmartScreen reputation and interactive unsigned-installer behavior.
- Real GNOME/Wayland compositor, display scaling, pointer, and shell behavior.
- Physical USB/network/CUPS/WebUSB printers and printed receipts.
- Mac App Store signing, Transporter submission, and Apple App Review.
- Microsoft Store submission, listing, flight, and review.

Unsigned Windows direct-download artifacts are recorded as an explicit residual
risk. A Windows signature, if later added, does not constitute SmartScreen
reputation evidence.

## Installed-artifact integration boundary

The release-candidate workflow does not duplicate the runtime upgrade harness.
It dispatches and waits for the durable #468 workflow only after that workflow
(from PR #512) exposes and validates these exact inputs:

- `candidate_tag`
- `from_version`
- `candidate_manifest_asset_id`
- `candidate_manifest_sha256`
- `matrix_dispatch_id` (included in the matrix run name for correlation)

Until #512 lands with that contract, installed-artifact rows remain
**NOT-RUN** and the candidate gate must not be described as a complete runtime
upgrade pass.

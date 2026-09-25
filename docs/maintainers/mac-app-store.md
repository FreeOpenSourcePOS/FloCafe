# Mac App Store publishing

The Mac App Store build is a separate manual workflow,
[`.github/workflows/publish-mas.yml`](../../.github/workflows/publish-mas.yml). It builds the MAS
package and submits it through fastlane and Transporter. The release workflow produces the MAS
package as a build target but does not submit it, and the MAS path is not consumed by
`electron-updater`, so it is invisible to in-app updates.

## Runner requirement

The job runs on a self-hosted macOS runner, matched by the `self-hosted` and `macOS` labels.
Transporter and the App Store Connect API key need a real macOS host with Xcode command-line tools
and an Apple ID enrolled in the team, none of which a hosted runner provides.

## Credentials

Five secrets are required. The workflow verifies all of them in one step before installing
anything, and fails with the list of missing names if any is empty.

| Secret | Purpose |
| --- | --- |
| `MAC_CERTS` | The signing certificate in `CSC_LINK` form. |
| `MAC_CERTS_PASSWORD` | Password for `MAC_CERTS`. |
| `APPLE_API_KEY` | The App Store Connect API `.p8` key content, base64-encoded. |
| `APPLE_API_KEY_ID` | Key identifier. |
| `APPLE_API_ISSUER` | Issuer identifier. |

Three repository variables are optional and have defaults, so the workflow works without setting
them.

| Variable | Default |
| --- | --- |
| `APPLE_TEAM_ID` | `BKDY677XJA` |
| `MAS_APP_IDENTIFIER` | `com.flo.desktop` |
| `MAS_RELEASE_LOCALE` | `en-US` |

Two more inputs are passed straight through from the workflow dispatch to the fastlane lane:
`MAS_SUBMIT_FOR_REVIEW`, defaulting to true, and `MAS_AUTOMATIC_RELEASE`, also defaulting to true.

## Release notes

The lane reads release notes from a file, not from an environment variable.

The workflow prepares `release/mas-release-notes.txt` in one of two ways. If the `release_notes`
dispatch input is non-empty, it is written to that path verbatim. If it is empty,
[`scripts/mas-release-notes.sh`](../../scripts/mas-release-notes.sh) builds the "What's New" text
from the current `CHANGELOG.md` entry for the version, stripping markdown formatting and failing if
the result exceeds Apple's limit.

The path is passed to the lane as `MAS_RELEASE_NOTES_PATH`, which
[`fastlane/Fastfile`](../../fastlane/Fastfile) reads. This is the knob to set when you supply notes
from somewhere other than the default file.

`SKIP_MAS_BUILD` is the other knob. It is read by the Fastfile, not the workflow. When it is set
to a truthy value, the lane skips the `npm run build:mas` step and submits whatever `.pkg` is
already in `release/`. It defaults to false, so a normal dispatch builds. Set it when you are
re-submitting a package you have already built locally.

The lane reads the version from `package.json` and refuses to continue if the notes are empty or
longer than Apple's 4,000 character limit. That check is duplicated in
[`scripts/mas-release-notes.sh`](../../scripts/mas-release-notes.sh), so the limit is enforced
whether the notes come from the dispatch input or from the changelog.

## What the lane does

`.github/workflows/publish-mas.yml` runs these steps in order:

1. Verify the run is from the selected release tag, then validate the release ref with
   [`scripts/release-gate/validate-release-ref.cjs`](../../scripts/release-gate/validate-release-ref.cjs),
   which requires the tag to come from `main` history.
2. Check out the exact commit with `persist-credentials: false`.
3. Set up Ruby 3.3 with a bundler cache.
4. Verify the five secrets.
5. Install dependencies with `npm ci`.
6. Verify the Electron dev runtime with `npm run verify:electron`.
7. Prepare the release notes.
8. Run the fastlane `publish_mas` lane.

The `npm run build:mas` build is **not** a workflow step. It runs inside the fastlane lane, which
calls `npm run build:mas` from the repository root unless `SKIP_MAS_BUILD` is set, and then picks
the most recently modified `.pkg` from `release/`.

`deliver` is invoked with the App Store Connect API key, a 20-minute key duration, the app
identifier and version from `package.json`, and the release notes keyed by
`MAS_RELEASE_LOCALE`. Screenshots are skipped, the precheck is not run before submission, and the
export compliance answers declare that FloCafe does not use encryption and does not contain
third-party content.

## Store review is external

Signing, Transporter submission, and Apple App Review all happen outside this repository. The
release evidence summary records `masReview` as `NOT-RUN` for every release for that reason, and a
`NOT-RUN` row is not a pass. Do not describe a release as App Store reviewed because the workflow
succeeded.

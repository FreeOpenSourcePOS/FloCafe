# Mac App Store publishing

The `Publish Mac App Store` GitHub Actions workflow replaces the manual
Transporter and App Store Connect handoff for the MAS build.

Run it from **Actions > Publish Mac App Store > Run workflow** on the exact
release tag you want to publish, and set `release_tag` to that same tag. The
workflow rejects branch refs, mismatched tags, unsigned or unverified tags and
commits, tags outside `main` history, and package-version mismatches. Leave
`release_notes` blank to use the matching `CHANGELOG.md` entry for the current
`package.json` version, or paste custom "What's New" text into the workflow
input.

## Required runner

The job runs on a self-hosted macOS runner:

```yaml
runs-on: [self-hosted, macOS]
```

If the Mac mini uses a more specific label, add that label to
`.github/workflows/publish-mas.yml`.

## Required GitHub secrets

- `MAC_CERTS`: base64-encoded Apple distribution certificate archive used by
  electron-builder.
- `MAC_CERTS_PASSWORD`: password for `MAC_CERTS`.
- `APPLE_API_KEY`: base64-encoded App Store Connect API `.p8` key.
- `APPLE_API_KEY_ID`: App Store Connect API key ID.
- `APPLE_API_ISSUER`: App Store Connect issuer ID.

The existing macOS release workflow already uses the same Apple API secret
format.

## Optional GitHub variables

- `APPLE_TEAM_ID`: Apple Developer team ID. Defaults to `BKDY677XJA`.
- `MAS_APP_IDENTIFIER`: Mac App Store bundle identifier. Defaults to
  `com.flo.desktop`.
- `MAS_RELEASE_LOCALE`: App Store Connect locale for release notes. Defaults to
  `en-US`.

## What the workflow does

1. Checks release provenance using the current `main` verifier code.
2. Checks out the selected release tag for the build.
3. Installs Node and Ruby dependencies.
4. Generates App Store release notes.
5. Runs `npm run build:mas`.
6. Uploads the newest `release/*.pkg` through Fastlane/Transporter.
7. Sets "What's New" in App Store Connect.
8. Submits the version for App Review when `submit_for_review` is enabled.
9. Sets the version to release automatically after approval when
   `automatic_release` is enabled.

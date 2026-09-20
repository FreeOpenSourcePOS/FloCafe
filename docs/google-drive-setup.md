# Google Drive backup integration — maintainer setup

FloCafe can optionally upload database backups to a store owner's own Google
Drive on a schedule (see #129). This is **off by default** and requires two
things before it works in a given build:

1. A Google Cloud OAuth client (this doc — one-time, done by a maintainer).
2. The store owner explicitly acknowledging the warning and clicking
   **Connect** in `Settings > Backup & Data > Google Drive` (per-install, done
   by the owner).

If the OAuth client isn't configured, the Backup & Data UI shows *"Google Drive
integration is not configured for this build"* and the Connect button is
disabled - the app never attempts to reach Google's APIs.

Drive backups are full SQLite database copies and are not encrypted by FloCafe
yet. They can contain customer, staff-authentication, and store-settings data.
Anyone with access to the selected Google Drive account or folder may access the
copy; the FloCafe Master PIN is not a portable encryption key. Automatic
backups run only while the Electron app is running, with one startup catch-up
attempt when due. Drive retention moves only FloCafe-owned automatic files to
Trash; manual files are kept indefinitely, and Drive retention never deletes
local backup history.

This doc covers step 1: creating the OAuth client credentials in Google
Cloud Console and wiring them into a FloCafe build.

## Why this can't be pre-provisioned

Google OAuth clients are tied to a Google Cloud project owned by a human
Google account, and creating one requires clicking through the Cloud
Console UI (and, for a public app, an OAuth consent screen review) — there's
no way to script this or ship a working client ID/secret in the open-source
repo itself. Supported packaged releases must ship a public Desktop client
configuration for their distribution channel; self-hosted builds may supply
their own client through environment variables. An installed-app client secret
is not confidential and is never stored in SQLite.

## 1. Create (or select) a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com/).
2. Create a new project (or pick an existing one) — e.g. "FloCafe POS".

## 2. Enable the Google Drive API

1. In the left sidebar, go to **APIs & Services > Library**.
2. Search for **Google Drive API** and click **Enable**.

## 3. Configure the OAuth consent screen

1. Go to **APIs & Services > OAuth consent screen**.
2. Choose **External** (unless every store using this build is a Google
   Workspace user in your own organization, in which case **Internal** is
   fine and skips verification).
3. Fill in the app name (e.g. "FloCafe"), support email, and developer
   contact email.
4. Under **Scopes**, add:
   - `https://www.googleapis.com/auth/drive.file`

   Do **not** add the broader `drive` or `drive.readonly` scopes — FloCafe
   only ever needs to see the backup files it creates itself.
5. Add any test users you want to be able to connect while the app is in
   "Testing" publishing status (Google caps this at 100 users and access
   tokens expire after 7 days until the app is verified/published).
6. Save. If you intend to distribute this build outside your own
   organization, you'll eventually want to submit the app for Google's
   verification review to remove the "unverified app" warning and the
   7-day token expiry — not required for internal/self-hosted use.

## 4. Create the OAuth client ID

1. Go to **APIs & Services > Credentials**.
2. Click **Create Credentials > OAuth client ID**.
3. Application type: **Desktop app** (this matches the loopback flow
   FloCafe uses — it opens the consent screen in the system browser and
   catches the redirect on a local `127.0.0.1` server on a random port, per
   Google's recommended flow for installed apps; no fixed redirect URI needs
   to be registered for this client type).
4. Name it (e.g. "FloCafe Desktop").
5. Click **Create**. Copy the generated **Client ID** and **Client secret** —
   you won't be able to see the secret again after leaving this screen
   (you can always generate a new one from the Credentials page if you lose
   it).

## 5. Wire the credentials into a FloCafe build

Set two environment variables wherever this build is built/run:

```bash
GOOGLE_DRIVE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_DRIVE_CLIENT_SECRET=xxxxxxxx
```

For local development, copy `.env.example` to `.env` and fill these in.
For packaged builds (electron-builder), set them in the environment the
build runs in (CI secrets, `.env` picked up by your build pipeline, etc.) —
FloCafe reads them from `process.env` at runtime, the same pattern already
used for `JWT_SECRET`.

Once both variables are set and the app is restarted, `Settings > Backup &
Data > Google Drive` shows a **Connect** button instead of the
"not configured" message. Clicking it starts the OAuth flow and initial
setup. After connection, FloCafe may contact Google for startup or scheduled
backups and for owner-requested remote history or restore operations - see the
main README/issue #129 for the opt-in and security details (scope, token
storage, revoke-on-disconnect, retention).

## Notes for reviewers / auditors

- Scope is `drive.file` plus the OpenID identity scopes needed to bind one
  stable Google account subject per installation. FloCafe can only see/manage
  files it created through the API, not the user's whole Drive.
- OAuth tokens are encrypted at rest via Electron's `safeStorage`
  (`main/services/google-drive.ts`), the same mechanism used for the Master
  PIN, and are stored in their own file — never in the SQLite database.
- Disconnecting revokes the token with Google's `/revoke` endpoint, not just
  the local UI state.
- Uploaded backups are the exact same artifact `createBackup()` already
  produces for local backups and the Backup History list (#120) — there is
  no separate export path for Drive uploads.
- Pre-existing Drive files without FloCafe app properties are preserved. They
  are excluded from automatic retention and in-app restore, and FloCafe does
  not infer whether an unmarked file was automatic or manual.

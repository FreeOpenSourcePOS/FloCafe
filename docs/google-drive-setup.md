# Google Drive backup integration: maintainer setup

FloCafe can optionally upload database backups to a store owner's own Google Drive on a schedule.
This is off by default and needs two things before it works in a given build:

1. A Google Cloud OAuth client. This page covers that, and it is a one-time task for a maintainer.
2. The store owner explicitly acknowledging the warning and clicking **Connect** in
   **Settings > Backup & Data > Google Drive**, which is per-install and done by the owner.

If the OAuth client is not configured, the Backup & Data UI reports that the integration is not
configured for this build and the Connect button is disabled. The app does not attempt to reach
Google's APIs at all in that state.

Drive backups are full SQLite database copies and FloCafe does not encrypt them. They can contain
customer data, staff authentication data, and store settings. Anyone with access to the selected
Google Drive account or folder can read the copy; the FloCafe Master PIN is not a portable
encryption key. Automatic backups run only while the Electron app is running, with one startup
catch-up attempt when a backup is due. Drive retention moves only FloCafe-owned automatic files to
Trash. Manual files are kept indefinitely, and Drive retention never deletes local backup history.

## Why this cannot be pre-provisioned

A Google OAuth client is tied to a Google Cloud project owned by a human Google account, and creating
one means clicking through the Cloud Console UI. For a public app, an OAuth consent screen review is
also required. There is no way to script this, and a working client ID and secret cannot be shipped
in an open-source repository.

Supported packaged releases must ship a public Desktop client configuration for their distribution
channel. Self-hosted builds may supply their own client through environment variables. An
installed-app client secret is not confidential, and it is never stored in SQLite.

## 1. Create or select a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com/).
2. Create a new project, or pick an existing one.

## 2. Enable the Google Drive API

1. In the left sidebar, open **APIs & Services > Library**.
2. Search for **Google Drive API** and click **Enable**.

## 3. Configure the OAuth consent screen

1. Go to **APIs & Services > OAuth consent screen**.
2. Choose **External**, unless every store using this build is a Google Workspace user in your own
   organization, in which case **Internal** is fine and skips verification.
3. Fill in the app name, a support email, and a developer contact email.
4. Under **Scopes**, add `https://www.googleapis.com/auth/drive.file`.
5. Add any test users who need to connect while the app is in **Testing** publishing status. Google
   caps this at 100 users, and access tokens expire after 7 days until the app is verified or
   published.
6. Save. If you intend to distribute this build outside your own organization, submit the app for
   Google's verification review to remove the unverified-app warning and the 7-day token expiry. This
   is not required for internal or self-hosted use.

## 4. Create the OAuth client ID

1. Go to **APIs & Services > Credentials**.
2. Click **Create Credentials > OAuth client ID**.
3. Choose application type **Desktop app**. This matches the loopback flow FloCafe uses: it opens
   the consent screen in the system browser and catches the redirect on a local server bound to
   `127.0.0.1` on an ephemeral port. No fixed redirect URI needs registering for this client type.
4. Name it.
5. Click **Create** and copy the generated **Client ID** and **Client secret**. You cannot see the
   secret again after leaving that screen, though you can generate a new one from the Credentials
   page.

## 5. Wire the credentials into a FloCafe build

Set two environment variables wherever the build is compiled and run:

```bash
GOOGLE_DRIVE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_DRIVE_CLIENT_SECRET=xxxxxxxx
```

For local development, copy `.env.example` to `.env` and fill these in. For packaged builds, set
them in the build environment, through CI secrets or your build pipeline. FloCafe reads them from
`process.env` at runtime, the same pattern used for `JWT_SECRET`.

Once both variables are set and the app is restarted, **Settings > Backup & Data > Google Drive**
shows a **Connect** button instead of the not-configured message.

## The connection flow

The flow is worth knowing before you change it, because several details are load-bearing.

- **Requested scopes are `drive.file`, `openid`, and `email`.** `drive.file` lets FloCafe see only
  the files it creates itself, never the user's whole Drive. `openid` and `email` are used to bind
  one stable Google account subject per installation. Do **not** add the broader `drive` or
  `drive.readonly` scopes. The constant `DRIVE_FILE_SCOPE` in
  [`main/services/google-drive.ts`](../main/services/google-drive.ts) is the single definition.
- **The flow uses PKCE with the S256 code challenge method.** The authorization URL carries
  `code_challenge` and `code_challenge_method: 'S256'`, and the verifier is presented at token
  exchange. A fresh verifier is generated for every connection attempt.
- **The redirect is a loopback listener on `127.0.0.1` with an ephemeral port**, created per
  attempt and closed as soon as the callback lands or the attempt times out. The callback path is
  `/oauth2callback`.
- **State is 32 random bytes**, base64url-encoded, and the returned state is compared with
  `crypto.timingSafeEqual` before the code is accepted. A missing code, a Google-side error, or a
  state mismatch all fail the attempt the same way.
- **The authorization URL is validated before it is opened.** FloCafe refuses to open a URL that
  does not pass `isSafeGoogleAuthorizationUrl`.
- **The flow requests `access_type: 'offline'` with `prompt: 'consent'`**, so a refresh token is
  issued without relying on a prior grant.

## Token storage and revocation

- **Tokens are encrypted at rest with Electron `safeStorage`**, the same mechanism used for the
  Master PIN, and are written to their own file. They are never written to the SQLite database.
  If `safeStorage` reports encryption unavailable, FloCafe does not store a token.
- **Account identity is read from the OpenID Connect userinfo endpoint** after connection, and the
  stable subject and email are stored so an install stays bound to one account.
- **Disconnecting revokes the token with Google**, by POSTing it to
  `https://oauth2.googleapis.com/revoke`. It does not only clear local UI state. A revocation that
  cannot be confirmed is recorded as an unconfirmed revocation and retried rather than being
  silently treated as done.
- **Uploaded backups are the same artifact local backups produce.** There is no separate Drive
  export path, so a Drive copy and a local copy of the same moment are the same database file.
- **Pre-existing Drive files without FloCafe app properties are preserved.** They are excluded from
  automatic retention and from in-app restore, and FloCafe does not guess whether an unmarked file
  was automatic or manual.

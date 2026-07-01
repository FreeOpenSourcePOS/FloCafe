# FloAdmin License Integration — Instructions for FloCafe POS

## What This Is

FloAdmin (the cloud backend at `soflo.codify.tech`) now issues a **license key** to every
registered store (`FLOC-XXXX-XXXX-XXXX-XXXX`). The POS must:

1. Store the license key entered by the user during setup
2. Generate and persist a unique **installation fingerprint** (a UUID created once on first run)
3. **Activate** the license against the server on first cloud setup
4. **Validate** the license on every app start and before every cloud sync

If someone copies the POS to another machine and tries to use the same license key, the server
returns HTTP 409 and sync is blocked.

---

## What You Need to Implement in FloCafe

### 1. Installation Fingerprint

On **first launch**, generate a UUID and persist it permanently in local storage (never regenerate it):

```js
// Electron / Node.js example — adapt to whatever storage layer FloCafe uses
import { randomUUID } from 'crypto'

function getInstallationFingerprint() {
  let fp = store.get('installationFingerprint')   // e.g. electron-store, localStorage, flo.db
  if (!fp) {
    fp = randomUUID()
    store.set('installationFingerprint', fp)
  }
  return fp
}
```

If FloCafe already has a settings/store module, add the key there. The fingerprint must survive
app updates but can be reset by a full uninstall (which is intentional — reinstall = new activation).

---

### 2. Settings / Onboarding UI

Add two new fields to the Cloud Sync settings screen (wherever `api_key` is currently entered):

| Field | Label | Notes |
|---|---|---|
| `licenseKey` | License Key | `FLOC-XXXX-XXXX-XXXX-XXXX` — entered once by the user |
| `apiKey` | API Key | Already exists — `fac_live_xxx` |

Both values are provided to the user when they register a store at `soflo.codify.tech/register`
(or via the `/api/auth/register` API response).

Store them in the same place the API key is currently stored.

---

### 3. License Activation (call once, on first setup)

After the user saves their license key and API key, call the activate endpoint:

```
POST https://soflo.codify.tech/api/license/activate
X-Api-Key: fac_live_xxx
Content-Type: application/json

{
  "license_key": "FLOC-XXXX-XXXX-XXXX-XXXX",
  "installation_fingerprint": "<uuid from step 1>"
}
```

**Success (200):**
```json
{ "activated": true, "plan": "free", "expires_at": null }
```

**Already on another machine (409):**
```json
{ "error": "License is already activated on another installation. Contact support to transfer it." }
```

**How to trigger:** Call this when the user taps "Save" on the Cloud Sync settings screen AND
a license key is present AND `licenseActivated` flag in local storage is not already `true`.
On success, set `licenseActivated = true` locally.

---

### 4. License Validation (call on every startup + before every sync)

```
GET https://soflo.codify.tech/api/license/validate
    ?license_key=FLOC-XXXX-XXXX-XXXX-XXXX
    &installation_fingerprint=<uuid>
X-Api-Key: fac_live_xxx
```

**Success (200):**
```json
{ "valid": true, "plan": "free", "expires_at": null }
```

**Errors to handle:**

| HTTP | `error` contains | POS action |
|---|---|---|
| 401 | Invalid API key | Show "Cloud sync not configured" |
| 403 | License inactive / expired | Block sync, show message |
| 409 | Different installation | Block sync, show "License in use on another machine" |
| 404 | License not found | Block sync, prompt re-enter license key |

**Where to call this:**
- Once at app startup, before the main window is shown (or immediately after, non-blocking with
  a retry). If validation fails, disable the cloud sync toggle and surface the error.
- Before calling `POST /api/sync/bill` — if the last validation was more than 1 hour ago,
  re-validate first.

---

### 5. Error UI

When validation returns a 409 (license conflict), show a prominent, persistent banner:

> **License conflict** — This license key is already activated on another installation.
> Cloud sync has been paused. Contact support at support@flocafe.in to transfer your license.

Do NOT silently fail or retry — a conflict means someone may be misusing the license.

---

### 6. Local State to Track

Add these keys to wherever FloCafe persists settings (electron-store / SQLite / etc.):

| Key | Type | Purpose |
|---|---|---|
| `installationFingerprint` | string (UUID) | Generated once, never changed |
| `licenseKey` | string | Entered by user: `FLOC-XXXX-XXXX-XXXX-XXXX` |
| `licenseActivated` | boolean | Set to true after successful /activate call |
| `licenseLastValidated` | ISO timestamp | Used to throttle re-validation |
| `licensePlan` | string | `free` / `pro` — from server response |

---

### 7. Implementation Checklist

- [ ] `getInstallationFingerprint()` — generate + persist UUID on first run
- [ ] Add `licenseKey` field to Cloud Sync settings UI
- [ ] Call `POST /api/license/activate` when settings are saved (if not yet activated)
- [ ] Call `GET /api/license/validate` on startup
- [ ] Throttled re-validation before sync (max once per hour)
- [ ] Error states: show banner, disable sync button on 403/409
- [ ] Store `licensePlan` locally for potential future feature gating

---

### Notes

- The **API key** (`fac_live_xxx`) is used for HTTP auth (`X-Api-Key` header) on all POS
  endpoints. The license key is a separate concept — it controls *whether* this installation
  is allowed to sync, not *who* it is.
- The license system is intentionally simple for MVP: one license per store, one machine per
  license, no online transfer. Transfers are manual (support resets `installation_fingerprint`
  in the DB).
- Free plan licenses do not expire (`expires_at` is null). Pro plan licenses will have an
  `expires_at` date — handle the 403 gracefully when they lapse.

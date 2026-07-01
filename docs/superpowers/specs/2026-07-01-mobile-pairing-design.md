# Mobile App Pairing — Design Spec

**Date:** 2026-07-01
**Author:** khaira777
**Status:** Draft — pending lead review

---

## Problem

The Flo desktop POS needs a mobile companion app that lets owners view reports and sales on their phone. The mobile app must connect to the desktop from anywhere (not just same WiFi), without requiring networking expertise from the shop owner.

Current state: Settings page has a stub pairing code (date-based, no backend endpoint for rotation, no actual pairing flow).

## Goals

1. Owner can pair mobile app to desktop in < 30 seconds
2. Works from anywhere (over the internet, not just same WiFi)
3. Free — no external service costs
4. Secure — pairing code verification + JWT auth
5. Cross-platform (Mac, Windows, Linux)

## Non-Goals

- Real-time push notifications (mobile app polls for data)
- Multi-desktop support (one mobile app pairs to one desktop)
- Two-way sync (mobile is read-only for reports/sales)

---

## Architecture

```
Mobile App → Cloudflare Tunnel → localhost:3001 → Express → SQLite
                                        ↑
                                   (pairing code validated)
                                   (JWT auth for ongoing access)
```

Three layers:
1. **Transport:** Cloudflare Tunnel exposes the desktop server to the internet
2. **Authentication:** Pairing code exchange → JWT token
3. **Data:** Mobile-optimized API endpoints on the existing Express server

---

## Cloudflare Tunnel Integration

### Binary Bundling

- Bundle `cloudflared` binary with the Electron app (platform-specific)
- Mac: `cloudflared-darwin-arm64` (~14MB)
- Windows: `cloudflared-windows-amd64.exe` (~12MB)
- Linux: `cloudflared-linux-amd64` (~14MB)
- Location: `resources/cloudflared/` (via electron-builder `extraResources`)

### Lifecycle

```
App start:
  1. Locate cloudflared binary in app resources
  2. Spawn: cloudflared tunnel --url http://localhost:3001
  3. Capture stdout for generated URL (https://xxx.trycloudflare.com)
  4. Store URL in memory + settings table (key: tunnel_url)
  5. Expose via IPC: get-tunnel-status

App quit:
  1. Kill cloudflared child process (SIGTERM)
  2. Clean up temp files

Error handling:
  - If cloudflared not found: log warning, disable mobile pairing
  - If tunnel fails to start: retry 3 times with 5s delay
  - If tunnel drops mid-session: auto-restart, update URL
```

### IPC Handlers

| Channel | Direction | Purpose |
|---|---|---|
| `get-tunnel-status` | Renderer → Main | Returns `{ url, connected, uptime }` |
| `restart-tunnel` | Renderer → Main | Kill and restart cloudflared |

---

## Pairing Flow

### Step 1: Desktop Generates Code

- Owner clicks "Generate New Code" in Settings
- Backend generates random 6-digit numeric code
- Stores bcrypt hash in settings table (key: `mobile_pairing_code_hash`)
- Stores `rotated_at` timestamp
- Displays plaintext code in UI with 10-minute expiry countdown

### Step 2: Mobile App Enters Code

- Mobile app shows: "Enter pairing code from Flo desktop"
- Owner types the 6-digit code
- Mobile app sends: `POST /api/mobile/pair { code: "123456", device_name: "Owner's iPhone" }`

### Step 3: Backend Validates

- Looks up `mobile_pairing_code_hash` from settings
- Compares plain code against bcrypt hash
- If match:
  - Generates JWT (30-day expiry)
  - Creates device record in `mobile_devices` table
  - Returns JWT + device info + business info
- If no match: returns 401 "Invalid pairing code"

### Step 4: Mobile App Stores Token

- Stores JWT in device storage
- Uses JWT for all subsequent API calls
- Caches tunnel URL for reconnection

---

## Security Model

| Layer | Mechanism | Details |
|---|---|---|
| Transport | Cloudflare Tunnel | Encrypted HTTPS, but URL is guessable |
| Pairing | 6-digit code + bcrypt | Code expires in 10 min, max 5 attempts/min |
| Ongoing | JWT token | 30-day expiry, signed with install-specific secret |
| Revocation | Code rotation | Rotating code invalidates all paired devices |

### Threat Mitigations

- **Someone discovers tunnel URL:** Can't do anything without valid pairing code
- **Brute-force pairing code:** Rate limited to 5 attempts/minute, code expires in 10 min
- **Stolen JWT:** Owner can rotate code to invalidate all devices
- **Man-in-the-middle:** Cloudflare Tunnel provides end-to-end HTTPS

---

## Database Schema

### New Table: `mobile_devices`

```sql
CREATE TABLE IF NOT EXISTS mobile_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_name TEXT NOT NULL,
  pairing_code_hash TEXT NOT NULL,
  jwt_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  is_active INTEGER DEFAULT 1
);
```

### Settings Table Additions

| Key | Value | Purpose |
|---|---|---|
| `mobile_pairing_code_hash` | bcrypt hash | Current pairing code |
| `mobile_pairing_rotated_at` | ISO timestamp | When code was last rotated |
| `tunnel_url` | URL string | Current Cloudflare tunnel URL |
| `tunnel_connected` | boolean | Whether tunnel is running |

---

## API Endpoints

### Pairing

| Endpoint | Method | Auth | Request | Response |
|---|---|---|---|---|
| `/api/mobile/pair` | POST | Pairing code | `{ code, device_name }` | `{ access_token, device, business }` |
| `/api/mobile/devices` | GET | JWT | — | `{ devices: [...] }` |
| `/api/mobile/unpair` | POST | JWT | `{ device_id }` | `{ success: true }` |

### Data

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/mobile/dashboard` | GET | JWT | Today's summary, top items, recent orders |
| `/api/mobile/sales` | GET | JWT | Sales data with date range filter |
| `/api/mobile/reports` | GET | JWT | Report data (daily/weekly/monthly) |

### Settings (existing, fixes needed)

| Endpoint | Method | Auth | Change |
|---|---|---|---|
| `/api/mobile/pairing-code` | GET | JWT | Return actual random code, not date |
| `/api/mobile/rotate-code` | POST | JWT | Generate new code, revoke old |

---

## Settings Page UI

### Current State
- Shows date-based "pairing code"
- "Generate new code" button calls nonexistent endpoint (404s)
- No device list, no tunnel info

### New State

```
┌──────────────────────────────────────────────────┐
│  📱 Mobile App                                   │
│                                                  │
│  Connect the Flo mobile app to view reports      │
│  and sales on your phone.                        │
│                                                  │
│  Pairing Code                                    │
│  ┌──────────────────────────┐  [📋 Copy]         │
│  │      • • 4 8 2 7         │                    │
│  └──────────────────────────┘                    │
│  Expires in 8 minutes                            │
│                                                  │
│  [🔄 Generate New Code]                          │
│  ⚠️ Generating a new code will disconnect all    │
│  currently paired devices.                       │
│                                                  │
│  Tunnel: https://abc-xyz.trycloudflare.com       │
│  Status: 🟢 Connected                            │
│                                                  │
│  Paired Devices                                  │
│  ┌──────────────────────────────────────────┐    │
│  │ 📱 Owner's iPhone    Last seen: 2m ago   │    │
│  │                        [Unpair]          │    │
│  │ 📱 Manager Android   Last seen: 1h ago   │    │
│  │                        [Unpair]          │    │
│  └──────────────────────────────────────────┘    │
└──────────────────────────────────────────────────┘
```

### UI Elements

- **Code display:** 6-digit masked (dots), revealed on hover/click
- **Expiry countdown:** Live timer showing minutes remaining
- **Copy button:** Copies plaintext code to clipboard
- **Rotate button:** Generates new code, shows confirmation dialog
- **Tunnel status:** URL + green/red indicator
- **Device list:** Name + last seen + unpair button per device

---

## Implementation Phases

### Phase 1: Backend (no tunnel yet)
1. Add `mobile_devices` table migration
2. Implement `POST /api/mobile/pair` endpoint
3. Implement `GET /api/mobile/devices` and `POST /api/mobile/unpair`
4. Fix `GET /api/mobile/pairing-code` to return random code
5. Implement `POST /api/mobile/rotate-code`
6. Add mobile-specific auth middleware
7. Implement `/api/mobile/dashboard` endpoint

### Phase 2: Settings Page
1. Update pairing code UI (masked display, expiry, copy)
2. Add rotate code functionality
3. Add tunnel status display
4. Add paired devices list with unpair

### Phase 3: Tunnel Integration
1. Bundle cloudflared binary with Electron app
2. Implement tunnel spawn/kill in main process
3. Add IPC handlers for tunnel status
4. Auto-start tunnel on app launch
5. Handle tunnel errors and restarts

### Phase 4: Mobile App
1. Pairing screen (enter code)
2. Dashboard screen
3. Sales screen
4. Reports screen

---

## Verification Checklist

- [ ] `npm run build` passes
- [ ] `npx tsc --noEmit` passes
- [ ] Pairing code generation works (random 6-digit, not date)
- [ ] Pairing code rotation works (old code invalidated)
- [ ] `POST /api/mobile/pair` validates code and returns JWT
- [ ] Mobile API endpoints return correct data
- [ ] Settings page shows tunnel status
- [ ] Settings page shows paired devices
- [ ] Cloudflare tunnel starts on app launch
- [ ] Tunnel URL displayed in settings
- [ ] Mobile app can pair using code
- [ ] Mobile app can access dashboard after pairing
- [ ] Rotating code disconnects all paired devices
- [ ] Works on Mac, Windows, Linux

---

## Open Questions

1. Should the mobile app be a native app (Swift/Kotlin) or a web app (PWA)?
   - Recommendation: PWA — same codebase, no app store needed
2. Should we support multiple paired devices simultaneously?
   - Recommendation: Yes, with a max of 5
3. What data should the mobile dashboard show?
   - Recommendation: Same as web dashboard, mobile-optimized layout

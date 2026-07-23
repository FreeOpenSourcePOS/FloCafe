<h1 align="center">FloCafe</h1>

<p align="center">
  <strong>Free, open-source, offline-first Point of Sale for cafes, restaurants, and food businesses.</strong>
</p>

<p align="center">
  <a href="https://flopos.com"><img src="https://img.shields.io/badge/website-flopos.com-2ea44f" alt="Website"></a>
  <a href="https://github.com/FreeOpenSourcePOS/FloCafe/releases"><img src="https://img.shields.io/github/v/release/FreeOpenSourcePOS/FloCafe" alt="GitHub release"></a>
  <a href="https://github.com/FreeOpenSourcePOS/FloCafe/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" alt="Platform">
  <img src="https://img.shields.io/badge/Node-%3E%3D22.0.0-brightgreen" alt="Node.js">
  <br>
  <a href="https://github.com/FreeOpenSourcePOS/FloCafe/stargazers"><img src="https://img.shields.io/github/stars/FreeOpenSourcePOS/FloCafe?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/FreeOpenSourcePOS/FloCafe/network/members"><img src="https://img.shields.io/github/forks/FreeOpenSourcePOS/FloCafe?style=social" alt="GitHub forks"></a>
  <a href="https://github.com/FreeOpenSourcePOS/FloCafe/issues"><img src="https://img.shields.io/github/issues/FreeOpenSourcePOS/FloCafe" alt="Open issues"></a>
  <a href="https://github.com/FreeOpenSourcePOS/FloCafe/pulls"><img src="https://img.shields.io/github/issues-pr/FreeOpenSourcePOS/FloCafe" alt="Open pull requests"></a>
  <a href="https://www.reddit.com/r/FloPOS/"><img src="https://img.shields.io/badge/Reddit-r%2FFloPOS-FF4500?logo=reddit&logoColor=white" alt="Reddit community"></a>
</p>

---

FloCafe runs entirely on your own machine — no internet, no subscriptions, no cloud dependency. Your data stays local, your business stays private.

**FloCafe is free.** Every feature, in every app across the ecosystem — FloCafe, FloRetail, FloSalon, and RevFlo (our companion mobile reporting app, short for *Revenue Flow*) — has no tiers, no subscriptions, and no paywalled features.

## Table of Contents

- [Why FloCafe](#why-flocafe)
- [Downloads](#downloads)
- [Features](#features)
- [Project Stats](#project-stats)
- [Public Roadmap](#public-roadmap)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Development Setup](#development-setup)
- [Architecture](#architecture)
- [Updates & Database Integrity](#updates--database-integrity)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Why FloCafe

| | |
|---|---|
| **Completely Free** | No subscriptions, no licenses, no hidden costs |
| **Works Offline** | Full functionality without internet |
| **Your Data** | Self-hosted on your own machine |
| **Restaurant Ready** | Table management, KDS, thermal printing |
| **Cafe Ready** | Fast counter billing, takeaway, delivery orders |
| **Cross-Platform** | Windows, macOS, Linux |

## Downloads

<p>
  <a href="https://apps.apple.com/in/app/flo-cafe/id6763136018">
    <img src="https://img.shields.io/badge/Mac_App_Store-Download-black?logo=apple&style=for-the-badge" alt="Download on the Mac App Store">
  </a>
  &nbsp;
  <a href="https://apps.microsoft.com/detail/9n1md6585p4q">
    <img src="https://img.shields.io/badge/Microsoft_Store-Download-0078D4?logo=microsoft&style=for-the-badge" alt="Download on Microsoft Store">
  </a>
</p>

Or grab the latest build directly from [Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases) — always the top-most release, filenames are versioned (e.g. `Flo.Cafe-<version>.dmg`):

| Platform | Asset | Description |
|----------|------|-------------|
| **macOS** | [Mac App Store](https://apps.apple.com/in/app/flo-cafe/id6763136018) | Recommended — auto-updates |
| **macOS (Intel DMG)** | `Flo.Cafe-<version>.dmg` | Direct download for Intel Macs |
| **macOS (Apple Silicon DMG)** | `Flo.Cafe-<version>-arm64.dmg` | Direct download for M1/M2/M3/M4 |
| **Windows** | [Microsoft Store](https://apps.microsoft.com/detail/9n1md6585p4q) | Recommended — auto-updates |
| **Windows (EXE)** | `Flo.Cafe.Setup.<version>.exe` | Direct download installer |
| **Linux (AppImage)** | `Flo.Cafe-<version>.AppImage` | Portable Linux binary, built on `ubuntu-22.04` for glibc compatibility with Ubuntu 22.04+ and similarly recent distros |
| **Linux (Debian)** | `flo-desktop_<version>_amd64.deb` | Debian/Ubuntu package, same `ubuntu-22.04` build target |

**Uninstalling:** standalone uninstaller scripts for macOS and Windows are attached to every [release](https://github.com/FreeOpenSourcePOS/FloCafe/releases) — useful if the packaged uninstaller is missing or a reinstall needs a clean slate. They remove the app and its support files but leave your database/backups/Master PIN alone unless you pass `--purge-data` / `-PurgeData`.

```sh
# macOS
curl -fsSL https://github.com/FreeOpenSourcePOS/FloCafe/releases/latest/download/uninstall-macos.sh -o uninstall-macos.sh && chmod +x uninstall-macos.sh && ./uninstall-macos.sh
```
```powershell
# Windows (PowerShell)
irm https://github.com/FreeOpenSourcePOS/FloCafe/releases/latest/download/uninstall-windows.ps1 -OutFile uninstall-windows.ps1; powershell -ExecutionPolicy Bypass -File .\uninstall-windows.ps1
```

## 🚀 Features

### Core POS
- Fast order entry with product search
- Multiple order types: Dine-in, Takeaway, Delivery
- Cart with modifiers and addons
- Multiple payment methods (Cash, UPI, Card)
- GST-compliant invoice generation

### Restaurant & Cafe
- Kitchen Display System (KDS) with real-time updates
- Kitchen Order Tickets (KOT) printing
- Table management with status tracking
- Multi-station kitchen support
- Addon groups for modifiers (extras, toppings, variants)

### Thermal Printing
- ESC/POS protocol (USB, Network, Bluetooth)
- Auto-detect printers (Epson, Xprinter, Star, etc.)
- Multiple bill templates (Classic, Compact, Detailed)
- Configurable paper widths (58mm/80mm)

### Business Management
- Menu catalog with categories
- Staff management with roles
- Customer database
- Dashboard insights and owner-restricted analytics
- Sales reports
- Local database backups with history/restore, plus optional automated
  off-device backups to Google Drive (opt-in — see
  [`docs/google-drive-setup.md`](docs/google-drive-setup.md))

### Localization (i18n)
- Native multi-language support (English and Spanish included)
- Easily extensible translation system for adding new locales
- Fully localized user interfaces, printed receipts, and POS interactions

### Order Management
- Bill-style order cards for intuitive layout and fast management
- Cancel orders with status-based rules (pending = free, preparing+ = manager PIN)
- Loyalty points toggle per order (configurable earn/redeem rates)
- Discount system (order + item level, percentage + amount)
- Extra notes per item and order (configurable character limits)
- Receipt reprinting with print logging
- Add-on items after order placement
- Filter bar with search, table, type, and status filters
- Cross-device held orders synchronization

### Kitchen Display System (KDS)
- Real-time order updates via WebSocket
- Dynamic IP detection for easy pairing via VPN/Mesh networks (Tailscale, ZeroTier, etc.)
- "NEW" badge for items added after initial order
- Table name always visible

## Project Stats

FloCafe's public GitHub activity is visible through live badges and GitHub Insights:

| Signal | Live status |
|--------|-------------|
| Latest release | [![Latest release](https://img.shields.io/github/v/release/FreeOpenSourcePOS/FloCafe?label=release)](https://github.com/FreeOpenSourcePOS/FloCafe/releases/latest) |
| Total release downloads | [![Downloads](https://img.shields.io/github/downloads/FreeOpenSourcePOS/FloCafe/total?label=release%20downloads)](https://github.com/FreeOpenSourcePOS/FloCafe/releases) |
| Stars | [![Stars](https://img.shields.io/github/stars/FreeOpenSourcePOS/FloCafe?label=stars)](https://github.com/FreeOpenSourcePOS/FloCafe/stargazers) |
| Forks | [![Forks](https://img.shields.io/github/forks/FreeOpenSourcePOS/FloCafe?label=forks)](https://github.com/FreeOpenSourcePOS/FloCafe/network/members) |
| Open issues | [![Open issues](https://img.shields.io/github/issues/FreeOpenSourcePOS/FloCafe?label=open%20issues)](https://github.com/FreeOpenSourcePOS/FloCafe/issues) |
| Open pull requests | [![Open PRs](https://img.shields.io/github/issues-pr/FreeOpenSourcePOS/FloCafe?label=open%20PRs)](https://github.com/FreeOpenSourcePOS/FloCafe/pulls) |
| Commit activity | [![Commit activity](https://img.shields.io/github/commit-activity/m/FreeOpenSourcePOS/FloCafe?label=commits%2Fmonth)](https://github.com/FreeOpenSourcePOS/FloCafe/pulse) |
| Last commit | [![Last commit](https://img.shields.io/github/last-commit/FreeOpenSourcePOS/FloCafe)](https://github.com/FreeOpenSourcePOS/FloCafe/commits/main) |

For deeper repository analytics, see [Pulse](https://github.com/FreeOpenSourcePOS/FloCafe/pulse), [Contributors](https://github.com/FreeOpenSourcePOS/FloCafe/graphs/contributors), [Traffic](https://github.com/FreeOpenSourcePOS/FloCafe/graphs/traffic), and [Community Standards](https://github.com/FreeOpenSourcePOS/FloCafe/community). GitHub traffic, clones, and referrers require repository access, so they are linked instead of embedded.

## 🗺️ Public Roadmap

FloCafe is actively evolving. This roadmap reflects the current public issue discussions as of July 21, 2026.

### Active Priorities

- **KDS and KOT workflow controls:** Add a settings toggle so operators can choose KDS-first or printer/KOT-first kitchen workflows ([#133](https://github.com/FreeOpenSourcePOS/FloCafe/issues/133)).
- **Backup, recovery, and restore confidence:** Add automated Google Drive database backups ([#129](https://github.com/FreeOpenSourcePOS/FloCafe/issues/129)), backup history management ([#120](https://github.com/FreeOpenSourcePOS/FloCafe/issues/120)), clearer signup recovery guidance ([#128](https://github.com/FreeOpenSourcePOS/FloCafe/issues/128)), and a secure password recovery/database reinitialization flow ([#127](https://github.com/FreeOpenSourcePOS/FloCafe/issues/127)).
- **Menu and add-on experience:** Improve add-on configuration UX and support multi-quantity add-ons ([#83](https://github.com/FreeOpenSourcePOS/FloCafe/issues/83)).
- **Loyalty program polish:** Refine loyalty onboarding and labels so staff understand earn/redeem behavior faster ([#81](https://github.com/FreeOpenSourcePOS/FloCafe/issues/81)).
- **Desktop update experience:** Add in-app auto-update support with a notification badge ([#58](https://github.com/FreeOpenSourcePOS/FloCafe/issues/58)).

### Longer-Term Direction

- **Android/iOS tablet client + free e-billing:** A thin-client order-taking + billing surface for tablets on the same local network as the desktop install — same pattern KDS already uses (LAN, no install required), not an Electron port (not possible on mobile). No printer access on the tablet itself; printing routes through the existing desktop install. Bundled: how bills reach customers for free (the already-shipped `wa.me` share link today, richer automated WhatsApp messaging as a possible future step) ([#135](https://github.com/FreeOpenSourcePOS/FloCafe/issues/135)).
- **Barcode scanning:** Scan a product's barcode at POS to look it up and add it to the cart, for packaged goods (bottled drinks, snacks) sold alongside prepared food. Built here first as a reusable pattern for two upcoming products in the same ecosystem that need it as a core capability — FloRetail and FloSalon (salons/spas also sell retail inventory) ([#137](https://github.com/FreeOpenSourcePOS/FloCafe/issues/137)).
- **Modular Plugin Architecture:** Support for custom plugins, third-party integrations, and UI themes without modifying core code.
- **Advanced Inventory Management:** Low stock alerts, supplier purchase orders, and ingredient-level tracking.
- **Enhanced Cloud Sync:** Opt-in multi-device synchronization across different branches or franchises.
- **Expanded Translations (i18n):** Add more community-contributed languages to the native English and Spanish support.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Electron 31 |
| Backend | Express.js + TypeScript |
| Frontend | Next.js 16 + React 19 |
| Database | SQLite (better-sqlite3, WAL mode) |
| State | Zustand |
| Styling | Tailwind CSS v4 + shadcn/ui |
| Realtime | WebSocket (KDS) |
| Printing | ESC/POS (node-thermal-printer) |

## Prerequisites

- **Node.js** >= 22.0.0
- **npm** (comes with Node)
- **Git** (for cloning)

Optional:
- Thermal printer (ESC/POS compatible)

### System Requirements

| Requirement | Minimum |
|-------------|---------|
| OS | Windows 10+, macOS 11+, Ubuntu 20.04+ |
| RAM | 4 GB |
| Disk | 500 MB free |
| Node.js | >= 22.0.0 (development only) |

> **Note:** OS and RAM requirements are based on Electron 31 defaults. The app itself is lightweight.

## Quick Start

### 1. Download & Install

Download the installer for your platform from [Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases) or the app stores above.

### 2. First Launch

On first run, the app initializes the SQLite database and asks you to create the first owner account.

### 3. Login

Use the owner email and password created during first launch.

### 4. Configure Printer (Optional)

1. Go to **Settings** → **Printers**
2. Click **Detect Printers**
3. Select your thermal printer
4. Test the connection

## Development Setup

```bash
# Clone the repo
git clone https://github.com/FreeOpenSourcePOS/FloCafe.git
cd FloCafe

# Install dependencies
npm install

# Start development
npm run dev
```

### Available Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Full app (Electron + backend + frontend) |
| `node dev-server.js` | Backend-only (mocks Electron, faster iteration) |
| `npm run build` | Compile TypeScript (main/ → dist/) |
| `npm run build:frontend` | Static export via Next.js |
| `npm run build:mac` | macOS DMG |
| `npm run build:win` | Windows NSIS installer |
| `npm run build:linux` | Linux AppImage + deb |
| `npm test` | Run all tests |
| `npm run test:upgrade-path` | Migrate a real old-release DB fixture through today's schema — see [Database migrations](specs/DatabaseMigrations.md) |
| `npm run clean` | Kill dev servers on ports 3001/3002 |

> **Adding a column to the database?** If it goes into `createSchema()` in `main/db.ts`, it only reaches *new* installs automatically — existing installs need a paired, guarded migration in `MIGRATIONS`, or they'll crash on upgrade the first time something touches that column. This bit us for real (`customers.country_code`/`tag_counts`, fixed in `9c92409`). See [specs/DatabaseMigrations.md](specs/DatabaseMigrations.md) for the rule and the regression test (`npm run test:upgrade-path`) that guards against it.

### Environment Variables

Create a `.env` file in the project root for custom configuration:

```env
# Server
PORT=3001                    # API server port (default: 3001)
KDS_PORT=3002                # KDS server port (default: 3002)

# Authentication
JWT_SECRET=your-secret-key   # JWT signing secret (default: built-in dev secret)
ADMIN_PASSWORD=admin123      # Initial admin password (standalone server.js only)

# Google Drive backups (optional — off unless both are set, see docs/google-drive-setup.md)
GOOGLE_DRIVE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_DRIVE_CLIENT_SECRET=your-client-secret
```

> **Security:** Never commit `.env` files. The default JWT secret is for development only — change it in production.

> **Google Drive backups:** `GOOGLE_DRIVE_CLIENT_ID`/`GOOGLE_DRIVE_CLIENT_SECRET` are only needed if you want the optional
> "back up to Google Drive" feature to be usable in your build. Without them, `Settings > Integrations > Google Drive`
> simply shows "Google Drive integration is not configured for this build" — everything else works normally. See
> [`docs/google-drive-setup.md`](docs/google-drive-setup.md) for how to create these credentials in Google Cloud Console.

## Architecture

```
┌─────────────────────────────────────────┐
│ Electron Main Process                    │
│  main/index.ts → orchestrator            │
│  main/server.ts → Express :3001 (API)    │
│  main/kds-server.ts → Express :3002 (KDS)│
│  main/db.ts → SQLite (WAL mode)          │
└──────────────┬──────────────────────────┘
               │ HTTP + WebSocket
┌──────────────▼──────────────────────────┐
│ Renderer (Next.js static export)         │
│  frontend/src/app/ → pages               │
│  frontend/src/store/ → Zustand           │
└─────────────────────────────────────────┘
```

### Project Structure

```
FloCafe/
├── main/                    # Electron main process (TypeScript)
│   ├── index.ts            # Entry point, orchestrates everything
│   ├── server.ts           # Express API server (:3001)
│   ├── kds-server.ts       # KDS server (:3002)
│   ├── db.ts               # SQLite database & migrations
│   ├── ipc.ts              # Electron IPC handlers
│   ├── preload.ts          # Context bridge
│   ├── routes/             # 20 API route modules
│   ├── services/           # Business logic (cloud-sync, KDS, tax)
│   └── printers/           # ESC/POS thermal printing
├── frontend/               # Next.js frontend
│   └── src/
│       ├── app/            # App Router pages
│       ├── components/     # React components
│       ├── store/          # Zustand stores
│       ├── lib/            # Utilities & printer encoders
│       └── hooks/          # Custom React hooks
├── tests/                  # Integration tests
├── dev-server.js           # Headless backend for dev
└── server.js               # Standalone Express server
```

## Updates & Database Integrity

FloCafe auto-updates in the background on macOS and Windows (checks a few seconds after
launch, downloads silently, applies on quit). This relies on `electron-updater` fetching
a manifest (`latest-mac.yml` / `latest.yml`) from the latest GitHub release — every
release build verifies these files exist before publishing (see
`.github/workflows/release.yml` and `tests/release-config.test.ts`), so a release can't
silently ship without a working update path again.

**Your data is never touched by an update.** The SQLite database, local backups, and
Master PIN all live in the OS user-data directory (`app.getPath('userData')`) — a
completely separate location from the application binary that gets replaced. This holds
regardless of *how* you update: automatic background update, manually re-downloading and
reinstalling from [GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases),
or (once available) via the Mac App Store / Microsoft Store.

**Schema migrations run automatically and safely on every startup:**
- Pending migrations apply in order, wrapped in a transaction each, tracked via SQLite's
  `user_version` pragma.
- Before running *any* pending migration batch, the app takes a full timestamped backup
  to the local `backups/` folder — not just for specific migrations, but for the whole
  batch, so an install that's been offline or stuck for a long time and jumps through many
  migrations at once is just as protected as one applying a single routine update.
- If a database's schema is *newer* than the running app version understands (e.g. a
  stale install sharing a database with an already-updated device), the app refuses to
  start and shows a clear message asking you to update, instead of silently running
  queries against columns that no longer exist.
- Startup failures — including that schema-mismatch case — are reported through the
  existing anonymous telemetry pipe (on by default, opt-out anytime in Settings →
  Integrations → Privacy) with the relevant version numbers attached, so installs stuck on
  a stale build can be caught proactively.
- A built-in health check (Settings → Database Tools) diffs your live schema against what
  the current app version expects and can safely apply additive fixes.

**Mac App Store / Microsoft Store note:** those channels are sandboxed and manage their
own updates entirely outside `electron-updater` — Apple and Microsoft's store policies
prohibit in-app auto-update mechanisms. Updates *within* a store channel are safe by
construction. Switching *between* channels (e.g. a direct-download install to a future
store install) does not carry data over automatically, since sandboxed apps use an
OS-isolated storage location — use Settings → Database Tools → Backup/Restore to move
data across a channel switch.

## Troubleshooting

### Printer not detected

- Ensure the printer is powered on and connected (USB or network)
- For USB: try a different port or cable
- For network printers: confirm they're on the same subnet
- On macOS, check **System Preferences → Printers & Scanners**
- On Windows, check **Device Manager** for USB printer entries
- On Linux, ensure your user is in the `lp` group: `sudo usermod -aG lp $USER`

### App crashes on startup

- The SQLite database may be corrupted. Check logs in:
  - macOS: `~/Library/Logs/Flo Cafe/`
  - Windows: `%APPDATA%/Flo Cafe/logs/`
  - Linux: `~/.config/Flo Cafe/logs/`
- Delete the database file to reset (data will be lost)
- Run `npm run clean` to kill any stuck processes on ports 3001/3002

### Printing issues

- Verify the printer supports **ESC/POS** protocol
- Test with **Settings → Printers → Test Print**
- For network printers: check the IP address and port in printer settings
- Ensure paper is loaded and the thermal head is clean
- Check printer status via the **Printer Status** indicator in the POS topbar

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for:

- Development setup and available commands
- Branch naming and commit conventions
- PR process and checklist
- Database migration guidelines
- Code style and testing expectations

Discussion, questions, and feedback also happen over on [r/FloPOS](https://www.reddit.com/r/FloPOS/).

## License

This project is open source under the [MIT License](LICENSE).

---

<p align="center">
  <strong>Bringing professional POS software to every cafe and restaurant.</strong><br>
  <sub>⭐ Star us on GitHub if you find this useful!</sub>
</p>

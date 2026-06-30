<p align="center">
  <img src="logo/logo-white.png" alt="FloCafe" width="200">
</p>

<h1 align="center">FloCafe</h1>

<p align="center">
  <strong>Free, open-source, offline-first Point of Sale for cafes, restaurants, and food businesses.</strong>
</p>

<p align="center">
  <a href="https://github.com/FreeOpenSourcePOS/FloCafe/releases"><img src="https://img.shields.io/github/v/release/FreeOpenSourcePOS/FloCafe" alt="GitHub release"></a>
  <a href="https://github.com/FreeOpenSourcePOS/FloCafe/blob/main/license_instructions.md"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" alt="Platform">
  <img src="https://img.shields.io/badge/Node-%3E%3D22.0.0-brightgreen" alt="Node.js">
</p>

---

FloCafe runs entirely on your own machine — no internet, no subscriptions, no cloud dependency. Your data stays local, your business stays private.

## Table of Contents

- [Why FloCafe](#why-flocafe)
- [Downloads](#downloads)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Development Setup](#development-setup)
- [Architecture](#architecture)
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

Or download directly from [Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases):

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `Flo-1.7.1-arm64.dmg` |
| macOS (Intel) | `Flo-1.7.1.dmg` |
| Windows | `Flo Setup 1.7.1.exe` |
| Linux (AppImage) | `Flo-1.7.1.AppImage` |
| Linux (Debian) | `flo-desktop_1.7.1_amd64.deb` |

## Features

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
- Sales reports

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

On first run, the app initializes the SQLite database. Optionally load demo data.

### 3. Login

| Role | Email | Password |
|------|-------|----------|
| Admin/Owner | `admin@flo.local` | `admin123` |
| Kitchen (KDS) | `chef@flo.local` | `chef123` |

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

# Install dependencies (also inits frontend submodule)
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
| `npm run clean` | Kill dev servers on ports 3001/3002 |

### Environment Variables

Create a `.env` file in the project root for custom configuration:

```env
# Server
PORT=3001                    # API server port (default: 3001)
KDS_PORT=3002                # KDS server port (default: 3002)

# Authentication
JWT_SECRET=your-secret-key   # JWT signing secret (default: built-in dev secret)
ADMIN_PASSWORD=admin123      # Initial admin password (standalone server.js only)
```

> **Security:** Never commit `.env` files. The default JWT secret is for development only — change it in production.

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
├── frontend/               # Next.js frontend (git submodule)
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

### Default Credentials

| Role | Email | Password |
|------|-------|----------|
| Admin | `admin@flo.local` | `admin123` |
| Kitchen | `chef@flo.local` | `chef123` |

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

Contributions are welcome!

1. **Fork** the repository
2. **Clone** your fork: `git clone https://github.com/YOUR_NAME/FloCafe.git`
3. **Create** a branch: `git checkout -b feature/amazing-feature`
4. **Commit** your changes: `git commit -m 'Add amazing feature'`
5. **Push** to the branch: `git push origin feature/amazing-feature`
6. **Open** a Pull Request

See [AGENTS.md](AGENTS.md) for development guidelines and architecture details.

## License

This project is open source under the [MIT License](license_instructions.md).

---

<p align="center">
  <strong>Bringing professional POS software to every cafe and restaurant.</strong><br>
  <sub>⭐ Star us on GitHub if you find this useful!</sub>
</p>

<div align="center">
  <h1>FloCafe</h1>
  <p><strong>Free, open-source, offline-first point of sale for cafés, restaurants, and small kitchens.</strong></p>
  <p>
    <a href="https://flopos.com">Website</a> ·
    <a href="https://github.com/FreeOpenSourcePOS/FloCafe/releases">Download</a> ·
    <a href="https://github.com/FreeOpenSourcePOS/FloCafe/issues">Report a bug</a> ·
    <a href="https://www.reddit.com/r/FloPOS/">Community</a>
  </p>
  <p>
    <a href="https://github.com/FreeOpenSourcePOS/FloCafe/releases"><img src="https://img.shields.io/github/v/release/FreeOpenSourcePOS/FloCafe?label=latest%20release" alt="Latest release"></a>
    <a href="https://github.com/FreeOpenSourcePOS/FloCafe/releases"><img src="https://img.shields.io/github/downloads/FreeOpenSourcePOS/FloCafe/total?label=release%20downloads" alt="Total release downloads"></a>
    <a href="https://github.com/FreeOpenSourcePOS/FloCafe/blob/main/LICENSE"><img src="https://img.shields.io/github/license/FreeOpenSourcePOS/FloCafe" alt="MIT License"></a>
    <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" alt="Windows, macOS, and Linux">
    <a href="https://github.com/FreeOpenSourcePOS/FloCafe/actions/workflows/ci.yml"><img src="https://github.com/FreeOpenSourcePOS/FloCafe/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
    <br>
    <a href="https://github.com/FreeOpenSourcePOS/FloCafe/stargazers"><img src="https://img.shields.io/github/stars/FreeOpenSourcePOS/FloCafe?style=social" alt="GitHub stars"></a>
    <a href="https://github.com/FreeOpenSourcePOS/FloCafe/network/members"><img src="https://img.shields.io/github/forks/FreeOpenSourcePOS/FloCafe?style=social" alt="GitHub forks"></a>
    <a href="https://github.com/FreeOpenSourcePOS/FloCafe/issues"><img src="https://img.shields.io/github/issues/FreeOpenSourcePOS/FloCafe" alt="Open issues"></a>
    <a href="https://github.com/FreeOpenSourcePOS/FloCafe/pulls"><img src="https://img.shields.io/github/issues-pr/FreeOpenSourcePOS/FloCafe" alt="Open pull requests"></a>
    <a href="https://www.reddit.com/r/FloPOS/"><img src="https://img.shields.io/badge/Reddit-r%2FFloPOS-FF4500?logo=reddit&logoColor=white" alt="Reddit community"></a>
  </p>
</div>

<p align="center">
  <img src="docs/images/flo-cafe-pos.webp" alt="FloCafe POS screen showing product selection and an active dine-in order" width="100%">
</p>

FloCafe runs on the business's own computer. Orders, customers, receipts, and backups stay in a local SQLite database, so the counter keeps working when the internet does not. Google Drive backup, WhatsApp bill delivery, and cloud-connected reporting are optional.

If FloCafe helps your cafe, restaurant, cloud kitchen, bakery, or food truck, please star the repository. GitHub stars help more operators find a free open-source POS instead of assuming every restaurant system must be a paid cloud subscription.

**Best-fit searches:** open-source POS, free restaurant POS, cafe POS, kitchen display system, KDS, self-hosted restaurant POS, offline-first POS, thermal printer POS.

## Get FloCafe

Download the latest installer from [GitHub Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases), or use the app store for macOS and Windows.

<p>
  <a href="https://apps.apple.com/in/app/flo-cafe/id6763136018">
    <img src="https://img.shields.io/badge/Mac_App_Store-Download-black?logo=apple&style=for-the-badge" alt="Download on the Mac App Store">
  </a>
  <a href="https://apps.microsoft.com/detail/9n1md6585p4q">
    <img src="https://img.shields.io/badge/Microsoft_Store-Download-0078D4?logo=microsoft&style=for-the-badge" alt="Download from Microsoft Store">
  </a>
</p>

Releases include Windows installers, macOS DMGs, and Linux AppImage, `.deb`, `.rpm`, and Snap packages. On Linux:

```sh
# AppImage
chmod +x flocafe-*.AppImage
./flocafe-*.AppImage

# Debian or Ubuntu
sudo apt install ./flocafe-*.deb

# Snap
sudo snap install flocafe
```

If the Snap build cannot see a USB receipt printer:

```sh
sudo snap connect flocafe:raw-usb
```

On first launch, create the owner account, then add products, tables, staff, and printers in Settings.

For Linux package choices, updates, FUSE, printing, and tray support, see [Linux installation and support](docs/linux.md).

### System requirements

| Requirement | Minimum |
| --- | --- |
| Operating system | Windows 10+, macOS 12+, or a current supported Linux distribution |
| Memory | 4 GB RAM |
| Storage | 500 MB free space, plus room for local backups |

Node.js is only required to develop FloCafe, not to run a packaged release.

<details>
<summary>Uninstall a direct-download build</summary>

App Store and Microsoft Store installs should be removed through the relevant store or operating system.

```sh
# macOS
curl -fsSL https://github.com/FreeOpenSourcePOS/FloCafe/releases/latest/download/uninstall-macos.sh -o uninstall-macos.sh
chmod +x uninstall-macos.sh
./uninstall-macos.sh
```

```powershell
# Windows PowerShell
irm https://github.com/FreeOpenSourcePOS/FloCafe/releases/latest/download/uninstall-windows.ps1 -OutFile uninstall-windows.ps1
powershell -ExecutionPolicy Bypass -File .\uninstall-windows.ps1
```

Both scripts ask whether to keep application data. Do not choose their data-purge options unless you intend to remove the local database and backups.

</details>

## Why FloCafe

FloCafe combines counter service and table service in one desktop app. A kitchen display can receive live orders while receipt printers and kitchen tickets use the same local setup. There is no hosted account required for the core POS.

It is free software. FloCafe has no tiers or paywalled features, and the code is available under the [MIT License](LICENSE).

## What it handles

- Counter, dine-in, takeaway, and delivery orders
- Tables, held orders, modifiers, add-ons, discounts, and loyalty points
- ESC/POS receipt printing over USB, network, and Bluetooth
- Kitchen display, kitchen stations, and kitchen order tickets
- Product images, barcode lookup, and CSV menu import/export
- Customer records, staff roles, sales reporting, and receipt history
- Configurable tax packs and local overrides
- English, Spanish, and Brazilian Portuguese

Backups and restores are built in. Optional [Google Drive backup](docs/google-drive-setup.md) stores backup copies in the owner’s Drive. WhatsApp bill delivery can be enabled for businesses that use a paired phone.

## Direction

FloCafe will remain local-first and free. Current work focuses on making the desktop POS easier to operate, expanding tax and country support, improving inventory and loyalty workflows, and allowing companion devices to work with the existing local install. Public discussions and planned work live in [GitHub Issues](https://github.com/FreeOpenSourcePOS/FloCafe/issues).

## Data, updates, and recovery

The database and backups live in the operating system's user-data directory, separate from the installed application. Updating or reinstalling through the same distribution channel does not remove them.

Before a pending migration runs, FloCafe creates a timestamped local backup. Migrations are additive and tracked with SQLite's `user_version` pragma. Use Settings → Database Tools → Backup before moving to another computer or switching distribution channels.

If the app cannot start, do not delete the database first. Restore the latest backup from Settings → Database Tools, then [open an issue](https://github.com/FreeOpenSourcePOS/FloCafe/issues) with the app version, operating system, and logs.

## Troubleshooting

### Printers not printing

1. Use Settings → Printers → **Test Print** first. As of 2.6.1 it shows the actual failure reason (offline, out of paper, cover open, a Windows driver error, a network timeout) instead of a generic message — read it, it usually tells you exactly what's wrong.
2. **Network printers:** confirm the printer's IP address hasn't changed (check your router's DHCP lease list or set a static IP/DHCP reservation) and that it's on the same network as the machine running FloCafe.
3. **Windows USB printers, especially with the manufacturer's own driver installed:** FloCafe sends raw ESC/POS bytes directly to the Windows print queue, bypassing the driver, which only works if the queue's *Print Processor* is the default `winprint`/`RAW`. Manufacturer "official" driver packages (Epson APD, Star, etc.) are usually GDI drivers meant to render formatted pages, and can register their own print processor or reject/garble a raw byte stream. Two things to try, in order:
   - Right-click the printer in Windows → **Printer Properties → Advanced tab → Print Processor** → confirm it's `winprint` with datatype `RAW`.
   - If that doesn't help, add/reinstall the printer using Windows' built-in **"Generic / Text Only"** driver, or the manufacturer's dedicated raw/ESC-POS mode if their installer offers one as an alternative to their main GDI driver — then re-select it in FloCafe's printer settings, since renaming or reinstalling changes the exact queue name FloCafe has stored.
4. **macOS/Linux (CUPS) printers:** if the print queue is disabled (commonly after the printer was unplugged), re-enable it from the OS's printer settings and the next print will go through — FloCafe detects and reports a disabled queue rather than silently failing.
5. Still stuck? Open **Help → Open Logs Folder** (added in 2.6.1) and check `main.log` around the time of the failed print for a `[Printer]` line with the specific error, then [open an issue](https://github.com/FreeOpenSourcePOS/FloCafe/issues) with that line, your OS, printer make/model, and whether it's USB or network.

## Development

Development requires Node.js 22 or later.

```sh
git clone https://github.com/FreeOpenSourcePOS/FloCafe.git
cd FloCafe
npm install
npm run dev
```

`npm run dev` builds the frontend and backend, then starts Electron. For backend-only work:

```sh
node dev-server.js
```

```sh
npm run lint             # backend and frontend lint
npm run build            # compile main/ to dist/
npm run build:frontend   # export the Next.js frontend
npm test                 # complete test suite
```

### Architecture

```text
Electron main process
├── Express API and WebSocket server       :3001
├── Standalone kitchen-display server      :3002
└── SQLite database, migrations, and printing
                 ↕ HTTP and WebSocket
Next.js renderer
└── React UI and Zustand client state
```

| Layer | Technology |
| --- | --- |
| Desktop runtime | Electron |
| Backend | Express and TypeScript |
| Frontend | Next.js, React, Tailwind CSS, and shadcn/ui |
| Database | SQLite via better-sqlite3 in WAL mode |
| Realtime | WebSocket |
| Printing | ESC/POS via node-thermal-printer |

```text
main/          Electron process, Express servers, SQLite, printing, and services
frontend/src/  Next.js pages, components, client state, and translations
tests/         Backend, integration, and release checks
docs/          API, release, and integration notes
```

Both servers use the same local SQLite database. The renderer is a statically exported Next.js application using React and Zustand.

## Tax packs

Country tax rules ship as signed, versioned data files, not code. A generic engine, English/Spanish/Portuguese tax labels, and official packs for India and Thailand are bundled with every installer; more countries can be added as pack data without an app release. Owners install and activate packs from Settings → Tax Configuration, with rollback and an audit trail.

Adding tax support for a new country is usually a pack contribution, not a code change. See [Tax packs: developer guide](docs/tax-packs.md) for the pack schema, how to author and test one, and how signing and publishing work.

## Contribute

Start with [open issues](https://github.com/FreeOpenSourcePOS/FloCafe/issues). For substantial work, open an issue first so the change can be discussed before implementation.

Database migrations must be non-destructive. Add a migration for existing installations instead of replacing or dropping schema. Before opening a pull request, run:

```sh
npm run lint
npm run build
npm test
```

Project activity is also available through [Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases), [Issues](https://github.com/FreeOpenSourcePOS/FloCafe/issues), and [Pulse](https://github.com/FreeOpenSourcePOS/FloCafe/pulse).

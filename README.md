# FloCafe - Free Open-Source POS for Cafes & Restaurants

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License">
  <img src="https://img.shields.io/github/stars/FreeOpenSourcePOS/FloCafe" alt="Stars">
  <img src="https://img.shields.io/github/contributors/FreeOpenSourcePOS/FloCafe" alt="Contributors">
</p>

FloCafe is a **free, open-source, offline-first Point of Sale (POS) system** built specifically for cafes, restaurants, cloud kitchens, and food businesses worldwide. Runs entirely on your own computer with no internet required.

## 🌟 Why FloCafe?

- **💰 Completely Free** - No subscriptions, no licenses, no hidden costs
- **📴 Works Offline** - Full functionality without internet connection
- **🔒 Your Data, Your Server** - Self-hosted on your own machine
- **🍽️ Restaurant Ready** - Table management, KDS, thermal printing
- **☕ Cafe Ready** - Fast counter billing, takeaway, delivery orders
- **🖥️ Cross-Platform** - Windows, macOS, Linux

## 📦 Downloads

<p>
  <a href="https://apps.apple.com/in/app/flo-cafe/id6763136018">
    <img src="https://img.shields.io/badge/Mac_App_Store-Download-black?logo=apple&style=for-the-badge" alt="Download on the Mac App Store">
  </a>
  &nbsp;
  <a href="https://apps.microsoft.com/detail/9n1md6585p4q">
    <img src="https://img.shields.io/badge/Microsoft_Store-Download-0078D4?logo=microsoft&style=for-the-badge" alt="Download on Microsoft Store">
  </a>
</p>

Or grab the latest release directly:

| Platform | File | Description |
|----------|------|-------------|
| **macOS** | [Mac App Store](https://apps.apple.com/in/app/flo-cafe/id6763136018) | Recommended — auto-updates |
| **macOS (Intel DMG)** | `Flo-1.7.0.dmg` | Direct download for Intel Macs |
| **macOS (Apple Silicon DMG)** | `Flo-1.7.0-arm64.dmg` | Direct download for M1/M2/M3/M4 |
| **Windows** | [Microsoft Store](https://apps.microsoft.com/detail/9n1md6585p4q) | Recommended — auto-updates |
| **Windows (EXE)** | `Flo Setup 1.7.0.exe` | Direct download installer |
| **Linux (AppImage)** | `Flo-1.7.0.AppImage` | Portable Linux binary |
| **Linux (Debian)** | `flo-desktop_1.7.0_amd64.deb` | Debian/Ubuntu package |

**Latest Version:** v1.7.0

## 🚀 Features

### Core POS
- [x] Fast order entry with product search
- [x] Multiple order types (Dine-in, Takeaway, Delivery)
- [x] Table management with real-time status
- [x] Cart with modifiers and addons
- [x] Billing with multiple payment methods (Cash, UPI, Card)
- [x] GST-compliant invoice generation

### Restaurant & Cafe Features
- [x] Kitchen Display System (KDS)
- [x] Kitchen Order Tickets (KOT) printing
- [x] Table tracking and management
- [x] Multi-station kitchen support
- [x] Real-time order updates
- [x] Counter/quick-service billing for cafes

### Thermal Printing
- [x] ESC/POS thermal receipt printing
- [x] USB printer support
- [x] Network/Bluetooth printer support
- [x] Auto-detect printers (Epson, Xprinter, Star, etc.)
- [x] Multiple bill templates (Classic, Compact, Detailed)
- [x] Configurable character widths (58mm/80mm paper)

### Business Management
- [x] Menu catalog with categories
- [x] Addon groups for modifiers (extras, variants, toppings)
- [x] Staff management with roles
- [x] Customer database
- [x] Low stock alerts

### Integrations
- [x] WhatsApp bill sharing
- [x] Thermal printer support
- [x] Network printing

## 🖥️ Tech Stack

- **Runtime:** Electron 31
- **Backend:** Express.js + TypeScript
- **Frontend:** Next.js 16 (React 19, TypeScript)
- **Database:** SQLite (better-sqlite3)
- **Styling:** Tailwind CSS + shadcn/ui
- **Real-time:** WebSocket for KDS updates

## 💾 Requirements

### Minimum System Requirements
- **OS:** Windows 10+, macOS 11+, Ubuntu 20.04+
- **RAM:** 4GB
- **Disk:** 500MB
- **Node.js:** 20+ (for development only)

### Hardware (Optional)
- **Thermal Printer:** ESC/POS compatible (Epson TM series, Xprinter, Star, etc.)
- **USB:** For USB-connected printers

## 🚀 Quick Start

### 1. Download & Install

Download the appropriate installer from the [Releases](https://github.com/FreeOpenSourcePOS/FloCafe/releases) page.

### 2. First Launch

On first run, the app will:
1. Initialize the SQLite database
2. Load demo data (optional)

### 3. Login

Default credentials:

| Role | Email | Password |
|------|-------|----------|
| **Admin/Owner** | `admin@flo.local` | `admin123` |
| **Kitchen (KDS)** | `chef@flo.local` | `chef123` |

### 4. Configure Printer

1. Go to **Settings** → **Printers**
2. Click **Detect Printers**
3. Select your thermal printer
4. Test the connection

## 🔧 Development Setup

```bash
# Clone the repository
git clone https://github.com/FreeOpenSourcePOS/FloCafe.git
cd FloCafe

# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build:mac            # macOS
npm run build:win            # Windows
npm run build:linux          # Linux
npm run build:all-platforms  # All platforms
```

### Environment Variables

Create a `.env` file for production:

```env
JWT_SECRET=your-secure-secret-key-here
PORT=3088
```

## 📱 Screenshots

*(Coming soon)*

## 🏗️ Architecture

```
FloCafe/
├── main/                    # Electron main process
│   ├── db.ts              # SQLite database setup
│   ├── routes/            # API routes
│   ├── printers/          # Thermal printing logic
│   └── services/          # Business logic
├── frontend/               # Next.js frontend (submodule)
│   └── src/
│       ├── app/           # Next.js App Router
│       ├── components/    # React components
│       ├── hooks/         # Custom React hooks
│       └── lib/           # Utilities
└── release/               # Built applications
```

### Database

FloCafe uses **SQLite** for local storage:
- `business` - Business profile
- `products` - Menu/product catalog
- `categories` - Menu categories
- `tables` - Restaurant tables
- `orders` - Order records
- `bills` - Billing/payments
- `printers` - Printer configurations
- `staff` - Employee records
- `customers` - Customer database


## 🤝 Contributing

Contributions are welcome!

1. **Fork** the repository
2. **Clone** your fork: `git clone https://github.com/YOUR_NAME/FloCafe.git`
3. **Create** a branch: `git checkout -b feature/amazing-feature`
4. **Commit** your changes: `git commit -m 'Add amazing feature'`
5. **Push** to the branch: `git push origin feature/amazing-feature`
6. **Open** a Pull Request

## 🐛 Troubleshooting

### Printer not detected?
- Ensure the printer is connected and powered on
- Check USB connection
- For network printers, ensure they're on the same network

### App crashes on startup?
- Delete the database file and restart (data will be lost)
- Check logs in the application directory

### Printing issues?
- Verify printer supports ESC/POS protocol
- Test with the built-in print test page
- Check paper and ribbon/thermal head

## 📄 License

This project is open source under the **MIT License**.

## 🙏 Acknowledgments

Built with ❤️ using:
- Electron
- Next.js
- SQLite
- Tailwind CSS
- shadcn/ui

## 📞 Support

- **GitHub Issues:** https://github.com/FreeOpenSourcePOS/FloCafe/issues
- **Community:** [Discord](https://discord.gg/flopos) | [Telegram](https://t.me/flopos)

---

<p align="center">
  <strong>Bringing professional POS software to every cafe and restaurant!</strong><br>
  ⭐ Star us on GitHub | 🐛 Report bugs | 💡 Suggest features | 📢 Share with others
</p>

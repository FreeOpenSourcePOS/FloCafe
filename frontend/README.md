# FloCafe Frontend

Frontend for FloCafe POS - a Next.js 16 + React 19 application with Tailwind CSS v4 and shadcn/ui components.

It runs as a static HTML/CSS/JS export (`output: 'export'`) when embedded inside the Electron desktop application, served by the local Express backend (`:3001`), standalone KDS server (`:3002`), and Server App (`:3003`). When `NEXT_BUILD_MODE` is unset, it can also run in standard Next.js server runtime mode.

## Features

### Orders Page
- **Bill-style order cards** with status tracking, items, and totals
- **Filter bar** - search by order number, filter by table, type, or status
- **Print receipt** - confirmation modal with print logging
- **Cancel order** - modal with reason, table free option, and manager PIN override
- **Loyalty points** - toggle to award points per order
- **Discount modal** - percentage or amount discounts with live preview
- **Add item / New order** buttons for existing orders
- **Print history** - collapsible section showing print log
- **WhatsApp sharing** - share bill directly with customer
- **Cross-device held orders sync** - resume and manage suspended orders seamlessly

### Kitchen Display System (KDS)
- Real-time order updates via WebSocket
- Standalone KDS mode (`/kds-standalone`) and in-dashboard kitchen view
- Dynamic IP detection for easy pairing via VPN/Mesh networks (Tailscale, ZeroTier, etc.)
- **"NEW" badge** for items added after initial order
- Table name always visible
- Status progression: pending → preparing → ready → served

### Point of Sale & Management Pages
- **POS (`/pos`)** - Fast order entry with product search, modifiers/addons, customer selection, and cart
- **Products (`/products`)** - Product catalog management, categories, dietary badges, and prices
- **Tables (`/tables`)** - Table status, floor switching, and interactive drag-and-drop floorplan editor
- **Customers (`/customers`)** - Customer database, search, and purchase history
- **Reports (`/reports`)** - Sales reports, cash close, and analytics
- **Staff (`/staff`)** - Staff management, fixed roles, and permissions
- **Settings (`/settings`)** - Store settings, printers, payment methods, tax configuration, and beta channel toggle
- **Support (`/support`)** - Support ticket submission with optional diagnostic log attachment
- **WhatsApp (`/whatsapp`)** - WhatsApp QR pairing and message template configuration

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| UI | React 19 |
| State | Zustand |
| Styling | Tailwind CSS v4 |
| Components | shadcn/ui & Radix UI |
| Icons | Lucide React |
| API Client | Axios |
| Notifications | React Hot Toast |
| Printing | WebUSB, ESC/POS receipt encoder, and IPC bridge |

## Development Setup

From the repository root:

```bash
# Full development environment (Electron app + backend + frontend)
npm run dev

# Or run frontend in browser dev server
npm run dev:frontend

# Backend alone (Express on :3001, KDS on :3002, Server App on :3003)
node dev-server.js
```

### Available Frontend Commands

Run from repository root:

| Command | Description |
|---------|-------------|
| `npm run dev:frontend` | Start Next.js development server on port 3000 |
| `npm run build:frontend` | Build and export static Next.js frontend to `frontend/out/` |
| `npm run lint` | Run ESLint across backend and frontend |
| `npm run test:e2e:browser` | Run Playwright browser tests in `frontend/` |

## Project Structure

```
frontend/src/
├── app/                    # Next.js App Router pages
│   ├── (dashboard)/        # Main dashboard routes (POS, orders, products, tables, etc.)
│   ├── auth/               # Login, registration, recovery
│   ├── customer-display/   # Customer-facing secondary display
│   ├── kds-standalone/     # Standalone KDS display
│   ├── server-standalone/  # Standalone Server App (tableside ordering)
│   └── setup/              # Initial setup wizard
├── components/             # React components
│   ├── dashboard/          # Cash close and dashboard modals
│   ├── kds/                # Kitchen display components
│   ├── layout/             # Sidebar, title bar, window controls, theme sync
│   ├── orders/             # Order history and refund modals
│   ├── pos/                # POS cart, products grid, payments, number pad
│   ├── settings/           # Configuration tabs and dialogs
│   ├── tables/             # Floorplan editor and turnover badges
│   └── ui/                 # shadcn/ui base primitives
├── hooks/                  # Custom React hooks (printers, KDS, theme, updates)
├── lib/                    # Utilities, API client, types, i18n, printer encoders
├── store/                  # Zustand state stores
│   ├── auth.ts             # Authentication state
│   ├── cart.ts             # Shopping cart state
│   ├── held-orders.ts      # Suspended/held orders
│   ├── pos-settings.ts     # POS configuration
│   └── theme.ts            # UI theme mode state
└── types/                  # TypeScript declaration files
```

## State Management

Zustand stores live in `src/store/`:

- **auth.ts** - User authentication, tenant info, current user, roles
- **cart.ts** - Shopping cart items, addons, discounts, and totals
- **held-orders.ts** - Suspended/held orders
- **pos-settings.ts** - POS configuration from backend
- **theme.ts** - Light, dark, and system theme preferences

## License

MIT License - see [LICENSE](../LICENSE).

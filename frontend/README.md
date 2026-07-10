# FloUI

**Frontend for FloCafe POS** — a Next.js 16 + React 19 application with Tailwind CSS v4 and shadcn/ui components.

FloUI is the user interface for the FloCafe point-of-sale system. It runs as a static export inside Electron and communicates with the local Express backend (`:3001`) and KDS server (`:3002`).

## Features

### Orders Page
- **Order cards** with status tracking, items, and totals
- **Filter bar** — search by order number, filter by table, type, or status
- **Print receipt** — confirmation modal with print logging
- **Cancel order** — modal with reason, table free option, and manager PIN override
- **Loyalty points** — checkbox to award points per order
- **Discount modal** — percentage or amount discounts with live preview
- **Add item / New order** buttons for existing orders
- **Print history** — collapsible section showing print log
- **WhatsApp sharing** — share bill directly with customer

### Kitchen Display System (KDS)
- Real-time order updates via WebSocket
- **"NEW" badge** for items added after initial order
- Table name always visible
- Status progression: pending → preparing → ready → served

### Other Pages
- **POS** — Fast order entry with product search and cart
- **Menu** — Product catalog management
- **Tables** — Table status and management
- **Customers** — Customer database
- **Reports** — Sales and analytics
- **Settings** — App configuration

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| UI | React 19 |
| State | Zustand |
| Styling | Tailwind CSS v4 |
| Components | shadcn/ui |
| Icons | Lucide React |
| API Client | Axios |
| Notifications | React Hot Toast |

## Development Setup

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the app.

### Available Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |

## Project Structure

```
src/
├── app/                    # App Router pages
│   ├── (dashboard)/        # Dashboard layout group
│   │   ├── orders/         # Orders management
│   │   ├── kds/            # Kitchen Display System
│   │   ├── pos/            # Point of Sale
│   │   ├── menu/           # Menu management
│   │   ├── tables/         # Table management
│   │   ├── customers/      # Customer database
│   │   ├── reports/        # Sales reports
│   │   └── settings/       # App settings
│   ├── kds-standalone/     # Standalone KDS mode
│   └── setup/              # Initial setup wizard
├── components/             # React components
│   ├── pos/                # POS-specific components
│   └── ui/                 # shadcn/ui base components
├── store/                  # Zustand state stores
│   ├── auth.ts             # Authentication state
│   ├── cart.ts             # Shopping cart state
│   ├── held-orders.ts      # Held/suspended orders
│   └── pos-settings.ts     # POS configuration
├── lib/                    # Utilities
│   ├── api.ts              # Axios API client
│   ├── types.ts            # TypeScript types
│   ├── utils.ts            # Helper functions
│   └── countries.ts        # Country/currency data
├── hooks/                  # Custom React hooks
│   └── usePrinter.ts       # Printer integration
└── types/                  # Type declarations
    ├── electron.d.ts       # Electron API types
    └── receipt-printer-encoder.d.ts
```

## API Communication

FloUI communicates with the FloCafe backend via Axios:

```typescript
import api from '@/lib/api';

// GET orders
const { data } = await api.get('/orders', { params: { per_page: 50 } });

// PATCH order status
await api.patch(`/orders/${orderId}/status`, { status: 'cancelled' });

// POST print receipt
await api.post(`/bills/${billId}/print`, { print_type: 'receipt' });
```

## State Management

Uses Zustand for global state:

- **auth.ts** — User authentication, tenant info, current user
- **cart.ts** — Shopping cart items and totals
- **held-orders.ts** — Suspended/held orders
- **pos-settings.ts** — POS configuration from backend

## Integration with FloCafe

FloUI is included directly in the FloCafe repo:

```bash
npm run build:frontend  # Builds static export to frontend/out/
```

The static export is served by the Electron main process.

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License — see [FloCafe License](https://github.com/FreeOpenSourcePOS/FloCafe/blob/main/license_instructions.md)

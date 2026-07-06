import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CartItem } from '@/lib/types';

interface HeldOrder {
  tableId: string;
  items: CartItem[];
  customerId: number | string | null;
  guestCount: number;
  orderNotes: string;
  heldAt: string;
}

interface HeldOrdersState {
  orders: Record<string, HeldOrder>;
  holdOrder: (tableId: string, items: CartItem[], customerId: number | string | null, guestCount: number, orderNotes?: string) => void;
  restoreOrder: (tableId: string) => HeldOrder | null;
  removeHeldOrder: (tableId: string) => void;
  hasHeldOrder: (tableId: string) => boolean;
  getHeldOrder: (tableId: string) => HeldOrder | undefined;
}

export const useHeldOrdersStore = create<HeldOrdersState>()(
  persist(
    (set, get) => ({
      orders: {},

      holdOrder: (tableId, items, customerId, guestCount, orderNotes = '') => {
        set((state) => ({
          orders: {
            ...state.orders,
            [tableId]: { tableId, items, customerId, guestCount, orderNotes, heldAt: new Date().toISOString() },
          },
        }));
      },

      restoreOrder: (tableId) => {
        const order = get().orders[tableId];
        if (!order) return null;
        set((state) => {
          const { [tableId]: _, ...rest } = state.orders;
          return { orders: rest };
        });
        return order;
      },

      removeHeldOrder: (tableId) => {
        set((state) => {
          const { [tableId]: _, ...rest } = state.orders;
          return { orders: rest };
        });
      },

      hasHeldOrder: (tableId) => !!get().orders[tableId],

      getHeldOrder: (tableId) => get().orders[tableId],
    }),
    {
      name: 'held-orders',
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const migrated: Record<string, HeldOrder> = {};
        let changed = false;
        for (const [key, value] of Object.entries(state.orders)) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            migrated[String(Number(key))] = { ...value, tableId: String(Number(key)) };
            changed = true;
          } else {
            migrated[key] = value;
          }
        }
        if (changed) {
          useHeldOrdersStore.setState({ orders: migrated });
        }
      },
    }
  )
);

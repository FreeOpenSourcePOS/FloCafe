import { create } from 'zustand';
import type { CartItem } from '@/lib/types';
import api from '@/lib/api';

const HELD_ORDERS_ENDPOINT = '/held-orders';

export interface HeldOrder {
  id?: string;
  tableId: string;
  items: CartItem[];
  customerId: number | string | null;
  guestCount: number;
  orderNotes: string;
  heldAt: string;
}

interface HeldOrdersState {
  orders: Record<string, HeldOrder>;
  fetchHeldOrders: () => Promise<void>;
  holdOrder: (tableId: string, items: CartItem[], customerId: number | string | null, guestCount: number, orderNotes?: string) => Promise<void>;
  restoreOrder: (tableId: string) => Promise<HeldOrder | null>;
  removeHeldOrder: (tableId: string) => Promise<void>;
  hasHeldOrder: (tableId: string) => boolean;
  getHeldOrder: (tableId: string) => HeldOrder | undefined;
}

export const useHeldOrdersStore = create<HeldOrdersState>()((set, get) => {
  const deleteHeldOrderState = async (tableId: string) => {
    await api.delete(`${HELD_ORDERS_ENDPOINT}/${tableId}`);
    set((state) => {
      const rest = { ...state.orders };
      delete rest[tableId];
      return { orders: rest };
    });
  };

  return {
    orders: {},

    fetchHeldOrders: async () => {
      try {
        const { data } = await api.get(HELD_ORDERS_ENDPOINT);
        if (data && data.orders) {
          const newOrders: Record<string, HeldOrder> = {};
          for (const order of data.orders) {
            newOrders[order.tableId] = order;
          }
          set({ orders: newOrders });
        }
      } catch (err) {
        console.error('Failed to fetch held orders', err);
        throw err;
      }
    },

    holdOrder: async (tableId, items, customerId, guestCount, orderNotes = '') => {
      try {
        await api.post(HELD_ORDERS_ENDPOINT, { tableId, items, customerId, guestCount, orderNotes });
        set((state) => ({
          orders: {
            ...state.orders,
            [tableId]: { tableId, items, customerId, guestCount, orderNotes, heldAt: new Date().toISOString() },
          },
        }));
      } catch (err) {
        console.error('Failed to hold order', err);
        throw err;
      }
    },

    restoreOrder: async (tableId) => {
      const order = get().orders[tableId];
      if (!order) return null;
      try {
        await deleteHeldOrderState(tableId);
        return order;
      } catch (err) {
        console.error('Failed to restore order', err);
        throw err;
      }
    },

    removeHeldOrder: async (tableId) => {
      try {
        await deleteHeldOrderState(tableId);
      } catch (err) {
        console.error('Failed to remove held order', err);
        throw err;
      }
    },

    hasHeldOrder: (tableId) => !!get().orders[tableId],

    getHeldOrder: (tableId) => get().orders[tableId],
  };
});

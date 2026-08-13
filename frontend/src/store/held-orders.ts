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

interface HeldOrderDeleteResponse {
  success: boolean;
  deleted: boolean;
}

interface HeldOrderPostResponse {
  success: boolean;
  id?: string;
}

type HeldOrdersApiClient = Pick<typeof api, 'get' | 'post' | 'delete'>;

export const createHeldOrdersStore = (apiClient: HeldOrdersApiClient = api) => create<HeldOrdersState>()((set, get) => {
  let mutationVersion = 0;
  let fetchSequence = 0;

  const deleteHeldOrderState = async (tableId: string, expectedHeldOrderId?: string) => {
    const query = expectedHeldOrderId ? `?heldOrderId=${encodeURIComponent(expectedHeldOrderId)}` : '';
    const { data } = await apiClient.delete<HeldOrderDeleteResponse>(`${HELD_ORDERS_ENDPOINT}/${tableId}${query}`);
    // A successful no-op is a stale consumer, not permission to restore its cache.
    mutationVersion += 1;
    set((state) => {
      const rest = { ...state.orders };
      delete rest[tableId];
      return { orders: rest };
    });
    return data?.success === true && data.deleted === true;
  };

  return {
    orders: {},

    fetchHeldOrders: async () => {
      const requestSequence = ++fetchSequence;
      const requestMutationVersion = mutationVersion;
      try {
        const { data } = await apiClient.get(HELD_ORDERS_ENDPOINT);
        if (data && data.orders && requestSequence === fetchSequence && requestMutationVersion === mutationVersion) {
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
        const { data } = await apiClient.post<HeldOrderPostResponse>(HELD_ORDERS_ENDPOINT, { tableId, items, customerId, guestCount, orderNotes });
        mutationVersion += 1;
        set((state) => ({
          orders: {
            ...state.orders,
            [tableId]: { id: data?.id, tableId, items, customerId, guestCount, orderNotes, heldAt: new Date().toISOString() },
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
        const deleted = await deleteHeldOrderState(tableId, order.id);
        return deleted ? order : null;
      } catch (err) {
        console.error('Failed to restore order', err);
        throw err;
      }
    },

    removeHeldOrder: async (tableId) => {
      try {
        await deleteHeldOrderState(tableId, get().orders[tableId]?.id);
      } catch (err) {
        console.error('Failed to remove held order', err);
        throw err;
      }
    },

    hasHeldOrder: (tableId) => !!get().orders[tableId],

    getHeldOrder: (tableId) => get().orders[tableId],
  };
});

export const useHeldOrdersStore = createHeldOrdersStore(api);

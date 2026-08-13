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
  const tableMutationVersions = new Map<string, number>();
  let fetchSequence = 0;

  const getTableMutationVersion = (tableId: string) => tableMutationVersions.get(tableId) ?? 0;
  const markTableMutation = (tableId: string) => {
    tableMutationVersions.set(tableId, getTableMutationVersion(tableId) + 1);
  };

  const deleteHeldOrderState = async (tableId: string, expectedHeldOrderId?: string) => {
    const query = expectedHeldOrderId ? `?heldOrderId=${encodeURIComponent(expectedHeldOrderId)}` : '';
    const { data } = await apiClient.delete<HeldOrderDeleteResponse>(`${HELD_ORDERS_ENDPOINT}/${tableId}${query}`);
    if (expectedHeldOrderId) {
      markTableMutation(tableId);
      set((state) => {
        const current = state.orders[tableId];
        if (!current || current.id !== expectedHeldOrderId) return state;
        const rest = { ...state.orders };
        delete rest[tableId];
        return { orders: rest };
      });
    }
    return data?.success === true && data.deleted === true;
  };

  return {
    orders: {},

    fetchHeldOrders: async () => {
      const requestSequence = ++fetchSequence;
      const requestMutationVersions = new Map(tableMutationVersions);
      try {
        const { data } = await apiClient.get(HELD_ORDERS_ENDPOINT);
        if (data && data.orders && requestSequence === fetchSequence) {
          const fetchedOrders: Record<string, HeldOrder> = {};
          for (const order of data.orders) fetchedOrders[order.tableId] = order;
          set((state) => {
            const newOrders = { ...state.orders };
            const tableIds = new Set([...Object.keys(state.orders), ...Object.keys(fetchedOrders)]);
            for (const tableId of tableIds) {
              if (getTableMutationVersion(tableId) !== (requestMutationVersions.get(tableId) ?? 0)) continue;
              if (fetchedOrders[tableId]) newOrders[tableId] = fetchedOrders[tableId];
              else delete newOrders[tableId];
            }
            return { orders: newOrders };
          });
        }
      } catch (err) {
        console.error('Failed to fetch held orders', err);
        throw err;
      }
    },

    holdOrder: async (tableId, items, customerId, guestCount, orderNotes = '') => {
      try {
        const { data } = await apiClient.post<HeldOrderPostResponse>(HELD_ORDERS_ENDPOINT, { tableId, items, customerId, guestCount, orderNotes });
        markTableMutation(tableId);
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

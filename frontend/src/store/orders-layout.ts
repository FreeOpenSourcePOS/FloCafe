import { create } from 'zustand';

export type OrdersLayout = 'split' | 'cards';

export interface OrdersLayoutState {
  layout: OrdersLayout;
  /** Set by an explicit user choice this session; boot hydration must not override. */
  userSelected: boolean;
  setLayout: (layout: OrdersLayout) => void;
  markUserSelected: () => void;
}

export function isOrdersLayoutValue(v: unknown): v is OrdersLayout {
  return v === 'split' || v === 'cards';
}

/** Renderer-owned Orders screen layout ('split' | 'cards').
 * Persistence is handled by writers to keep store pure. */
export const useOrdersLayoutStore = create<OrdersLayoutState>((set) => ({
  layout: 'split',
  userSelected: false,
  setLayout: (layout) => set({ layout }),
  markUserSelected: () => set({ userSelected: true }),
}));
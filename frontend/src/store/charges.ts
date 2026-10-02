'use client';

import { create } from 'zustand';
import api from '@/lib/api';
import type { ChargeDefinition } from '@/lib/charges';

interface ChargesState {
  charges: ChargeDefinition[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  save: (charges: ChargeDefinition[]) => Promise<ChargeDefinition[]>;
}

export const useChargesStore = create<ChargesState>((set) => ({
  charges: [],
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const { data } = await api.get('/settings/charges');
      set({ charges: Array.isArray(data?.charges) ? data.charges : [], loading: false });
    } catch {
      // A charges read failure must not take the POS down; the cart simply shows
      // no engine charges and the backend stays authoritative on the total.
      set({ charges: [], loading: false, error: 'charges_unavailable' });
    }
  },

  save: async (charges) => {
    const { data } = await api.put('/settings/charges', { charges });
    const saved = Array.isArray(data?.charges) ? data.charges : charges;
    set({ charges: saved, error: null });
    return saved;
  },
}));

/** Charges that apply to an order type, auto-applied unless opted in. */
export function chargesForOrderType(
  charges: ChargeDefinition[],
  orderType: string,
): ChargeDefinition[] {
  return charges.filter(
    (charge) => charge.is_active && charge.order_types.includes(orderType as ChargeDefinition['order_types'][number]),
  );
}
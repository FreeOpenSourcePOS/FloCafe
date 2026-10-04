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

export const useChargesStore = create<ChargesState>((set) => {
  let latestLoadRequest = 0;

  return {
    charges: [],
    loading: false,
    error: null,

    load: async () => {
      const requestId = ++latestLoadRequest;
      set({ loading: true, error: null });
      try {
        const { data } = await api.get('/settings/charges');
        if (requestId !== latestLoadRequest) return;
        set({ charges: Array.isArray(data?.charges) ? data.charges : [], error: null });
      } catch {
        if (requestId !== latestLoadRequest) return;
        // A charges read failure must not take the POS down; the cart simply shows
        // no engine charges and the backend stays authoritative on the total.
        set({ error: 'charges_unavailable' });
      } finally {
        if (requestId === latestLoadRequest) set({ loading: false });
      }
    },

    save: async (charges) => {
      const { data } = await api.put('/settings/charges', { charges });
      const saved = Array.isArray(data?.charges) ? data.charges : charges;
      latestLoadRequest += 1;
      set({ charges: saved, error: null, loading: false });
      return saved;
    },
  };
});

/** Charges that apply to an order type, auto-applied unless opted in. */
export function chargesForOrderType(
  charges: ChargeDefinition[],
  orderType: string,
): ChargeDefinition[] {
  return charges.filter(
    (charge) => charge.is_active && charge.order_types.includes(orderType as ChargeDefinition['order_types'][number]),
  );
}

import { create } from 'zustand';
import type { Customer, Product, Addon, CartItem } from '@/lib/types';
import { generateCartItemId, normalizeCartItems } from '@/lib/cart-identity';

export { generateCartItemId, normalizeCartItems } from '@/lib/cart-identity';

export type CartOrderType = 'dine_in' | 'takeaway' | 'delivery' | 'online';

interface CartState {
  items: CartItem[];
  orderType: CartOrderType;
  tableId: string | null;
  heldOrderId: string | null;
  customerId: number | string | null;
  customer: Customer | null;
  customerSource: 'explicit' | 'reservation' | null;
  guestCount: number;
  deliveryAddress: string;
  onlinePlatform: string;
  externalOrderId: string;
  orderNotes: string;

  addItem: (product: Product, quantity?: number, addons?: Addon[], specialInstructions?: string) => void;
  updateItemDetails: (cartItemId: string, quantity: number, addons: Addon[], specialInstructions: string) => void;
  removeItem: (cartItemId: string) => void;
  updateQuantity: (cartItemId: string, quantity: number) => void;
  clearCart: () => void;
  loadItems: (items: CartItem[], tableId: string | null, customerId: number | string | null, guestCount: number, orderNotes?: string, heldOrderId?: string) => void;
  setOrderType: (type: CartState['orderType']) => void;
  setTableId: (id: string | null) => void;
  setCustomerId: (id: number | string | null) => void;
  setCustomer: (customer: Customer | null) => void;
  setReservationCustomer: (customer: Customer | null) => void;
  setGuestCount: (count: number) => void;
  setDeliveryAddress: (address: string) => void;
  setOnlinePlatform: (platform: string) => void;
  setExternalOrderId: (id: string) => void;
  setOrderNotes: (notes: string) => void;
  /** Charge ids the cashier has waived in this cart. */
  waivedChargeIds: Set<string>;
  /** Opt-in (not default-active) charges the cashier has added to this cart. */
  optedInChargeIds: Set<string>;
  toggleWaiveCharge: (chargeId: string) => void;
  toggleOptedInCharge: (chargeId: string) => void;
  resetCharges: () => void;

  subtotal: () => number;
  itemCount: () => number;
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  orderType: 'dine_in',
  tableId: null,
  heldOrderId: null,
  customerId: null,
  customer: null,
  customerSource: null,
  guestCount: 1,
  deliveryAddress: '',
  onlinePlatform: '',
  externalOrderId: '',
  orderNotes: '',
  waivedChargeIds: new Set<string>(),
  optedInChargeIds: new Set<string>(),

  // Waivers are explicit state, never inferred from a zero amount: a waived
  // charge and a fee configured at 0 must stay distinguishable.
  toggleWaiveCharge: (chargeId) => set((state) => {
    const waivedChargeIds = new Set(state.waivedChargeIds);
    if (waivedChargeIds.has(chargeId)) waivedChargeIds.delete(chargeId);
    else waivedChargeIds.add(chargeId);
    return { waivedChargeIds };
  }),

  toggleOptedInCharge: (chargeId) => set((state) => {
    const optedInChargeIds = new Set(state.optedInChargeIds);
    if (optedInChargeIds.has(chargeId)) optedInChargeIds.delete(chargeId);
    else optedInChargeIds.add(chargeId);
    return { optedInChargeIds };
  }),

  resetCharges: () => set({ waivedChargeIds: new Set<string>(), optedInChargeIds: new Set<string>() }),

  addItem: (product, quantity = 1, addons = [], specialInstructions = '') => {
    const items = get().items;
    const itemId = generateCartItemId(product.id, addons, specialInstructions);
    const existing = items.find((i) => i.id === itemId);

    if (existing) {
      set({
        items: items.map((i) =>
          i.id === itemId ? { ...i, quantity: i.quantity + quantity } : i
        ),
      });
    } else {
      set({
        items: [...items, { id: itemId, product, quantity, addons, special_instructions: specialInstructions }],
      });
    }
  },

  updateItemDetails: (cartItemId, quantity, addons, specialInstructions) => {
    const items = get().items;
    const target = items.find((i) => i.id === cartItemId);
    if (!target) return;

    const newId = generateCartItemId(target.product.id, addons, specialInstructions);
    if (newId === cartItemId) {
      set({
        items: items.map((i) =>
          i.id === cartItemId ? { ...i, quantity, addons, special_instructions: specialInstructions } : i
        ),
      });
      return;
    }

    // The edit produced a config that matches another existing line — merge into it.
    const collision = items.find((i) => i.id === newId && i.id !== cartItemId);
    if (collision) {
      set({
        items: items
          .filter((i) => i.id !== cartItemId)
          .map((i) => (i.id === newId ? { ...i, quantity: i.quantity + quantity } : i)),
      });
    } else {
      set({
        items: items.map((i) =>
          i.id === cartItemId ? { ...i, id: newId, quantity, addons, special_instructions: specialInstructions } : i
        ),
      });
    }
  },

  removeItem: (cartItemId) => {
    set({ items: get().items.filter((i) => i.id !== cartItemId) });
  },

  updateQuantity: (cartItemId, quantity) => {
    if (quantity <= 0) {
      get().removeItem(cartItemId);
      return;
    }
    set({
      items: get().items.map((i) =>
        i.id === cartItemId ? { ...i, quantity } : i
      ),
    });
  },

  clearCart: () => {
    set({ items: [], tableId: null, heldOrderId: null, customerId: null, customer: null, customerSource: null, guestCount: 1, orderType: 'dine_in', deliveryAddress: '', onlinePlatform: '', externalOrderId: '', orderNotes: '', waivedChargeIds: new Set<string>(), optedInChargeIds: new Set<string>() });
  },

  loadItems: (items, tableId, customerId, guestCount, orderNotes, heldOrderId) => {
    set({ items: normalizeCartItems(items), tableId, heldOrderId: heldOrderId || null, customerId, customerSource: customerId == null ? null : 'explicit', guestCount, orderNotes: orderNotes || '' });
  },

  setOrderType: (type) => set((state) => ({
    orderType: type,
    deliveryAddress: type !== 'delivery' ? '' : state.deliveryAddress,
    onlinePlatform: type !== 'online' ? '' : state.onlinePlatform,
    externalOrderId: type !== 'online' ? '' : state.externalOrderId,
    // Only a real change of order type resets charges: re-selecting the type the
    // cart already has must not silently un-waive a fee the cashier removed.
    ...(state.orderType === type
      ? {}
      : { waivedChargeIds: new Set<string>(), optedInChargeIds: new Set<string>() }),
  })),
  setTableId: (id) => set({ tableId: id, heldOrderId: null }),
  setCustomerId: (id) => set({ customerId: id, customerSource: id == null ? null : 'explicit' }),
  setCustomer: (customer) => set({ customer, customerId: customer?.id ?? null, customerSource: customer ? 'explicit' : null }),
  setReservationCustomer: (customer) => set({ customer, customerId: customer?.id ?? null, customerSource: customer ? 'reservation' : null }),
  setGuestCount: (count) => set({ guestCount: count }),
  setDeliveryAddress: (address) => set({ deliveryAddress: address }),
  setOnlinePlatform: (platform) => set({ onlinePlatform: platform }),
  setExternalOrderId: (id) => set({ externalOrderId: id }),
  setOrderNotes: (notes) => set({ orderNotes: notes }),

  subtotal: () => {
    return get().items.reduce((sum, item) => {
      const itemPrice = Number(item.product?.price) || 0;
      const itemQty = Number(item.quantity) || 1;
      const addonTotal = (item.addons || []).reduce((a, addon) => a + (Number(addon.price) || 0) * (Number(addon.quantity) || 1), 0);
      return sum + (itemPrice + addonTotal) * itemQty;
    }, 0);
  },

  itemCount: () => {
    return get().items.reduce((sum, item) => sum + item.quantity, 0);
  },
}));

import { create } from 'zustand';
import type { Customer, Product, Addon, CartItem } from '@/lib/types';

interface CartState {
  items: CartItem[];
  orderType: 'dine_in' | 'takeaway' | 'delivery';
  tableId: string | null;
  customerId: number | string | null;
  customer: Customer | null;
  guestCount: number;
  deliveryAddress: string;
  orderNotes: string;

  addItem: (product: Product, quantity?: number, addons?: Addon[], specialInstructions?: string) => void;
  removeItem: (cartItemId: string) => void;
  updateQuantity: (cartItemId: string, quantity: number) => void;
  clearCart: () => void;
  loadItems: (items: CartItem[], tableId: string | null, customerId: number | string | null, guestCount: number, orderNotes?: string) => void;
  setOrderType: (type: CartState['orderType']) => void;
  setTableId: (id: string | null) => void;
  setCustomerId: (id: number | string | null) => void;
  setCustomer: (customer: Customer | null) => void;
  setGuestCount: (count: number) => void;
  setDeliveryAddress: (address: string) => void;
  setOrderNotes: (notes: string) => void;

  subtotal: () => number;
  itemCount: () => number;
}

function generateCartItemId(productId: number, addons: Addon[], specialInstructions: string): string {
  const parts = [String(productId)];
  if (addons.length > 0) {
    parts.push(addons.map((a) => a.id).sort((a, b) => a - b).join(','));
  }
  if (specialInstructions) {
    parts.push(specialInstructions);
  }
  return parts.join('-');
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  orderType: 'dine_in',
  tableId: null,
  customerId: null,
  customer: null,
  guestCount: 1,
  deliveryAddress: '',
  orderNotes: '',

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
    set({ items: [], tableId: null, customerId: null, customer: null, guestCount: 1, deliveryAddress: '', orderNotes: '' });
  },

  loadItems: (items, tableId, customerId, guestCount, orderNotes) => {
    set({ items, tableId, customerId, guestCount, orderNotes: orderNotes || '' });
  },

  setOrderType: (type) => set({ orderType: type, deliveryAddress: type !== 'delivery' ? '' : undefined }),
  setTableId: (id) => set({ tableId: id }),
  setCustomerId: (id) => set({ customerId: id }),
  setCustomer: (customer) => set({ customer, customerId: customer?.id ?? null }),
  setGuestCount: (count) => set({ guestCount: count }),
  setDeliveryAddress: (address) => set({ deliveryAddress: address }),
  setOrderNotes: (notes) => set({ orderNotes: notes }),

  subtotal: () => {
    return get().items.reduce((sum, item) => {
      const addonTotal = item.addons.reduce((a, addon) => a + Number(addon.price), 0);
      return sum + (Number(item.product.price) + addonTotal) * item.quantity;
    }, 0);
  },

  itemCount: () => {
    return get().items.reduce((sum, item) => sum + item.quantity, 0);
  },
}));

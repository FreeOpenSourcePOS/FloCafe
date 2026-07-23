export interface User {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  country_code: string;
  is_active: boolean;
}

export interface Tenant {
  id: number;
  business_name: string;
  slug: string;
  database_name: string;
  business_type: 'restaurant';
  service_model?: 'qsr' | 'finedine';
  country: string;
  currency: string;
  timezone: string;
  plan: string;
  status: string;
  role?: string;
  language?: 'en' | 'es';
}

export interface Category {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  parent_id: number | null;
  sort_order: number;
  is_active: boolean;
  color: string | null;
  icon: string | null;
  children?: Category[];
  products?: Product[];
}

export interface LoyaltyLedger {
  id: number;
  customer_id: number;
  bill_id: number | null;
  type: 'credit' | 'debit';
  amount: number;
  description: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface Product {
  id: number;
  category_id: number;
  name: string;
  sku: string | null;
  barcode: string | null;
  description: string | null;
  price: number;
  cost_price: number | null;
  cb_percent?: number;
  tax_type: 'none' | 'inclusive' | 'exclusive';
  tax_rate: number;
  track_inventory: boolean;
  stock_quantity: number;
  low_stock_threshold: number | null;
  is_active: boolean;
  available_online: boolean;
  has_image: boolean;
  updated_at: string;
  tags: string[] | null;
  variants: Record<string, unknown>[] | null;
  modifiers: Record<string, unknown>[] | null;
  sort_order: number;
  category?: Category;
  addon_groups?: AddonGroup[];
}

export interface AddonGroup {
  id: number | string;
  name: string;
  description: string | null;
  is_required: boolean | number;
  min_selection: number;
  max_selection: number;
  allow_multiple_quantities?: boolean | number;
  sort_order: number;
  is_active: boolean | number;
  addons?: Addon[];
}

export interface Addon {
  id: number | string;
  addon_group_id: number | string;
  name: string;
  price: number;
  quantity?: number;
  is_active: boolean | number;
  sort_order: number;
}

export interface Table {
  id: string;
  name: string;
  capacity: number;
  status: 'available' | 'occupied' | 'reserved' | 'cleaning' | 'held';
  kitchen_station_id: number | null;
  floor: string | null;
  section: string | null;
  is_active: boolean;
  activeOrder?: Order | null;
  current_order?: Order | null;
  reservation_customer_id?: number | null;
  reservation_customer_name?: string | null;
  reservation_customer_phone?: string | null;
}

export interface Customer {
  id: string | number;
  phone: string;
  phone_digits?: string | null;
  country_code: string;
  name: string;
  email: string | null;
  visits_count?: number;
  total_spent?: number;
  last_visit_at?: string | null;
  wallet_balance?: number;
  global_customer_id?: number | null;
  dietary_preferences?: string[] | null;
  favourite_dishes?: string[] | null;
  tag_counts?: Record<string, number> | null;
  address?: string | null;
}

export interface Order {
  id: number;
  order_number: string;
  table_id: string | null;
  customer_id: number | string | null;
  type: 'dine_in' | 'takeaway' | 'delivery' | 'online';
  status: 'pending' | 'preparing' | 'ready' | 'served' | 'completed' | 'cancelled';
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  delivery_charge: number;
  packaging_charge?: number;
  round_off?: number;
  tax_breakdown?: { title: string; rate: number; amount: number }[] | null;
  total: number;
  guest_count: number | null;
  special_instructions: string | null;
  created_by: number;
  created_at: string;
  items?: OrderItem[];
  table?: Table;
  customer?: Customer;
  bill?: Bill;
}

export interface OrderItem {
  id: number;
  order_id: number;
  product_id: number;
  product_name: string;
  product_sku: string | null;
  unit_price: number;
  quantity: number;
  subtotal: number;
  tax_amount: number;
  total: number;
  addons: { id?: number | string | null; name: string; price?: number; quantity?: number }[] | null;
  special_instructions: string | null;
  status: 'pending' | 'preparing' | 'ready' | 'served' | 'cancelled';
}

export interface Bill {
  id: number;
  bill_number: string;
  order_id: number;
  customer_id?: number | string | null;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  discount_type?: string | null;
  discount_value?: number | null;
  discount_reason?: string | null;
  service_charge: number;
  delivery_charge: number;
  packaging_charge?: number;
  round_off?: number;
  total: number;
  paid_amount: number;
  balance: number;
  payment_status: 'unpaid' | 'partial' | 'paid';
  payment_details: { method: string; amount: number; timestamp: string }[] | null;
  tax_breakdown?: { title: string; rate: number; amount: number }[] | null;
  order?: Order;
}

export interface Staff {
  id: string;
  name: string;
  email: string | null;
  role: string;
  pin_hash: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface KitchenStation {
  id: number;
  name: string;
  description: string | null;
  category_ids: number[] | null;
  is_active: boolean;
  printer_ip: string | null;
  sort_order: number;
}

// Cart types for POS
export interface CartItem {
  id: string;
  product: Product;
  quantity: number;
  addons: Addon[];
  special_instructions: string;
}

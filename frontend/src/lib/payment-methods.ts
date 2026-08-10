import { Banknote, CreditCard } from 'lucide-react';

export const PAYMENT_METHODS = Object.freeze([
  { key: 'cash' as const, labelKey: 'pos.methodCash', icon: Banknote },
  { key: 'card' as const, labelKey: 'pos.methodCard', icon: CreditCard },
]);

export interface CustomPaymentMethod {
  id: number;
  name: string;
  is_active: boolean;
  sort_order: number;
  usage_count?: number;
}

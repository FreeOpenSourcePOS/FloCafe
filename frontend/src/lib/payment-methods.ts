import { Banknote, CreditCard, Smartphone } from 'lucide-react';

export const PAYMENT_METHODS = Object.freeze([
  { key: 'cash' as const, labelKey: 'pos.methodCash', icon: Banknote },
  { key: 'card' as const, labelKey: 'pos.methodCard', icon: CreditCard },
  { key: 'upi' as const, labelKey: 'pos.methodUpi', icon: Smartphone },
]);

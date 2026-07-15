import { Banknote, CreditCard, Smartphone } from 'lucide-react';

export const PAYMENT_METHODS: { key: 'cash' | 'card' | 'upi'; labelKey: string; icon: typeof Banknote }[] = [
  { key: 'cash', labelKey: 'pos.methodCash', icon: Banknote },
  { key: 'card', labelKey: 'pos.methodCard', icon: CreditCard },
  { key: 'upi', labelKey: 'pos.methodUpi', icon: Smartphone },
];

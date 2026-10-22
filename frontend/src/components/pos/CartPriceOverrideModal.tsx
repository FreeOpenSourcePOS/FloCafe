'use client';

import { formatItemHeading } from '@/lib/printer/item-heading';
import { cartLineUnitPrice } from '@/lib/cart-price';
import { PriceOverrideDialog } from '@/components/orders/PriceOverrideDialog';
import type { CartItem } from '@/lib/types';

interface Props {
  item: CartItem;
  onlinePlatformSelected: boolean;
  onApply: (override: { price: number; reason: string } | null) => void;
  onClose: () => void;
}

/** Owner-only: sets or clears a manual price on a cart line before the order is placed. */
export function CartPriceOverrideModal({ item, onlinePlatformSelected, onApply, onClose }: Props) {
  return (
    <PriceOverrideDialog
      heading={formatItemHeading(item.product.name, item.variant ?? null)}
      initialPrice={cartLineUnitPrice(item, onlinePlatformSelected)}
      initialReason={item.price_override?.reason ?? ''}
      onSubmit={(price, reason) => {
        onApply({ price, reason });
        onClose();
      }}
      onClear={
        item.price_override
          ? () => {
              onApply(null);
              onClose();
            }
          : undefined
      }
      onClose={onClose}
    />
  );
}

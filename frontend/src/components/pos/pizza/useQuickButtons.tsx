'use client';

import { useRef } from 'react';
import { Check, Star } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { create } from 'zustand';
import { getCategoryColorClasses } from '@/components/pos/ProductGrid';
import { tenantCan } from '@/lib/permissions';
import { holdPizzaCatalog } from '@/lib/pizza/catalog';
import {
  buttonContents,
  fetchQuickButtons,
  refusalMessage,
  sheetButtonId,
  updateQuickButton,
  type ButtonLine,
} from '@/lib/pizza/quick-buttons';
import type { CartItem } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth';
import { useCartStore } from '@/store/cart';
import { onSessionBoundary } from '@/store/session-events';
import type { QuickButton } from '@shared/pizza/types';

/** The id the Quick Buttons block selects in place of a category; no product has it. */
export const QUICK_BUTTONS_CATEGORY = 'quick-buttons';

export type QuickButtonDialog =
  /** `line` is what to save; null lets the cashier pick a line of the order. */
  | { type: 'save'; line: ButtonLine | null; forCustomer: boolean }
  | { type: 'edit'; button: QuickButton }
  | { type: 'delete'; button: QuickButton };

interface QuickButtonState {
  /** The shop-wide buttons, then those of the customer on the order. */
  buttons: QuickButton[];
  dialog: QuickButtonDialog | null;
  open: (dialog: QuickButtonDialog | null) => void;
  /** The customer the buttons were last listed for: the one the cart panel shows. */
  customerId: string | number | null;
  /** Lists the buttons for that customer, or again for the last one when none is named. */
  load: (customerId?: string | number | null) => Promise<void>;
}

let latest: Promise<QuickButton[]> | null = null;

/** The buttons and the open dialog, shared by the category block, the page, the cart and the sheet. */
export const useQuickButtonStore = create<QuickButtonState>((set, get) => ({
  buttons: [],
  dialog: null,
  customerId: null,
  open: (dialog) => {
    // Before the dialog renders, so no answer on its way changes the menu under it.
    if (dialog) holdPizzaCatalog(true);
    set({ dialog });
  },
  load: async (customerId = get().customerId) => {
    set({ customerId });
    const request = fetchQuickButtons(customerId);
    latest = request;
    try {
      const buttons = await request;
      // Only the latest answer counts, whatever order they arrive in.
      if (latest === request) set({ buttons });
    } catch {
      // A failed fetch keeps the buttons already shown; the next change asks again.
    }
  },
}));

/** Forgets the buttons, the open dialog and any list on its way: they belong to one session and tenant. */
function forget() {
  latest = null;
  useQuickButtonStore.setState({ buttons: [], dialog: null, customerId: null });
}

// Locking and unlocking with a PIN keep the store, so its buttons stay.
onSessionBoundary((event) => {
  if (event === 'login' || event === 'logout') forget();
});

// Selecting another tenant changes the session with no sign-in; a locked screen has no tenant.
let tenantId = useAuthStore.getState().currentTenant?.id ?? null;
useAuthStore.subscribe((state) => {
  const id = state.currentTenant?.id ?? null;
  if (id === null || id === tenantId) return;
  if (tenantId !== null) forget();
  tenantId = id;
});

/** True while the order is for an online platform, as the cart decides which price a line has. */
export const useOnlineOrder = () =>
  useCartStore((cart) => cart.orderType === 'online' && cart.onlinePlatform.trim().length > 0);

/** Whose buttons this user may save, change and delete, as the routes decide it. */
export function useQuickButtonRights() {
  const tenant = useAuthStore((state) => state.currentTenant);
  const customer = useCartStore((state) => state.customer);
  const customers = tenantCan(tenant, 'orders.create');
  return {
    shop: tenantCan(tenant, 'catalog.manage'),
    customers,
    /** The customer on the order, when this user may keep buttons for them. */
    customer: customers ? customer : null,
  };
}

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground';

/**
 * The Quick Buttons block among the category blocks, with how many the shop
 * has saved. It selects an id no category has, which empties the product grid
 * for the quick buttons page.
 */
export function QuickButtonsBlock({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations('pizza');
  const count = useQuickButtonStore(
    (state) => state.buttons.filter((button) => button.customer_id === null).length,
  );
  const color = getCategoryColorClasses('indigo');
  const pressed = selected === QUICK_BUTTONS_CATEGORY;
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onSelect(QUICK_BUTTONS_CATEGORY)}
      className={cn(
        'flex min-h-14 flex-col justify-center rounded-xl border border-s-4 px-3 py-1 text-start font-bold leading-tight transition-colors',
        FOCUS,
        color && `${color.bg} ${color.text} ${color.border}`,
        // The ring and the tick mark the open block, as on the category blocks beside it.
        pressed && 'border-current ring-2 ring-inset ring-current',
      )}
    >
      <span className="text-base">{t('quickButtons')}</span>
      <span className="flex items-center justify-between gap-2 text-xs">
        {t('quickSaved', { count })}
        {pressed && <Check size={16} className="shrink-0" />}
      </span>
    </button>
  );
}

/** What the pizza sheet's owner needs: whether a dialog is open, and where a saved pizza goes. */
export function useQuickButtonSheet() {
  const t = useTranslations('pizza');
  const dialogOpen = useQuickButtonStore((state) => state.dialog !== null);
  /** True while a changed button is on its way to the server, when a second Save is ignored. */
  const sending = useRef(false);
  return {
    dialogOpen,
    /**
     * True when the pizza goes to a button and not to the order. `target` is
     * true for "Save as quick button", or the id of the line the sheet opened on.
     * `done` runs once a changed button is stored.
     */
    takes: (line: ButtonLine, target: string | boolean | null | undefined, done: () => void) => {
      const { open, load } = useQuickButtonStore.getState();
      if (target === true) {
        open({ type: 'save', line, forCustomer: false });
        return true;
      }
      const id = typeof target === 'string' ? sheetButtonId(target) : null;
      if (!id) return false;
      if (sending.current) return true;
      sending.current = true;
      updateQuickButton(id, buttonContents(line))
        .then(
          () => load().then(done),
          (error) => toast.error(refusalMessage(error, t('quickFailed'))),
        )
        .finally(() => {
          sending.current = false;
        });
      return true;
    },
  };
}

/** "Save as quick button", for a user who may save one for the shop or for the order's customer. */
export function QuickButtonSaveAction({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  const t = useTranslations('pizza');
  const rights = useQuickButtonRights();
  if (!rights.shop && !rights.customer) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-h-12 min-w-12 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-brand hover:bg-muted dark:text-indigo-300',
        FOCUS,
        className,
      )}
    >
      <Star size={16} className="shrink-0" />
      {t('quickSaveAs')}
    </button>
  );
}

/** The action under a line of the cart that saves that line as a button. */
export function QuickButtonLineAction({ item }: { item: CartItem }) {
  return (
    <div className="flex justify-end">
      <QuickButtonSaveAction
        onClick={() =>
          useQuickButtonStore.getState().open({ type: 'save', line: item, forCustomer: false })
        }
      />
    </div>
  );
}

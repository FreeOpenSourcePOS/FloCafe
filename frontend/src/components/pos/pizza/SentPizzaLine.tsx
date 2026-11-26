'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { create } from 'zustand';
import api from '@/lib/api';
import {
  clearOrderItemEditAttempt,
  newOrderItemEditAttempt,
  OrderItemEditAttemptStorageError,
  orderItemEditAttemptStorageKey,
  orderItemEditCanonicalPath,
  persistOrderItemEditAttempt,
  readOrderItemEditAttempt,
  replayOrderItemEditAttempt,
  subscribeOrderItemEditAttemptsChanged,
  withOrderItemEditAttemptLock,
} from '@/lib/order-item-edit-attempt';
import { isOrderItemEditLocked } from '@/lib/order-payment-state';
import { tenantCan } from '@/lib/permissions';
import {
  getPizzaCatalog,
  hasPizzaMenu,
  holdPizzaCatalog,
  loadPizzaCatalog,
} from '@/lib/pizza/catalog';
import { newDeal } from '@/lib/pizza/deal-state';
import { CART_DETAIL_COLUMNS } from '@/lib/pizza/detail-lines';
import { PIZZA_PRODUCT_PREFIX } from '@/lib/pizza/line-recipe';
import {
  DEAL_PRODUCT_PREFIX,
  sentDetailLines,
  sentLine,
  sentLineChangeable,
  sentLineEdit,
  sentLineRepriced,
  sentLineReprices,
  sentPriceGate,
  sheetSentLine,
  sheetSource,
  soldPrices,
  type SentItem,
  type SentLine,
  type SentLineEdit,
} from '@/lib/pizza/sent-line';
import { newSheet, sheetReducer } from '@/lib/pizza/sheet-state';
import type { Order, OrderItem, Product } from '@/lib/types';
import { useAuthStore } from '@/store/auth';
import { RECIPE_NOT_PRINTED } from '@shared/pizza/ticket';
import type { CatalogDeal, PizzaCatalog } from '@shared/pizza/types';
import { PizzaDetailLines } from './PizzaCartLine';
import PizzaDeal from './PizzaDeal';
import PizzaSheet from './PizzaSheet';
import { usePizzaCatalog } from './usePizzaCatalog';

const CHANGE =
  'mt-1 min-h-12 min-w-12 rounded-lg border border-border bg-card px-3 text-sm font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground';

/** How long the sent-line editor waits before it asks for the product prices again. */
const PRICE_RETRY_MS = 3000;

/** The sent item whose sheet or configurator is open, and the one whose button takes the focus when it appears. */
const useSentEdit = create<{ open: number | null; focus: number | null }>(() => ({
  open: null,
  focus: null,
}));

/**
 * Opens the sheet or the configurator on that sent item. The menu is held from
 * here, before anything renders, so no answer on its way changes it under the editor.
 */
export function openSentLine(itemId: number): void {
  holdPizzaCatalog(true);
  useSentEdit.setState({ open: itemId });
}

/** True while a sent line is open in the sheet or the configurator, so the POS page counts a modal. */
export const useSentLineOpen = (): boolean => useSentEdit((state) => state.open !== null);

/** False until the menu request has answered, so a line is not called unreadable while its menu is on the way. */
function useMenuAnswered(): boolean {
  const token = useAuthStore((state) => state.token);
  const [answered, setAnswered] = useState(() => getPizzaCatalog() !== null);
  useEffect(() => {
    let current = true;
    const done = () => {
      if (current) setAnswered(true);
    };
    (token ? loadPizzaCatalog() : Promise.resolve(null)).then(done, done);
    return () => {
      current = false;
    };
  }, [token]);
  return answered;
}

/** The menu a screen fetched itself, and whether its request has answered. */
export interface FetchedPizzaMenu {
  catalog: PizzaCatalog | null;
  answered: boolean;
}

/**
 * The pizza menu for a screen with its own API client and sign-in, which is
 * the Server App: fetched from `/api/pizza/catalog` whenever `userId` changes.
 * No catalogue when the request fails or the menu has no pizzas.
 */
export function useFetchedPizzaMenu(
  client: { get: (url: string) => Promise<{ data: unknown }> } | null,
  userId: string | number | null | undefined,
): FetchedPizzaMenu {
  const [menu, setMenu] = useState<FetchedPizzaMenu>({ catalog: null, answered: false });
  useEffect(() => {
    if (!client || !userId) return;
    let current = true;
    const answer = (catalog: PizzaCatalog | null) => {
      if (current) setMenu({ catalog: hasPizzaMenu(catalog) ? catalog : null, answered: true });
    };
    client.get('/api/pizza/catalog').then(
      (response) => answer(response.data as PizzaCatalog),
      () => answer(null),
    );
    return () => {
      current = false;
      setMenu({ catalog: null, answered: false });
    };
  }, [client, userId]);
  return menu;
}

/**
 * True while an earlier edit of the line has no confirmed answer. Upstream
 * hides its own edit control then, and the Orders page resolves the edit.
 */
function useEditUnresolved(orderId: number | undefined, itemId: number): boolean {
  const tenantId = useAuthStore((state) => state.currentTenant?.id ?? null);
  const actorId = useAuthStore((state) => (state.user ? String(state.user.id) : null));
  const [, changed] = useReducer((count: number) => count + 1, 0);
  const scoped = orderId !== undefined && tenantId !== null && actorId !== null;
  useEffect(
    () =>
      scoped
        ? subscribeOrderItemEditAttemptsChanged({ tenantId, actorId, orderId }, changed)
        : undefined,
    [scoped, tenantId, actorId, orderId],
  );
  if (!scoped) return false;
  try {
    return readOrderItemEditAttempt(tenantId, actorId, orderId, itemId) !== null;
  } catch {
    return true;
  }
}

/**
 * Sends the edit as the Orders page's edit window does: saved under the line
 * before it goes, so an answer that never arrives is resolved from the Orders
 * page with the same key and body. False when someone else signed in meanwhile.
 */
async function sendEdit(orderId: number, itemId: number, body: SentLineEdit): Promise<boolean> {
  const { user, currentTenant } = useAuthStore.getState();
  const actorId = user ? String(user.id) : null;
  const tenantId = currentTenant?.id ?? null;
  if (tenantId === null || !actorId) throw new OrderItemEditAttemptStorageError();
  const key = orderItemEditAttemptStorageKey(tenantId, actorId, orderId, itemId);
  await withOrderItemEditAttemptLock(key, async () => {
    // An earlier edit of this line has no answer yet; the Orders page resolves it.
    if (readOrderItemEditAttempt(tenantId, actorId, orderId, itemId))
      throw new OrderItemEditAttemptStorageError();
    const snapshot = newOrderItemEditAttempt({
      mode: body.replacement ? 'replace' : 'quantity',
      path: orderItemEditCanonicalPath(orderId, itemId),
      orderId,
      itemId,
      body,
      actorId,
      tenantId,
    });
    persistOrderItemEditAttempt(snapshot);
    const result = await replayOrderItemEditAttempt({
      snapshot,
      send: (path, sent, idempotencyKey) =>
        api.patch(path, sent, { headers: { 'Idempotency-Key': idempotencyKey } }),
    });
    if (result.outcome === 'committed' || result.outcome === 'rejected')
      clearOrderItemEditAttempt(tenantId, actorId, orderId, itemId, snapshot.idempotencyKey);
    if (result.outcome !== 'committed') throw result.error;
  });
  const now = useAuthStore.getState();
  return now.currentTenant?.id === tenantId && String(now.user?.id) === actorId;
}

/** The sheet or the configurator on a sent line; Save sends the change to the order. */
function SentLineEditor({
  catalog,
  deal,
  order,
  item,
  onSaved,
  returnFocus,
}: {
  catalog: PizzaCatalog;
  deal: CatalogDeal | undefined;
  order: Order;
  item: OrderItem & SentItem;
  onSaved: (order: Order) => void;
  returnFocus: () => HTMLElement | null;
}) {
  const t = useTranslations('pizza');
  const tOrders = useTranslations('orders');
  const sending = useRef(false);
  const [was] = useState(() => sentLine(item));
  // What a changed size or dip is charged at. A request that fails is sent again while the editor is open.
  const [products, setProducts] = useState<Product[]>();
  const [failures, setFailures] = useState(0);
  useEffect(() => {
    if (deal) return;
    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    api.get('/products?active=1').then(
      (response) => {
        if (current) setProducts(response.data.products || []);
      },
      () => {
        retry = setTimeout(() => current && setFailures((count) => count + 1), PRICE_RETRY_MS);
      },
    );
    return () => {
      current = false;
      clearTimeout(retry);
    };
  }, [deal, failures]);
  const close = () => useSentEdit.setState({ open: null });

  /** Hands the order as it now stands to the screen, and the focus to the line that took this one's place. */
  const refresh = async () => {
    try {
      const { data } = await api.get(`/orders/${order.id}`);
      const fresh = data.order as Order;
      const items = fresh.items ?? [];
      // A changed line is cancelled and the newest item of the order takes its place.
      if (items.find((entry) => entry.id === item.id)?.status !== 'pending')
        useSentEdit.setState({ focus: Math.max(...items.map((entry) => entry.id)) });
      onSaved(fresh);
    } catch {
      // The screen keeps the order it had; its next save is refused as stale and asks again.
    }
  };

  const save = async (now: SentLine) => {
    if (sending.current) return;
    const body = sentLineEdit(item, now);
    if (!body) {
      close();
      return;
    }
    sending.current = true;
    try {
      const sameUser = await sendEdit(order.id, item.id, body);
      close();
      if (!sameUser) return;
      toast.success(tOrders('itemEdited'));
      await refresh();
    } catch (error) {
      const response = (error as { response?: { status?: number; data?: { error?: string } } })
        ?.response;
      toast.error(response?.data?.error || tOrders('editItemFailed'));
      if (response?.status === 409) {
        close();
        await refresh();
      }
    } finally {
      sending.current = false;
    }
  };

  return deal ? (
    <PizzaDeal
      catalog={catalog}
      deal={deal}
      // The configurator changes the deal's choices only, which keeps the price it was sold at.
      product={{ price: soldPrices(item).price }}
      initial={newDeal(deal, was.recipe?.kind === 'deal' ? was.recipe : null)}
      editing
      quantity={was.quantity}
      onSave={(recipe) => void save({ ...was, recipe })}
      onClose={close}
      returnFocus={returnFocus}
    />
  ) : (
    <PizzaSheet
      catalog={catalog}
      products={products}
      online={order.type === 'online' && Boolean(order.online_platform?.trim())}
      soldPrices={(line, state) =>
        sentLineReprices(was, sheetSentLine(was, line, state)) ? null : soldPrices(item)
      }
      refusal={(line, state) => {
        const { blocked, notice } = sentPriceGate({
          reprices: sentLineReprices(was, sheetSentLine(was, line, state)),
          held: products !== undefined,
          failed: failures > 0,
        });
        return notice ? { message: t('sentPricesNotLoaded'), blocks: blocked } : null;
      }}
      initial={sheetReducer(newSheet(), { type: 'load', line: sheetSource(was) })}
      editing
      onSave={(line, state) => void save(sheetSentLine(was, line, state))}
      onClose={close}
      returnFocus={returnFocus}
    />
  );
}

/**
 * What is on a pizza or deal line of an order already placed: its kitchen
 * lines, or the ticket's warning words when they cannot be written out. Given
 * the order, a user who may edit sent items also gets a button that opens the
 * line in the pizza sheet or the deal configurator. Nothing for any other line.
 */
export function SentPizzaLine({
  item,
  order,
  onSaved,
  menu,
  className = '',
}: {
  item: { id: number };
  /** The order the item is on; without it the line is shown and cannot be changed. */
  order?: Order | null;
  /** Called with the order as the server holds it after a change. */
  onSaved?: (order: Order) => void;
  /** The menu of a screen that fetched it itself; without it, the dashboard's. */
  menu?: FetchedPizzaMenu;
  className?: string;
}) {
  const t = useTranslations('pizza');
  const tOrders = useTranslations('orders');
  const held = usePizzaCatalog();
  const heldAnswered = useMenuAnswered();
  const catalog = menu ? menu.catalog : held;
  const answered = menu ? menu.answered : heldAnswered;
  const unresolved = useEditUnresolved(order?.id, item.id);
  const tenant = useAuthStore((state) => state.currentTenant);
  const open = useSentEdit((state) => state.open === item.id);
  const button = useRef<HTMLButtonElement | null>(null);
  const sent = item as OrderItem & SentItem;
  // A line that goes away while it is open must not leave the POS page counting a modal.
  useEffect(
    () => () => {
      if (useSentEdit.getState().open === item.id) useSentEdit.setState({ open: null });
    },
    [item.id],
  );

  // The hold `openSentLine` took ends when this line is no longer the open one, on the Orders page as in the POS.
  useEffect(() => (open ? () => holdPizzaCatalog(false) : undefined), [open]);

  const lines = sentDetailLines(catalog, sent, CART_DETAIL_COLUMNS);
  const unreadable = lines.length === 1 && lines[0] === RECIPE_NOT_PRINTED;
  if (unreadable && !answered) return null;

  const deal = catalog?.deals.find((entry) => DEAL_PRODUCT_PREFIX + entry.id === sent.product_id);
  const pizza = !deal && Boolean(sent.product_id?.startsWith(PIZZA_PRODUCT_PREFIX));
  const editable =
    catalog && order && onSaved && (deal || pizza) && !unreadable && sentLineChangeable(sent)
      ? tenantCan(tenant, 'orders.item.edit') && !isOrderItemEditLocked(order)
      : false;
  // An edit of this line with no answer yet hides the button, except under the sheet that sent it.
  const offered = editable && (open || !unresolved);
  if (lines.length === 0 && !offered) return null;

  return (
    <div data-testid="sent-pizza-line" className={className}>
      {unreadable ? (
        <p
          data-testid="sent-pizza-warning"
          className="flex items-center gap-1 font-mono text-xs font-bold leading-snug text-amber-800 dark:text-amber-300"
        >
          <AlertTriangle size={14} aria-hidden className="shrink-0" />
          {RECIPE_NOT_PRINTED}
        </p>
      ) : (
        <PizzaDetailLines lines={lines} testId="sent-pizza-detail" />
      )}
      {offered && (
        <button
          type="button"
          ref={(element) => {
            button.current = element;
            if (element && useSentEdit.getState().focus === item.id) {
              useSentEdit.setState({ focus: null });
              element.focus();
            }
          }}
          className={CHANGE}
          onClick={() => {
            // Once the kitchen has started an item, upstream allows a change of quantity only.
            if (sent.status !== 'pending') {
              toast.error(tOrders('editPreparationStartedHint'));
              return;
            }
            if (sentLineRepriced(sent)) toast(t('sentPriceReset'), { icon: '⚠️', duration: 8000 });
            openSentLine(item.id);
          }}
        >
          {deal ? t('sentChangeDeal') : t('sentChangePizza')}
        </button>
      )}
      {open && editable && catalog && order && onSaved && (
        <SentLineEditor
          catalog={catalog}
          deal={deal}
          order={order}
          item={sent}
          onSaved={onSaved}
          returnFocus={() => button.current}
        />
      )}
    </div>
  );
}

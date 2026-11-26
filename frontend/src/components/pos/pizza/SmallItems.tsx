'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Minus } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { create } from 'zustand';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import {
  foldsActions,
  popupCategory,
  smallItemRows,
  tileAdd,
  tileCount,
  tileLines,
  tileSoldOut,
  touchedLine,
  type SmallItemRow,
  type SmallItemTile,
} from '@/lib/pizza/small-items';
import type { CartItem, Category, Product } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useCartStore } from '@/store/cart';
import type { PizzaCatalog } from '@shared/pizza/types';
import { PizzaCategoryBlocks } from './PizzaHome';
import { useOnlineOrder } from './useQuickButtons';

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground';
/** The id of the Dips block, which is not a category of the catalogue. */
const DIPS_BLOCK = 'pizza-dips';
const PRODUCT_AREA = '[data-testid="pos-product-grid"]';

interface SmallItemsState {
  /** The popup's rows, worked out where the POS page's product list is. */
  rows: SmallItemRow[];
  /** The category whose block opens the popup, besides the Dips block; null when none does. */
  opens: string | null;
  /** The cart line a tile just added to, until the order changes again. */
  added: string | null;
  /** The cart line last added or changed: its action row stays unfolded. */
  touched: string | null;
}

const useSmallItemsStore = create<SmallItemsState>(() => ({
  rows: [],
  opens: null,
  added: null,
  touched: null,
}));

// Any change to the order ends the "added" mark and moves the unfolded row to the line it changed.
useCartStore.subscribe((cart, before) => {
  if (cart.items === before.items) return;
  const touched = touchedLine(before.items, cart.items);
  useSmallItemsStore.setState((state) => ({
    added: null,
    touched: touched ?? state.touched,
  }));
});

/**
 * Every cart line can hold a folded line's tap target, which covers the line;
 * the line's own buttons stay above it. The row that follows the fold button,
 * "Save as quick button", is folded away with the action row.
 */
const LINE =
  'relative isolate has-[[data-pizza-line-unfold]]:min-h-12 [&>div_button]:relative [&>div_button]:z-10 [&>[data-pizza-line-unfold]+div]:hidden';
const ADDED_LINE = 'bg-emerald-50 dark:bg-emerald-950/40';

/** What the cart panel hooks the popup's mark and the folded rows in with. */
export interface SmallItemsPos {
  /** Classes for a cart line: the tint of the line just added, and room for a folded line's tap target. */
  lineClass: (item: CartItem) => string;
  /** The "added" mark beside the name of the line a tile just added to. */
  lineMark: (item: CartItem) => ReactNode;
}

/** Keeps the popup's rows in step with the menu and the product list, and marks cart lines. */
export function useSmallItems(catalog: PizzaCatalog | null, products: Product[]): SmallItemsPos {
  const t = useTranslations('pizza');
  const added = useSmallItemsStore((state) => state.added);
  const online = useOnlineOrder();
  const rows = useMemo(() => smallItemRows(catalog, products, online), [catalog, products, online]);
  useEffect(
    () => useSmallItemsStore.setState({ rows, opens: popupCategory(rows, products) }),
    [rows, products],
  );
  return {
    lineClass: (item) => cn(LINE, item.id === added && ADDED_LINE),
    lineMark: (item) =>
      item.id === added && (
        <span
          data-testid="pizza-line-added"
          className="ms-1.5 inline-block rounded-full bg-emerald-700 px-1.5 align-middle text-[11px] font-bold leading-4 text-white"
        >
          {t('added')}
        </span>
      ),
  };
}

/** True when a pizza line hides its action row: a long order, and another line was touched last. */
export function usePizzaLineFolded(lineId: string): boolean {
  const touched = useSmallItemsStore((state) => state.touched);
  return foldsActions(
    useCartStore((cart) => cart.items),
    touched,
    lineId,
  );
}

/** A folded pizza line: how many, and one button whose tap target is the whole line. */
export function PizzaLineFold({ item }: { item: CartItem }) {
  const t = useTranslations('pizza');
  return (
    <button
      type="button"
      data-testid="pizza-line-unfold"
      data-pizza-line-unfold
      aria-expanded={false}
      aria-label={t('showLineActions', {
        count: item.quantity,
        name: item.product.name,
      })}
      onClick={(event) => {
        const line = event.currentTarget.parentElement;
        useSmallItemsStore.setState({ touched: item.id });
        // This button is gone once the row shows, so the focus moves on to the row.
        requestAnimationFrame(() =>
          line?.querySelector<HTMLElement>('[data-pizza-line-edit]')?.focus(),
        );
      }}
      className="mt-0.5 flex items-center gap-0.5 text-sm font-bold tabular-nums text-foreground outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:outline-2 focus-visible:after:outline-foreground"
    >
      {t('lineQuantity', { count: item.quantity })}
      <ChevronDown size={14} />
    </button>
  );
}

function Tile({ tile, fmt }: { tile: SmallItemTile; fmt: (amount: number) => string }) {
  const t = useTranslations('pizza');
  const items = useCartStore((cart) => cart.items);
  const justAdded = useSmallItemsStore((state) => state.added === tile.lineId);
  const count = tileCount(items, tile);
  const soldOut = tileSoldOut(tile, count);

  /**
   * After a tap with a pointer the focus goes back to the sheet, so the Enter that
   * ends a barcode scan presses no tile. A key press reports no click count, and
   * leaves the focus where the keyboard user put it.
   */
  const toSheet = (event: MouseEvent<HTMLButtonElement>) =>
    event.detail > 0 && event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus();
  const add = (event: MouseEvent<HTMLButtonElement>) => {
    toSheet(event);
    useCartStore.getState().addItem(...tileAdd(tile));
    useSmallItemsStore.setState({ added: tile.lineId });
  };
  const takeOne = (event: MouseEvent<HTMLButtonElement>) => {
    const line = tileLines(items, tile).at(-1);
    if (!line) return;
    // The minus goes with the last one, so a keyboard's focus moves to the tile's own button.
    if (count === 1) (event.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
    toSheet(event);
    useCartStore.getState().updateQuantity(line.id, line.quantity - 1);
  };

  return (
    <div
      data-testid="small-item-tile"
      className={cn(
        'relative flex min-h-[4.75rem] rounded-xl border bg-card',
        count > 0 ? 'border-brand ring-1 ring-inset ring-brand' : 'border-border',
      )}
    >
      {count > 0 && (
        <button
          type="button"
          aria-label={t('oneFewer', { name: tile.name })}
          onClick={takeOne}
          className={cn(
            'flex w-12 shrink-0 items-center justify-center rounded-s-xl border-e border-brand/40 bg-brand/10 text-brand hover:bg-brand/20 dark:text-indigo-300',
            FOCUS,
          )}
        >
          <Minus size={20} />
        </button>
      )}
      <button
        type="button"
        disabled={soldOut}
        onClick={add}
        className={cn(
          'flex min-w-12 flex-1 flex-col justify-center rounded-xl px-3 text-start hover:bg-muted/60 active:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
          FOCUS,
        )}
      >
        <span className="text-base font-bold leading-tight text-foreground">{tile.name}</span>
        <span className="text-sm tabular-nums text-muted-foreground">
          {soldOut
            ? t('soldOut')
            : justAdded
              ? t('justAdded')
              : count > 0
                ? t('inOrder', { count })
                : fmt(tile.price)}
        </span>
      </button>
      {count > 0 && (
        <span
          data-testid="small-item-count"
          className="pointer-events-none absolute -end-2 -top-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-brand px-1.5 text-xs font-bold tabular-nums text-white"
        >
          {count}
        </span>
      )}
    </div>
  );
}

/**
 * The sheet over the lower part of the product area. It is not modal: the
 * product area behind it is dimmed and switched off, the order stays in use.
 */
function SmallItemsPopup({ rows, onClose }: { rows: SmallItemRow[]; onClose: () => void }) {
  const t = useTranslations('pizza');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const id = useId();
  const [area, setArea] = useState<DOMRect | null>(null);
  // The sheet takes the focus, not a tile: a scanner's Enter must not press one.
  const focusSheet = useCallback((node: HTMLDivElement | null) => node?.focus(), []);

  useEffect(() => {
    const grid = document.querySelector<HTMLElement>(PRODUCT_AREA);
    if (!grid) return;
    const opener = document.activeElement as HTMLElement | null;
    const observer = new ResizeObserver(() => setArea(grid.getBoundingClientRect()));
    observer.observe(grid);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // A window opened from the order is in front, so the POS and its dialogs take Escape
      // first. The POS registers its listener again whenever a window opens, which puts it
      // after this one, so the answer is read once every listener has run.
      setTimeout(() => {
        if (!event.defaultPrevented) onClose();
      });
    };
    window.addEventListener('keydown', onKey);
    grid.inert = true;
    return () => {
      observer.disconnect();
      window.removeEventListener('keydown', onKey);
      grid.inert = false;
      opener?.focus();
    };
  }, [onClose]);

  if (!area) return null;
  return createPortal(
    <>
      <div
        data-testid="small-items-dim"
        aria-hidden
        onClick={onClose}
        className="fixed z-30 rounded-xl bg-black/40"
        style={{
          left: area.left,
          top: area.top,
          width: area.width,
          height: area.height,
        }}
      />
      <div
        ref={focusSheet}
        tabIndex={-1}
        role="dialog"
        aria-label={t('smallItemsTitle')}
        aria-describedby={`${id}-hint`}
        className="fixed z-30 grid gap-3 overflow-y-auto rounded-2xl outline-none border border-border bg-card p-4 shadow-2xl"
        style={{
          left: area.left,
          width: area.width,
          bottom: window.innerHeight - area.bottom,
          maxHeight: area.height,
        }}
      >
        <div className="flex items-center gap-3">
          <h2 className="shrink-0 text-lg font-bold text-foreground">{t('smallItemsTitle')}</h2>
          <p id={`${id}-hint`} className="min-w-0 flex-1 text-sm text-muted-foreground">
            {t('smallItemsHint')}
          </p>
          <button
            type="button"
            onClick={onClose}
            className={cn(
              'min-h-12 shrink-0 rounded-lg bg-brand px-6 text-base font-bold text-white hover:bg-brand-hover',
              FOCUS,
            )}
          >
            {tCommon('done')}
          </button>
        </div>
        {rows.map((row) => (
          <div
            key={row.id}
            role="group"
            aria-labelledby={`${id}-${row.id}`}
            className="grid grid-cols-[5rem_1fr] items-center gap-3"
          >
            <p id={`${id}-${row.id}`} className="text-sm font-bold leading-tight text-foreground">
              {row.label ?? t('dips')}
              {row.price !== null && (
                <span className="block font-normal tabular-nums text-muted-foreground">
                  {fmt(row.price)}
                </span>
              )}
            </p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
              {row.tiles.map((tile) => (
                <Tile key={tile.lineId} tile={tile} fmt={fmt} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>,
    document.body,
  );
}

/**
 * The pizza home's category blocks with the popup on them: a Dips block after
 * the category the dip is sold under, and the drinks' own block, both opening
 * the popup. With no dips and no drinks these are the plain blocks.
 */
export function SmallItemBlocks(props: Parameters<typeof PizzaCategoryBlocks>[0]) {
  const t = useTranslations('pizza');
  const rows = useSmallItemsStore((state) => state.rows);
  const [opener, setOpener] = useState<string | null>(null);
  const close = useCallback(() => setOpener(null), []);
  // A category chosen while the popup is open, such as the Quick Buttons page, closes it.
  const [chosen, setChosen] = useState(props.selectedCategory);
  if (chosen !== props.selectedCategory) {
    setChosen(props.selectedCategory);
    setOpener(null);
  }
  const dips = rows.find((row) => row.kind === 'dips');
  const opens = useSmallItemsStore((state) => state.opens);
  // Rows that went away take the popup with them for good, not until they come back.
  if (opener !== null && rows.length === 0) setOpener(null);

  let categories = props.categories;
  if (dips) {
    const sold = categories.findIndex((category) => category.id === dips.categoryId);
    const at = sold < 0 ? categories.length : sold + 1;
    const block = {
      id: DIPS_BLOCK,
      name: t('dips'),
      color: 'teal',
    } as Category;
    categories = [...categories.slice(0, at), block, ...categories.slice(at)];
  }
  const open = opener !== null && rows.length > 0;
  return (
    <>
      <PizzaCategoryBlocks
        {...props}
        categories={categories}
        selectedCategory={open ? opener : props.selectedCategory}
        setSelectedCategory={(id) =>
          id !== null && (id === DIPS_BLOCK || id === opens)
            ? setOpener(id)
            : props.setSelectedCategory(id)
        }
      />
      {open && <SmallItemsPopup rows={rows} onClose={close} />}
    </>
  );
}

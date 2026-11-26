'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Ban, Check, MoreHorizontal, Plus, Star, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { CATEGORY_COLORS, getCategoryColorClasses } from '@/components/pos/ProductGrid';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import {
  buttonContents,
  buttonLine,
  buttonName,
  buttonPrice,
  buttonRefusal,
  buttonSheetLine,
  buttonSummary,
  deleteQuickButton,
  isPizzaButton,
  refusalMessage,
  saveQuickButton,
  updateQuickButton,
  type ButtonLine,
} from '@/lib/pizza/quick-buttons';
import type { CartItem, Product } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useCartStore } from '@/store/cart';
import type { QuickButton } from '@shared/pizza/types';
import { PizzaLineDetails } from './PizzaCartLine';
import {
  QUICK_BUTTONS_CATEGORY,
  useOnlineOrder,
  useQuickButtonRights,
  useQuickButtonStore,
  type QuickButtonDialog,
} from './useQuickButtons';

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground';
const HEADING = 'text-xs font-semibold uppercase tracking-wider text-muted-foreground';
const GRID = 'grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]';
/** The colours a button can have: the names the POS gives categories, which the route checks. */
const COLORS = Object.keys(CATEGORY_COLORS);
/** Where the pizza grid shows, and a customer's favourites sit above it. */
const HOME_CATEGORIES: (string | null)[] = [null, 'cat-pizzas'];
/** The category block that is open, which takes the focus when a dialog's opener is gone. */
const OPEN_BLOCK = '[data-testid="pizza-category-blocks"] [aria-pressed="true"]';

type EditItem = (line: CartItem) => void;

/** A tile's frame: the button's colour, or grey for one that cannot be added. */
function tileClass(color: string, usable: boolean): string {
  const classes = getCategoryColorClasses(color);
  return cn(
    'relative flex min-h-28 rounded-xl border border-s-4',
    usable && classes ? `${classes.bg} ${classes.border}` : 'border-border bg-muted',
  );
}

/** What a tile says: the label, then what the button holds and costs, or why it cannot be added. */
function Face({
  label,
  color,
  line,
  reason,
}: {
  label: string;
  color: string;
  line: ButtonLine | null;
  reason: string;
}) {
  const fmt = useFormatCurrency();
  const online = useOnlineOrder();
  return (
    <>
      <span className="break-words text-sm font-bold leading-tight text-foreground">{label}</span>
      {line ? (
        <>
          <span className="line-clamp-2 break-words text-xs leading-snug text-foreground">
            {buttonSummary(line)}
          </span>
          <span
            className={cn(
              'mt-auto text-sm font-bold tabular-nums',
              getCategoryColorClasses(color)?.text,
            )}
          >
            {fmt(buttonPrice(line, online))}
          </span>
        </>
      ) : (
        <span className="flex gap-1 text-xs font-semibold leading-snug text-foreground">
          <Ban size={14} className="mt-0.5 shrink-0" />
          {reason}
        </span>
      )}
    </>
  );
}

/** The `⋯` menu of a button. Its entries act once the menu has closed and `⋯` has the focus again. */
function TileMenu({ button, onEditItem }: { button: QuickButton; onEditItem: EditItem }) {
  const t = useTranslations('pizza');
  const open = useQuickButtonStore((state) => state.open);
  const trigger = useRef<HTMLButtonElement>(null);
  const picked = useRef<(() => void) | null>(null);
  const entry = 'min-h-12 px-3 text-base';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        ref={trigger}
        aria-label={t('quickMenu', { label: button.label })}
        className={cn(
          'absolute end-0 top-0 flex h-12 w-12 items-center justify-center rounded-xl text-foreground hover:bg-black/5 dark:hover:bg-white/10',
          FOCUS,
        )}
      >
        <MoreHorizontal size={20} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          const run = picked.current;
          picked.current = null;
          if (!run) return;
          // The dialog that opens next hands the focus back to whatever has it now.
          event.preventDefault();
          trigger.current?.focus();
          run();
        }}
      >
        <DropdownMenuItem
          className={entry}
          onSelect={() => {
            picked.current = () => open({ type: 'edit', button });
          }}
        >
          {t('quickEditLabel')}
        </DropdownMenuItem>
        {isPizzaButton(button) && (
          <DropdownMenuItem
            className={entry}
            onSelect={() => {
              picked.current = () => onEditItem(buttonSheetLine(button));
            }}
          >
            {t('quickEditItem')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          variant="destructive"
          className={entry}
          onSelect={() => {
            picked.current = () => open({ type: 'delete', button });
          }}
        >
          {t('quickDelete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One button: a tap adds what it holds to the order, `⋯` changes or deletes it. */
function Tile({
  button,
  products,
  onEditItem,
  className,
}: {
  button: QuickButton;
  products: Product[];
  onEditItem: EditItem;
  className?: string;
}) {
  const t = useTranslations('pizza');
  const rights = useQuickButtonRights();
  const line = buttonLine(button, products);
  return (
    <div
      data-testid="quick-button"
      data-color={button.color}
      data-usable={line !== null}
      className={cn(tileClass(button.color, line !== null), className)}
    >
      <button
        type="button"
        data-testid="quick-button-add"
        // Not `disabled`: the reason must stay reachable with the keyboard.
        aria-disabled={!line}
        onClick={() =>
          line &&
          useCartStore
            .getState()
            .addItem(
              line.product,
              1,
              line.addons,
              line.special_instructions,
              line.variant ?? null,
              line.recipe,
            )
        }
        className={cn(
          'flex min-w-0 flex-1 flex-col items-start gap-1 rounded-xl p-2.5 pe-12 text-start aria-disabled:cursor-not-allowed',
          FOCUS,
        )}
      >
        <Face
          label={button.label}
          color={button.color}
          line={line}
          reason={buttonRefusal(button, products, {
            soldOut: t('quickSoldOut'),
            notOnPos: t('quickNotOnPos'),
          })}
        />
      </button>
      {(button.customer_id === null ? rights.shop : rights.customers) && (
        <TileMenu button={button} onEditItem={onEditItem} />
      )}
    </div>
  );
}

/** The shop's buttons or a customer's, under a heading; `row` keeps them on one line. */
function Section({
  title,
  hint,
  starred = false,
  row = false,
  buttons,
  products,
  onEditItem,
  children,
}: {
  title: string;
  hint?: ReactNode;
  starred?: boolean;
  row?: boolean;
  buttons: QuickButton[];
  products: Product[];
  onEditItem: EditItem;
  children?: ReactNode;
}) {
  return (
    <section
      role="group"
      aria-label={title}
      data-testid={row ? 'quick-favourites' : undefined}
      className={row ? 'mb-3' : undefined}
    >
      <p className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <span className="flex items-center gap-1 text-base font-bold text-foreground">
          {starred && <Star size={16} fill="currentColor" />}
          {title}
        </span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </p>
      <div className={row ? 'flex gap-2 overflow-x-auto p-0.5' : cn('grid gap-2', GRID)}>
        {buttons.map((button) => (
          <Tile
            key={button.id}
            button={button}
            products={products}
            onEditItem={onEditItem}
            className={row ? 'w-52 shrink-0' : undefined}
          />
        ))}
        {children}
      </div>
    </section>
  );
}

/** The save dialog, the label and colour dialog, and the delete confirm. Mounted while one is open. */
function QuickButtonDialogs({
  dialog,
  products,
}: {
  dialog: QuickButtonDialog;
  products: Product[];
}) {
  const t = useTranslations('pizza');
  const tCommon = useTranslations('common');
  const tProducts = useTranslations('products');
  const fmt = useFormatCurrency();
  const online = useOnlineOrder();
  const labelId = useId();
  const { open, load } = useQuickButtonStore();
  const rights = useQuickButtonRights();
  const items = useCartStore((state) => state.items);
  // The dialog has no trigger of its own, so it hands the focus back to whatever opened it.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const [lineId, setLineId] = useState(() => items.at(-1)?.id ?? '');
  const line =
    dialog.type === 'save'
      ? (dialog.line ?? items.find((item) => item.id === lineId) ?? null)
      : buttonLine(dialog.button, products);
  const saved = dialog.type === 'save' ? null : dialog.button;
  const [label, setLabel] = useState(() => saved?.label ?? (line?.product.name ?? '').slice(0, 24));
  const [color, setColor] = useState(saved?.color ?? COLORS[0]);
  const scopes = [
    ...(rights.shop ? (['shop'] as const) : []),
    ...(rights.customer ? (['customer'] as const) : []),
  ];
  const [scope, setScope] = useState(
    dialog.type === 'save' && dialog.forCustomer && rights.customer ? 'customer' : scopes[0],
  );
  const [busy, setBusy] = useState(false);
  const close = () => open(null);
  const colourName = (name: string) =>
    tProducts(`color${name[0].toUpperCase()}${name.slice(1)}` as 'colorRed');

  const send = async (request: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await request();
      await load();
      close();
    } catch (error) {
      toast.error(refusalMessage(error, t('quickFailed')));
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (dialog.type === 'delete') void send(() => deleteQuickButton(dialog.button.id));
    else if (dialog.type === 'edit')
      void send(() => updateQuickButton(dialog.button.id, { label, color }));
    else if (line && scope) {
      // A button meant for a customer is never saved for the shop because the customer left the order.
      const customerId = scope === 'customer' ? rights.customer?.id : null;
      if (customerId === undefined) toast.error(t('quickNoCustomer'));
      else
        void send(() =>
          saveQuickButton({
            label,
            color,
            ...buttonContents(line),
            ...(customerId === null ? {} : { customer_id: String(customerId) }),
          }),
        );
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          (opener?.isConnected ? opener : document.querySelector<HTMLElement>(OPEN_BLOCK))?.focus();
        }}
        className="max-h-[calc(100dvh-1.5rem)] gap-0 overflow-y-auto p-0 sm:max-w-[640px]"
      >
        <form onSubmit={submit}>
          <header className="flex items-center gap-3 border-b border-border px-4 py-3">
            <DialogTitle className="text-xl">
              {dialog.type === 'save'
                ? t('quickSaveAs')
                : dialog.type === 'edit'
                  ? t('quickEditLabel')
                  : t('quickDeleteTitle', { label: dialog.button.label })}
            </DialogTitle>
            <DialogClose
              type="button"
              aria-label={tCommon('close')}
              className={cn(
                'ms-auto flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-border text-foreground hover:bg-muted',
                FOCUS,
              )}
            >
              <X size={20} />
            </DialogClose>
          </header>

          {dialog.type === 'delete' ? (
            <p className="p-4 text-sm text-foreground">{t('quickDeleteBody')}</p>
          ) : (
            <div className="space-y-4 p-4">
              {dialog.type === 'save' && !dialog.line && (
                <label className="block">
                  <span className={cn(HEADING, 'mb-1 block')}>{t('quickFromOrder')}</span>
                  <select
                    value={lineId}
                    onChange={(event) => setLineId(event.target.value)}
                    className="min-h-12 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
                  >
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {buttonSummary(item)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="grid grid-cols-2 gap-3">
                {dialog.type === 'save' && (
                  <div data-testid="quick-button-adds" className="rounded-xl bg-muted p-3">
                    <p className={cn(HEADING, 'mb-1')}>{t('quickAdds')}</p>
                    {line && (
                      <>
                        <p className="text-sm font-bold text-foreground">{buttonName(line)}</p>
                        <PizzaLineDetails item={{ ...line, id: '', quantity: 1 }} />
                        {(line.addons.length > 0 || line.special_instructions) && (
                          <p className="break-words text-xs text-foreground">
                            {[
                              ...line.addons.map(
                                (addon) =>
                                  `+ ${addon.name}${(addon.quantity || 1) > 1 ? ` ×${addon.quantity}` : ''}`,
                              ),
                              ...(line.special_instructions ? [line.special_instructions] : []),
                            ].join(' · ')}
                          </p>
                        )}
                        <p className="mt-1 text-sm font-bold tabular-nums text-foreground">
                          {fmt(buttonPrice(line, online))}
                        </p>
                      </>
                    )}
                  </div>
                )}
                <div>
                  <p className={cn(HEADING, 'mb-1')}>{t('quickPreview')}</p>
                  <div className={tileClass(color, line !== null)}>
                    <div className="flex min-w-0 flex-1 flex-col gap-1 p-2.5">
                      <Face
                        label={label}
                        color={color}
                        line={line}
                        reason={
                          saved
                            ? buttonRefusal(saved, products, {
                                soldOut: t('quickSoldOut'),
                                notOnPos: t('quickNotOnPos'),
                              })
                            : t('quickNotOnPos')
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <label htmlFor={labelId} className={HEADING}>
                    {t('quickLabel')}
                  </label>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {t('quickLabelCount', { count: label.length })}
                  </span>
                </div>
                <input
                  id={labelId}
                  type="text"
                  autoFocus
                  value={label}
                  maxLength={24}
                  onChange={(event) => setLabel(event.target.value)}
                  className="min-h-12 w-full rounded-lg border border-border bg-background px-3 text-base font-semibold text-foreground outline-none focus:ring-2 focus:ring-brand"
                />
              </div>

              <div>
                <p className={cn(HEADING, 'mb-1')}>{t('quickColour')}</p>
                <div role="group" aria-label={t('quickColour')} className="flex flex-wrap gap-1.5">
                  {COLORS.map((name) => {
                    const chosen = name === color;
                    return (
                      <button
                        key={name}
                        type="button"
                        aria-label={colourName(name)}
                        aria-pressed={chosen}
                        onClick={() => setColor(name)}
                        className={cn(
                          'flex min-h-12 w-14 flex-col items-center gap-1 rounded-lg p-1 text-[11px] leading-tight text-foreground',
                          FOCUS,
                          chosen && 'font-bold',
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-9 w-9 items-center justify-center rounded-lg text-black',
                            getCategoryColorClasses(name)?.activeBg,
                            chosen && 'ring-2 ring-foreground ring-offset-2 ring-offset-background',
                          )}
                        >
                          {chosen && <Check size={20} strokeWidth={3} />}
                        </span>
                        {colourName(name)}
                      </button>
                    );
                  })}
                </div>
              </div>

              {dialog.type === 'save' && (
                <div>
                  <p className={cn(HEADING, 'mb-1')}>{t('quickShowFor')}</p>
                  <div
                    role="group"
                    aria-label={t('quickShowFor')}
                    className="flex gap-1 rounded-xl bg-muted p-1"
                  >
                    {scopes.map((entry) => (
                      <button
                        key={entry}
                        type="button"
                        aria-pressed={entry === scope}
                        onClick={() => setScope(entry)}
                        className={cn(
                          'flex min-h-12 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold',
                          FOCUS,
                          entry === scope
                            ? 'bg-card text-brand shadow-sm ring-2 ring-inset ring-brand dark:text-indigo-300'
                            : 'text-foreground hover:bg-card/60',
                        )}
                      >
                        {entry === scope && <Check size={16} className="shrink-0" />}
                        {entry === 'shop'
                          ? t('quickForShop')
                          : t('quickForCustomer', { name: rights.customer?.name ?? '' })}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <footer className="flex justify-end gap-3 border-t border-border px-4 py-3">
            <Button type="button" variant="outline" className="h-12 px-6 text-base" onClick={close}>
              {tCommon('cancel')}
            </Button>
            <Button
              type="submit"
              variant={dialog.type === 'delete' ? 'destructive' : 'default'}
              disabled={busy || (dialog.type !== 'delete' && !label.trim())}
              className={cn(
                'h-12 px-6 text-base font-bold',
                dialog.type !== 'delete' && 'bg-brand text-white hover:bg-brand-hover',
              )}
            >
              {dialog.type === 'save'
                ? t('quickSaveButton')
                : dialog.type === 'edit'
                  ? tCommon('save')
                  : t('quickDelete')}
            </Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What the product grid shows above its tiles: the quick buttons page while
 * its block is open, else the favourites of the order's customer above the
 * pizzas. It also lists the buttons and mounts the open dialog.
 */
export function QuickButtonsArea({
  category,
  products,
  onEditItem,
}: {
  category: string | null;
  products: Product[];
  onEditItem: EditItem;
}) {
  const t = useTranslations('pizza');
  const { buttons, dialog, open, load } = useQuickButtonStore();
  const rights = useQuickButtonRights();
  const customer = useCartStore((state) => state.customer);
  const customerId = customer?.id ?? null;
  // The route refuses a customer's list to someone who may not keep their buttons.
  const listedFor = rights.customers ? customerId : null;
  useEffect(() => {
    void load(listedFor);
  }, [load, listedFor]);

  // Until the list for a new customer arrives, the last customer's buttons must not show.
  const theirs = buttons.filter(
    (button) => button.customer_id !== null && button.customer_id === String(customerId),
  );
  const section = { products, onEditItem };
  const favourites = customer && {
    ...section,
    title: t('quickFavourites', { name: customer.name }),
    hint: customer.phone && <Ltr>{customer.phone}</Ltr>,
    starred: true,
    buttons: theirs,
  };

  return (
    <>
      {category === QUICK_BUTTONS_CATEGORY ? (
        <div data-testid="quick-buttons-page" className="space-y-4 pb-3">
          {favourites && (rights.customers || theirs.length > 0) && (
            <Section {...favourites}>
              {rights.customers && (
                <button
                  type="button"
                  onClick={() =>
                    useCartStore.getState().items.length > 0
                      ? open({ type: 'save', line: null, forCustomer: true })
                      : toast.error(t('quickOrderEmpty'))
                  }
                  className={cn(
                    'flex min-h-28 items-center justify-center gap-1 rounded-xl border-2 border-dashed border-border px-3 text-center text-sm font-semibold text-foreground hover:bg-muted',
                    FOCUS,
                  )}
                >
                  <Plus size={16} className="shrink-0" />
                  {t('quickSaveFromOrder', { name: customer?.name ?? '' })}
                </button>
              )}
            </Section>
          )}
          <Section
            {...section}
            title={t('quickShop')}
            hint={rights.shop && t('quickShopHint')}
            buttons={buttons.filter((button) => button.customer_id === null)}
          >
            {buttons.every((button) => button.customer_id !== null) && (
              <p className="col-span-full text-sm text-muted-foreground">{t('quickNone')}</p>
            )}
          </Section>
        </div>
      ) : (
        favourites &&
        theirs.length > 0 &&
        HOME_CATEGORIES.includes(category) && <Section {...favourites} row />
      )}
      {dialog && <QuickButtonDialogs dialog={dialog} products={products} />}
    </>
  );
}

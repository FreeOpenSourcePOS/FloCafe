'use client';

import { useId, useReducer, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Tabs as TabsPrimitive } from 'radix-ui';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Tabs } from '@/components/ui/tabs';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { dealLine, dealReducer, type DealState, type DealTab } from '@/lib/pizza/deal-state';
import type { SheetAction } from '@/lib/pizza/sheet-state';
import { cn } from '@/lib/utils';
import { dealPickCount } from '@shared/pizza/recipe';
import type { CatalogDeal, DealRecipe, PizzaCatalog } from '@shared/pizza/types';
import {
  CookAndCut,
  FOCUS,
  HEADING,
  PizzaHalves,
  PizzaStepper,
  Segmented,
  WholeOrHalf,
} from './PizzaSheet';

const MISSING =
  'border-dashed border-amber-700 bg-amber-50 text-amber-900 dark:border-amber-500 dark:bg-amber-950/30 dark:text-amber-200';
const CHOICE =
  'flex min-h-12 min-w-12 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-semibold transition-colors';
const CHOSEN = 'border-brand bg-brand text-white';
const NOT_CHOSEN = 'border-border bg-card text-foreground hover:border-brand/40';

/** One of a few buttons of which one is chosen; the chosen one is pressed and ticked. */
function Choice({
  chosen,
  onClick,
  children,
}: {
  chosen: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={chosen}
      onClick={onClick}
      className={cn(CHOICE, FOCUS, chosen ? CHOSEN : NOT_CHOSEN)}
    >
      {chosen && <Check size={16} aria-hidden />}
      {children}
    </button>
  );
}

/**
 * The deal configurator: a tab for each choice the deal asks for, the pizza
 * sheet's editor on each pizza tab, and what the deal prints as beside them.
 * Its state is `dealReducer`'s; `dealLine` says what is missing and gives the
 * recipe once nothing is.
 */
export default function PizzaDeal({
  catalog,
  deal,
  initial,
  editing,
  quantity,
  onSave,
  onClose,
  returnFocus,
}: {
  catalog: PizzaCatalog;
  deal: CatalogDeal;
  initial: DealState;
  /** True when the configurator changes a line already in the cart. */
  editing: boolean;
  /** How many of the deal the line holds; the price on the button is for all of them. */
  quantity: number;
  onSave: (recipe: DealRecipe) => void;
  onClose: () => void;
  /** Where the focus goes on close when the control that opened the dialog is gone. */
  returnFocus: () => HTMLElement | null;
}) {
  const t = useTranslations('pizza');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  // The menu load takes only currencies counted in hundredths.
  const money = (cents: number) => fmt(cents / 100);
  const [state, dispatch] = useReducer(dealReducer, initial);
  // The dialog has no trigger of its own, so it hands the focus back to whatever opened it.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const tabList = useRef<HTMLDivElement>(null);
  const messageId = useId();

  const line = dealLine(catalog, state);
  const { choice } = dealPickCount(deal);
  const cans = line.cans ?? { asked: 0, chosen: 0 };
  const missing = line.tabs.flatMap((tab, index) => (tab.done ? [] : [index]));
  const open = line.tabs[state.tab];
  const total = money(deal.priceCents * quantity);
  const flavours = catalog.sides.find((side) => side.id === 'wings')?.modifier?.options ?? [];

  // Pizza tabs come first, so a pizza's place among the tabs is its number in the deal.
  const nameOf = (tab: DealTab, index: number) =>
    tab.kind === 'pizza'
      ? t('dealPizza', { number: index + 1 })
      : tab.kind === 'wings'
        ? t('dealWings')
        : choice
          ? t('dealDrinks')
          : t('dealPops');
  const hintOf = (tab: DealTab) =>
    tab.kind === 'pizza'
      ? t('dealChoosePizza')
      : tab.kind === 'wings'
        ? t('dealChooseFlavour')
        : t(choice ? 'dealChooseDrinks' : 'dealChoosePops', { count: cans.asked });
  /** What the ticket puts in front of that choice, which is not menu text. */
  const ticketLabel = (tab: DealTab, index: number) =>
    tab.kind === 'pizza' ? `${index + 1})` : tab.kind === 'wings' ? 'WINGS:' : 'POP:';

  const focusTab = (tab: number) =>
    tabList.current?.querySelectorAll<HTMLElement>('[role="tab"]')[tab]?.focus();
  /** Opens a tab from outside the tab row and takes the focus there. */
  const go = (tab: number) => {
    dispatch({ type: 'tab', tab });
    focusTab(tab);
  };

  let panel: ReactNode = null;
  if (open?.kind === 'pizza') {
    const sheet = state.pizzas[state.tab];
    const send = (action: SheetAction) => dispatch({ type: 'pizza', index: state.tab, action });
    const size = catalog.sizes.find((entry) => entry.id === sheet.sizeId)?.label ?? sheet.sizeId;
    panel = (
      <>
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full bg-muted px-3 py-1.5 text-sm font-semibold text-foreground">
            {t('dealSizeSet', { size: size ?? '' })}
          </span>
          <WholeOrHalf state={sheet} dispatch={send} />
        </div>
        <div className="grid grid-cols-2 items-start gap-3">
          <PizzaHalves catalog={catalog} state={sheet} dispatch={send} />
          <CookAndCut state={sheet} dispatch={send} />
        </div>
      </>
    );
  } else if (open?.kind === 'wings') {
    panel = (
      <div role="group" aria-label={t('dealWings')} className="max-w-md space-y-2">
        <p className={HEADING}>{t('dealWingsHint')}</p>
        <div className="grid grid-cols-2 gap-2">
          {flavours.map((flavour) => (
            <Choice
              key={flavour.id}
              chosen={flavour.id === state.wingFlavour}
              onClick={() => dispatch({ type: 'wings', flavourId: flavour.id })}
            >
              {flavour.label}
            </Choice>
          ))}
        </div>
      </div>
    );
  } else if (open?.kind === 'drinks') {
    panel = (
      <div className="max-w-md space-y-3">
        {choice && (
          <>
            <Segmented
              label={t('dealDrinkChoice')}
              value={state.bottle ? 'bottle' : 'cans'}
              options={[
                { id: 'cans', label: t('dealCans', { count: cans.asked }) },
                { id: 'bottle', label: t('dealOneBottle') },
              ]}
              onChange={(id) => dispatch({ type: 'bottle', bottle: id === 'bottle' })}
            />
            <p className="text-sm text-muted-foreground">{t('dealDrinkChoiceHint')}</p>
          </>
        )}
        {state.bottle ? (
          <div role="group" aria-label={t('dealBottleHeading')} className="grid gap-2">
            <p className={HEADING}>{t('dealBottleHeading')}</p>
            {catalog.drinks.map((drink) => (
              <Choice
                key={drink.id}
                chosen={drink.id === state.twoLitre}
                onClick={() => dispatch({ type: 'twoLitre', drinkId: drink.id })}
              >
                {t('dealBottle', { name: drink.label })}
              </Choice>
            ))}
          </div>
        ) : (
          <div
            role="group"
            aria-label={t('dealCansHeading', { count: cans.asked })}
            className="space-y-2"
          >
            <p className="flex items-center justify-between gap-2">
              <span className={HEADING}>{t('dealCansHeading', { count: cans.asked })}</span>
              <span
                data-testid="deal-cans-count"
                className={cn(
                  'flex items-center gap-1 rounded-full border px-3 py-1 text-sm font-semibold',
                  open.done ? 'border-border text-foreground' : MISSING,
                )}
              >
                {open.done && <Check size={14} aria-hidden />}
                {t('dealCansCount', { ...cans, more: cans.asked - cans.chosen })}
              </span>
            </p>
            {catalog.drinks.map((drink) => {
              const count = state.pops[drink.id] ?? 0;
              return (
                <div key={drink.id} className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">{drink.label}</span>
                  <PizzaStepper
                    name={drink.label}
                    value={count}
                    least={0}
                    most={count + cans.asked - cans.chosen}
                    onChange={(next) => dispatch({ type: 'pop', drinkId: drink.id, count: next })}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        // A stray tap beside the dialog must not throw the deal away.
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusTab(state.tab);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          (opener?.isConnected ? opener : returnFocus())?.focus();
        }}
        className="flex max-h-[calc(100dvh-1.5rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1100px]"
      >
        <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <DialogTitle className="text-xl">{deal.name}</DialogTitle>
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">{deal.description}</p>
          <p
            data-testid="deal-price"
            className="rounded-full border border-border px-3 py-1 text-sm text-foreground"
          >
            {t('dealFixedPrice')} <b className="text-base tabular-nums">{money(deal.priceCents)}</b>
          </p>
          <p
            data-testid="deal-chosen"
            className={cn(
              'rounded-full border px-3 py-1 text-sm font-semibold',
              missing.length > 0 ? MISSING : 'border-border text-foreground',
            )}
          >
            {t('dealChosen', {
              chosen: line.tabs.length - missing.length,
              total: line.tabs.length,
            })}
          </p>
          <DialogClose
            aria-label={tCommon('close')}
            className={cn(
              'flex h-12 w-12 items-center justify-center rounded-lg border border-border text-foreground hover:bg-muted',
              FOCUS,
            )}
          >
            <X size={20} />
          </DialogClose>
        </header>

        <Tabs
          value={String(state.tab)}
          onValueChange={(tab) => dispatch({ type: 'tab', tab: Number(tab) })}
          className="min-h-0 flex-1 gap-0"
        >
          <TabsPrimitive.List
            ref={tabList}
            aria-label={t('dealChoices')}
            className="flex gap-2 border-b border-border px-4 pt-2"
          >
            {line.tabs.map((tab, index) => (
              <TabsPrimitive.Trigger
                key={tab.id}
                value={String(index)}
                className={cn(
                  'flex min-h-14 max-w-64 min-w-0 flex-1 items-center gap-2 rounded-t-xl border border-b-0 px-2.5 text-start',
                  FOCUS,
                  tab.done ? 'border-border bg-muted text-foreground' : MISSING,
                  // The open tab is the one with the heavy top edge, joined to the panel below it.
                  'data-[state=active]:border-t-4 data-[state=active]:border-solid data-[state=active]:border-brand data-[state=active]:bg-background',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white',
                    tab.done ? 'bg-green-700' : 'bg-amber-700',
                  )}
                >
                  {tab.done ? <Check size={14} /> : '!'}
                </span>
                <span className="min-w-0 leading-tight">
                  <span className="block truncate text-sm font-bold">{nameOf(tab, index)}</span>
                  <span className={cn('block text-xs font-semibold', tab.done && 'truncate')}>
                    {tab.summary ?? hintOf(tab)}
                  </span>
                </span>
              </TabsPrimitive.Trigger>
            ))}
          </TabsPrimitive.List>

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_20rem] grid-rows-[minmax(0,1fr)] gap-3 px-4 py-3">
            <div className="flex min-h-0 flex-col gap-3">
              <TabsPrimitive.Content
                key={state.tab}
                value={String(state.tab)}
                className="min-h-0 flex-1 space-y-3 overflow-y-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground"
              >
                {panel}
              </TabsPrimitive.Content>
              {/* Outside the panel, so Back and Next stay in view while a long pizza scrolls. */}
              <div className="flex shrink-0 items-center gap-3">
                {state.tab > 0 && (
                  <button
                    type="button"
                    onClick={() => go(state.tab - 1)}
                    aria-label={t('dealBack', {
                      name: nameOf(line.tabs[state.tab - 1], state.tab - 1),
                    })}
                    className={cn(CHOICE, FOCUS, NOT_CHOSEN)}
                  >
                    <ChevronLeft size={16} className="rtl-flip" aria-hidden />
                    {nameOf(line.tabs[state.tab - 1], state.tab - 1)}
                  </button>
                )}
                <p className="min-w-0 flex-1 text-sm font-semibold text-red-700 dark:text-red-300">
                  {open?.message}
                </p>
                {state.tab < line.tabs.length - 1 && (
                  <Button
                    onClick={() => go(state.tab + 1)}
                    className="h-12 bg-brand px-5 text-base font-bold text-white hover:bg-brand-hover"
                  >
                    {t('dealNext', { name: nameOf(line.tabs[state.tab + 1], state.tab + 1) })}
                    <ChevronRight size={16} className="rtl-flip" aria-hidden />
                  </Button>
                )}
              </div>
            </div>

            <aside className="flex min-h-0 flex-col gap-3">
              <div
                role="group"
                aria-label={t('dealSummary')}
                tabIndex={0}
                className={cn(
                  'min-h-24 overflow-y-auto rounded-xl border border-border p-3',
                  FOCUS,
                )}
              >
                <p className={cn(HEADING, 'mb-2')}>{t('dealSummary')}</p>
                <div className="font-mono text-xs font-semibold leading-snug text-foreground">
                  <div data-testid="deal-summary-line" className="whitespace-pre">
                    {line.heading}
                  </div>
                  {line.tabs.map((tab, index) =>
                    tab.done ? (
                      tab.lines.map((text, at) => (
                        <div
                          key={`${tab.id}-${at}`}
                          data-testid="deal-summary-line"
                          className={cn(
                            'whitespace-pre',
                            text.trimStart().startsWith('NO ') && 'text-red-700 dark:text-red-300',
                          )}
                        >
                          {text}
                        </div>
                      ))
                    ) : (
                      <div
                        key={tab.id}
                        data-testid="deal-summary-line"
                        className="text-amber-800 italic dark:text-amber-300"
                      >
                        {ticketLabel(tab, index)} {hintOf(tab)}
                      </div>
                    ),
                  )}
                </div>
              </div>

              {missing.length > 0 && (
                <div
                  data-testid="deal-missing"
                  role="group"
                  aria-label={t('dealMissing', { count: missing.length })}
                  className={cn('shrink-0 rounded-xl border p-3', MISSING)}
                >
                  <p className="mb-2 text-sm font-bold">
                    {t('dealMissing', { count: missing.length })}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {missing.map((index) => (
                      <button
                        key={line.tabs[index].id}
                        type="button"
                        onClick={() => go(index)}
                        className={cn(
                          'min-h-12 min-w-12 rounded-lg border border-current bg-card px-3 text-sm font-semibold',
                          FOCUS,
                        )}
                      >
                        {nameOf(line.tabs[index], index)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-auto shrink-0 space-y-2">
                <p className="flex items-baseline justify-between text-base font-bold text-foreground">
                  <span>{t('dealPrice')}</span>
                  <span className="tabular-nums">{money(deal.priceCents)}</span>
                </p>
                <p
                  id={messageId}
                  role="status"
                  data-testid="deal-message"
                  className="text-sm font-semibold text-red-700 dark:text-red-300"
                >
                  {line.message}
                </p>
                <Button
                  data-testid="deal-add"
                  aria-describedby={messageId}
                  disabled={!line.recipe}
                  onClick={() => line.recipe && onSave(line.recipe)}
                  className={cn(
                    'h-12 w-full px-6 text-base font-bold',
                    // While it counts what is left the button is read, so it is not faded.
                    missing.length > 0
                      ? 'border border-border bg-muted text-foreground disabled:opacity-100'
                      : 'bg-brand text-white hover:bg-brand-hover',
                  )}
                >
                  {missing.length > 0
                    ? t('dealChoicesLeft', { count: missing.length })
                    : editing
                      ? t('save', { total })
                      : t('addToOrder', { total })}
                </Button>
              </div>
            </aside>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

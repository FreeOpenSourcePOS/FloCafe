'use client';

import { useId, useReducer, useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import {
  sheetLine,
  sheetReducer,
  type SheetAction,
  type SheetHalf,
  type SheetLine,
  type SheetState,
} from '@/lib/pizza/sheet-state';
import { cn } from '@/lib/utils';
import type { CookNote, CutNote, PizzaCatalog } from '@shared/pizza/types';
import { QuickButtonSaveAction } from './useQuickButtons';

export const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground';
export const HEADING = 'text-xs font-semibold uppercase tracking-wider text-muted-foreground';
const NORMAL = 'normal';

/** A minus, a count and a plus, each 48 px; `name` says what is counted, for the labels. */
export function PizzaStepper({
  name,
  value,
  least,
  most,
  onChange,
  valueTestId,
}: {
  name: string;
  value: number;
  least: number;
  most?: number;
  onChange: (value: number) => void;
  valueTestId?: string;
}) {
  const t = useTranslations('pizza');
  const button = `flex h-12 w-12 items-center justify-center rounded-lg text-brand dark:text-indigo-300 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
  return (
    <div className="inline-flex shrink-0 items-center rounded-xl border border-border bg-card">
      <button
        type="button"
        className={button}
        aria-label={t('oneFewer', { name })}
        disabled={value <= least}
        onClick={() => onChange(value - 1)}
      >
        <Minus size={18} />
      </button>
      <output
        data-testid={valueTestId}
        className="min-w-8 text-center text-base font-bold tabular-nums text-foreground"
      >
        {value}
      </output>
      <button
        type="button"
        className={button}
        aria-label={t('oneMore', { name })}
        disabled={most != null && value >= most}
        onClick={() => onChange(value + 1)}
      >
        <Plus size={18} />
      </button>
    </div>
  );
}

/** One choice out of a few, as a row of buttons; the chosen one is pressed. */
export function Segmented({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: string | null;
  options: { id: string; label: string; hint?: string }[];
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('flex gap-1 rounded-xl bg-muted p-1', className)}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === value}
          onClick={() => onChange(option.id)}
          className={cn(
            'min-h-12 min-w-12 flex-1 rounded-lg px-3 text-sm font-semibold whitespace-nowrap transition-colors',
            FOCUS,
            option.id === value
              ? 'bg-card text-brand shadow-sm ring-2 ring-inset ring-brand dark:text-indigo-300'
              : 'text-foreground hover:bg-card/60',
          )}
        >
          {option.label}
          {option.hint && <span className="ms-1.5 font-normal tabular-nums">{option.hint}</span>}
        </button>
      ))}
    </div>
  );
}

/** One half, or the whole pizza: which pizza it is and what comes off it. */
function HalfColumn({
  catalog,
  label,
  half,
  wide,
  onPizza,
  onIngredient,
}: {
  catalog: PizzaCatalog;
  label: string;
  half: SheetHalf;
  wide: boolean;
  onPizza: (pizzaId: string) => void;
  onIngredient: (name: string) => void;
}) {
  const t = useTranslations('pizza');
  const pizza = catalog.pizzas.find((entry) => entry.id === half.pizzaId);
  return (
    <section
      role="group"
      aria-label={label}
      className={cn('rounded-xl border border-border p-3', wide && 'col-span-2')}
    >
      <p className="mb-2 flex items-baseline gap-2">
        <span className={HEADING}>{label}</span>
        <span className="text-base font-bold text-foreground">{pizza?.name}</span>
      </p>
      <div className={cn('grid gap-2', wide ? 'grid-cols-4' : 'grid-cols-2')}>
        {catalog.pizzas.map((entry) => {
          const chosen = entry.id === half.pizzaId;
          return (
            <button
              key={entry.id}
              type="button"
              aria-pressed={chosen}
              onClick={() => onPizza(entry.id)}
              className={cn(
                'flex min-h-12 items-center gap-2 rounded-lg border px-2 text-start text-sm font-semibold leading-tight transition-colors',
                FOCUS,
                chosen
                  ? 'border-brand bg-brand text-white'
                  : 'border-border bg-card text-foreground hover:border-brand/40',
              )}
            >
              {entry.number != null && (
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-bold tabular-nums',
                    chosen
                      ? 'bg-white text-brand'
                      : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
                  )}
                >
                  {entry.number}
                </span>
              )}
              {entry.name}
            </button>
          );
        })}
      </div>
      {pizza && (
        <>
          <p className={cn(HEADING, 'mt-3 mb-2')}>
            {pizza.ingredients.length > 0 ? t('ingredientsHint') : t('noIngredients')}
          </p>
          <div className="flex flex-wrap gap-2">
            {pizza.ingredients.map((name) => {
              const removed = half.removed.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  aria-pressed={removed}
                  onClick={() => onIngredient(name)}
                  className={cn(
                    'min-h-12 min-w-12 rounded-full border px-4 text-sm font-semibold transition-colors',
                    FOCUS,
                    removed
                      ? 'border-2 border-red-700 bg-red-50 text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300'
                      : 'border-border bg-card text-foreground hover:border-brand/40',
                  )}
                >
                  {removed ? (
                    <>
                      <span className="font-bold">{t('no')}</span> <s>{name}</s>
                    </>
                  ) : (
                    name
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

/** What the pizza sheet and a deal's pizza tab hand each part of the pizza editor. */
interface EditorProps {
  state: SheetState;
  dispatch: (action: SheetAction) => void;
}

/** Whole pizza or half and half. */
export function WholeOrHalf({ state, dispatch }: EditorProps) {
  const t = useTranslations('pizza');
  return (
    <Segmented
      label={t('wholeOrHalf')}
      value={state.split ? 'half' : 'whole'}
      options={[
        { id: 'whole', label: t('wholePizza') },
        { id: 'half', label: t('halfAndHalf') },
      ]}
      onChange={(id) => dispatch({ type: 'split', split: id === 'half' })}
    />
  );
}

/** The whole pizza as one wide column, or both halves side by side: two columns of the grid around them. */
export function PizzaHalves({ catalog, state, dispatch }: EditorProps & { catalog: PizzaCatalog }) {
  const t = useTranslations('pizza');
  const halves = state.split ? ([0, 1] as const) : ([0] as const);
  return halves.map((index) => (
    <HalfColumn
      key={index}
      catalog={catalog}
      label={state.split ? (index === 0 ? t('firstHalf') : t('secondHalf')) : t('wholePizza')}
      half={state.halves[index]}
      wide={!state.split}
      onPizza={(pizzaId) => dispatch({ type: 'pizza', half: index, pizzaId })}
      onIngredient={(name) => dispatch({ type: 'ingredient', half: index, name })}
    />
  ));
}

/** The cook and the cut, each a row of three. */
export function CookAndCut({ state, dispatch }: EditorProps) {
  const t = useTranslations('pizza');
  return (
    <>
      <div>
        <p className={cn(HEADING, 'mb-1')}>{t('cook')}</p>
        <Segmented
          label={t('cook')}
          value={state.cook ?? NORMAL}
          options={[
            { id: NORMAL, label: t('normal') },
            { id: 'well-done', label: t('cookWellDone') },
            { id: 'light-bake', label: t('cookLightBake') },
          ]}
          onChange={(id) =>
            dispatch({ type: 'cook', cook: id === NORMAL ? null : (id as CookNote) })
          }
        />
      </div>
      <div>
        <p className={cn(HEADING, 'mb-1')}>{t('cut')}</p>
        <Segmented
          label={t('cut')}
          value={state.cut ?? NORMAL}
          options={[
            { id: NORMAL, label: t('normal') },
            { id: 'square-cut', label: t('cutSquare') },
            { id: 'uncut', label: t('cutUncut') },
          ]}
          onChange={(id) => dispatch({ type: 'cut', cut: id === NORMAL ? null : (id as CutNote) })}
        />
      </div>
    </>
  );
}

/**
 * The pizza sheet: one dialog for a new pizza and for a cart line being
 * changed. Its state is `sheetReducer`'s; `sheetLine` says what it would put
 * in the cart, what that prints as, and why Add is off.
 */
export default function PizzaSheet({
  catalog,
  initial,
  editing,
  onSave,
  onSaveButton,
  onClose,
  returnFocus,
}: {
  catalog: PizzaCatalog;
  initial: SheetState;
  /** True when the sheet changes a line already in the cart. */
  editing: boolean;
  onSave: (line: SheetLine, state: SheetState) => void;
  /** Saves what the sheet holds as a quick button, leaving the order as it is. */
  onSaveButton?: (line: SheetLine, state: SheetState) => void;
  onClose: () => void;
  /** Where the focus goes on close when the control that opened the sheet is gone. */
  returnFocus: () => HTMLElement | null;
}) {
  const t = useTranslations('pizza');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  // The menu load takes only currencies counted in hundredths.
  const money = (cents: number) => fmt(cents / 100);
  const [state, dispatch] = useReducer(sheetReducer, initial);
  // The dialog has no trigger of its own, so it hands the focus back to whatever opened it.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const messageId = useId();
  const line = sheetLine(catalog, state);
  const size = catalog.sizes.find((entry) => entry.id === state.sizeId);
  const total = line.unitPriceCents === null ? '—' : money(line.unitPriceCents * state.quantity);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        // A stray tap beside the sheet must not throw the pizza away.
        onInteractOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          (opener?.isConnected ? opener : returnFocus())?.focus();
        }}
        className="flex max-h-[calc(100dvh-1.5rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1100px]"
      >
        <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <DialogTitle className="text-xl">{t('sheetTitle')}</DialogTitle>
          <Segmented
            label={t('size')}
            value={state.sizeId}
            options={catalog.sizes.map((entry) => ({
              id: entry.id,
              label: entry.label,
              hint: money(entry.priceCents),
            }))}
            onChange={(sizeId) => dispatch({ type: 'size', sizeId })}
          />
          <WholeOrHalf state={state} dispatch={dispatch} />
          <DialogClose
            aria-label={tCommon('close')}
            className={cn(
              'ms-auto flex h-12 w-12 items-center justify-center rounded-lg border border-border text-foreground hover:bg-muted',
              FOCUS,
            )}
          >
            <X size={20} />
          </DialogClose>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[1fr_1fr_18rem] items-start gap-3 overflow-y-auto p-4">
          <PizzaHalves catalog={catalog} state={state} dispatch={dispatch} />

          <div className="space-y-3">
            <CookAndCut state={state} dispatch={dispatch} />
            {catalog.dips.length > 0 && (
              <div role="group" aria-label={t('dips')} className="space-y-2">
                <p className={HEADING}>
                  {t('dipsEach', { price: money(catalog.dips[0].priceCents) })}
                </p>
                {catalog.dips.map((dip) => (
                  <div key={dip.id} className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">{dip.label}</span>
                    <PizzaStepper
                      name={dip.label}
                      value={state.dips[dip.id] ?? 0}
                      least={0}
                      onChange={(count) => dispatch({ type: 'dip', dipId: dip.id, count })}
                    />
                  </div>
                ))}
              </div>
            )}
            <label className="block">
              <span className={cn(HEADING, 'mb-1 block')}>{t('note')}</span>
              <input
                type="text"
                value={state.note}
                maxLength={100}
                onChange={(event) => dispatch({ type: 'note', note: event.target.value })}
                placeholder={t('notePlaceholder')}
                className="min-h-12 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-brand"
              />
            </label>
            <div className="flex items-center justify-between gap-2">
              <span className={HEADING}>{t('quantity')}</span>
              <PizzaStepper
                name={t('quantityUnit')}
                value={state.quantity}
                least={1}
                onChange={(quantity) => dispatch({ type: 'quantity', quantity })}
              />
            </div>
          </div>
        </div>

        <footer className="flex items-center gap-4 border-t border-border px-4 py-3">
          <div
            data-testid="pizza-prints-as"
            className="flex min-h-12 min-w-64 gap-3 rounded-lg bg-muted px-3 py-2"
          >
            <span className={cn(HEADING, 'shrink-0')}>{t('printsAs')}</span>
            <div className="font-mono text-xs font-semibold leading-snug text-foreground">
              {line.printsAs &&
                [line.printsAs.heading, ...line.printsAs.detailLines].map((text, index) => (
                  <div
                    key={index}
                    data-testid="pizza-prints-line"
                    className={cn(
                      'whitespace-pre',
                      text.trimStart().startsWith('NO ') && 'text-red-700 dark:text-red-300',
                    )}
                  >
                    {text}
                  </div>
                ))}
            </div>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-4 text-sm text-foreground">
            {size && (
              <>
                <dt>{t('pizzaLine', { size: size.label })}</dt>
                <dd className="text-end tabular-nums">{money(size.priceCents)}</dd>
              </>
            )}
            {line.dips.map((dip) => (
              <div key={dip.addonId} className="contents">
                <dt>{t('dipLine', { count: dip.quantity, name: dip.name })}</dt>
                <dd className="text-end tabular-nums">{money(dip.priceCents * dip.quantity)}</dd>
              </div>
            ))}
          </dl>
          <div className="ms-auto flex items-center gap-3">
            {!editing && line.canAdd && onSaveButton && (
              <QuickButtonSaveAction onClick={() => onSaveButton(line, state)} />
            )}
            <p
              id={messageId}
              role="status"
              data-testid="pizza-sheet-message"
              className="max-w-56 text-end text-sm font-semibold text-red-700 dark:text-red-300"
            >
              {line.message}
            </p>
            <Button
              aria-describedby={messageId}
              disabled={!line.canAdd}
              onClick={() => onSave(line, state)}
              className="h-12 min-w-48 bg-brand px-6 text-base font-bold text-white hover:bg-brand-hover"
            >
              {editing ? t('save', { total }) : t('addToOrder', { total })}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

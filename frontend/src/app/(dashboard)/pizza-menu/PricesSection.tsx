'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { tenantCan } from '@/lib/permissions';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { GROUPS, type PriceList, type PriceRow } from '@shared/pizza/prices';
import type { PizzaCatalog } from '@shared/pizza/types';

/** An amount as the owner types it: up to five digits and at most two decimals. */
const AMOUNT = /^\d{1,5}(\.\d{1,2})?$/;

/** What a row's input holds: typed text, or null for "use the menu's price". */
type Edits = Record<string, string | null>;

/** The price a row changes to, `'bad'` for text that is no amount, or undefined for no change. */
function changeOf(row: PriceRow, edit: string | null | undefined): number | 'bad' | undefined {
  if (edit === null) return row.overridden ? row.file : undefined;
  const typed = edit?.trim() ?? '';
  if (typed === '') return undefined;
  if (!AMOUNT.test(typed)) return 'bad';
  return Number(typed) === row.price ? undefined : Number(typed);
}

/**
 * The prices of the loaded menu, each with the menu file's amount beside the one charged, and an
 * input to set another. `menu` is the catalogue the screen shows: the list is read again whenever
 * it changes. `onSaved` runs after a save, so the screen and the POS read the new menu.
 */
export function PricesSection({
  menu,
  onSaved,
}: {
  menu: PizzaCatalog | null | undefined;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations('pizza');
  const fmt = useFormatCurrency();
  const mayEdit = tenantCan(
    useAuthStore((state) => state.currentTenant),
    'catalog.manage',
  );
  const [list, setList] = useState<PriceList | null>(null);
  const [edits, setEdits] = useState<Edits>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasMenu = Boolean(menu);

  const read = useCallback(
    () =>
      api.get<PriceList>('/pizza/prices').then(
        (answer) => {
          setList(answer.data);
          setError(null);
        },
        () => setError(t('pricesReadFailed')),
      ),
    [t],
  );
  useEffect(() => {
    if (mayEdit && hasMenu) void read();
  }, [mayEdit, hasMenu, menu, read]);

  if (!mayEdit || !hasMenu) return null;

  const rows = list?.prices ?? [];
  const changes = rows.flatMap((row) => {
    const to = changeOf(row, edits[row.key]);
    return to === undefined ? [] : [{ row, to }];
  });
  const dropped = (list?.unused ?? []).filter((entry) => edits[entry.key] === null);
  const bad = changes.some((change) => change.to === 'bad');
  const edit = (key: string, value: string | null | undefined) =>
    setEdits((current) => ({ ...current, [key]: value }) as Edits);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const prices = Object.fromEntries([
        ...changes.map(({ row, to }) => [row.key, edits[row.key] === null ? null : to]),
        ...dropped.map((entry) => [entry.key, null]),
      ]);
      setList((await api.put<PriceList>('/pizza/prices', { prices })).data);
      setEdits({});
      await onSaved();
    } catch (err) {
      const said = (err as { response?: { data?: { error?: unknown } } }).response?.data?.error;
      setError(typeof said === 'string' ? said : t('pricesNotSaved'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="pizza-prices">
      <CardHeader>
        <CardTitle>
          <h2>{t('pricesHeading')}</h2>
        </CardTitle>
        <CardDescription>{t('pricesHint')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {rows.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-start text-muted-foreground">
                <th scope="col" className="py-2 text-start font-medium">
                  {t('pricesColumnItem')}
                </th>
                <th scope="col" className="px-2 py-2 text-end font-medium">
                  {t('pricesColumnFile')}
                </th>
                <th scope="col" className="px-2 py-2 text-end font-medium">
                  {t('pricesColumnNow')}
                </th>
                <th scope="col" className="py-2 text-start font-medium">
                  {t('pricesColumnNew')}
                </th>
              </tr>
            </thead>
            {GROUPS.map((group) => {
              const inGroup = rows.filter((row) => row.group === group);
              if (inGroup.length === 0) return null;
              return (
                <tbody key={group}>
                  <tr>
                    <th
                      scope="rowgroup"
                      colSpan={4}
                      className="pt-4 pb-1 text-start text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                    >
                      {t('pricesGroup', { group })}
                    </th>
                  </tr>
                  {inGroup.map((row) => {
                    const staged = edits[row.key];
                    return (
                      <tr key={row.key} data-testid={`pizza-price-${row.key}`} className="border-b">
                        <th scope="row" className="py-2 text-start font-medium">
                          {row.label}
                        </th>
                        <td className="px-2 py-2 text-end tabular-nums">{fmt(row.file)}</td>
                        <td className="px-2 py-2 text-end tabular-nums">
                          {fmt(row.price)}
                          {row.overridden && (
                            <span className="block text-xs text-muted-foreground">
                              {t('pricesSetHere')}
                            </span>
                          )}
                        </td>
                        <td className="py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <Input
                              inputMode="decimal"
                              aria-label={t('pricesNewFor', { label: row.label })}
                              aria-invalid={changeOf(row, staged) === 'bad'}
                              disabled={busy}
                              value={staged ?? ''}
                              onChange={(event) => edit(row.key, event.target.value)}
                              className="h-12 w-28 text-end tabular-nums"
                            />
                            {row.overridden && (
                              <Button
                                variant={staged === null ? 'default' : 'outline'}
                                aria-pressed={staged === null}
                                className={cn('h-12 px-3', staged !== null && 'text-foreground')}
                                disabled={busy}
                                onClick={() => edit(row.key, staged === null ? undefined : null)}
                              >
                                {t('pricesUseFile')}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              );
            })}
          </table>
        )}

        {(list?.unused.length ?? 0) > 0 && (
          <div data-testid="pizza-prices-unused" className="flex flex-col gap-2 text-sm">
            <h3 className="font-semibold">{t('pricesUnusedHeading')}</h3>
            <p className="text-muted-foreground">{t('pricesUnusedHint')}</p>
            <ul className="flex flex-col gap-2">
              {list?.unused.map((entry) => (
                <li key={entry.key} className="flex flex-wrap items-center gap-3">
                  <span className="tabular-nums">
                    <code>{entry.key}</code> {fmt(entry.price)}
                  </span>
                  <Button
                    variant={edits[entry.key] === null ? 'default' : 'outline'}
                    aria-pressed={edits[entry.key] === null}
                    className={cn('h-12 px-3', edits[entry.key] !== null && 'text-foreground')}
                    disabled={busy}
                    onClick={() => edit(entry.key, edits[entry.key] === null ? undefined : null)}
                  >
                    {t('pricesRemoveUnused')}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(changes.length > 0 || dropped.length > 0) && (
          <div
            data-testid="pizza-prices-preview"
            className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 shadow-md dark:border-amber-800/50 dark:bg-amber-950 dark:text-amber-300"
          >
            <h3 className="text-base font-semibold">{t('pricesPreviewHeading')}</h3>
            <ul className="list-disc space-y-1 ps-5">
              {changes.map(({ row, to }) => (
                <li key={row.key}>
                  {to === 'bad'
                    ? t('pricesBadAmount', { label: row.label })
                    : t('pricesChange', {
                        label: row.label,
                        from: fmt(row.price),
                        to: fmt(to),
                        group: row.group,
                        count: row.count,
                        source: edits[row.key] === null ? 'file' : 'typed',
                      })}
                </li>
              ))}
              {dropped.map((entry) => (
                <li key={entry.key}>{t('pricesUnusedRemoved', { key: entry.key })}</li>
              ))}
            </ul>
            <p>{t('pricesPreviewNote')}</p>
            <div className="flex flex-wrap gap-3">
              <Button className="h-12 px-6" disabled={busy || bad} onClick={save}>
                {t('pricesSave')}
              </Button>
              <Button
                variant="outline"
                className="h-12 px-6 text-foreground"
                disabled={busy}
                onClick={() => setEdits({})}
              >
                {t('pricesDiscard')}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div
            role="alert"
            data-testid="pizza-prices-error"
            className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
          >
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <p className="min-w-0 break-words">{error}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

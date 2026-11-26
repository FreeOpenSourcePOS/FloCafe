'use client';

import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { reloadPizzaCatalog } from '@/lib/pizza/catalog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { PizzaCatalog } from '@shared/pizza/types';
import { PricesSection } from './PricesSection';

/** What `POST /api/pizza/menu/import` answers. */
interface LoadSummary {
  created: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  untaxed: boolean;
}

const WARNING_BOX =
  'flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/40 dark:text-amber-300';
const ERROR_BOX =
  'flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300';

export default function PizzaMenuPage() {
  const t = useTranslations('pizza');
  const tCommon = useTranslations('common');
  // undefined until the first answer; null when the shop has no pizza menu.
  const [loaded, setLoaded] = useState<PizzaCatalog | null>();
  const [readFailed, setReadFailed] = useState(false);
  const [pending, setPending] = useState<{ name: string; menu: unknown } | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<LoadSummary | null>(null);
  const [error, setError] = useState<{ message: string; path?: string } | null>(null);

  // Also refreshes the copy of the menu the POS reads, so a new menu shows without signing out.
  const refresh = useCallback(
    () =>
      reloadPizzaCatalog().then(
        (catalog) => {
          setLoaded(catalog);
          setReadFailed(false);
        },
        () => setReadFailed(true),
      ),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setPending(null);
    setSummary(null);
    setError(null);
    let menu: unknown;
    try {
      menu = JSON.parse(await file.text());
    } catch {
      // Refused below, with a list, a number, text and null: none of them is a menu file.
    }
    if (typeof menu !== 'object' || menu === null || Array.isArray(menu)) {
      setError({ message: t('menuNotJson', { name: file.name }) });
      return;
    }
    setPending({ name: file.name, menu });
  };

  const load = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const { data } = await api.post<LoadSummary>('/pizza/menu/import', pending.menu);
      setSummary(data);
      await refresh();
    } catch (err) {
      const answer = (err as { response?: { data?: { error?: unknown; path?: unknown } } }).response
        ?.data;
      const path = typeof answer?.path === 'string' ? answer.path : undefined;
      const message = typeof answer?.error === 'string' ? answer.error : t('menuNotLoaded');
      // The server's message starts with the entry it names, which is shown on its own line.
      const named = path !== undefined && message.startsWith(`${path}: `);
      setError({ message: named ? message.slice(path.length + 2) : message, path });
    } finally {
      setPending(null);
      setBusy(false);
    }
  };

  const counts = loaded
    ? ([
        ['menuCountPizzas', loaded.pizzas.length],
        ['menuCountSizes', loaded.sizes.length],
        ['menuCountDips', loaded.dips.length],
        ['menuCountSides', loaded.sides.length],
        ['menuCountDrinks', loaded.drinks.length],
        ['menuCountDeals', loaded.deals.length],
      ] as const)
    : [];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <h1 className="text-2xl font-bold text-foreground">{t('menuTitle')}</h1>

      <Card data-testid="pizza-menu-loaded">
        <CardHeader>
          <CardTitle>
            <h2>{t('menuLoadedHeading')}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {readFailed ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {t('menuReadFailed')}
            </p>
          ) : loaded === undefined ? (
            <p className="text-sm text-muted-foreground">{tCommon('loading')}</p>
          ) : loaded === null ? (
            <p className="text-sm text-muted-foreground">{t('menuNoneLoaded')}</p>
          ) : (
            <ul className="grid grid-cols-3 gap-3 sm:grid-cols-6">
              {counts.map(([key, count]) => (
                <li key={key} className="rounded-lg border bg-muted/40 px-2 py-3 text-center">
                  <span className="block text-2xl font-semibold tabular-nums">{count}</span>{' '}
                  <span className="text-sm text-muted-foreground">{t(key, { count })}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <PricesSection menu={loaded} onSaved={refresh} />

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t('menuFileHeading')}</h2>
          </CardTitle>
          <CardDescription>{t('menuFileHint')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="pizza-menu-file">{t('menuFileLabel')}</Label>
            <Input
              id="pizza-menu-file"
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={choose}
              // Cleared as the picker opens, so choosing the same file again after fixing it is seen.
              onClick={(event) => {
                event.currentTarget.value = '';
              }}
              className="h-12 cursor-pointer py-2 file:me-3 file:h-8 file:cursor-pointer file:rounded-md file:bg-secondary file:px-3"
            />
          </div>

          {pending && (
            <div data-testid="pizza-menu-confirm" className={`${WARNING_BOX} flex-col`}>
              <h3 className="text-base font-semibold">
                {t('menuConfirmHeading', { name: pending.name })}
              </h3>
              <ul className="list-disc space-y-1 ps-5">
                <li>{t('menuConfirmMaster')}</li>
                <li>{t('menuConfirmFollows')}</li>
                <li>{t('menuConfirmSwitchedOff')}</li>
                <li>{t('menuConfirmOverwrites')}</li>
                <li>{t('menuConfirmKeepsPrices')}</li>
              </ul>
              <div className="flex flex-wrap gap-3">
                <Button className="h-12 px-6" disabled={busy} onClick={load}>
                  {t('menuConfirmButton')}
                </Button>
                <Button
                  variant="outline"
                  className="h-12 px-6 text-foreground"
                  disabled={busy}
                  onClick={() => setPending(null)}
                >
                  {tCommon('cancel')}
                </Button>
              </div>
            </div>
          )}

          {error && (
            <div role="alert" data-testid="pizza-menu-error" className={ERROR_BOX}>
              <AlertTriangle size={18} className="mt-0.5 shrink-0" />
              <div className="min-w-0 space-y-1 break-words">
                <p>{error.message}</p>
                {error.path && <p>{t('menuErrorEntry', { path: error.path })}</p>}
              </div>
            </div>
          )}

          {summary && (
            <div
              role="status"
              data-testid="pizza-menu-result"
              className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900/50 dark:bg-green-950/40 dark:text-green-300"
            >
              <CheckCircle2 size={18} className="mt-0.5 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">
                  {t('menuResult', {
                    created: summary.created,
                    updated: summary.updated,
                    unchanged: summary.unchanged,
                    deactivated: summary.deactivated,
                  })}
                </p>
                <p>{t('menuResultRows')}</p>
              </div>
            </div>
          )}

          {summary?.untaxed && (
            <div role="alert" data-testid="pizza-menu-untaxed" className={WARNING_BOX}>
              <AlertTriangle size={18} className="mt-0.5 shrink-0" />
              <p>{t('menuUntaxed')}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

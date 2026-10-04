'use client';

import { useCallback, useEffect } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { isOrdersLayoutValue, useOrdersLayoutStore, type OrdersLayout } from '@/store/orders-layout';

// Several screens read the preference; hydrate it from the DB once per renderer.
let hydrationStarted = false;
let saveGeneration = 0;
let pendingRequest: Promise<unknown> = Promise.resolve();
let confirmedLayout: OrdersLayout = 'split';

/** Reads the persisted orders layout into the store and saves it optimistically,
 * rolling back and surfacing an error when the write fails. */
export function useOrdersLayoutPreference() {
  const t = useTranslations('settings');
  const layout = useOrdersLayoutStore((s) => s.layout);
  const setLayout = useOrdersLayoutStore((s) => s.setLayout);
  const markUserSelected = useOrdersLayoutStore((s) => s.markUserSelected);

  useEffect(() => {
    if (hydrationStarted) return;
    hydrationStarted = true;
    pendingRequest = pendingRequest.then(async () => {
      try {
        const { data } = await api.get('/settings/orders_layout');
        const raw = data?.setting?.value;
        // A choice made while the fetch was in flight wins over the stored row.
        if (isOrdersLayoutValue(raw)) {
          confirmedLayout = raw;
          if (!useOrdersLayoutStore.getState().userSelected) setLayout(raw);
        }
      } catch {
        hydrationStarted = false;
      }
    });
  }, [setLayout]);

  const save = useCallback(
    async (next: OrdersLayout) => {
      const previous = useOrdersLayoutStore.getState().layout;
      if (next === previous) return;
      const generation = ++saveGeneration;
      markUserSelected();
      setLayout(next);
      const write = pendingRequest.then(() => api.put('/settings/orders_layout', { value: next }));
      pendingRequest = write.catch(() => {});
      try {
        await write;
        confirmedLayout = next;
      } catch {
        if (generation !== saveGeneration) return;
        setLayout(confirmedLayout);
        toast.error(t('saveFailed'));
      }
    },
    [markUserSelected, setLayout, t],
  );

  return { layout, save };
}
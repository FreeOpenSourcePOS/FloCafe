'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import {
  isPosCategorySort,
  isPosItemSort,
  type PosCategorySort,
  type PosItemSort,
} from '@/lib/pos-sort';

/** Reads the tenant-wide POS catalog ordering; falls back to the saved order. */
export function usePosSortPreference() {
  const t = useTranslations('settings');
  const [categorySort, setCategorySort] = useState<PosCategorySort>('saved');
  const [itemSort, setItemSort] = useState<PosItemSort>('saved');

  useEffect(() => {
    let cancelled = false;
    api
      .get('/settings/pos-sort')
      .then(({ data }) => {
        if (cancelled) return;
        if (isPosCategorySort(data?.category_sort)) setCategorySort(data.category_sort);
        if (isPosItemSort(data?.item_sort)) setItemSort(data.item_sort);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (key: 'pos_category_sort' | 'pos_item_sort', value: PosCategorySort | PosItemSort) => {
      const previousCategory = categorySort;
      const previousItem = itemSort;
      if (key === 'pos_category_sort') setCategorySort(value as PosCategorySort);
      else setItemSort(value as PosItemSort);
      try {
        await api.put(`/settings/${key}`, { value });
      } catch {
        setCategorySort(previousCategory);
        setItemSort(previousItem);
        toast.error(t('saveFailed'));
      }
    },
    [categorySort, itemSort, t],
  );

  return { categorySort, itemSort, save };
}

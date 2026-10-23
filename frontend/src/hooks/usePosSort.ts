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
import { useAuthStore } from '@/store/auth';

/** Reads the tenant-wide POS catalog ordering; falls back to the saved order. */
export function usePosSortPreference() {
  const t = useTranslations('settings');
  const tenantId = useAuthStore((s) => s.currentTenant?.id);
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
  }, [tenantId]);

  const save = useCallback(
    async (key: 'pos_category_sort' | 'pos_item_sort', value: PosCategorySort | PosItemSort) => {
      if (key === 'pos_category_sort') {
        const previousCategory = categorySort;
        setCategorySort(value as PosCategorySort);
        try {
          await api.put(`/settings/${key}`, { value });
        } catch {
          setCategorySort(previousCategory);
          toast.error(t('saveFailed'));
        }
        return;
      }
      const previousItem = itemSort;
      setItemSort(value as PosItemSort);
      try {
        await api.put(`/settings/${key}`, { value });
      } catch {
        setItemSort(previousItem);
        toast.error(t('saveFailed'));
      }
    },
    [categorySort, itemSort, t],
  );

  return { categorySort, itemSort, save };
}

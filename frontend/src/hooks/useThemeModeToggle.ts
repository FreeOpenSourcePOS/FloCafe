'use client';

import { useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { useThemeMode, type ThemeMode } from '@/store/theme';
import api from '@/lib/api';

const CYCLE: readonly ThemeMode[] = ['light', 'dark', 'system'];

/** Theme toggle for app chrome; optimistically updates store
 * and rolls back on persistence failure. */
export function useThemeModeToggle() {
  const t = useTranslations('settings');
  const mode = useThemeMode((s) => s.mode);
  const setMode = useThemeMode((s) => s.setMode);
  const markUserSelected = useThemeMode((s) => s.markUserSelected);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const save = async (next: ThemeMode) => {
    if (savingRef.current || next === mode) return;
    const previous = mode;
    savingRef.current = true;
    setSaving(true);
    markUserSelected();
    setMode(next);
    try {
      await api.put('/settings/theme_mode', { value: next });
    } catch {
      setMode(previous);
      toast.error(t('saveFailed'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const cycle = () => {
    const next = CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length];
    void save(next);
  };

  return { mode, saving, save, cycle };
}

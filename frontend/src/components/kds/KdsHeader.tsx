'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { ChefHat, LogOut, Moon, Sun, Wifi, WifiOff } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { ConnectionMode } from '@/hooks/useKdsConnection';
import type { KdsViewMode } from '@/hooks/useKdsView';
import { persistKdsThemeOverride } from '@/lib/i18n/server-language';
import { useThemeMode, type ThemeMode } from '@/store/theme';

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

export function resolveEffectiveKdsDark(mode: ThemeMode): boolean {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return Boolean(window.matchMedia(DARK_MEDIA_QUERY).matches);
  }
  if (typeof document !== 'undefined') {
    return Boolean(document.documentElement?.classList?.contains('dark'));
  }
  return false;
}

export function subscribeSystemColorScheme(mode: ThemeMode, onStoreChange: () => void): () => void {
  if (
    mode !== 'system' ||
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return () => {};
  }
  const media = window.matchMedia(DARK_MEDIA_QUERY);
  media.addEventListener('change', onStoreChange);
  return () => media.removeEventListener('change', onStoreChange);
}

function getSystemDarkSnapshot(): boolean {
  return resolveEffectiveKdsDark('system');
}

export interface KdsHeaderProps {
  userName: string;
  userRole: string;
  connected: boolean;
  connectionMode: ConnectionMode;
  viewMode: KdsViewMode;
  onChangeView: (mode: KdsViewMode) => void;
  onLogout: () => void;
}

export function KdsHeader({
  userName,
  userRole,
  connected,
  connectionMode,
  viewMode,
  onChangeView,
  onLogout,
}: KdsHeaderProps) {
  const t = useTranslations('kds');
  const tNav = useTranslations('nav');
  const tSettings = useTranslations('settings');
  const mode = useThemeMode((s) => s.mode);
  const selectMode = useThemeMode((s) => s.selectMode);
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeSystemColorScheme(mode, onStoreChange),
    [mode],
  );
  const systemDark = useSyncExternalStore(subscribe, getSystemDarkSnapshot, getSystemDarkSnapshot);
  const isDark = mode === 'dark' ? true : mode === 'light' ? false : systemDark;
  const themeLabel = `${tSettings('themeTitle')}: ${isDark ? tSettings('themeLight') : tSettings('themeDark')}`;

  return (
    <div className="shrink-0 mb-4">
      <div className="flex items-center gap-3 mb-3">
        <ChefHat size={24} className="text-brand dark:text-indigo-300" />
        <div>
          <h1 className="text-xl font-bold text-foreground">{t('title')}</h1>
          <p className="text-xs text-slate-700 dark:text-slate-300">
            {userName} ({userRole})
          </p>
        </div>
        <div className="ms-auto flex items-center gap-2">
          {connectionMode === 'websocket' ? (
            <span title={t('wsConnected')}>
              <Wifi size={16} className="text-green-500" />
            </span>
          ) : connectionMode === 'rest' ? (
            <span title={t('restPolling')}>
              <WifiOff size={16} className="text-amber-500" />
            </span>
          ) : null}
          <span
            className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}
          />
          <span className="text-xs text-slate-700 dark:text-slate-300">
            {connected
              ? connectionMode === 'websocket'
                ? t('connectionLive')
                : t('connectionPolling')
              : t('connectionConnecting')}
          </span>

          <div className="flex items-center bg-muted rounded-lg p-0.5 ms-2" role="tablist">
            <button
              onClick={() => onChangeView('tabs')}
              aria-pressed={viewMode === 'tabs'}
              className={`min-w-11 min-h-11 px-2.5 py-1 text-xs font-medium rounded-md transition ${
                viewMode === 'tabs'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-slate-700 dark:text-slate-300 hover:text-foreground'
              }`}
            >
              {t('viewTabs')}
            </button>
            <button
              onClick={() => onChangeView('kanban')}
              aria-pressed={viewMode === 'kanban'}
              className={`min-w-11 min-h-11 px-2.5 py-1 text-xs font-medium rounded-md transition ${
                viewMode === 'kanban'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-slate-700 dark:text-slate-300 hover:text-foreground'
              }`}
            >
              {t('viewKanban')}
            </button>
          </div>

          <button
            type="button"
            data-testid="kds-theme-toggle"
            onClick={() => {
              const currentDark = resolveEffectiveKdsDark(useThemeMode.getState().mode);
              const nextMode: 'light' | 'dark' = currentDark ? 'light' : 'dark';
              selectMode(nextMode);
              persistKdsThemeOverride(nextMode);
              if (typeof document !== 'undefined') {
                document.documentElement?.classList?.toggle('dark', nextMode === 'dark');
              }
            }}
            className="min-w-11 min-h-11 p-2 hover:bg-muted rounded-lg text-slate-700 dark:text-slate-300 hover:text-foreground ms-1"
            title={themeLabel}
            aria-label={themeLabel}
          >
            {isDark ? <Sun size={20} /> : <Moon size={20} />}
          </button>

          <button
            onClick={onLogout}
            className="min-w-11 min-h-11 p-2 hover:bg-muted rounded-lg text-slate-700 dark:text-slate-300 hover:text-foreground ms-1"
            title={tNav('logout')}
          >
            <LogOut size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}

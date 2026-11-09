'use client';

import { ChefHat, LogOut, Moon, Sun, Wifi, WifiOff } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { ConnectionMode } from '@/hooks/useKdsConnection';
import type { KdsViewMode } from '@/hooks/useKdsView';
import { useThemeMode } from '@/store/theme';

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
  const isDark =
    mode === 'dark' ||
    (mode !== 'light' &&
      typeof document !== 'undefined' &&
      Boolean(document.documentElement?.classList?.contains('dark')));
  const themeLabel = `${tSettings('themeTitle')}: ${isDark ? tSettings('themeLight') : tSettings('themeDark')}`;

  return (
    <div className="shrink-0 mb-4">
      <div className="flex items-center gap-3 mb-3">
        <ChefHat size={24} className="text-brand" />
        <div>
          <h1 className="text-xl font-bold text-foreground">{t('title')}</h1>
          <p className="text-xs text-muted-foreground">
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
          <span className="text-xs text-muted-foreground">
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
                  : 'text-muted-foreground hover:text-foreground'
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
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t('viewKanban')}
            </button>
          </div>

          <button
            type="button"
            data-testid="kds-theme-toggle"
            onClick={() => {
              const nextMode = isDark ? 'light' : 'dark';
              selectMode(nextMode);
              if (typeof document !== 'undefined') {
                document.documentElement?.classList?.toggle('dark', nextMode === 'dark');
                try {
                  window.localStorage?.setItem('flo-theme-resolved', nextMode);
                } catch {}
              }
            }}
            className="min-w-11 min-h-11 p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-foreground ms-1"
            title={themeLabel}
            aria-label={themeLabel}
          >
            {isDark ? <Sun size={20} /> : <Moon size={20} />}
          </button>

          <button
            onClick={onLogout}
            className="min-w-11 min-h-11 p-2 hover:bg-muted rounded-lg text-muted-foreground ms-1"
            title={tNav('logout')}
          >
            <LogOut size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}

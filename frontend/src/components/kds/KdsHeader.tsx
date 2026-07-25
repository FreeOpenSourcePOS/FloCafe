'use client';

import { ChefHat, LogOut, Wifi, WifiOff } from 'lucide-react';
import type { ConnectionMode } from '@/hooks/useKdsConnection';
import { useI18n } from '@/hooks/useI18n';
import type { KdsViewMode } from '@/hooks/useKdsView';

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
  const { t } = useI18n();

  return (
    <div className="shrink-0 mb-4">
      <div className="flex items-center gap-3 mb-3">
        <ChefHat size={24} className="text-brand" />
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t('kds.title')}</h1>
          <p className="text-xs text-gray-500">
            {userName} ({userRole})
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {connectionMode === 'websocket' ? (
            <span title={t('kds.wsConnected')}>
              <Wifi size={16} className="text-green-500" />
            </span>
          ) : connectionMode === 'rest' ? (
            <span title={t('kds.restPolling')}>
              <WifiOff size={16} className="text-amber-500" />
            </span>
          ) : null}
          <span className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-xs text-gray-400">
            {connected
              ? connectionMode === 'websocket'
                ? t('kds.connectionLive')
                : t('kds.connectionPolling')
              : t('kds.connectionConnecting')}
          </span>

          <div className="flex items-center bg-gray-100 rounded-lg p-0.5 ml-2" role="tablist">
            <button
              onClick={() => onChangeView('tabs')}
              aria-pressed={viewMode === 'tabs'}
              className={`min-w-11 min-h-11 px-2.5 py-1 text-xs font-medium rounded-md transition ${
                viewMode === 'tabs'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t('kds.viewTabs')}
            </button>
            <button
              onClick={() => onChangeView('kanban')}
              aria-pressed={viewMode === 'kanban'}
              className={`min-w-11 min-h-11 px-2.5 py-1 text-xs font-medium rounded-md transition ${
                viewMode === 'kanban'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t('kds.viewKanban')}
            </button>
          </div>

          <button
            onClick={onLogout}
            className="min-w-11 min-h-11 p-2 hover:bg-gray-100 rounded-lg text-gray-500 ml-2"
            title={t('nav.logout')}
          >
            <LogOut size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}

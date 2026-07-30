'use client';

/**
 * UpdateBadge — subtle in-app indicator for silent background updates (#58).
 * Hidden entirely unless there's a download in progress or a restart pending;
 * never shows a native OS dialog.
 */

import { Download, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useUpdateStatus } from '@/hooks/useUpdateStatus';
import { useI18n } from '@/hooks/useI18n';

export default function UpdateBadge() {
  const { updateStatus, appVersion, restartAndInstall } = useUpdateStatus();
  const { t } = useI18n();

  const status = updateStatus?.status;
  if (!status || (status !== 'downloading' && status !== 'ready-to-install')) {
    return null;
  }

  const isReady = status === 'ready-to-install';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={`flex items-center gap-1.5 h-7 px-2 ${isReady ? 'text-brand border-brand/30' : 'text-gray-500 border-current/30'}`}
        >
          {isReady ? (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-brand" />
            </span>
          ) : (
            <Download size={12} />
          )}
          <span className="text-xs font-medium">
            {isReady ? t('update.readyBadge') : t('update.downloadingBadge', { percent: Math.round(updateStatus?.percent || 0) })}
          </span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs text-gray-500">
          {t('update.sectionLabel')}
        </DropdownMenuLabel>

        <div className="px-2 py-1.5 text-xs text-gray-500">
          {isReady ? (
            <p className="flex items-center gap-1.5 text-gray-700">
              <Sparkles size={13} className="text-brand" />
              {t('update.versionReady', { version: updateStatus?.version || '' })}
            </p>
          ) : (
            <div>
              <p className="text-gray-700">{t('update.downloadingDetail', { version: updateStatus?.version || '' })}</p>
              <div className="w-full bg-gray-200 rounded-full h-1.5 mt-2">
                <div
                  className="bg-brand h-1.5 rounded-full transition-all"
                  style={{ width: `${updateStatus?.percent || 0}%` }}
                />
              </div>
            </div>
          )}
          <p className="mt-1.5 text-gray-400">{t('update.currentVersion', { version: appVersion })}</p>
        </div>

        {isReady && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={restartAndInstall} className="text-sm cursor-pointer">
              {t('update.restartNow')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

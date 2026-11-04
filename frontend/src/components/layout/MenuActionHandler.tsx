'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { MasterPinPrompt } from '@/components/settings/MasterPinPrompt';
import { dispatchQuickSearchRequest } from '@/lib/quick-search';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';

export const RESTORE_FROM_FILE_EVENT = 'flo-restore-from-file';

type PendingPinAction = 'backup' | 'restore' | null;

export default function MenuActionHandler() {
  const tCommon = useTranslations('common');
  const tBackup = useTranslations('backup');
  const tSettings = useTranslations('settings');
  const tAuth = useTranslations('auth');
  const router = useRouter();
  const [pendingPinAction, setPendingPinAction] = useState<PendingPinAction>(null);
  const restoreRoutingInFlightRef = useRef(false);

  async function runBackup(pin: string) {
    if (!window.electronAPI?.backupDatabase)
      return { success: false, error: tCommon('notAvailable') };

    toast.loading(tBackup('creating'), { id: 'backup' });
    try {
      const result = await window.electronAPI.backupDatabase(pin);
      if (result.success) {
        toast.success(tBackup('savedTo', { path: result.path ?? '' }));
      } else if (result.error !== 'Cancelled') {
        toast.error(tBackup('failedWith', { error: tCommon('somethingWrong') }));
      }
      return result;
    } catch {
      const message = tCommon('somethingWrong');
      toast.error(tBackup('failedWith', { error: message }));
      return { success: false, error: message };
    } finally {
      toast.remove('backup');
    }
  }

  async function handlePinSubmit(pin: string) {
    const result = await runBackup(pin);
    if (result.success || result.error === 'Cancelled') {
      setPendingPinAction(null);
    }
    return result;
  }

  async function beginPinGatedAction(action: 'backup') {
    try {
      const status = await window.electronAPI?.getMasterPinStatus?.();

      if (!status || 'error' in status) {
        const message = tCommon('somethingWrong');
        toast.error(tBackup('failedWith', { error: message }));
        return;
      }

      if (!status.available) {
        // No OS-backed encryption on this machine — the gate is inert, proceed directly.
        await runBackup('');
        return;
      }

      if (!status.isSet) {
        toast.error(tSettings('setMasterPinFirst'));
        router.push('/settings?tab=data&action=master-pin');
        return;
      }

      setPendingPinAction(action);
    } catch {
      const message = tCommon('somethingWrong');
      toast.error(tBackup('failedWith', { error: message }));
    }
  }

  type AuthOutcome = 'signed-in' | 'signed-out' | 'unknown';

  async function waitForAuthHydration(): Promise<AuthOutcome> {
    const outcome = (): AuthOutcome => (useAuthStore.getState().user ? 'signed-in' : 'signed-out');
    if (!useAuthStore.getState().loading) return outcome();
    return new Promise((resolve) => {
      const unsubscribe = useAuthStore.subscribe((next) => {
        if (next.loading) return;
        unsubscribe();
        clearTimeout(timer);
        resolve(outcome());
      });
      // A slow session check is not proof of a signed-out session.
      const timer = setTimeout(() => {
        unsubscribe();
        resolve('unknown');
      }, 3000);
    });
  }

  async function routeRestoreRequest() {
    if (restoreRoutingInFlightRef.current) return;
    restoreRoutingInFlightRef.current = true;
    try {
      const auth = await waitForAuthHydration();
      if (auth !== 'signed-out') {
        router.push('/settings?tab=data&action=restore-from-file');
        return;
      }
      try {
        const { data } = await api.get('/auth/setup/status');
        if (data?.needsSetup) {
          if (window.location.pathname.startsWith('/setup')) {
            window.dispatchEvent(new CustomEvent(RESTORE_FROM_FILE_EVENT));
          } else {
            router.push('/setup?action=restore-from-file');
          }
          return;
        }
      } catch {
        // Fall through to sign-in.
      }
      toast.error(tAuth('signInTitle'));
      router.push('/auth/login');
    } finally {
      restoreRoutingInFlightRef.current = false;
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        !e.defaultPrevented &&
        !e.repeat &&
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        !e.altKey &&
        e.key?.toLowerCase() === 'r'
      ) {
        e.preventDefault?.();
        void routeRestoreRequest();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    const unsubscribe = window.electronAPI.onMenuAction?.((action: string) => {
      console.log('[Menu] Action received:', action);

      switch (action) {
        case 'new-order':
          router.push('/pos');
          break;
        case 'quick-search':
          router.push('/pos');
          dispatchQuickSearchRequest();
          break;
        case 'view-orders':
        case 'go-orders':
          router.push('/orders');
          break;
        case 'report-daily':
        case 'report-sales':
          router.push('/dashboard');
          break;
        case 'report-x':
          router.push('/dashboard?action=cash-close&view=x-report');
          break;
        case 'report-z':
          router.push('/dashboard?action=cash-close&view=z-report');
          break;
        case 'settings-business':
          router.push('/settings?tab=general');
          break;
        case 'settings-tax':
          router.push('/settings?tab=tax');
          break;
        case 'settings-printer':
          router.push('/settings?tab=printers');
          break;
        case 'settings-kitchen':
          router.push('/settings?tab=kds');
          break;
        case 'go-pos':
          router.push('/pos');
          break;
        case 'go-dashboard':
          router.push('/dashboard');
          break;
        case 'go-kds':
          router.push('/kds');
          break;
        case 'go-tables':
          router.push('/tables');
          break;
        case 'go-products':
          router.push('/products');
          break;
        case 'go-inventory':
          router.push('/inventory');
          break;
        case 'go-customers':
          router.push('/customers');
          break;
        case 'go-staff':
          router.push('/staff');
          break;
        case 'backup-database':
          beginPinGatedAction('backup');
          break;
        case 'menu-restore-from-file':
          void routeRestoreRequest();
          break;
        case 'menu-db-health-check':
          router.push('/settings?tab=data&action=health-check');
          break;
        case 'menu-db-initialize':
          router.push('/settings?tab=data&action=initialize-db');
          break;
        case 'menu-master-pin':
          router.push('/settings?tab=data&action=master-pin');
          break;
        case 'lock':
        case 'lock-terminal':
          void useAuthStore.getState().lock();
          break;
        default:
          console.log('[Menu] Unknown action:', action);
      }
    });

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      unsubscribe?.();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  return (
    <MasterPinPrompt
      open={pendingPinAction !== null}
      mode="verify"
      title={
        pendingPinAction === 'backup'
          ? tSettings('confirmBackupTitle')
          : tSettings('confirmRestoreTitle')
      }
      description={tSettings('enterMasterPinPrompt')}
      onCancel={() => setPendingPinAction(null)}
      onSubmit={handlePinSubmit}
    />
  );
}

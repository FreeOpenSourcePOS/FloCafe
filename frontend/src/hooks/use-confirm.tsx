'use client';

import { useState, useCallback, useEffect, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

const OPEN_MODAL_SELECTOR =
  '[data-slot="dialog-content"][data-state="open"], [data-slot="dropdown-menu-content"][data-state="open"], [data-slot="sheet-content"][data-state="open"], [data-slot="drawer-content"][data-state="open"]';

export function clearStaleBodyPointerEvents(): void {
  if (
    typeof document === 'undefined' ||
    !document.body?.style ||
    document.body.style.pointerEvents !== 'none'
  ) {
    return;
  }
  const hasOpenModal =
    typeof document.querySelector === 'function' &&
    Boolean(document.querySelector(OPEN_MODAL_SELECTOR));
  if (!hasOpenModal) {
    document.body.style.pointerEvents = '';
  }
}

interface ConfirmState {
  open: boolean;
  message: string;
  title?: string;
  confirmLabel?: string;
  destructive?: boolean;
  resolve: (value: boolean) => void;
}

/** Promise-based confirmation hook replacing native window.confirm()
 * to preserve keyboard focus state. */
export function useConfirm() {
  const t = useTranslations('common');
  const [state, setState] = useState<ConfirmState | null>(null);

  useEffect(() => {
    if (!state?.open) {
      clearStaleBodyPointerEvents();
      return;
    }
    return () => {
      clearStaleBodyPointerEvents();
      if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
        window.setTimeout(clearStaleBodyPointerEvents, 0);
      }
    };
  }, [state?.open]);

  const confirm = useCallback(
    (
      message: string,
      options?: {
        title?: string;
        confirmLabel?: string;
        destructive?: boolean;
      },
    ): Promise<boolean> => {
      clearStaleBodyPointerEvents();
      return new Promise((resolve) => {
        setState((previous) => {
          previous?.resolve(false);
          return {
            open: true,
            message,
            title: options?.title,
            confirmLabel: options?.confirmLabel,
            destructive: options?.destructive,
            resolve,
          };
        });
      });
    },
    [],
  );

  const handleConfirm = useCallback(() => {
    const resolve = state?.resolve;
    setState(null);
    clearStaleBodyPointerEvents();
    if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
      window.setTimeout(clearStaleBodyPointerEvents, 0);
    }
    resolve?.(true);
  }, [state]);

  const handleCancel = useCallback(() => {
    const resolve = state?.resolve;
    setState(null);
    clearStaleBodyPointerEvents();
    if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
      window.setTimeout(clearStaleBodyPointerEvents, 0);
    }
    resolve?.(false);
  }, [state]);

  const ConfirmDialog: ReactNode = state ? (
    <Dialog open={state.open} onOpenChange={(open) => !open && handleCancel()}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{state.title || t('confirm')}</DialogTitle>
          <DialogDescription className="whitespace-pre-line">{state.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            {t('cancel')}
          </Button>
          <Button variant={state.destructive ? 'destructive' : 'default'} onClick={handleConfirm}>
            {state.confirmLabel || t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null;

  return { confirm, ConfirmDialog, isConfirmOpen: state !== null };
}

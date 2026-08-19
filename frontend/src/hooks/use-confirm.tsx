'use client';

import { useState, useCallback, type ReactNode } from 'react';
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

interface ConfirmState {
  open: boolean;
  message: string;
  title?: string;
  confirmLabel?: string;
  destructive?: boolean;
  resolve: (value: boolean) => void;
}

/**
 * Promise-based confirmation hook — replaces window.confirm() which breaks
 * keyboard focus on Windows after the native dialog closes.
 *
 * Usage:
 *   const { confirm, ConfirmDialog } = useConfirm();
 *
 *   const handleDelete = async (id: number) => {
 *     if (!await confirm('Delete this item?')) return;
 *     await api.delete(`/items/${id}`);
 *   };
 *
 *   return (
 *     <>
 *       {ConfirmDialog}
 *       <button onClick={() => handleDelete(1)}>Delete</button>
 *     </>
 *   );
 */
export function useConfirm() {
  const t = useTranslations('common');
  const [state, setState] = useState<ConfirmState | null>(null);

  const confirm = useCallback(
    (
      message: string,
      options?: {
        title?: string;
        confirmLabel?: string;
        destructive?: boolean;
      },
    ): Promise<boolean> => {
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
    state?.resolve(true);
    setState(null);
  }, [state]);

  const handleCancel = useCallback(() => {
    state?.resolve(false);
    setState(null);
  }, [state]);

  const ConfirmDialog: ReactNode = state ? (
    <Dialog open={state.open} onOpenChange={(open) => !open && handleCancel()}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{state.title || t('confirm')}</DialogTitle>
          <DialogDescription>{state.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            {t('cancel')}
          </Button>
          <Button
            variant={state.destructive ? 'destructive' : 'default'}
            onClick={handleConfirm}
          >
            {state.confirmLabel || t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null;

  return { confirm, ConfirmDialog };
}

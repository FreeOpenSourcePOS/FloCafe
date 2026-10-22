import { useEffect, useRef } from 'react';

export interface PosKeyboardShortcutHandlers {
  onFocusSearch: () => void;
  onTender: () => void;
  onToggleTables?: () => void;
  onOpenCheckout?: () => void;
  onOpenCashMovement?: () => void;
  onFocusCustomer?: () => void;
  onHoldOrder?: () => void;
  onToggleFullscreen?: () => void;
  onDismissModalOrBlur: () => boolean;
  onIncrementLastItem?: () => void;
  onDecrementLastItem?: () => void;
  onClearCart?: () => void;
  onShowHelp?: () => void;
}

export interface UsePosKeyboardShortcutsOptions {
  enabled?: boolean;
  anyModalOpen: boolean;
  tablePickerOpen: boolean;
  cartItemCount: number;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (name: string) => string | null;
  };
  const tag = el.tagName?.toUpperCase();
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    Boolean(el.isContentEditable) ||
    el.getAttribute?.('role') === 'textbox'
  );
}

export function usePosKeyboardShortcuts(
  handlers: PosKeyboardShortcutHandlers,
  options: UsePosKeyboardShortcutsOptions,
) {
  const { enabled = true, anyModalOpen, tablePickerOpen, cartItemCount } = options;
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput = isTypingTarget(target);
      const noModifiers = !e.ctrlKey && !e.metaKey && !e.altKey;
      const isPlainKey = noModifiers && !e.shiftKey;
      const isAltChord = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      const isAltDigit = (digit: '2' | '4') =>
        isAltChord && (e.code ? e.code === `Digit${digit}` : e.key === digit);

      // 1. Universal keys (Escape, Fullscreen, Help)
      if (isPlainKey && e.key === 'Escape') {
        const handled = handlersRef.current.onDismissModalOrBlur();
        if (handled) {
          e.preventDefault();
          return;
        }
      }

      if (isPlainKey && e.key === 'F11') {
        e.preventDefault();
        handlersRef.current.onToggleFullscreen?.();
        return;
      }

      if (tablePickerOpen && ((isPlainKey && e.key === 'F2') || isAltDigit('2'))) {
        e.preventDefault();
        handlersRef.current.onToggleTables?.();
        return;
      }

      if (
        !anyModalOpen &&
        ((isPlainKey && e.key === 'F1') || (noModifiers && e.key === '?' && !isInput))
      ) {
        e.preventDefault();
        handlersRef.current.onShowHelp?.();
        return;
      }

      // 2. Modal Guard: suppress POS canvas shortcuts when modal is open
      if (anyModalOpen) {
        return;
      }

      // 3. Typing Immunity: suppress all single-key accelerators in inputs
      if (isInput) {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          handlersRef.current.onFocusSearch();
        }
        return;
      }

      // 5. Global POS shortcuts
      // Search Focus (/ or Cmd/Ctrl+K)
      if (
        (noModifiers && e.key === '/') ||
        ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k')
      ) {
        e.preventDefault();
        handlersRef.current.onFocusSearch();
        return;
      }

      // Quick Tender / Place Order (Space)
      if (isPlainKey && (e.key === ' ' || e.code === 'Space')) {
        if (target instanceof HTMLElement && target.matches('button, [role="button"]')) {
          return;
        }
        if (cartItemCount > 0) {
          e.preventDefault();
          if (e.repeat) return;
          handlersRef.current.onTender();
        }
        return;
      }

      // Tables / Floorplan: F2 or Alt+2
      if ((isPlainKey && e.key === 'F2') || isAltDigit('2')) {
        e.preventDefault();
        handlersRef.current.onToggleTables?.();
        return;
      }

      // Instant Checkout Modal: F4 or Alt+4
      if ((isPlainKey && e.key === 'F4') || isAltDigit('4')) {
        e.preventDefault();
        handlersRef.current.onOpenCheckout?.();
        return;
      }

      // Cash Drawer / Movement: F3
      if (isPlainKey && e.key === 'F3') {
        e.preventDefault();
        handlersRef.current.onOpenCashMovement?.();
        return;
      }

      // Customer Search Focus: F6
      if (isPlainKey && e.key === 'F6') {
        e.preventDefault();
        handlersRef.current.onFocusCustomer?.();
        return;
      }

      // Hold / Park Order: F8
      if (isPlainKey && e.key === 'F8') {
        e.preventDefault();
        handlersRef.current.onHoldOrder?.();
        return;
      }

      // Quantity adjustments on last added cart item (+ / -)
      if (
        noModifiers &&
        (e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd')
      ) {
        e.preventDefault();
        handlersRef.current.onIncrementLastItem?.();
        return;
      }

      if (
        noModifiers &&
        (e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract')
      ) {
        e.preventDefault();
        handlersRef.current.onDecrementLastItem?.();
        return;
      }

      // Cart Clear (Alt+Backspace)
      if (isAltChord && (e.key === 'Backspace' || e.key === 'Delete')) {
        e.preventDefault();
        handlersRef.current.onClearCart?.();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, anyModalOpen, tablePickerOpen, cartItemCount]);
}

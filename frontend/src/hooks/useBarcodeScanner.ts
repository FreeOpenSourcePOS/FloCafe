import { useEffect, useRef } from 'react';

/**
 * Detects input from a USB/Bluetooth barcode scanner acting as a "keyboard
 * wedge" — the common case, needing no special driver or WebUSB/serial API.
 * A scanner types the barcode's digits far faster than a human can, then
 * sends Enter. Distinguishes that from normal typing/keyboard shortcuts by
 * the gap between keystrokes, not by which element has focus, since a scan
 * can land while any input is focused (or none).
 *
 * See issue #137 — written to be reusable as-is for FloRetail/FloSalon, not
 * POS-specific.
 */
const MAX_INTER_KEY_MS = 60;
const MIN_CODE_LENGTH = 4;

export function useBarcodeScanner(onScan: (code: string) => void, enabled: boolean = true) {
  const bufferRef = useRef('');
  const lastKeyTimeRef = useRef(0);
  const onScanRef = useRef(onScan);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const now = Date.now();
      const gap = now - lastKeyTimeRef.current;
      lastKeyTimeRef.current = now;

      if (e.key === 'Enter') {
        const code = bufferRef.current;
        bufferRef.current = '';
        // A focused text field handles its own Enter (e.g. a search/barcode
        // box that does an exact-match lookup regardless of typing speed) —
        // defer to it instead of also firing here, or a real scanner typing
        // into a focused field would trigger both.
        const target = e.target as HTMLElement | null;
        const isTextInput = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
        if (!isTextInput && code.length >= MIN_CODE_LENGTH) {
          onScanRef.current(code);
        }
        return;
      }

      // Single printable character keys only — ignore Shift/Tab/Escape/etc,
      // and reject anything with modifiers (real shortcuts, not a scan).
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) {
        bufferRef.current = '';
        return;
      }

      // A gap this large means either the first keystroke of a new sequence,
      // or genuine human typing — either way, start a fresh buffer.
      bufferRef.current = gap > MAX_INTER_KEY_MS ? e.key : bufferRef.current + e.key;
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled]);
}

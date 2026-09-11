'use client';

import { useEffect } from 'react';

/** Blurs a number input when scrolled over it, so it can't be changed by accident. */
export function NumberInputWheelGuard() {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const el = e.target;
      if (el instanceof HTMLInputElement && el.type === 'number' && el === document.activeElement) el.blur();
    };
    document.addEventListener('wheel', onWheel, { passive: true });
    return () => document.removeEventListener('wheel', onWheel);
  }, []);
  return null;
}

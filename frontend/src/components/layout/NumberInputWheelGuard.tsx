'use client';

import { useEffect } from 'react';

/** Blurs a focused number input on scroll so it can't be changed by accident. */
export function NumberInputWheelGuard() {
  useEffect(() => {
    const onWheel = () => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement && el.type === 'number') el.blur();
    };
    document.addEventListener('wheel', onWheel, { passive: true });
    return () => document.removeEventListener('wheel', onWheel);
  }, []);
  return null;
}

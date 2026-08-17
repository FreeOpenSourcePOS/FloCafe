import type { ComponentProps, ElementType, ReactNode } from 'react';
import { cn } from '@/lib/utils';

type LtrProps<T extends ElementType> = {
  as?: T;
  className?: string;
  children?: ReactNode;
} & Omit<ComponentProps<T>, 'as' | 'className' | 'children'>;

/**
 * Explicit LTR island for content that must stay left-to-right inside RTL
 * pages: emails, URLs, IP addresses, pairing/technical codes, numeric
 * identifiers, paths, and version strings.
 *
 * Renders `dir="ltr"` with bidi isolation (via `.ltr-island`) so mixed
 * Persian/Latin content stays readable and copy/paste preserves the correct
 * character order. Defaults to a `<span>`; use `as="div"` for block content.
 *
 * Example:
 *   <Ltr>{customer.email}</Ltr>
 *   <Ltr as="div" className="text-xs">{pairingCode}</Ltr>
 */
export function Ltr<T extends ElementType = 'span'>({ as, className, children, ...props }: LtrProps<T>) {
  const Comp = (as ?? 'span') as ElementType;
  return (
    <Comp dir="ltr" className={cn('ltr-island', className)} {...props}>
      {children}
    </Comp>
  );
}

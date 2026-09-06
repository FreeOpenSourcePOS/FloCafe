import type { ComponentProps, ElementType, ReactNode } from 'react';
import { cn } from '@/lib/utils';

type LtrProps<T extends ElementType> = {
  as?: T;
  className?: string;
  children?: ReactNode;
} & Omit<ComponentProps<T>, 'as' | 'className' | 'children'>;

/** Explicit LTR island with bidi isolation for emails, URLs, IPs,
 * and codes inside RTL pages. */
export function Ltr<T extends ElementType = 'span'>({ as, className, children, ...props }: LtrProps<T>) {
  const Comp = (as ?? 'span') as ElementType;
  return (
    <Comp dir="ltr" className={cn('ltr-island', className)} {...props}>
      {children}
    </Comp>
  );
}

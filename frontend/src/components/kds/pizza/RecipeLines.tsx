import { AlertTriangle } from 'lucide-react';
import { RECIPE_NOT_PRINTED } from '@shared/pizza/ticket';
import { cn } from '@/lib/utils';

/**
 * The recipe of a pizza or deal line on the kitchen display: the kitchen ticket's lines as the
 * server wrote them. A line too wide for its card wraps one cell inside its own indent.
 */
export function RecipeLines({ lines, className }: { lines?: string[] | null; className?: string }) {
  if (!lines?.length) return null;
  return (
    <span
      dir="ltr"
      data-testid="kds-recipe-lines"
      className={cn('block text-start font-mono font-semibold text-foreground', className)}
    >
      {lines.map((line, index) => {
        if (line === RECIPE_NOT_PRINTED)
          return (
            <span
              key={index}
              data-testid="kds-recipe-warning"
              className="flex items-center gap-2 rounded-md bg-red-600 px-2 py-1 font-bold text-white"
            >
              <AlertTriangle size={18} className="shrink-0" aria-hidden="true" />
              {line}
            </span>
          );
        const indent = `${line.length - line.trimStart().length + 1}ch`;
        return (
          <span
            key={index}
            className="block whitespace-pre-wrap break-words"
            style={{ paddingInlineStart: indent, textIndent: `-${indent}` }}
          >
            {line}
          </span>
        );
      })}
    </span>
  );
}

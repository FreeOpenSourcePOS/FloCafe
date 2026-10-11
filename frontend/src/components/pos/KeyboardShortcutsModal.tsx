'use client';

import { X, Keyboard } from 'lucide-react';
import { useTranslations } from 'use-intl';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ShortcutEntry {
  keys: string[];
  description: string;
}

export default function KeyboardShortcutsModal({ open, onClose }: Props) {
  const tCommon = useTranslations('common');

  if (!open) return null;

  const shortcuts: { category: string; items: ShortcutEntry[] }[] = [
    {
      category: 'Speed Cashier & Tendering',
      items: [
        { keys: ['Space'], description: 'Place Order / Tender Cash in checkout' },
        { keys: ['F4', 'Alt + 4'], description: 'Open Checkout modal' },
        { keys: ['F2', 'Alt + 2'], description: 'Toggle Tables / Floorplan' },
        { keys: ['F8'], description: 'Hold / park active dine-in order' },
      ],
    },
    {
      category: 'Search & Catalog',
      items: [
        { keys: ['/'], description: 'Quick-focus product search' },
        { keys: ['Ctrl / ⌘', 'K'], description: 'Universal quick search' },
        { keys: ['3 *', '3 x'], description: 'Multiplier prefix in search (e.g. 3*latte)' },
        { keys: ['F6'], description: 'Focus customer search' },
      ],
    },
    {
      category: 'Cart & Adjustments',
      items: [
        { keys: ['+'], description: 'Increment quantity of last item' },
        { keys: ['-'], description: 'Decrement quantity of last item' },
        { keys: ['Alt', '⌫'], description: 'Clear active cart (with confirmation)' },
      ],
    },
    {
      category: 'Navigation & Controls',
      items: [
        { keys: ['Esc'], description: 'Clear search / dismiss active modal' },
        { keys: ['F11'], description: 'Toggle POS fullscreen' },
        { keys: ['F3'], description: 'Open cash movement / till drawer' },
        { keys: ['?', 'F1'], description: 'Show keyboard shortcuts guide' },
      ],
    },
  ];

  return (
    <div
      data-testid="keyboard-shortcuts-modal"
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
    >
      <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-xl max-h-[85vh] overflow-y-auto shadow-2xl">
        <div className="flex justify-between items-center mb-5 pb-3 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand/10 text-brand flex items-center justify-center">
              <Keyboard size={18} />
            </div>
            <div>
              <h2 className="text-base font-bold text-foreground">Keyboard Shortcuts</h2>
              <p className="text-xs text-muted-foreground">
                High-speed POS hotkeys for rapid cashier operation
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="touch-target rounded-full text-muted-foreground hover:text-foreground active:bg-muted"
            aria-label={tCommon('close')}
          >
            <X size={20} />
          </button>
        </div>

        <div className="space-y-5">
          {shortcuts.map((group) => (
            <div key={group.category} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {group.category}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {group.items.map((item, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-2 rounded-lg bg-muted/50 border border-border/50 text-xs"
                  >
                    <span className="text-foreground/80 font-medium pe-2 truncate">
                      {item.description}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      {item.keys.map((k, kIdx) => (
                        <kbd
                          key={kIdx}
                          className="px-2 py-0.5 rounded bg-background border border-border text-[11px] font-mono font-semibold text-foreground shadow-xs"
                        >
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 pt-3 border-t border-border flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-brand text-white text-xs font-semibold hover:bg-brand-hover active:bg-brand-hover transition-colors"
          >
            {tCommon('done')}
          </button>
        </div>
      </div>
    </div>
  );
}

import toast from 'react-hot-toast';
import type { PrintWarning } from './warnings';

/** Shows one amber toast listing every line a print job skipped, if any. */
export function showPrintWarningsToast(warnings: PrintWarning[]): void {
  if (warnings.length === 0) return;
  toast(warnings.map((warning) => warning.message).join('\n'), {
    duration: 7000,
    style: {
      background: '#fffbeb',
      color: '#b45309',
      border: '1px solid #fcd34d',
      whiteSpace: 'pre-line',
    },
  });
}

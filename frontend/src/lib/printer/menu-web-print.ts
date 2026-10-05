export interface MenuWebPrintSection {
  name: string | null;
  products: Array<{ name: string; price: string; details?: string[] }>;
}

export interface MenuWebPrintInput {
  businessName: string;
  printedAt: string;
  sections: MenuWebPrintSection[];
  itemCount: number;
  paperWidth?: 58 | 80;
  pageSize?: 'A4' | 'Letter';
  menuTitle: string;
  totalItemsLabel: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildMenuWebPrintHtml(input: MenuWebPrintInput): string {
  const selectedPageSize = input.pageSize === 'Letter' ? 'Letter' : 'A4';
  const width = input.paperWidth ? `${input.paperWidth}mm` : input.pageSize === 'Letter' ? '216mm' : '210mm';
  const pageSize = input.paperWidth ? `${width} auto` : `${selectedPageSize} portrait`;
  const sections = input.sections.map((section) => `
    ${section.name ? `<h2>${escapeHtml(section.name)}</h2>` : ''}
    <div class="items">${section.products.map((product) => `
      <div class="row"><span>${escapeHtml(product.name)}</span><span>${escapeHtml(product.price)}</span></div>
      ${(product.details || []).map((detail) => `<div class="detail">${escapeHtml(detail)}</div>`).join('')}
    `).join('')}</div>
  `).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.menuTitle)}</title>
  <style>
    @page { size: ${pageSize}; margin: ${input.paperWidth ? '3mm' : '14mm'}; }
    * { box-sizing: border-box; }
    body { color: #171717; font: 14px/1.4 Arial, sans-serif; margin: 0 auto; max-width: ${input.paperWidth ? width : '720px'}; padding: ${input.paperWidth ? '2mm' : '0'}; }
    header { border-bottom: 2px solid #171717; margin-bottom: 16px; padding-bottom: 10px; text-align: center; }
    h1 { font-size: 24px; letter-spacing: .12em; margin: 8px 0; }
    .date { color: #555; font-size: 12px; }
    h2 { border-bottom: 1px solid #999; font-size: 15px; margin: 18px 0 6px; padding-bottom: 3px; text-transform: uppercase; }
    .row { align-items: baseline; display: flex; gap: 8px; justify-content: space-between; padding: 3px 0; }
    .row span:first-child { min-width: 0; overflow-wrap: anywhere; }
    .row span:last-child { flex: 0 0 auto; text-align: right; white-space: nowrap; }
    .detail { color: #555; padding: 0 0 4px 12px; overflow-wrap: anywhere; }
    footer { border-top: 1px solid #999; font-size: 12px; margin-top: 18px; padding-top: 8px; text-align: center; }
    @media print { body { max-width: ${input.paperWidth ? width : 'none'}; } }
  </style>
</head>
<body>
  <header>
    <div>${escapeHtml(input.businessName)}</div>
    <h1>${escapeHtml(input.menuTitle)}</h1>
    <div class="date">${escapeHtml(input.printedAt)}</div>
  </header>
  <main>${sections}</main>
  <footer>${escapeHtml(input.totalItemsLabel)}: ${input.itemCount}<br>Powered by FloCafe</footer>
</body>
</html>`;
}

export class MenuPopupBlockedError extends Error {}

/**
 * Holds the user gesture a popup blocker would otherwise consume.
 *
 * The print request crosses an await, so a window opened after it would be
 * blocked. The desktop runtime has no blocker to defeat - its window-open
 * handler decides every popup outright - so opening one there bought nothing
 * and cost the cashier a flash of an empty window on every successful print,
 * a window that a physical printer never used. Where a blocker does exist the
 * reservation is still made, synchronously, before the request goes out.
 */
export function reservePrintGesture(host: Window = window): Window | null {
  if (host.electronAPI) return null;
  try {
    return host.open('', '_blank');
  } catch {
    return null;
  }
}

export function printMenuInBrowser(html: string, targetWindow?: Window | null): void {
  const printWindow = targetWindow !== undefined ? targetWindow : window.open('', '_blank');
  if (!printWindow || printWindow.closed) throw new MenuPopupBlockedError('Allow pop-ups to use browser printing');
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}

export type MenuTemplate = 'mobile-cafe' | 'classic-bistro' | 'standard';

export interface MenuWebPrintSection {
  name: string | null;
  products: Array<{ name: string; price: string; details?: string[]; imageUrl?: string | null }>;
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
  template?: MenuTemplate;
  customerFacing?: boolean;
  logoDataUrl?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeImageDataUrl(value: string | null | undefined): string | null {
  if (!value || !/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(value))
    return null;
  return value;
}

function renderProduct(product: MenuWebPrintSection['products'][number]): string {
  const image = safeImageDataUrl(product.imageUrl);
  return `<article class="item">${image ? `<img class="product-photo" src="${escapeHtml(image)}" alt="">` : ''}<div class="item-copy">
    <div class="row"><span class="item-name">${escapeHtml(product.name)}</span><span class="leader" aria-hidden="true"></span><span class="price">${escapeHtml(product.price)}</span></div>
    ${(product.details || []).map((detail) => `<div class="detail">${escapeHtml(detail)}</div>`).join('')}</div></article>`;
}

export function buildMenuWebPrintHtml(input: MenuWebPrintInput): string {
  const template: MenuTemplate =
    input.template === 'mobile-cafe' || input.template === 'classic-bistro'
      ? input.template
      : 'standard';
  const selectedPageSize = input.pageSize === 'Letter' ? 'Letter' : 'A4';
  const mobile = template === 'mobile-cafe';
  const classic = template === 'classic-bistro';
  const width = input.paperWidth
    ? `${input.paperWidth}mm`
    : mobile
      ? '105mm'
      : selectedPageSize === 'Letter'
        ? '216mm'
        : '210mm';
  const pageSize = input.paperWidth
    ? `${width} auto`
    : mobile
      ? '105mm auto'
      : `${selectedPageSize} portrait`;
  const customerFacing = input.customerFacing === true;
  const logo = safeImageDataUrl(input.logoDataUrl);
  const sections = input.sections
    .map(
      (section) => `<section class="menu-section">
    ${section.name ? `<h2>${escapeHtml(section.name)}</h2>` : ''}
    <div class="items">${section.products.map(renderProduct).join('')}</div>
  </section>`,
    )
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.menuTitle)}</title><style>
    @page { size: ${pageSize}; margin: ${input.paperWidth ? '3mm' : mobile ? '8mm' : '14mm'}; }
    * { box-sizing: border-box; } body { color: ${classic ? '#29231f' : '#171717'}; font: 14px/1.45 ${classic ? 'Georgia, serif' : 'Arial, sans-serif'}; margin: 0 auto; max-width: ${input.paperWidth ? width : mobile ? '105mm' : '720px'}; padding: ${input.paperWidth ? '2mm' : mobile ? '4mm' : '0'}; }
    header { border-bottom: ${mobile ? '0' : '2px solid currentColor'}; margin-bottom: 16px; padding-bottom: 10px; text-align: center; }
    .logo { display: block; height: ${mobile ? '64px' : '72px'}; margin: 0 auto 10px; max-width: 55%; object-fit: contain; }
    .business { color: ${mobile ? '#925f34' : 'inherit'}; font-size: ${mobile ? '15px' : '14px'}; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { font-size: ${mobile ? '30px' : classic ? '30px' : '24px'}; letter-spacing: ${classic ? '.06em' : '.12em'}; margin: 8px 0; } .date { color: #666; font-size: 12px; }
    main { ${classic ? 'column-count: 2; column-gap: 28px;' : ''} } .menu-section { break-inside: avoid; margin-bottom: 16px; }
    h2 { ${mobile ? 'background: #f3dfc9; border-radius: 8px; color: #704421; padding: 8px 10px;' : classic ? 'border-bottom: 2px solid #7c6758; border-top: 1px solid #b9a99d; padding: 7px 0;' : 'border-bottom: 1px solid #999; padding-bottom: 3px;'} font-size: ${mobile ? '18px' : '15px'}; margin: 18px 0 8px; text-transform: uppercase; }
    .item { align-items: flex-start; display: flex; gap: 10px; padding: ${mobile ? '8px 2px' : '4px 0'}; } .product-photo { border-radius: 8px; flex: 0 0 auto; height: ${mobile ? '58px' : '48px'}; object-fit: cover; width: ${mobile ? '58px' : '48px'}; }
    .item-copy { min-width: 0; width: 100%; } .row { align-items: baseline; display: flex; gap: 8px; justify-content: space-between; } .item-name { font-weight: ${mobile ? '700' : 'inherit'}; min-width: 0; overflow-wrap: anywhere; }
    .leader { ${classic ? 'border-bottom: 1px dotted #8f8177; flex: 1 1 auto;' : 'display: none;'} } .price { ${mobile ? 'background: #fff1df; border-radius: 999px; color: #6d3f1c; font-weight: 700; padding: 2px 8px;' : ''} flex: 0 0 auto; text-align: right; white-space: nowrap; }
    .detail { color: #666; font-size: ${mobile ? '13px' : 'inherit'}; padding: 2px 0 3px ${mobile ? '0' : '12px'}; overflow-wrap: anywhere; } footer { border-top: 1px solid #999; font-size: 12px; margin-top: 18px; padding-top: 8px; text-align: center; }
    @media print { body { max-width: ${input.paperWidth ? width : mobile ? '105mm' : 'none'}; } }
  </style></head><body data-menu-template="${template}"><header>${logo ? `<img class="logo" src="${escapeHtml(logo)}" alt="">` : ''}<div class="business">${escapeHtml(input.businessName)}</div><h1>${escapeHtml(input.menuTitle)}</h1>${customerFacing ? '' : `<div class="date">${escapeHtml(input.printedAt)}</div>`}</header><main>${sections}</main>${customerFacing ? '<footer>Powered by FloCafe</footer>' : `<footer>${escapeHtml(input.totalItemsLabel)}: ${input.itemCount}<br>Powered by FloCafe</footer>`}</body></html>`;
}

export function buildQrTableCardHtml(input: {
  businessName: string;
  logoDataUrl?: string | null;
  qrDataUrl: string;
  scanPrompt: string;
}): string {
  const qrDataUrl = safeImageDataUrl(input.qrDataUrl);
  if (!qrDataUrl) throw new Error('Invalid QR image');
  const logo = safeImageDataUrl(input.logoDataUrl);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(input.scanPrompt)}</title><style>@page{size:A5 portrait;margin:10mm}*{box-sizing:border-box}body{align-items:center;color:#2c2119;display:flex;font-family:Arial,sans-serif;justify-content:center;margin:0;min-height:180mm;text-align:center}.card{border:3px solid #8d6038;border-radius:18px;padding:18mm 12mm;width:100%}.logo{height:24mm;max-width:60%;object-fit:contain}h1{font-size:24px;margin:8px 0 18px}.qr{height:90mm;image-rendering:pixelated;width:90mm}p{font-size:20px;font-weight:700;margin:16px 0 0}</style></head><body><main class="card">${logo ? `<img class="logo" src="${escapeHtml(logo)}" alt="">` : ''}<h1>${escapeHtml(input.businessName)}</h1><img class="qr" src="${escapeHtml(qrDataUrl)}" alt=""><p>${escapeHtml(input.scanPrompt)}</p></main></body></html>`;
}

export class MenuPopupBlockedError extends Error {}

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
  if (!printWindow || printWindow.closed)
    throw new MenuPopupBlockedError('Allow pop-ups to use browser printing');
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}

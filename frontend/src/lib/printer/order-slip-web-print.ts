/** Minimal unbranded HTML renderer for the tableside terminal's "no printer configured" browser-print fallback. */

import type { Order } from '@/lib/types';
import { formatCurrencyForTenant } from '@/lib/countries';
import { escapeHtml } from './web-print';

export interface OrderSlipWebPrintOptions {
  /** 58 mm or 80mm paper. Controls font sizing. Default: 58 */
  paperWidth?: 58 | 80;
  country?: string;
  currency?: string;
}

export interface OrderSlipLabels {
  title: string;
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
}

/** Renders order.subtotal/tax_amount/total as already computed by the backend — no tax math happens here. */
export function generateOrderSlipHtml(order: Order, labels: OrderSlipLabels, opts: OrderSlipWebPrintOptions = {}): string {
  const paperWidth = opts.paperWidth ?? 58;
  const fontSize = paperWidth === 58 ? '10px' : '12px';
  const padding = paperWidth === 58 ? '4px' : '6px';
  const paperWidthCss = paperWidth === 58 ? '58mm' : '80mm';
  const money = (value: unknown) => formatCurrencyForTenant(Number(value || 0), opts.country, opts.currency || 'INR');

  const items = order.items ?? [];
  const itemRows = items.map((item) => `
    <div style="margin:${padding} 0;display:flex;justify-content:space-between;gap:8px;">
      <span>${escapeHtml(item.quantity)}x ${escapeHtml(item.product_name)}</span>
      <span>${escapeHtml(money(item.subtotal ?? item.unit_price * item.quantity))}</span>
    </div>
    ${(item.addons ?? []).filter((addon) => addon?.name).map((addon) => `
      <div style="padding-inline-start:1em;display:flex;justify-content:space-between;gap:8px;color:#444;">
        <span>+ ${escapeHtml(addon.name)}${(addon.quantity ?? 1) > 1 ? ` x${escapeHtml(addon.quantity)}` : ''}</span>
        ${addon.price ? `<span>${escapeHtml(money(addon.price))}</span>` : ''}
      </div>
    `).join('')}
    ${item.special_instructions ? `<div style="padding-inline-start:1em;font-style:italic;">&gt;&gt; ${escapeHtml(item.special_instructions)}</div>` : ''}
  `).join('');

  return `
    <div style="width:100%;max-width:${paperWidthCss};min-width:0;box-sizing:border-box;overflow-wrap:anywhere;word-break:break-word;padding:${padding};font-family:'Courier New',monospace;font-size:${fontSize};">
      <h2 style="margin:0 0 ${padding} 0;font-size:${paperWidth === 58 ? '14px' : '16px'};text-align:center;">${escapeHtml(labels.title)}</h2>
      <p style="margin:2px 0;font-weight:bold;">#${escapeHtml(order.order_number)}</p>
      ${order.table?.name ? `<p style="margin:2px 0;">${escapeHtml(order.table.name)}</p>` : ''}
      <hr style="border:1px dashed #000;margin:${padding} 0;">
      ${itemRows}
      <hr style="border:1px dashed #000;margin:${padding} 0;">
      <div style="display:flex;justify-content:space-between;"><span>${escapeHtml(labels.subtotal)}</span><span>${escapeHtml(money(order.subtotal))}</span></div>
      ${order.discount_amount ? `<div style="display:flex;justify-content:space-between;"><span>${escapeHtml(labels.discount)}</span><span>-${escapeHtml(money(order.discount_amount))}</span></div>` : ''}
      ${order.tax_amount ? `<div style="display:flex;justify-content:space-between;"><span>${escapeHtml(labels.tax)}</span><span>${escapeHtml(money(order.tax_amount))}</span></div>` : ''}
      <div style="display:flex;justify-content:space-between;font-weight:bold;margin-top:${padding};"><span>${escapeHtml(labels.total)}</span><span>${escapeHtml(money(order.total))}</span></div>
    </div>
  `;
}

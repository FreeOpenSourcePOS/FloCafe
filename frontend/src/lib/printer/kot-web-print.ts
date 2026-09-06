/** Semantic Kitchen Order Ticket HTML renderer for the browser print dialog. */

import type { Order } from '@/lib/types';
import { createTranslator } from 'use-intl/core';
import { getCachedMessages } from '@/lib/i18n/loader';
import { LANGUAGES, getLanguageDirection, type Language } from '@/lib/i18n/languages';
import { defaultPrintLanguagePolicy, resolveKotLanguage } from '@print/policy';
import { directionalText, isKotItemPending, type DirectionalText } from '@print/document';
import { containsRtlScript } from '@print/direction';
import type { TextDirection } from '@print/types';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useAuthStore } from '@/store/auth';
import { formatTime } from './format-date';
import { escapeHtml } from './web-print';

export interface KotWebPrintOptions {
  /** 58 mm or 80mm paper. Controls font sizing. Default: 58 */
  paperWidth?: 58 | 80;
  /** UI/receipt language (defaults to the client KOT language policy). */
  language?: Language;
  /** Kitchen station name to print on the ticket. */
  stationName?: string;
  /** Store timezone used for business-local time formatting. */
  timezone?: string;
}

/** Resolve the KOT ticket language: fixed policy language or the UI language. */
export function resolveKotTicketLanguage(language?: Language): Language {
  if (language) return language;
  try {
    const store = usePosSettingsStore.getState();
    const uiLanguage = store.language;
    return resolveKotLanguage(store.kotLanguagePolicy ?? defaultPrintLanguagePolicy(), uiLanguage) as Language;
  } catch {
    return 'en';
  }
}
function translatorFor(lang: Language): ((key: string) => string) {
  const locale = LANGUAGES[lang]?.locale ?? 'en';
  const messages = getCachedMessages(lang) ?? getCachedMessages('en') ?? {};
  return createTranslator({ locale, messages }) as unknown as (key: string) => string;
}

/** Render one kernel-annotated value with bidi-isolated LTR span inside RTL tickets. */
function directionalValue(value: DirectionalText, base: TextDirection): string {
  if (value.direction === 'ltr' && base === 'rtl') {
    return `<span dir="ltr" style="direction:ltr;unicode-bidi:isolate;">${escapeHtml(value.text)}</span>`;
  }
  return escapeHtml(value.text);
}

function detectTicketDirection(lang: Language): TextDirection {
  try {
    return getLanguageDirection(lang);
  } catch {
    const sample = translatorFor(lang)('print.kot.banner');
    return containsRtlScript(sample) ? 'rtl' : 'ltr';
  }
}

/** Strip the `{name}` placeholder (and its separator) from an interpolated label. */
function labelWithoutPlaceholder(label: string): string {
  return label.replace('{name}', '').replace(/[:：]\s*$/, '').trim();
}

function formatOrderNumberLabel(label: string, orderNumber: DirectionalText, base: TextDirection): string {
  const placeholder = '{number}';
  const position = label.indexOf(placeholder);
  if (position === -1) return escapeHtml(label + ': ') + directionalValue(orderNumber, base);
  return escapeHtml(label.slice(0, position)) + directionalValue(orderNumber, base) + escapeHtml(label.slice(position + placeholder.length));
}

function resolveKotTimezone(timezone?: string): string | undefined {
  if (timezone) return timezone;
  try {
    return useAuthStore.getState().currentTenant?.timezone ?? undefined;
  } catch {
    return undefined;
  }
}

function resolveOrderType(type: unknown, language: Language, tr: (key: string) => string): string {
  const keys: Record<string, string> = {
    dine_in: 'pos.orderTypeDineIn',
    delivery: 'pos.orderTypeDelivery',
    online: 'pos.orderTypeOnline',
    takeaway: 'pos.orderTypeTakeaway',
  };
  const normalized = String(type ?? '').trim();
  const key = keys[normalized];
  if (!key) return normalized.replace(/_/g, ' ').toUpperCase();
  return tr(key);
}

/** Generate the semantic KOT HTML fragment (without opening a print dialog). */
export function generateKotHtml(
  order: Order,
  opts: KotWebPrintOptions = {}
): string {
  const paperWidth = opts.paperWidth ?? 58;
  const lang = resolveKotTicketLanguage(opts.language);
  const tr = translatorFor(lang);
  const base = detectTicketDirection(lang);
  const timezone = resolveKotTimezone(opts.timezone);

  const fontSize = paperWidth === 58 ? '10px' : '12px';
  const padding = paperWidth === 58 ? '4px' : '6px';
  const locale = LANGUAGES[lang]?.locale ?? 'en-US';

  // Header facts annotated by the direction kernel.
  const orderNumber = directionalText(String(order.order_number ?? ''), base);
  const createdAt = String(order.created_at ?? '');
  const stationName = String(opts.stationName ?? '');

  const orderType = resolveOrderType(order.type, lang, tr);

  const items = (order.items ?? [])
    .filter((item) => isKotItemPending(item.status))
    .map((item) => ({
      name: directionalText(String(item.product_name ?? ''), base),
      quantity: Number(item.quantity) || 0,
      addons: (Array.isArray(item.addons) ? item.addons : []).filter((addon) => addon?.name),
      specialInstructions: item.special_instructions
        ? directionalText(String(item.special_instructions), base)
        : null,
    }));

  const itemRows = items.length > 0
    ? items.map((item) => `
        <div style="margin:${padding} 0;">
          <div style="font-weight:bold;">${escapeHtml(item.quantity)}x ${directionalValue(item.name, base)}</div>
          ${item.addons.map((addon) => {
            const qty = ('quantity' in addon && typeof addon.quantity === 'number' && addon.quantity) || 1;
            const suffix = qty > 1 ? ` x${qty}` : '';
            return `<div style="padding-inline-start:1em;">+ ${escapeHtml(addon.name)}${escapeHtml(suffix)}</div>`;
          }).join('')}
          ${item.specialInstructions ? `<div style="padding-inline-start:1em;font-style:italic;">&gt;&gt; ${directionalValue(item.specialInstructions, base)}</div>` : ''}
        </div>
      `).join('')
    : `<div style="margin:${padding} 0;">${escapeHtml(tr('print.kot.noPendingItems'))}</div>`;

  return `
    <div class="kot-container" dir="${base}" style="text-align:start;padding:${padding};font-family:'Courier New',monospace;font-size:${fontSize};">
      <h2 style="margin:0 0 ${padding} 0;font-size:${paperWidth === 58 ? '14px' : '16px'};text-align:center;">${escapeHtml(tr('print.kot.banner'))}</h2>
      ${stationName ? `<p style="margin:2px 0;">${escapeHtml(tr('print.kot.station'))}: ${directionalValue(directionalText(stationName, base), base)}</p>` : ''}
      <p style="margin:2px 0;font-weight:bold;">${formatOrderNumberLabel(tr('pos.orderNumber'), orderNumber, base)}</p>
      ${order.table?.name ? `<p style="margin:2px 0;">${escapeHtml(labelWithoutPlaceholder(tr('pos.tableLabel')))}: ${directionalValue(directionalText(String(order.table.name), base), base)}</p>` : ''}
      ${orderType ? `<p style="margin:2px 0;">${escapeHtml(tr('print.kot.type'))}: ${escapeHtml(orderType)}</p>` : ''}
      ${order.customer?.name ? `<p style="margin:2px 0;">${escapeHtml(tr('pos.customer'))}: ${directionalValue(directionalText(String(order.customer.name), base), base)}</p>` : ''}
      <p style="margin:2px 0;">${escapeHtml(`${tr('print.time')}: ${formatTime(createdAt, locale, timezone ? { timeZone: timezone } : undefined)}`)}</p>
      <hr style="border:1px dashed #000;margin:${padding} 0;">
      ${itemRows}
      <hr style="border:1px dashed #000;margin:${padding} 0;">
      <p style="margin:2px 0;text-align:center;">${escapeHtml(`--- ${tr('print.kot.end')} ---`)}</p>
    </div>
  `;
}

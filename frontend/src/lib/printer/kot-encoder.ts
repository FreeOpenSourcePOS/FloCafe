/**
 * kot-encoder.ts
 *
 * Converts a Flo POS Order into a Kitchen Order Ticket (KOT) ESC/POS byte array.
 * KOTs are printed in the kitchen to show what items need to be prepared.
 */

import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';
import type { Order } from '@/lib/types';
import { formatTime } from './format-date';

export interface KotOptions {
  /** 58 mm (32 chars) or 80 mm (48 chars). Default: 58 */
  paperWidth?: 58 | 80;
  /** Kitchen station name to print on KOT */
  stationName?: string;
}

const CHARS: Record<58 | 80, number> = { 58: 32, 80: 48 };

/**
 * Build a KOT byte array from an Order object.
 * The Order must have `items` populated.
 */
export function buildKotBytes(
  order: Order,
  opts: KotOptions = {}
): Uint8Array {
  const { paperWidth = 58 } = opts;
  const cols = CHARS[paperWidth];

  const enc = new ReceiptPrinterEncoder({ columns: cols });

  // ── KOT Header ───────────────────────────────────────────────────────────────
  enc.initialize();

  // KOT Banner
  enc.align('center').bold(true).width(2).height(2).text('KOT').width(1).height(1).bold(false).newline();

  // Order details
  enc.align('left').bold(true);
  enc.text(`Order #${order.order_number}`).newline();

  if (order.table) {
    enc.text(`Table: ${order.table.name}`).newline();
  }

  const orderType = order.type.replace('_', ' ').toUpperCase();
  enc.text(`Type: ${orderType}`).newline();

  if (order.customer) {
    enc.text(`Customer: ${order.customer.name}`).newline();
  }

  enc.bold(false);
  enc.text(formatTime(order.created_at)).newline();
  enc.rule({ style: 'double' });

  // ── Items ────────────────────────────────────────────────────────────────────
  const items = order.items ?? [];
  let hasItems = false;

  for (const item of items) {
    // Skip items that are already served/completed
    if (item.status === 'served' || item.status === 'ready') {
      continue;
    }

    hasItems = true;

    // Item name with quantity
    const qtyName = `${item.quantity}x ${item.product_name}`;
    enc.bold(true).text(truncate(qtyName, cols)).newline();
    enc.bold(false);

    // Addons
    if (item.addons && item.addons.length > 0) {
      for (const addon of item.addons) {
        enc.text(`   + ${truncate(addon.name, cols - 4)}`).newline();
      }
    }

    // Special instructions
    if (item.special_instructions) {
      enc.text(`   >> ${truncate(item.special_instructions, cols - 6)}`).newline();
    }

    enc.newline();
  }

  if (!hasItems) {
    enc.text('(No pending items)').newline();
  }

  // ── Footer ─────────────────────────────────────────────────────────────────
  enc.rule({ style: 'single' });
  enc.align('center').text('--- End of KOT ---').newline();

  enc.newline().newline().newline().cut();

  return enc.encode();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/**
 * Add-on inventory helpers.
 *
 * Sold-out and low-stock gating are pure so the POS modal and its tests agree
 * on one rule: only a tracked add-on is limited by stock. An untracked add-on
 * sells at zero, exactly as an untracked product does.
 */

import type { Addon } from '@/lib/types';

/** A tracked add-on with no stock left cannot be sold. */
export function isAddonSoldOut(addon: Addon): boolean {
  return Boolean(addon.track_inventory) && Number(addon.stock_quantity) <= 0;
}

/**
 * A tracked add-on at or below its reorder threshold still sells, but the
 * cashier is told it is running low. Sold out wins over low so a zero-stock
 * add-on never carries both badges, matching the product grid.
 */
export function isAddonLowStock(addon: Addon): boolean {
  if (!addon.track_inventory || isAddonSoldOut(addon)) return false;
  return Number(addon.stock_quantity) <= Number(addon.low_stock_threshold ?? 0);
}

/**
 * The most of a tracked add-on the cashier may dial into one line, or null when
 * stock does not limit the selection.
 */
export function addonStockCeiling(addon: Addon): number | null {
  if (!addon.track_inventory) return null;
  return Math.max(0, Number(addon.stock_quantity));
}
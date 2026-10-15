/**
 * Order item status rules shared by the backend and the renderer: the two
 * tax-components implementations keep separate numeric policies, but they must
 * not disagree about which items count on a printed document.
 */

/** Item statuses excluded from active order calculations and printed tax. */
export const TERMINAL_ITEM_STATUSES: string[] = [
  'cancelled',
  'voided',
  'void_adjustment',
  'refunded',
];

export function isTerminalItemStatus(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL_ITEM_STATUSES.includes(status);
}

/**
 * Item statuses excluded from printed bill item lists.
 * Cancelled, voided, and negative void_adjustment rows are excluded, while
 * refunded rows remain on historical bill copies whose stored totals include them.
 */
export function isExcludedFromBillReceipt(status: unknown): boolean {
  return status !== 'refunded' && isTerminalItemStatus(status);
}

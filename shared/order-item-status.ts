/**
 * Order item status rules shared by the backend and the renderer: the two
 * tax-components implementations keep separate numeric policies, but they must
 * not disagree about which items count on a printed document.
 */

/** Item statuses excluded from active order calculations and printed tax. */
export const TERMINAL_ITEM_STATUSES: string[] = ['cancelled', 'voided', 'void_adjustment', 'refunded'];

export function isTerminalItemStatus(status: string | null | undefined): boolean {
  return !!status && TERMINAL_ITEM_STATUSES.includes(status);
}

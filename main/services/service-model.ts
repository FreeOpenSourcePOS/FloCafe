import type { getDatabase } from '../db';

export const VALID_SERVICE_MODELS = new Set(['qsr', 'finedine', 'hybrid']);

export type ServiceModel = 'qsr' | 'finedine' | 'hybrid';

type Db = ReturnType<typeof getDatabase>;

function readSetting(db: Db, key: string): string | undefined {
  return (
    db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  )?.value;
}

/**
 * Hybrid venues run a counter and a dining room together: only dine-in orders are paid after
 * service. Every other mode keeps the single global `billing_type`.
 */
export function isOrderPrepaid(db: Db, orderType: string | null | undefined): boolean {
  if (readSetting(db, 'service_model') === 'hybrid') return orderType !== 'dine_in';
  return readSetting(db, 'billing_type') === 'prepaid';
}

export function isOrderPrepaidById(db: Db, orderId: string | number): boolean {
  const order = db.prepare('SELECT type FROM orders WHERE id = ?').get(orderId) as
    | { type?: string | null }
    | undefined;
  return isOrderPrepaid(db, order?.type);
}

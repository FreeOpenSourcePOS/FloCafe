export const SERVICE_CHARGE_ORDER_TYPES = ['dine_in', 'takeaway', 'delivery', 'online'] as const;

export type ServiceChargeOrderType = typeof SERVICE_CHARGE_ORDER_TYPES[number];

export const DEFAULT_SERVICE_CHARGE_ORDER_TYPES: ServiceChargeOrderType[] = ['dine_in'];

function isServiceChargeOrderType(value: unknown): value is ServiceChargeOrderType {
  return typeof value === 'string'
    && (SERVICE_CHARGE_ORDER_TYPES as readonly string[]).includes(value);
}

export function parseServiceChargeOrderTypes(value: unknown): ServiceChargeOrderType[] {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
  }
  if (!Array.isArray(parsed)) return [...DEFAULT_SERVICE_CHARGE_ORDER_TYPES];
  return [...new Set(parsed.filter(isServiceChargeOrderType))];
}

export function isServiceChargeEnabled(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function normalizeServiceChargeRate(value: unknown): number {
  const rate = typeof value === 'string' && value.trim() === '' ? 0 : Number(value);
  if (!Number.isFinite(rate)) return 0;
  return Math.min(100, Math.max(0, rate));
}

export function calculateServiceCharge(
  enabled: unknown,
  rate: unknown,
  orderTypes: unknown,
  orderType: unknown,
  netSubtotal: unknown,
  waived = false,
): number {
  if (waived || !isServiceChargeEnabled(enabled) || !isServiceChargeOrderType(orderType)) return 0;
  if (!parseServiceChargeOrderTypes(orderTypes).includes(orderType)) return 0;
  const subtotal = Math.max(0, Number(netSubtotal) || 0);
  return Number((subtotal * normalizeServiceChargeRate(rate) / 100).toFixed(2));
}

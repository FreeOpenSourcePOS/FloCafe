export const SERVICE_CHARGE_ORDER_TYPES = ['dine_in', 'takeaway', 'delivery', 'online'] as const;

export type ServiceChargeOrderType = typeof SERVICE_CHARGE_ORDER_TYPES[number];

export function calculateServiceCharge(
  enabled: boolean,
  rate: number,
  orderTypes: readonly ServiceChargeOrderType[],
  orderType: ServiceChargeOrderType,
  netSubtotal: number,
  waived = false,
): number {
  if (waived || !enabled || !orderTypes.includes(orderType)) return 0;
  return Number((Math.max(0, netSubtotal) * Math.min(100, Math.max(0, rate)) / 100).toFixed(2));
}

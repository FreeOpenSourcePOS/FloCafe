export const CUSTOMER_DISPLAY_STATUSES = ['pending', 'preparing', 'ready'] as const;

export type CustomerDisplayStatus = (typeof CUSTOMER_DISPLAY_STATUSES)[number];

export interface CustomerDisplayConfig {
  statuses: CustomerDisplayStatus[];
  refresh_seconds: number;
  show_updated: boolean;
}

export const CUSTOMER_DISPLAY_DEFAULTS: CustomerDisplayConfig = {
  statuses: [...CUSTOMER_DISPLAY_STATUSES],
  refresh_seconds: 3,
  show_updated: true,
};

export const CUSTOMER_DISPLAY_PATH = '/customer-display/';

export function isCustomerDisplayConfig(value: unknown): value is CustomerDisplayConfig {
  if (!value || typeof value !== 'object') return false;
  const { statuses, refresh_seconds, show_updated } = value as Record<string, unknown>;
  return (
    Array.isArray(statuses) &&
    statuses.length > 0 &&
    statuses.every((s) => (CUSTOMER_DISPLAY_STATUSES as readonly unknown[]).includes(s)) &&
    typeof refresh_seconds === 'number' &&
    typeof show_updated === 'boolean'
  );
}

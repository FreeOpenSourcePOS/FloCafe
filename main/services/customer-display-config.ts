export const CUSTOMER_DISPLAY_KEY = 'customer_display';
export const CUSTOMER_DISPLAY_STATUSES = ['pending', 'preparing', 'ready'] as const;
export const CUSTOMER_DISPLAY_ORDER_TYPES = ['takeaway', 'dine_in', 'online', 'delivery'] as const;
export type CustomerDisplayOrderType = (typeof CUSTOMER_DISPLAY_ORDER_TYPES)[number];

export interface CustomerDisplayConfig {
  statuses: Array<(typeof CUSTOMER_DISPLAY_STATUSES)[number]>;
  order_types: Array<(typeof CUSTOMER_DISPLAY_ORDER_TYPES)[number]>;
  refresh_seconds: number;
  show_updated: boolean;
}

export const CUSTOMER_DISPLAY_DEFAULTS: CustomerDisplayConfig = {
  statuses: [...CUSTOMER_DISPLAY_STATUSES],
  order_types: ['takeaway'],
  refresh_seconds: 3,
  show_updated: true,
};

function cloneDefaultCustomerDisplayConfig(): CustomerDisplayConfig {
  return {
    statuses: [...CUSTOMER_DISPLAY_DEFAULTS.statuses],
    order_types: [...CUSTOMER_DISPLAY_DEFAULTS.order_types],
    refresh_seconds: CUSTOMER_DISPLAY_DEFAULTS.refresh_seconds,
    show_updated: CUSTOMER_DISPLAY_DEFAULTS.show_updated,
  };
}

/** Returns the normalized config, or null when the payload is malformed. */
export function parseCustomerDisplayConfig(value: unknown): CustomerDisplayConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { statuses, order_types, refresh_seconds, show_updated } = value as Record<string, unknown>;
  if (
    !Array.isArray(statuses) ||
    statuses.length === 0 ||
    !statuses.every((status) => (CUSTOMER_DISPLAY_STATUSES as readonly unknown[]).includes(status))
  ) {
    return null;
  }
  let normalizedOrderTypes: CustomerDisplayOrderType[];
  if (order_types === undefined) {
    normalizedOrderTypes = [...CUSTOMER_DISPLAY_DEFAULTS.order_types];
  } else {
    if (
      !Array.isArray(order_types) ||
      order_types.length === 0 ||
      !order_types.every((orderType) =>
        (CUSTOMER_DISPLAY_ORDER_TYPES as readonly unknown[]).includes(orderType),
      )
    ) {
      return null;
    }
    normalizedOrderTypes = CUSTOMER_DISPLAY_ORDER_TYPES.filter((orderType) =>
      order_types.includes(orderType),
    );
  }
  if (
    typeof refresh_seconds !== 'number' ||
    !Number.isInteger(refresh_seconds) ||
    refresh_seconds < 2 ||
    refresh_seconds > 60
  ) {
    return null;
  }
  if (typeof show_updated !== 'boolean') return null;
  return {
    statuses: CUSTOMER_DISPLAY_STATUSES.filter((status) => statuses.includes(status)),
    order_types: normalizedOrderTypes,
    refresh_seconds,
    show_updated,
  };
}

/** Parses a stored settings value, falling back to defaults when absent or invalid. */
export function readStoredCustomerDisplayConfig(raw: string | undefined): CustomerDisplayConfig {
  if (!raw) return cloneDefaultCustomerDisplayConfig();
  try {
    return parseCustomerDisplayConfig(JSON.parse(raw)) ?? cloneDefaultCustomerDisplayConfig();
  } catch {
    return cloneDefaultCustomerDisplayConfig();
  }
}

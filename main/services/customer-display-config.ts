export const CUSTOMER_DISPLAY_KEY = 'customer_display';
export const CUSTOMER_DISPLAY_STATUSES = ['pending', 'preparing', 'ready'] as const;

export interface CustomerDisplayConfig {
  statuses: Array<(typeof CUSTOMER_DISPLAY_STATUSES)[number]>;
  refresh_seconds: number;
  show_updated: boolean;
}

export const CUSTOMER_DISPLAY_DEFAULTS: CustomerDisplayConfig = {
  statuses: [...CUSTOMER_DISPLAY_STATUSES],
  refresh_seconds: 3,
  show_updated: true,
};

/** Returns the normalized config, or null when the payload is malformed. */
export function parseCustomerDisplayConfig(value: unknown): CustomerDisplayConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { statuses, refresh_seconds, show_updated } = value as Record<string, unknown>;
  if (
    !Array.isArray(statuses) ||
    statuses.length === 0 ||
    !statuses.every((status) => (CUSTOMER_DISPLAY_STATUSES as readonly unknown[]).includes(status))
  ) {
    return null;
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
    refresh_seconds,
    show_updated,
  };
}

/** Parses a stored settings value, falling back to defaults when absent or invalid. */
export function readStoredCustomerDisplayConfig(raw: string | undefined): CustomerDisplayConfig {
  if (!raw) return { ...CUSTOMER_DISPLAY_DEFAULTS };
  try {
    return parseCustomerDisplayConfig(JSON.parse(raw)) ?? { ...CUSTOMER_DISPLAY_DEFAULTS };
  } catch {
    return { ...CUSTOMER_DISPLAY_DEFAULTS };
  }
}

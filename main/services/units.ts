export const SUPPLY_UNITS = ['each', 'g', 'kg', 'ml', 'l'] as const;
export type SupplyUnit = (typeof SUPPLY_UNITS)[number];

export const QUANTITY_PRECISION = 8;
const QUANTITY_TOLERANCE = 1e-8;

export class UnitConversionError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'UnitConversionError';
    this.statusCode = statusCode;
  }
}

type UnitDimension = 'count' | 'mass' | 'volume';

const UNIT_DIMENSIONS: Record<SupplyUnit, UnitDimension> = {
  each: 'count',
  g: 'mass',
  kg: 'mass',
  ml: 'volume',
  l: 'volume',
};

// Multiplier to convert 1 of the unit into the dimension's base unit.
const TO_BASE: Record<SupplyUnit, number> = {
  each: 1,
  g: 1,
  kg: 1000,
  ml: 1,
  l: 1000,
};

export function isSupplyUnit(value: unknown): value is SupplyUnit {
  return typeof value === 'string' && (SUPPLY_UNITS as readonly string[]).includes(value);
}

export function assertSupplyUnit(value: unknown, field = 'unit'): SupplyUnit {
  if (!isSupplyUnit(value)) {
    throw new UnitConversionError(400, `${field} must be one of: ${SUPPLY_UNITS.join(', ')}`);
  }
  return value;
}

/** Round a quantity to the shared inventory precision. */
export function roundQuantity(value: number): number {
  if (!Number.isFinite(value)) {
    throw new UnitConversionError(400, 'quantity must be a finite number');
  }
  const rounded = Number(value.toFixed(QUANTITY_PRECISION));
  return Math.abs(rounded) < QUANTITY_TOLERANCE ? 0 : rounded;
}

/**
 * Convert a quantity between units. Throws 400 when units are unknown or
 * belong to different dimensions (e.g. g → ml).
 */
export function convertQuantity(quantity: number, fromUnit: string, toUnit: string): number {
  const from = assertSupplyUnit(fromUnit, 'from_unit');
  const to = assertSupplyUnit(toUnit, 'to_unit');
  if (!Number.isFinite(quantity)) {
    throw new UnitConversionError(400, 'quantity must be a finite number');
  }
  if (UNIT_DIMENSIONS[from] !== UNIT_DIMENSIONS[to]) {
    throw new UnitConversionError(400, `Cannot convert between units of different dimensions (${from} → ${to})`);
  }
  if (from === to) return roundQuantity(quantity);
  const inBase = quantity * TO_BASE[from];
  return roundQuantity(inBase / TO_BASE[to]);
}

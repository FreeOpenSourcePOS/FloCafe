/**
 * Unified charges & fees engine - shared contracts and pure calculation.
 *
 * One model covers service charges, packaging fees and arbitrary surcharges.
 * Definitions live in the `custom_charges` setting as JSON; the itemised result
 * is persisted per order/bill in `charges_breakdown`.
 *
 * All arithmetic happens in integer minor units derived from the tenant's own
 * fraction digits, so zero-decimal currencies (JPY/KRW/VND) and three-decimal
 * currencies (KWD/BHD) round and persist correctly. Nothing here assumes two
 * decimals.
 */

export const VALID_CHARGE_ORDER_TYPES = ['dine_in', 'takeaway', 'delivery', 'online'] as const;
export type ChargeOrderType = (typeof VALID_CHARGE_ORDER_TYPES)[number];

export type ChargeType = 'percentage' | 'fixed';
export type ChargeCalculationBasis = 'net' | 'gross';

/** Charge ids that mirror the dedicated orders/bills columns. */
export const STANDARD_CHARGE_COLUMN_IDS = ['service_charge', 'packaging_charge'] as const;
export type StandardChargeColumnId = (typeof STANDARD_CHARGE_COLUMN_IDS)[number];

export interface ChargeDefinition {
  id: string;
  name: string;
  type: ChargeType;
  /** Rate between 0 and 100 for percentage, otherwise a currency amount. */
  value: number;
  calculation_basis: ChargeCalculationBasis;
  order_types: ChargeOrderType[];
  /** Cashier may waive this charge in cart or checkout. */
  is_optional: boolean;
  is_default_active: boolean;
  tax_category_id?: string | null;
  is_active: boolean;
}

export interface AppliedCharge {
  id: string;
  name: string;
  type: ChargeType;
  /** Present for percentage charges; the configured rate. */
  rate?: number;
  amount: number;
  calculation_basis: ChargeCalculationBasis;
  /** Explicit waiver state. A waived charge keeps `amount: 0`. */
  waived: boolean;
  tax_category_id?: string | null;
}

export const CHARGE_ID_PATTERN = /^[a-z0-9_-]+$/;
export const MAX_CHARGE_ID_LENGTH = 64;
export const MAX_CHARGE_DEFINITIONS = 50;
export const MAX_CHARGE_NAME_LENGTH = 80;
export const MAX_PERCENTAGE = 100;
export const MAX_CHARGE_ORDER_TYPES = VALID_CHARGE_ORDER_TYPES.length;

export class ChargeValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ChargeValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeChargeId(raw: unknown): string {
  if (typeof raw !== 'string') throw new ChargeValidationError('Charge id must be a string');
  const id = raw.trim().toLowerCase();
  if (!CHARGE_ID_PATTERN.test(id)) {
    throw new ChargeValidationError(`Charge id must match ${CHARGE_ID_PATTERN.source}`);
  }
  if (id.length > MAX_CHARGE_ID_LENGTH) {
    throw new ChargeValidationError(`Charge id must be at most ${MAX_CHARGE_ID_LENGTH} characters`);
  }
  return id;
}

function normalizeChargeName(raw: unknown): string {
  if (typeof raw !== 'string') throw new ChargeValidationError('Charge name must be a string');
  const name = raw.trim();
  if (!name) throw new ChargeValidationError('Charge name is required');
  if (name.length > MAX_CHARGE_NAME_LENGTH) {
    throw new ChargeValidationError(`Charge name must be at most ${MAX_CHARGE_NAME_LENGTH} characters`);
  }
  return name;
}

function normalizeChargeValue(type: ChargeType, raw: unknown): number {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ChargeValidationError('Charge value must be a finite number');
  }
  if (value < 0) throw new ChargeValidationError('Charge value must be zero or greater');
  if (type === 'percentage' && value > MAX_PERCENTAGE) {
    throw new ChargeValidationError(`Charge value must be between 0 and ${MAX_PERCENTAGE}`);
  }
  return value;
}

function normalizeOrderTypes(raw: unknown): ChargeOrderType[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ChargeValidationError('Charge must apply to at least one order type');
  }
  if (raw.length > MAX_CHARGE_ORDER_TYPES) {
    throw new ChargeValidationError(`Charge cannot apply to more than ${MAX_CHARGE_ORDER_TYPES} order types`);
  }
  const seen = new Set<ChargeOrderType>();
  for (const entry of raw) {
    if (typeof entry !== 'string' || !VALID_CHARGE_ORDER_TYPES.includes(entry as ChargeOrderType)) {
      throw new ChargeValidationError(
        `Charge order_types must be one of ${VALID_CHARGE_ORDER_TYPES.join(', ')}`,
      );
    }
    seen.add(entry as ChargeOrderType);
  }
  return [...seen];
}

/**
 * Validates an untrusted payload into charge definitions. The first invalid
 * entry rejects the whole array, so a partial write never lands.
 */
export function normalizeChargeDefinitions(raw: unknown): ChargeDefinition[] {
  if (typeof raw === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ChargeValidationError('Charges must be valid JSON');
    }
    return normalizeChargeDefinitions(parsed);
  }
  if (!Array.isArray(raw)) throw new ChargeValidationError('Charges must be an array');
  if (raw.length > MAX_CHARGE_DEFINITIONS) {
    throw new ChargeValidationError(`At most ${MAX_CHARGE_DEFINITIONS} charges may be configured`);
  }

  const definitions: ChargeDefinition[] = [];
  const seenIds = new Set<string>();

  for (const entry of raw) {
    if (!isRecord(entry)) throw new ChargeValidationError('Each charge must be an object');

    const id = normalizeChargeId(entry.id);
    if (seenIds.has(id)) throw new ChargeValidationError(`Duplicate charge id: ${id}`);
    seenIds.add(id);

    const type = entry.type;
    if (type !== 'percentage' && type !== 'fixed') {
      throw new ChargeValidationError('Charge type must be percentage or fixed');
    }

    const basis = entry.calculation_basis;
    if (basis !== 'net' && basis !== 'gross') {
      throw new ChargeValidationError('Charge calculation_basis must be net or gross');
    }

    definitions.push({
      id,
      name: normalizeChargeName(entry.name),
      type,
      value: normalizeChargeValue(type, entry.value),
      calculation_basis: basis,
      order_types: normalizeOrderTypes(entry.order_types),
      is_optional: entry.is_optional === true,
      is_default_active: entry.is_default_active !== false,
      tax_category_id:
        typeof entry.tax_category_id === 'string' && entry.tax_category_id.trim()
          ? entry.tax_category_id.trim()
          : null,
      is_active: entry.is_active !== false,
    });
  }

  return definitions;
}

/** Reads a stored definitions list for calculation, discarding anything invalid. */
export function parseStoredChargeDefinitions(raw: unknown): ChargeDefinition[] {
  try {
    return normalizeChargeDefinitions(raw);
  } catch {
    return [];
  }
}

/** Clamps untrusted fraction digits to the range ISO 4217 can express. */
export function normalizeCurrencyDecimals(currencyDecimals: number): number {
  return Number.isInteger(currencyDecimals) && currencyDecimals >= 0 && currencyDecimals <= 4
    ? currencyDecimals
    : 2;
}

export interface CalculateAppliedChargesInput {
  definitions: ChargeDefinition[];
  orderType: string;
  /** Raw subtotal before order-level discounts. */
  subtotal: number;
  discountAmount: number;
  /** Charge ids the cashier has waived. Honoured only for optional charges. */
  waivedIds?: Iterable<string>;
  /**
   * Charge ids the cashier explicitly opted into. A charge that is not
   * `is_default_active` is never applied unless it appears here, so "available"
   * charges stay out of the bill until they are added on purpose.
   */
  optedInIds?: Iterable<string>;
  /** Tenant currency fraction digits (0 for JPY/KRW/VND, 3 for KWD/BHD). */
  currencyDecimals: number;
}

function toMinorUnits(amount: number, factor: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * factor);
}

/**
 * Applies the matching active charges to an order.
 *
 * `net` basis applies to the discounted subtotal, `gross` to the raw subtotal.
 * A waived charge records `amount: 0` with `waived: true`, so an audit can tell
 * a waived fee apart from a fee configured at zero.
 */
export function calculateAppliedCharges(input: CalculateAppliedChargesInput): AppliedCharge[] {
  const { definitions, orderType, subtotal, discountAmount, waivedIds, optedInIds } = input;

  const decimals = normalizeCurrencyDecimals(input.currencyDecimals);
  const factor = Math.pow(10, decimals);
  const waived = new Set(waivedIds ?? []);
  const optedIn = new Set(optedInIds ?? []);
  const grossMinor = Math.max(0, toMinorUnits(subtotal, factor));
  const discountMinor = Math.max(0, toMinorUnits(discountAmount, factor));
  const netMinor = Math.max(0, grossMinor - discountMinor);

  const applied: AppliedCharge[] = [];

  for (const definition of definitions) {
    if (!definition.is_active) continue;
    if (!definition.is_default_active && !optedIn.has(definition.id)) continue;
    if (!definition.order_types.includes(orderType as ChargeOrderType)) continue;

    // Only optional charges are waivable, so a stray waiver id for a mandatory
    // charge cannot zero it out.
    const isWaived = definition.is_optional && waived.has(definition.id);
    const basisMinor = definition.calculation_basis === 'net' ? netMinor : grossMinor;
    const amountMinor = isWaived
      ? 0
      : definition.type === 'percentage'
        // Integer minor units keep the percentage exact at the tenant's precision.
        ? Math.max(0, Math.round((basisMinor * definition.value) / 100))
        : Math.max(0, toMinorUnits(definition.value, factor));

    const charge: AppliedCharge = {
      id: definition.id,
      name: definition.name,
      type: definition.type,
      amount: amountMinor / factor,
      calculation_basis: definition.calculation_basis,
      waived: isWaived,
      tax_category_id: definition.tax_category_id ?? null,
    };
    if (definition.type === 'percentage') charge.rate = definition.value;
    applied.push(charge);
  }

  return applied;
}

export interface StandardChargeColumns {
  service_charge: number;
  packaging_charge: number;
  /** Sum of every non-standard charge, so totals still reconcile. */
  other_charges: number;
}

/**
 * Projects applied charges onto the legacy dedicated columns that daily
 * exports, the tax service and Z-reports already aggregate. Non-standard
 * charges are summed rather than dropped, so nothing is lost.
 */
export function toStandardChargeColumns(charges: AppliedCharge[], currencyDecimals: number): StandardChargeColumns {
  const factor = Math.pow(10, normalizeCurrencyDecimals(currencyDecimals));
  let serviceMinor = 0;
  let packagingMinor = 0;
  let otherMinor = 0;

  for (const charge of charges) {
    const amountMinor = Math.max(0, toMinorUnits(charge.amount, factor));
    if (charge.id === 'service_charge') serviceMinor += amountMinor;
    else if (charge.id === 'packaging_charge') packagingMinor += amountMinor;
    else otherMinor += amountMinor;
  }

  return {
    service_charge: serviceMinor / factor,
    packaging_charge: packagingMinor / factor,
    other_charges: otherMinor / factor,
  };
}

/** Persisted `charges_breakdown` payload; null or unparseable reads as empty. */
export function parseAppliedCharges(raw: unknown): AppliedCharge[] {
  if (!raw) return [];
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is AppliedCharge =>
      isRecord(entry)
      && typeof entry.id === 'string'
      && typeof entry.name === 'string'
      && (entry.type === 'percentage' || entry.type === 'fixed')
      && typeof entry.amount === 'number'
      && Number.isFinite(entry.amount)
      && (entry.calculation_basis === 'net' || entry.calculation_basis === 'gross'),
  );
}

export function serializeAppliedCharges(charges: AppliedCharge[]): string {
  return JSON.stringify(charges);
}

export interface ReceiptChargeLine {
  id: string;
  name: string;
  amount: number;
  waived: boolean;
}

/**
 * Itemised charges to print on a receipt, from the engine's breakdown.
 *
 * Empty when the bill predates the engine, so the caller keeps rendering the
 * dedicated service_charge/packaging_charge columns. Only non-zero charges are
 * returned: a waived fee records amount 0 and must not be billed on the receipt.
 */
export function receiptChargeLines(raw: unknown): ReceiptChargeLine[] {
  return parseAppliedCharges(raw)
    .filter((charge) => charge.amount !== 0)
    .map((charge) => ({
      id: charge.id,
      name: charge.name,
      amount: charge.amount,
      waived: charge.waived,
    }));
}

/** Total of every non-waived applied charge. */
export function totalAppliedCharges(charges: AppliedCharge[]): number {
  let total = 0;
  for (const charge of charges) {
    if (charge.waived) continue;
    total += Number.isFinite(charge.amount) ? charge.amount : 0;
  }
  return total;
}
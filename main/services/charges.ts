/**
 * Backend entry point for the unified charges & fees engine.
 *
 * The contracts and pure calculation live in `shared/charges.ts` so the
 * POS cart preview and the authoritative backend totals cannot drift apart.
 */
import {
  calculateAppliedCharges,
  parseAppliedCharges,
  parseStoredChargeDefinitions,
  toStandardChargeColumns,
  type AppliedCharge,
  type ChargeDefinition,
  type ChargeOrderType,
  type StandardChargeColumns,
} from '../../shared/charges';
import { getCurrencyFractionDigits } from '../countries';
import { getSettingValue } from '../db';

export {
  CHARGE_ID_PATTERN,
  ChargeValidationError,
  MAX_CHARGE_DEFINITIONS,
  MAX_CHARGE_ID_LENGTH,
  MAX_CHARGE_NAME_LENGTH,
  MAX_CHARGE_ORDER_TYPES,
  MAX_PERCENTAGE,
  STANDARD_CHARGE_COLUMN_IDS,
  VALID_CHARGE_ORDER_TYPES,
  calculateAppliedCharges,
  normalizeChargeDefinitions,
  parseAppliedCharges,
  parseStoredChargeDefinitions,
  serializeAppliedCharges,
  toStandardChargeColumns,
  totalAppliedCharges,
} from '../../shared/charges';
export type {
  AppliedCharge,
  ChargeCalculationBasis,
  ChargeDefinition,
  ChargeOrderType,
  ChargeType,
  StandardChargeColumnId,
  StandardChargeColumns,
} from '../../shared/charges';

export const CUSTOM_CHARGES_SETTING_KEY = 'custom_charges';

/** Configured charges for the tenant; unreadable or malformed storage reads as none. */
export function getChargeDefinitions(): ChargeDefinition[] {
  const currencyDecimals = getCurrencyFractionDigits(getSettingValue('currency') || 'USD');
  return parseStoredChargeDefinitions(getSettingValue(CUSTOM_CHARGES_SETTING_KEY), currencyDecimals);
}

export interface ResolveOrderChargesInput {
  definitions: ChargeDefinition[];
  orderType: string;
  subtotal: number;
  discountAmount: number;
  currency: string;
  /** Raw `charges_breakdown` already on the row, so waivers survive a recompute. */
  existingBreakdown?: unknown;
  /** Explicit waiver/opt-in ids; derived from the breakdown when omitted. */
  waivedIds?: string[];
  optedInIds?: string[];
}

export interface ResolvedOrderCharges {
  charges: AppliedCharge[];
  columns: StandardChargeColumns;
  ownsServiceChargeColumn: boolean;
  ownsPackagingChargeColumn: boolean;
  /**
   * True when the merchant configured a charge that matches this order. False
   * means the engine has nothing to say and the row keeps whatever charge
   * amounts it already carried.
   */
  configured: boolean;
}

/**
 * Resolves the charges to apply to an order at the tenant's own precision.
 *
 * Waivers recorded on the row are re-applied rather than reset, so a recompute
 * triggered by adding an item or changing a discount does not silently un-waive
 * a fee the cashier already removed. Optional charges the cashier opted into
 * stay applied for the same reason.
 */
export function resolveOrderCharges(input: ResolveOrderChargesInput): ResolvedOrderCharges {
  const { definitions, orderType, subtotal, discountAmount, currency, existingBreakdown } = input;

  const existing = parseAppliedCharges(existingBreakdown);
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));

  const derivedWaivedIds = existing.filter((charge) => charge.waived).map((charge) => charge.id);
  const derivedOptedInIds = existing
    .filter((charge) => byId.get(charge.id)?.is_default_active === false)
    .map((charge) => charge.id);

  const waivedIds = input.waivedIds ?? derivedWaivedIds;
  const optedInIds = input.optedInIds ?? derivedOptedInIds;

  const activeCharges = calculateAppliedCharges({
    definitions,
    orderType,
    subtotal,
    discountAmount,
    waivedIds,
    optedInIds,
    currencyDecimals: getCurrencyFractionDigits(currency),
  });

  const retainedCharges = existing.filter((charge) => {
    const definition = byId.get(charge.id);
    return !definition?.is_active || !definition.order_types.includes(orderType as ChargeOrderType);
  });
  const charges = [...activeCharges, ...retainedCharges];

  const columns = toStandardChargeColumns(charges, getCurrencyFractionDigits(currency));
  const ownsStandardColumn = (id: string) => charges.some((charge) => charge.id === id)
    || definitions.some((definition) => definition.id === id
      && definition.is_active
      && definition.order_types.includes(orderType as ChargeOrderType));
  const configured = retainedCharges.length > 0 || definitions.some(
    (definition) => definition.is_active
      && (definition.is_default_active || optedInIds.includes(definition.id))
      && definition.order_types.includes(orderType as ChargeOrderType),
  );

  return {
    charges,
    columns,
    configured,
    ownsServiceChargeColumn: ownsStandardColumn('service_charge'),
    ownsPackagingChargeColumn: ownsStandardColumn('packaging_charge'),
  };
}

/** Convenience wrapper that resolves charges from the tenant's stored definitions. */
export function buildAppliedCharges(args: {
  currency: string;
  orderType: string;
  subtotal: number;
  discountAmount: number;
  existingBreakdown?: unknown;
  /** Explicit cashier decisions; derived from the breakdown when omitted. */
  waivedIds?: string[];
  optedInIds?: string[];
}): ResolvedOrderCharges {
  return resolveOrderCharges({ definitions: getChargeDefinitions(), ...args });
}

export interface ChargeToggle {
  chargeId: string;
  waived?: boolean;
  /** false removes an opt-in charge; true adds one. */
  applied?: boolean;
}

/**
 * Waiver and opt-in id sets after a cashier toggle, starting from the state
 * already recorded on the row. Returned so the caller can re-run the
 * calculation rather than hand-editing an amount.
 */
export function chargeIdsAfterToggle(args: {
  existingBreakdown?: unknown;
  definitions: ChargeDefinition[];
  toggle: ChargeToggle;
}): { waivedIds: string[]; optedInIds: string[] } {
  const existing = parseAppliedCharges(args.existingBreakdown);
  const byId = new Map(args.definitions.map((definition) => [definition.id, definition]));

  let waivedIds = existing.filter((charge) => charge.waived).map((charge) => charge.id);
  let optedInIds = existing
    .filter((charge) => byId.get(charge.id)?.is_default_active === false)
    .map((charge) => charge.id);

  if (args.toggle.applied === false) {
    optedInIds = optedInIds.filter((id) => id !== args.toggle.chargeId);
    waivedIds = waivedIds.filter((id) => id !== args.toggle.chargeId);
  } else if (args.toggle.applied === true && !optedInIds.includes(args.toggle.chargeId)) {
    optedInIds.push(args.toggle.chargeId);
  }

  if (args.toggle.waived === true) {
    if (!waivedIds.includes(args.toggle.chargeId)) waivedIds.push(args.toggle.chargeId);
  } else if (args.toggle.waived === false) {
    waivedIds = waivedIds.filter((id) => id !== args.toggle.chargeId);
  }

  return { waivedIds, optedInIds };
}

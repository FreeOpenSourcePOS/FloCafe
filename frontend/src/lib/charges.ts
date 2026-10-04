/**
 * Frontend entry point for the unified charges & fees engine.
 *
 * Re-exports the shared contracts and calculation so the POS cart preview uses
 * exactly the same arithmetic as the authoritative backend totals. The shared
 * path is relative rather than the `@shared` alias because print-path test
 * harnesses resolve `@/` and `@print/` but not `@shared/`.
 */
export {
  CHARGE_ID_PATTERN,
  MAX_CHARGE_ID_LENGTH,
  MAX_CHARGE_DEFINITIONS,
  MAX_CHARGE_NAME_LENGTH,
  MAX_PERCENTAGE,
  STANDARD_CHARGE_COLUMN_IDS,
  VALID_CHARGE_ORDER_TYPES,
  calculateAppliedCharges,
  normalizeChargeDefinitions,
  parseAppliedCharges,
  parseStoredChargeDefinitions,
  receiptChargeLines,
  serializeAppliedCharges,
  toStandardChargeColumns,
  totalAppliedCharges,
} from '../../../shared/charges';
export type {
  AppliedCharge,
  ChargeCalculationBasis,
  ChargeDefinition,
  ChargeOrderType,
  ChargeType,
  ReceiptChargeLine,
} from '../../../shared/charges';
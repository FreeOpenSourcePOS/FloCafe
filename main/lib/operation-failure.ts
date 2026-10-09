export type OperationOutcome = 'not_applied' | 'applied' | 'partial' | 'unknown' | 'not_applicable';
export type OperationFailureClass = 'expected_rejection' | 'unexpected_failure';

type IntegerFactRule = { type: 'integer'; min: number; max: number; required?: boolean };
type EnumFactRule = { type: 'enum'; values: readonly string[]; required?: boolean };
type FactRule = IntegerFactRule | EnumFactRule;

type OperationFailureDefinition = {
  capture_point: string;
  reason_code: string;
  operation: string;
  stage: string;
  classification: OperationFailureClass;
  outcomes: readonly OperationOutcome[];
  facts: Readonly<Record<string, FactRule>>;
};

export type OperationFailure = {
  capture_point: string;
  reason_code: string;
  operation: string;
  stage: string;
  classification: OperationFailureClass;
  outcome: OperationOutcome;
  correlation_id?: string;
  facts: Record<string, number | string>;
};

const NO_FACTS = {} as const;
const NETWORK_FAILURE_CLASSES = [
  'timeout', 'dns', 'connection_refused', 'offline', 'unreachable', 'invalid_response', 'unknown',
] as const;
const PRINT_FAILURE_CLASSES = [
  'not_configured', 'offline', 'needs_attention', 'queue_unavailable', 'spooler_error', 'driver_error',
  'permission_denied', 'timeout', 'write_error', 'unsupported', 'unknown',
] as const;
const PRINT_CONNECTION_TYPES = ['network', 'usb', 'webusb', 'unknown'] as const;
const DISCOUNT_DISPLAY_CODES = [
  'invalid_type', 'invalid_value', 'disabled', 'type_disabled', 'limit_exceeded',
  'order_not_discountable', 'bill_not_discountable', 'split_check', 'refunded', 'paid',
] as const;
const PAYMENT_DISPLAY_CODES = [
  'transaction_reference_used', 'transaction_reference_reused', 'bill_refunded', 'bill_already_paid',
  'customer_mismatch', 'customer_unavailable', 'wallet_customer_required', 'amount_required',
  'non_cash_exceeds_balance', 'cash_reference_zero_applied', 'wallet_insufficient',
  'kitchen_undelivered', 'idempotency_conflict', 'payment_method_unavailable', 'payment_input_invalid',
] as const;
const BILL_CHARGE_DISPLAY_CODES = [
  'charge_required', 'bill_not_found', 'split_check', 'bill_paid', 'bill_refunded',
  'order_not_found', 'order_cancelled', 'charge_unavailable', 'order_type_unsupported',
  'change_required', 'invalid_change_type', 'charge_not_waivable', 'charge_always_applied',
] as const;
const REFUND_DISPLAY_CODES = [
  'bill_id_required', 'order_item_id_invalid', 'amount_required', 'amount_invalid', 'reason_too_long',
  'approver_required', 'approver_conflict', 'idempotency_key_invalid', 'bill_unavailable',
  'order_unavailable', 'idempotency_conflict', 'refund_window_expired', 'item_unavailable',
  'item_bill_mismatch', 'split_item_unallocated', 'split_item_partial', 'item_status_ineligible',
  'item_amount_mismatch', 'method_required', 'wallet_disabled', 'wallet_customer_required',
  'nothing_to_refund', 'amount_exceeds_refundable', 'approver_pin_required', 'pin_rate_limited',
  'approver_pin_invalid', 'cash_session_required',
] as const;
const CASH_SESSION_OPEN_DISPLAY_CODES = ['opening_float_invalid', 'session_already_open'] as const;
const CASH_SESSION_CLOSE_DISPLAY_CODES = [
  'session_id_invalid', 'counted_cash_invalid', 'session_unavailable', 'session_already_closed',
  'session_owner_required', 'unpaid_bills_remaining',
] as const;
const CASH_MOVEMENT_CREATE_DISPLAY_CODES = [
  'business_date_invalid', 'future_business_date', 'movement_type_invalid', 'amount_invalid',
  'reason_required', 'reason_invalid', 'reason_too_long', 'cash_session_required',
  'day_already_closed', 'opening_float_exists',
] as const;
const CASH_MOVEMENT_VOID_DISPLAY_CODES = [
  'movement_id_invalid', 'reason_required', 'reason_invalid', 'reason_too_long',
  'movement_unavailable', 'movement_already_voided', 'day_already_closed',
] as const;
const CASH_DAY_CLOSE_DISPLAY_CODES = [
  'business_date_invalid', 'future_business_date', 'amount_invalid', 'notes_too_long',
  'day_already_closed', 'opening_float_mismatch',
] as const;
const KDS_ITEM_STATUS_DISPLAY_CODES = [
  'invalid_status', 'expected_status_invalid', 'action_permission_denied', 'user_inactive',
  'station_unassigned', 'item_voided', 'item_immutable', 'item_terminal',
  'category_scope_denied', 'station_scope_denied', 'orphaned_order', 'status_conflict',
  'item_unavailable',
] as const;
const RECIPE_VALIDATION_CODES = [
  'product_missing', 'items_missing', 'supply_id_missing', 'duplicate_supply', 'supply_missing',
  'quantity_invalid', 'unit_invalid', 'yield_invalid',
] as const;
const STAFF_CREATE_VALIDATION_CODES = [
  'required_fields', 'email_invalid', 'password_policy', 'role_invalid', 'station_list_invalid',
  'station_role_mismatch', 'pin_role_mismatch', 'pin_invalid', 'station_unavailable',
] as const;
const STAFF_UPDATE_VALIDATION_CODES = [
  'status_change_requires_action', 'role_invalid', 'role_change_forbidden', 'pin_role_mismatch',
  'pin_invalid', 'email_missing', 'email_invalid', 'password_policy',
] as const;
const STAFF_TARGET_ACTIONS = [
  'create_target', 'update_privileged', 'role_change', 'deactivate_privileged', 'reactivate_privileged',
] as const;
const CUSTOMER_VALIDATION_CODES = ['name_required', 'phone_invalid', 'address_invalid'] as const;
const CATEGORY_VALIDATION_CODES = ['name_required', 'addon_group_ids_invalid'] as const;
const CATEGORY_DELETE_CODES = ['requires_resolution', 'action_invalid', 'target_invalid', 'target_cycle', 'self_target'] as const;
const AUTHORIZATION_INPUT_CODES = ['invalid_role', 'invalid_overrides', 'missing_revision'] as const;
const PRODUCT_VALIDATION_CODES = [
  'required_fields', 'numeric_fields', 'weighted_fields', 'cashback_invalid', 'tax_behavior_invalid',
  'tax_category_invalid', 'image_url_invalid', 'inventory_link_invalid', 'category_invalid',
  'dietary_tags_invalid', 'variants_invalid', 'barcode_conflict', 'addon_groups_invalid',
] as const;
const PRODUCT_STOCK_VALIDATION_CODES = ['action_required', 'action_invalid', 'quantity_invalid'] as const;
const SUPPLY_VALIDATION_CODES = [
  'name_required', 'name_too_long', 'unit_invalid', 'quantity_invalid', 'threshold_invalid',
  'movement_reason_required', 'movement_reason_too_long', 'movement_type_invalid', 'movement_quantity_invalid',
  'movement_zero', 'movement_negative',
] as const;
const REPORT_RANGE_CODES = ['invalid_format', 'reversed_range', 'date_and_range_conflict'] as const;

/** Closed capture registry; new event tuples must be added here and to the cloud receiver. */
export const OPERATION_FAILURE_REGISTRY: readonly OperationFailureDefinition[] = [
  {
    capture_point: 'fc.backend.order.create.quantity_validation',
    reason_code: 'order.quantity_invalid', operation: 'order.create', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.order.create.stock_validation',
    reason_code: 'order.stock_insufficient', operation: 'order.create', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.order.create.other_validation',
    reason_code: 'validation.rejected', operation: 'order.create', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.order.create.persistence',
    reason_code: 'persistence.failed', operation: 'order.create', stage: 'persistence',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'partial', 'unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.order.create.completion',
    reason_code: 'operation.completion_failed', operation: 'order.create', stage: 'completion',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.order.create.server_error',
    reason_code: 'server.internal_error', operation: 'order.create', stage: 'persistence',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'partial', 'unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.order.append.validation',
    reason_code: 'validation.rejected', operation: 'order.append', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.order.append.persistence',
    reason_code: 'persistence.failed', operation: 'order.append', stage: 'persistence',
    classification: 'unexpected_failure', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.order.append.completion',
    reason_code: 'operation.completion_failed', operation: 'order.append', stage: 'completion',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.order.discount.validation',
    reason_code: 'discount.rejected', operation: 'order.discount', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { display_code: { type: 'enum', values: DISCOUNT_DISPLAY_CODES } },
  },
  {
    capture_point: 'fc.backend.order.discount.persistence',
    reason_code: 'persistence.failed', operation: 'order.discount', stage: 'persistence',
    classification: 'unexpected_failure', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.order.discount.completion',
    reason_code: 'operation.completion_failed', operation: 'order.discount', stage: 'completion',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.bill.discount.validation',
    reason_code: 'discount.rejected', operation: 'bill.discount', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { display_code: { type: 'enum', values: DISCOUNT_DISPLAY_CODES } },
  },
  {
    capture_point: 'fc.backend.bill.discount.persistence',
    reason_code: 'persistence.failed', operation: 'bill.discount', stage: 'persistence',
    classification: 'unexpected_failure', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.bill.discount.completion',
    reason_code: 'operation.completion_failed', operation: 'bill.discount', stage: 'completion',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.bill.charge.validation',
    reason_code: 'bill.charge_rejected', operation: 'bill.charge.update', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { display_code: { type: 'enum', values: BILL_CHARGE_DISPLAY_CODES } },
  },
  {
    capture_point: 'fc.backend.bill.charge.persistence',
    reason_code: 'persistence.failed', operation: 'bill.charge.update', stage: 'persistence',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.bill.charge.completion',
    reason_code: 'operation.completion_failed', operation: 'bill.charge.update', stage: 'completion',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.frontend.pos.order.create.transport',
    reason_code: 'request.transport_failed', operation: 'order.create', stage: 'submission',
    classification: 'unexpected_failure', outcomes: ['unknown'],
    facts: { failure_class: { type: 'enum', values: NETWORK_FAILURE_CLASSES } },
  },
  {
    capture_point: 'fc.frontend.pos.order.create.recovery',
    reason_code: 'request.outcome_unknown', operation: 'order.create', stage: 'recovery',
    classification: 'unexpected_failure', outcomes: ['unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.frontend.pos.order.create.retry_storage',
    reason_code: 'storage.retry_state_unavailable', operation: 'order.create', stage: 'local_storage',
    classification: 'unexpected_failure', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.frontend.pos.order.create.retry_cleanup',
    reason_code: 'storage.retry_state_cleanup_failed', operation: 'order.create', stage: 'cleanup',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.client.order.create.retry_state_update',
    reason_code: 'order.retry_state_failed', operation: 'order.create', stage: 'retry_state',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.client.payment.create.retry_state_update',
    reason_code: 'payment.retry_state_failed', operation: 'payment.create', stage: 'retry_state',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.client.bill.generate.retry_state_update',
    reason_code: 'bill.retry_state_failed', operation: 'bill.generate', stage: 'retry_state',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.payment.create.validation',
    reason_code: 'payment.invalid', operation: 'payment.create', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { display_code: { type: 'enum', values: PAYMENT_DISPLAY_CODES } },
  },
  {
    capture_point: 'fc.backend.payment.create.persistence',
    reason_code: 'persistence.failed', operation: 'payment.create', stage: 'persistence',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'partial', 'unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.payment.create.completion',
    reason_code: 'operation.completion_failed', operation: 'payment.create', stage: 'completion',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.frontend.pos.payment.create.transport',
    reason_code: 'request.transport_failed', operation: 'payment.create', stage: 'submission',
    classification: 'unexpected_failure', outcomes: ['unknown'],
    facts: { failure_class: { type: 'enum', values: NETWORK_FAILURE_CLASSES } },
  },
  {
    capture_point: 'fc.frontend.pos.payment.create.recovery',
    reason_code: 'request.outcome_unknown', operation: 'payment.create', stage: 'recovery',
    classification: 'unexpected_failure', outcomes: ['unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.frontend.pos.payment.create.retry_storage',
    reason_code: 'storage.retry_state_unavailable', operation: 'payment.create', stage: 'local_storage',
    classification: 'unexpected_failure', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.frontend.pos.payment.create.retry_cleanup',
    reason_code: 'storage.retry_state_cleanup_failed', operation: 'payment.create', stage: 'cleanup',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.frontend.pos.order.create.held_cleanup',
    reason_code: 'order.held_state.cleanup_failed', operation: 'order.create', stage: 'cleanup',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.frontend.pos.payment.create.held_cleanup',
    reason_code: 'order.held_state.cleanup_failed', operation: 'payment.create', stage: 'cleanup',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.frontend.pos.order.append.transport',
    reason_code: 'request.transport_failed', operation: 'order.append', stage: 'submission',
    classification: 'unexpected_failure', outcomes: ['unknown'],
    facts: { failure_class: { type: 'enum', values: NETWORK_FAILURE_CLASSES } },
  },
  {
    capture_point: 'fc.frontend.pos.order.append.recovery',
    reason_code: 'request.outcome_unknown', operation: 'order.append', stage: 'recovery',
    classification: 'unexpected_failure', outcomes: ['unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.frontend.pos.order.append.retry_storage',
    reason_code: 'storage.retry_state_unavailable', operation: 'order.append', stage: 'local_storage',
    classification: 'unexpected_failure', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.frontend.pos.order.append.retry_cleanup',
    reason_code: 'storage.retry_state_cleanup_failed', operation: 'order.append', stage: 'cleanup',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.payment.refund.persistence',
    reason_code: 'persistence.failed', operation: 'payment.refund', stage: 'persistence',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.payment.refund.validation',
    reason_code: 'refund.rejected', operation: 'payment.refund', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { display_code: { type: 'enum', values: REFUND_DISPLAY_CODES } },
  },
  {
    capture_point: 'fc.backend.payment.refund.completion',
    reason_code: 'operation.completion_failed', operation: 'payment.refund', stage: 'completion',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.cash.session.open.validation',
    reason_code: 'cash.session_rejected', operation: 'cash.session.open', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { display_code: { type: 'enum', values: CASH_SESSION_OPEN_DISPLAY_CODES } },
  },
  {
    capture_point: 'fc.backend.cash.session.open.persistence',
    reason_code: 'persistence.failed', operation: 'cash.session.open', stage: 'persistence',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.cash.session.open.completion',
    reason_code: 'operation.completion_failed', operation: 'cash.session.open', stage: 'completion',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.cash.session.close.validation',
    reason_code: 'cash.session_rejected', operation: 'cash.session.close', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { display_code: { type: 'enum', values: CASH_SESSION_CLOSE_DISPLAY_CODES } },
  },
  {
    capture_point: 'fc.backend.cash.session.close.persistence',
    reason_code: 'persistence.failed', operation: 'cash.session.close', stage: 'persistence',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.cash.session.close.completion',
    reason_code: 'operation.completion_failed', operation: 'cash.session.close', stage: 'completion',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.cash.movement.create.validation',
    reason_code: 'cash.movement_rejected', operation: 'cash.movement.create', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { display_code: { type: 'enum', values: CASH_MOVEMENT_CREATE_DISPLAY_CODES } },
  },
  {
    capture_point: 'fc.backend.cash.movement.create.persistence',
    reason_code: 'persistence.failed', operation: 'cash.movement.create', stage: 'persistence',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.cash.movement.create.completion',
    reason_code: 'operation.completion_failed', operation: 'cash.movement.create', stage: 'completion',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.cash.movement.void.validation',
    reason_code: 'cash.movement_rejected', operation: 'cash.movement.void', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { display_code: { type: 'enum', values: CASH_MOVEMENT_VOID_DISPLAY_CODES } },
  },
  {
    capture_point: 'fc.backend.cash.movement.void.persistence',
    reason_code: 'persistence.failed', operation: 'cash.movement.void', stage: 'persistence',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.cash.movement.void.completion',
    reason_code: 'operation.completion_failed', operation: 'cash.movement.void', stage: 'completion',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.cash.day.close.validation',
    reason_code: 'cash.day_close_rejected', operation: 'cash.day.close', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { display_code: { type: 'enum', values: CASH_DAY_CLOSE_DISPLAY_CODES } },
  },
  {
    capture_point: 'fc.backend.cash.day.close.persistence',
    reason_code: 'persistence.failed', operation: 'cash.day.close', stage: 'persistence',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.cash.day.close.completion',
    reason_code: 'operation.completion_failed', operation: 'cash.day.close', stage: 'completion',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.kds.item.status.validation',
    reason_code: 'kds.status_rejected', operation: 'kds.item.status.update', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { display_code: { type: 'enum', values: KDS_ITEM_STATUS_DISPLAY_CODES } },
  },
  {
    capture_point: 'fc.backend.kds.item.status.authorization_state',
    reason_code: 'kds.permissions_unavailable', operation: 'kds.item.status.update', stage: 'authorization',
    classification: 'unexpected_failure', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.kds.item.status.persistence',
    reason_code: 'persistence.failed', operation: 'kds.item.status.update', stage: 'persistence',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.kds.item.status.completion',
    reason_code: 'operation.completion_failed', operation: 'kds.item.status.update', stage: 'completion',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.bill.generate.failure',
    reason_code: 'persistence.failed', operation: 'bill.generate', stage: 'persistence',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'partial', 'unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.bill.generate.validation',
    reason_code: 'bill.order_unavailable', operation: 'bill.generate', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.bill.generate.completion',
    reason_code: 'operation.completion_failed', operation: 'bill.generate', stage: 'completion',
    classification: 'unexpected_failure', outcomes: ['applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.printer.receipt.queue',
    reason_code: 'printer.queue_failed', operation: 'printer.print', stage: 'printing',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'partial', 'unknown'],
    facts: {
      failure_class: { type: 'enum', values: PRINT_FAILURE_CLASSES },
      connection_type: { type: 'enum', values: PRINT_CONNECTION_TYPES },
      kind: { type: 'enum', values: ['receipt'], required: true },
    },
  },
  {
    capture_point: 'fc.backend.printer.kot.queue',
    reason_code: 'printer.queue_failed', operation: 'printer.print', stage: 'printing',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'partial', 'unknown'],
    facts: {
      failure_class: { type: 'enum', values: PRINT_FAILURE_CLASSES },
      connection_type: { type: 'enum', values: PRINT_CONNECTION_TYPES },
      kind: { type: 'enum', values: ['kot'], required: true },
    },
  },
  {
    capture_point: 'fc.backend.printer.receipt.timeout',
    reason_code: 'printer.timeout', operation: 'printer.print', stage: 'printing',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'partial', 'unknown'],
    facts: {
      failure_class: { type: 'enum', values: PRINT_FAILURE_CLASSES },
      connection_type: { type: 'enum', values: PRINT_CONNECTION_TYPES },
      kind: { type: 'enum', values: ['receipt'], required: true },
    },
  },
  {
    capture_point: 'fc.backend.printer.kot.timeout',
    reason_code: 'printer.timeout', operation: 'printer.print', stage: 'printing',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'partial', 'unknown'],
    facts: {
      failure_class: { type: 'enum', values: PRINT_FAILURE_CLASSES },
      connection_type: { type: 'enum', values: PRINT_CONNECTION_TYPES },
      kind: { type: 'enum', values: ['kot'], required: true },
    },
  },
  {
    capture_point: 'fc.backend.printer.delivery_slip.queue',
    reason_code: 'printer.queue_failed', operation: 'printer.print', stage: 'printing',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'partial', 'unknown'],
    facts: {
      failure_class: { type: 'enum', values: PRINT_FAILURE_CLASSES },
      connection_type: { type: 'enum', values: PRINT_CONNECTION_TYPES },
      kind: { type: 'enum', values: ['delivery_slip'], required: true },
    },
  },
  {
    capture_point: 'fc.backend.printer.delivery_slip.timeout',
    reason_code: 'printer.timeout', operation: 'printer.print', stage: 'printing',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'partial', 'unknown'],
    facts: {
      failure_class: { type: 'enum', values: PRINT_FAILURE_CLASSES },
      connection_type: { type: 'enum', values: PRINT_CONNECTION_TYPES },
      kind: { type: 'enum', values: ['delivery_slip'], required: true },
    },
  },
  {
    capture_point: 'fc.electron.startup.failure',
    reason_code: 'app.startup_failed', operation: 'app.startup', stage: 'initialization',
    classification: 'unexpected_failure', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.electron.main.uncaught',
    reason_code: 'app.main_process_failed', operation: 'app.main_process', stage: 'runtime',
    classification: 'unexpected_failure', outcomes: ['unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.electron.main.unhandled_rejection',
    reason_code: 'app.main_process_rejected', operation: 'app.main_process', stage: 'runtime',
    classification: 'unexpected_failure', outcomes: ['unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.electron.renderer.process_gone',
    reason_code: 'app.renderer_process_failed', operation: 'app.renderer', stage: 'runtime',
    classification: 'unexpected_failure', outcomes: ['unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.electron.renderer.exception',
    reason_code: 'app.renderer_error', operation: 'app.renderer', stage: 'runtime',
    classification: 'unexpected_failure', outcomes: ['unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.electron.child.process_gone',
    reason_code: 'app.child_process_failed', operation: 'app.child_process', stage: 'runtime',
    classification: 'unexpected_failure', outcomes: ['unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.electron.runtime.relaunch_exhausted',
    reason_code: 'app.runtime_relaunch_exhausted', operation: 'app.runtime', stage: 'recovery',
    classification: 'unexpected_failure', outcomes: ['unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.tax.catalog_missing',
    reason_code: 'tax.catalog_missing', operation: 'tax.pack', stage: 'verification',
    classification: 'unexpected_failure', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.tax.download',
    reason_code: 'tax.download_failed', operation: 'tax.pack', stage: 'download',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'unknown'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.tax.signature',
    reason_code: 'tax.signature_invalid', operation: 'tax.pack', stage: 'verification',
    classification: 'unexpected_failure', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.tax.install',
    reason_code: 'tax.install_failed', operation: 'tax.pack', stage: 'installation',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'partial'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.tax.activation',
    reason_code: 'tax.activation_failed', operation: 'tax.pack', stage: 'activation',
    classification: 'unexpected_failure', outcomes: ['not_applied', 'partial'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.diagnostics.delivery.queue_gap',
    reason_code: 'diagnostics.delivery_gap', operation: 'diagnostics.delivery', stage: 'delivery',
    classification: 'unexpected_failure', outcomes: ['partial'],
    facts: {
      gap_count: { type: 'integer', min: 1, max: 100_000, required: true },
      gap_reason: { type: 'enum', values: [
        'queue_eviction', 'permanent_rejection', 'invalid_ack', 'report_id_mismatch', 'local_retention',
      ], required: true },
    },
  },
  {
    capture_point: 'fc.backend.staff.administration_access_guard',
    reason_code: 'staff.administration_invariant', operation: 'staff.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.customer.duplicate_phone',
    reason_code: 'customer.duplicate_phone', operation: 'customer.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.product.delete.inventory_target',
    reason_code: 'product.delete_blocked', operation: 'product.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.staff.duplicate_email',
    reason_code: 'staff.email_conflict', operation: 'staff.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.auth.recovery.owner_state_changed',
    reason_code: 'auth.owner_state_changed', operation: 'auth.session', stage: 'recovery',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.authorization.administration_guard',
    reason_code: 'authorization.administration_invariant', operation: 'authorization.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.authorization.self_lockout_guard',
    reason_code: 'authorization.self_lockout_prevented', operation: 'authorization.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.authorization.revision_conflict',
    reason_code: 'authorization.revision_conflict', operation: 'authorization.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.category.parent_reference_invalid',
    reason_code: 'category.parent_reference_invalid', operation: 'category.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.category.parent_cycle',
    reason_code: 'category.parent_cycle', operation: 'category.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.addon_group.selection_bounds',
    reason_code: 'addon_group.selection_bounds_invalid', operation: 'addon_group.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.inventory.movement_query.invalid',
    reason_code: 'inventory.query_rejected', operation: 'inventory.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.supply.delete.recipe_linked',
    reason_code: 'supply.delete_blocked', operation: 'supplies.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.recipe.save.invalid_component',
    reason_code: 'recipe.component_invalid', operation: 'recipe.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { validation_code: { type: 'enum', values: RECIPE_VALIDATION_CODES, required: true } },
  },
  {
    capture_point: 'fc.backend.reports.financial_summary.date_range',
    reason_code: 'reports.date_range_invalid', operation: 'report.generate', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.menu_csv.import.invalid_input',
    reason_code: 'catalog_import.invalid_input', operation: 'catalog.import', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.menu_csv.import.row_rejections',
    reason_code: 'catalog_import.rows_rejected', operation: 'catalog.import', stage: 'import',
    classification: 'expected_rejection', outcomes: ['not_applied', 'partial'],
    facts: {
      failed_count: { type: 'integer', min: 1, max: 10000, required: true },
      changed_count: { type: 'integer', min: 0, max: 10000, required: true },
    },
  },
  {
    capture_point: 'fc.backend.staff.create.validation',
    reason_code: 'staff.input_rejected', operation: 'staff.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { validation_code: { type: 'enum', values: STAFF_CREATE_VALIDATION_CODES, required: true } },
  },
  {
    capture_point: 'fc.backend.staff.update.validation',
    reason_code: 'staff.input_rejected', operation: 'staff.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { validation_code: { type: 'enum', values: STAFF_UPDATE_VALIDATION_CODES, required: true } },
  },
  {
    capture_point: 'fc.backend.staff.target_access_denied',
    reason_code: 'permission.denied', operation: 'staff.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { action: { type: 'enum', values: STAFF_TARGET_ACTIONS, required: true } },
  },
  {
    capture_point: 'fc.backend.staff.update.duplicate_email',
    reason_code: 'staff.email_conflict', operation: 'staff.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.customer.create.validation',
    reason_code: 'customer.input_rejected', operation: 'customer.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { validation_code: { type: 'enum', values: CUSTOMER_VALIDATION_CODES, required: true } },
  },
  {
    capture_point: 'fc.backend.customer.update.validation',
    reason_code: 'customer.input_rejected', operation: 'customer.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { validation_code: { type: 'enum', values: CUSTOMER_VALIDATION_CODES, required: true } },
  },
  {
    capture_point: 'fc.backend.customer.list.pagination_invalid',
    reason_code: 'customer.query_rejected', operation: 'customer.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.category.save.validation',
    reason_code: 'category.input_rejected', operation: 'category.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { validation_code: { type: 'enum', values: CATEGORY_VALIDATION_CODES, required: true } },
  },
  {
    capture_point: 'fc.backend.category.delete.action_rejected',
    reason_code: 'category.delete_rejected', operation: 'category.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { validation_code: { type: 'enum', values: CATEGORY_DELETE_CODES, required: true } },
  },
  {
    capture_point: 'fc.backend.addon_group.input_validation',
    reason_code: 'addon_group.input_rejected', operation: 'addon_group.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.authorization.input_validation',
    reason_code: 'authorization.input_rejected', operation: 'authorization.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { validation_code: { type: 'enum', values: AUTHORIZATION_INPUT_CODES, required: true } },
  },
  {
    capture_point: 'fc.backend.product.create.validation',
    reason_code: 'product.input_rejected', operation: 'product.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { validation_code: { type: 'enum', values: PRODUCT_VALIDATION_CODES, required: true } },
  },
  {
    capture_point: 'fc.backend.product.update.validation',
    reason_code: 'product.input_rejected', operation: 'product.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { validation_code: { type: 'enum', values: PRODUCT_VALIDATION_CODES, required: true } },
  },
  {
    capture_point: 'fc.backend.product.stock.validation',
    reason_code: 'product.stock_input_rejected', operation: 'product.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { validation_code: { type: 'enum', values: PRODUCT_STOCK_VALIDATION_CODES, required: true } },
  },
  {
    capture_point: 'fc.backend.supply.movement_query.invalid',
    reason_code: 'supply.query_rejected', operation: 'supplies.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'], facts: NO_FACTS,
  },
  {
    capture_point: 'fc.backend.supply.validation',
    reason_code: 'supply.input_rejected', operation: 'supplies.manage', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { validation_code: { type: 'enum', values: SUPPLY_VALIDATION_CODES, required: true } },
  },
  {
    capture_point: 'fc.backend.reports.date_range.invalid',
    reason_code: 'reports.date_range_invalid', operation: 'report.generate', stage: 'validation',
    classification: 'expected_rejection', outcomes: ['not_applied'],
    facts: { validation_code: { type: 'enum', values: REPORT_RANGE_CODES, required: true } },
  },
  {
    capture_point: 'fc.backend.http.unhandled',
    reason_code: 'server.unhandled_error', operation: 'api.request', stage: 'handling',
    classification: 'unexpected_failure', outcomes: ['unknown'], facts: NO_FACTS,
  },
];

const REGISTRY_BY_CAPTURE_POINT = new Map(OPERATION_FAILURE_REGISTRY.map((definition) => [definition.capture_point, definition]));
const OPERATION_REFERENCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isOperationReference(value: unknown): value is string {
  return typeof value === 'string' && OPERATION_REFERENCE_RE.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Produces only the registered tuple and approved bounded facts, or null for any mismatch. */
export function serializeOperationFailure(input: {
  capture_point: unknown;
  outcome: unknown;
  correlation_id?: unknown;
  facts?: unknown;
}): OperationFailure | null {
  try {
  if (typeof input.capture_point !== 'string') return null;
  const definition = REGISTRY_BY_CAPTURE_POINT.get(input.capture_point);
  if (!definition || typeof input.outcome !== 'string' || !definition.outcomes.includes(input.outcome as OperationOutcome)) return null;
  if (input.correlation_id !== undefined && !isOperationReference(input.correlation_id)) return null;
  const sourceFacts = input.facts === undefined ? {} : input.facts;
  if (!isPlainRecord(sourceFacts)) return null;

  const facts: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(sourceFacts)) {
    if (!Object.hasOwn(definition.facts, key)) return null;
    const rule = definition.facts[key];
    if (rule.type === 'integer') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < rule.min || value > rule.max) return null;
      facts[key] = value;
    } else {
      if (typeof value !== 'string' || !rule.values.includes(value)) return null;
      facts[key] = value;
    }
  }
  for (const [key, rule] of Object.entries(definition.facts)) {
    if (rule.required && !Object.hasOwn(facts, key)) return null;
  }

  return {
    capture_point: definition.capture_point,
    reason_code: definition.reason_code,
    operation: definition.operation,
    stage: definition.stage,
    classification: definition.classification,
    outcome: input.outcome as OperationOutcome,
    ...(input.correlation_id === undefined ? {} : { correlation_id: input.correlation_id }),
    facts,
  };
  } catch {
    return null;
  }
}

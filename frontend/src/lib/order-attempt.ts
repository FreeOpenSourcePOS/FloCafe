import type { AppendAttemptStorage } from './append-attempt';

/** Global key used by builds before prepaid attempts became user scoped. */
export const PREPAID_ATTEMPT_STORAGE_KEY = 'flo.prepaid.checkout.attempt';
const ORDER_ATTEMPT_USER_SUFFIX = '.user.';

/** Raised when new-order attempt state cannot be durably read or written.
 * Callers must not send the order request when this is thrown. */
export class OrderAttemptStorageError extends Error {
  constructor() {
    super('Order attempt storage is unavailable');
    this.name = 'OrderAttemptStorageError';
  }
}

export interface StoredOrderAttempt {
  userId: string;
}

interface CompletedOrderAttempt {
  completed: true;
  userId: string;
  completedAt: number;
}

/** Prepaid attempts are user scoped. A single shared key let one cashier's read
 * drop another cashier's pending retry, which hands a possibly committed
 * request a fresh idempotency key. */
export function getPrepaidOrderAttemptStorageKey(userId: string): string {
  return `${PREPAID_ATTEMPT_STORAGE_KEY}${ORDER_ATTEMPT_USER_SUFFIX}${encodeURIComponent(userId)}`;
}

function isCompletedAttempt(value: unknown): value is CompletedOrderAttempt {
  return (
    !!value && typeof value === 'object' && (value as { completed?: unknown }).completed === true
  );
}

interface ReadOrderAttemptOptions<T extends StoredOrderAttempt> {
  /** Set for global keys written before attempts were user scoped. Those keys
   * are shared, so a foreign or unreadable value means "not mine" instead of
   * "damaged", and mutating it would drop another cashier's pending retry. */
  sharedKey?: boolean;
  /** Structural check for the fields the caller needs. A record that fails it
   * is damaged, not absent. */
  isValid?: (attempt: T) => boolean;
}

/** Read an attempt back from the durable store. Fails closed rather than
 * reporting "no attempt" when the stored value cannot be trusted, so a caller
 * never starts a second order under a fresh idempotency key. */
export function readOrderAttempt<T extends StoredOrderAttempt>(
  storage: AppendAttemptStorage,
  key: string,
  userId: string,
  options: ReadOrderAttemptOptions<T> = {},
): T | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    throw new OrderAttemptStorageError();
  }
  if (storage.hasUnverifiedRead?.(key)) throw new OrderAttemptStorageError();
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (options.sharedKey) return null;
    throw new OrderAttemptStorageError();
  }
  if (isCompletedAttempt(parsed)) {
    // The order was confirmed; this record only survived because cleanup could
    // not delete it. Its keys must never be reused for a later sale.
    if (parsed.userId === userId) clearOrderAttempt(storage, key, parsed);
    return null;
  }
  const usable =
    !!parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    (parsed as StoredOrderAttempt).userId === userId &&
    (options.isValid?.(parsed as T) ?? true);
  if (!usable) {
    if (options.sharedKey) return null;
    throw new OrderAttemptStorageError();
  }
  return parsed as T;
}

/** Persist an attempt before its request is sent, through the safe storage
 * wrapper's verified write. Throws when no backend accepted the value. */
export function persistOrderAttempt(
  storage: AppendAttemptStorage,
  key: string,
  attempt: StoredOrderAttempt,
): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(attempt);
  } catch {
    throw new OrderAttemptStorageError();
  }
  try {
    storage.setItem(key, serialized);
  } catch {
    throw new OrderAttemptStorageError();
  }
}

/** Close an attempt whose response was confirmed. The completion marker is
 * stored before removal so a record the browser refuses to delete is still
 * never read back as a reusable attempt. Returns false when not even the marker
 * could be stored, which the caller reports as a storage problem. */
export function clearOrderAttempt(
  storage: AppendAttemptStorage,
  key: string,
  attempt: StoredOrderAttempt,
): boolean {
  const marker: CompletedOrderAttempt = {
    completed: true,
    userId: attempt.userId,
    completedAt: Date.now(),
  };
  const serializedMarker = JSON.stringify(marker);
  let markerPersisted = false;
  try {
    storage.setItem(key, serializedMarker);
    markerPersisted = storage.getItem(key) === serializedMarker;
  } catch {
    markerPersisted = false;
  }
  let removed = false;
  try {
    removed = storage.removeItem(key) !== false;
  } catch {
    removed = false;
  }
  const removalVerified = removed && !storage.hasUnverifiedRemoval?.(key);
  return removalVerified || markerPersisted;
}

export type OperationFailureMetadata = {
  reasonCode: string | null;
  operation: string;
  stage: string | null;
  outcome: 'not_applied' | 'applied' | 'partial' | 'unknown' | 'not_applicable' | null;
  classification: 'expected_rejection' | 'unexpected_failure' | null;
  correlationId: string | null;
  displayCode: string | null;
  serverError: string | null;
  trusted: boolean;
};

export type OperationName =
  | 'order.create'
  | 'payment.create'
  | 'order.append'
  | 'order.discount'
  | 'bill.discount'
  | 'bill.generate'
  | 'bill.charge.update';
type FailureDefinition = {
  stage: string;
  classification: OperationFailureMetadata['classification'];
  outcomes: readonly NonNullable<OperationFailureMetadata['outcome']>[];
};

const STRUCTURED_FAILURES: Record<
  OperationName,
  Record<string, Record<string, FailureDefinition>>
> = {
  'order.create': {
    validation: {
      'order.quantity_invalid': {
        stage: 'validation',
        classification: 'expected_rejection',
        outcomes: ['not_applied'],
      },
      'order.stock_insufficient': {
        stage: 'validation',
        classification: 'expected_rejection',
        outcomes: ['not_applied'],
      },
      'order.addon_selection_required': {
        stage: 'validation',
        classification: 'expected_rejection',
        outcomes: ['not_applied'],
      },
      'order.addon_unavailable': {
        stage: 'validation',
        classification: 'expected_rejection',
        outcomes: ['not_applied'],
      },
      'validation.rejected': {
        stage: 'validation',
        classification: 'expected_rejection',
        outcomes: ['not_applied'],
      },
    },
    persistence: {
      'persistence.failed': {
        stage: 'persistence',
        classification: 'unexpected_failure',
        outcomes: ['not_applied', 'partial', 'unknown'],
      },
      'server.internal_error': {
        stage: 'persistence',
        classification: 'unexpected_failure',
        outcomes: ['not_applied', 'partial', 'unknown'],
      },
    },
    completion: {
      'operation.completion_failed': {
        stage: 'completion',
        classification: 'unexpected_failure',
        outcomes: ['applied'],
      },
    },
    submission: {
      'request.transport_failed': {
        stage: 'submission',
        classification: 'unexpected_failure',
        outcomes: ['unknown'],
      },
    },
    recovery: {
      'request.outcome_unknown': {
        stage: 'recovery',
        classification: 'unexpected_failure',
        outcomes: ['unknown'],
      },
    },
  },
  'payment.create': {
    validation: {
      'payment.invalid': {
        stage: 'validation',
        classification: 'expected_rejection',
        outcomes: ['not_applied'],
      },
    },
    persistence: {
      'persistence.failed': {
        stage: 'persistence',
        classification: 'unexpected_failure',
        outcomes: ['not_applied', 'partial', 'unknown'],
      },
    },
    completion: {
      'operation.completion_failed': {
        stage: 'completion',
        classification: 'unexpected_failure',
        outcomes: ['applied'],
      },
    },
    submission: {
      'request.transport_failed': {
        stage: 'submission',
        classification: 'unexpected_failure',
        outcomes: ['unknown'],
      },
    },
    recovery: {
      'request.outcome_unknown': {
        stage: 'recovery',
        classification: 'unexpected_failure',
        outcomes: ['unknown'],
      },
    },
  },
  'order.append': {
    validation: {
      'validation.rejected': {
        stage: 'validation',
        classification: 'expected_rejection',
        outcomes: ['not_applied'],
      },
    },
    persistence: {
      'persistence.failed': {
        stage: 'persistence',
        classification: 'unexpected_failure',
        outcomes: ['not_applied'],
      },
    },
    completion: {
      'operation.completion_failed': {
        stage: 'completion',
        classification: 'unexpected_failure',
        outcomes: ['applied'],
      },
    },
    submission: {
      'request.transport_failed': {
        stage: 'submission',
        classification: 'unexpected_failure',
        outcomes: ['unknown'],
      },
    },
    recovery: {
      'request.outcome_unknown': {
        stage: 'recovery',
        classification: 'unexpected_failure',
        outcomes: ['unknown'],
      },
    },
  },
  'order.discount': {
    validation: {
      'discount.rejected': {
        stage: 'validation',
        classification: 'expected_rejection',
        outcomes: ['not_applied'],
      },
    },
    persistence: {
      'persistence.failed': {
        stage: 'persistence',
        classification: 'unexpected_failure',
        outcomes: ['not_applied'],
      },
    },
    completion: {
      'operation.completion_failed': {
        stage: 'completion',
        classification: 'unexpected_failure',
        outcomes: ['applied'],
      },
    },
  },
  'bill.discount': {
    validation: {
      'discount.rejected': {
        stage: 'validation',
        classification: 'expected_rejection',
        outcomes: ['not_applied'],
      },
    },
    persistence: {
      'persistence.failed': {
        stage: 'persistence',
        classification: 'unexpected_failure',
        outcomes: ['not_applied'],
      },
    },
    completion: {
      'operation.completion_failed': {
        stage: 'completion',
        classification: 'unexpected_failure',
        outcomes: ['applied'],
      },
    },
  },
  'bill.generate': {
    validation: {
      'bill.order_unavailable': {
        stage: 'validation',
        classification: 'expected_rejection',
        outcomes: ['not_applied'],
      },
    },
    persistence: {
      'persistence.failed': {
        stage: 'persistence',
        classification: 'unexpected_failure',
        outcomes: ['not_applied', 'partial', 'unknown'],
      },
    },
    completion: {
      'operation.completion_failed': {
        stage: 'completion',
        classification: 'unexpected_failure',
        outcomes: ['applied'],
      },
    },
  },
  'bill.charge.update': {
    validation: {
      'bill.charge_rejected': {
        stage: 'validation',
        classification: 'expected_rejection',
        outcomes: ['not_applied'],
      },
    },
    persistence: {
      'persistence.failed': {
        stage: 'persistence',
        classification: 'unexpected_failure',
        outcomes: ['not_applied', 'unknown'],
      },
    },
    completion: {
      'operation.completion_failed': {
        stage: 'completion',
        classification: 'unexpected_failure',
        outcomes: ['applied'],
      },
    },
  },
};

const DISCOUNT_DISPLAY_CODES = [
  'invalid_type',
  'invalid_value',
  'disabled',
  'type_disabled',
  'limit_exceeded',
  'order_not_discountable',
  'bill_not_discountable',
  'split_check',
  'refunded',
  'paid',
] as const;
const PAYMENT_DISPLAY_CODES = [
  'transaction_reference_used',
  'transaction_reference_reused',
  'bill_refunded',
  'bill_already_paid',
  'payment_exceeds_balance',
  'customer_mismatch',
  'customer_unavailable',
  'wallet_customer_required',
  'amount_required',
  'non_cash_exceeds_balance',
  'cash_reference_zero_applied',
  'wallet_insufficient',
  'kitchen_undelivered',
  'idempotency_conflict',
  'payment_method_unavailable',
  'payment_input_invalid',
  'cash_session_required',
  'card_transaction_id_required',
] as const;
const CHARGE_DISPLAY_CODES = [
  'charge_required',
  'bill_not_found',
  'split_check',
  'bill_paid',
  'bill_refunded',
  'order_not_found',
  'order_cancelled',
  'charge_unavailable',
  'order_type_unsupported',
  'change_required',
  'invalid_change_type',
  'charge_not_waivable',
  'charge_always_applied',
] as const;

export function isSupportedFailureOperation(value: string): value is OperationName {
  return Object.prototype.hasOwnProperty.call(STRUCTURED_FAILURES, value);
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function sanitizeServerError(rawError: unknown): string | null {
  if (typeof rawError !== 'string') return null;
  const trimmed = rawError.trim();
  if (!trimmed) return null;
  const bounded = trimmed.length > 255 ? trimmed.slice(0, 255) : trimmed;
  if (
    /[\r\n]/.test(bounded) ||
    /\bat\s+\S+\s+\(/.test(bounded) ||
    /\bat\s+.*:\d+:\d+/.test(bounded)
  ) {
    return null;
  }
  if (
    /(?:sqlite|syntax error|database (?:locked|disk image)|no such (?:table|column)|foreign key constraint|unique constraint|primary key constraint|check constraint|table\s+\w+|column\s+\w+|select\s+.+from|insert\s+into|update\s+.+set|delete\s+from|drop\s+table|alter\s+table)/i.test(
      bounded,
    )
  ) {
    return null;
  }
  if (
    /^(?:[A-Z][a-zA-Z0-9_]*(?:Error|Exception)|TypeError|RangeError|SyntaxError|ReferenceError|SystemError):/i.test(
      bounded,
    )
  ) {
    return null;
  }
  if (
    /\b(?:ENOENT|EACCES|EPERM|ECONNREFUSED|ECONNRESET|EADDRINUSE|ETIMEDOUT|EPIPE)\b/i.test(bounded)
  ) {
    return null;
  }
  if (/(?:^|[\s"'`])(?:(?:\/|[a-zA-Z]:[\\/])\w+|(?:\.\.?[\\/]\w+))/i.test(bounded)) {
    return null;
  }
  if (
    /\b(?:bearer\s+[a-zA-Z0-9._-]+|jwt|api[_-]?key|client[_-]?secret|secret[_-]?key|private[_-]?key|password)\b/i.test(
      bounded,
    )
  ) {
    return null;
  }
  return bounded;
}

/** Trusts additive server metadata only when the closed tuple and operation reference match. */
export function classifyOrderRequestFailure(
  error: unknown,
  expected: { operation: OperationName; correlationId: string } = {
    operation: 'order.create',
    correlationId: '',
  },
): {
  code: string;
  detail: string;
  status: number | null;
} & OperationFailureMetadata {
  const response = (error as { response?: { status?: unknown; data?: unknown } } | null)?.response;
  let rawStatus = Number.NaN;
  try {
    rawStatus = Number(response?.status);
  } catch {
    // A malformed transport error must not break the cashier's fallback message.
  }
  const status = Number.isInteger(rawStatus) && rawStatus > 0 ? rawStatus : null;
  const fallback = {
    code:
      status !== null
        ? 'order.place.rejected'
        : (error as { isAxiosError?: unknown } | null)?.isAxiosError === true
          ? 'order.place.unreachable'
          : 'order.place.failed',
    detail:
      status !== null
        ? `The local server response did not confirm the result (HTTP ${status})`
        : (error as { isAxiosError?: unknown } | null)?.isAxiosError === true
          ? 'The request did not receive confirmation from the local server'
          : 'The request result could not be confirmed on this device',
    status,
    reasonCode: null,
    operation: expected.operation,
    stage: null,
    outcome: 'unknown' as const,
    classification: null,
    correlationId: null,
    displayCode: null,
    serverError: null,
    trusted: false,
  };

  if (!UUID_V4.test(expected.correlationId) || !plainRecord(response?.data)) return fallback;
  const payload = response.data;
  if (
    payload.operation !== expected.operation ||
    typeof payload.reason_code !== 'string' ||
    typeof payload.stage !== 'string'
  )
    return fallback;
  if (
    payload.facts !== undefined &&
    (!plainRecord(payload.facts) || Object.keys(payload.facts).length > 0)
  )
    return fallback;
  const operationDefinitions = STRUCTURED_FAILURES[expected.operation];
  if (!Object.prototype.hasOwnProperty.call(operationDefinitions, payload.stage)) return fallback;
  const stageDefinitions = operationDefinitions[payload.stage];
  if (!Object.prototype.hasOwnProperty.call(stageDefinitions, payload.reason_code)) return fallback;
  const definition = stageDefinitions[payload.reason_code];
  const displayCode = payload.display_code;
  const isDiscountRejection =
    payload.reason_code === 'discount.rejected' &&
    (expected.operation === 'order.discount' || expected.operation === 'bill.discount');
  const isPaymentRejection =
    payload.reason_code === 'payment.invalid' && expected.operation === 'payment.create';
  const isChargeRejection =
    payload.reason_code === 'bill.charge_rejected' && expected.operation === 'bill.charge.update';
  const allowedDisplayCodes: readonly string[] = isDiscountRejection
    ? DISCOUNT_DISPLAY_CODES
    : isPaymentRejection
      ? PAYMENT_DISPLAY_CODES
      : isChargeRejection
        ? CHARGE_DISPLAY_CODES
        : [];
  if (
    !definition ||
    payload.stage !== definition.stage ||
    payload.classification !== definition.classification ||
    typeof payload.outcome !== 'string' ||
    !definition.outcomes.includes(
      payload.outcome as NonNullable<OperationFailureMetadata['outcome']>,
    ) ||
    payload.correlation_id !== expected.correlationId ||
    (displayCode !== undefined &&
      (typeof displayCode !== 'string' || !allowedDisplayCodes.includes(displayCode)))
  )
    return fallback;

  const serverError = sanitizeServerError(payload.error);
  const detail = serverError ?? fallback.detail;

  return {
    ...fallback,
    code: payload.reason_code,
    reasonCode: payload.reason_code,
    stage: definition.stage,
    outcome: payload.outcome as NonNullable<OperationFailureMetadata['outcome']>,
    classification: definition.classification,
    correlationId: expected.correlationId,
    displayCode: typeof displayCode === 'string' ? displayCode : null,
    serverError,
    detail,
    trusted: true,
  };
}

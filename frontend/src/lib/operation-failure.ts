import { sanitizeServerError } from './order-attempt';

export const OPERATION_REFERENCE_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isOperationReference(value: unknown): value is string {
  return typeof value === 'string' && OPERATION_REFERENCE_V4.test(value);
}

export const SUPPORT_LOG_TAIL_MAX_CHARS = 16 * 1024;

export function boundSupportLogTail(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  return raw.length > SUPPORT_LOG_TAIL_MAX_CHARS ? raw.slice(-SUPPORT_LOG_TAIL_MAX_CHARS) : raw;
}

export async function readBoundedSupportLogTail(
  attachLog: boolean,
  getLogTail?: (() => Promise<unknown>) | null,
): Promise<string | undefined> {
  if (!attachLog || typeof getLogTail !== 'function') return undefined;
  try {
    const result = await getLogTail();
    if (result && typeof result === 'object' && 'text' in result) {
      return boundSupportLogTail((result as { text?: unknown }).text);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface SupportErrorContextSnapshot {
  storeId: string;
  userId: string | null;
  token: string | null;
  sessionEpoch: number;
}

function normalizeStoreId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

export function isSupportErrorContextCurrent(
  origin: SupportErrorContextSnapshot,
  current: {
    storeId: string | number;
    initialStoreId?: string | number | null;
    userId: string | null;
    token: string | null;
    sessionEpoch: number;
  },
): boolean {
  if (origin.sessionEpoch !== current.sessionEpoch) return false;
  if (origin.userId !== current.userId) return false;
  if ((origin.token ?? null) !== (current.token ?? null)) return false;
  const originStore = normalizeStoreId(origin.storeId);
  const currentStore = normalizeStoreId(current.storeId);
  if (!originStore || !currentStore) return false;
  if (originStore === currentStore) return true;
  if (originStore === 'default') {
    const hydratedInitial = normalizeStoreId(current.initialStoreId);
    return hydratedInitial !== null && hydratedInitial === currentStore;
  }
  return false;
}

export function buildPosSupportTicketRequestBody(input: {
  payload: Record<string, unknown>;
  subject: string;
  ticketCorrelationId: string;
  clientTicketId: string;
  attachLog: boolean;
  logTail?: unknown;
}): Record<string, unknown> {
  const boundedLogTail = input.attachLog ? boundSupportLogTail(input.logTail) : undefined;
  return {
    ...input.payload,
    subject: input.subject,
    correlation_id: input.ticketCorrelationId,
    client_ticket_id: input.clientTicketId,
    ...(boundedLogTail ? { log_tail: boundedLogTail } : {}),
  };
}

export const PRINT_FAILURE_CLASSES = [
  'not_configured',
  'offline',
  'needs_attention',
  'queue_unavailable',
  'spooler_error',
  'driver_error',
  'permission_denied',
  'timeout',
  'write_error',
  'unsupported',
  'unknown',
] as const;

export type PrintFailureClass = (typeof PRINT_FAILURE_CLASSES)[number];

export const PRINT_CONNECTION_TYPES = ['network', 'usb', 'webusb', 'unknown'] as const;

export type PrintConnectionType = (typeof PRINT_CONNECTION_TYPES)[number];

export type PrintFailureKind = 'receipt' | 'kot';
export type PrintFailureStage = 'prepare' | 'dispatch' | 'printing';
export type PrintFailureOutcome = 'not_applied' | 'partial' | 'unknown';

const PRINT_FAILURE_CLASS_SET = new Set<string>(PRINT_FAILURE_CLASSES);
const PRINT_CONNECTION_TYPE_SET = new Set<string>(PRINT_CONNECTION_TYPES);

export function isPrintFailureClass(value: unknown): value is PrintFailureClass {
  return typeof value === 'string' && PRINT_FAILURE_CLASS_SET.has(value);
}

export function isPrintConnectionType(value: unknown): value is PrintConnectionType {
  return typeof value === 'string' && PRINT_CONNECTION_TYPE_SET.has(value);
}

export function normalizePrinterConnectionType(value: unknown): PrintConnectionType {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase();
  if (isPrintConnectionType(normalized)) return normalized;
  return 'unknown';
}

export const MAX_PRINTER_DETAIL_LENGTH = 400;
const TRUNCATED_SUFFIX = ' ... [truncated]';
const BASE64_COMMAND_BLOB_RE = /[A-Za-z0-9+/]{60,}={0,2}/;
const QUOTED_PAYLOAD_FILE_RE =
  /(['"])(?:[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n'"]+\\)*flo_print_[^'"\r\n]+|\/(?:tmp|var\/folders|var\/tmp|private\/tmp)\/[^'"\r\n]*flo_print_[^'"\r\n]+)\1/gi;
const PAYLOAD_FILE_RE =
  /(?:[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n\s'"]+\\)*flo_print_[^\s'"]+\.bin|\/(?:tmp|var\/folders|var\/tmp|private\/tmp)\/[^\s'"]*flo_print_[^\s'"]+\.bin|\bflo_print_[A-Za-z0-9_-]+\.bin\b)/gi;
const QUOTED_OS_PATH_RE =
  /(['"])(?:[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n'"]+\\)+[^\\/:*?"<>|\r\n'"]*|\/(?:tmp|var\/folders|var\/tmp|private\/tmp|Users|home)\/[^'"\r\n]+)\1/g;
const OS_PATH_RE =
  /(?:[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n\s'"]+\\)+[^\\/:*?"<>|\r\n\s'"]*|\/(?:tmp|var\/folders|var\/tmp|private\/tmp|Users|home)\/[^\s'"]+)/g;
const WINDOWS_SUBPROCESS_LEAK_RE =
  /\s-EncodedCommand\b|\s-NoProfile\b|\s-NonInteractive\b|\bpowershell(?:\.exe)?\b/i;
const SUBPROCESS_COMMAND_LEAK_RE =
  /\bCommand failed:|\s-EncodedCommand\b|\s-NoProfile\b|\s-NonInteractive\b|\bpowershell(?:\.exe)?\b/i;

function decodeClixmlEscapes(value: string): string {
  return value
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => {
      const code = parseInt(hex, 16);
      if (code === 0x0d || code === 0x0a) return '\n';
      return String.fromCharCode(code);
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripPowerShellClixml(raw: string): string {
  if (!raw.includes('#< CLIXML') && !raw.includes('<Objs')) {
    return raw;
  }
  const errorTagMatches = Array.from(raw.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g));
  if (errorTagMatches.length > 0) {
    const objsIndex = raw.indexOf('<Objs');
    const prefix =
      objsIndex > 0
        ? raw
            .slice(0, objsIndex)
            .replace(/^#<\s*CLIXML[\r\n\s]*/i, '')
            .trim()
        : '';
    const extracted = decodeClixmlEscapes(errorTagMatches.map((m) => m[1]).join(''))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 0 &&
          !/^At line:\d+/i.test(line) &&
          !/^\+\s/.test(line) &&
          !/^CategoryInfo\s*:/i.test(line) &&
          !/^FullyQualifiedErrorId\s*:/i.test(line),
      );
    return [prefix, ...extracted].filter(Boolean).join('\n');
  }

  return decodeClixmlEscapes(
    raw
      .replace(/#<\s*CLIXML[\r\n\s]*/gi, '')
      .replace(/<Objs\b[^>]*>[\s\S]*?<\/Objs>/gi, '')
      .replace(/<Objs\b[\s\S]*$/gi, ''),
  ).trim();
}

export function sanitizePrinterErrorDetail(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const hadClixml = trimmed.includes('#< CLIXML') || trimmed.includes('<Objs');
  const clixmlCleaned = stripPowerShellClixml(trimmed);
  const hadWindowsSubprocessLeak =
    WINDOWS_SUBPROCESS_LEAK_RE.test(clixmlCleaned) || BASE64_COMMAND_BLOB_RE.test(clixmlCleaned);
  const hadSubprocessLeak =
    hadWindowsSubprocessLeak || SUBPROCESS_COMMAND_LEAK_RE.test(clixmlCleaned);
  const timedOut = /timed?\s*out|etimedout/i.test(clixmlCleaned);

  const safeLines = clixmlCleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^\s*at\s+\S+/i.test(line)) return false;
      if (/^At line:\d+/i.test(line)) return false;
      if (/^\+\s/.test(line)) return false;
      if (SUBPROCESS_COMMAND_LEAK_RE.test(line)) return false;
      if (BASE64_COMMAND_BLOB_RE.test(line)) return false;
      return true;
    })
    .map((line) =>
      line
        .replace(QUOTED_PAYLOAD_FILE_RE, "'<payload file>'")
        .replace(PAYLOAD_FILE_RE, '<payload file>')
        .replace(QUOTED_OS_PATH_RE, "'<path>'")
        .replace(OS_PATH_RE, '<path>')
        .trim(),
    )
    .filter(Boolean);

  if (safeLines.length === 0) {
    if (hadWindowsSubprocessLeak || (hadSubprocessLeak && hadClixml)) {
      return timedOut ? 'Windows print command timed out' : 'Windows raw print failed';
    }
    if (hadSubprocessLeak) {
      return timedOut ? 'Print command timed out' : 'Print command failed';
    }
    return '';
  }

  const joined = safeLines.join('\n');
  if (joined.length <= MAX_PRINTER_DETAIL_LENGTH) {
    return joined;
  }
  return (
    joined.slice(0, MAX_PRINTER_DETAIL_LENGTH - TRUNCATED_SUFFIX.length).trimEnd() +
    TRUNCATED_SUFFIX
  );
}

export function classifyPrinterFailureClass(
  detail?: unknown,
  explicitClass?: unknown,
): PrintFailureClass {
  if (isPrintFailureClass(explicitClass) && explicitClass !== 'unknown') {
    return explicitClass;
  }
  const text = sanitizePrinterErrorDetail(detail);
  if (text) {
    if (/no (?:default )?printer configured|printer not configured/i.test(text)) {
      return 'not_configured';
    }
    if (
      /offline|not connected|disconnected|no such device|device not found|host is down|enetunreach|ehostunreach|econnrefused/i.test(
        text,
      )
    ) {
      return 'offline';
    }
    if (
      /paper out|out of paper|paper jam|jammed|cover open|door open|toner low|ink low|needs attention/i.test(
        text,
      )
    ) {
      return 'needs_attention';
    }
    if (/paused|rejecting jobs|not accepting|disabled|queue unavailable/i.test(text)) {
      return 'queue_unavailable';
    }
    if (
      /spooler|rpc server|print processor|winspool|startdocprinter|writeprinter|cupsd/i.test(text)
    ) {
      return 'spooler_error';
    }
    if (/driver|filter failed|rendering failed|invalid printer name/i.test(text)) {
      return 'driver_error';
    }
    if (/access is denied|permission denied|unauthorized|eacces|eprem/i.test(text)) {
      return 'permission_denied';
    }
    if (/timed?\s*out|etimedout/i.test(text)) {
      return 'timeout';
    }
    if (
      /unsupported|not supported|financial row|pop-?ups?\b|print window|browser print mode/i.test(
        text,
      )
    ) {
      return 'unsupported';
    }
    if (/write error|epipe|econnreset|broken pipe|transfer.*failed|claiminterface/i.test(text)) {
      return 'write_error';
    }
  }
  if (isPrintFailureClass(explicitClass)) {
    return explicitClass;
  }
  return 'unknown';
}

export interface PrinterOperationErrorInit {
  kind: PrintFailureKind;
  code?: string;
  failure_class?: unknown;
  connection_type?: unknown;
  stage?: unknown;
  correlation_id?: unknown;
  outcome?: unknown;
  detail?: unknown;
  fallbackDetail?: string;
  status?: number | null;
}

export class PrinterOperationError extends Error {
  readonly kind: PrintFailureKind;
  readonly code: string;
  readonly failure_class: PrintFailureClass;
  readonly connection_type: PrintConnectionType;
  readonly stage: PrintFailureStage;
  readonly correlation_id: string | null;
  readonly outcome: PrintFailureOutcome;
  readonly capture_point: string | null;
  readonly detail: string;
  readonly status: number | null;

  constructor(init: PrinterOperationErrorInit) {
    const sanitizedDetail = sanitizePrinterErrorDetail(init.detail);
    const fallback = sanitizePrinterErrorDetail(init.fallbackDetail);
    const effectiveDetail = sanitizedDetail || fallback || 'Print failed';
    super(effectiveDetail);
    this.name = 'PrinterOperationError';
    this.kind = init.kind;
    this.connection_type = normalizePrinterConnectionType(init.connection_type);
    const stage: PrintFailureStage =
      init.stage === 'prepare' || init.stage === 'dispatch' || init.stage === 'printing'
        ? init.stage
        : 'dispatch';
    this.stage = stage;
    const expectedCode = init.kind === 'kot' ? 'print.kot.failed' : 'print.receipt.failed';
    const normalizedCode =
      typeof init.code === 'string' && init.code.trim().length > 0
        ? init.code.trim()
        : expectedCode;
    this.code = normalizedCode;
    const backendCorrelationId = isOperationReference(init.correlation_id)
      ? init.correlation_id
      : null;
    const hasTrustedBackendCapture =
      backendCorrelationId !== null &&
      (init.stage === 'prepare' || init.stage === 'dispatch') &&
      normalizedCode === expectedCode;
    const failureClass =
      hasTrustedBackendCapture && isPrintFailureClass(init.failure_class)
        ? init.failure_class
        : classifyPrinterFailureClass(sanitizedDetail || effectiveDetail, init.failure_class);
    this.failure_class = failureClass;
    this.correlation_id = hasTrustedBackendCapture ? backendCorrelationId : null;
    const outcome: PrintFailureOutcome =
      init.outcome === 'not_applied' || init.outcome === 'partial' || init.outcome === 'unknown'
        ? init.outcome
        : stage === 'prepare'
          ? 'not_applied'
          : 'unknown';
    this.outcome = outcome;
    const pointStage = failureClass === 'timeout' ? 'timeout' : 'queue';
    this.capture_point = hasTrustedBackendCapture
      ? `fc.backend.printer.${init.kind}.${pointStage}`
      : null;
    this.detail = sanitizedDetail;
    this.status = typeof init.status === 'number' ? init.status : null;
  }
}

export function toPrinterOperationError(
  error: unknown,
  defaults: {
    kind: PrintFailureKind;
    connectionType?: unknown;
    stage?: PrintFailureStage;
    fallbackDetail?: string;
  },
): PrinterOperationError {
  if (error instanceof PrinterOperationError) {
    return error;
  }
  const errObj = error as {
    response?: {
      status?: number;
      data?: {
        error?: unknown;
        detail?: unknown;
        failure_class?: unknown;
        connection_type?: unknown;
        code?: unknown;
        correlation_id?: unknown;
        stage?: unknown;
      };
    };
    message?: unknown;
  } | null;

  const responseData = errObj?.response?.data;
  const rawDetail =
    (typeof responseData?.detail === 'string' && responseData.detail) ||
    (typeof responseData?.error === 'string' && responseData.error) ||
    (typeof errObj?.message === 'string' && errObj.message) ||
    '';
  const expectedCode = defaults.kind === 'kot' ? 'print.kot.failed' : 'print.receipt.failed';
  const hasBackendPrinterCapture =
    isOperationReference(responseData?.correlation_id) &&
    (responseData?.stage === 'prepare' || responseData?.stage === 'dispatch') &&
    responseData?.code === expectedCode;

  return new PrinterOperationError({
    kind: defaults.kind,
    code: typeof responseData?.code === 'string' ? responseData.code : undefined,
    failure_class: responseData?.failure_class,
    connection_type: responseData?.connection_type ?? defaults.connectionType,
    stage: responseData?.stage ?? defaults.stage ?? 'dispatch',
    correlation_id: hasBackendPrinterCapture ? responseData.correlation_id : null,
    detail: rawDetail,
    fallbackDetail: defaults.fallbackDetail,
    status: typeof errObj?.response?.status === 'number' ? errObj.response.status : null,
  });
}

const GENERIC_PRINT_MESSAGES = new Set([
  'print failed',
  'receipt print failed',
  'kot print failed',
  'print failed. check printer connection and settings.',
  'kot print failed. check printer connection.',
]);

export interface PrinterSupportOperationFailurePayload {
  capture_point: string;
  operation_id: string;
  outcome: PrintFailureOutcome;
  facts: {
    kind: PrintFailureKind;
    failure_class: PrintFailureClass;
    connection_type: PrintConnectionType;
  };
}

export interface PrinterFailureSupportDescriptor {
  kind: PrintFailureKind;
  code: string;
  reasonCode: string;
  failure_class: PrintFailureClass;
  connection_type: PrintConnectionType;
  stage: PrintFailureStage;
  outcome: PrintFailureOutcome;
  correlation_id: string | null;
  capture_point: string | null;
  detail: string;
  hasSpecificDetail: boolean;
  status: number | null;
  operation_failure?: PrinterSupportOperationFailurePayload;
}

export function buildPrinterOperationFailureSupportPayload(
  error: unknown,
  options: {
    kind: PrintFailureKind;
    connectionType?: unknown;
    fallbackDetail: string;
  },
): PrinterFailureSupportDescriptor {
  const printerErr = toPrinterOperationError(error, {
    kind: options.kind,
    connectionType: options.connectionType,
    fallbackDetail: options.fallbackDetail,
  });
  const candidateDetail = printerErr.detail || sanitizePrinterErrorDetail(printerErr.message);
  const hasSpecificDetail =
    candidateDetail.length > 0 && !GENERIC_PRINT_MESSAGES.has(candidateDetail.toLowerCase());
  const effectiveDetail = hasSpecificDetail ? candidateDetail : options.fallbackDetail;
  const reasonCode =
    printerErr.failure_class === 'timeout' ? 'printer.timeout' : 'printer.queue_failed';
  const operationFailure =
    printerErr.capture_point && printerErr.correlation_id
      ? {
          capture_point: printerErr.capture_point,
          operation_id: printerErr.correlation_id,
          outcome: printerErr.outcome,
          facts: {
            kind: options.kind,
            failure_class: printerErr.failure_class,
            connection_type: printerErr.connection_type,
          },
        }
      : undefined;

  return {
    kind: options.kind,
    code: printerErr.code,
    reasonCode,
    failure_class: printerErr.failure_class,
    connection_type: printerErr.connection_type,
    stage: printerErr.stage,
    outcome: printerErr.outcome,
    correlation_id: printerErr.correlation_id,
    capture_point: printerErr.capture_point,
    detail: effectiveDetail,
    hasSpecificDetail,
    status: printerErr.status,
    ...(operationFailure ? { operation_failure: operationFailure } : {}),
  };
}

export function extractQuotedItemName(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const match = text.match(/"([^"\r\n]{1,80})"/);
  if (!match) return null;
  const candidate = match[1].trim();
  if (!candidate) return null;
  if (/https?:\/\//i.test(candidate)) return null;
  if (!sanitizeServerError(candidate)) return null;
  return candidate;
}

export function isStockInsufficientRejection(input: {
  reasonCode?: string | null;
  displayCode?: string | null;
  message?: string | null;
  detail?: string | null;
}): boolean {
  if (input.reasonCode === 'order.stock_insufficient') {
    return true;
  }
  const unquoted = `${input.message || ''} ${input.detail || ''}`.replace(/"[^"\r\n]*"/g, '""');
  return /\binsufficient\s+stock\b|\bout\s+of\s+stock\b/i.test(unquoted);
}

export function isClosedBooksRejection(input: {
  reasonCode?: string | null;
  displayCode?: string | null;
  message?: string | null;
  detail?: string | null;
}): boolean {
  if (input.displayCode === 'day_closed' || input.displayCode === 'day_already_closed') {
    return true;
  }
  const combined = `${input.message || ''} ${input.detail || ''}`;
  return /books\s+are\s+(?:already\s+)?closed|(?:business\s+|this\s+)?day\s+is\s+(?:already\s+)?closed/i.test(
    combined,
  );
}

export function isShiftRequiredRejection(input: {
  reasonCode?: string | null;
  displayCode?: string | null;
  message?: string | null;
  detail?: string | null;
}): boolean {
  if (
    input.displayCode === 'cash_session_required' ||
    input.displayCode === 'session_already_closed'
  ) {
    return true;
  }
  const combined = `${input.message || ''} ${input.detail || ''}`;
  return /\bno\s+open\s+(?:shift|cash\s+session)\b|\bopen\s+a\s+shift\s+before\b|\bshift\s+is\s+(?:already\s+)?closed\b/i.test(
    combined,
  );
}

export type PosValidationRejectionKind =
  | 'stock_insufficient'
  | 'shift_required'
  | 'closed_books'
  | 'validation';

export type PosCorrectiveAction =
  | { kind: 'link'; href: '/products' | '/inventory' }
  | { kind: 'open_shift' };

export function resolvePosValidationAction(
  rejectionKind: PosValidationRejectionKind | null,
  permissions: {
    canManageCatalog?: boolean;
    canViewInventory?: boolean;
    canUseShift?: boolean;
  } = {},
): PosCorrectiveAction | null {
  if (rejectionKind === 'stock_insufficient') {
    if (permissions.canManageCatalog) return { kind: 'link', href: '/products' };
    if (permissions.canViewInventory) return { kind: 'link', href: '/inventory' };
    return null;
  }
  if (rejectionKind === 'shift_required') {
    return permissions.canUseShift ? { kind: 'open_shift' } : null;
  }
  return null;
}

export interface PosFailureSupportMetadata {
  isExpectedRejection: boolean;
  variant: 'validation' | 'error';
  category: 'general' | 'printer' | 'bug';
  subject: string;
  rejectionKind: PosValidationRejectionKind | null;
  affectedItem: string | null;
}

export function resolvePosFailureSupportMetadata(input: {
  operation: string;
  classification?: string;
  outcome?: string;
  reasonCode?: string | null;
  displayCode?: string | null;
  code: string;
  message: string;
  detail: string;
}): PosFailureSupportMetadata {
  const isExpectedRejection = input.classification === 'expected_rejection';
  if (!isExpectedRejection) {
    const isPrinter =
      input.operation === 'printer.print' ||
      input.code.startsWith('print.') ||
      input.code.startsWith('printer.');
    return {
      isExpectedRejection: false,
      variant: 'error',
      category: isPrinter ? 'printer' : 'bug',
      subject: isPrinter ? 'FloCafe printer problem' : 'FloCafe order problem',
      rejectionKind: null,
      affectedItem: null,
    };
  }

  const reasonCode = input.reasonCode || input.code;
  if (
    isStockInsufficientRejection({
      reasonCode,
      displayCode: input.displayCode,
      message: input.message,
      detail: input.detail,
    })
  ) {
    const affectedItem =
      extractQuotedItemName(input.message) ?? extractQuotedItemName(input.detail);
    return {
      isExpectedRejection: true,
      variant: 'validation',
      category: 'general',
      subject: 'FloCafe inventory or stock validation help',
      rejectionKind: 'stock_insufficient',
      affectedItem,
    };
  }

  if (
    isClosedBooksRejection({
      reasonCode,
      displayCode: input.displayCode,
      message: input.message,
      detail: input.detail,
    })
  ) {
    return {
      isExpectedRejection: true,
      variant: 'validation',
      category: 'general',
      subject: 'FloCafe business day or shift validation help',
      rejectionKind: 'closed_books',
      affectedItem: null,
    };
  }

  if (
    isShiftRequiredRejection({
      reasonCode,
      displayCode: input.displayCode,
      message: input.message,
      detail: input.detail,
    })
  ) {
    return {
      isExpectedRejection: true,
      variant: 'validation',
      category: 'general',
      subject: 'FloCafe business day or shift validation help',
      rejectionKind: 'shift_required',
      affectedItem: null,
    };
  }

  const subject =
    reasonCode === 'payment.invalid'
      ? 'FloCafe payment validation help'
      : reasonCode === 'discount.rejected'
        ? 'FloCafe discount validation help'
        : 'FloCafe order validation help';

  return {
    isExpectedRejection: true,
    variant: 'validation',
    category: 'general',
    subject,
    rejectionKind: 'validation',
    affectedItem: null,
  };
}

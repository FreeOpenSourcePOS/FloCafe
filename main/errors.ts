import { randomUUID } from 'crypto';

export type FloErrorCode =
  | `print.${string}`
  | `tax.${string}`
  | `migration.${string}`
  | `backup.${string}`
  | `cloud.${string}`
  | `update.${string}`;

export type CorrelatedError = Error & { code: FloErrorCode; correlationId: string };

export function correlationId(): string {
  return randomUUID();
}

export function correlatedError(code: FloErrorCode, message: string, cause?: unknown): CorrelatedError {
  const error = new Error(message) as CorrelatedError;
  error.name = 'FloOperationError';
  error.code = code;
  error.correlationId = correlationId();
  if (cause) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

export function errorDetails(error: unknown, fallbackCode: FloErrorCode): { code: FloErrorCode; correlationId: string; message: string } {
  const candidate = error as Partial<CorrelatedError> | null;
  return {
    code: candidate?.code || fallbackCode,
    correlationId: candidate?.correlationId || correlationId(),
    message: error instanceof Error ? error.message : String(error),
  };
}

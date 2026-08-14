import { Request, Response, NextFunction, RequestHandler } from 'express';
import { trackHttpRequestWork } from '../shutdown';

/**
 * Wrap an async Express handler so rejected promises flow to the global
 * error handler at main/server.ts:198 instead of crashing the request.
 * Saves a try/catch boilerplate per route.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    const operation = Promise.resolve().then(() => fn(req, res, next));
    trackHttpRequestWork(req, operation).catch(next);
  };
}

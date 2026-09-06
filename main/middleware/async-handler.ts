import { Request, Response, NextFunction, RequestHandler } from 'express';
import { trackHttpRequestWork } from '../shutdown';

/** Wrap async Express handler so rejected promises flow to the global error handler. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    const operation = Promise.resolve().then(() => fn(req, res, next));
    trackHttpRequestWork(req, operation).catch(next);
  };
}

import { Request, Response, NextFunction } from 'express';
import { authorizeMasterPin } from '../services/master-pin';
import { normalizeIpForRateLimit } from './security';

/** Requires master_pin in request body or x-master-pin header; rate limit is shared per normalized IP. */
export function requireMasterPin(req: Request, res: Response, next: NextFunction): void {
  const ip = normalizeIpForRateLimit(req.ip || req.socket?.remoteAddress || 'unknown');
  const rawMasterPin =
    req.body?.master_pin !== undefined
      ? req.body.master_pin
      : typeof req.headers['x-master-pin'] === 'string'
        ? req.headers['x-master-pin']
        : undefined;
  const result = authorizeMasterPin(rawMasterPin, `master-pin:${ip}`);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  next();
}

import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import {
  SupplyMovementType,
  createSupply,
  getSupply,
  listSupplies,
  listSupplyMovements,
  recordSupplyMovement,
  softDeleteSupply,
  updateSupply,
} from '../services/supplies';

const router = Router();
const MANUAL_MOVEMENT_TYPES: Array<'receive' | 'count' | 'adjustment' | 'waste'> = ['receive', 'count', 'adjustment', 'waste'];
const ALL_MOVEMENT_TYPES: SupplyMovementType[] = ['receive', 'count', 'adjustment', 'waste', 'recipe_depletion', 'recipe_restore'];

function sendError(res: Response, error: unknown): void {
  const details = error as { statusCode?: unknown; message?: unknown };
  const statusCode = Number.isInteger(details.statusCode) ? details.statusCode as number : 500;
  if (statusCode >= 500) console.error('[API] Internal error:', error);
  res.status(statusCode).json({ error: statusCode >= 500 ? 'Internal server error' : details.message });
}

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw Object.assign(new Error(`${field} must be a non-empty string of at most 128 characters`), { statusCode: 400 });
  }
  return value.trim();
}

router.get('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const includeInactive = req.query.include_inactive === 'true' || req.query.include_inactive === '1';
    const lowStockOnly = req.query.low_stock === 'true' || req.query.low_stock === '1';
    const search = queryString(req.query.search, 'search');
    const supplies = listSupplies(db, { includeInactive, lowStockOnly, search });
    res.json({ supplies });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.post('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const supply = createSupply(getDatabase(), {
      name: body.name,
      baseUnit: body.base_unit,
      stockQuantity: body.stock_quantity,
      lowStockThreshold: body.low_stock_threshold,
      isActive: body.is_active,
    });
    res.status(201).json({ supply });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/movements', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const supplyId = queryString(req.query.supply_id, 'supply_id');
    const movementType = queryString(req.query.movement_type, 'movement_type') as SupplyMovementType | undefined;
    if (movementType && !ALL_MOVEMENT_TYPES.includes(movementType)) {
      return res.status(400).json({ error: 'movement_type is invalid' });
    }
    const rawBeforeId = req.query.before_id;
    const beforeId = rawBeforeId === undefined
      ? undefined
      : typeof rawBeforeId === 'string' && /^\d+$/.test(rawBeforeId) ? Number(rawBeforeId) : NaN;
    if (beforeId !== undefined && (!Number.isSafeInteger(beforeId) || beforeId <= 0)) {
      return res.status(400).json({ error: 'before_id must be a positive integer' });
    }
    const rawPerPage = req.query.per_page;
    const requestedPerPage = rawPerPage === undefined ? NaN : Number(rawPerPage);
    const perPage = Number.isInteger(requestedPerPage) && requestedPerPage > 0
      ? Math.min(requestedPerPage, 500)
      : 50;

    const page = listSupplyMovements(getDatabase(), { supplyId, movementType, beforeId, perPage });
    res.json({
      movements: page.movements,
      ...(page.nextCursor !== null && { nextCursor: page.nextCursor }),
    });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const supply = getSupply(getDatabase(), String(req.params.id));
    res.json({ supply });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.put('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const supply = updateSupply(getDatabase(), String(req.params.id), {
      name: body.name,
      isActive: body.is_active,
      lowStockThreshold: body.low_stock_threshold,
    });
    res.json({ supply });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.delete('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    softDeleteSupply(getDatabase(), String(req.params.id));
    res.json({ success: true });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.post('/:id/movements', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const actorId = String((req as any).user?.userId || '');
    if (!actorId) return res.status(403).json({ error: 'Authentication required' });
    const body = req.body || {};
    const movementType = body.movement_type;
    if (!MANUAL_MOVEMENT_TYPES.includes(movementType)) {
      return res.status(400).json({ error: 'movement_type must be one of: receive, count, adjustment, waste' });
    }
    const movement = recordSupplyMovement(getDatabase(), {
      supplyId: String(req.params.id),
      movementType,
      quantity: body.quantity,
      unit: body.unit,
      reason: body.reason,
      actorUserId: actorId,
    });
    res.status(201).json({ movement });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

export const supplyRoutes = router;

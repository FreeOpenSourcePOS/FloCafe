import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requirePermission } from '../services/authorization';
import { InventoryMovementType, listInventoryMovements } from '../services/inventory';

const router = Router();
const MOVEMENT_TYPES: InventoryMovementType[] = ['sale', 'cancel_restore', 'adjustment'];

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw Object.assign(new Error(`${field} must be a non-empty string of at most 128 characters`), { statusCode: 400 });
  }
  return value.trim();
}

router.get('/movements', requirePermission('inventory.view'), (req: Request, res: Response) => {
  try {
    const productId = queryString(req.query.product_id, 'product_id');
    const referenceType = queryString(req.query.reference_type, 'reference_type');
    const referenceId = queryString(req.query.reference_id, 'reference_id');
    const movementType = queryString(req.query.movement_type, 'movement_type') as InventoryMovementType | undefined;
    if (movementType && !MOVEMENT_TYPES.includes(movementType)) {
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

    const page = listInventoryMovements(getDatabase(), {
      productId,
      movementType,
      referenceType,
      referenceId,
      beforeId,
      perPage,
    });
    res.json({
      movements: page.movements,
      ...(page.nextCursor !== null && { nextCursor: page.nextCursor }),
    });
  } catch (error: unknown) {
    const details = error as { statusCode?: unknown; message?: unknown };
    const statusCode = Number.isInteger(details.statusCode) ? details.statusCode as number : 500;
    if (statusCode >= 500) console.error('[API] Internal error:', error);
    res.status(statusCode).json({ error: statusCode >= 500 ? 'Internal server error' : details.message });
  }
});

export const inventoryRoutes = router;

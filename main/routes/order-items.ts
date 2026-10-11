import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import {
  getDatabase,
  getKdsStationCategoryIds,
  getKdsStationRoutingScope,
  getUserKdsStationIds,
  hasUserKdsStationAssignments,
  isKdsStationItemAllowed,
  now,
  parseItemJson,
  attachEffectiveAddons,
  isVoidedItemKdsVisible,
  projectKdsItem,
  projectKdsOrder,
  withTxn,
} from '../db';
import { notifyKdsUpdate } from '../services/kds';
import { parseCategoryIds } from './auth';
import { requireKdsEnabled, isTokenRevoked, isTokenStale } from '../middleware/security';
import { hasPermission, requirePermission } from '../services/authorization';
import { ROLE_ACCESS, hasRole } from '../../shared/role-permissions';
import { cloudSync } from '../services/cloud-sync';
import { isOperationReference, serializeOperationFailure } from '../lib/operation-failure';

const router = Router();

function structuredKdsStatusFailure(
  req: Request,
  capturePoint: string,
  outcome: 'not_applied' | 'applied' | 'unknown',
  displayCode?: string,
): Record<string, unknown> {
  const header = req.get('x-operation-id');
  const correlationId = isOperationReference(header) ? header : randomUUID();
  const failure = serializeOperationFailure({
    capture_point: capturePoint,
    outcome,
    correlation_id: correlationId,
    ...(displayCode ? { facts: { display_code: displayCode } } : {}),
  });
  if (!failure) return {};
  (req as Request & { diagnosticsCaptured?: boolean }).diagnosticsCaptured = true;
  try {
    cloudSync.captureOperationFailure(failure);
  } catch {
    /* Diagnostics must not affect KDS state. */
  }
  return {
    reason_code: failure.reason_code,
    operation: failure.operation,
    stage: failure.stage,
    classification: failure.classification,
    outcome: failure.outcome,
    correlation_id: failure.correlation_id,
    ...(failure.facts.display_code ? { display_code: failure.facts.display_code } : {}),
  };
}

interface OrderItemRow {
  id: number | string;
  order_id: number | string;
  status: string;
  category_id?: string | null;
}

// PATCH /api/order-items/:id/status — update a single item's kitchen status
router.patch(
  '/:id/status',
  requirePermission('kitchen.status.update'),
  requireKdsEnabled,
  (req: Request, res: Response) => {
    let transactionBodyCompleted = false;
    let operationCommitted = false;
    try {
      const requestUserId = (req as any).user?.userId;
      if (!requestUserId || !hasPermission(requestUserId, 'kitchen.status.update')) {
        return res.status(403).json({
          error: 'Only chef, manager, or owner can update item status',
          ...structuredKdsStatusFailure(
            req,
            'fc.backend.kds.item.status.validation',
            'not_applied',
            'action_permission_denied',
          ),
        });
      }

      const itemId = req.params.id;
      if (!itemId) {
        return res.status(400).json({
          error: 'Order item ID is required',
          ...structuredKdsStatusFailure(
            req,
            'fc.backend.kds.item.status.validation',
            'not_applied',
            'item_unavailable',
          ),
        });
      }

      const { status, expected_status: expectedStatus } = req.body;
      const validStatuses = ['pending', 'preparing', 'ready', 'served'];

      if (!status || !validStatuses.includes(status)) {
        return res.status(400).json({
          error: `Valid status required: ${validStatuses.join(', ')}`,
          ...structuredKdsStatusFailure(
            req,
            'fc.backend.kds.item.status.validation',
            'not_applied',
            'invalid_status',
          ),
        });
      }
      if (expectedStatus !== undefined && !validStatuses.includes(expectedStatus)) {
        return res.status(400).json({
          error: `Invalid expected status. Use: ${validStatuses.join(', ')}`,
          ...structuredKdsStatusFailure(
            req,
            'fc.backend.kds.item.status.validation',
            'not_applied',
            'expected_status_invalid',
          ),
        });
      }

      const db = getDatabase();
      const userId = (req as any).user?.userId;
      const currentUser = userId
        ? (db
            .prepare('SELECT role, category_ids FROM users WHERE id = ? AND is_active = 1')
            .get(userId) as { role: string; category_ids: string | null } | undefined)
        : undefined;
      if (!currentUser)
        return res.status(403).json({
          error: 'User account is not active',
          ...structuredKdsStatusFailure(
            req,
            'fc.backend.kds.item.status.validation',
            'not_applied',
            'user_inactive',
          ),
        });
      let categoryIds = hasRole(currentUser.role, ROLE_ACCESS.ownerManager)
        ? []
        : parseCategoryIds(currentUser.category_ids);
      const loadedStationIds = getUserKdsStationIds(db, userId);
      const hasStationAssignments = hasUserKdsStationAssignments(db, userId);
      if (!loadedStationIds || hasStationAssignments === null)
        return res.status(403).json({
          error: 'User account is not active',
          ...structuredKdsStatusFailure(
            req,
            'fc.backend.kds.item.status.authorization_state',
            'not_applied',
          ),
        });
      if (hasStationAssignments && loadedStationIds.length === 0)
        return res.status(403).json({
          error: 'No active kitchen station is assigned to this user',
          ...structuredKdsStatusFailure(
            req,
            'fc.backend.kds.item.status.validation',
            'not_applied',
            'station_unassigned',
          ),
        });
      let stationIds: string[] = loadedStationIds;
      let stationCategoryIds = getKdsStationCategoryIds(db, stationIds)!;
      if (!stationCategoryIds)
        return res.status(403).json({
          error: 'Could not load station permissions',
          ...structuredKdsStatusFailure(
            req,
            'fc.backend.kds.item.status.authorization_state',
            'not_applied',
          ),
        });
      let stationScope = getKdsStationRoutingScope(db, stationIds, categoryIds)!;
      if (!stationScope)
        return res.status(403).json({
          error: 'Could not load station permissions',
          ...structuredKdsStatusFailure(
            req,
            'fc.backend.kds.item.status.authorization_state',
            'not_applied',
          ),
        });
      let stationRoutingCategoryIds = stationScope!.tablelessCategoryIds;
      let restrictedKdsPayload =
        currentUser.role === 'chef' || categoryIds.length > 0 || stationIds.length > 0;

      const orderData = withTxn(() => {
        const liveUser = db
          .prepare(
            'SELECT role, category_ids, tokens_valid_after FROM users WHERE id = ? AND is_active = 1',
          )
          .get(userId) as
          | { role: string; category_ids: string | null; tokens_valid_after: string | null }
          | undefined;
        const token = req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : '';
        if (
          !liveUser ||
          isTokenRevoked(token) ||
          isTokenStale((req as any).user?.iat, liveUser.tokens_valid_after) ||
          !hasPermission(userId, 'kitchen.status.update')
        ) {
          throw Object.assign(new Error('USER_FORBIDDEN'), {
            diagnosticCode: 'action_permission_denied',
          });
        }
        categoryIds = hasRole(liveUser.role, ROLE_ACCESS.ownerManager)
          ? []
          : parseCategoryIds(liveUser.category_ids);
        const liveStationIds = getUserKdsStationIds(db, userId);
        const liveAssignments = hasUserKdsStationAssignments(db, userId);
        if (!liveStationIds || liveAssignments === null)
          throw Object.assign(new Error('PERMISSIONS_UNAVAILABLE'), {
            diagnosticCode: 'permissions_unavailable',
          });
        if (liveAssignments && liveStationIds.length === 0)
          throw Object.assign(new Error('STATION_FORBIDDEN'), {
            diagnosticCode: 'station_unassigned',
          });
        const liveStationCategoryIds = getKdsStationCategoryIds(db, liveStationIds);
        const liveStationScope = getKdsStationRoutingScope(db, liveStationIds, categoryIds);
        if (!liveStationCategoryIds || !liveStationScope)
          throw Object.assign(new Error('PERMISSIONS_UNAVAILABLE'), {
            diagnosticCode: 'permissions_unavailable',
          });
        stationIds = liveStationIds;
        stationCategoryIds = liveStationCategoryIds;
        stationScope = liveStationScope;
        stationRoutingCategoryIds = liveStationScope.tablelessCategoryIds;
        restrictedKdsPayload =
          liveUser.role === 'chef' || categoryIds.length > 0 || stationIds.length > 0;
        const item = db
          .prepare(`
        SELECT oi.*, p.category_id
        FROM order_items oi
        LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.id = ?
      `)
          .get(itemId) as OrderItemRow | undefined;
        if (!item) {
          return null;
        }

        if (item.status === 'voided') {
          throw Object.assign(new Error('VOIDED_ITEM'), { diagnosticCode: 'item_voided' });
        }
        if (item.status === 'void_adjustment') {
          throw Object.assign(new Error('IMMUTABLE_KDS_ITEM'), {
            diagnosticCode: 'item_immutable',
          });
        }
        if (
          item.status === 'completed' ||
          item.status === 'cancelled' ||
          item.status === 'refunded'
        ) {
          throw Object.assign(new Error('TERMINAL_KDS_ITEM'), { diagnosticCode: 'item_terminal' });
        }

        if (
          categoryIds.length > 0 &&
          (!item.category_id || !categoryIds.includes(String(item.category_id)))
        ) {
          throw Object.assign(new Error('CATEGORY_FORBIDDEN'), {
            diagnosticCode: 'category_scope_denied',
          });
        }
        const parentOrder = db.prepare('SELECT id FROM orders WHERE id = ?').get(item.order_id);
        if (!parentOrder)
          throw Object.assign(new Error('ORPHANED_ORDER_ITEM'), {
            diagnosticCode: 'orphaned_order',
          });
        let orderStationId: string | null | undefined;
        if (stationIds.length > 0) {
          const station = db
            .prepare(`
          SELECT t.kitchen_station_id
          FROM orders o LEFT JOIN tables t ON t.id = o.table_id
          WHERE o.id = ?
        `)
            .get(item.order_id) as { kitchen_station_id: string | null } | undefined;
          orderStationId = station?.kitchen_station_id;
          if (
            !isKdsStationItemAllowed(
              stationIds,
              stationRoutingCategoryIds,
              orderStationId,
              item.category_id,
              orderStationId
                ? stationScope.categoryIdsByStation[String(orderStationId)]
                : undefined,
              stationScope.hasUnrestrictedStation,
            )
          ) {
            throw Object.assign(new Error('STATION_FORBIDDEN'), {
              diagnosticCode: 'station_scope_denied',
            });
          }
        }

        const updateResult =
          expectedStatus === undefined
            ? db
                .prepare(
                  "UPDATE order_items SET status = ?, updated_at = ? WHERE id = ? AND status NOT IN ('voided', 'void_adjustment', 'completed', 'cancelled', 'refunded')",
                )
                .run(status, now(), itemId)
            : db
                .prepare(
                  'UPDATE order_items SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
                )
                .run(status, now(), itemId, expectedStatus);
        if (updateResult.changes !== 1)
          throw Object.assign(new Error('STATUS_CONFLICT'), { diagnosticCode: 'status_conflict' });

        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(item.order_id) as any;

        const rawItems = db
          .prepare(`
        SELECT oi.*, p.category_id
        FROM order_items oi
        LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ?
      `)
          .all(item.order_id) as any[];
        const visibleItems = rawItems
          .filter(
            (row) =>
              !['completed', 'cancelled', 'void_adjustment', 'refunded'].includes(row.status),
          )
          .filter((row) => row.status !== 'voided' || isVoidedItemKdsVisible(row.voided_at))
          .filter(
            (row) =>
              categoryIds.length === 0 ||
              (row.category_id && categoryIds.includes(String(row.category_id))),
          )
          .filter(
            (row) =>
              stationIds.length === 0 ||
              isKdsStationItemAllowed(
                stationIds,
                stationRoutingCategoryIds,
                orderStationId,
                row.category_id,
                orderStationId
                  ? stationScope.categoryIdsByStation[String(orderStationId)]
                  : undefined,
                stationScope.hasUnrestrictedStation,
              ),
          );
        const items = attachEffectiveAddons(db, visibleItems.map(parseItemJson)).map((row) =>
          projectKdsItem(row, restrictedKdsPayload),
        );
        const tableRow = order.table_id
          ? (db.prepare('SELECT * FROM tables WHERE id = ?').get(order.table_id) as any)
          : null;
        const table = tableRow
          ? restrictedKdsPayload
            ? { name: tableRow.number }
            : { ...tableRow, name: tableRow.number }
          : null;

        transactionBodyCompleted = true;
        return {
          ...projectKdsOrder(order, restrictedKdsPayload),
          items,
          table,
        };
      });

      if (orderData === null) {
        return res.status(404).json({
          error: 'Order item not found',
          ...structuredKdsStatusFailure(
            req,
            'fc.backend.kds.item.status.validation',
            'not_applied',
            'item_unavailable',
          ),
        });
      }

      operationCommitted = true;
      notifyKdsUpdate();

      res.json({ order: orderData });
    } catch (error: any) {
      const diagnosticCode =
        typeof error?.diagnosticCode === 'string' ? error.diagnosticCode : null;
      if (diagnosticCode) {
        const displayCode =
          diagnosticCode === 'permissions_unavailable' ? undefined : diagnosticCode;
        const capturePoint =
          diagnosticCode === 'permissions_unavailable'
            ? 'fc.backend.kds.item.status.authorization_state'
            : 'fc.backend.kds.item.status.validation';
        const outcome = operationCommitted ? 'applied' : 'not_applied';
        const diagnostic = structuredKdsStatusFailure(
          req,
          capturePoint,
          outcome,
          displayCode || undefined,
        );
        if (error.message === 'VOIDED_ITEM')
          return res.status(400).json({
            error: 'This item has been voided and can no longer be updated',
            ...diagnostic,
          });
        if (error.message === 'USER_FORBIDDEN' || error.message === 'PERMISSIONS_UNAVAILABLE')
          return res
            .status(403)
            .json({ error: 'Could not load current station permissions', ...diagnostic });
        if (error.message === 'STATION_FORBIDDEN')
          return res
            .status(403)
            .json({ error: 'Could not load current station permissions', ...diagnostic });
        if (error.message === 'CATEGORY_FORBIDDEN')
          return res
            .status(403)
            .json({ error: 'Not authorized to update this item', ...diagnostic });
        if (error.message === 'IMMUTABLE_KDS_ITEM')
          return res
            .status(400)
            .json({ error: 'This bill adjustment cannot be updated from KDS', ...diagnostic });
        if (error.message === 'TERMINAL_KDS_ITEM')
          return res
            .status(400)
            .json({ error: 'This terminal item cannot be updated from KDS', ...diagnostic });
        if (error.message === 'ORPHANED_ORDER_ITEM')
          return res
            .status(404)
            .json({ error: 'Order item is not attached to an order', ...diagnostic });
        if (error.message === 'STATUS_CONFLICT')
          return res
            .status(409)
            .json({ error: 'Item status changed; refresh and try again', ...diagnostic });
      }
      if (error.message === 'VOIDED_ITEM') {
        return res
          .status(400)
          .json({ error: 'This item has been voided and can no longer be updated' });
      }
      if (error.message === 'USER_FORBIDDEN' || error.message === 'PERMISSIONS_UNAVAILABLE') {
        return res.status(403).json({ error: 'Could not load current station permissions' });
      }
      if (error.message === 'CATEGORY_FORBIDDEN' || error.message === 'STATION_FORBIDDEN') {
        return res.status(403).json({ error: 'Not authorized to update this item' });
      }
      if (error.message === 'IMMUTABLE_KDS_ITEM') {
        return res.status(400).json({ error: 'This bill adjustment cannot be updated from KDS' });
      }
      if (error.message === 'TERMINAL_KDS_ITEM') {
        return res.status(400).json({ error: 'This terminal item cannot be updated from KDS' });
      }
      if (error.message === 'ORPHANED_ORDER_ITEM') {
        return res.status(404).json({ error: 'Order item is not attached to an order' });
      }
      if (error.message === 'STATUS_CONFLICT') {
        return res.status(409).json({ error: 'Item status changed; refresh and try again' });
      }
      const capturePoint = operationCommitted
        ? 'fc.backend.kds.item.status.completion'
        : 'fc.backend.kds.item.status.persistence';
      const outcome = operationCommitted
        ? 'applied'
        : transactionBodyCompleted
          ? 'unknown'
          : 'not_applied';
      const diagnostic = structuredKdsStatusFailure(req, capturePoint, outcome);
      console.error('[OrderItems] Status update error:', error);
      res.status(500).json({ error: 'Could not update order item status', ...diagnostic });
    }
  },
);

export const orderItemRoutes = router;

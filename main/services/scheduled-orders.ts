/**
 * Scheduled orders release service and server-owned due sweep.
 *
 * Scheduled orders persist quoted items, prices, discounts, charges, taxes, and
 * totals immediately without touching product/variant/add-on/recipe stock or
 * notifying KDS/KOT. Inventory deduction, recipe depletion snapshots, KDS
 * broadcasts, and automatic KOT printing occur atomically at kitchen release.
 */

import {
  getDatabase,
  getSettingValue,
  hasActiveUnservedOrderItems,
  isDatabaseMaintenanceActive,
  isOrderSettledAndNonRefunded,
  parseDbTimestamp,
  recordOrderAudit,
  withDatabaseRequest,
} from '../db';
import { resolveRegionalSnapshot } from '../countries';
import { adjustProductStock, InventoryServiceError, resolveInventoryDeduction } from './inventory';
import { resolveOrderItemVariant } from './product-variants';
import {
  applyRecipeSnapshot,
  buildRecipeSnapshot,
  extractOrderItemCostFromSnapshot,
  RecipeServiceError,
} from './recipes';
import { SupplyServiceError } from './supplies';
import { notifyKdsUpdate, notifyOrderUpdated } from './kds';
import { cloudSync } from './cloud-sync';
import { autoPrintReleasedOrderKot } from '../routes/printers';
import { parseScheduledForInput } from '../../shared/scheduled-time';

export type OrderReleaseStatus = 'scheduled' | 'released' | 'blocked';
export type ReleaseTrigger = 'sweep' | 'startup' | 'resume' | 'manual';

export const SCHEDULED_SWEEP_INTERVAL_MS = 10_000;
export const ALLOWED_SCHEDULED_ORDER_TYPES = new Set(['takeaway', 'delivery']);

export class ScheduledOrderError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, message: string, code: string) {
    super(message);
    this.name = 'ScheduledOrderError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

class ReleaseHoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseHoldError';
  }
}

export interface ScheduledOrderDbRow {
  id: number;
  order_number: string;
  user_id: string | null;
  type: string;
  status: string;
  scheduled_for: string | null;
  release_status: OrderReleaseStatus;
  released_at: string | null;
  release_blocked_reason: string | null;
  [key: string]: unknown;
}

export interface ReleasePreconditionContext {
  db: ReturnType<typeof getDatabase>;
  order: ScheduledOrderDbRow;
  trigger: ReleaseTrigger;
  nowIso: string;
}

export interface ReleasePreconditionDecision {
  allow: boolean;
  holdReason?: string;
  markBlocked?: boolean;
}

export interface ReleaseScheduledOrderOptions {
  trigger: ReleaseTrigger;
  actorUserId?: string | null;
  nowDate?: Date;
  autoPrintKot?: boolean;
  /** Extension hook so multi-counter checkout can gate release on payment stage. */
  checkPreconditions?: (ctx: ReleasePreconditionContext) => ReleasePreconditionDecision;
}

export interface ReleaseScheduledOrderResult {
  outcome: 'released' | 'already_released' | 'blocked' | 'skipped';
  order: ScheduledOrderDbRow;
  reason?: string;
  kotAutoPrinted: boolean;
}

export interface ScheduledSweepSummary {
  checkedCount: number;
  releasedIds: number[];
  blockedIds: number[];
  skippedIds: number[];
}

export function isScheduledOrderRow(
  order:
    | {
        scheduled_for?: unknown;
        release_status?: unknown;
      }
    | null
    | undefined,
): boolean {
  if (!order) return false;
  return Boolean(
    order.scheduled_for ||
    (typeof order.release_status === 'string' &&
      order.release_status.length > 0 &&
      order.release_status !== 'released'),
  );
}

export function isUnreleasedOrderRow(
  order: { release_status?: unknown } | null | undefined,
): boolean {
  return Boolean(
    typeof order?.release_status === 'string' &&
    order.release_status.length > 0 &&
    order.release_status !== 'released',
  );
}

export function resolveStoreTimezone(db?: ReturnType<typeof getDatabase>): string {
  const readSetting = (key: string): string | undefined => {
    if (db) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value?: string }
        | undefined;
      return row?.value ?? undefined;
    }
    return getSettingValue(key) ?? undefined;
  };
  return resolveRegionalSnapshot({
    country: readSetting('country'),
    currency: readSetting('currency'),
    timezone: readSetting('timezone'),
  }).timezone;
}

export function validateScheduledOrderRequest(
  db: ReturnType<typeof getDatabase>,
  params: {
    orderType: unknown;
    scheduledForInput: unknown;
    nowMs?: number;
  },
): { scheduledForUtc: string; timezone: string } | null {
  const { orderType, scheduledForInput, nowMs = Date.now() } = params;
  if (scheduledForInput === undefined || scheduledForInput === null || scheduledForInput === '') {
    return null;
  }

  const normalizedType = typeof orderType === 'string' && orderType ? orderType : 'takeaway';
  if (!ALLOWED_SCHEDULED_ORDER_TYPES.has(normalizedType)) {
    throw new ScheduledOrderError(
      400,
      'Scheduled orders are supported for takeaway and delivery orders only.',
      'UNSUPPORTED_ORDER_TYPE',
    );
  }

  const timezone = resolveStoreTimezone(db);
  const parsed = parseScheduledForInput({
    input: scheduledForInput,
    timezone,
    nowMs,
  });
  if (!parsed.ok) {
    throw new ScheduledOrderError(400, parsed.message, parsed.code);
  }

  return {
    scheduledForUtc: parsed.isoUtc,
    timezone,
  };
}

function hasNonEmptyPaymentDetails(raw: unknown): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '[]' || trimmed === 'null') return false;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return true;
  }
}

/**
 * True once any payment has been recorded against any bill on the order,
 * including partial payments or payments later refunded.
 */
export function hasRecordedOrderPayment(
  db: ReturnType<typeof getDatabase>,
  orderId: string | number,
): boolean {
  const bills = db
    .prepare('SELECT payment_status, paid_amount, payment_details FROM bills WHERE order_id = ?')
    .all(orderId) as Array<{
    payment_status: string | null;
    paid_amount: number | null;
    payment_details: string | null;
  }>;

  return bills.some(
    (bill) =>
      ['paid', 'partial', 'partially_paid', 'partially_refunded', 'refunded'].includes(
        String(bill.payment_status || ''),
      ) ||
      Number(bill.paid_amount || 0) > 0 ||
      hasNonEmptyPaymentDetails(bill.payment_details),
  );
}

/**
 * Scheduled orders allow item and financial edits only before the first
 * payment is recorded. Afterwards, staff must use correction or refund flows.
 */
export function assertScheduledOrderUnpaidForEdit(
  db: ReturnType<typeof getDatabase>,
  orderId: string | number,
  order:
    | {
        scheduled_for?: string | null;
        release_status?: string | null;
      }
    | null
    | undefined,
): void {
  if (!isScheduledOrderRow(order)) return;
  if (hasRecordedOrderPayment(db, orderId)) {
    throw new ScheduledOrderError(
      409,
      'Item and financial edits are locked after payment is recorded on a scheduled order. Use the refund or payment correction flow instead.',
      'SCHEDULED_ORDER_PAID',
    );
  }
}

function resolveReleaseActorUserId(
  db: ReturnType<typeof getDatabase>,
  preferredActorId: string | null | undefined,
  orderCreatorId: string | null | undefined,
): string | null {
  if (preferredActorId) {
    const row = db.prepare('SELECT id FROM users WHERE id = ?').get(preferredActorId) as
      | { id: string }
      | undefined;
    if (row?.id) return row.id;
  }
  if (orderCreatorId) {
    const row = db.prepare('SELECT id FROM users WHERE id = ?').get(orderCreatorId) as
      | { id: string }
      | undefined;
    if (row?.id) return row.id;
  }
  const fallback = db
    .prepare(
      `SELECT id FROM users
       ORDER BY CASE WHEN role = 'owner' THEN 0 WHEN role = 'manager' THEN 1 ELSE 2 END,
                is_active DESC,
                rowid ASC
       LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  return fallback?.id ?? null;
}

function isCatalogOrStockHoldError(error: unknown): error is Error {
  if (
    error instanceof ReleaseHoldError ||
    error instanceof InventoryServiceError ||
    error instanceof RecipeServiceError ||
    error instanceof SupplyServiceError
  ) {
    return true;
  }
  if (error instanceof Error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (statusCode === 400 || statusCode === 404) {
      return true;
    }
  }
  return false;
}

function formatSqlUtcTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\..*$/, '');
}

/**
 * Shared, transactional release operation for scheduled orders.
 *
 * - Runs inside a SQLite transaction with compare-and-check on `release_status`
 *   so concurrent due sweeps and manual retries never deduct stock twice.
 * - Uses a nested savepoint so any stock shortfall or unusable catalog item
 *   rolls back partial item deductions while committing `release_status = 'blocked'`
 *   and `release_blocked_reason` on the whole order.
 * - Preserves saved prices, discounts, charges, taxes, and totals without repricing.
 */
export async function releaseScheduledOrder(
  db: ReturnType<typeof getDatabase>,
  orderId: string | number,
  options: ReleaseScheduledOrderOptions,
): Promise<ReleaseScheduledOrderResult> {
  const nowDate = options.nowDate ?? new Date();
  const nowIso = nowDate.toISOString();
  const nowDb = formatSqlUtcTimestamp(nowDate);
  const isAutoTrigger = options.trigger !== 'manual';

  const txResult = db.transaction((): Omit<ReleaseScheduledOrderResult, 'kotAutoPrinted'> => {
    const currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as
      | ScheduledOrderDbRow
      | undefined;

    if (!currentOrder) {
      throw new ScheduledOrderError(404, 'Order not found', 'ORDER_NOT_FOUND');
    }

    if (currentOrder.status === 'cancelled' || currentOrder.status === 'completed') {
      if (isAutoTrigger) {
        return {
          outcome: 'skipped',
          reason: 'terminal_order_status',
          order: currentOrder,
        };
      }
      throw new ScheduledOrderError(
        409,
        `Cannot release a ${currentOrder.status} order`,
        'INVALID_ORDER_STATUS',
      );
    }

    if (currentOrder.release_status === 'released') {
      return {
        outcome: 'already_released',
        order: currentOrder,
      };
    }

    if (isAutoTrigger) {
      if (currentOrder.release_status !== 'scheduled') {
        return {
          outcome: 'skipped',
          reason: 'already_blocked',
          order: currentOrder,
        };
      }
      if (!currentOrder.scheduled_for) {
        return {
          outcome: 'skipped',
          reason: 'missing_scheduled_for',
          order: currentOrder,
        };
      }
      const scheduledMs = parseDbTimestamp(currentOrder.scheduled_for).getTime();
      if (!Number.isFinite(scheduledMs) || scheduledMs > nowDate.getTime()) {
        return {
          outcome: 'skipped',
          reason: 'not_due',
          order: currentOrder,
        };
      }
    } else if (
      currentOrder.release_status !== 'scheduled' &&
      currentOrder.release_status !== 'blocked'
    ) {
      throw new ScheduledOrderError(
        409,
        `Order cannot be released from state "${currentOrder.release_status}"`,
        'INVALID_RELEASE_STATUS',
      );
    }

    const effectiveActorId = resolveReleaseActorUserId(
      db,
      options.actorUserId,
      currentOrder.user_id,
    );

    if (options.checkPreconditions) {
      const decision = options.checkPreconditions({
        db,
        order: currentOrder,
        trigger: options.trigger,
        nowIso,
      });
      if (!decision.allow) {
        if (decision.markBlocked) {
          const reason = decision.holdReason || 'Order release preconditions are not satisfied.';
          db.prepare(
            `UPDATE orders
             SET release_status = 'blocked',
                 release_blocked_reason = ?,
                 updated_at = ?
             WHERE id = ?`,
          ).run(reason, nowDb, currentOrder.id);
          if (effectiveActorId) {
            recordOrderAudit(db, {
              orderId: String(currentOrder.id),
              actorUserId: effectiveActorId,
              action: 'release_blocked',
              details: {
                trigger: options.trigger,
                initiated_by: options.actorUserId ? 'staff' : 'server_sweep',
                reason,
              },
            });
          }
          const blockedOrder = db
            .prepare('SELECT * FROM orders WHERE id = ?')
            .get(currentOrder.id) as ScheduledOrderDbRow;
          return {
            outcome: 'blocked',
            reason,
            order: blockedOrder,
          };
        }
        return {
          outcome: 'skipped',
          reason: decision.holdReason || 'precondition_not_met',
          order: currentOrder,
        };
      }
    }

    const deductAndValidateInSavepoint = db.transaction(() => {
      if (!effectiveActorId) {
        throw new ReleaseHoldError(
          'No staff user exists to attribute inventory depletion for this order.',
        );
      }

      const itemRows = db
        .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC')
        .all(currentOrder.id) as Array<{
        id: number;
        product_id: string;
        product_name: string;
        variant_id: string | null;
        quantity: number;
        status: string | null;
      }>;

      const activeItems = itemRows.filter(
        (item) => item.status !== 'cancelled' && item.status !== 'voided',
      );
      if (activeItems.length === 0) {
        throw new ReleaseHoldError('Order has no active items to release to the kitchen.');
      }

      const updateAddonDepletion = db.prepare(
        'UPDATE order_item_addons SET inventory_deducted_quantity = ? WHERE id = ?',
      );
      const updateItemDepletion = db.prepare(
        `UPDATE order_items
         SET inventory_deducted_quantity = ?,
             inventory_product_id = ?,
             inventory_variant_id = ?,
             recipe_snapshot = ?,
             ingredient_cost = ?,
             ingredient_cost_known = ?,
             status = 'pending',
             updated_at = ?
         WHERE id = ?`,
      );

      for (const item of activeItems) {
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id) as
          | {
              id: string;
              name: string;
              category_id: string | null;
              is_active: number;
              deleted_at: string | null;
              track_inventory: number | null;
              inventory_product_id: string | null;
              inventory_deduction_quantity: number | null;
            }
          | undefined;

        if (!product || product.deleted_at) {
          throw new ReleaseHoldError(
            `Product "${item.product_name}" is no longer available in the catalog.`,
          );
        }
        if (Number(product.is_active) !== 1) {
          throw new ReleaseHoldError(`Product "${product.name}" is currently inactive.`);
        }
        if (product.category_id) {
          const category = db
            .prepare('SELECT id, name, is_active FROM categories WHERE id = ?')
            .get(product.category_id) as
            | { id: string; name: string; is_active: number }
            | undefined;
          if (category && Number(category.is_active) === 0) {
            throw new ReleaseHoldError(
              `Category "${category.name}" for "${product.name}" is currently inactive.`,
            );
          }
        }

        const variant = resolveOrderItemVariant(
          db,
          product,
          { variant_id: item.variant_id },
          false,
        );

        const productGroupIds = (
          db
            .prepare('SELECT addon_group_id FROM addon_group_product WHERE product_id = ?')
            .all(product.id) as Array<{ addon_group_id: string }>
        ).map((row) => row.addon_group_id);
        const categoryGroupIds = product.category_id
          ? (
              db
                .prepare('SELECT addon_group_id FROM category_addon_groups WHERE category_id = ?')
                .all(product.category_id) as Array<{ addon_group_id: string }>
            ).map((row) => row.addon_group_id)
          : [];
        const linkedGroupIds = new Set([...productGroupIds, ...categoryGroupIds]);

        const addonRows = db
          .prepare('SELECT * FROM order_item_addons WHERE order_item_id = ? ORDER BY id ASC')
          .all(item.id) as Array<{
          id: number;
          addon_id: string | null;
          addon_name: string;
          quantity: number;
        }>;
        const groupSelections = new Map<string, { totalQty: number; hasMultiQty: boolean }>();

        for (const addonRow of addonRows) {
          if (!addonRow.addon_id) {
            throw new ReleaseHoldError(
              `Add-on "${addonRow.addon_name}" on "${product.name}" is missing a catalog reference.`,
            );
          }
          const catalogAddon = db
            .prepare(
              `SELECT addons.*, addon_groups.is_active AS addon_group_is_active
               FROM addons
               LEFT JOIN addon_groups ON addon_groups.id = addons.addon_group_id
               WHERE addons.id = ?`,
            )
            .get(addonRow.addon_id) as
            | {
                id: string;
                addon_group_id: string | null;
                name: string;
                is_active: number;
                addon_group_is_active: number | null;
                track_inventory: number | null;
                stock_quantity: number | null;
              }
            | undefined;

          if (!catalogAddon) {
            throw new ReleaseHoldError(
              `Add-on "${addonRow.addon_name}" on "${product.name}" was removed from the catalog.`,
            );
          }
          if (
            Number(catalogAddon.is_active) !== 1 ||
            (catalogAddon.addon_group_id !== null &&
              Number(catalogAddon.addon_group_is_active) !== 1)
          ) {
            throw new ReleaseHoldError(
              `Add-on "${catalogAddon.name}" on "${product.name}" is currently inactive.`,
            );
          }
          if (!catalogAddon.addon_group_id || !linkedGroupIds.has(catalogAddon.addon_group_id)) {
            throw new ReleaseHoldError(
              `Add-on "${catalogAddon.name}" is no longer linked to "${product.name}".`,
            );
          }

          const unitCount = Number(item.quantity);
          const addonQty = Number(addonRow.quantity || 1);
          const qtyInt = Math.max(1, Math.floor(addonQty));
          const currentSel = groupSelections.get(catalogAddon.addon_group_id) || {
            totalQty: 0,
            hasMultiQty: false,
          };
          groupSelections.set(catalogAddon.addon_group_id, {
            totalQty: currentSel.totalQty + qtyInt,
            hasMultiQty: currentSel.hasMultiQty || qtyInt > 1,
          });
          const requirement = Number((unitCount * addonQty).toFixed(8));

          if (Number(catalogAddon.track_inventory) === 1 && requirement > 0) {
            const available = Number(catalogAddon.stock_quantity ?? 0);
            if (requirement - available > 1e-8) {
              throw new ReleaseHoldError(
                `Insufficient stock for add-on "${catalogAddon.name}" (requested ${requirement}, available ${available}).`,
              );
            }
            adjustProductStock(db, {
              productId: null,
              addonId: catalogAddon.id,
              quantityDelta: -requirement,
              movementType: 'sale',
              referenceType: 'order_item',
              referenceId: String(item.id),
              actorUserId: effectiveActorId,
              createdAt: nowDb,
            });
            updateAddonDepletion.run(requirement, addonRow.id);
          } else {
            updateAddonDepletion.run(0, addonRow.id);
          }
        }

        for (const groupId of linkedGroupIds) {
          const group = db
            .prepare('SELECT * FROM addon_groups WHERE id = ? AND is_active = 1')
            .get(groupId) as
            | {
                id: string;
                name: string;
                is_required: number;
                min_selection: number | null;
                max_selection: number | null;
                allow_multiple_quantities: number | null;
              }
            | undefined;
          if (!group) continue;
          const selection = groupSelections.get(groupId) || { totalQty: 0, hasMultiQty: false };
          if (!group.allow_multiple_quantities && selection.hasMultiQty) {
            throw new ReleaseHoldError(
              `Add-on group "${group.name}" on "${product.name}" no longer allows multiple quantities.`,
            );
          }
          if (
            group.max_selection !== null &&
            group.max_selection !== undefined &&
            selection.totalQty > Number(group.max_selection)
          ) {
            throw new ReleaseHoldError(
              `Add-on group "${group.name}" on "${product.name}" exceeds maximum allowed (${group.max_selection}).`,
            );
          }
          const requiredMin = group.is_required
            ? Math.max(1, Number(group.min_selection || 1))
            : Number(group.min_selection || 0);
          if (requiredMin > 0 && selection.totalQty < requiredMin) {
            throw new ReleaseHoldError(
              `Required add-on group "${group.name}" on "${product.name}" needs at least ${requiredMin} selection(s).`,
            );
          }
        }

        const deduction = resolveInventoryDeduction(product, Number(item.quantity), variant);
        if (deduction) {
          if (!deduction.variantId && String(deduction.productId) !== String(product.id)) {
            const linkedProduct = db
              .prepare('SELECT id, name, deleted_at, is_active FROM products WHERE id = ?')
              .get(deduction.productId) as
              | { id: string; name: string; deleted_at: string | null; is_active: number }
              | undefined;
            if (!linkedProduct || linkedProduct.deleted_at) {
              throw new ReleaseHoldError(
                `Linked inventory product for "${product.name}" is unavailable.`,
              );
            }
          }
          adjustProductStock(db, {
            productId: deduction.productId,
            variantId: deduction.variantId ?? null,
            quantityDelta: -deduction.deductedQuantity,
            movementType: 'sale',
            referenceType: 'order_item',
            referenceId: String(item.id),
            actorUserId: effectiveActorId,
            createdAt: nowDb,
          });
        }

        const recipeSnapshot = buildRecipeSnapshot(
          db,
          product.id,
          Number(item.quantity),
          variant?.recipe_multiplier ?? 1,
        );
        if (recipeSnapshot) {
          for (const component of recipeSnapshot.components) {
            const supply = db
              .prepare('SELECT id, name, deleted_at FROM supplies WHERE id = ?')
              .get(component.supply_id) as
              | { id: string; name: string; deleted_at: string | null }
              | undefined;
            if (!supply || supply.deleted_at) {
              throw new ReleaseHoldError(
                `Recipe supply "${component.supply_name}" for "${product.name}" is unavailable.`,
              );
            }
          }
          applyRecipeSnapshot(db, recipeSnapshot, {
            direction: 'deplete',
            actorUserId: effectiveActorId,
            referenceId: String(item.id),
            createdAt: nowDb,
          });
        }

        const { ingredientCost, ingredientCostKnown } =
          extractOrderItemCostFromSnapshot(recipeSnapshot);

        updateItemDepletion.run(
          deduction ? deduction.deductedQuantity : 0,
          deduction ? deduction.productId : null,
          deduction?.variantId ?? null,
          recipeSnapshot ? JSON.stringify(recipeSnapshot) : null,
          ingredientCost,
          ingredientCostKnown,
          nowDb,
          item.id,
        );
      }
    });

    try {
      deductAndValidateInSavepoint();
    } catch (error) {
      if (!isCatalogOrStockHoldError(error)) {
        throw error;
      }
      const holdReason =
        error.message || 'Scheduled release blocked due to stock or catalog issue.';
      db.prepare(
        `UPDATE orders
         SET release_status = 'blocked',
             release_blocked_reason = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(holdReason, nowDb, currentOrder.id);

      if (effectiveActorId) {
        recordOrderAudit(db, {
          orderId: String(currentOrder.id),
          actorUserId: effectiveActorId,
          action: 'release_blocked',
          details: {
            trigger: options.trigger,
            initiated_by: options.actorUserId ? 'staff' : 'server_sweep',
            scheduled_for: currentOrder.scheduled_for,
            reason: holdReason,
          },
        });
      }

      const blockedOrder = db
        .prepare('SELECT * FROM orders WHERE id = ?')
        .get(currentOrder.id) as ScheduledOrderDbRow;
      return {
        outcome: 'blocked',
        reason: holdReason,
        order: blockedOrder,
      };
    }

    const kdsSetting = db.prepare("SELECT value FROM settings WHERE key = 'kds_enabled'").get() as
      | { value?: string }
      | undefined;
    const kdsEnabled = kdsSetting?.value !== 'false';
    const shouldCompleteAtRelease =
      isOrderSettledAndNonRefunded(db, currentOrder.id) &&
      (!kdsEnabled || !hasActiveUnservedOrderItems(db, currentOrder.id));

    if (shouldCompleteAtRelease) {
      db.prepare(
        `UPDATE orders
         SET release_status = 'released',
             released_at = ?,
             release_blocked_reason = NULL,
             status = 'completed',
             completed_at = COALESCE(completed_at, ?),
             updated_at = ?
         WHERE id = ?`,
      ).run(nowIso, nowDb, nowDb, currentOrder.id);
    } else {
      db.prepare(
        `UPDATE orders
         SET release_status = 'released',
             released_at = ?,
             release_blocked_reason = NULL,
             status = 'pending',
             updated_at = ?
         WHERE id = ?`,
      ).run(nowIso, nowDb, currentOrder.id);
    }

    if (effectiveActorId) {
      recordOrderAudit(db, {
        orderId: String(currentOrder.id),
        actorUserId: effectiveActorId,
        action: 'order_released',
        details: {
          trigger: options.trigger,
          initiated_by: options.actorUserId ? 'staff' : 'server_sweep',
          scheduled_for: currentOrder.scheduled_for,
          released_at: nowIso,
        },
      });
    }

    const releasedOrder = db
      .prepare('SELECT * FROM orders WHERE id = ?')
      .get(currentOrder.id) as ScheduledOrderDbRow;
    return {
      outcome: 'released',
      order: releasedOrder,
    };
  })();

  let kotAutoPrinted = false;
  if (txResult.outcome === 'released') {
    notifyKdsUpdate();
    cloudSync.recordOrderChanged(String(orderId), 'order.released');
    if (options.autoPrintKot !== false) {
      kotAutoPrinted = await autoPrintReleasedOrderKot(db, orderId);
    }
  } else if (txResult.outcome === 'blocked') {
    notifyOrderUpdated();
    cloudSync.recordOrderChanged(String(orderId), 'order.release_blocked');
  }

  return {
    ...txResult,
    kotAutoPrinted,
  };
}

/**
 * Releases all due scheduled orders (`release_status = 'scheduled'` and
 * `scheduled_for <= now`). Orders already in `release_status = 'blocked'` are
 * intentionally excluded and require an explicit staff retry.
 */
export async function sweepDueScheduledOrders(
  db: ReturnType<typeof getDatabase>,
  options?: {
    trigger?: Exclude<ReleaseTrigger, 'manual'>;
    nowDate?: Date;
    autoPrintKot?: boolean;
    checkPreconditions?: (ctx: ReleasePreconditionContext) => ReleasePreconditionDecision;
  },
): Promise<ScheduledSweepSummary> {
  const nowDate = options?.nowDate ?? new Date();
  const nowIso = nowDate.toISOString();
  const trigger = options?.trigger ?? 'sweep';

  const dueRows = db
    .prepare(
      `SELECT id, scheduled_for
       FROM orders
       WHERE release_status = 'scheduled'
         AND scheduled_for IS NOT NULL
         AND scheduled_for <= ?
         AND status NOT IN ('cancelled', 'completed')
       ORDER BY scheduled_for ASC, id ASC`,
    )
    .all(nowIso) as Array<{ id: number; scheduled_for: string }>;

  const summary: ScheduledSweepSummary = {
    checkedCount: dueRows.length,
    releasedIds: [],
    blockedIds: [],
    skippedIds: [],
  };

  for (const row of dueRows) {
    try {
      const result = await releaseScheduledOrder(db, row.id, {
        trigger,
        nowDate,
        autoPrintKot: options?.autoPrintKot,
        checkPreconditions: options?.checkPreconditions,
      });
      if (result.outcome === 'released') {
        summary.releasedIds.push(row.id);
      } else if (result.outcome === 'blocked') {
        summary.blockedIds.push(row.id);
      } else {
        summary.skippedIds.push(row.id);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('shutting down') ||
        message.includes('maintenance') ||
        message.includes('not initialized') ||
        isDatabaseMaintenanceActive()
      ) {
        throw err;
      }
      console.error(
        `[Scheduled Orders] Unexpected sweep release error for order ${row.id} (${trigger}):`,
        err,
      );
      try {
        const orderRow = db
          .prepare('SELECT id, release_status FROM orders WHERE id = ?')
          .get(row.id) as { id: number; release_status: string } | undefined;
        if (orderRow && orderRow.release_status === 'scheduled') {
          const reason =
            'Automatic release failed due to an unexpected error. Staff can retry release manually.';
          const nowDb = formatSqlUtcTimestamp(nowDate);
          db.prepare(
            `UPDATE orders
             SET release_status = 'blocked',
                 release_blocked_reason = ?,
                 updated_at = ?
             WHERE id = ? AND release_status = 'scheduled'`,
          ).run(reason, nowDb, row.id);
          notifyOrderUpdated();
          cloudSync.recordOrderChanged(String(row.id), 'order.release_blocked');
          summary.blockedIds.push(row.id);
        } else {
          summary.skippedIds.push(row.id);
        }
      } catch (innerErr) {
        console.error(
          `[Scheduled Orders] Failed to mark order ${row.id} as blocked after sweep failure:`,
          innerErr,
        );
        summary.skippedIds.push(row.id);
      }
    }
  }

  return summary;
}

let sweepIntervalHandle: ReturnType<typeof setInterval> | null = null;
let sweepInFlight: Promise<ScheduledSweepSummary> | null = null;

export async function triggerScheduledOrderSweep(
  trigger: Exclude<ReleaseTrigger, 'manual'> = 'sweep',
  nowDate?: Date,
): Promise<ScheduledSweepSummary> {
  if (isDatabaseMaintenanceActive()) {
    return { checkedCount: 0, releasedIds: [], blockedIds: [], skippedIds: [] };
  }
  if (sweepInFlight) {
    if (trigger !== 'resume') {
      return sweepInFlight;
    }
    await sweepInFlight;
  }

  const runPromise = withDatabaseRequest(async () => {
    const db = getDatabase();
    return sweepDueScheduledOrders(db, { trigger, nowDate });
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !message.includes('shutting down') &&
      !message.includes('maintenance') &&
      !message.includes('not initialized')
    ) {
      console.error(`[Scheduled Orders] ${trigger} sweep failed:`, error);
    }
    return { checkedCount: 0, releasedIds: [], blockedIds: [], skippedIds: [] };
  });

  const trackedPromise = runPromise.finally(() => {
    if (sweepInFlight === trackedPromise) {
      sweepInFlight = null;
    }
  });
  sweepInFlight = trackedPromise;

  return trackedPromise;
}

export function startScheduledOrderSweep(intervalMs: number = SCHEDULED_SWEEP_INTERVAL_MS): void {
  stopScheduledOrderSweep();
  void triggerScheduledOrderSweep('startup');
  sweepIntervalHandle = setInterval(() => {
    void triggerScheduledOrderSweep('sweep');
  }, intervalMs);
  sweepIntervalHandle.unref?.();
}

export function stopScheduledOrderSweep(): void {
  if (sweepIntervalHandle) {
    clearInterval(sweepIntervalHandle);
    sweepIntervalHandle = null;
  }
}

export interface ScheduledOrdersCursor {
  rank: number;
  scheduled_for: string;
  id: number;
}

export function encodeScheduledOrdersCursor(cursor: ScheduledOrdersCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeScheduledOrdersCursor(raw: string): ScheduledOrdersCursor | null {
  if (typeof raw !== 'string' || raw.length === 0 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as ScheduledOrdersCursor).rank === 'number' &&
      typeof (parsed as ScheduledOrdersCursor).scheduled_for === 'string' &&
      typeof (parsed as ScheduledOrdersCursor).id === 'number'
    ) {
      return parsed as ScheduledOrdersCursor;
    }
    return null;
  } catch {
    return null;
  }
}

import { createHash } from 'crypto';
import { Router, Request, Response } from 'express';
import {
  getDatabase,
  generateOrderNumber,
  now,
  parseItemJson,
  parseRowJson,
  withTxn,
  verifyPin,
  verifyPinAsync,
  getSettingValue,
  insertOrderItemAddons,
  attachEffectiveAddons,
  utcDayBounds,
  utcTodayDate,
  recordOrderAudit,
  isKdsEnabled,
  registerOrderSearchFunctions,
} from '../db';
import { asyncHandler } from '../middleware/async-handler';
import {
  calculateConfiguredChargeTaxes,
  calculateItemTax,
  combineItemAndChargeTaxes,
  getActiveCountryPack,
  getConfiguredChargeTaxCategories,
  invertTaxBreakdown,
  invertTaxSnapshot,
  normalizeChargeAmount,
  type Customer,
} from '../services/tax';
import { applyPayableRounding } from '../services/tax-engine';
import { calculateOrderTotals, recomputeOrderTotals } from '../services/orders';
import {
  buildAppliedCharges,
  ChargeValidationError,
  serializeAppliedCharges,
} from '../services/charges';
import {
  adjustProductStock,
  InventoryServiceError,
  resolveInventoryDeduction,
} from '../services/inventory';
import {
  resolveOrderItemVariant,
  variantUnitPrice,
  type ProductVariant,
} from '../services/product-variants';
import { applyRecipeSnapshot, buildRecipeSnapshot, parseRecipeSnapshot } from '../services/recipes';
import { notifyKdsUpdate, notifyOrderUpdated } from '../services/kds';
import { cloudSync } from '../services/cloud-sync';
import {
  validateOrderNotes,
  validateItemNotes,
  validateProductQuantity,
  validateDeliveryAddress,
  validateDeliveryNote,
  resolveExpectedPaymentMethod,
  resolveExpectedPaymentMethodIdentity,
} from './orders-validation';
import { hasPermission, requirePermission } from '../services/authorization';
import { ROLE_ACCESS, hasRole } from '../../shared/role-permissions';
import { isTerminalItemStatus } from '../../shared/order-item-status';
import { getCurrencyFractionDigits, getCurrencyMinorUnitFactor } from '../countries';
import { getTenantCurrency, syncUnpaidBillsForOrder } from './bills';
import expressRateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import { isAllowedPrivateIp } from '../middleware/security';
import { isOperationReference, serializeOperationFailure } from '../lib/operation-failure';

type PinApproverCandidate = { id: string; role: string; pin_hash: string };

const registeredSearchDatabases = new WeakSet<object>();

function ensureOrderSearchFunctions(dbInstance: any): void {
  if (registeredSearchDatabases.has(dbInstance)) return;
  registerOrderSearchFunctions(dbInstance);
  registeredSearchDatabases.add(dbInstance);
}

function isSearchIndexAvailable(dbInstance: any): boolean {
  try {
    const row = dbInstance
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orders_search_fts'")
      .get();
    return Boolean(row);
  } catch {
    return false;
  }
}

const router = Router();
const ORDER_WRITE_RATE_LIMIT_ERROR = {
  error: 'Too many requests, please try again later.',
};

export function resolveOrderWriteRateLimitMax(
  rawLimit = process.env.FLO_ORDER_WRITE_RATE_LIMIT_MAX,
): number {
  const configured = Number.parseInt(rawLimit || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 60;
}

export function shouldSkipOrderWriteRateLimit(req: Request): boolean {
  const userId = String((req as Request & { user?: { userId?: string } }).user?.userId || '');
  if (!userId) return false;
  return isAllowedPrivateIp(req.socket?.remoteAddress || '');
}

const orderReadRateLimit = expressRateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
const orderWriteRateLimit = expressRateLimit({
  windowMs: 60 * 1000,
  limit: () => resolveOrderWriteRateLimitMax(),
  standardHeaders: true,
  legacyHeaders: false,
  message: ORDER_WRITE_RATE_LIMIT_ERROR,
  skip: shouldSkipOrderWriteRateLimit,
});
// Kept as its own bucket rather than folded into orderWriteRateLimit: this limit
// had its own counter when the route lived in the registrar, and sharing a
// counter would let unrelated order writes exhaust the item-void budget.
const orderItemCancelRateLimit = expressRateLimit({
  windowMs: 60 * 1000,
  limit: () => resolveOrderWriteRateLimitMax(),
  standardHeaders: true,
  legacyHeaders: false,
  message: ORDER_WRITE_RATE_LIMIT_ERROR,
  skip: shouldSkipOrderWriteRateLimit,
});
const MAX_ORDER_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_ORDER_ITEMS = 200;

function structuredOperationFailure(
  req: Request,
  capturePoint: string,
  outcome: 'not_applied' | 'applied',
  error: string,
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
  if (!failure) return { error };
  (req as Request & { diagnosticsCaptured?: boolean }).diagnosticsCaptured = true;
  try {
    cloudSync.captureOperationFailure(failure);
  } catch {
    /* Diagnostics must not affect order handling. */
  }
  return {
    error,
    reason_code: failure.reason_code,
    operation: failure.operation,
    stage: failure.stage,
    classification: failure.classification,
    outcome: failure.outcome,
    correlation_id: failure.correlation_id,
    ...(failure.facts.display_code ? { display_code: failure.facts.display_code } : {}),
  };
}

/**
 * Resolves the unified engine's charges for an order, carrying forward the
 * waivers already recorded on it so a recompute never silently un-waives a fee.
 * Returns null when the merchant configured nothing that matches this order, so
 * the row keeps the charge amounts it already carried.
 */
/** The order columns the charge engine reads. */
interface EngineChargeOrderRow {
  type?: string | null;
  charges_breakdown?: string | null;
  service_charge?: number | null;
  packaging_charge?: number | null;
}

function resolveEngineCharges(
  order: EngineChargeOrderRow,
  subtotal: number,
  discountAmount: number,
) {
  const resolved = buildAppliedCharges({
    currency: getTenantCurrency(),
    orderType: String(order?.type || ''),
    subtotal,
    discountAmount,
    existingBreakdown: order?.charges_breakdown,
  });
  if (
    !resolved.configured &&
    !resolved.ownsServiceChargeColumn &&
    !resolved.ownsPackagingChargeColumn
  )
    return null;
  const chargeColumnOverrides: { service_charge?: number; packaging_charge?: number } = {};
  if (resolved.ownsServiceChargeColumn)
    chargeColumnOverrides.service_charge = resolved.columns.service_charge;
  if (resolved.ownsPackagingChargeColumn)
    chargeColumnOverrides.packaging_charge = resolved.columns.packaging_charge;
  return {
    appliedCharges: resolved.charges,
    ownsServiceChargeColumn: resolved.ownsServiceChargeColumn,
    ownsPackagingChargeColumn: resolved.ownsPackagingChargeColumn,
    chargeColumnOverrides,
    // Applicable definitions and retained snapshots own their standard column;
    // unmatched legacy amounts stay on the row.
    columns: {
      ...resolved.columns,
      service_charge: resolved.ownsServiceChargeColumn
        ? resolved.columns.service_charge
        : Number(order?.service_charge || 0),
      packaging_charge: resolved.ownsPackagingChargeColumn
        ? resolved.columns.packaging_charge
        : Number(order?.packaging_charge || 0),
    },
    chargesJson: serializeAppliedCharges(resolved.charges),
  };
}

function orderIdempotencyKey(req: Request): string | null {
  const raw = req.get('Idempotency-Key');
  if (raw === undefined) return null;
  const supplied = raw.trim();
  if (!supplied) return null;
  if (supplied.length > MAX_ORDER_IDEMPOTENCY_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(supplied)) {
    throw Object.assign(new Error('Idempotency-Key is invalid or too long'), { statusCode: 400 });
  }
  return supplied;
}

function getStoredOrderReplay(
  db: ReturnType<typeof getDatabase>,
  userId: string,
  idempotencyKey: string,
  requestHash: string,
): unknown | null {
  const prior = db
    .prepare(`
    SELECT request_hash, response_json
    FROM order_idempotency
    WHERE (user_id = ? OR user_id = 'legacy') AND idempotency_key = ?
    ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `)
    .get(userId, idempotencyKey, userId) as
    | { request_hash: string; response_json: string }
    | undefined;
  if (!prior) return null;
  if (prior.request_hash !== requestHash) {
    throw Object.assign(
      new Error('Idempotency-Key was already used for a different order request'),
      { statusCode: 409 },
    );
  }
  try {
    return JSON.parse(prior.response_json);
  } catch {
    throw Object.assign(new Error('Stored order response is invalid'), { statusCode: 500 });
  }
}

// Rate limiting for PIN validation (simple in-memory)
const pinAttempts = new Map<string, { count: number; resetAt: number }>();
const PIN_MAX_ATTEMPTS = 5;
const PIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export function checkPinRateLimit(key: string): boolean {
  const now = Date.now();
  // Sweep expired rate limit entries when map grows beyond threshold.
  if (pinAttempts.size > 500) {
    for (const [k, v] of pinAttempts.entries()) {
      if (now > v.resetAt) pinAttempts.delete(k);
    }
  }
  const entry = pinAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    pinAttempts.set(key, { count: 1, resetAt: now + PIN_WINDOW_MS });
    return true;
  }
  if (entry.count >= PIN_MAX_ATTEMPTS) return false;
  entry.count++;
  return true;
}

export function isPinRateLimited(key: string): boolean {
  const entry = pinAttempts.get(key);
  if (!entry || Date.now() > entry.resetAt) {
    pinAttempts.delete(key);
    return false;
  }
  return entry.count >= PIN_MAX_ATTEMPTS;
}

export function clearPinRateLimit(key: string): void {
  pinAttempts.delete(key);
}

export function resetPinRateLimitForTests(): void {
  pinAttempts.clear();
}

function syncCustomerTagCounts(
  db: any,
  customerId: string,
  items: { product_id: string; quantity: number }[],
) {
  const row = db.prepare('SELECT tag_counts FROM customers WHERE id = ?').get(customerId) as any;
  if (!row) return;
  let counts: Record<string, number> = {};
  try {
    counts = row.tag_counts ? JSON.parse(row.tag_counts) : {};
  } catch {
    counts = {};
  }
  for (const item of items) {
    const product = db
      .prepare('SELECT tags FROM products WHERE id = ?')
      .get(item.product_id) as any;
    if (!product?.tags) continue;
    let tags: string[] = [];
    try {
      tags = JSON.parse(product.tags);
    } catch {
      continue;
    }
    for (const tag of tags) {
      if (tag && typeof tag === 'string') counts[tag] = (counts[tag] || 0) + (item.quantity || 1);
    }
  }
  db.prepare('UPDATE customers SET tag_counts = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(counts),
    now(),
    customerId,
  );
}

function variantSelectionSnapshot(variant: ProductVariant): string {
  return JSON.stringify({
    id: variant.id,
    name: variant.name,
    price: Number(variant.price),
    sku: variant.sku,
  });
}

/**
 * The stock pool an order item consumed, read from the pool recorded on the line
 * at sale time. Re-resolving the current variant settings could refund a pool
 * the sale never debited after a track_inventory or recipe-link edit.
 */
function orderItemInventoryTarget(
  db: ReturnType<typeof getDatabase>,
  item: {
    product_id: string;
    variant_id?: string | null;
    quantity?: number;
    inventory_product_id?: string | null;
    inventory_variant_id?: string | null;
  },
): { productId: string; variantId: string | null } | null {
  const recordedProductId = item.inventory_product_id || item.product_id;
  const recordedVariantId = item.inventory_variant_id ? String(item.inventory_variant_id) : null;
  const recorded = db.prepare('SELECT id FROM products WHERE id = ?').get(recordedProductId) as
    | { id: string }
    | undefined;
  return recorded ? { productId: recorded.id, variantId: recordedVariantId } : null;
}

/** One add-on pool an order line consumed, carrying the snapshot quantity taken. */
interface AddonStockLine {
  id: string | null;
  name: string;
  inventory_deducted_quantity: number;
}

/** Move the add-on pools an order line consumed, using the snapshot recorded on the line. */
function moveOrderItemAddonStock(
  db: ReturnType<typeof getDatabase>,
  addons: AddonStockLine[],
  options: {
    direction: 'deplete' | 'restore';
    actorUserId: string;
    referenceId: string;
    reason?: string;
    createdAt?: string;
  },
): void {
  const sign = options.direction === 'deplete' ? -1 : 1;
  const movementType = options.direction === 'deplete' ? 'sale' : 'cancel_restore';
  for (const addon of addons) {
    const quantity = Number(addon.inventory_deducted_quantity) || 0;
    if (quantity <= 0 || !addon.id) continue;
    try {
      adjustProductStock(db, {
        productId: null,
        addonId: addon.id,
        quantityDelta: sign * quantity,
        movementType,
        referenceType: 'order_item',
        referenceId: options.referenceId,
        reason: options.reason ?? null,
        actorUserId: options.actorUserId,
        createdAt: options.createdAt,
      });
    } catch (err) {
      // Two lines can each clear the per-line check and jointly exhaust the
      // pool; the ledger guard stops the second, so name the add-on as the
      // pre-check does rather than returning a bare "Insufficient stock".
      if (!(err instanceof InventoryServiceError) || err.statusCode !== 400) throw err;
      const pool = db.prepare('SELECT stock_quantity FROM addons WHERE id = ?').get(addon.id) as
        | { stock_quantity: number }
        | undefined;
      throw Object.assign(
        new Error(
          `Add-on "${addon.name}" is out of stock (requested ${quantity}, available ${Number(pool?.stock_quantity ?? 0)})`,
        ),
        { statusCode: 400 },
      );
    }
  }
}

/** The add-on snapshot rows an order line drew out of its pools, read at sale time. */
function orderItemAddonStockLines(
  db: ReturnType<typeof getDatabase>,
  orderItemId: number | bigint,
): AddonStockLine[] {
  return db
    .prepare(`
    SELECT addon_id AS id, addon_name AS name, inventory_deducted_quantity
    FROM order_item_addons
    WHERE order_item_id = ? AND inventory_deducted_quantity > 0
  `)
    .all(orderItemId) as AddonStockLine[];
}

/** Resolves and validates item add-ons against catalog to enforce authoritative pricing. */
function resolveItemAddons(
  db: ReturnType<typeof getDatabase>,
  productId: string,
  addons: any[] | null | undefined,
  itemQuantity: unknown,
): {
  id: string;
  name: string;
  price: number;
  quantity: number;
  inventory_deducted_quantity: number;
}[] {
  const addonInputs = Array.isArray(addons) ? addons : [];

  const product = db.prepare('SELECT category_id FROM products WHERE id = ?').get(productId) as
    | { category_id: string | null }
    | undefined;
  const productGroupIds = (
    db
      .prepare('SELECT addon_group_id FROM addon_group_product WHERE product_id = ?')
      .all(productId) as { addon_group_id: string }[]
  ).map((row) => row.addon_group_id);
  const categoryGroupIds = product?.category_id
    ? (
        db
          .prepare('SELECT addon_group_id FROM category_addon_groups WHERE category_id = ?')
          .all(product.category_id) as { addon_group_id: string }[]
      ).map((row) => row.addon_group_id)
    : [];
  const linkedGroupIds = new Set([...productGroupIds, ...categoryGroupIds]);

  const resolved: {
    id: string;
    name: string;
    price: number;
    quantity: number;
    inventory_deducted_quantity: number;
  }[] = [];
  const groupSelections = new Map<string, { totalQty: number; hasMultiQty: boolean }>();

  for (const addon of addonInputs) {
    if (!addon) continue;
    if (!addon.id || typeof addon.id !== 'string') {
      throw new Error('Each add-on must reference a valid catalog add-on ID');
    }
    const catalog = db
      .prepare(`
      SELECT addons.*, addon_groups.is_active AS addon_group_is_active
      FROM addons LEFT JOIN addon_groups ON addon_groups.id = addons.addon_group_id
      WHERE addons.id = ?
    `)
      .get(addon.id) as
      | {
          id: string;
          addon_group_id: string | null;
          name: string;
          price: number;
          is_active: number;
          addon_group_is_active: number | null;
          track_inventory: number | null;
          stock_quantity: number | null;
        }
      | undefined;
    if (!catalog) {
      throw new Error(`Add-on "${addon.id}" was not found`);
    }
    if (
      catalog.is_active !== 1 ||
      (catalog.addon_group_id !== null && catalog.addon_group_is_active !== 1)
    ) {
      throw new Error(`Add-on "${catalog.name}" is not available`);
    }
    const addonGroupId = catalog.addon_group_id;
    if (!addonGroupId || !linkedGroupIds.has(addonGroupId)) {
      throw new Error(`Add-on "${catalog.name}" is not available for this product`);
    }

    const quantity = addon.quantity ?? 1;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`Invalid add-on quantity for "${catalog.name}": must be a positive integer`);
    }

    // One tracked add-on on a line consumes a whole item's worth: three burgers
    // with two extra bacon each take six, not two. An item quantity that is not
    // yet a positive number is refused by validateProductQuantity before the
    // order is written, so there is no requirement to check here.
    const unitCount = Number(itemQuantity);
    const requirement = Number.isFinite(unitCount) && unitCount > 0 ? unitCount * quantity : 0;
    let inventoryDeductedQuantity = 0;
    if (Number(catalog.track_inventory) === 1) {
      const available = Number(catalog.stock_quantity ?? 0);
      // Refusing is the point: a tracked add-on with nothing left must not be
      // silently substituted, so there is no variant-style fallback here.
      if (requirement - available > 1e-8) {
        throw new Error(
          `Add-on "${catalog.name}" is out of stock (requested ${requirement}, available ${available})`,
        );
      }
      inventoryDeductedQuantity = requirement;
    }

    resolved.push({
      id: catalog.id,
      name: catalog.name,
      price: Number(catalog.price) || 0,
      quantity,
      inventory_deducted_quantity: inventoryDeductedQuantity,
    });

    const qty = Math.max(1, Math.floor(quantity));
    const current = groupSelections.get(addonGroupId) || { totalQty: 0, hasMultiQty: false };
    groupSelections.set(addonGroupId, {
      totalQty: current.totalQty + qty,
      hasMultiQty: current.hasMultiQty || qty > 1,
    });
  }

  // Validate every group linked to the product, not just ones with a selection —
  // otherwise a required group (e.g. Size) can be silently skipped by omitting `addons`.
  for (const groupId of linkedGroupIds) {
    const group = db
      .prepare('SELECT * FROM addon_groups WHERE id = ? AND is_active = 1')
      .get(groupId) as any;
    if (!group) continue;
    const selection = groupSelections.get(groupId) || { totalQty: 0, hasMultiQty: false };

    if (!group.allow_multiple_quantities && selection.hasMultiQty) {
      throw new Error(`Add-on group "${group.name}" does not allow multiple quantities`);
    }

    if (
      group.max_selection !== null &&
      group.max_selection !== undefined &&
      selection.totalQty > group.max_selection
    ) {
      throw new Error(
        `Total add-on quantity for group "${group.name}" exceeds maximum allowed (${group.max_selection})`,
      );
    }

    const requiredMin = group.is_required
      ? Math.max(1, group.min_selection || 1)
      : group.min_selection || 0;
    if (requiredMin > 0 && selection.totalQty < requiredMin) {
      throw new Error(
        `Selection for group "${group.name}" requires at least ${requiredMin} item(s)`,
      );
    }
  }

  return resolved;
}

router.get(
  '/',
  orderReadRateLimit,
  requirePermission('orders.read'),
  (req: Request, res: Response) => {
    try {
      const db = getDatabase();
      const wheres: string[] = [];
      const params: any[] = [];
      const view = typeof req.query.view === 'string' ? req.query.view : 'all';
      if (!['all', 'active', 'unpaid'].includes(view)) {
        return res.status(400).json({ error: 'Invalid view parameter.' });
      }
      const activeOrderPredicate = `(
        (orders.status NOT IN ('cancelled', 'completed'))
        OR (
          orders.status = 'completed'
          AND ? = 1
          AND EXISTS (
            SELECT 1 FROM order_items AS active_item
            WHERE active_item.order_id = orders.id
              AND active_item.status IN ('pending', 'preparing', 'ready')
          )
        )
      )`;
      if (view === 'active') {
        wheres.push(activeOrderPredicate);
        params.push(isKdsEnabled() ? 1 : 0);
      } else if (view === 'unpaid') {
        wheres.push("orders.status != 'cancelled'");
        wheres.push(`(
          NOT EXISTS (SELECT 1 FROM bills AS existing_bill WHERE existing_bill.order_id = orders.id)
          OR EXISTS (
            SELECT 1 FROM bills AS payable_bill
            WHERE payable_bill.order_id = orders.id
              AND COALESCE(payable_bill.payment_status, 'unpaid') IN ('unpaid', 'partial')
              AND payable_bill.balance > 0
          )
        )`);
      }

      if (typeof req.query.status === 'string' && req.query.status) {
        const statuses = req.query.status.split(',');
        if (statuses.length === 1 && statuses[0] === 'active') {
          wheres.push(activeOrderPredicate);
          params.push(isKdsEnabled() ? 1 : 0);
        } else if (statuses.length === 1) {
          wheres.push('orders.status = ?');
          params.push(statuses[0]);
        } else {
          wheres.push(`orders.status IN (${statuses.map(() => '?').join(',')})`);
          params.push(...statuses);
        }
      }
      if (req.query.type) {
        wheres.push('orders.type = ?');
        params.push(req.query.type);
      }
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      if (search) {
        ensureOrderSearchFunctions(db);
        const phoneDigits = search.replace(/\D/g, '');
        const isPhoneSearch = Boolean(phoneDigits && !/\p{L}/u.test(search));
        const customerSearch = ['orders_search_contains(search_customer.name, ?)'];
        if (isPhoneSearch) {
          customerSearch.push('orders_search_digits_contains(search_customer.phone_digits, ?)');
          customerSearch.push('orders_search_digits_contains(search_customer.phone, ?)');
        }
        const udfClause = `(
        orders_search_contains(orders.order_number, ?)
        OR EXISTS (
          SELECT 1 FROM customers AS search_customer
          WHERE search_customer.id = orders.customer_id
            AND (${customerSearch.join(' OR ')})
        )
      )`;

        const isEligible = [...search].length >= 3 && (!isPhoneSearch || phoneDigits.length >= 3);
        const hasFts = isEligible && isSearchIndexAvailable(db);

        if (hasFts) {
          let candidateClause: string;
          const candidateParams: any[] = [];

          if (isPhoneSearch) {
            // For phone searches, customer phone strings may contain varied formatting
            // (e.g. "+1/555 ext 0199"). Querying customers table with digit UDF efficiently
            // identifies matching customer IDs across the small customers table, avoiding a
            // full orders scan while preserving full parity across phone formats.
            const ftsSearch = '"' + phoneDigits.replace(/"/g, '""') + '"';
            candidateClause = `(
              orders.id IN (SELECT rowid FROM orders_search_fts WHERE orders_search_fts MATCH ?)
              OR orders.customer_id IN (
                SELECT id FROM customers
                WHERE (phone_digits IS NOT NULL AND orders_search_digits_contains(phone_digits, ?))
                   OR (phone IS NOT NULL AND orders_search_digits_contains(phone, ?))
                   OR orders_search_contains(name, ?)
              )
            )`;
            candidateParams.push(ftsSearch, phoneDigits, phoneDigits, search);
          } else {
            const ftsSearch = '"' + search.replace(/"/g, '""') + '"';
            candidateClause = `(
              orders.id IN (SELECT rowid FROM orders_search_fts WHERE orders_search_fts MATCH ?)
              OR orders.customer_id IN (
                SELECT id FROM customers WHERE rowid IN (
                  SELECT rowid FROM customers_search_fts WHERE customers_search_fts MATCH ?
                )
              )
            )`;
            candidateParams.push(ftsSearch, ftsSearch);
          }

          wheres.push(`(${candidateClause} AND ${udfClause})`);
          params.push(...candidateParams, search, search);
          if (isPhoneSearch) params.push(phoneDigits, phoneDigits);
        } else {
          wheres.push(udfClause);
          params.push(search, search);
          if (isPhoneSearch) params.push(phoneDigits, phoneDigits);
        }
      }
      // Filter by UTC day or date range across indexed created_at column.
      if (req.query.today && req.query.today !== '0' && req.query.today !== 'false') {
        const [s, e] = utcDayBounds(utcTodayDate());
        wheres.push('created_at >= ? AND created_at < ?');
        params.push(s, e);
      } else {
        const startDate =
          typeof req.query.start_date === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test(req.query.start_date)
            ? req.query.start_date
            : null;
        const endDate =
          typeof req.query.end_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.end_date)
            ? req.query.end_date
            : null;
        if (startDate) {
          wheres.push('created_at >= ?');
          params.push(utcDayBounds(startDate)[0]);
        }
        if (endDate) {
          wheres.push('created_at < ?');
          params.push(utcDayBounds(endDate)[1]);
        }
      }
      if (req.query.table_id) {
        wheres.push('orders.table_id = ?');
        params.push(req.query.table_id);
      }
      // Cursor pagination: `before` / `after` are ORDER BY keys (created_at),
      // composed with `id` to break ties when many orders share a second.
      if (typeof req.query.before_id === 'string' && /^\d+$/.test(req.query.before_id)) {
        const oid = parseInt(req.query.before_id, 10);
        if (Number.isSafeInteger(oid) && oid > 0) {
          const ref = db.prepare('SELECT created_at FROM orders WHERE id = ?').get(oid) as
            | { created_at: string }
            | undefined;
          if (ref) {
            wheres.push('(orders.created_at, orders.id) < (?, ?)');
            params.push(ref.created_at, oid);
          }
        }
      }

      const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
      // Limit per-page items with default 50 and maximum 500.
      const requestedPerPage = req.query.per_page
        ? parseInt(req.query.per_page as string, 10)
        : NaN;
      const perPage =
        Number.isInteger(requestedPerPage) && requestedPerPage > 0
          ? Math.min(requestedPerPage, 500)
          : 50;
      const perPagePlusOne = perPage + 1;

      const orders = db
        .prepare(`
      SELECT orders.* FROM orders
      ${whereSql}
      ORDER BY orders.created_at DESC, orders.id DESC
      LIMIT ?
    `)
        .all(...params, perPagePlusOne) as any[];

      const hasMore = orders.length > perPage;
      const pageOrders = hasMore ? orders.slice(0, perPage) : orders;
      const nextCursor = hasMore ? pageOrders[pageOrders.length - 1].id : null;

      // Batch hydrate relations for page orders.
      const ordersWithRelations = batchHydrateOrders(db, pageOrders);

      res.json({
        orders: ordersWithRelations,
        ...(nextCursor !== null && { nextCursor }),
      });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

/** Batches order relations and WhatsApp receipt status into IN queries. */
type WhatsAppReceiptStatus = 'sent' | 'partial' | 'pending' | 'failed' | null;

function summarizeWhatsAppReceiptStatuses(statuses: (string | null)[]): WhatsAppReceiptStatus {
  const positiveStatuses = statuses.filter(
    (status) => status === 'sent' || status === 'delivered' || status === 'read',
  );
  if (positiveStatuses.length === statuses.length && statuses.length > 0) return 'sent';
  if (positiveStatuses.length > 0) return 'partial';
  if (statuses.some((status) => status === 'queued' || status === 'typing')) return 'pending';
  if (statuses.some((status) => status === 'failed')) return 'failed';
  return null;
}

type TaxProductRow = Parameters<typeof calculateItemTax>[1];
type TaxCustomerRow = Parameters<typeof calculateItemTax>[3];
type ProductRow = TaxProductRow & {
  id: string;
  name: string;
  sku: string | null;
  price: string | number;
};

interface OrderItemInput {
  product_id: string;
  quantity: number;
  unit_price?: number;
  discount_amount?: number;
  variant_id?: string | null;
  variant_selection?: unknown;
  modifier_selection?: unknown;
  special_instructions?: string | null;
  recipe_snapshot?: unknown;
  inventory_deducted_quantity?: number;
  inventory_target_product_id?: string | null;
  inventory_target_variant_id?: string | null;
  addons?:
    | {
        id?: string;
        name?: string;
        price?: number;
        quantity?: number;
        inventory_deducted_quantity?: number;
      }[]
    | null;
}

function insertOrderItems(
  db: ReturnType<typeof getDatabase>,
  orderId: string | number,
  items: OrderItemInput[],
  context: {
    tenantInfo: Parameters<typeof calculateItemTax>[0];
    customer: TaxCustomerRow;
    isOnlineOrder: boolean;
    actorUserId: string;
    initialStatus?: string;
    preserveUnitPrice?: boolean;
    /** Quantity reductions keep the stored variant/add-on selections verbatim. */
    preserveSelections?: boolean;
  },
): (number | bigint)[] {
  const { tenantInfo, customer, isOnlineOrder, actorUserId } = context;
  const initialStatus = context.initialStatus ?? 'pending';
  const insertItem = db.prepare(`
  INSERT INTO order_items (order_id, product_id, variant_id, product_name, product_sku, unit_price, quantity, inventory_deducted_quantity, inventory_product_id, inventory_variant_id,
    subtotal, tax_amount, tax_breakdown, tax_snapshot, tax_type, discount_amount, total, variant_selection,
    modifier_selection, special_instructions, recipe_snapshot, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

  const insertedItemIds: (number | bigint)[] = [];
  for (const item of items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id) as
      | ProductRow
      | undefined;
    if (!product) {
      throw Object.assign(new Error(`Product ${item.product_id} not found`), {
        statusCode: 404,
      });
    }
    const quantity = item.quantity;
    // Item discounts are applied via dedicated discount routes, not creation;
    // quantity edits on existing items preserve their scaled discount.
    const itemDiscount =
      context.preserveUnitPrice &&
      typeof item.discount_amount === 'number' &&
      Number.isFinite(item.discount_amount) &&
      item.discount_amount > 0
        ? item.discount_amount
        : 0;

    // Validate quantity and price
    validateProductQuantity(product, quantity);
    const variant = resolveOrderItemVariant(db, product, item, isOnlineOrder, {
      // A quantity reduction keeps the stored selection even if the merchant
      // has since disabled the variant or added variants the line never had;
      // the line was valid when it was sold. Increases and replacements
      // re-validate against the current catalog.
      allowInactive: !!context.preserveSelections,
      allowUnselected: !!context.preserveSelections,
    });
    const unitPrice = context.preserveUnitPrice
      ? Number(item.unit_price)
      : variant
        ? variantUnitPrice(variant, isOnlineOrder)
        : parseFloat(String(product.price));
    const deduction =
      context.preserveSelections && typeof item.inventory_deducted_quantity === 'number'
        ? item.inventory_deducted_quantity > 0
          ? {
              productId: item.inventory_target_product_id ?? product.id,
              variantId:
                item.inventory_target_variant_id !== undefined
                  ? item.inventory_target_variant_id
                  : (variant?.id ?? null),
              deductedQuantity: item.inventory_deducted_quantity,
            }
          : null
        : resolveInventoryDeduction(product, quantity, variant);
    if (unitPrice < 0 || !Number.isFinite(unitPrice)) {
      throw Object.assign(
        new Error(`Invalid price for ${product.name}: must be a non-negative number`),
        { statusCode: 400 },
      );
    }

    let itemSubtotal = unitPrice * quantity;
    if (item.addons && Array.isArray(item.addons)) {
      for (const addon of item.addons) {
        if (!addon) continue;
        if (addon.quantity !== undefined) {
          if (
            typeof addon.quantity !== 'number' ||
            !Number.isInteger(addon.quantity) ||
            addon.quantity <= 0
          ) {
            throw Object.assign(
              new Error(
                `Invalid add-on quantity for ${addon.name || 'addon'}: must be a positive integer`,
              ),
              { statusCode: 400 },
            );
          }
        }
        const addonQty = addon.quantity || 1;
        itemSubtotal += (addon.price || 0) * addonQty * quantity;
      }
    }
    itemSubtotal = Math.max(0, itemSubtotal - itemDiscount);

    const taxResult = calculateItemTax(tenantInfo, product, itemSubtotal, customer);
    const itemTotal =
      itemSubtotal + (taxResult.tax_type === 'inclusive' ? 0 : taxResult.tax_amount);
    const itemTaxSnapshotJson = taxResult.tax_snapshot
      ? JSON.stringify(taxResult.tax_snapshot)
      : null;

    const itemCreatedAt = now();
    const recipeSnapshot =
      context.preserveSelections && item.recipe_snapshot !== undefined
        ? (item.recipe_snapshot as ReturnType<typeof buildRecipeSnapshot>)
        : buildRecipeSnapshot(db, product.id, quantity, variant?.recipe_multiplier ?? 1);
    const insertItemResult = insertItem.run(
      orderId,
      product.id,
      variant ? variant.id : null,
      product.name,
      product.sku,
      unitPrice,
      quantity,
      deduction ? deduction.deductedQuantity : 0,
      deduction ? deduction.productId : null,
      deduction?.variantId ?? null,
      itemSubtotal,
      taxResult.tax_amount,
      JSON.stringify(taxResult.tax_breakdown),
      itemTaxSnapshotJson,
      taxResult.tax_type,
      itemDiscount,
      itemTotal,
      context.preserveSelections && item.variant_selection !== undefined
        ? JSON.stringify(item.variant_selection ?? null)
        : variant
          ? variantSelectionSnapshot(variant)
          : JSON.stringify(item.variant_selection || null),
      JSON.stringify(item.modifier_selection || null),
      item.special_instructions || null,
      recipeSnapshot ? JSON.stringify(recipeSnapshot) : null,
      initialStatus,
      itemCreatedAt,
      itemCreatedAt,
    );
    insertOrderItemAddons(db, insertItemResult.lastInsertRowid, item.addons, itemCreatedAt);
    insertedItemIds.push(insertItemResult.lastInsertRowid);

    if (deduction) {
      adjustProductStock(db, {
        productId: deduction.productId,
        variantId: deduction.variantId ?? null,
        quantityDelta: -deduction.deductedQuantity,
        movementType: 'sale',
        referenceType: 'order_item',
        referenceId: String(insertItemResult.lastInsertRowid),
        actorUserId: actorUserId,
        createdAt: itemCreatedAt,
      });
    }
    moveOrderItemAddonStock(db, (item.addons ?? []) as AddonStockLine[], {
      direction: 'deplete',
      actorUserId: actorUserId,
      referenceId: String(insertItemResult.lastInsertRowid),
      createdAt: itemCreatedAt,
    });

    if (recipeSnapshot) {
      applyRecipeSnapshot(db, recipeSnapshot, {
        direction: 'deplete',
        actorUserId: actorUserId,
        referenceId: String(insertItemResult.lastInsertRowid),
        createdAt: itemCreatedAt,
      });
    }
  }
  return insertedItemIds;
}

interface EditableOrderRow extends EngineChargeOrderRow {
  status: string;
  customer_id: string | null;
  online_platform: string | null;
  subtotal: number;
  discount_amount: number | null;
  discount_type: string | null;
  discount_value: number | null;
  delivery_charge: number | null;
}

interface OrderItemRow {
  id: number;
  status: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
  unit_price: number;
  discount_amount?: number | null;
  special_instructions: string | null;
  inventory_deducted_quantity: number;
  inventory_product_id: string | null;
  inventory_variant_id: string | null;
  recipe_snapshot: string | null;
  updated_at: string;
}

function cancelOrderItemAndRestoreStock(
  db: ReturnType<typeof getDatabase>,
  currentItem: OrderItemRow,
  actorId: string,
  reason: string | undefined,
): void {
  // Cancel the item and restore the inventory quantity recorded when it was added.
  db.prepare("UPDATE order_items SET status = 'cancelled', updated_at = ? WHERE id = ?").run(
    now(),
    currentItem.id,
  );

  const inventoryTarget =
    currentItem.inventory_deducted_quantity > 0 ? orderItemInventoryTarget(db, currentItem) : null;
  if (inventoryTarget) {
    adjustProductStock(db, {
      productId: inventoryTarget.productId,
      variantId: inventoryTarget.variantId,
      quantityDelta: currentItem.inventory_deducted_quantity,
      movementType: 'cancel_restore',
      referenceType: 'order_item',
      referenceId: `${currentItem.id}:${currentItem.updated_at}`,
      reason: reason || 'Item cancelled',
      actorUserId: actorId,
    });
  }
  moveOrderItemAddonStock(db, orderItemAddonStockLines(db, currentItem.id), {
    direction: 'restore',
    actorUserId: actorId,
    referenceId: `${currentItem.id}:${currentItem.updated_at}`,
    reason: reason || 'Item cancelled',
  });
  const recipeSnapshot = parseRecipeSnapshot(currentItem.recipe_snapshot);
  if (recipeSnapshot) {
    applyRecipeSnapshot(db, recipeSnapshot, {
      direction: 'restore',
      actorUserId: actorId,
      referenceId: `${currentItem.id}:${currentItem.updated_at}`,
    });
  }
}

function batchHydrateOrders(db: ReturnType<typeof getDatabase>, orders: any[]) {
  if (orders.length === 0) return [];
  // Normalize JSON text columns on orders and items.
  const parsedOrders = orders.map(parseRowJson);
  const ids = parsedOrders.map((o) => o.id);
  const tableIds = Array.from(new Set(parsedOrders.map((o: any) => o.table_id).filter(Boolean)));
  const customerIds = Array.from(
    new Set(parsedOrders.map((o: any) => o.customer_id).filter(Boolean)),
  );

  const orderIdsCsv = `(${ids.map(() => '?').join(',')})`;
  const itemsRows = db
    .prepare(`SELECT * FROM order_items WHERE order_id IN ${orderIdsCsv} ORDER BY order_id, id`)
    .all(...ids)
    .map(parseItemJson);
  // Attach resolved addons and audit metadata, then regroup by order_id.
  const itemsWithAddons = attachEffectiveAddons(db, itemsRows as any[]);
  const itemsByOrder = new Map<number, any[]>();
  for (const it of itemsWithAddons) {
    const list = itemsByOrder.get(it.order_id) || [];
    list.push(it);
    itemsByOrder.set(it.order_id, list);
  }

  const tablesById = new Map<string, any>();
  if (tableIds.length > 0) {
    const ph = tableIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM tables WHERE id IN (${ph})`).all(...tableIds) as any[];
    for (const t of rows) tablesById.set(t.id, t);
  }
  const customersById = new Map<string, any>();
  if (customerIds.length > 0) {
    const ph = customerIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM customers WHERE id IN (${ph})`).all(...customerIds);
    for (const c of rows as any[]) customersById.set(c.id, parseRowJson(c));
  }
  const billsByOrderId = new Map<number, any[]>();
  const billsById = new Map<number, any>();
  const billRows = db
    .prepare(`SELECT * FROM bills WHERE order_id IN ${orderIdsCsv}`)
    .all(...ids) as any[];
  for (const b of billRows) {
    const parsed = parseRowJson(b);
    const siblings = billsByOrderId.get(parsed.order_id) || [];
    siblings.push(parsed);
    billsByOrderId.set(parsed.order_id, siblings);
    billsById.set(parsed.id, parsed);
  }
  const loyaltyByBillId = new Map<number, { earned: number; redeemed: number }>();
  if (billsById.size > 0) {
    const billIds = Array.from(billsById.keys());
    const ph = billIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT bill_id, type, COALESCE(SUM(amount),0) as total FROM loyalty_ledger WHERE bill_id IN (${ph}) AND type IN ('credit', 'debit') GROUP BY bill_id, type`,
      )
      .all(...billIds) as { bill_id: number; type: 'credit' | 'debit'; total: number }[];
    for (const r of rows) {
      const current = loyaltyByBillId.get(r.bill_id) || { earned: 0, redeemed: 0 };
      if (r.type === 'credit') current.earned = Number(r.total) || 0;
      if (r.type === 'debit') current.redeemed = Number(r.total) || 0;
      loyaltyByBillId.set(r.bill_id, current);
    }
  }
  const whatsappReceiptStatusByBillId = new Map<number, string>();
  const paidBillIdsByOrderId = new Map<number, number[]>();
  const receiptBillIds = Array.from(billsByOrderId.entries()).flatMap(([orderId, bills]) => {
    const paidBillIds = bills
      .filter((bill) => bill.payment_status === 'paid')
      .map((bill) => bill.id);
    paidBillIdsByOrderId.set(orderId, paidBillIds);
    return paidBillIds;
  });
  if (receiptBillIds.length > 0) {
    const ph = receiptBillIds.map(() => '?').join(',');
    const rows = db
      .prepare(`
      SELECT bill_id, status
      FROM whatsapp_messages
      WHERE direction = 'outbound'
        AND kind = 'bill_receipt'
        AND bill_id IN (${ph})
      ORDER BY id DESC
    `)
      .all(...receiptBillIds) as { bill_id: number; status: string }[];
    for (const row of rows) {
      if (!whatsappReceiptStatusByBillId.has(row.bill_id)) {
        whatsappReceiptStatusByBillId.set(row.bill_id, row.status);
      }
    }
  }
  const whatsappReceiptStatusByOrderId = new Map<number, WhatsAppReceiptStatus>();
  for (const [orderId, billIds] of paidBillIdsByOrderId) {
    whatsappReceiptStatusByOrderId.set(
      orderId,
      summarizeWhatsAppReceiptStatuses(
        billIds.map((billId) => whatsappReceiptStatusByBillId.get(billId) ?? null),
      ),
    );
  }
  const loyaltyEnabled = ['true', '1'].includes(getSettingValue('loyalty_enabled') || '');
  const loyaltyByCustomerId = new Map<string, { credits: number; debits: number }>();
  const billCustomerIds = Array.from(
    new Set(
      Array.from(billsById.values())
        .map((bill) => bill.customer_id)
        .filter(Boolean),
    ),
  );
  if (loyaltyEnabled && billCustomerIds.length > 0) {
    const ph = billCustomerIds.map(() => '?').join(',');
    const rows = db
      .prepare(`
      SELECT customer_id, type, COALESCE(SUM(amount), 0) as total
      FROM loyalty_ledger
      WHERE customer_id IN (${ph})
        AND type IN ('credit', 'debit')
      GROUP BY customer_id, type
    `)
      .all(...billCustomerIds) as {
      customer_id: string | number;
      type: 'credit' | 'debit';
      total: number;
    }[];
    for (const r of rows) {
      const key = String(r.customer_id);
      const current = loyaltyByCustomerId.get(key) || { credits: 0, debits: 0 };
      if (r.type === 'credit') current.credits = Number(r.total) || 0;
      if (r.type === 'debit') current.debits = Number(r.total) || 0;
      loyaltyByCustomerId.set(key, current);
    }
  }

  return parsedOrders.map((order) => {
    const itemList = itemsByOrder.get(order.id) || [];
    const tableRow = order.table_id ? tablesById.get(order.table_id) : null;
    const table = tableRow ? { ...tableRow, name: tableRow.number } : null;
    const customer = order.customer_id ? customersById.get(order.customer_id) : null;
    const bills = billsByOrderId.get(order.id) || [];
    for (const billRow of bills) {
      if (billRow.customer_id) {
        const billLoyalty = loyaltyByBillId.get(billRow.id) || { earned: 0, redeemed: 0 };
        const customerLoyalty = loyaltyByCustomerId.get(String(billRow.customer_id));
        billRow.points_earned = billLoyalty.earned;
        billRow.points_redeemed = billLoyalty.redeemed;
        billRow.points_balance =
          loyaltyEnabled && customerLoyalty
            ? Math.max(0, customerLoyalty.credits - customerLoyalty.debits)
            : null;
      }
    }
    const bill = bills.find((row) => row.payment_status !== 'paid') || bills[0] || null;
    return {
      ...order,
      items: itemList,
      table,
      customer,
      bill,
      bills,
      whatsapp_receipt_status: whatsappReceiptStatusByOrderId.get(order.id) ?? null,
    };
  });
}

router.get(
  '/:id',
  orderReadRateLimit,
  requirePermission('orders.read'),
  (req: Request, res: Response) => {
    try {
      const db = getDatabase();
      const order = parseRowJson(
        db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id),
      );
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      // Hydrate relations using batchHydrateOrders.
      const [hydrated] = batchHydrateOrders(db, [order]);
      res.json({ order: hydrated });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post(
  '/',
  orderWriteRateLimit,
  requirePermission('orders.create'),
  (req: Request, res: Response) => {
    let operationCommitted = false;
    try {
      const body = req.body || {};
      const {
        table_id,
        customer_id,
        type,
        guest_count,
        special_instructions,
        packaging_charge,
        delivery_charge,
        service_charge,
        items,
        online_platform,
        external_order_id,
        delivery_address,
        expected_payment_method,
        expected_payment_method_id,
        delivery_note,
        waived_charge_ids,
        opted_in_charge_ids,
      } = body;
      // Carries optional service charge without automatic calculation policy.
      const idempotencyKey = orderIdempotencyKey(req);
      const idempotencyUserId = String((req as any).user.userId);
      const requestHash = idempotencyKey
        ? createHash('sha256').update(JSON.stringify(body)).digest('hex')
        : null;
      // Always use authenticated user ID to ensure correct server visibility and attribution.
      const authenticatedUserId = (req as any).user.userId;

      if (!Array.isArray(items) || items.length === 0) {
        return res
          .status(400)
          .json(
            structuredOperationFailure(
              req,
              'fc.backend.order.create.other_validation',
              'not_applied',
              'At least one item is required',
            ),
          );
      }
      if (items.length > MAX_ORDER_ITEMS) {
        return res
          .status(400)
          .json(
            structuredOperationFailure(
              req,
              'fc.backend.order.create.other_validation',
              'not_applied',
              `A maximum of ${MAX_ORDER_ITEMS} items is allowed per request`,
            ),
          );
      }

      if (!type || !['dine_in', 'takeaway', 'delivery', 'online'].includes(type)) {
        return res
          .status(400)
          .json(
            structuredOperationFailure(
              req,
              'fc.backend.order.create.other_validation',
              'not_applied',
              'Valid type is required (dine_in, takeaway, delivery, online)',
            ),
          );
      }
      if (
        guest_count !== undefined &&
        guest_count !== null &&
        (!Number.isSafeInteger(guest_count) || guest_count < 1 || guest_count > 99)
      ) {
        return res
          .status(400)
          .json(
            structuredOperationFailure(
              req,
              'fc.backend.order.create.other_validation',
              'not_applied',
              'guest_count must be a whole number between 1 and 99',
            ),
          );
      }

      let pkgCharge: number;
      let delCharge: number;
      let serviceCharge: number;
      try {
        pkgCharge = normalizeChargeAmount(packaging_charge, 'packaging');
        delCharge = normalizeChargeAmount(delivery_charge, 'delivery');
        serviceCharge = normalizeChargeAmount(service_charge, 'service_charge');
      } catch (error: unknown) {
        const statusCode =
          typeof error === 'object' &&
          error !== null &&
          'statusCode' in error &&
          typeof error.statusCode === 'number'
            ? error.statusCode
            : 400;
        const message = error instanceof Error ? error.message : 'Invalid charge amount';
        return res
          .status(statusCode)
          .json(
            structuredOperationFailure(
              req,
              'fc.backend.order.create.other_validation',
              'not_applied',
              message,
            ),
          );
      }

      // Cashier charge decisions taken in the cart travel with the order, so the
      // engine applies them instead of resetting to the merchant defaults.
      if (
        [waived_charge_ids, opted_in_charge_ids].some(
          (list) =>
            list !== undefined &&
            list !== null &&
            (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')),
        )
      ) {
        return res
          .status(400)
          .json(
            structuredOperationFailure(
              req,
              'fc.backend.order.create.other_validation',
              'not_applied',
              'waived_charge_ids and opted_in_charge_ids must be arrays of charge ids',
            ),
          );
      }
      const waivedChargeIds = (waived_charge_ids || []) as string[];
      const optedInChargeIds = (opted_in_charge_ids || []) as string[];

      if (
        online_platform !== undefined &&
        online_platform !== null &&
        typeof online_platform !== 'string'
      ) {
        return res
          .status(400)
          .json(
            structuredOperationFailure(
              req,
              'fc.backend.order.create.other_validation',
              'not_applied',
              'online_platform must be a string',
            ),
          );
      }
      if (
        external_order_id !== undefined &&
        external_order_id !== null &&
        typeof external_order_id !== 'string'
      ) {
        return res
          .status(400)
          .json(
            structuredOperationFailure(
              req,
              'fc.backend.order.create.other_validation',
              'not_applied',
              'external_order_id must be a string',
            ),
          );
      }
      if (
        delivery_address !== undefined &&
        delivery_address !== null &&
        typeof delivery_address !== 'string'
      ) {
        return res
          .status(400)
          .json(
            structuredOperationFailure(
              req,
              'fc.backend.order.create.other_validation',
              'not_applied',
              'delivery_address must be a string',
            ),
          );
      }
      const deliveryAddress =
        typeof delivery_address === 'string' ? delivery_address.trim() || null : null;
      if (
        delivery_note !== undefined &&
        delivery_note !== null &&
        typeof delivery_note !== 'string'
      ) {
        return res
          .status(400)
          .json(
            structuredOperationFailure(
              req,
              'fc.backend.order.create.other_validation',
              'not_applied',
              'delivery_note must be a string',
            ),
          );
      }
      // Courier-only details: other order types never store them.
      const isDelivery = type === 'delivery';
      const deliveryNote =
        isDelivery && typeof delivery_note === 'string' ? delivery_note.trim() || null : null;
      const onlinePlatform =
        typeof online_platform === 'string' ? online_platform.trim().slice(0, 100) : null;
      const externalOrderId =
        typeof external_order_id === 'string' ? external_order_id.trim().slice(0, 100) : null;
      const isOnlineOrder = Boolean(onlinePlatform);

      const db = getDatabase();

      if (idempotencyKey && requestHash) {
        const replayed = getStoredOrderReplay(
          db,
          idempotencyUserId,
          idempotencyKey,
          requestHash,
        ) as { order: any } | null;
        if (replayed) {
          return res.status(200).json({ order: replayed.order });
        }
      }

      // Free text that ends up printed on a courier slip, so it is capped and
      // validated the same way order notes are, at this boundary.
      let expectedPaymentMethod: string | null;
      let expectedPaymentMethodId: number | null = null;
      try {
        validateDeliveryAddress(db, deliveryAddress);
        validateDeliveryNote(db, deliveryNote);
        if (isDelivery) {
          // An explicit configured-method identity wins over the string contract:
          // a method literally named "Pending" or "Unknown" would otherwise be
          // read back as the sentinel. Its canonical name is stored with the ID.
          const identity = resolveExpectedPaymentMethodIdentity(
            db,
            expected_payment_method_id,
            expected_payment_method,
          );
          if (identity) {
            expectedPaymentMethod = identity.name;
            expectedPaymentMethodId = identity.id;
          } else {
            expectedPaymentMethod = resolveExpectedPaymentMethod(db, expected_payment_method);
          }
        } else {
          // Non-delivery orders ignore delivery collection metadata, like before.
          expectedPaymentMethod = null;
        }
      } catch (err: unknown) {
        return res
          .status(400)
          .json(
            structuredOperationFailure(
              req,
              'fc.backend.order.create.other_validation',
              'not_applied',
              err instanceof Error ? err.message : 'Invalid delivery details',
            ),
          );
      }

      try {
        validateOrderNotes(db, special_instructions);
        for (const item of items) {
          validateItemNotes(db, item.special_instructions);
          item.addons = resolveItemAddons(db, item.product_id, item.addons, item.quantity);
        }
      } catch (err: any) {
        const msg = err?.message || 'Item validation failed';
        const isRequiredGroup =
          typeof msg === 'string' &&
          (msg.includes('requires at least') ||
            msg.includes('exceeds maximum allowed') ||
            msg.includes('does not allow multiple'));
        const isAddonUnavailable =
          typeof msg === 'string' &&
          (msg.includes('is not available') ||
            msg.includes('was not found') ||
            msg.includes('is out of stock'));
        const point = isRequiredGroup
          ? 'fc.backend.order.create.addon_group_validation'
          : isAddonUnavailable
            ? 'fc.backend.order.create.addon_item_validation'
            : 'fc.backend.order.create.other_validation';
        return res.status(400).json(structuredOperationFailure(req, point, 'not_applied', msg));
      }
      const result = withTxn(() => {
        if (idempotencyKey) {
          const prior = db
            .prepare(`
          SELECT request_hash, response_json
          FROM order_idempotency
          WHERE (user_id = ? OR user_id = 'legacy') AND idempotency_key = ?
          ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END
          LIMIT 1
        `)
            .get(idempotencyUserId, idempotencyKey, idempotencyUserId) as
            | { request_hash: string; response_json: string }
            | undefined;
          if (prior) {
            if (prior.request_hash !== requestHash) {
              throw Object.assign(
                new Error('Idempotency-Key was already used for a different order request'),
                { statusCode: 409 },
              );
            }
            try {
              const response = JSON.parse(prior.response_json);
              return {
                order: response.order,
                orderItems: response.order?.items || [],
                idempotentReplay: true,
              };
            } catch {
              throw Object.assign(new Error('Stored order response is invalid'), {
                statusCode: 500,
              });
            }
          }
        }
        // Generate order number inside transaction to prevent race conditions
        const orderNumber = generateOrderNumber();

        // Get settings for tax calculation
        const settings: Record<string, string> = {};
        db.prepare('SELECT key, value FROM settings')
          .all()
          .forEach((row: any) => {
            settings[row.key] = row.value;
          });

        const tenantInfo = {
          country: settings.country || '',
          business_type: settings.business_type || 'restaurant',
          state_code: settings.state_code || '',
          currency: getTenantCurrency(),
          taxes_enabled: settings.taxes_enabled === 'true',
        };
        const chargeCategories = getConfiguredChargeTaxCategories(tenantInfo.country);
        const chargeContext = {
          packaging_charge: pkgCharge,
          delivery_charge: delCharge,
          service_charge: serviceCharge,
          packaging_tax_category_id: chargeCategories.packaging?.categoryId || null,
          delivery_tax_category_id: chargeCategories.delivery?.categoryId || null,
          service_charge_tax_category_id: chargeCategories.service_charge?.categoryId || null,
        };

        const reservedCustomerId =
          type === 'dine_in' && table_id
            ? (
                db
                  .prepare(
                    "SELECT reservation_customer_id FROM tables WHERE id = ? AND status = 'reserved'",
                  )
                  .get(table_id) as { reservation_customer_id: string | null } | undefined
              )?.reservation_customer_id || null
            : null;
        const orderCustomerId = customer_id || reservedCustomerId || null;

        const orderResult = db
          .prepare(`
        INSERT INTO orders (order_number, table_id, customer_id, user_id, type, delivery_address, expected_payment_method, expected_payment_method_id, delivery_note, guest_count, special_instructions,
          packaging_charge, delivery_charge, packaging_tax_category_id, delivery_tax_category_id,
          service_charge, service_charge_tax_category_id, online_platform, external_order_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `)
          .run(
            orderNumber,
            table_id || null,
            orderCustomerId,
            authenticatedUserId,
            type,
            deliveryAddress,
            expectedPaymentMethod,
            expectedPaymentMethodId,
            deliveryNote,
            guest_count || null,
            special_instructions || null,
            pkgCharge,
            delCharge,
            chargeContext.packaging_tax_category_id,
            chargeContext.delivery_tax_category_id,
            serviceCharge,
            chargeContext.service_charge_tax_category_id,
            onlinePlatform || null,
            externalOrderId || null,
            now(),
            now(),
          );

        const orderId = orderResult.lastInsertRowid;

        let subtotal = 0;
        let totalTax = 0;
        let exclusiveTax = 0;
        const allTaxBreakdowns: any[] = [];
        const allTaxSnapshots: (string | null)[] = [];
        const customer = orderCustomerId
          ? (db.prepare('SELECT * FROM customers WHERE id = ?').get(orderCustomerId) as any)
          : null;

        const insertItem = db.prepare(`
        INSERT INTO order_items (order_id, product_id, variant_id, product_name, product_sku, unit_price, quantity, inventory_deducted_quantity, inventory_product_id, inventory_variant_id,
          subtotal, tax_amount, tax_breakdown, tax_snapshot, tax_type, discount_amount, total, variant_selection,
          modifier_selection, special_instructions, recipe_snapshot, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `);

        for (const item of items) {
          const product = db
            .prepare('SELECT * FROM products WHERE id = ?')
            .get(item.product_id) as any;
          if (!product) {
            throw Object.assign(new Error(`Product ${item.product_id} not found`), {
              statusCode: 404,
            });
          }

          const quantity = item.quantity;
          // Item discounts are applied via dedicated discount routes, not creation.
          const itemDiscount = 0;

          // Validate quantity and price
          validateProductQuantity(product, quantity);
          const variant = resolveOrderItemVariant(db, product, item, isOnlineOrder);
          const unitPrice = variant
            ? variantUnitPrice(variant, isOnlineOrder)
            : parseFloat(product.price);
          const deduction = resolveInventoryDeduction(product, quantity, variant);
          if (unitPrice < 0 || !Number.isFinite(unitPrice)) {
            throw Object.assign(
              new Error(`Invalid price for ${product.name}: must be a non-negative number`),
              { statusCode: 400 },
            );
          }

          let itemSubtotal = unitPrice * quantity;
          if (item.addons && Array.isArray(item.addons)) {
            for (const addon of item.addons) {
              if (!addon) continue;
              if (addon.quantity !== undefined) {
                if (
                  typeof addon.quantity !== 'number' ||
                  !Number.isInteger(addon.quantity) ||
                  addon.quantity <= 0
                ) {
                  throw Object.assign(
                    new Error(
                      `Invalid add-on quantity for ${addon.name || 'addon'}: must be a positive integer`,
                    ),
                    { statusCode: 400 },
                  );
                }
              }
              const addonQty = addon.quantity || 1;
              itemSubtotal += (addon.price || 0) * addonQty * quantity;
            }
          }
          itemSubtotal = Math.max(0, itemSubtotal - itemDiscount);

          const taxResult = calculateItemTax(tenantInfo, product, itemSubtotal, customer);

          totalTax += taxResult.tax_amount;
          if (taxResult.tax_type !== 'inclusive') {
            exclusiveTax += taxResult.tax_amount;
          }
          if (taxResult.tax_breakdown) {
            allTaxBreakdowns.push(taxResult.tax_breakdown);
          }
          const itemTaxSnapshotJson = taxResult.tax_snapshot
            ? JSON.stringify(taxResult.tax_snapshot)
            : null;
          allTaxSnapshots.push(itemTaxSnapshotJson);

          const itemTotal =
            itemSubtotal + (taxResult.tax_type === 'inclusive' ? 0 : taxResult.tax_amount);
          subtotal += itemSubtotal;

          const itemCreatedAt = now();
          const recipeSnapshot = buildRecipeSnapshot(
            db,
            product.id,
            quantity,
            variant?.recipe_multiplier ?? 1,
          );
          const insertItemResult = insertItem.run(
            orderId,
            product.id,
            variant ? variant.id : null,
            product.name,
            product.sku,
            unitPrice,
            quantity,
            deduction ? deduction.deductedQuantity : 0,
            deduction ? deduction.productId : null,
            deduction?.variantId ?? null,
            itemSubtotal,
            taxResult.tax_amount,
            JSON.stringify(taxResult.tax_breakdown),
            itemTaxSnapshotJson,
            taxResult.tax_type,
            itemDiscount,
            itemTotal,
            variant
              ? variantSelectionSnapshot(variant)
              : JSON.stringify(item.variant_selection || null),
            JSON.stringify(item.modifier_selection || null),
            item.special_instructions || null,
            recipeSnapshot ? JSON.stringify(recipeSnapshot) : null,
            itemCreatedAt,
            itemCreatedAt,
          );
          insertOrderItemAddons(db, insertItemResult.lastInsertRowid, item.addons, itemCreatedAt);

          if (deduction) {
            adjustProductStock(db, {
              productId: deduction.productId,
              variantId: deduction.variantId ?? null,
              quantityDelta: -deduction.deductedQuantity,
              movementType: 'sale',
              referenceType: 'order_item',
              referenceId: String(insertItemResult.lastInsertRowid),
              actorUserId: authenticatedUserId,
              createdAt: itemCreatedAt,
            });
          }
          moveOrderItemAddonStock(db, item.addons, {
            direction: 'deplete',
            actorUserId: authenticatedUserId,
            referenceId: String(insertItemResult.lastInsertRowid),
            createdAt: itemCreatedAt,
          });

          if (recipeSnapshot) {
            applyRecipeSnapshot(db, recipeSnapshot, {
              direction: 'deplete',
              actorUserId: authenticatedUserId,
              referenceId: String(insertItemResult.lastInsertRowid),
              createdAt: itemCreatedAt,
            });
          }
        }

        const currency = getTenantCurrency();
        const decimals = getCurrencyFractionDigits(currency);
        const minorFactor = getCurrencyMinorUnitFactor(currency);

        // Unified charges & fees engine. Charges the merchant configured for this
        // order type are applied here and the standard ids are projected onto the
        // dedicated columns. Manually entered amounts survive when no configured
        // or retained charge owns the corresponding standard column.
        const resolvedCharges = buildAppliedCharges({
          currency,
          orderType: type,
          subtotal,
          discountAmount: 0,
          waivedIds: waivedChargeIds,
          optedInIds: optedInChargeIds,
        });
        const engineColumns = resolvedCharges.configured ? resolvedCharges.columns : null;
        const appliedServiceCharge = resolvedCharges.ownsServiceChargeColumn
          ? resolvedCharges.columns.service_charge
          : serviceCharge;
        const appliedPackagingCharge = resolvedCharges.ownsPackagingChargeColumn
          ? resolvedCharges.columns.packaging_charge
          : pkgCharge;
        const otherCharges = engineColumns ? engineColumns.other_charges : 0;
        const appliedChargeContext: typeof chargeContext = {
          ...chargeContext,
          service_charge: appliedServiceCharge,
          packaging_charge: appliedPackagingCharge,
        };

        const chargeTaxes = calculateConfiguredChargeTaxes(
          tenantInfo,
          appliedChargeContext,
          customer,
        );
        const taxRollup = combineItemAndChargeTaxes({
          itemTaxAmount: totalTax,
          itemExclusiveTaxAmount: exclusiveTax,
          itemBreakdowns: allTaxBreakdowns,
          itemSnapshots: allTaxSnapshots,
          itemTaxRatio: 1,
          chargeTaxes,
          minorFactor,
        });
        const preRoundTotal =
          subtotal +
          taxRollup.exclusiveTaxAmount +
          delCharge +
          appliedPackagingCharge +
          appliedServiceCharge +
          otherCharges;
        const total = Number(preRoundTotal.toFixed(decimals));
        if (!Number.isSafeInteger(Math.round(total * minorFactor))) {
          throw new ChargeValidationError('Order total exceeds the supported currency precision');
        }
        const roundOff = 0;

        db.prepare(`
        UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, total = ?,
          service_charge = ?, packaging_charge = ?, charges_breakdown = ?, round_off = ?, updated_at = ? WHERE id = ?
      `).run(
          subtotal,
          taxRollup.taxAmount,
          JSON.stringify(taxRollup.breakdowns),
          taxRollup.snapshotJson,
          total,
          appliedServiceCharge,
          appliedPackagingCharge,
          engineColumns ? serializeAppliedCharges(resolvedCharges.charges) : null,
          roundOff,
          now(),
          orderId,
        );

        if (table_id && type === 'dine_in') {
          db.prepare("UPDATE tables SET status = 'occupied', updated_at = ? WHERE id = ?").run(
            now(),
            table_id,
          );
        }

        const order = parseRowJson(
          db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId),
        ) as any;
        const orderItems = attachEffectiveAddons(
          db,
          db
            .prepare('SELECT * FROM order_items WHERE order_id = ?')
            .all(orderId)
            .map(parseItemJson) as any[],
        );
        const response = { order: Object.assign({}, order, { items: orderItems }) };
        if (idempotencyKey && requestHash) {
          db.prepare(
            'INSERT INTO order_idempotency (user_id, idempotency_key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
          ).run(idempotencyUserId, idempotencyKey, requestHash, JSON.stringify(response), now());
        }
        return { order, orderItems, idempotentReplay: false };
      });
      operationCommitted = true;

      if (!result.idempotentReplay) {
        notifyKdsUpdate();
        cloudSync.recordOrderChanged(result.order.id, 'order.created');

        if (result.order.customer_id) {
          try {
            syncCustomerTagCounts(db, result.order.customer_id, items);
          } catch (err) {
            console.error('[Orders] Tag sync failed:', err);
          }
        }
      }

      res
        .status(result.idempotentReplay ? 200 : 201)
        .json({ order: Object.assign({}, result.order, { items: result.orderItems }) });
    } catch (error: any) {
      console.error('[Orders] Create error:', error);
      console.error('[API] Internal error:', error);
      const statusCode = error.statusCode || 500;
      const point = operationCommitted
        ? 'fc.backend.order.create.completion'
        : error?.diagnosticCode === 'quantity_invalid'
          ? 'fc.backend.order.create.quantity_validation'
          : error instanceof InventoryServiceError && error.statusCode === 400
            ? 'fc.backend.order.create.stock_validation'
            : statusCode >= 500
              ? 'fc.backend.order.create.persistence'
              : 'fc.backend.order.create.other_validation';
      return res
        .status(statusCode)
        .json(
          structuredOperationFailure(
            req,
            point,
            operationCommitted ? 'applied' : 'not_applied',
            error.statusCode ? error.message : 'Internal server error',
          ),
        );
    }
  },
);

router.post(
  '/:id/items',
  orderWriteRateLimit,
  requirePermission('orders.create'),
  (req: Request, res: Response) => {
    let operationCommitted = false;
    try {
      const db = getDatabase();
      const body = req.body || {};
      const { items, special_instructions } = body;
      const idempotencyKey = orderIdempotencyKey(req);
      const idempotencyUserId = String((req as any).user.userId);
      const requestHash = idempotencyKey
        ? createHash('sha256')
            .update(JSON.stringify({ order_id: req.params.id, items, special_instructions }))
            .digest('hex')
        : null;

      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as any;
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      // Return stored idempotent replay if already processed.
      if (idempotencyKey && requestHash) {
        const replayResponse = getStoredOrderReplay(
          db,
          idempotencyUserId,
          idempotencyKey,
          requestHash,
        );
        if (replayResponse) return res.json(replayResponse);
      }

      if (!Array.isArray(items) || items.length === 0) {
        return res
          .status(400)
          .json(
            structuredOperationFailure(
              req,
              'fc.backend.order.append.validation',
              'not_applied',
              'At least one item is required',
            ),
          );
      }
      if (items.length > MAX_ORDER_ITEMS) {
        return res
          .status(400)
          .json(
            structuredOperationFailure(
              req,
              'fc.backend.order.append.validation',
              'not_applied',
              `A maximum of ${MAX_ORDER_ITEMS} items is allowed per request`,
            ),
          );
      }

      // Get settings
      const settings: Record<string, string> = {};
      db.prepare('SELECT key, value FROM settings')
        .all()
        .forEach((row: any) => {
          settings[row.key] = row.value;
        });

      const tenantInfo = {
        country: settings.country || '',
        business_type: settings.business_type || 'restaurant',
        state_code: settings.state_code || '',
        currency: getTenantCurrency(),
        taxes_enabled: settings.taxes_enabled === 'true',
      };

      const result = withTxn(() => {
        // Re-fetch and re-validate order state inside transaction to prevent concurrency races.
        const currentOrder = db
          .prepare('SELECT * FROM orders WHERE id = ?')
          .get(req.params.id) as any;
        if (!currentOrder) {
          throw Object.assign(new Error('Order not found'), { statusCode: 404 });
        }

        // Re-check idempotency under transaction lock.
        if (idempotencyKey && requestHash) {
          const replayResponse = getStoredOrderReplay(
            db,
            idempotencyUserId,
            idempotencyKey,
            requestHash,
          );
          if (replayResponse) return { replayResponse };
        }

        if (
          db
            .prepare(
              'SELECT 1 FROM bills WHERE order_id = ? AND split_group_id IS NOT NULL LIMIT 1',
            )
            .get(req.params.id)
        ) {
          throw Object.assign(new Error('Items cannot be changed after a check has been split'), {
            statusCode: 409,
          });
        }
        if (['completed', 'cancelled'].includes(currentOrder.status)) {
          throw Object.assign(new Error('Cannot add items to a completed or cancelled order'), {
            statusCode: 400,
          });
        }
        const refundedBill = db
          .prepare(
            `SELECT 1 FROM bills WHERE order_id = ? AND payment_status IN ('refunded', 'partially_refunded') LIMIT 1`,
          )
          .get(req.params.id);
        if (refundedBill) {
          throw Object.assign(new Error('Cannot add items to a refunded order'), {
            statusCode: 409,
          });
        }

        try {
          for (const item of items) {
            validateItemNotes(db, item.special_instructions);
            item.addons = resolveItemAddons(db, item.product_id, item.addons, item.quantity);
          }
          if (special_instructions !== undefined) {
            validateOrderNotes(db, special_instructions);
          }
        } catch (err: unknown) {
          throw Object.assign(
            new Error(err instanceof Error ? err.message : 'Invalid order item'),
            { statusCode: 400 },
          );
        }

        const customer = currentOrder.customer_id
          ? (db
              .prepare('SELECT * FROM customers WHERE id = ?')
              .get(currentOrder.customer_id) as any)
          : null;
        const isOnlineOrder = !!currentOrder.online_platform;

        const insertedItemIds = insertOrderItems(db, req.params.id as string, items, {
          tenantInfo,
          customer,
          isOnlineOrder,
          actorUserId: idempotencyUserId,
        });

        // BUG #3 FIX: Filter out terminal items from total recalculation.
        const totals = calculateOrderTotals(db, req.params.id as string);
        const { subtotal } = totals;

        // BUG #12 FIX: Preserve order-level discount (scale percentage proportionally)
        const currency = getTenantCurrency();
        const decimals = getCurrencyFractionDigits(currency);
        const existingDiscountAmount = currentOrder.discount_amount || 0;
        let newDiscountAmount = existingDiscountAmount;
        if (existingDiscountAmount > 0 && currentOrder.subtotal > 0) {
          if (currentOrder.discount_type === 'percentage') {
            const pct = currentOrder.discount_value || 0;
            newDiscountAmount = Number(((subtotal * pct) / 100).toFixed(decimals));
          }
          // amount type: keep same value
        }

        const engineCharges = resolveEngineCharges(currentOrder, subtotal, newDiscountAmount);
        const { taxRollup, total, roundOff } = recomputeOrderTotals({
          tenantInfo,
          chargeContext: currentOrder,
          customer,
          totals,
          discountAmount: newDiscountAmount,
          taxScaling: 'when-discounted',
          appliedCharges: engineCharges ? engineCharges.appliedCharges : null,
          chargeColumnOverrides: engineCharges?.chargeColumnOverrides,
        });

        const syncedServiceCharge = engineCharges
          ? engineCharges.columns.service_charge
          : currentOrder.service_charge || 0;
        const syncedPackagingCharge = engineCharges
          ? engineCharges.columns.packaging_charge
          : currentOrder.packaging_charge || 0;
        const syncedChargesJson = engineCharges
          ? engineCharges.chargesJson
          : (currentOrder.charges_breakdown ?? null);

        // Update order totals and optionally update order-level notes
        if (special_instructions !== undefined) {
          db.prepare(`
          UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?, service_charge = ?, packaging_charge = ?, charges_breakdown = ?, round_off = ?, special_instructions = ?, updated_at = ? WHERE id = ?
        `).run(
            subtotal,
            taxRollup.taxAmount,
            JSON.stringify(taxRollup.breakdowns),
            taxRollup.snapshotJson,
            newDiscountAmount,
            total,
            syncedServiceCharge,
            syncedPackagingCharge,
            syncedChargesJson,
            roundOff,
            special_instructions || null,
            now(),
            req.params.id,
          );
        } else {
          db.prepare(`
          UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?, service_charge = ?, packaging_charge = ?, charges_breakdown = ?, round_off = ?, updated_at = ? WHERE id = ?
        `).run(
            subtotal,
            taxRollup.taxAmount,
            JSON.stringify(taxRollup.breakdowns),
            taxRollup.snapshotJson,
            newDiscountAmount,
            total,
            syncedServiceCharge,
            syncedPackagingCharge,
            syncedChargesJson,
            roundOff,
            now(),
            req.params.id,
          );
        }

        // BUG #4 FIX: Sync bill if it exists (add-items didn't update the bill)
        const existingBill = db
          .prepare("SELECT * FROM bills WHERE order_id = ? AND payment_status != 'paid'")
          .get(req.params.id) as any;
        if (existingBill) {
          const pack = getActiveCountryPack(tenantInfo.country);
          const { total: billTotal, adjustment: billRoundOff } = applyPayableRounding(
            total,
            pack,
            currency,
          );
          const newBillBalance = Math.max(0, billTotal - (existingBill.paid_amount || 0));
          db.prepare(
            `UPDATE bills SET subtotal = ?, total = ?, balance = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, service_charge = ?, packaging_charge = ?, charges_breakdown = ?, round_off = ?, updated_at = ? WHERE id = ?`,
          ).run(
            subtotal,
            billTotal,
            newBillBalance,
            taxRollup.taxAmount,
            JSON.stringify(taxRollup.breakdowns),
            taxRollup.snapshotJson,
            newDiscountAmount,
            syncedServiceCharge,
            syncedPackagingCharge,
            syncedChargesJson,
            billRoundOff,
            now(),
            existingBill.id,
          );
        }

        recordOrderAudit(db, {
          orderId: req.params.id as string,
          actorUserId: idempotencyUserId,
          action: 'items_added',
          details: { item_ids: insertedItemIds },
        });

        const updatedOrder = parseRowJson(
          db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id),
        ) as any;
        const updatedItems = attachEffectiveAddons(
          db,
          db
            .prepare('SELECT * FROM order_items WHERE order_id = ?')
            .all(req.params.id)
            .map(parseItemJson) as any[],
        );
        const response = { order: Object.assign({}, updatedOrder, { items: updatedItems }) };
        if (idempotencyKey && requestHash) {
          db.prepare(
            'INSERT INTO order_idempotency (user_id, idempotency_key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
          ).run(idempotencyUserId, idempotencyKey, requestHash, JSON.stringify(response), now());
        }
        return { updatedOrder, updatedItems, replayResponse: null };
      });
      operationCommitted = true;

      if (result.replayResponse) return res.json(result.replayResponse);
      cloudSync.recordOrderChanged(req.params.id as string, 'order.updated');
      notifyKdsUpdate();

      res.json({ order: Object.assign({}, result.updatedOrder, { items: result.updatedItems }) });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      const statusCode = error.statusCode || 500;
      const message = error.statusCode ? error.message : 'Internal server error';
      if (statusCode === 404 && !operationCommitted)
        return res.status(statusCode).json({ error: message });
      const point = operationCommitted
        ? 'fc.backend.order.append.completion'
        : statusCode >= 500
          ? 'fc.backend.order.append.persistence'
          : 'fc.backend.order.append.validation';
      return res
        .status(statusCode)
        .json(
          structuredOperationFailure(
            req,
            point,
            operationCommitted ? 'applied' : 'not_applied',
            message,
          ),
        );
    }
  },
);

interface OrderStatusBillEvaluationRow {
  id?: number | string;
  total?: number | string | null;
  round_off?: number | string | null;
  paid_amount?: number | string | null;
  refunded_cents?: number | string | null;
  balance?: number | string | null;
  payment_status?: string | null;
  payment_details?: unknown;
}

function evaluateOrderPaymentCompletion(
  order: { total?: number | string | null; round_off?: number | string | null } | null | undefined,
  bills: OrderStatusBillEvaluationRow[],
  minorFactor = 100,
) {
  const evaluatedBills = bills.map((b) => {
    const totalMinor = Math.max(0, Math.round(Number(b.total || 0) * minorFactor));
    const roundOffMinor = Math.round(Number(b.round_off || 0) * minorFactor);
    const unroundedTotalMinor = Math.max(0, totalMinor - roundOffMinor);
    const paidMinor = Math.max(0, Math.round(Number(b.paid_amount || 0) * minorFactor));
    const refundedMinor = Math.max(0, Math.round(Number(b.refunded_cents || 0)));
    const fallbackBalance = Math.max(0, Number(b.total || 0) - Number(b.paid_amount || 0));
    const storedBalanceMinor = Math.max(
      0,
      Math.round(Number(b.balance ?? fallbackBalance) * minorFactor),
    );
    let parsedPaymentDetails: Array<{ amount?: unknown }> = [];
    if (typeof b.payment_details === 'string' && b.payment_details.trim()) {
      try {
        const parsed = JSON.parse(b.payment_details);
        if (Array.isArray(parsed)) parsedPaymentDetails = parsed;
      } catch {
        parsedPaymentDetails = [];
      }
    } else if (Array.isArray(b.payment_details)) {
      parsedPaymentDetails = b.payment_details as Array<{ amount?: unknown }>;
    }
    const detailsPaidMinor = parsedPaymentDetails.reduce(
      (sum, entry) => sum + Math.max(0, Math.round(Number(entry?.amount || 0) * minorFactor)),
      0,
    );
    const recordedPaidMinor = Math.max(paidMinor, detailsPaidMinor);
    const netCollectedMinor = Math.max(0, recordedPaidMinor - refundedMinor);
    const paymentStatus = String(b.payment_status || '');
    const effectiveCollectedMinor = Math.max(
      netCollectedMinor,
      paymentStatus === 'paid' ? Math.max(0, totalMinor - refundedMinor) : 0,
    );
    const hasCollectedFunds =
      effectiveCollectedMinor > 0 ||
      (recordedPaidMinor > 0 && paymentStatus !== 'refunded') ||
      paymentStatus === 'partial' ||
      paymentStatus === 'partially_refunded' ||
      (paymentStatus === 'paid' && (totalMinor > 0 || parsedPaymentDetails.length > 0));
    const isPayable = totalMinor > 0 || storedBalanceMinor > 0;
    const unpaidBalanceMinor = isPayable
      ? Math.max(storedBalanceMinor, Math.max(0, totalMinor - recordedPaidMinor))
      : 0;
    const isSettled =
      !isPayable ||
      (paymentStatus === 'paid' && unpaidBalanceMinor === 0 && recordedPaidMinor >= totalMinor);
    return {
      id: b.id,
      paymentStatus,
      totalMinor,
      unroundedTotalMinor,
      recordedPaidMinor,
      effectiveCollectedMinor,
      hasCollectedFunds,
      isPayable,
      unpaidBalanceMinor,
      isSettled,
    };
  });

  const orderTotalMinor = Math.max(0, Math.round(Number(order?.total || 0) * minorFactor));
  const orderRoundOffMinor = Math.round(Number(order?.round_off || 0) * minorFactor);
  const orderUnroundedTotalMinor = Math.max(0, orderTotalMinor - orderRoundOffMinor);
  const effectiveOrderTargetMinor = Math.min(orderTotalMinor, orderUnroundedTotalMinor);
  const payableBills = evaluatedBills.filter((b) => b.isPayable);
  const billedCoverageMinor = evaluatedBills.reduce(
    (sum, b) => sum + Math.max(b.totalMinor, b.unroundedTotalMinor),
    0,
  );
  const unbilledMinor =
    payableBills.length === 0
      ? orderTotalMinor
      : Math.max(0, effectiveOrderTargetMinor - billedCoverageMinor);
  const totalOutstandingMinor =
    payableBills.reduce((sum, b) => sum + b.unpaidBalanceMinor, 0) + unbilledMinor;
  const totalCollectedMinor = evaluatedBills.reduce((sum, b) => sum + b.effectiveCollectedMinor, 0);

  const requiresPaymentOverride =
    totalOutstandingMinor > 0 ||
    (orderTotalMinor > 0 && payableBills.length === 0) ||
    payableBills.some((b) => !b.isSettled);

  return {
    evaluatedBills,
    payableBills,
    orderTotalMinor,
    orderRoundOffMinor,
    orderUnroundedTotalMinor,
    effectiveOrderTargetMinor,
    unbilledMinor,
    totalOutstandingMinor,
    totalCollectedMinor,
    requiresPaymentOverride,
  };
}

function orderRequiresPaymentOverrideOnComplete(
  db: ReturnType<typeof getDatabase>,
  orderId: string | number,
): boolean {
  const currentOrder = db
    .prepare('SELECT total, round_off FROM orders WHERE id = ?')
    .get(orderId) as { total?: number | string; round_off?: number | string } | undefined;
  if (!currentOrder) return false;
  const currency = getTenantCurrency();
  const minorFactor = getCurrencyMinorUnitFactor(currency);

  const bills = db
    .prepare(`
      SELECT b.id, b.total, b.round_off, b.paid_amount,
             COALESCE((SELECT SUM(r.amount_cents) FROM refunds r WHERE r.bill_id = b.id), 0) AS refunded_cents,
             b.balance, b.payment_status, b.payment_details
      FROM bills b
      WHERE b.order_id = ?
      ORDER BY b.id ASC
    `)
    .all(orderId) as OrderStatusBillEvaluationRow[];

  const evaluation = evaluateOrderPaymentCompletion(currentOrder, bills, minorFactor);
  return evaluation.requiresPaymentOverride;
}

router.patch(
  '/:id/status',
  orderWriteRateLimit,
  requirePermission('orders.status.update'),
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const { status, reason, override_pin, free_table } = req.body;

      if (!status) {
        return res.status(400).json({ error: 'Status is required' });
      }

      const validStatuses = ['preparing', 'ready', 'served', 'completed', 'cancelled'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: `Invalid status. Use: ${validStatuses.join(', ')}` });
      }

      // reason is optional for cancellation

      const db = getDatabase();
      // Validate order existence before beginning authoritative transaction.
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      let preVerifiedStatusApprover: { id: string; verifiedPinHash: string } | null = null;
      if (
        (status === 'cancelled' || status === 'completed') &&
        override_pin &&
        typeof override_pin === 'string'
      ) {
        const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
        const rateLimitKey =
          status === 'cancelled'
            ? `pin:${clientIp}:order-cancel`
            : `pin:${clientIp}:order-complete`;
        if (isPinRateLimited(rateLimitKey)) {
          return res.status(429).json({ error: 'Too many PIN attempts. Try again in 15 minutes.' });
        }
        if (/^\d{4,6}$/.test(override_pin)) {
          const explicitApproverId =
            req.body.approver_id || req.body.manager_id || req.body.user_id;
          const candidateUsers = explicitApproverId
            ? (db
                .prepare(
                  'SELECT id, role, pin_hash FROM users WHERE id = ? AND is_active = 1 AND pin_hash IS NOT NULL',
                )
                .all(explicitApproverId) as PinApproverCandidate[])
            : (db
                .prepare(
                  'SELECT id, role, pin_hash FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL',
                )
                .all() as PinApproverCandidate[]);

          const requiresPaymentTake =
            status === 'completed' &&
            orderRequiresPaymentOverrideOnComplete(db, req.params.id as string);

          for (const candidate of candidateUsers) {
            if (
              hasRole(candidate.role, ROLE_ACCESS.ownerManager) &&
              hasPermission(candidate.id, 'orders.status.update') &&
              (status !== 'cancelled' || hasPermission(candidate.id, 'orders.item.cancel')) &&
              (!requiresPaymentTake || hasPermission(candidate.id, 'payments.take'))
            ) {
              if (await verifyPinAsync(candidate.pin_hash, override_pin)) {
                preVerifiedStatusApprover = {
                  id: candidate.id,
                  verifiedPinHash: candidate.pin_hash,
                };
                break;
              }
            }
          }
        }
      }

      const nowStr = now();

      const { updatedOrder, orderItems, table, changed } = withTxn(() => {
        const currentOrder = db
          .prepare('SELECT * FROM orders WHERE id = ?')
          .get(req.params.id) as any;
        if (!currentOrder) {
          throw Object.assign(new Error('Order not found'), { statusCode: 404 });
        }

        const authUser = (req as any).user;
        if (!authUser?.userId || !hasPermission(authUser.userId, 'orders.status.update')) {
          throw Object.assign(new Error('Insufficient permissions'), { statusCode: 403 });
        }

        if (currentOrder.status === status) {
          // Idempotent same-state request for order
          const items = attachEffectiveAddons(
            db,
            db
              .prepare('SELECT * FROM order_items WHERE order_id = ?')
              .all(req.params.id)
              .map(parseItemJson) as any[],
          );
          const tableRow = currentOrder.table_id
            ? (db.prepare('SELECT * FROM tables WHERE id = ?').get(currentOrder.table_id) as any)
            : null;
          const tableObj = tableRow ? { ...tableRow, name: tableRow.number } : null;
          return {
            updatedOrder: parseRowJson(currentOrder),
            orderItems: items,
            table: tableObj,
            changed: false,
          };
        }

        const VALID_TRANSITIONS: Record<string, string[]> = {
          pending: ['preparing', 'ready', 'served', 'completed', 'cancelled'],
          preparing: ['ready', 'served', 'completed', 'cancelled'],
          ready: ['served', 'completed', 'cancelled'],
          served: ['completed', 'cancelled'],
          completed: [],
          cancelled: [],
        };

        const allowedTargets = VALID_TRANSITIONS[currentOrder.status] || [];
        if (!allowedTargets.includes(status)) {
          throw Object.assign(
            new Error(
              `Cannot transition order status from '${currentOrder.status}' to '${status}'`,
            ),
            { statusCode: 400 },
          );
        }

        // Evaluate item progress, kitchen delivery policy, and bill/payment state
        // inside the authoritative transaction.
        const hasItemsInProgress =
          db
            .prepare(`
        SELECT 1 FROM order_items
        WHERE order_id = ? AND status IN ('preparing', 'ready', 'served', 'completed')
        LIMIT 1
      `)
            .get(req.params.id) !== undefined;
        const statusOrder = ['pending', 'preparing', 'ready', 'served', 'completed'];
        const currentStatusIndex = statusOrder.indexOf(currentOrder.status);

        const tenantCurrency = getTenantCurrency();
        const minorFactor = getCurrencyMinorUnitFactor(tenantCurrency);
        const fractionDigits = getCurrencyFractionDigits(tenantCurrency);
        const roundCurrency = (amount: number): number =>
          fractionDigits === 0 ? Math.round(amount) : Number(amount.toFixed(fractionDigits));

        const billRows = db
          .prepare(`
            SELECT b.*,
                   COALESCE((SELECT SUM(r.amount_cents) FROM refunds r WHERE r.bill_id = b.id), 0) AS refunded_cents
            FROM bills b
            WHERE b.order_id = ?
            ORDER BY b.id ASC
          `)
          .all(req.params.id) as Array<{
          id: string;
          total?: number | null;
          round_off?: number | null;
          paid_amount?: number | null;
          refunded_cents?: number | null;
          balance?: number | null;
          payment_details?: unknown;
          payment_status?: string | null;
        }>;

        const {
          evaluatedBills,
          payableBills,
          orderTotalMinor,
          totalOutstandingMinor,
          totalCollectedMinor,
          requiresPaymentOverride,
        } = evaluateOrderPaymentCompletion(currentOrder, billRows, minorFactor);

        const paymentBlocksCompletion = status === 'completed' && requiresPaymentOverride;

        const requireKitchenDelivered = db
          .prepare(
            "SELECT value FROM settings WHERE key = 'require_kitchen_delivered_before_settlement'",
          )
          .get() as { value: string } | undefined;
        const kdsEnabled = db
          .prepare("SELECT value FROM settings WHERE key = 'kds_enabled'")
          .get() as { value: string } | undefined;
        const billingType = db
          .prepare("SELECT value FROM settings WHERE key = 'billing_type'")
          .get() as { value: string } | undefined;
        const kitchenPolicyApplies =
          requireKitchenDelivered?.value === 'true' &&
          kdsEnabled?.value !== 'false' &&
          billingType?.value !== 'prepaid';
        const undeliveredKitchenItems =
          status === 'completed' && kitchenPolicyApplies
            ? (db
                .prepare(`
                  SELECT product_name FROM order_items
                  WHERE order_id = ? AND status IN ('pending', 'preparing', 'ready')
                `)
                .all(req.params.id) as { product_name: string }[])
            : [];
        const kitchenBlocksCompletion =
          status === 'completed' && undeliveredKitchenItems.length > 0;

        const orderInProgressForCancel = currentStatusIndex > 0 || hasItemsInProgress;
        const hasCollectedFundsOnOrder = evaluatedBills.some((b) => b.hasCollectedFunds);
        const requiresCancelOverride =
          status === 'cancelled' && (orderInProgressForCancel || hasCollectedFundsOnOrder);
        const requiresCompleteOverride =
          status === 'completed' && (paymentBlocksCompletion || kitchenBlocksCompletion);
        const requiresOverride = requiresCancelOverride || requiresCompleteOverride;

        const overriddenSafeguards: string[] = [];
        if (status === 'completed') {
          if (paymentBlocksCompletion) overriddenSafeguards.push('unsettled_payment');
          if (kitchenBlocksCompletion) overriddenSafeguards.push('kitchen_undelivered');
        } else if (status === 'cancelled') {
          if (orderInProgressForCancel) overriddenSafeguards.push('order_in_progress');
          if (hasCollectedFundsOnOrder) overriddenSafeguards.push('collected_funds');
        }

        let approvedByUserId: string | undefined;
        if (requiresOverride) {
          if (!override_pin || typeof override_pin !== 'string') {
            let missingPinMessage = 'Manager PIN required to cancel order in progress';
            if (status === 'cancelled' && hasCollectedFundsOnOrder && !orderInProgressForCancel) {
              missingPinMessage = 'Manager PIN required to cancel order with collected payment';
            } else if (status === 'completed') {
              if (paymentBlocksCompletion && kitchenBlocksCompletion) {
                missingPinMessage =
                  'Manager PIN required to complete unpaid order with undelivered kitchen items';
              } else if (paymentBlocksCompletion) {
                missingPinMessage = 'Manager PIN required to complete unpaid order';
              } else {
                missingPinMessage =
                  'Manager PIN required to complete order with undelivered kitchen items';
              }
            }
            throw Object.assign(new Error(missingPinMessage), { statusCode: 400 });
          }

          const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
          const rateLimitKey =
            status === 'cancelled'
              ? `pin:${clientIp}:order-cancel`
              : `pin:${clientIp}:order-complete`;
          if (isPinRateLimited(rateLimitKey)) {
            throw Object.assign(new Error('Too many PIN attempts. Try again in 15 minutes.'), {
              statusCode: 429,
            });
          }

          const explicitApproverId =
            req.body.approver_id || req.body.manager_id || req.body.user_id;

          let user: PinApproverCandidate | undefined;
          if (preVerifiedStatusApprover) {
            const candidate = db
              .prepare('SELECT id, role, pin_hash, is_active FROM users WHERE id = ?')
              .get(preVerifiedStatusApprover.id) as
              | { id: string; role: string; pin_hash: string | null; is_active: number }
              | undefined;
            if (
              candidate &&
              candidate.is_active === 1 &&
              candidate.pin_hash === preVerifiedStatusApprover.verifiedPinHash &&
              hasRole(candidate.role, ROLE_ACCESS.ownerManager) &&
              hasPermission(candidate.id, 'orders.status.update') &&
              (status !== 'cancelled' || hasPermission(candidate.id, 'orders.item.cancel')) &&
              (!paymentBlocksCompletion || hasPermission(candidate.id, 'payments.take')) &&
              (!explicitApproverId || candidate.id === explicitApproverId)
            ) {
              user = { id: candidate.id, role: candidate.role, pin_hash: candidate.pin_hash };
            }
          }

          if (!user) {
            checkPinRateLimit(rateLimitKey);
            throw Object.assign(new Error('Invalid manager PIN'), { statusCode: 403 });
          }
          pinAttempts.delete(rateLimitKey);
          approvedByUserId = user.id;
        }

        switch (status) {
          case 'preparing':
            db.prepare(
              'UPDATE orders SET status = ?, cooking_started_at = ?, updated_at = ? WHERE id = ?',
            ).run(status, nowStr, nowStr, req.params.id);
            break;

          case 'ready':
            db.prepare(
              'UPDATE orders SET status = ?, ready_at = ?, updated_at = ? WHERE id = ?',
            ).run(status, nowStr, nowStr, req.params.id);
            break;

          case 'served':
            db.prepare(
              'UPDATE orders SET status = ?, served_at = ?, updated_at = ? WHERE id = ?',
            ).run(status, nowStr, nowStr, req.params.id);
            break;

          case 'completed':
            db.prepare(
              'UPDATE orders SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?',
            ).run(status, nowStr, nowStr, req.params.id);
            db.prepare(`
            UPDATE order_items SET status = 'served', updated_at = ?
            WHERE order_id = ? AND status IN ('pending', 'preparing', 'ready')
          `).run(nowStr, req.params.id);
            if (currentOrder.table_id) {
              db.prepare("UPDATE tables SET status = 'available', updated_at = ? WHERE id = ?").run(
                nowStr,
                currentOrder.table_id,
              );
            }
            break;

          case 'cancelled': {
            // Restore stock only for items still pending; prepared/in-progress items use void/waste semantics.
            const eligibleItems = db
              .prepare(`
            SELECT * FROM order_items
            WHERE order_id = ? AND status = 'pending'
          `)
              .all(req.params.id) as any[];

            for (const item of eligibleItems) {
              const inventoryTarget =
                item.inventory_deducted_quantity > 0 ? orderItemInventoryTarget(db, item) : null;
              if (inventoryTarget) {
                adjustProductStock(db, {
                  productId: inventoryTarget.productId,
                  variantId: inventoryTarget.variantId,
                  quantityDelta: item.inventory_deducted_quantity,
                  movementType: 'cancel_restore',
                  referenceType: 'order_item',
                  referenceId: `${item.id}:${item.updated_at}`,
                  reason: reason || 'Order cancelled',
                  actorUserId: authUser.userId,
                });
              }
              moveOrderItemAddonStock(db, orderItemAddonStockLines(db, item.id), {
                direction: 'restore',
                actorUserId: authUser.userId,
                referenceId: `${item.id}:${item.updated_at}`,
                reason: reason || 'Order cancelled',
              });
              const recipeSnapshot = parseRecipeSnapshot(item.recipe_snapshot);
              if (recipeSnapshot) {
                applyRecipeSnapshot(db, recipeSnapshot, {
                  direction: 'restore',
                  actorUserId: authUser.userId,
                  referenceId: `${item.id}:${item.updated_at}`,
                });
              }
            }

            db.prepare(`
            UPDATE order_items SET status = 'cancelled', updated_at = ?
            WHERE order_id = ? AND status NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded')
          `).run(nowStr, req.params.id);

            db.prepare(
              'UPDATE orders SET status = ?, cancelled_at = ?, cancellation_reason = ?, updated_at = ? WHERE id = ?',
            ).run(status, nowStr, reason, nowStr, req.params.id);
            // Only free table if explicitly requested (default: true for backward compatibility)
            if (currentOrder.table_id && free_table !== false) {
              db.prepare("UPDATE tables SET status = 'available', updated_at = ? WHERE id = ?").run(
                nowStr,
                currentOrder.table_id,
              );
            }
            break;
          }
        }

        recordOrderAudit(db, {
          orderId: req.params.id as string,
          actorUserId: authUser.userId,
          action: 'status_changed',
          details: {
            from: currentOrder.status,
            to: status,
            ...(approvedByUserId && {
              actor_user_id: authUser.userId,
              approved_by: approvedByUserId,
              overridden_safeguards: overriddenSafeguards,
              bill_ids: evaluatedBills.map((b) => b.id),
              outstanding_amount: roundCurrency(totalOutstandingMinor / minorFactor),
              outstanding_amounts: evaluatedBills.map((b) => ({
                bill_id: b.id,
                outstanding_amount: roundCurrency(b.unpaidBalanceMinor / minorFactor),
                collected_amount: roundCurrency(b.effectiveCollectedMinor / minorFactor),
              })),
              collected_amount: roundCurrency(totalCollectedMinor / minorFactor),
              ...(kitchenBlocksCompletion
                ? { undelivered_items: undeliveredKitchenItems.map((i) => i.product_name) }
                : {}),
            }),
            ...(status === 'cancelled' && reason ? { reason } : {}),
          },
        });

        const updatedOrder = parseRowJson(
          db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id),
        ) as any;
        const orderItems = attachEffectiveAddons(
          db,
          db
            .prepare('SELECT * FROM order_items WHERE order_id = ?')
            .all(req.params.id)
            .map(parseItemJson) as any[],
        );
        const tableRow2 = updatedOrder.table_id
          ? (db.prepare('SELECT * FROM tables WHERE id = ?').get(updatedOrder.table_id) as any)
          : null;
        const table = tableRow2 ? { ...tableRow2, name: tableRow2.number } : null;
        return { updatedOrder, orderItems, table, changed: true };
      });

      if (changed) {
        cloudSync.recordOrderChanged(req.params.id as string, `order.${status}`);
        notifyKdsUpdate();
      }

      res.json({ order: Object.assign({}, updatedOrder, { items: orderItems, table }) });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res
        .status(error.statusCode || 500)
        .json({ error: error.statusCode ? error.message : 'Internal server error' });
    }
  }),
);

router.patch(
  '/:id/customer',
  orderWriteRateLimit,
  requirePermission('orders.customer.update'),
  (req: Request, res: Response) => {
    try {
      const db = getDatabase();
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as any;
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const { customer_id } = req.body;

      // Validate customer exists if providing one
      if (customer_id) {
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id);
        if (!customer) {
          return res.status(404).json({ error: 'Customer not found' });
        }
      }

      const nowStr = now();
      const updatedOrder = withTxn(() => {
        db.prepare('UPDATE orders SET customer_id = ?, updated_at = ? WHERE id = ?').run(
          customer_id || null,
          nowStr,
          req.params.id,
        );

        // Keep every unpaid guest check attached to the same customer.
        db.prepare(
          "UPDATE bills SET customer_id = ?, updated_at = ? WHERE order_id = ? AND payment_status != 'paid'",
        ).run(customer_id || null, nowStr, req.params.id);

        return parseRowJson(
          db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id),
        ) as any;
      });

      const customer = updatedOrder.customer_id
        ? db.prepare('SELECT * FROM customers WHERE id = ?').get(updatedOrder.customer_id)
        : null;

      cloudSync.recordOrderChanged(req.params.id as string, 'order.updated');
      notifyOrderUpdated();

      res.json({ order: { ...updatedOrder, customer } });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.patch(
  '/:id/convert-to-takeaway',
  orderWriteRateLimit,
  requirePermission('orders.create'),
  (req: Request, res: Response) => {
    try {
      const db = getDatabase();
      const nowStr = now();

      withTxn(() => {
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as any;
        if (!order) {
          throw Object.assign(new Error('Order not found'), { statusCode: 404 });
        }
        if (order.type !== 'dine_in') {
          throw Object.assign(new Error('Only dine-in orders can be converted to takeaway'), {
            statusCode: 400,
          });
        }
        if (['completed', 'cancelled'].includes(order.status)) {
          throw Object.assign(new Error('Cannot convert a completed or cancelled order'), {
            statusCode: 400,
          });
        }
        if (
          db
            .prepare(
              'SELECT 1 FROM bills WHERE order_id = ? AND split_group_id IS NOT NULL LIMIT 1',
            )
            .get(req.params.id)
        ) {
          throw Object.assign(new Error('A split dine-in check cannot be converted to takeaway'), {
            statusCode: 409,
          });
        }

        // Charges are defined per order type, so converting re-resolves them
        // against 'takeaway'. The dine-in breakdown is deliberately not carried
        // forward: its waivers belong to a charge set the takeaway order no longer
        // uses, and a takeaway order that configures no charge must end at zero
        // rather than keep the dine-in fee.
        const totals = calculateOrderTotals(db, req.params.id as string);
        const discountAmount = Number(order.discount_amount || 0);
        const engineCharges = resolveEngineCharges(
          { ...order, type: 'takeaway', charges_breakdown: null },
          totals.subtotal,
          discountAmount,
        );
        const syncedServiceCharge = engineCharges ? engineCharges.columns.service_charge : 0;
        const syncedPackagingCharge = engineCharges ? engineCharges.columns.packaging_charge : 0;
        const syncedChargesJson = engineCharges ? engineCharges.chargesJson : '[]';

        const tenantInfo = {
          country: getSettingValue('country') || '',
          business_type: getSettingValue('business_type') || 'restaurant',
          state_code: getSettingValue('state_code') || '',
          currency: getTenantCurrency(),
          taxes_enabled: getSettingValue('taxes_enabled') === 'true',
        };
        const customer = order.customer_id
          ? (db
              .prepare('SELECT * FROM customers WHERE id = ?')
              .get(order.customer_id) as Customer | null)
          : null;

        // The order type changed, so tax, rounding and the payable total are all
        // stale until they are recomputed from the item data.
        const { taxRollup, total, roundOff } = recomputeOrderTotals({
          tenantInfo,
          chargeContext: {
            ...order,
            service_charge: syncedServiceCharge,
            packaging_charge: syncedPackagingCharge,
          },
          customer,
          totals,
          discountAmount,
          taxScaling: 'when-discounted',
          appliedCharges: engineCharges ? engineCharges.appliedCharges : [],
          chargeColumnOverrides: engineCharges?.chargeColumnOverrides,
        });

        db.prepare(`
        UPDATE orders SET type = 'takeaway', table_id = NULL, subtotal = ?, tax_amount = ?, tax_breakdown = ?,
          tax_snapshot = ?, service_charge = ?, packaging_charge = ?, charges_breakdown = ?,
          total = ?, round_off = ?, updated_at = ? WHERE id = ?
      `).run(
          totals.subtotal,
          taxRollup.taxAmount,
          JSON.stringify(taxRollup.breakdowns),
          taxRollup.snapshotJson,
          syncedServiceCharge,
          syncedPackagingCharge,
          syncedChargesJson,
          total,
          roundOff,
          nowStr,
          req.params.id,
        );

        syncUnpaidBillsForOrder(
          db,
          req.params.id as string,
          {
            subtotal: totals.subtotal,
            taxAmount: taxRollup.taxAmount,
            taxBreakdown: JSON.stringify(taxRollup.breakdowns),
            taxSnapshot: taxRollup.snapshotJson,
            discountAmount,
            deliveryCharge: Number(order.delivery_charge || 0),
            packagingCharge: syncedPackagingCharge,
            serviceCharge: syncedServiceCharge,
            chargesBreakdown: syncedChargesJson,
            total,
          },
          tenantInfo.country,
        );

        if (order.table_id) {
          db.prepare("UPDATE tables SET status = 'available', updated_at = ? WHERE id = ?").run(
            nowStr,
            order.table_id,
          );
        }
        return order.table_id;
      });

      const updatedOrder = parseRowJson(
        db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id),
      ) as any;
      const orderItems = attachEffectiveAddons(
        db,
        db
          .prepare('SELECT * FROM order_items WHERE order_id = ?')
          .all(req.params.id)
          .map(parseItemJson) as any[],
      );

      cloudSync.recordOrderChanged(req.params.id as string, 'order.type_changed');
      notifyKdsUpdate();

      res.json({ order: Object.assign({}, updatedOrder, { items: orderItems, table: null }) });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res
        .status(error.statusCode || 500)
        .json({ error: error.statusCode ? error.message : 'Internal server error' });
    }
  },
);

router.patch(
  '/:id/discount',
  orderWriteRateLimit,
  requirePermission('orders.discount.apply'),
  asyncHandler(async (req: Request, res: Response) => {
    let operationCommitted = false;
    try {
      const db = getDatabase();
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as any;
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }
      if (
        db
          .prepare('SELECT 1 FROM bills WHERE order_id = ? AND split_group_id IS NOT NULL LIMIT 1')
          .get(req.params.id)
      ) {
        return res
          .status(409)
          .json(
            structuredOperationFailure(
              req,
              'fc.backend.order.discount.validation',
              'not_applied',
              'Discounts cannot be changed after a check has been split',
              'split_check',
            ),
          );
      }

      // Cannot apply discount to completed or cancelled orders
      if (['completed', 'cancelled'].includes(order.status)) {
        return res
          .status(400)
          .json(
            structuredOperationFailure(
              req,
              'fc.backend.order.discount.validation',
              'not_applied',
              'Cannot apply discount to a completed or cancelled order',
              'order_not_discountable',
            ),
          );
      }

      const { discount_type, discount_value, discount_reason } = req.body || {};

      // Validate discount_type
      if (
        discount_value !== 0 &&
        (!discount_type || !['percentage', 'amount'].includes(discount_type))
      ) {
        return res
          .status(400)
          .json(
            structuredOperationFailure(
              req,
              'fc.backend.order.discount.validation',
              'not_applied',
              'discount_type must be "percentage" or "amount"',
              'invalid_type',
            ),
          );
      }

      // Validate discount_value is a non-negative finite number
      if (
        discount_value === undefined ||
        discount_value === null ||
        typeof discount_value !== 'number' ||
        discount_value < 0 ||
        !Number.isFinite(discount_value)
      ) {
        return res
          .status(400)
          .json(
            structuredOperationFailure(
              req,
              'fc.backend.order.discount.validation',
              'not_applied',
              'discount_value must be a non-negative number',
              'invalid_value',
            ),
          );
      }

      // Check if approval is required
      let approvedByUserId: string | undefined;
      let preVerifiedOrderDiscountPinHash: string | undefined;
      if (discount_value > 0) {
        const requiresApproval = getSettingValue('discount_requires_approval') === 'true';
        if (requiresApproval) {
          const { override_pin } = req.body || {};
          if (!override_pin) {
            return res
              .status(403)
              .json({ error: 'Manager PIN required for discounts', requiresApproval: true });
          }
          const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
          const rateLimitKey = `pin:${clientIp}:discount`;
          if (isPinRateLimited(rateLimitKey)) {
            return res
              .status(429)
              .json({ error: 'Too many PIN attempts. Try again in 15 minutes.' });
          }
          const explicitApproverId =
            req.body.approver_id || req.body.manager_id || req.body.user_id;
          const candidateUsers = explicitApproverId
            ? (db
                .prepare(
                  'SELECT id, role, pin_hash FROM users WHERE id = ? AND is_active = 1 AND pin_hash IS NOT NULL',
                )
                .all(explicitApproverId) as PinApproverCandidate[])
            : (db
                .prepare(
                  'SELECT id, role, pin_hash FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL',
                )
                .all() as PinApproverCandidate[]);
          let user: PinApproverCandidate | undefined;
          for (const candidate of candidateUsers) {
            if (
              hasRole(candidate.role, ROLE_ACCESS.ownerManager) &&
              hasPermission(candidate.id, 'orders.discount.apply') &&
              (await verifyPinAsync(candidate.pin_hash, override_pin))
            ) {
              user = candidate;
              break;
            }
          }
          if (!user) {
            checkPinRateLimit(rateLimitKey);
            return res.status(403).json({ error: 'Invalid manager PIN' });
          }
          pinAttempts.delete(rateLimitKey);
          approvedByUserId = user.id;
          preVerifiedOrderDiscountPinHash = user.pin_hash;
        }
      }

      // Check discount mode
      if (discount_value > 0) {
        const discountMode = getSettingValue('discount_mode') || 'percentage';
        if (discountMode === 'none') {
          return res
            .status(400)
            .json(
              structuredOperationFailure(
                req,
                'fc.backend.order.discount.validation',
                'not_applied',
                'Discounts are disabled',
                'disabled',
              ),
            );
        }
        if (discountMode === 'flat' && discount_type === 'percentage') {
          return res
            .status(400)
            .json(
              structuredOperationFailure(
                req,
                'fc.backend.order.discount.validation',
                'not_applied',
                'Percentage discounts are disabled',
                'type_disabled',
              ),
            );
        }
        if (discountMode === 'percentage' && discount_type === 'amount') {
          return res
            .status(400)
            .json(
              structuredOperationFailure(
                req,
                'fc.backend.order.discount.validation',
                'not_applied',
                'Flat amount discounts are disabled',
                'type_disabled',
              ),
            );
        }
      }

      // Check against limits from settings (0 = no limit)
      if (discount_value > 0) {
        if (discount_type === 'percentage') {
          const maxPercentage = parseFloat(getSettingValue('discount_max_percentage') || '25');
          if (maxPercentage > 0 && discount_value > maxPercentage) {
            return res
              .status(400)
              .json(
                structuredOperationFailure(
                  req,
                  'fc.backend.order.discount.validation',
                  'not_applied',
                  `discount_value exceeds maximum percentage of ${maxPercentage}`,
                  'limit_exceeded',
                ),
              );
          }
        } else if (discount_type === 'amount') {
          const maxAmount = parseFloat(getSettingValue('discount_max_amount') || '0');
          if (maxAmount > 0 && discount_value > maxAmount) {
            return res
              .status(400)
              .json(
                structuredOperationFailure(
                  req,
                  'fc.backend.order.discount.validation',
                  'not_applied',
                  `discount_value exceeds maximum amount of ${maxAmount}`,
                  'limit_exceeded',
                ),
              );
          }
        }
      }
      const tenantInfo = {
        country: getSettingValue('country') || '',
        business_type: getSettingValue('business_type') || 'restaurant',
        state_code: getSettingValue('state_code') || '',
        currency: getTenantCurrency(),
        taxes_enabled: getSettingValue('taxes_enabled') === 'true',
      };
      // Wrap discount, tax recalculation, and bill sync in transaction.
      const result = withTxn(() => {
        if (approvedByUserId && preVerifiedOrderDiscountPinHash) {
          const approver = db
            .prepare('SELECT id, role, pin_hash, is_active FROM users WHERE id = ?')
            .get(approvedByUserId) as
            | { id: string; role: string; pin_hash: string | null; is_active: number }
            | undefined;
          if (
            !approver ||
            approver.is_active !== 1 ||
            !hasRole(approver.role, ROLE_ACCESS.ownerManager) ||
            !hasPermission(approver.id, 'orders.discount.apply') ||
            approver.pin_hash !== preVerifiedOrderDiscountPinHash
          ) {
            throw Object.assign(new Error('Invalid manager PIN'), { statusCode: 403 });
          }
        }

        // Re-fetch and re-validate under transaction lock to prevent races with concurrent edits.
        const currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as
          | EditableOrderRow
          | undefined;
        if (!currentOrder) {
          throw Object.assign(new Error('Order not found'), { statusCode: 404 });
        }
        if (['completed', 'cancelled'].includes(currentOrder.status)) {
          throw Object.assign(
            new Error('Cannot apply discount to a completed or cancelled order'),
            { statusCode: 400, diagnosticCode: 'order_not_discountable' },
          );
        }
        const splitBill = db
          .prepare('SELECT 1 FROM bills WHERE order_id = ? AND split_group_id IS NOT NULL LIMIT 1')
          .get(req.params.id);
        if (splitBill) {
          throw Object.assign(
            new Error('Discounts cannot be changed after a check has been split'),
            { statusCode: 409, diagnosticCode: 'split_check' },
          );
        }
        const refundedBill = db
          .prepare(
            `SELECT 1 FROM bills WHERE order_id = ? AND payment_status IN ('refunded', 'partially_refunded') LIMIT 1`,
          )
          .get(req.params.id);
        if (refundedBill) {
          throw Object.assign(new Error('Cannot apply discount to a refunded bill'), {
            statusCode: 409,
            diagnosticCode: 'refunded',
          });
        }

        const customer = currentOrder.customer_id
          ? ((db.prepare('SELECT * FROM customers WHERE id = ?').get(currentOrder.customer_id) as
              | Customer
              | undefined) ?? null)
          : null;
        const currency = getTenantCurrency();
        const decimals = getCurrencyFractionDigits(currency);

        // Recalculate tax from item-level data to avoid compounding on repeated discount edits.
        // The fresh item sum is the only basis: it describes exactly the items the
        // tax is summed over, and the write below heals the stored column to match.
        const totals = calculateOrderTotals(db, req.params.id as string);

        // Calculate discount amount
        let discountAmount = 0;
        if (discount_value > 0) {
          if (discount_type === 'percentage') {
            discountAmount = (totals.subtotal * discount_value) / 100;
          } else {
            discountAmount = Math.min(discount_value, totals.subtotal);
          }
          discountAmount = Number(discountAmount.toFixed(decimals));
        }

        const engineCharges = resolveEngineCharges(currentOrder, totals.subtotal, discountAmount);
        const {
          taxRollup,
          total: newTotal,
          roundOff,
        } = recomputeOrderTotals({
          tenantInfo,
          chargeContext: currentOrder,
          customer,
          totals,
          discountAmount,
          taxScaling: 'when-discounted',
          appliedCharges: engineCharges ? engineCharges.appliedCharges : null,
          chargeColumnOverrides: engineCharges?.chargeColumnOverrides,
        });

        const syncedServiceCharge = engineCharges
          ? engineCharges.columns.service_charge
          : currentOrder.service_charge || 0;
        const syncedPackagingCharge = engineCharges
          ? engineCharges.columns.packaging_charge
          : currentOrder.packaging_charge || 0;
        const syncedChargesJson = engineCharges
          ? engineCharges.chargesJson
          : (currentOrder.charges_breakdown ?? null);

        db.prepare(`
        UPDATE orders SET subtotal = ?, discount_amount = ?, discount_type = ?, discount_value = ?,
          discount_reason = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, total = ?,
          service_charge = ?, packaging_charge = ?, charges_breakdown = ?, round_off = ?, updated_at = ? WHERE id = ?
      `).run(
          totals.subtotal,
          discountAmount,
          discount_value > 0 ? discount_type : null,
          discount_value > 0 ? discount_value : null,
          discount_value > 0 ? discount_reason || null : null,
          taxRollup.taxAmount,
          JSON.stringify(taxRollup.breakdowns),
          taxRollup.snapshotJson,
          newTotal,
          syncedServiceCharge,
          syncedPackagingCharge,
          syncedChargesJson,
          roundOff,
          now(),
          req.params.id,
        );

        // Sync discount to bill if it exists and is unpaid
        const existingBill = db
          .prepare('SELECT * FROM bills WHERE order_id = ? AND payment_status != ?')
          .get(req.params.id, 'paid') as any;
        if (existingBill) {
          const pack = getActiveCountryPack(tenantInfo.country);
          const { total: billTotal, adjustment: billRoundOff } = applyPayableRounding(
            newTotal,
            pack,
            currency,
          );
          if ((existingBill.paid_amount || 0) > 0 && billTotal < existingBill.paid_amount) {
            throw Object.assign(
              new Error('Discount cannot reduce bill total below collected payments'),
              { statusCode: 409, diagnosticCode: 'below_collected_funds' },
            );
          }
          const newBillBalance = Math.max(0, billTotal - (existingBill.paid_amount || 0));
          db.prepare(`
          UPDATE bills SET subtotal = ?, discount_amount = ?, discount_type = ?, discount_value = ?,
            discount_reason = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, total = ?, balance = ?,
            service_charge = ?, packaging_charge = ?, charges_breakdown = ?, round_off = ?, updated_at = ?
          WHERE id = ?
        `).run(
            totals.subtotal,
            discountAmount,
            discount_value > 0 ? discount_type : null,
            discount_value > 0 ? discount_value : null,
            discount_value > 0 ? discount_reason || null : null,
            taxRollup.taxAmount,
            JSON.stringify(taxRollup.breakdowns),
            taxRollup.snapshotJson,
            billTotal,
            newBillBalance,
            syncedServiceCharge,
            syncedPackagingCharge,
            syncedChargesJson,
            billRoundOff,
            now(),
            existingBill.id,
          );
        }

        recordOrderAudit(db, {
          orderId: req.params.id as string,
          actorUserId: (req as any).user.userId,
          action: 'order_discount_applied',
          details: {
            discount_type,
            discount_value,
            ...(approvedByUserId && { approved_by: approvedByUserId }),
          },
        });

        const updatedOrder = parseRowJson(
          db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id),
        ) as any;
        return updatedOrder;
      });
      operationCommitted = true;

      notifyOrderUpdated();
      res.json({ order: result });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      const statusCode = error.statusCode || 500;
      const message = error.statusCode ? error.message : 'Internal server error';
      if (statusCode === 404 && !operationCommitted)
        return res.status(statusCode).json({ error: message });
      const point = operationCommitted
        ? 'fc.backend.order.discount.completion'
        : statusCode >= 500
          ? 'fc.backend.order.discount.persistence'
          : 'fc.backend.order.discount.validation';
      return res
        .status(statusCode)
        .json(
          structuredOperationFailure(
            req,
            point,
            operationCommitted ? 'applied' : 'not_applied',
            message,
            operationCommitted ? undefined : error.diagnosticCode,
          ),
        );
    }
  }),
);

router.patch(
  '/:id/items/:itemId/discount',
  orderWriteRateLimit,
  requirePermission('orders.discount.apply'),
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const db = getDatabase();
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as any;
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }
      if (
        db
          .prepare('SELECT 1 FROM bills WHERE order_id = ? AND split_group_id IS NOT NULL LIMIT 1')
          .get(req.params.id)
      ) {
        return res
          .status(409)
          .json({ error: 'Discounts cannot be changed after a check has been split' });
      }

      const refundedBill = db
        .prepare(
          `SELECT 1 FROM bills WHERE order_id = ? AND payment_status IN ('refunded', 'partially_refunded') LIMIT 1`,
        )
        .get(req.params.id);
      if (refundedBill) {
        return res.status(409).json({ error: 'Cannot apply discount to a refunded bill' });
      }
      // Cannot apply discount to completed or cancelled orders
      if (['completed', 'cancelled'].includes(order.status)) {
        return res
          .status(400)
          .json({ error: 'Cannot apply discount to a completed or cancelled order' });
      }

      const item = db
        .prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?')
        .get(req.params.itemId, req.params.id) as any;
      if (!item) {
        return res.status(404).json({ error: 'Item not found' });
      }
      if (['cancelled', 'voided', 'void_adjustment', 'refunded'].includes(item.status)) {
        return res
          .status(400)
          .json({ error: 'Cannot apply discount to a cancelled, voided, or refunded item' });
      }

      const { discount_type, discount_value } = req.body;

      // Validate discount_type
      if (!discount_type || !['percentage', 'amount'].includes(discount_type)) {
        return res.status(400).json({ error: 'discount_type must be "percentage" or "amount"' });
      }

      // Validate discount_value is a positive number
      if (
        discount_value === undefined ||
        discount_value === null ||
        typeof discount_value !== 'number' ||
        discount_value <= 0
      ) {
        return res.status(400).json({ error: 'discount_value must be a positive number' });
      }

      // Check if approval is required
      let approvedByUserId: string | undefined;
      let preVerifiedItemDiscountPinHash: string | undefined;
      const requiresApproval = getSettingValue('discount_requires_approval') === 'true';
      if (requiresApproval) {
        const { override_pin } = req.body;
        if (!override_pin) {
          return res
            .status(403)
            .json({ error: 'Manager PIN required for discounts', requiresApproval: true });
        }
        const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
        const rateLimitKey = `pin:${clientIp}:item-discount`;
        if (isPinRateLimited(rateLimitKey)) {
          return res.status(429).json({ error: 'Too many PIN attempts. Try again in 15 minutes.' });
        }
        const explicitApproverId = req.body.approver_id || req.body.manager_id || req.body.user_id;
        const candidateUsers = explicitApproverId
          ? (db
              .prepare(
                'SELECT id, role, pin_hash FROM users WHERE id = ? AND is_active = 1 AND pin_hash IS NOT NULL',
              )
              .all(explicitApproverId) as PinApproverCandidate[])
          : (db
              .prepare(
                'SELECT id, role, pin_hash FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL',
              )
              .all() as PinApproverCandidate[]);
        let user: PinApproverCandidate | undefined;
        for (const candidate of candidateUsers) {
          if (
            hasRole(candidate.role, ROLE_ACCESS.ownerManager) &&
            hasPermission(candidate.id, 'orders.discount.apply') &&
            (await verifyPinAsync(candidate.pin_hash, override_pin))
          ) {
            user = candidate;
            break;
          }
        }
        if (!user) {
          checkPinRateLimit(rateLimitKey);
          return res.status(403).json({ error: 'Invalid manager PIN' });
        }
        pinAttempts.delete(rateLimitKey);
        approvedByUserId = user.id;
        preVerifiedItemDiscountPinHash = user.pin_hash;
      }

      // Check discount mode
      const discountMode = getSettingValue('discount_mode') || 'percentage';
      if (discountMode === 'none') {
        return res.status(400).json({ error: 'Discounts are disabled' });
      }
      if (discountMode === 'flat' && discount_type === 'percentage') {
        return res.status(400).json({ error: 'Percentage discounts are disabled' });
      }
      if (discountMode === 'percentage' && discount_type === 'amount') {
        return res.status(400).json({ error: 'Flat amount discounts are disabled' });
      }

      // BUG #14 FIX: Check item-level discount against max settings (0 = no limit)
      if (discount_type === 'percentage') {
        const maxPercentage = parseFloat(getSettingValue('discount_max_percentage') || '25');
        if (maxPercentage > 0 && discount_value > maxPercentage) {
          return res
            .status(400)
            .json({ error: `discount_value exceeds maximum percentage of ${maxPercentage}` });
        }
      } else if (discount_type === 'amount') {
        const maxAmount = parseFloat(getSettingValue('discount_max_amount') || '0');
        if (maxAmount > 0 && discount_value > maxAmount) {
          return res
            .status(400)
            .json({ error: `discount_value exceeds maximum amount of ${maxAmount}` });
        }
      }

      const currency = getTenantCurrency();
      const decimals = getCurrencyFractionDigits(currency);

      const updatedItem = withTxn(() => {
        if (approvedByUserId && preVerifiedItemDiscountPinHash) {
          const approver = db
            .prepare('SELECT id, role, pin_hash, is_active FROM users WHERE id = ?')
            .get(approvedByUserId) as
            | { id: string; role: string; pin_hash: string | null; is_active: number }
            | undefined;
          if (
            !approver ||
            approver.is_active !== 1 ||
            !hasRole(approver.role, ROLE_ACCESS.ownerManager) ||
            !hasPermission(approver.id, 'orders.discount.apply') ||
            approver.pin_hash !== preVerifiedItemDiscountPinHash
          ) {
            throw Object.assign(new Error('Invalid manager PIN'), { statusCode: 403 });
          }
        }

        // Re-read current order and item under transaction lock to prevent financial state races (#1206)
        const currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id) as
          | EditableOrderRow
          | undefined;
        if (!currentOrder) {
          throw Object.assign(new Error('Order not found'), { statusCode: 404 });
        }
        if (['completed', 'cancelled'].includes(currentOrder.status)) {
          throw Object.assign(
            new Error('Cannot apply discount to a completed or cancelled order'),
            { statusCode: 400 },
          );
        }

        const splitBill = db
          .prepare('SELECT 1 FROM bills WHERE order_id = ? AND split_group_id IS NOT NULL LIMIT 1')
          .get(req.params.id);
        if (splitBill) {
          throw Object.assign(
            new Error('Discounts cannot be changed after a check has been split'),
            { statusCode: 409 },
          );
        }

        const refundedBill = db
          .prepare(
            `SELECT 1 FROM bills WHERE order_id = ? AND payment_status IN ('refunded', 'partially_refunded') LIMIT 1`,
          )
          .get(req.params.id);
        if (refundedBill) {
          throw Object.assign(new Error('Cannot apply discount to a refunded bill'), {
            statusCode: 409,
          });
        }

        const currentItem = db
          .prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?')
          .get(req.params.itemId, req.params.id) as OrderItemRow | undefined;
        if (!currentItem) {
          throw Object.assign(new Error('Item not found'), { statusCode: 404 });
        }
        if (['cancelled', 'voided', 'void_adjustment', 'refunded'].includes(currentItem.status)) {
          throw Object.assign(
            new Error('Cannot apply discount to a cancelled, voided, or refunded item'),
            { statusCode: 400 },
          );
        }

        // Calculate item discount amount using fresh quantity and addons
        const addonRows = db
          .prepare('SELECT price, quantity FROM order_item_addons WHERE order_item_id = ?')
          .all(currentItem.id) as { price: number; quantity?: number }[];
        const addonTotal = addonRows.reduce(
          (sum, addon) => sum + (addon.price || 0) * (addon.quantity || 1) * currentItem.quantity,
          0,
        );
        const freshItemBaseTotal = currentItem.unit_price * currentItem.quantity + addonTotal;

        let discountAmount: number;
        if (discount_type === 'percentage') {
          discountAmount = (freshItemBaseTotal * discount_value) / 100;
        } else {
          discountAmount = Math.min(discount_value, freshItemBaseTotal);
        }
        discountAmount = Number(discountAmount.toFixed(decimals));

        // Recalculate item subtotal after discount
        const newSubtotal = Math.max(0, freshItemBaseTotal - discountAmount);

        // Recalculate tax on discounted subtotal
        const product = db
          .prepare('SELECT * FROM products WHERE id = ?')
          .get(currentItem.product_id) as ProductRow | undefined;
        if (!product) {
          throw Object.assign(new Error('Product not found'), { statusCode: 404 });
        }
        const customer = currentOrder.customer_id
          ? ((db.prepare('SELECT * FROM customers WHERE id = ?').get(currentOrder.customer_id) as
              | Customer
              | undefined) ?? null)
          : null;
        const settings = db
          .prepare(
            "SELECT key, value FROM settings WHERE key IN ('country', 'business_type', 'state_code', 'taxes_enabled')",
          )
          .all() as { key: string; value: string }[];
        const settingsMap = Object.fromEntries(settings.map((s) => [s.key, s.value]));
        const tenantInfo = {
          country: settingsMap.country || '',
          business_type: settingsMap.business_type || 'restaurant',
          state_code: settingsMap.state_code || '',
          currency: getTenantCurrency(),
          taxes_enabled: settingsMap.taxes_enabled === 'true',
        };
        const taxResult = calculateItemTax(tenantInfo, product, newSubtotal, customer);
        const newTaxAmount = taxResult.tax_amount;
        const newTaxBreakdown = taxResult.tax_breakdown;
        const newTaxSnapshotJson = taxResult.tax_snapshot
          ? JSON.stringify(taxResult.tax_snapshot)
          : null;

        const newTotal = newSubtotal + (taxResult.tax_type === 'inclusive' ? 0 : newTaxAmount);

        // Update item with recalculated tax
        db.prepare(`
        UPDATE order_items SET discount_amount = ?,
          subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, tax_type = ?,
          total = ?, updated_at = ? WHERE id = ?
      `).run(
          discountAmount,
          newSubtotal,
          newTaxAmount,
          JSON.stringify(newTaxBreakdown),
          newTaxSnapshotJson,
          taxResult.tax_type,
          newTotal,
          now(),
          req.params.itemId,
        );

        // Update order totals excluding terminal items.
        const orderTotals = calculateOrderTotals(db, req.params.id as string);

        // Recalculate order-level discount proportionally on new subtotal
        const existingDiscountAmount = currentOrder.discount_amount || 0;
        let newOrderDiscount = existingDiscountAmount;
        if (existingDiscountAmount > 0 && currentOrder.subtotal > 0) {
          // Scale discount proportionally to new subtotal
          newOrderDiscount = Number(
            (existingDiscountAmount * (orderTotals.subtotal / currentOrder.subtotal)).toFixed(
              decimals,
            ),
          );
        }

        // Recalculate tax on discounted subtotal
        const engineCharges = resolveEngineCharges(
          currentOrder,
          orderTotals.subtotal,
          newOrderDiscount,
        );
        const {
          taxRollup,
          total: orderTotal,
          roundOff,
        } = recomputeOrderTotals({
          tenantInfo,
          chargeContext: currentOrder,
          customer,
          totals: orderTotals,
          discountAmount: newOrderDiscount,
          taxScaling: 'when-discounted',
          appliedCharges: engineCharges ? engineCharges.appliedCharges : null,
          chargeColumnOverrides: engineCharges?.chargeColumnOverrides,
        });

        const syncedServiceCharge = engineCharges
          ? engineCharges.columns.service_charge
          : currentOrder.service_charge || 0;
        const syncedPackagingCharge = engineCharges
          ? engineCharges.columns.packaging_charge
          : currentOrder.packaging_charge || 0;
        const syncedChargesJson = engineCharges
          ? engineCharges.chargesJson
          : (currentOrder.charges_breakdown ?? null);

        db.prepare(`
        UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?,
          service_charge = ?, packaging_charge = ?, charges_breakdown = ?, round_off = ?, updated_at = ? WHERE id = ?
      `).run(
          orderTotals.subtotal,
          taxRollup.taxAmount,
          JSON.stringify(taxRollup.breakdowns),
          taxRollup.snapshotJson,
          newOrderDiscount,
          orderTotal,
          syncedServiceCharge,
          syncedPackagingCharge,
          syncedChargesJson,
          roundOff,
          now(),
          req.params.id,
        );

        // BUG #15 FIX: Sync item-level discount to bill
        const existingBill = db
          .prepare("SELECT * FROM bills WHERE order_id = ? AND payment_status != 'paid'")
          .get(req.params.id) as any;
        if (existingBill) {
          const pack = getActiveCountryPack(tenantInfo.country);
          const { total: billTotal, adjustment: billRoundOff } = applyPayableRounding(
            orderTotal,
            pack,
            currency,
          );
          if ((existingBill.paid_amount || 0) > 0 && billTotal < existingBill.paid_amount) {
            throw Object.assign(
              new Error('Discount cannot reduce bill total below collected payments'),
              { statusCode: 409, diagnosticCode: 'below_collected_funds' },
            );
          }
          const newBillBalance = Math.max(0, billTotal - (existingBill.paid_amount || 0));
          db.prepare(
            `UPDATE bills SET subtotal = ?, total = ?, balance = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, service_charge = ?, packaging_charge = ?, charges_breakdown = ?, round_off = ?, updated_at = ? WHERE id = ?`,
          ).run(
            orderTotals.subtotal,
            billTotal,
            newBillBalance,
            taxRollup.taxAmount,
            JSON.stringify(taxRollup.breakdowns),
            taxRollup.snapshotJson,
            newOrderDiscount,
            syncedServiceCharge,
            syncedPackagingCharge,
            syncedChargesJson,
            billRoundOff,
            now(),
            existingBill.id,
          );
        }

        recordOrderAudit(db, {
          orderId: req.params.id as string,
          orderItemId: req.params.itemId as string,
          actorUserId: (req as any).user.userId,
          action: 'item_discount_applied',
          details: {
            discount_type,
            discount_value,
            ...(approvedByUserId && { approved_by: approvedByUserId }),
          },
        });

        const updatedRow = db
          .prepare('SELECT * FROM order_items WHERE id = ?')
          .get(req.params.itemId) as Record<string, unknown>;
        return {
          ...updatedRow,
          edit_version: getOrderItemEditVersion(
            db,
            req.params.id as string,
            req.params.itemId as string,
          ),
        };
      });

      res.json({ item: updatedItem });
    } catch (error: any) {
      console.error('[API] Internal error:', error);
      res
        .status(error.statusCode || 500)
        .json({ error: error.statusCode ? error.message : 'Internal server error' });
    }
  }),
);

function getOrderItemEditVersion(
  db: ReturnType<typeof getDatabase>,
  orderId: string | number,
  itemId: string | number,
): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(id), 0) AS v FROM order_audit_log WHERE order_id = ? AND order_item_id = ?',
    )
    .get(orderId, itemId) as { v: number } | undefined;
  return Number(row?.v ?? 0);
}

function isOrderItemSuperseded(
  db: ReturnType<typeof getDatabase>,
  orderId: string | number,
  itemId: string | number,
): boolean {
  const rows = db
    .prepare(
      `SELECT details_json FROM order_audit_log WHERE order_id = ? AND order_item_id = ? AND action = 'item_edited'`,
    )
    .all(orderId, itemId) as { details_json: string | null }[];
  return rows.some((row) => {
    if (!row.details_json) return false;
    try {
      const parsed = JSON.parse(row.details_json) as { superseded?: unknown } | null;
      return parsed?.superseded === true;
    } catch {
      return false;
    }
  });
}

function normalizeReplacementForHash(replacement: unknown): Record<string, unknown> | null {
  if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)) {
    return null;
  }
  const r = replacement as Record<string, unknown>;
  const addons = Array.isArray(r.addons)
    ? r.addons.map((a) => {
        if (!a || typeof a !== 'object') return a;
        const addon = a as Record<string, unknown>;
        return {
          id: addon.id ?? null,
          name: addon.name ?? null,
          price: addon.price !== undefined ? Number(addon.price) : null,
          quantity: addon.quantity !== undefined ? Number(addon.quantity) : 1,
        };
      })
    : null;
  return {
    product_id: String(r.product_id ?? ''),
    quantity: Number(r.quantity),
    variant_id: r.variant_id ?? null,
    variant_selection: r.variant_selection ?? null,
    modifier_selection: r.modifier_selection ?? null,
    special_instructions:
      typeof r.special_instructions === 'string' ? r.special_instructions.trim() || null : null,
    addons,
  };
}

function buildOrderItemEditRequestHash(params: {
  orderId: string;
  itemId: string;
  expectedEditVersion: number;
  hasQuantity: boolean;
  quantity: unknown;
  replacement: unknown;
  reason: unknown;
}): string {
  const normalized = {
    operation: 'order.item.edit',
    order_id: String(params.orderId),
    item_id: String(params.itemId),
    expected_edit_version: params.expectedEditVersion,
    kind: params.hasQuantity ? 'quantity' : 'replacement',
    quantity: params.hasQuantity ? Number(params.quantity) : null,
    replacement: params.hasQuantity ? null : normalizeReplacementForHash(params.replacement),
    reason: typeof params.reason === 'string' ? params.reason.trim() || null : null,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function getAppliedItemDiscountDetails(
  db: ReturnType<typeof getDatabase>,
  itemId: string | number,
): { discount_type: 'percentage' | 'amount'; discount_value: number; approved_by?: string } | null {
  const auditRow = db
    .prepare(
      `SELECT details_json FROM order_audit_log WHERE order_item_id = ? AND action = 'item_discount_applied' ORDER BY id DESC LIMIT 1`,
    )
    .get(itemId) as { details_json: string | null } | undefined;
  if (!auditRow?.details_json) return null;
  try {
    const details = JSON.parse(auditRow.details_json) as {
      discount_type?: string;
      discount_value?: number;
      approved_by?: string;
    } | null;
    if (
      (details?.discount_type === 'percentage' || details?.discount_type === 'amount') &&
      typeof details.discount_value === 'number'
    ) {
      return {
        discount_type: details.discount_type,
        discount_value: details.discount_value,
        ...(typeof details.approved_by === 'string' ? { approved_by: details.approved_by } : {}),
      };
    }
  } catch {
    // Fall back to proportional scaling.
  }
  return null;
}

function resolveEditedItemDiscountAmount(
  db: ReturnType<typeof getDatabase>,
  oldItem: OrderItemRow,
  itemBaseTotal: number,
  newQuantity: number,
  oldQuantity: number,
  decimals: number,
  extraLineOnly = false,
): number {
  const existingDiscount = Number(oldItem.discount_amount || 0);
  if (existingDiscount <= 0) return 0;
  const details = getAppliedItemDiscountDetails(db, oldItem.id);
  if (details?.discount_type === 'percentage') {
    return Math.min(
      itemBaseTotal,
      Number(((itemBaseTotal * details.discount_value) / 100).toFixed(decimals)),
    );
  }
  if (details?.discount_type === 'amount') {
    if (extraLineOnly) return 0;
    return Math.min(itemBaseTotal, Number(details.discount_value.toFixed(decimals)));
  }
  if (extraLineOnly) return 0;
  const scaled =
    oldQuantity > 0 ? (existingDiscount * newQuantity) / oldQuantity : existingDiscount;
  return Math.min(itemBaseTotal, Number(scaled.toFixed(decimals)));
}

// Cancel or void an order item (frontend calls this)
router.patch(
  '/:orderId/items/:itemId/cancel',
  orderItemCancelRateLimit,
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const orderId = String(req.params.orderId);
      const itemId = String(req.params.itemId);
      const { override_pin, reason } = req.body;

      // requireAuth (main/server.ts) already verified the token and attached
      // the user's current DB role to req.user — use that, not the JWT claim.
      const actorId = String((req as any).user?.userId || '');
      if (!actorId) return res.status(403).json({ error: 'Authentication required' });

      const db = getDatabase();
      // Look up pre-transaction rows for initial 404 validation.
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }
      const item = db
        .prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?')
        .get(itemId, orderId) as any;
      if (!item) {
        return res.status(404).json({ error: 'Item not found in this order' });
      }

      const isItemVoidInProgress = ['preparing', 'ready'].includes(item.status);
      let preVerifiedVoidApprover: { id: string; verifiedPinHash: string } | null = null;
      if (isItemVoidInProgress && override_pin && typeof override_pin === 'string') {
        const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
        const rateLimitKey = `pin:${clientIp}:item-void`;
        if (isPinRateLimited(rateLimitKey)) {
          return res.status(429).json({ error: 'Too many PIN attempts. Try again in 15 minutes.' });
        }
        if (/^\d{4,6}$/.test(override_pin)) {
          const managerId = req.body.manager_id || req.body.user_id || req.body.approver_id;
          const candidateUsers = managerId
            ? (db
                .prepare(
                  'SELECT id, role, pin_hash, is_active FROM users WHERE id = ? AND pin_hash IS NOT NULL AND is_active = 1',
                )
                .all(managerId) as {
                id: string;
                role: string;
                pin_hash: string;
                is_active: number;
              }[])
            : (db
                .prepare(
                  'SELECT id, role, pin_hash, is_active FROM users WHERE pin_hash IS NOT NULL AND is_active = 1',
                )
                .all() as { id: string; role: string; pin_hash: string; is_active: number }[]);

          for (const candidate of candidateUsers) {
            if (
              hasRole(candidate.role, ROLE_ACCESS.ownerManager) &&
              hasPermission(candidate.id, 'orders.item.void')
            ) {
              if (await verifyPinAsync(candidate.pin_hash, override_pin)) {
                preVerifiedVoidApprover = { id: candidate.id, verifiedPinHash: candidate.pin_hash };
                break;
              }
            }
          }
        }
      }

      // Wrap item cancel and total recalculation in transaction.
      const result = withTxn(() => {
        const currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
        const currentItem = db
          .prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?')
          .get(itemId, orderId) as any;
        if (!currentItem || !currentOrder) {
          throw Object.assign(new Error('Item or order not found'), { statusCode: 404 });
        }
        const actor = db
          .prepare('SELECT id FROM users WHERE id = ? AND is_active = 1')
          .get(actorId) as { id: string } | undefined;
        if (!actor) {
          throw Object.assign(new Error('Authentication required'), { statusCode: 403 });
        }
        // Idempotent no-op for already-terminal items.
        if (['cancelled', 'voided', 'void_adjustment', 'refunded'].includes(currentItem.status)) {
          const terminalPermission =
            currentItem.status === 'cancelled' ? 'orders.item.cancel' : 'orders.item.void';
          if (!hasPermission(actorId, terminalPermission)) {
            throw Object.assign(new Error('Only owner or manager can cancel this item'), {
              statusCode: 403,
            });
          }
          const items = attachEffectiveAddons(
            db,
            db
              .prepare('SELECT * FROM order_items WHERE order_id = ?')
              .all(orderId)
              .map(parseItemJson) as any[],
          );
          return {
            updatedOrder: currentOrder,
            items,
            orderCancelled: currentOrder.status === 'cancelled',
            eventType: null,
          };
        }

        if (
          db
            .prepare(`
        SELECT 1
        FROM bills
        WHERE order_id = ?
          AND NOT (COALESCE(payment_status, '') = 'paid' AND COALESCE(paid_amount, 0) = 0)
          AND (
            COALESCE(payment_status, 'unpaid') <> 'unpaid'
            OR COALESCE(paid_amount, 0) > 0
            OR (payment_details IS NOT NULL AND TRIM(payment_details) NOT IN ('', '[]', '{}', 'null'))
          )
        LIMIT 1
      `)
            .get(orderId)
        ) {
          throw Object.assign(new Error('Cannot cancel items on a paid or partially paid order'), {
            statusCode: 409,
          });
        }

        // Completed and cancelled orders are terminal.
        if (['completed', 'cancelled'].includes(currentOrder.status)) {
          throw Object.assign(new Error('Cannot cancel items on completed or cancelled orders'), {
            statusCode: 400,
          });
        }

        // Voiding items in preparation requires manager PIN and records a void adjustment line.
        const isItemVoid = ['preparing', 'ready'].includes(currentItem.status);
        const requiredPermission = isItemVoid ? 'orders.item.void' : 'orders.item.cancel';
        if (!hasPermission(actorId, requiredPermission)) {
          throw Object.assign(new Error('Only owner or manager can cancel this item'), {
            statusCode: 403,
          });
        }
        let approvedByUserId: string | undefined;
        if (isItemVoid) {
          if (!override_pin) {
            throw Object.assign(
              new Error('Manager PIN required to void an item already in progress'),
              { statusCode: 400 },
            );
          }

          const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
          // Rate-limit attempts per client rather than per item to prevent brute force attacks.
          const rateLimitKey = `pin:${clientIp}:item-void`;
          if (isPinRateLimited(rateLimitKey)) {
            throw Object.assign(new Error('Too many PIN attempts. Try again in 15 minutes.'), {
              statusCode: 429,
            });
          }

          const managerId = req.body.manager_id || req.body.user_id || req.body.approver_id;
          let pinUser: any = null;
          if (preVerifiedVoidApprover) {
            const candidate = db
              .prepare('SELECT id, role, pin_hash, is_active FROM users WHERE id = ?')
              .get(preVerifiedVoidApprover.id) as any;
            if (
              candidate &&
              candidate.is_active === 1 &&
              candidate.pin_hash === preVerifiedVoidApprover.verifiedPinHash &&
              hasRole(candidate.role, ROLE_ACCESS.ownerManager) &&
              hasPermission(candidate.id, 'orders.item.void') &&
              (!managerId || candidate.id === managerId)
            ) {
              pinUser = candidate;
            }
          }
          if (!pinUser) {
            checkPinRateLimit(rateLimitKey);
            throw Object.assign(new Error('Invalid manager PIN'), { statusCode: 403 });
          }
          pinAttempts.delete(rateLimitKey);
          approvedByUserId = pinUser.id;
        }

        if (isItemVoid) {
          // Record mirrored negative line to adjust bill total while preserving original item line.
          db.prepare(`
          INSERT INTO order_items (
            order_id, product_id, product_name, product_sku, unit_price, quantity,
            subtotal, tax_amount, tax_breakdown, tax_snapshot, tax_type, discount_amount, total,
            variant_selection, modifier_selection, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'void_adjustment', ?, ?)
        `).run(
            orderId,
            currentItem.product_id,
            `Void: ${currentItem.product_name}`,
            currentItem.product_sku,
            -currentItem.unit_price,
            currentItem.quantity,
            -currentItem.subtotal,
            -(currentItem.tax_amount || 0),
            invertTaxBreakdown(currentItem.tax_breakdown),
            invertTaxSnapshot(currentItem.tax_snapshot),
            currentItem.tax_type,
            -(currentItem.discount_amount || 0),
            -currentItem.total,
            currentItem.variant_selection,
            currentItem.modifier_selection,
            now(),
            now(),
          );
          // Mark item voided without restoring deducted inventory.
          db.prepare(
            "UPDATE order_items SET status = 'voided', voided_at = ?, updated_at = ? WHERE id = ?",
          ).run(now(), now(), itemId);
        } else {
          cancelOrderItemAndRestoreStock(db, currentItem, actorId, reason);
        }

        // Recalculate order totals excluding terminal items.
        const orderTotals = calculateOrderTotals(db, orderId);
        const { activeItems, subtotal } = orderTotals;
        // BUG #13 FIX: Preserve order-level discount (scale percentage proportionally)
        const currency = getTenantCurrency();
        const decimals = getCurrencyFractionDigits(currency);
        const existingDiscountAmount = currentOrder.discount_amount || 0;
        let newDiscountAmount = existingDiscountAmount;
        if (existingDiscountAmount > 0 && currentOrder.subtotal > 0) {
          if (currentOrder.discount_type === 'percentage') {
            const pct = currentOrder.discount_value || 0;
            newDiscountAmount = Number(((subtotal * pct) / 100).toFixed(decimals));
          }
          // amount type: keep same value
        }

        const tenantInfo = {
          country: getSettingValue('country') || '',
          business_type: getSettingValue('business_type') || 'restaurant',
          state_code: getSettingValue('state_code') || '',
          currency: getTenantCurrency(),
          taxes_enabled: getSettingValue('taxes_enabled') === 'true',
        };
        const customer = currentOrder.customer_id
          ? (db
              .prepare('SELECT * FROM customers WHERE id = ?')
              .get(currentOrder.customer_id) as any)
          : null;
        // BUG #5 FIX: Correct round-off formula; BUG #24 FIX: include delivery_charge (was missing, causing total mismatch with bill generation)
        const engineCharges = resolveEngineCharges(order, subtotal, newDiscountAmount);
        const orderCancelled = activeItems.length === 0 && currentOrder.status !== 'cancelled';
        const chargeColumnOverrides =
          engineCharges && orderCancelled
            ? {
                ...(engineCharges.ownsServiceChargeColumn ? { service_charge: 0 } : {}),
                ...(engineCharges.ownsPackagingChargeColumn ? { packaging_charge: 0 } : {}),
              }
            : engineCharges?.chargeColumnOverrides;
        const syncedCharges = orderCancelled && engineCharges ? [] : engineCharges?.appliedCharges;
        const { taxRollup, total, roundOff } = recomputeOrderTotals({
          tenantInfo,
          chargeContext: currentOrder,
          customer,
          totals: orderTotals,
          discountAmount: newDiscountAmount,
          taxScaling: 'when-discounted',
          appliedCharges: syncedCharges ?? null,
          chargeColumnOverrides,
        });

        const syncedServiceCharge =
          orderCancelled && engineCharges?.ownsServiceChargeColumn
            ? 0
            : (engineCharges?.columns.service_charge ?? (order.service_charge || 0));
        const syncedPackagingCharge =
          orderCancelled && engineCharges?.ownsPackagingChargeColumn
            ? 0
            : (engineCharges?.columns.packaging_charge ?? (order.packaging_charge || 0));
        const syncedChargesJson =
          orderCancelled && engineCharges
            ? '[]'
            : engineCharges
              ? engineCharges.chargesJson
              : (order.charges_breakdown ?? null);

        // Cancelling the last active item marks the entire order cancelled and frees table.

        if (orderCancelled) {
          db.prepare(`
          UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?,
            service_charge = ?, packaging_charge = ?, charges_breakdown = ?, round_off = ?,
            status = 'cancelled', cancelled_at = ?, cancellation_reason = ?, updated_at = ? WHERE id = ?
        `).run(
            subtotal,
            taxRollup.taxAmount,
            JSON.stringify(taxRollup.breakdowns),
            taxRollup.snapshotJson,
            newDiscountAmount,
            total,
            syncedServiceCharge,
            syncedPackagingCharge,
            syncedChargesJson,
            roundOff,
            now(),
            'All items cancelled',
            now(),
            orderId,
          );
          if (currentOrder.table_id) {
            db.prepare("UPDATE tables SET status = 'available', updated_at = ? WHERE id = ?").run(
              now(),
              currentOrder.table_id,
            );
          }
        } else {
          db.prepare(`
          UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?,
            service_charge = ?, packaging_charge = ?, charges_breakdown = ?, round_off = ?, updated_at = ? WHERE id = ?
        `).run(
            subtotal,
            taxRollup.taxAmount,
            JSON.stringify(taxRollup.breakdowns),
            taxRollup.snapshotJson,
            newDiscountAmount,
            total,
            syncedServiceCharge,
            syncedPackagingCharge,
            syncedChargesJson,
            roundOff,
            now(),
            orderId,
          );
        }

        syncUnpaidBillsForOrder(
          db,
          orderId,
          {
            subtotal,
            taxAmount: taxRollup.taxAmount,
            taxBreakdown: JSON.stringify(taxRollup.breakdowns),
            taxSnapshot: taxRollup.snapshotJson,
            discountAmount: newDiscountAmount,
            deliveryCharge: order.delivery_charge || 0,
            packagingCharge: syncedPackagingCharge,
            serviceCharge: syncedServiceCharge,
            chargesBreakdown: syncedChargesJson,
            total,
          },
          tenantInfo.country,
        );

        recordOrderAudit(db, {
          orderId,
          orderItemId: itemId,
          actorUserId: actorId,
          action: isItemVoid ? 'item_voided' : 'item_cancelled',
          details: { ...(approvedByUserId && { approved_by: approvedByUserId }) },
        });

        const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
        const items = attachEffectiveAddons(
          db,
          db
            .prepare('SELECT * FROM order_items WHERE order_id = ?')
            .all(orderId)
            .map(parseItemJson) as any[],
        );
        return {
          updatedOrder,
          items,
          orderCancelled,
          eventType: orderCancelled
            ? 'order.cancelled'
            : isItemVoid
              ? 'order.item_voided'
              : 'order.item_cancelled',
        };
      });

      if (result.eventType) {
        cloudSync.recordOrderChanged(orderId, result.eventType);
        notifyKdsUpdate();
      }
      res.json({ order: { ...result.updatedOrder, items: result.items } });
    } catch (error: any) {
      console.error('[Orders] Cancel item error:', error);
      console.error('[API] Internal error:', error);
      res
        .status(error.statusCode || 500)
        .json({ error: error.statusCode ? error.message : 'Internal server error' });
    }
  }),
);

// Owner-only edit of a live order line: change its quantity or swap it for another product.
router.patch(
  '/:orderId/items/:itemId/edit',
  orderWriteRateLimit,
  requirePermission('orders.item.edit'),
  (req: Request, res: Response) => {
    try {
      const orderId = String(req.params.orderId);
      const itemId = String(req.params.itemId);
      const actorId = String((req as Request & { user?: { userId?: string } }).user?.userId || '');
      if (!actorId) return res.status(403).json({ error: 'Authentication required' });

      const idempotencyKey = orderIdempotencyKey(req);
      if (!idempotencyKey) {
        return res.status(400).json({ error: 'Idempotency-Key header is required' });
      }

      const { quantity, replacement, reason, expected_edit_version } = req.body || {};
      if (
        typeof expected_edit_version !== 'number' ||
        !Number.isSafeInteger(expected_edit_version) ||
        expected_edit_version < 0
      ) {
        return res
          .status(400)
          .json({ error: 'expected_edit_version must be a non-negative integer' });
      }

      const hasQuantity = quantity !== undefined;
      if (hasQuantity === (replacement !== undefined)) {
        return res.status(400).json({ error: 'Provide either quantity or replacement' });
      }
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 200)) {
        return res.status(400).json({ error: 'reason must be a string of at most 200 characters' });
      }
      if (hasQuantity) {
        const parsedQty = Number(quantity);
        if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
          return res.status(400).json({ error: 'quantity must be a positive number' });
        }
      } else if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)) {
        return res.status(400).json({ error: 'replacement must be an item object' });
      }

      const requestHash = buildOrderItemEditRequestHash({
        orderId,
        itemId,
        expectedEditVersion: expected_edit_version,
        hasQuantity,
        quantity,
        replacement,
        reason,
      });

      const db = getDatabase();
      const preReplay = getStoredOrderReplay(db, actorId, idempotencyKey, requestHash) as {
        order: Record<string, unknown>;
      } | null;
      if (preReplay) {
        return res.status(200).json({ order: preReplay.order });
      }

      const result = withTxn(() => {
        const txReplay = getStoredOrderReplay(db, actorId, idempotencyKey, requestHash) as {
          order: Record<string, unknown>;
        } | null;
        if (txReplay) {
          return {
            order: txReplay.order,
            idempotentReplay: true,
          };
        }

        const currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as
          | EditableOrderRow
          | undefined;
        if (!currentOrder) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
        const oldItem = db
          .prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?')
          .get(itemId, orderId) as OrderItemRow | undefined;
        if (!oldItem) {
          throw Object.assign(new Error('Item not found in this order'), { statusCode: 404 });
        }

        const currentEditVersion = getOrderItemEditVersion(db, orderId, oldItem.id);
        if (expected_edit_version !== currentEditVersion) {
          throw Object.assign(
            new Error('Order item was modified by another request; refresh and try again'),
            { statusCode: 409 },
          );
        }

        if (isTerminalItemStatus(oldItem.status)) {
          throw Object.assign(new Error('This item can no longer be edited'), { statusCode: 400 });
        }
        if (['completed', 'cancelled'].includes(currentOrder.status)) {
          throw Object.assign(new Error('Cannot edit items on completed or cancelled orders'), {
            statusCode: 400,
          });
        }
        const bills = db.prepare('SELECT * FROM bills WHERE order_id = ?').all(orderId) as {
          split_group_id: string | null;
          payment_status: string;
          paid_amount: number | null;
        }[];
        if (bills.some((bill) => bill.split_group_id)) {
          throw Object.assign(new Error('Items cannot be changed after a check has been split'), {
            statusCode: 409,
          });
        }
        if (
          bills.some((bill) =>
            ['paid', 'refunded', 'partially_refunded'].includes(bill.payment_status),
          )
        ) {
          throw Object.assign(new Error('Cannot edit items on a paid or refunded order'), {
            statusCode: 409,
          });
        }

        const tenantInfo = {
          country: getSettingValue('country') || '',
          business_type: getSettingValue('business_type') || 'restaurant',
          state_code: getSettingValue('state_code') || '',
          currency: getTenantCurrency(),
          taxes_enabled: getSettingValue('taxes_enabled') === 'true',
        };
        const decimals = getCurrencyFractionDigits(tenantInfo.currency);
        const customer = currentOrder.customer_id
          ? (db
              .prepare('SELECT * FROM customers WHERE id = ?')
              .get(currentOrder.customer_id) as TaxCustomerRow)
          : null;
        const oldAddons = db
          .prepare('SELECT * FROM order_item_addons WHERE order_item_id = ? ORDER BY id')
          .all(oldItem.id) as {
          id: number;
          addon_id: string | null;
          addon_name: string;
          price: number;
          quantity: number;
          inventory_deducted_quantity: number;
        }[];

        const oldQuantity = Number(oldItem.quantity);
        const newQuantity = hasQuantity ? Number(quantity) : 0;
        if (hasQuantity && newQuantity === oldQuantity) {
          throw Object.assign(new Error('Quantity is unchanged'), { statusCode: 400 });
        }

        const isPendingLine = oldItem.status === 'pending';
        const isStartedQuantityDecrease =
          hasQuantity && newQuantity < oldQuantity && !isPendingLine;
        const isStartedQuantityIncrease =
          hasQuantity && newQuantity > oldQuantity && !isPendingLine;

        let newItemId: number | bigint | null = null;
        let superseded = false;
        let wastedQuantity: number | undefined;

        if (!hasQuantity && !isPendingLine) {
          throw Object.assign(
            new Error(
              'Cannot replace an item once kitchen preparation has started; reduce quantity or void instead',
            ),
            { statusCode: 400 },
          );
        }

        if (isStartedQuantityDecrease) {
          const product = db
            .prepare('SELECT * FROM products WHERE id = ?')
            .get(oldItem.product_id) as ProductRow | undefined;
          if (!product) {
            throw Object.assign(new Error(`Product ${oldItem.product_id} not found`), {
              statusCode: 404,
            });
          }
          validateProductQuantity(product, newQuantity);

          const addonPerUnitTotal = oldAddons.reduce(
            (sum, addon) => sum + Number(addon.price || 0) * Number(addon.quantity || 1),
            0,
          );
          const unitPrice = Number(oldItem.unit_price);
          const itemBaseTotal = (unitPrice + addonPerUnitTotal) * newQuantity;
          const itemDiscount = resolveEditedItemDiscountAmount(
            db,
            oldItem,
            itemBaseTotal,
            newQuantity,
            oldQuantity,
            decimals,
          );
          const itemSubtotal = Math.max(
            0,
            Number((itemBaseTotal - itemDiscount).toFixed(decimals)),
          );
          const taxResult = calculateItemTax(tenantInfo, product, itemSubtotal, customer);
          const itemTotal =
            itemSubtotal + (taxResult.tax_type === 'inclusive' ? 0 : taxResult.tax_amount);
          const itemTaxSnapshotJson = taxResult.tax_snapshot
            ? JSON.stringify(taxResult.tax_snapshot)
            : null;

          // The dropped units are waste that stays out of stock, so the line's
          // held deduction, add-on snapshot, and recipe snapshot shrink to the
          // remaining quantity. A later cancel restores exactly what the line
          // still holds instead of the original deduction (regression: wasted
          // stock returning to available when a back-to-pending line is edited).
          const heldRatio = newQuantity / oldQuantity;
          const heldRecipeSnapshot = parseRecipeSnapshot(oldItem.recipe_snapshot);

          db.prepare(`
            UPDATE order_items
            SET quantity = ?,
                inventory_deducted_quantity = ?,
                recipe_snapshot = ?,
                subtotal = ?,
                tax_amount = ?,
                tax_breakdown = ?,
                tax_snapshot = ?,
                tax_type = ?,
                discount_amount = ?,
                total = ?,
                updated_at = ?
            WHERE id = ?
          `).run(
            newQuantity,
            Number((Number(oldItem.inventory_deducted_quantity) * heldRatio).toFixed(6)),
            heldRecipeSnapshot
              ? JSON.stringify({
                  ...heldRecipeSnapshot,
                  components: heldRecipeSnapshot.components.map((component) => ({
                    ...component,
                    quantity: Number((component.quantity * heldRatio).toFixed(6)),
                  })),
                })
              : oldItem.recipe_snapshot,
            itemSubtotal,
            taxResult.tax_amount,
            JSON.stringify(taxResult.tax_breakdown),
            itemTaxSnapshotJson,
            taxResult.tax_type,
            itemDiscount,
            itemTotal,
            now(),
            oldItem.id,
          );

          for (const addon of oldAddons) {
            db.prepare(
              'UPDATE order_item_addons SET inventory_deducted_quantity = ? WHERE id = ?',
            ).run(
              Number((Number(addon.inventory_deducted_quantity || 0) * heldRatio).toFixed(6)),
              addon.id,
            );
          }

          superseded = false;
          wastedQuantity = Number((oldQuantity - newQuantity).toFixed(6));
        } else {
          let newItem: OrderItemInput;
          const preserveUnitPrice = hasQuantity;
          const preserveStoredSelections = hasQuantity && newQuantity < oldQuantity;
          if (hasQuantity) {
            const lineQuantity = isStartedQuantityIncrease
              ? Number((newQuantity - oldQuantity).toFixed(6))
              : newQuantity;
            const parsedOld = parseItemJson(oldItem);
            newItem = {
              product_id: oldItem.product_id,
              variant_id: oldItem.variant_id,
              quantity: lineQuantity,
              unit_price: oldItem.unit_price,
              variant_selection: parsedOld.variant_selection,
              modifier_selection: parsedOld.modifier_selection,
              special_instructions: oldItem.special_instructions,
              addons: oldAddons.map((addon) => ({
                id: addon.addon_id ?? undefined,
                name: addon.addon_name,
                price: addon.price,
                quantity: addon.quantity,
              })),
            };
          } else {
            newItem = { ...replacement };
          }

          if (isStartedQuantityIncrease) {
            superseded = false;
          } else if (isPendingLine) {
            cancelOrderItemAndRestoreStock(db, oldItem, actorId, reason);
            superseded = true;
          } else {
            // Started replacement: void original line without restoring stock.
            db.prepare(
              "UPDATE order_items SET status = 'voided', voided_at = ?, updated_at = ? WHERE id = ?",
            ).run(now(), now(), oldItem.id);
            superseded = true;
            wastedQuantity = oldQuantity;
          }

          try {
            validateItemNotes(db, newItem.special_instructions);
            if (preserveStoredSelections) {
              // A reduction needs no extra units, so the stored selections stay
              // authoritative even when the catalog has since disabled the sold
              // variant or add-on; their held stock scales with the line.
              const heldRatio = newQuantity / oldQuantity;
              newItem.addons = oldAddons.map((addon) => ({
                id: addon.addon_id ?? undefined,
                name: addon.addon_name,
                price: addon.price,
                quantity: addon.quantity,
                inventory_deducted_quantity: Number(
                  (Number(addon.inventory_deducted_quantity || 0) * heldRatio).toFixed(6),
                ),
              }));
              const heldRecipeSnapshot = parseRecipeSnapshot(oldItem.recipe_snapshot);
              newItem.recipe_snapshot = heldRecipeSnapshot
                ? {
                    ...heldRecipeSnapshot,
                    components: heldRecipeSnapshot.components.map((component) => ({
                      ...component,
                      quantity: Number((component.quantity * heldRatio).toFixed(6)),
                    })),
                  }
                : null;
              const oldTarget = orderItemInventoryTarget(db, oldItem);
              newItem.inventory_deducted_quantity = Number(
                (Number(oldItem.inventory_deducted_quantity || 0) * heldRatio).toFixed(6),
              );
              newItem.inventory_target_product_id = oldTarget?.productId ?? null;
              newItem.inventory_target_variant_id = oldTarget?.variantId ?? null;
            } else {
              const resolved = resolveItemAddons(
                db,
                newItem.product_id,
                newItem.addons,
                newItem.quantity,
              );
              if (preserveUnitPrice && Array.isArray(resolved)) {
                const originalPrice = new Map(oldAddons.map((a) => [a.addon_id, a.price]));
                for (const addon of resolved) {
                  const original = originalPrice.get(addon.id);
                  if (original !== undefined) addon.price = original;
                }
              }
              newItem.addons = resolved;
            }
          } catch (err: unknown) {
            throw Object.assign(new Error(err instanceof Error ? err.message : 'Invalid item'), {
              statusCode: 400,
            });
          }

          const carriedDiscountDetails = preserveUnitPrice
            ? getAppliedItemDiscountDetails(db, oldItem.id)
            : null;
          if (preserveUnitPrice) {
            const addonPerUnitTotal = (newItem.addons || []).reduce(
              (sum, addon) => sum + Number(addon?.price || 0) * Number(addon?.quantity || 1),
              0,
            );
            const itemBaseTotal =
              (Number(newItem.unit_price) + addonPerUnitTotal) * Number(newItem.quantity);
            newItem.discount_amount = resolveEditedItemDiscountAmount(
              db,
              oldItem,
              itemBaseTotal,
              Number(newItem.quantity),
              oldQuantity,
              decimals,
              isStartedQuantityIncrease,
            );
          }

          const [insertedId] = insertOrderItems(db, orderId, [newItem], {
            tenantInfo,
            customer,
            isOnlineOrder: !!currentOrder.online_platform,
            actorUserId: actorId,
            initialStatus: 'pending',
            preserveUnitPrice,
            preserveSelections: preserveStoredSelections,
          });
          newItemId = insertedId;
          if (
            carriedDiscountDetails &&
            Number(newItem.discount_amount || 0) > 0 &&
            (!isStartedQuantityIncrease || carriedDiscountDetails.discount_type === 'percentage')
          ) {
            recordOrderAudit(db, {
              orderId,
              orderItemId: String(insertedId),
              actorUserId: actorId,
              action: 'item_discount_applied',
              details: carriedDiscountDetails,
            });
          }
        }

        const orderTotals = calculateOrderTotals(db, orderId);
        const { subtotal } = orderTotals;
        let newDiscountAmount = currentOrder.discount_amount || 0;
        if (newDiscountAmount > 0 && currentOrder.subtotal > 0) {
          if (currentOrder.discount_type === 'percentage') {
            newDiscountAmount = Number(
              ((subtotal * (currentOrder.discount_value || 0)) / 100).toFixed(decimals),
            );
          } else {
            newDiscountAmount = Math.min(subtotal, Number(newDiscountAmount.toFixed(decimals)));
          }
        }
        const engineCharges = resolveEngineCharges(currentOrder, subtotal, newDiscountAmount);
        const { taxRollup, total, roundOff } = recomputeOrderTotals({
          tenantInfo,
          chargeContext: currentOrder,
          customer,
          totals: orderTotals,
          discountAmount: newDiscountAmount,
          taxScaling: 'when-discounted',
          appliedCharges: engineCharges ? engineCharges.appliedCharges : null,
          chargeColumnOverrides: engineCharges?.chargeColumnOverrides,
        });

        const { total: payableTotal } = applyPayableRounding(
          total,
          getActiveCountryPack(tenantInfo.country),
          tenantInfo.currency,
        );
        const collected = bills.reduce((sum, bill) => sum + Number(bill.paid_amount || 0), 0);
        if (payableTotal < collected) {
          throw Object.assign(
            new Error(
              'The new total is below the amount already collected; refund the difference first',
            ),
            { statusCode: 409 },
          );
        }

        const serviceCharge = engineCharges
          ? engineCharges.columns.service_charge
          : currentOrder.service_charge || 0;
        const packagingCharge = engineCharges
          ? engineCharges.columns.packaging_charge
          : currentOrder.packaging_charge || 0;
        const chargesJson = engineCharges
          ? engineCharges.chargesJson
          : (currentOrder.charges_breakdown ?? null);
        db.prepare(`
          UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?,
            service_charge = ?, packaging_charge = ?, charges_breakdown = ?, round_off = ?, updated_at = ? WHERE id = ?
        `).run(
          subtotal,
          taxRollup.taxAmount,
          JSON.stringify(taxRollup.breakdowns),
          taxRollup.snapshotJson,
          newDiscountAmount,
          total,
          serviceCharge,
          packagingCharge,
          chargesJson,
          roundOff,
          now(),
          orderId,
        );
        syncUnpaidBillsForOrder(
          db,
          orderId,
          {
            subtotal,
            taxAmount: taxRollup.taxAmount,
            taxBreakdown: JSON.stringify(taxRollup.breakdowns),
            taxSnapshot: taxRollup.snapshotJson,
            discountAmount: newDiscountAmount,
            deliveryCharge: currentOrder.delivery_charge || 0,
            packagingCharge,
            serviceCharge,
            chargesBreakdown: chargesJson,
            total,
          },
          tenantInfo.country,
        );

        recordOrderAudit(db, {
          orderId,
          orderItemId: itemId,
          actorUserId: actorId,
          action: 'item_edited',
          details: {
            kind: hasQuantity ? 'quantity' : 'replacement',
            from_quantity: oldItem.quantity,
            from_product_id: oldItem.product_id,
            superseded,
            ...(newItemId !== null ? { new_item_id: Number(newItemId) } : {}),
            ...(hasQuantity ? { to_quantity: newQuantity } : {}),
            ...(wastedQuantity !== undefined ? { wasted_quantity: wastedQuantity } : {}),
            ...(reason ? { reason } : {}),
          },
        });

        const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<
          string,
          unknown
        >;
        const items = attachEffectiveAddons(
          db,
          db
            .prepare('SELECT * FROM order_items WHERE order_id = ?')
            .all(orderId)
            .map(parseItemJson) as { id: number }[],
        );
        const response = { order: { ...updatedOrder, items } };
        db.prepare(
          'INSERT INTO order_idempotency (user_id, idempotency_key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
        ).run(actorId, idempotencyKey, requestHash, JSON.stringify(response), now());
        return { order: response.order, idempotentReplay: false };
      });

      if (!result.idempotentReplay) {
        cloudSync.recordOrderChanged(orderId, 'order.item_edited');
        notifyKdsUpdate();
      }
      res.json({ order: result.order });
    } catch (err) {
      const error = err as { statusCode?: number; message?: string };
      console.error('[Orders] Edit item error:', error);
      res
        .status(error.statusCode || 500)
        .json({ error: error.statusCode ? error.message : 'Internal server error' });
    }
  },
);

// Restore cancelled order item (frontend calls this)
router.patch('/:orderId/items/:itemId/restore', (req: Request, res: Response) => {
  try {
    const orderId = String(req.params.orderId);
    const itemId = String(req.params.itemId);

    // requireAuth (main/server.ts) already verified the token and attached
    // the user's current DB role to req.user — use that, not the JWT claim.
    const actorId = String((req as any).user?.userId || '');
    if (!actorId) return res.status(403).json({ error: 'Authentication required' });

    const db = getDatabase();
    // Keep these lookups only for the inexpensive not-found response. The
    // transaction repeats all mutable state and policy checks authoritatively.
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const item = db
      .prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?')
      .get(itemId, orderId) as any;
    if (!item) {
      return res.status(404).json({ error: 'Item not found in this order' });
    }

    // BUG #17 FIX: Wrap restore + total recalc in transaction
    const result = withTxn(() => {
      const currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
      const currentItem = db
        .prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?')
        .get(itemId, orderId) as any;
      if (!currentItem || !currentOrder) {
        throw Object.assign(new Error('Item or order not found'), { statusCode: 404 });
      }
      const actor = db
        .prepare('SELECT id FROM users WHERE id = ? AND is_active = 1')
        .get(actorId) as { id: string } | undefined;
      if (!actor || !hasPermission(actorId, 'orders.item.restore')) {
        throw Object.assign(new Error('Only owner or manager can restore items'), {
          statusCode: 403,
        });
      }

      if (['completed', 'cancelled'].includes(currentOrder.status)) {
        throw Object.assign(new Error('Cannot restore items on completed or cancelled orders'), {
          statusCode: 400,
        });
      }
      if (
        db
          .prepare(
            "SELECT id FROM bills WHERE order_id = ? AND payment_status IN ('paid', 'partial') AND COALESCE(paid_amount, 0) > 0",
          )
          .get(orderId)
      ) {
        throw Object.assign(new Error('Cannot restore items on a paid order'), { statusCode: 400 });
      }

      if (
        currentItem.status === 'cancelled' &&
        isOrderItemSuperseded(db, orderId, currentItem.id)
      ) {
        throw Object.assign(new Error('Superseded order items cannot be restored'), {
          statusCode: 400,
        });
      }

      // Only cancelled items can be restored; ignore if already active or voided
      if (currentItem.status !== 'cancelled') {
        const items = attachEffectiveAddons(
          db,
          db
            .prepare('SELECT * FROM order_items WHERE order_id = ?')
            .all(orderId)
            .map(parseItemJson) as any[],
        );
        return { updatedOrder: currentOrder, items, changed: false };
      }

      // Re-deduct the inventory quantity originally consumed by the item
      const inventoryTarget =
        currentItem.inventory_deducted_quantity > 0
          ? orderItemInventoryTarget(db, currentItem)
          : null;
      if (inventoryTarget) {
        adjustProductStock(db, {
          productId: inventoryTarget.productId,
          variantId: inventoryTarget.variantId,
          quantityDelta: -currentItem.inventory_deducted_quantity,
          movementType: 'cancel_restore',
          referenceType: 'order_item',
          referenceId: `${currentItem.id}:${currentItem.updated_at}`,
          reason: 'Cancelled item restored',
          actorUserId: actorId,
        });
      }
      // The add-on snapshot, not a recomputation from the current catalog: the
      // merchant may have changed the add-on since the order was placed.
      moveOrderItemAddonStock(db, orderItemAddonStockLines(db, currentItem.id), {
        direction: 'deplete',
        actorUserId: actorId,
        referenceId: `${currentItem.id}:${currentItem.updated_at}`,
        reason: 'Cancelled item restored',
      });
      const recipeSnapshot = parseRecipeSnapshot(currentItem.recipe_snapshot);
      if (recipeSnapshot) {
        applyRecipeSnapshot(db, recipeSnapshot, {
          direction: 'deplete',
          actorUserId: actorId,
          referenceId: `${currentItem.id}:${currentItem.updated_at}`,
        });
      }

      // Restore - mark as pending
      db.prepare("UPDATE order_items SET status = 'pending', updated_at = ? WHERE id = ?").run(
        now(),
        itemId,
      );

      // Recalculate order totals
      const orderTotals = calculateOrderTotals(db, orderId);
      const { subtotal } = orderTotals;
      // BUG #13 FIX: Preserve order-level discount (scale percentage proportionally)
      const currency = getTenantCurrency();
      const decimals = getCurrencyFractionDigits(currency);
      const existingDiscountAmount = currentOrder.discount_amount || 0;
      let newDiscountAmount = existingDiscountAmount;
      if (existingDiscountAmount > 0 && currentOrder.subtotal > 0) {
        if (currentOrder.discount_type === 'percentage') {
          const pct = currentOrder.discount_value || 0;
          newDiscountAmount = Number(((subtotal * pct) / 100).toFixed(decimals));
        }
        // amount type: keep same value
      }

      const tenantInfo = {
        country: getSettingValue('country') || '',
        business_type: getSettingValue('business_type') || 'restaurant',
        state_code: getSettingValue('state_code') || '',
        currency: getTenantCurrency(),
        taxes_enabled: getSettingValue('taxes_enabled') === 'true',
      };
      const customer = currentOrder.customer_id
        ? (db.prepare('SELECT * FROM customers WHERE id = ?').get(currentOrder.customer_id) as any)
        : null;
      // BUG #5 FIX: Correct round-off formula; BUG #24 FIX: include delivery_charge (was missing, causing total mismatch with bill generation)
      const engineCharges = resolveEngineCharges(order, subtotal, newDiscountAmount);
      const { taxRollup, total, roundOff } = recomputeOrderTotals({
        tenantInfo,
        chargeContext: currentOrder,
        customer,
        totals: orderTotals,
        discountAmount: newDiscountAmount,
        taxScaling: 'when-discounted',
        appliedCharges: engineCharges ? engineCharges.appliedCharges : null,
        chargeColumnOverrides: engineCharges?.chargeColumnOverrides,
      });

      const syncedServiceCharge = engineCharges
        ? engineCharges.columns.service_charge
        : order.service_charge || 0;
      const syncedPackagingCharge = engineCharges
        ? engineCharges.columns.packaging_charge
        : order.packaging_charge || 0;
      const syncedChargesJson = engineCharges
        ? engineCharges.chargesJson
        : (order.charges_breakdown ?? null);

      db.prepare(`
        UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?,
          service_charge = ?, packaging_charge = ?, charges_breakdown = ?, round_off = ?, updated_at = ? WHERE id = ?
      `).run(
        subtotal,
        taxRollup.taxAmount,
        JSON.stringify(taxRollup.breakdowns),
        taxRollup.snapshotJson,
        newDiscountAmount,
        total,
        syncedServiceCharge,
        syncedPackagingCharge,
        syncedChargesJson,
        roundOff,
        now(),
        orderId,
      );

      syncUnpaidBillsForOrder(
        db,
        orderId,
        {
          subtotal,
          taxAmount: taxRollup.taxAmount,
          taxBreakdown: JSON.stringify(taxRollup.breakdowns),
          taxSnapshot: taxRollup.snapshotJson,
          discountAmount: newDiscountAmount,
          deliveryCharge: order.delivery_charge || 0,
          packagingCharge: syncedPackagingCharge,
          serviceCharge: syncedServiceCharge,
          chargesBreakdown: syncedChargesJson,
          total,
        },
        tenantInfo.country,
      );

      recordOrderAudit(db, {
        orderId,
        orderItemId: itemId,
        actorUserId: actorId,
        action: 'item_restored',
      });

      const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
      const items = attachEffectiveAddons(
        db,
        db
          .prepare('SELECT * FROM order_items WHERE order_id = ?')
          .all(orderId)
          .map(parseItemJson) as any[],
      );
      return { updatedOrder, items, changed: true };
    });

    if (result.changed) {
      cloudSync.recordOrderChanged(orderId, 'order.item_restored');
      notifyKdsUpdate();
    }
    res.json({ order: { ...result.updatedOrder, items: result.items } });
  } catch (error: any) {
    console.error('[Orders] Restore item error:', error);
    console.error('[API] Internal error:', error);
    res
      .status(error.statusCode || 500)
      .json({ error: error.statusCode ? error.message : 'Internal server error' });
  }
});

export const orderRoutes = router;

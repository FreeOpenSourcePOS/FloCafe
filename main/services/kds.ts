import { WebSocketServer, WebSocket } from 'ws';
import { getDatabase, getKdsStationCategoryIds, getKdsStationRoutingScope, getUserKdsStationIds, hasUserKdsStationAssignments, isDatabaseMaintenanceActive, isKdsStationItemAllowed, now, parseItemJson, attachEffectiveAddons, isKdsEnabled, isVoidedItemKdsVisible, KDS_VOIDED_ITEM_VISIBILITY_MS, projectKdsItem, projectKdsOrder, registerDatabaseMaintenanceStartListener, withTxn } from '../db';
import * as jwt from 'jsonwebtoken';
import { getJWTSecret, parseCategoryIds } from '../routes/auth';
import { getUserAuthStatus, isTokenRevoked, isTokenStale } from '../middleware/security';
import { ROLE_ACCESS, hasRole } from '../../shared/role-permissions';

interface KdsClient {
  ws: WebSocket;
  userId: string | null;
  userName: string | null;
  role: string | null;
  categoryIds: string[];
  stationIds: string[];
  stationCategoryIds: string[];
  stationAssignmentsConfigured: boolean;
  token: string | null;
  isAlive: boolean;
  categoryIdsChanged: boolean;
  stationIdsChanged: boolean;
  lastExpiredVoidMarker: string | null;
  authTimeout?: NodeJS.Timeout;
}

export const KDS_AUTH_TIMEOUT_MS = 5_000;
export const MAX_KDS_CLIENTS = 100;
export const MAX_UNAUTHENTICATED_KDS_CLIENTS = 25;
const clients: Map<WebSocket, KdsClient> = new Map();
let activeWebSocketServers = 0;
let heartbeat: NodeJS.Timeout | null = null;

function clearClientAuthTimeout(client: KdsClient): void {
  if (client.authTimeout) {
    clearTimeout(client.authTimeout);
    client.authTimeout = undefined;
  }
}

function clearClientIdentity(client: KdsClient): void {
  clearClientAuthTimeout(client);
  client.userId = null;
  client.userName = null;
  client.role = null;
  client.categoryIds = [];
  client.stationIds = [];
  client.stationCategoryIds = [];
  client.stationAssignmentsConfigured = false;
  client.lastExpiredVoidMarker = null;
  client.token = null;
}

function getExpiredVoidMarker(): string | null {
  try {
    const cutoff = new Date(Date.now() - KDS_VOIDED_ITEM_VISIBILITY_MS).toISOString().replace('T', ' ').replace(/\..*$/, '');
    const row = getDatabase().prepare(`
      SELECT COUNT(*) AS count, MAX(id) AS max_id
      FROM order_items
      WHERE status = 'voided' AND voided_at IS NOT NULL AND voided_at <= ?
    `).get(cutoff) as { count: number; max_id: number | null };
    return row.count > 0 ? `${row.count}:${row.max_id ?? ''}` : null;
  } catch {
    return null;
  }
}

function closeKdsClient(client: KdsClient, message?: string): void {
  clients.delete(client.ws);
  if (message && client.ws.readyState === WebSocket.OPEN) {
    try { client.ws.send(JSON.stringify({ type: 'auth_error', message })); } catch { }
  }
  clearClientIdentity(client);
  if (client.ws.readyState === WebSocket.OPEN || client.ws.readyState === WebSocket.CONNECTING) {
    client.ws.close(1008, message || 'Session invalid');
  }
}

function isKdsClientAuthorized(client: KdsClient): boolean {
  if (!isKdsEnabled() || !client.userId || !client.token || isTokenRevoked(client.token)) return false;
  try {
    const decoded = jwt.verify(client.token, getJWTSecret()) as any;
    const status = getUserAuthStatus(decoded.userId, { fresh: true });
    if (
      decoded.userId !== client.userId ||
      !status?.isActive ||
      !hasRole(status.role, ROLE_ACCESS.kitchen) ||
      isTokenStale(decoded.iat, status.tokensValidAfter)
    ) return false;
    const currentUser = getDatabase()
      .prepare('SELECT category_ids FROM users WHERE id = ? AND is_active = 1')
      .get(client.userId) as { category_ids: string | null } | undefined;
    if (!currentUser) return false;
    const nextCategoryIds = hasRole(status.role, ROLE_ACCESS.ownerManager)
      ? []
      : parseCategoryIds(currentUser.category_ids);
    const nextStationIds = getUserKdsStationIds(getDatabase(), client.userId);
    const nextStationCategoryIds = nextStationIds ? getKdsStationCategoryIds(getDatabase(), nextStationIds) : null;
    const nextStationAssignmentsConfigured = hasUserKdsStationAssignments(getDatabase(), client.userId);
    if (!nextStationIds || !nextStationCategoryIds || nextStationAssignmentsConfigured === null) return false;
    if (nextStationAssignmentsConfigured && nextStationIds.length === 0) return false;
    const roleChanged = client.role !== status.role;
    client.categoryIdsChanged = client.categoryIdsChanged
      || JSON.stringify(client.categoryIds) !== JSON.stringify(nextCategoryIds);
    client.stationIdsChanged = client.stationIdsChanged
      || roleChanged
      || JSON.stringify(client.stationIds) !== JSON.stringify(nextStationIds)
      || JSON.stringify(client.stationCategoryIds) !== JSON.stringify(nextStationCategoryIds)
      || client.stationAssignmentsConfigured !== nextStationAssignmentsConfigured;
    client.role = status.role;
    client.categoryIds = nextCategoryIds;
    client.stationIds = nextStationIds;
    client.stationCategoryIds = nextStationCategoryIds;
    client.stationAssignmentsConfigured = nextStationAssignmentsConfigured;
    return true;
  } catch {
    return false;
  }
}

export function setupKdsWebSocket(wss: WebSocketServer): void {
  const unregisterMaintenanceListener = registerDatabaseMaintenanceStartListener(() => {
    clients.forEach((client) => closeKdsClient(client, 'Database maintenance in progress'));
  });
  wss.once('close', unregisterMaintenanceListener);
  wss.on('connection', (ws: WebSocket, _req) => {
    const unauthenticatedClients = Array.from(clients.values()).filter((client) => !client.userId).length;
    if (clients.size >= MAX_KDS_CLIENTS || unauthenticatedClients >= MAX_UNAUTHENTICATED_KDS_CLIENTS) {
      ws.close(1013, 'KDS connection capacity reached');
      return;
    }

    console.log('[KDS] New client connection');

    const client: KdsClient = {
      ws,
      userId: null,
      userName: null,
      role: null,
      categoryIds: [],
      stationIds: [],
      stationCategoryIds: [],
      stationAssignmentsConfigured: false,
      token: null,
      isAlive: true,
      categoryIdsChanged: false,
      stationIdsChanged: false,
      lastExpiredVoidMarker: null,
    };
    client.authTimeout = setTimeout(() => {
      if (!client.userId) {
        closeKdsClient(client, 'Authentication required');
      }
    }, KDS_AUTH_TIMEOUT_MS);
    client.authTimeout.unref();
    clients.set(ws, client);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        handleMessage(ws, message);
      } catch (error) {
        console.error('[KDS] Message parse error:', error);
      }
    });

    ws.on('close', () => {
      console.log('[KDS] Client disconnected');
      clearClientAuthTimeout(client);
      clients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('[KDS] Client error:', error);
    });

    ws.on('pong', () => {
      client.isAlive = true;
    });

    ws.send(JSON.stringify({
      type: 'connected',
      message: 'Connected to Flo KDS',
      timestamp: new Date().toISOString(),
    }));
  });

  activeWebSocketServers += 1;
  if (!heartbeat) {
    heartbeat = setInterval(() => {
      // The voided-item expiry marker is a global value, not per-client —
      // compute it once per tick instead of repeating the query for every
      // connected kitchen terminal.
      const sharedExpiredVoidMarker = getExpiredVoidMarker();
      clients.forEach((client, ws) => {
        if (isDatabaseMaintenanceActive()) {
          closeKdsClient(client, 'Database maintenance in progress');
          return;
        }
        if (!isKdsEnabled()) {
          closeKdsClient(client, 'KDS is disabled');
          return;
        }
        if (client.userId && !isKdsClientAuthorized(client)) {
          closeKdsClient(client, 'Session expired or revoked');
          return;
        }
        const expiredVoidMarker = client.userId ? sharedExpiredVoidMarker : null;
        let snapshotSent = false;
        const permissionRefreshNeeded = client.categoryIdsChanged || client.stationIdsChanged;
        const expiryRefreshNeeded = expiredVoidMarker !== null && expiredVoidMarker !== client.lastExpiredVoidMarker;
        if ((permissionRefreshNeeded || expiryRefreshNeeded) && ws.readyState === WebSocket.OPEN) {
          try {
            sendActiveOrders(ws, client.categoryIds, client.stationIds, client.role === 'chef' || client.categoryIds.length > 0 || client.stationIds.length > 0);
            client.categoryIdsChanged = false;
            client.stationIdsChanged = false;
            client.lastExpiredVoidMarker = expiredVoidMarker;
            snapshotSent = true;
          } catch (error) {
            console.error('[KDS] Category refresh error:', error);
            closeKdsClient(client, 'Could not refresh KDS permissions');
            return;
          }
        }
        if (ws.readyState === WebSocket.OPEN) {
          if (client.isAlive === false) {
            ws.terminate();
            clients.delete(ws);
            return;
          }
          if (client.userId && !snapshotSent) {
            client.lastExpiredVoidMarker = expiredVoidMarker;
          }
          client.isAlive = false;
          ws.ping();
        }
      });
    }, 30000);
    // The HTTP server owns the WebSocket server. Do not keep Electron/test
    // processes alive after that server has closed.
    heartbeat.unref();
  }
  wss.once('close', () => {
    activeWebSocketServers = Math.max(0, activeWebSocketServers - 1);
    if (activeWebSocketServers === 0 && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  });

  console.log('[KDS] WebSocket server setup complete');
}

function handleMessage(ws: WebSocket, message: any): void {
  const client = clients.get(ws);
  if (!client) return;
  if (isDatabaseMaintenanceActive()) {
    closeKdsClient(client, 'Database maintenance in progress');
    return;
  }

  if (!client.userId && message.type !== 'auth') {
    closeKdsClient(client, 'Authentication required');
    return;
  }

  switch (message.type) {
    case 'auth':
      handleAuth(ws, client, message);
      break;

    case 'status_update':
      handleStatusUpdate(client, message);
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      break;

    default:
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
  }
}

function handleAuth(ws: WebSocket, client: KdsClient, message: any): void {
  const { token } = message;

  if (!isKdsEnabled()) {
    closeKdsClient(client, 'KDS is disabled');
    return;
  }

  // JWT-only authentication — plaintext password auth removed for security
  if (!token || isTokenRevoked(token)) {
    closeKdsClient(client, 'Invalid or revoked token');
    return;
  }

  try {
    const decoded = jwt.verify(token, getJWTSecret()) as any;
    const db = getDatabase();
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(decoded.userId) as any;

    if (!user) {
      closeKdsClient(client, 'User not found');
      return;
    }

    if (isTokenStale(decoded.iat, user.tokens_valid_after)) {
      closeKdsClient(client, 'Invalid or revoked token');
      return;
    }

    if (!hasRole(user.role, ROLE_ACCESS.kitchen)) {
      closeKdsClient(client, 'Only kitchen staff can access KDS');
      return;
    }

    const categoryIds = hasRole(user.role, ROLE_ACCESS.ownerManager)
      ? []
      : parseCategoryIds(user.category_ids);
    const stationIds = getUserKdsStationIds(getDatabase(), user.id);
    const stationAssignmentsConfigured = hasUserKdsStationAssignments(getDatabase(), user.id);
    if (!stationIds || stationAssignmentsConfigured === null) throw new Error('Could not load station permissions');
    if (stationAssignmentsConfigured && stationIds.length === 0) {
      throw new Error('No active kitchen station is assigned to this user');
    }

    client.userId = user.id;
    client.userName = user.name;
    client.role = user.role;
    client.categoryIds = categoryIds;
    client.stationIds = stationIds;
    client.stationAssignmentsConfigured = stationAssignmentsConfigured;
    client.categoryIdsChanged = false;
    client.stationIdsChanged = false;
    client.stationCategoryIds = getKdsStationCategoryIds(getDatabase(), stationIds) || [];
    client.token = token;
    clearClientAuthTimeout(client);

    ws.send(JSON.stringify({
      type: 'auth_success',
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        categoryIds: categoryIds,
        stationIds: stationIds,
      },
    }));

    sendActiveOrders(ws, client.categoryIds, client.stationIds, client.role === 'chef' || client.categoryIds.length > 0 || client.stationIds.length > 0);
    client.lastExpiredVoidMarker = getExpiredVoidMarker();
  } catch (error) {
    const message = error instanceof Error && /station|permission/i.test(error.message)
      ? error.message
      : 'Invalid token';
    closeKdsClient(client, message);
  }
}

function handleStatusUpdate(client: KdsClient, message: any): void {
  if (!isKdsEnabled()) {
    closeKdsClient(client, 'KDS is disabled');
    return;
  }
  if (!isKdsClientAuthorized(client)) {
    closeKdsClient(client, 'Session expired or revoked');
    return;
  }

  const { order_item_id, status, expected_status: expectedStatus } = message;

  if (!order_item_id || !status) {
    client.ws.send(JSON.stringify({ type: 'error', message: 'order_item_id and status required' }));
    return;
  }

  // Validate status against allowed values
  const validStatuses = ['pending', 'preparing', 'ready', 'served'];
  if (!validStatuses.includes(status)) {
    client.ws.send(JSON.stringify({ type: 'error', message: `Invalid status. Use: ${validStatuses.join(', ')}` }));
    return;
  }
  if (expectedStatus !== undefined && !validStatuses.includes(expectedStatus)) {
    client.ws.send(JSON.stringify({ type: 'error', message: `Invalid expected status. Use: ${validStatuses.join(', ')}` }));
    return;
  }

  try {
    const db = getDatabase();

    const result = withTxn(() => {
      const existingItem = db.prepare(`
        SELECT oi.*, p.category_id
        FROM order_items oi
        JOIN products p ON oi.product_id = p.id
        WHERE oi.id = ?
      `).get(order_item_id) as any;

      if (!existingItem) {
        return { error: 'Item not found' };
      }

      if (existingItem.status === 'voided') {
        return { error: 'This item has been voided and can no longer be updated' };
      }
      if (existingItem.status === 'void_adjustment') {
        return { error: 'This bill adjustment cannot be updated from KDS' };
      }
      if (existingItem.status === 'completed' || existingItem.status === 'cancelled') {
        return { error: 'This terminal item cannot be updated from KDS' };
      }

      if (client.stationIds.length > 0) {
        const station = db.prepare(`
          SELECT t.kitchen_station_id
          FROM orders o LEFT JOIN tables t ON t.id = o.table_id
          WHERE o.id = ?
        `).get(existingItem.order_id) as { kitchen_station_id: string | null } | undefined;
        const stationCategoryIds = getKdsStationCategoryIds(db, client.stationIds);
        const stationScope = getKdsStationRoutingScope(db, client.stationIds, client.categoryIds);
        const stationRoutingCategoryIds = stationScope?.tablelessCategoryIds;
        if (!stationCategoryIds || !stationScope || !stationRoutingCategoryIds || !isKdsStationItemAllowed(client.stationIds, stationRoutingCategoryIds, station?.kitchen_station_id, existingItem.category_id, station?.kitchen_station_id ? stationScope.categoryIdsByStation[String(station?.kitchen_station_id)] : undefined, stationScope.hasUnrestrictedStation)) {
          return { error: 'Not authorized to update this station' };
        }
      }

      if (client.categoryIds.length > 0 && !client.categoryIds.includes(existingItem.category_id)) {
        return { error: 'Not authorized to update this item' };
      }

      const updateResult = expectedStatus === undefined
        ? db.prepare("UPDATE order_items SET status = ?, updated_at = ? WHERE id = ? AND status NOT IN ('voided', 'void_adjustment', 'completed', 'cancelled')").run(status, now(), order_item_id)
        : db.prepare('UPDATE order_items SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(status, now(), order_item_id, expectedStatus);
      if (updateResult.changes !== 1) {
        return { error: 'Item status changed; refresh and try again' };
      }

      return { success: true };
    });

    if (result.error) {
      client.ws.send(JSON.stringify({ type: 'error', message: result.error }));
      return;
    }

    broadcastOrderUpdate();

    client.ws.send(JSON.stringify({
      type: 'status_updated',
      order_item_id,
      status,
    }));
  } catch (error: any) {
    console.error('[KDS] Status update error:', error);
    client.ws.send(JSON.stringify({ type: 'error', message: 'Could not update item status' }));
  }
}

/**
 * An order can be marked 'completed' the moment its bill is fully paid
 * (see bills.ts), which for a prepaid order happens before the kitchen has
 * even started — payment and kitchen fulfillment are independent and can
 * finish in either order. So "still needs the kitchen's attention" isn't
 * just `status NOT IN ('completed','cancelled')`: a completed-by-payment
 * order still belongs on KDS as long as it has items the kitchen hasn't
 * served yet. Non-completed orders (pending/preparing/ready/served) are
 * always included, matching the original behavior for the normal flow.
 */
function activeOrdersCondition(): string {
  if (!isKdsEnabled()) return `o.status NOT IN ('completed', 'cancelled')`;
  // #208: replace the OR EXISTS scan with a CTE anchored on the status and
  // item-status indexes — keeps the active-orders payload fast as the
  // orders table grows past ~100k rows.
  return `o.id IN (
    SELECT id FROM orders WHERE status IN ('pending','preparing','ready','served')
    UNION
    SELECT o2.id FROM orders o2
    JOIN order_items oi2 ON oi2.order_id = o2.id AND oi2.status NOT IN ('served','cancelled')
    WHERE o2.status NOT IN ('pending','preparing','ready','served','cancelled')
  )`;
}

function sendActiveOrders(ws: WebSocket, categoryIds: string[], stationIds: string[] = [], restrictedPayload = categoryIds.length > 0): void {
  const db = getDatabase();
  const stationCategoryIds = getKdsStationCategoryIds(db, stationIds);
  const stationScope = getKdsStationRoutingScope(db, stationIds, categoryIds);
  const stationRoutingCategoryIds = stationScope?.tablelessCategoryIds;
  if (!stationCategoryIds || !stationScope || !stationRoutingCategoryIds) throw new Error('Could not load station permissions');

  let query = `
    SELECT o.*, t.number as table_name, t.kitchen_station_id
    FROM orders o
    LEFT JOIN tables t ON o.table_id = t.id
    WHERE ${activeOrdersCondition()}
  `;

  const orderParams: string[] = [];
  if (stationIds.length > 0) {
    const stationPlaceholders = stationIds.map(() => '?').join(',');
    const categoryRoute = stationRoutingCategoryIds.length > 0
      ? ` OR EXISTS (SELECT 1 FROM order_items routed_oi JOIN products routed_p ON routed_p.id = routed_oi.product_id WHERE routed_oi.order_id = o.id AND o.table_id IS NULL AND routed_p.category_id IN (${stationRoutingCategoryIds.map(() => '?').join(',')}))`
      : '';
    query += ` AND (t.kitchen_station_id IN (${stationPlaceholders})${categoryRoute}${stationScope.hasUnrestrictedStation ? ' OR o.table_id IS NULL' : ''})`;
    orderParams.push(...stationIds, ...stationRoutingCategoryIds);
  }
  query += ' ORDER BY o.created_at ASC';

  const orders = db.prepare(query).all(...orderParams);

  // Pre-fetch allowed product IDs once if category restrictions apply to eliminate N+1 queries
  let allowedProductIds: Set<string> | null = null;
  if (categoryIds.length > 0) {
    const productRows = db.prepare(`
      SELECT id FROM products WHERE category_id IN (${categoryIds.map(() => '?').join(',')})
    `).all(...categoryIds) as { id: string }[];
    allowedProductIds = new Set(productRows.map((p) => p.id));
  }

  // Filter and attach items — one batched items query and one addons pass
  // per broadcast instead of N+1 per order (this runs on every KDS update).
  const orderIds = (orders as any[]).map((o: any) => o.id);
  const itemsByOrder: Record<string, any[]> = {};
  if (orderIds.length > 0) {
    const placeholders = orderIds.map(() => '?').join(',');
    const rawItems = db.prepare(`
      SELECT oi.*, p.category_id
      FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id IN (${placeholders}) ORDER BY oi.order_id, oi.id
    `).all(...orderIds) as any[];
    for (const item of rawItems) {
      if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
      itemsByOrder[item.order_id].push(item);
    }
  }

  const allVisibleItems = (orders as any[])
    .flatMap((o: any) => itemsByOrder[o.id] || [])
    .filter((i: any) => i.status !== 'void_adjustment'
      && !['completed', 'cancelled'].includes(i.status)
      && (i.status !== 'voided' || isVoidedItemKdsVisible(i.voided_at))
      && isKdsStationItemAllowed(stationIds, stationRoutingCategoryIds, (orders as any[]).find((order) => order.id === i.order_id)?.kitchen_station_id, i.category_id, (orders as any[]).find((order) => order.id === i.order_id)?.kitchen_station_id ? stationScope.categoryIdsByStation[String((orders as any[]).find((order) => order.id === i.order_id)?.kitchen_station_id)] : undefined, stationScope.hasUnrestrictedStation));
  const itemsWithAddons = attachEffectiveAddons(db, allVisibleItems.map(parseItemJson) as any[]);
  const addonsByItemId = new Map(itemsWithAddons.map((it: any) => [it.id, it]));

  const ordersWithItems = orders.map((order: any) => {
    // #150: hide the void reversal line (bill adjustment, not a kitchen
    // item) and age voided items off the board after their grace period.
    const visibleItems = (itemsByOrder[order.id] || [])
      .filter((i: any) => i.status !== 'void_adjustment'
        && !['completed', 'cancelled'].includes(i.status)
        && (i.status !== 'voided' || isVoidedItemKdsVisible(i.voided_at))
        && isKdsStationItemAllowed(stationIds, stationRoutingCategoryIds, order.kitchen_station_id, i.category_id, order.kitchen_station_id ? stationScope.categoryIdsByStation[String(order.kitchen_station_id)] : undefined, stationScope.hasUnrestrictedStation))
      .map((i: any) => addonsByItemId.get(i.id) || i);

    // Filter items by category if user has category restrictions
    let items = visibleItems;
    if (allowedProductIds) {
      items = items.filter((item: any) => allowedProductIds!.has(item.product_id));
    }
    items = items.map((item: any) => projectKdsItem(item, restrictedPayload));

    // Normalize: frontend expects table.name, query aliases the join as table_name.
    const table = order.table_name ? { name: order.table_name } : null;
    return { ...projectKdsOrder(order, restrictedPayload), items, table };  }).filter((order: any) => order.items.length > 0);

  // Get counts (filtered by category)
  const voidedCutoff = new Date(Date.now() - KDS_VOIDED_ITEM_VISIBILITY_MS).toISOString().replace('T', ' ').replace(/\..*$/, '');
  let countsQuery = `
    SELECT oi.status, COUNT(*) as count
    FROM order_items oi
    LEFT JOIN products p ON oi.product_id = p.id
    JOIN orders o ON oi.order_id = o.id
    LEFT JOIN tables t ON o.table_id = t.id
    WHERE ${activeOrdersCondition()}
      AND oi.status NOT IN ('completed', 'cancelled', 'void_adjustment')
      AND (oi.status != 'voided' OR oi.voided_at IS NULL OR oi.voided_at > ?)
  `;
  const countParams: any[] = [voidedCutoff];

  if (stationIds.length > 0) {
    const stationRoutes: string[] = [];
    for (const stationId of stationIds) {
      const allowedCategoryIds = stationScope.categoryIdsByStation[String(stationId)];
      if (allowedCategoryIds === null) {
        stationRoutes.push('t.kitchen_station_id = ?');
        countParams.push(stationId);
      } else if (allowedCategoryIds.length > 0) {
        stationRoutes.push(`(t.kitchen_station_id = ? AND p.category_id IN (${allowedCategoryIds.map(() => '?').join(',')}))`);
        countParams.push(stationId, ...allowedCategoryIds);
      }
    }
    if (stationRoutingCategoryIds.length > 0) {
      stationRoutes.push(`(o.table_id IS NULL AND p.category_id IN (${stationRoutingCategoryIds.map(() => '?').join(',')}))`);
      countParams.push(...stationRoutingCategoryIds);
    }
    if (stationScope.hasUnrestrictedStation) stationRoutes.push('o.table_id IS NULL');
    countsQuery += ` AND (${stationRoutes.length > 0 ? stationRoutes.join(' OR ') : '0'})`;
  }
  if (categoryIds.length > 0) {
    countsQuery += ` AND p.category_id IN (${categoryIds.map(() => '?').join(',')})`;
    countParams.push(...categoryIds);
  }

  countsQuery += ' GROUP BY oi.status';

  const counts = db.prepare(countsQuery).all(...countParams) as { status: string; count: number }[];

  const countMap: Record<string, number> = {};
  counts.forEach((c) => { countMap[c.status] = c.count; });

  if (ws.bufferedAmount > 1_000_000) {
    ws.close(1013, 'KDS client is too slow');
    return;
  }
  ws.send(JSON.stringify({
    type: 'initial_data',
    orders: ordersWithItems,
    counts: countMap,
  }));
}

let broadcastQueued = false;

function broadcastOrderUpdate(): void {
  if (isDatabaseMaintenanceActive()) return;
  if (!isKdsEnabled()) {
    clients.forEach((client) => closeKdsClient(client, 'KDS is disabled'));
    return;
  }
  // The voided-item expiry marker is global, not per-client — compute it once
  // and share it across every client in this broadcast.
  const sharedExpiredVoidMarker = getExpiredVoidMarker();
  clients.forEach((client) => {
    if (!isKdsClientAuthorized(client)) {
      closeKdsClient(client, 'Session expired or revoked');
      return;
    }
    if (client.ws.readyState !== WebSocket.OPEN) return;
    try {
      sendActiveOrders(client.ws, client.categoryIds, client.stationIds, client.role === 'chef' || client.categoryIds.length > 0 || client.stationIds.length > 0);
      client.categoryIdsChanged = false;
      client.stationIdsChanged = false;
      client.lastExpiredVoidMarker = sharedExpiredVoidMarker;
    } catch (err) {
      console.error('[KDS] Broadcast error for client:', err);
    }
  });
}

export function notifyKdsUpdate(): void {
  if (broadcastQueued) return;
  broadcastQueued = true;
  queueMicrotask(() => {
    broadcastQueued = false;
    broadcastOrderUpdate();
  });
}

export function notifyOrderUpdated(): void {
  notifyKdsUpdate();
}

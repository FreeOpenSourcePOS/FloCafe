import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDatabase, now } from '../db';
import {
  CUSTOMER_DISPLAY_KEY,
  readStoredCustomerDisplayConfig,
  type CustomerDisplayConfig,
} from './customer-display-config';

const TOKEN_PREFIX = 'cdt_';
const MAX_LABEL_LENGTH = 60;
const MAX_ACTIVE_TOKENS = 20;
const FEED_ORDER_LIMIT = 100;
const LAST_SEEN_THROTTLE_MS = 60_000;

export interface CustomerDisplayTokenSummary {
  id: string;
  label: string;
  created_at: string;
  last_seen_at: string | null;
}

export interface CustomerDisplayFeed {
  business_name: string;
  config: CustomerDisplayConfig;
  orders: Array<{ id: number; number: string; status: string }>;
  /** Pass as `cursor` to read the next older page; null when the queue is exhausted. */
  next_cursor: string | null;
}

interface FeedCursor {
  createdAt: string;
  id: number;
}

function encodeFeedCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString('base64url');
}

/** Returns null for anything that is not a cursor this service issued. */
export function decodeFeedCursor(value: unknown): FeedCursor | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, id] = parsed;
    if (typeof createdAt !== 'string' || createdAt.length === 0 || createdAt.length > 40)
      return null;
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

const lastSeenWrites = new Map<string, number>();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function normalizeTokenLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  return label.length > 0 && label.length <= MAX_LABEL_LENGTH ? label : null;
}

export function activeTokenCount(): number {
  const row = getDatabase()
    .prepare('SELECT COUNT(*) AS n FROM customer_display_tokens WHERE revoked_at IS NULL')
    .get() as { n: number };
  return row.n;
}

export function hasReachedTokenLimit(): boolean {
  return activeTokenCount() >= MAX_ACTIVE_TOKENS;
}

/** Creates a token and returns the plaintext once; only its hash is stored. */
export function createDisplayToken(label: string, createdBy: string | null) {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  const id = randomUUID();
  const createdAt = now();
  getDatabase()
    .prepare(
      `INSERT INTO customer_display_tokens (id, token_hash, label, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, hashToken(token), label, createdBy, createdAt);
  return { id, label, created_at: createdAt, last_seen_at: null, token };
}

export function listDisplayTokens(): CustomerDisplayTokenSummary[] {
  return getDatabase()
    .prepare(
      `SELECT id, label, created_at, last_seen_at FROM customer_display_tokens
       WHERE revoked_at IS NULL ORDER BY created_at DESC`,
    )
    .all() as CustomerDisplayTokenSummary[];
}

/** Returns true when an active token was revoked. */
export function revokeDisplayToken(id: string): boolean {
  lastSeenWrites.delete(id);
  const result = getDatabase()
    .prepare(
      'UPDATE customer_display_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    )
    .run(now(), id);
  return result.changes > 0;
}

/** Resolves a presented token to its id, or null when unknown or revoked. */
export function verifyDisplayToken(token: string): string | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = getDatabase()
    .prepare('SELECT id FROM customer_display_tokens WHERE token_hash = ? AND revoked_at IS NULL')
    .get(hashToken(token)) as { id: string } | undefined;
  return row?.id ?? null;
}

export function touchDisplayToken(id: string): void {
  const nowMs = Date.now();
  const last = lastSeenWrites.get(id) ?? 0;
  if (nowMs - last < LAST_SEEN_THROTTLE_MS) return;
  lastSeenWrites.set(id, nowMs);
  getDatabase()
    .prepare('UPDATE customer_display_tokens SET last_seen_at = ? WHERE id = ?')
    .run(now(), id);
}

/** Sanitized board data: order numbers and statuses only, never customer or staff fields. */
export function buildDisplayFeed(cursor: FeedCursor | null = null): CustomerDisplayFeed {
  const db = getDatabase();
  const settings = Object.fromEntries(
    (
      db
        .prepare('SELECT key, value FROM settings WHERE key IN (?, ?)')
        .all('business_name', CUSTOMER_DISPLAY_KEY) as Array<{ key: string; value: string }>
    ).map((row) => [row.key, row.value]),
  );
  const config = readStoredCustomerDisplayConfig(settings[CUSTOMER_DISPLAY_KEY]);
  const placeholders = config.statuses.map(() => '?').join(', ');
  const cursorClause = cursor ? 'AND (o.created_at < ? OR (o.created_at = ? AND o.id < ?))' : '';
  const cursorParams = cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : [];
  // One extra row tells whether an older page exists without a second query.
  const rows = db
    .prepare(
      `SELECT o.id AS id,
              COALESCE((SELECT b.bill_number FROM bills b WHERE b.order_id = o.id ORDER BY b.id DESC LIMIT 1), o.order_number) AS number,
              o.status AS status,
              o.created_at AS created_at
       FROM orders o
       WHERE o.status IN (${placeholders}) ${cursorClause}
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT ${FEED_ORDER_LIMIT + 1}`,
    )
    .all(...config.statuses, ...cursorParams) as Array<{
    id: number;
    number: string;
    status: string;
    created_at: string;
  }>;
  const hasMore = rows.length > FEED_ORDER_LIMIT;
  const page = hasMore ? rows.slice(0, FEED_ORDER_LIMIT) : rows;
  const oldest = page[page.length - 1];
  const orders = page.map(({ id, number, status }) => ({ id, number, status })).reverse();
  return {
    business_name: settings.business_name || '',
    config,
    orders,
    next_cursor:
      hasMore && oldest ? encodeFeedCursor({ createdAt: oldest.created_at, id: oldest.id }) : null,
  };
}

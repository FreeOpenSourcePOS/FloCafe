/**
 * Per-request SQL timing. Statements reached through the instrumented handle add their time to
 * the store of the request that runs them; outside a request the wrappers only call through.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { Database, Statement } from 'better-sqlite3';

export interface RequestDbStats {
  queries: number;
  dbMs: number;
  slowestMs: number;
  slowestSql: string;
}

const storage = new AsyncLocalStorage<RequestDbStats>();
const TIME_MEASURED_METHODS = new Set(['run', 'get', 'all']);
const instrumented = new WeakSet<object>();

/** The stats of the request this code runs in, if it runs in one. */
export function getRequestStats(): RequestDbStats | undefined {
  return storage.getStore();
}

export function runWithRequestStats<T>(fn: () => T): T {
  return storage.run({ queries: 0, dbMs: 0, slowestMs: 0, slowestSql: '' }, fn);
}

function record(sql: string, ms: number): void {
  const stats = storage.getStore();
  if (!stats) return;
  stats.queries += 1;
  stats.dbMs += ms;
  if (ms > stats.slowestMs) {
    stats.slowestMs = ms;
    stats.slowestSql = sql;
  }
}

function callTimed(sql: string, call: () => unknown): unknown {
  if (!storage.getStore()) return call();
  const start = performance.now();
  try {
    return call();
  } finally {
    record(sql, performance.now() - start);
  }
}

const normalizedSql = new Map<string, string>();

/** Collapses white space and hides literals and comments, so the text can leave the machine. */
export function normalizeSql(sql: string): string {
  const cached = normalizedSql.get(sql);
  if (cached !== undefined) return cached;
  const text = sql
    // Comments first: a literal can hold `--`, and a comment can hold anything.
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/"(?:[^"]|"")*"/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  // Statements come from code, so this stays small; built-up SQL must not grow it without bound.
  if (normalizedSql.size >= 500) normalizedSql.clear();
  normalizedSql.set(sql, text);
  return text;
}

function wrapStatement(statement: Statement, sql: string): Statement {
  const wrapped: Statement = new Proxy(statement, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const name = String(prop);
      return (...args: unknown[]) => {
        // `iterate` counts the call only: iterating lazily would time the caller's loop.
        if (name === 'iterate') {
          record(sql, 0);
          return value.apply(target, args);
        }
        if (TIME_MEASURED_METHODS.has(name)) return callTimed(sql, () => value.apply(target, args));
        // `pluck`, `raw`, `expand`, `bind`, `safeIntegers` return the statement itself.
        const result = value.apply(target, args);
        return result === target ? wrapped : result;
      };
    },
  });
  return wrapped;
}

/** Below this much SQL time a slow request is reported locally only, not sent. */
export const SLOW_SQL_MS = 200;

/** One route sends at most one slow-request event per window. */
export const SLOW_REQUEST_EVENT_WINDOW_MS = 60 * 60_000;

export interface SlowRequestRouteState {
  lastSentAt: number;
  suppressed: number;
}

/**
 * Decides whether a slow request becomes one event: SQL must be the slow part, and the same route
 * sends once per window, with the requests folded into that event counted as `occurrences`.
 */
export function slowRequestEventGate(
  state: Map<string, SlowRequestRouteState>,
  routeKey: string,
  dbMs: number,
  nowMs: number,
): { send: boolean; occurrences: number } {
  if (dbMs < SLOW_SQL_MS) return { send: false, occurrences: 0 };
  const last = state.get(routeKey);
  if (last && nowMs - last.lastSentAt < SLOW_REQUEST_EVENT_WINDOW_MS) {
    last.suppressed += 1;
    return { send: false, occurrences: 0 };
  }
  state.set(routeKey, { lastSentAt: nowMs, suppressed: 0 });
  return { send: true, occurrences: 1 + (last?.suppressed ?? 0) };
}

/** Times every statement this handle prepares or executes. Safe to call more than once. */
export function instrumentDatabase(db: Database): void {
  if (instrumented.has(db)) return;
  instrumented.add(db);

  // Looked up per call, so a later patch of the prototype still applies.
  const proto = Object.getPrototypeOf(db) as Database;
  db.prepare = ((source: string) => {
    const statement = proto.prepare.call(db, source);
    const sql = normalizeSql(source);
    return wrapStatement(statement, sql);
  }) as unknown as Database['prepare'];

  db.exec = ((source: string) =>
    callTimed(normalizeSql(source), () =>
      proto.exec.call(db, source),
    )) as unknown as Database['exec'];
}

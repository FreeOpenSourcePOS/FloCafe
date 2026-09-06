import Database from 'better-sqlite3';
import { getDatabase, buildIdealSchemaDb, getTables, isSafeIdentifier } from '../db';

export interface ColumnDef {
  name: string;
  type: string;
  notnull: boolean;
  dfltValue: string | null;
  pk: boolean;
}

export interface IndexDef {
  name: string;
  unique: boolean;
  columns: string[];
  createSql: string | null;
}

export interface ForeignKeyDef {
  table: string;
  from: string;
  to: string;
  onDelete: string;
  onUpdate: string;
}

export interface TableSchema {
  name: string;
  createSql: string | null;
  columns: ColumnDef[];
  indexes: IndexDef[];
  foreignKeys: ForeignKeyDef[];
}

export interface DbSchemaSnapshot {
  tables: Record<string, TableSchema>;
  schemaVersion: number;
}

export type FindingKind =
  | 'missing_table' | 'missing_column' | 'missing_index'
  | 'extra_table' | 'extra_column' | 'extra_index'
  | 'column_type_mismatch' | 'column_notnull_mismatch' | 'column_default_mismatch'
  | 'foreign_key_mismatch';

export interface HealthFinding {
  id: string;
  table: string;
  column?: string;
  index?: string;
  kind: FindingKind;
  risk: 'safe' | 'manual_review';
  autoApplicable: boolean;
  description: string;
  suggestedDdl?: string;
  currentState?: string;
  idealState?: string;
}

export interface HealthCheckReport {
  generatedAt: string;
  liveSchemaVersion: number;
  idealSchemaVersion: number;
  findings: HealthFinding[];
  summary: { safeCount: number; manualReviewCount: number };
}

function snapshotSchema(dbInstance: Database.Database): DbSchemaSnapshot {
  const tables: Record<string, TableSchema> = {};

  for (const name of getTables(dbInstance)) {
    // SQLite metadata can contain arbitrary object names in a damaged or
    // user-supplied database. Never interpolate an unsafe name into PRAGMA.
    if (!isSafeIdentifier(name)) continue;
    const createRow = dbInstance.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`
    ).get(name) as { sql: string | null } | undefined;

    const columns: ColumnDef[] = (dbInstance.prepare(`PRAGMA table_info(${name})`).all() as any[]).map((c) => ({
      name: c.name,
      type: String(c.type || '').toUpperCase(),
      notnull: !!c.notnull,
      dfltValue: c.dflt_value ?? null,
      pk: !!c.pk,
    }));

    const indexList = dbInstance.prepare(`PRAGMA index_list(${name})`).all() as any[];
    const indexes: IndexDef[] = indexList
      // sqlite_autoindex_* are implicit indexes backing PRIMARY KEY/UNIQUE column
      // constraints already captured by ColumnDef.pk — skip to avoid double-reporting.
      .filter((i) => !String(i.name).startsWith('sqlite_autoindex_'))
      .filter((i) => isSafeIdentifier(String(i.name)))
      .map((i) => {
        const cols = (dbInstance.prepare(`PRAGMA index_info(${i.name})`).all() as any[]).map((c) => c.name);
        const sqlRow = dbInstance.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name = ?`).get(i.name) as { sql: string | null } | undefined;
        return { name: i.name, unique: !!i.unique, columns: cols, createSql: sqlRow?.sql ?? null };
      });

    const foreignKeys: ForeignKeyDef[] = (dbInstance.prepare(`PRAGMA foreign_key_list(${name})`).all() as any[]).map((fk) => ({
      table: fk.table,
      from: fk.from,
      to: fk.to,
      onDelete: fk.on_delete,
      onUpdate: fk.on_update,
    }));

    tables[name] = { name, createSql: createRow?.sql ?? null, columns, indexes, foreignKeys };
  }

  return { tables, schemaVersion: dbInstance.pragma('user_version', { simple: true }) as number };
}

function normalizeType(type: string): string {
  return type.trim().toUpperCase().replace(/\(\d+(,\s*\d+)?\)/, '');
}

function normalizeCreateIfNotExists(sql: string): string {
  if (/\bIF\s+NOT\s+EXISTS\b/i.test(sql)) return sql;
  return sql.replace(/^\s*CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+/i, (m, unique = '') => `CREATE ${unique}${m.trim().split(/\s+/).pop()} IF NOT EXISTS `);
}

function sameColumnList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

function fkSignature(fk: ForeignKeyDef): string {
  // Include referential actions so differences in ON DELETE/UPDATE cascade behavior are reported.
  return `${fk.from}->${fk.table}.${fk.to}:${fk.onDelete}:${fk.onUpdate}`;
}

function sameForeignKeys(a: ForeignKeyDef[], b: ForeignKeyDef[]): boolean {
  const sigA = a.map(fkSignature).sort();
  const sigB = b.map(fkSignature).sort();
  return sigA.length === sigB.length && sigA.every((s, i) => s === sigB[i]);
}

function mismatchFinding(
  table: string, column: string, kind: FindingKind, description: string,
  currentState: string, idealState: string,
): HealthFinding {
  return {
    id: `${kind}:${table}.${column}`,
    table,
    column,
    kind,
    risk: 'manual_review',
    autoApplicable: false,
    description,
    currentState,
    idealState,
  };
}

function diffSchemas(live: DbSchemaSnapshot, ideal: DbSchemaSnapshot): HealthFinding[] {
  const findings: HealthFinding[] = [];

  for (const tableName of Object.keys(ideal.tables)) {
    const idealTable = ideal.tables[tableName];
    const liveTable = live.tables[tableName];

    if (!liveTable) {
      findings.push({
        id: `missing_table:${tableName}`,
        table: tableName,
        kind: 'missing_table',
        risk: 'safe',
        autoApplicable: !!idealTable.createSql,
        description: `Table "${tableName}" is missing.`,
        suggestedDdl: idealTable.createSql ? normalizeCreateIfNotExists(idealTable.createSql) : undefined,
        idealState: idealTable.createSql ?? undefined,
      });
      continue;
    }

    for (const idealCol of idealTable.columns) {
      const liveCol = liveTable.columns.find((c) => c.name === idealCol.name);

      if (!liveCol) {
        const canAutoAdd = !idealCol.notnull || idealCol.dfltValue !== null;
        findings.push({
          id: `missing_column:${tableName}.${idealCol.name}`,
          table: tableName,
          column: idealCol.name,
          kind: 'missing_column',
          risk: canAutoAdd ? 'safe' : 'manual_review',
          autoApplicable: canAutoAdd,
          description: canAutoAdd
            ? `Column "${idealCol.name}" is missing from "${tableName}".`
            : `Column "${idealCol.name}" is missing from "${tableName}" and is NOT NULL with no default — cannot be added automatically on a non-empty table.`,
          suggestedDdl: canAutoAdd
            ? `ALTER TABLE ${tableName} ADD COLUMN ${idealCol.name} ${idealCol.type}${idealCol.dfltValue !== null ? ` DEFAULT ${idealCol.dfltValue}` : ''}`
            : undefined,
          idealState: `${idealCol.type}${idealCol.notnull ? ' NOT NULL' : ''}${idealCol.dfltValue !== null ? ` DEFAULT ${idealCol.dfltValue}` : ''}`,
        });
        continue;
      }

      if (normalizeType(liveCol.type) !== normalizeType(idealCol.type)) {
        findings.push(mismatchFinding(tableName, idealCol.name, 'column_type_mismatch',
          `Column "${idealCol.name}" type differs from the expected schema.`, liveCol.type || '(none)', idealCol.type || '(none)'));
      }
      if (liveCol.notnull !== idealCol.notnull) {
        findings.push(mismatchFinding(tableName, idealCol.name, 'column_notnull_mismatch',
          `Column "${idealCol.name}" NOT NULL constraint differs from the expected schema.`,
          liveCol.notnull ? 'NOT NULL' : 'nullable', idealCol.notnull ? 'NOT NULL' : 'nullable'));
      }
      if ((liveCol.dfltValue ?? null) !== (idealCol.dfltValue ?? null)) {
        findings.push(mismatchFinding(tableName, idealCol.name, 'column_default_mismatch',
          `Column "${idealCol.name}" default value differs from the expected schema.`,
          liveCol.dfltValue ?? 'none', idealCol.dfltValue ?? 'none'));
      }
    }

    for (const liveCol of liveTable.columns) {
      if (!idealTable.columns.some((c) => c.name === liveCol.name)) {
        findings.push({
          id: `extra_column:${tableName}.${liveCol.name}`,
          table: tableName,
          column: liveCol.name,
          kind: 'extra_column',
          risk: 'manual_review',
          autoApplicable: false,
          description: `Column "${liveCol.name}" on "${tableName}" isn't part of the expected schema — may be legitimate custom data or a leftover from a partial migration. Will not be removed automatically; review before deciding.`,
          currentState: liveCol.type,
        });
      }
    }

    for (const idealIdx of idealTable.indexes) {
      const hasEquivalent = liveTable.indexes.some((i) => sameColumnList(i.columns, idealIdx.columns) && i.unique === idealIdx.unique);
      if (!hasEquivalent) {
        findings.push({
          id: `missing_index:${tableName}.${idealIdx.name}`,
          table: tableName,
          index: idealIdx.name,
          kind: 'missing_index',
          risk: 'safe',
          autoApplicable: !!idealIdx.createSql,
          description: `Index "${idealIdx.name}" (${idealIdx.columns.join(', ')}) is missing on "${tableName}".`,
          suggestedDdl: idealIdx.createSql ? normalizeCreateIfNotExists(idealIdx.createSql) : undefined,
        });
      }
    }

    for (const liveIdx of liveTable.indexes) {
      const hasEquivalent = idealTable.indexes.some((i) => sameColumnList(i.columns, liveIdx.columns) && i.unique === liveIdx.unique);
      if (!hasEquivalent) {
        findings.push({
          id: `extra_index:${tableName}.${liveIdx.name}`,
          table: tableName,
          index: liveIdx.name,
          kind: 'extra_index',
          risk: 'manual_review',
          autoApplicable: false,
          description: `Index "${liveIdx.name}" on "${tableName}" isn't part of the expected schema. Will not be removed automatically; review before deciding.`,
        });
      }
    }

    if (!sameForeignKeys(liveTable.foreignKeys, idealTable.foreignKeys)) {
      findings.push({
        id: `foreign_key_mismatch:${tableName}`,
        table: tableName,
        kind: 'foreign_key_mismatch',
        risk: 'manual_review',
        autoApplicable: false,
        description: `Foreign keys on "${tableName}" differ from the expected schema. SQLite can't add or alter constraints on an existing table without a full rebuild — review manually.`,
        currentState: liveTable.foreignKeys.map((f) => `${f.from} → ${f.table}.${f.to} (ON DELETE ${f.onDelete}, ON UPDATE ${f.onUpdate})`).join(', ') || 'none',
        idealState: idealTable.foreignKeys.map((f) => `${f.from} → ${f.table}.${f.to} (ON DELETE ${f.onDelete}, ON UPDATE ${f.onUpdate})`).join(', ') || 'none',
      });
    }
  }

  for (const tableName of Object.keys(live.tables)) {
    if (!ideal.tables[tableName]) {
      findings.push({
        id: `extra_table:${tableName}`,
        table: tableName,
        kind: 'extra_table',
        risk: 'manual_review',
        autoApplicable: false,
        description: `Table "${tableName}" isn't part of the expected schema — may be legitimate custom data or leftover from a removed feature. Will not be removed automatically; review before deciding.`,
      });
    }
  }

  return findings;
}

export function runHealthCheck(): HealthCheckReport {
  const liveDb = getDatabase();
  const idealDb = buildIdealSchemaDb();
  try {
    const live = snapshotSchema(liveDb);
    const ideal = snapshotSchema(idealDb);
    const findings = diffSchemas(live, ideal);
    return {
      generatedAt: new Date().toISOString(),
      liveSchemaVersion: live.schemaVersion,
      idealSchemaVersion: ideal.schemaVersion,
      findings,
      summary: {
        safeCount: findings.filter((f) => f.risk === 'safe').length,
        manualReviewCount: findings.filter((f) => f.risk === 'manual_review').length,
      },
    };
  } finally {
    idealDb.close();
  }
}

export interface ApplySafeFixesResult {
  applied: string[];
  skipped: string[];
  errors: { id: string; error: string }[];
}

/** Re-derives report before applying fixes so clients cannot inject arbitrary SQL. */
export function applySafeFixes(findingIds?: string[]): ApplySafeFixesResult {
  const report = runHealthCheck();
  const db = getDatabase();
  const result: ApplySafeFixesResult = { applied: [], skipped: [], errors: [] };

  const targets = report.findings.filter((f) =>
    f.autoApplicable && f.risk === 'safe' && (!findingIds || findingIds.includes(f.id))
  );

  if (targets.length === 0) return result;

  // Run batch inside a transaction so failed DDL rolls back cleanly.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const finding of targets) {
      const identifiersSafe = isSafeIdentifier(finding.table)
        && (!finding.column || isSafeIdentifier(finding.column))
        && (!finding.index || isSafeIdentifier(finding.index));

      if (!identifiersSafe || !finding.suggestedDdl) {
        result.skipped.push(finding.id);
        continue;
      }

      try {
        db.exec(finding.suggestedDdl);
        result.applied.push(finding.id);
      } catch (error: any) {
        result.errors.push({ id: finding.id, error: error.message });
      }
    }

    if (result.errors.length > 0) {
      db.exec('ROLLBACK');
      result.applied = [];
    } else {
      db.exec('COMMIT');
    }
  } catch (error: any) {
    try { db.exec('ROLLBACK'); } catch { }
    result.applied = [];
    result.errors.push({ id: 'transaction', error: error.message });
  }

  return result;
}

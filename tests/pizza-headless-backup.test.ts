/**
 * Pizza fork, headless kit: the backup script takes a consistent online copy of the live database
 * while the server runs and writes, the copy passes the app's own health predicate, and retention
 * keeps the newest N copies.
 *
 * Usage: npm run test:pizza-headless-backup
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
const { assertEqualOrThrow, assertOrThrow } = require('./helpers/test-setup');
import {
  appDb,
  backupDir,
  headlessEnv,
  liveDbPath,
  runCases,
  runKit,
  startHeadless,
} from './helpers/headless';

const insertCategory = (db: Database.Database, id: string) =>
  db
    .prepare(
      "INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
    )
    .run(id, id);

const modeOf = (file: string) => (fs.statSync(file).mode & 0o777).toString(8);

void runCases('Pizza headless kit: online backup and retention', [
  [
    'a backup taken while the server runs and writes is healthy and holds the last row',
    async () => {
      const env = await headlessEnv({ BACKUP_KEEP: '2' });
      const server = await startHeadless(env);
      const live = new Database(liveDbPath(env), { timeout: 5000 });
      try {
        assertEqualOrThrow(
          live.pragma('journal_mode', { simple: true }),
          'wal',
          'the live database is in WAL mode',
        );
        insertCategory(live, 'cat-before-backup');

        let writing = true;
        let writesDuringBackup = 0;
        const writer = (async () => {
          while (writing) {
            insertCategory(live, `cat-during-${writesDuringBackup++}`);
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        })();
        const result = await runKit('backup.cjs', [], env);
        writing = false;
        await writer;
        console.log(result.output);
        assertEqualOrThrow(result.status, 0, 'backup exits 0');
        assertOrThrow(
          writesDuringBackup > 0,
          `rows were written during the backup (${writesDuringBackup})`,
        );

        const copyPath = result.stdout.trim().split('\n').pop()!;
        assertOrThrow(
          path.dirname(copyPath) === backupDir(env) && fs.existsSync(copyPath),
          `backup file exists in the backup folder: ${copyPath}`,
        );
        assertEqualOrThrow(modeOf(backupDir(env)), '700', 'the backup folder is owner-only');
        assertEqualOrThrow(modeOf(copyPath), '600', 'the backup file is owner-only');
        assertOrThrow(
          appDb().isHealthyDatabaseFile(copyPath),
          'the copy passes the app health predicate',
        );
        const copy = new Database(copyPath, { readonly: true });
        try {
          const row = copy
            .prepare("SELECT id FROM categories WHERE id = 'cat-before-backup'")
            .get();
          assertOrThrow(Boolean(row), 'the copy holds the row written just before the backup');
          assertEqualOrThrow(
            copy.pragma('journal_mode', { simple: true }),
            'delete',
            'the copy is a single self-contained file',
          );
        } finally {
          copy.close();
        }
      } finally {
        live.close();
        await server.stop();
      }
    },
  ],
  [
    'retention keeps the newest N copies',
    async () => {
      const env = await headlessEnv({ BACKUP_KEEP: '2' });
      const server = await startHeadless(env);
      try {
        const made: string[] = [];
        for (let i = 0; i < 4; i++) {
          const result = await runKit('backup.cjs', [], env);
          assertEqualOrThrow(result.status, 0, `backup ${i + 1} exits 0`);
          made.push(result.stdout.trim().split('\n').pop()!);
        }
        const kept = fs.readdirSync(backupDir(env)).sort();
        console.log(`  kept: ${kept.join(', ')}`);
        assertEqualOrThrow(
          JSON.stringify(kept),
          JSON.stringify(made.slice(-2).map((file) => path.basename(file))),
          'only the two newest backups remain, and nothing else',
        );
      } finally {
        await server.stop();
      }
    },
  ],
  [
    "retention counts only the kit's own backups, and a stale partial file is removed",
    async () => {
      const env = await headlessEnv({ BACKUP_KEEP: '2' });
      const dir = backupDir(env);
      fs.mkdirSync(dir);
      const spared = [
        'pre-restore-2020-01-01T00-00-00-000Z.db',
        'pizza-pos-before-upgrade.db',
        'notes.partial',
      ];
      for (const name of spared) fs.writeFileSync(path.join(dir, name), 'kept by the operator');
      const stalePartial = '.pizza-pos-2020-01-01T00-00-00-000Z.db.partial';
      fs.writeFileSync(path.join(dir, stalePartial), 'left by an interrupted run');

      const server = await startHeadless(env);
      try {
        const made: string[] = [];
        for (let i = 0; i < 3; i++) {
          const result = await runKit('backup.cjs', [], env);
          assertEqualOrThrow(result.status, 0, `backup ${i + 1} exits 0: ${result.output}`);
          made.push(path.basename(result.stdout.trim().split('\n').pop()!));
        }
        const kept = fs.readdirSync(dir).sort();
        console.log(`  kept: ${kept.join(', ')}`);
        assertEqualOrThrow(modeOf(dir), '700', 'a folder from an earlier version is closed');
        assertEqualOrThrow(
          JSON.stringify(kept),
          JSON.stringify([...spared, ...made.slice(-2)].sort()),
          'the two newest backups and every file the kit did not write remain',
        );
      } finally {
        await server.stop();
      }
    },
  ],
  [
    'a backup of a database with fixable schema drift passes the health predicate',
    async () => {
      const env = await headlessEnv({ BACKUP_KEEP: '2' });
      const server = await startHeadless(env);
      try {
        const live = new Database(liveDbPath(env), { timeout: 5000 });
        let dropped: string;
        try {
          dropped = (
            live
              .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name LIMIT 1",
              )
              .get() as { name: string }
          ).name;
          live.exec(`DROP INDEX ${dropped}`);
        } finally {
          live.close();
        }
        console.log(`  dropped index ${dropped} from the live database`);
        const result = await runKit('backup.cjs', [], env);
        console.log(
          result.output
            .split('\n')
            .filter((line) => !line.startsWith('[MIGRATION'))
            .join('\n'),
        );
        assertEqualOrThrow(result.status, 0, 'backup exits 0');
        const copyPath = result.stdout.trim().split('\n').pop()!;
        assertOrThrow(
          appDb().isHealthyDatabaseFile(copyPath),
          'the copy passes the app health predicate',
        );
        const copy = new Database(copyPath, { readonly: true });
        try {
          assertOrThrow(
            Boolean(
              copy
                .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
                .get(dropped),
            ),
            'the copy has the missing index back',
          );
        } finally {
          copy.close();
        }
      } finally {
        await server.stop();
      }
    },
  ],
  [
    'a backup without BACKUP_KEEP fails and writes nothing',
    async () => {
      const env = await headlessEnv();
      const server = await startHeadless(env);
      try {
        const result = await runKit('backup.cjs', [], env);
        console.log(result.output);
        assertOrThrow(result.status !== 0, 'backup exits non-zero');
        assertOrThrow(result.stderr.includes('BACKUP_KEEP'), 'the error names BACKUP_KEEP');
        assertOrThrow(!fs.existsSync(backupDir(env)), 'no backup folder was created');
      } finally {
        await server.stop();
      }
    },
  ],
]);

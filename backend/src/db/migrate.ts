import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getPool, closePool, query } from './connection.js';

/**
 * Migration runner, patterned on edi-360-tracking's.
 *
 * Applies every file in migrations/ in filename order and records each in
 * wk_schema_migrations. The ledger is deliberately NOT named schema_migrations:
 * this product may share a database with edi-360-tracking, and a shared ledger
 * would make each app believe the other's migrations were its own.
 *
 * Each migration (and its ledger row) runs in one transaction, so a failure
 * rolls back that migration alone and leaves the database on the last complete
 * one.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

interface Migration {
  filename: string;
  sql: string;
  checksum: string;
}

// Line endings normalised so a Windows (CRLF) and Linux (LF) checkout hash alike
function checksum(sql: string): string {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

function loadMigrations(): Migration[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf-8');
      return { filename, sql, checksum: checksum(sql) };
    });
}

async function ensureLedger(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS wk_schema_migrations (
      filename   TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getApplied(): Promise<Map<string, { checksum: string; applied_at: Date }>> {
  await ensureLedger();
  const result = await query(`SELECT filename, checksum, applied_at FROM wk_schema_migrations`);
  return new Map(result.rows.map((r: any) => [r.filename, r]));
}

async function applyMigration(m: Migration): Promise<void> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(m.sql);
    await client.query(
      `INSERT INTO wk_schema_migrations (filename, checksum) VALUES ($1, $2)
       ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = NOW()`,
      [m.filename, m.checksum]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const statusOnly = process.argv.includes('--status');
  const all = loadMigrations();
  const applied = await getApplied();
  const pending = all.filter((m) => !applied.has(m.filename));

  const edited = all.filter((m) => applied.has(m.filename) && applied.get(m.filename)!.checksum !== m.checksum);
  if (edited.length > 0) {
    console.warn(`\n! ${edited.length} applied migration(s) were edited since they ran:`);
    edited.forEach((m) => console.warn(`    ${m.filename}`));
    console.warn('  The database does not reflect these edits. Add a new migration instead.\n');
  }

  if (statusOnly) {
    for (const m of all) console.log(`${applied.has(m.filename) ? '  applied ' : '  pending '} ${m.filename}`);
    console.log(`\n${all.length - pending.length} applied, ${pending.length} pending\n`);
    return;
  }

  if (pending.length === 0) {
    console.log(`\nDatabase is up to date (${all.length} migration(s) applied).\n`);
    return;
  }

  console.log(`\nApplying ${pending.length} migration(s):\n`);
  for (const m of pending) {
    const started = Date.now();
    try {
      await applyMigration(m);
      console.log(`  ok  ${m.filename}  (${Date.now() - started}ms)`);
    } catch (error) {
      console.error(`  FAILED  ${m.filename}\n\n    ${(error as Error).message}\n`);
      console.error('Rolled back. Fix the file and re-run.\n');
      throw error;
    }
  }
  console.log(`\nApplied ${pending.length} migration(s).\n`);
}

main()
  .catch((error) => {
    console.error('Migration failed:', (error as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });

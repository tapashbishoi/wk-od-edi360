import pkg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pkg;

// A DATE is a calendar day, not a moment. The driver turns it into a JS Date at local midnight,
// which serialises as a timestamp that lands on the previous or next day for viewers in other time
// zones (a PO dated 19 Feb became "2026-02-19T08:00:00Z"). Keep it as the 'YYYY-MM-DD' text it is.
pkg.types.setTypeParser(1082, (value: string) => value);

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_SIZE,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err: Error) => {
  console.error('Unexpected error on idle client', err);
});

export async function query<T = any>(
  text: string,
  params?: any[]
): Promise<{ rows: T[]; rowCount: number }> {
  const result = await pool.query(text, params);
  return { rows: result.rows, rowCount: result.rowCount || 0 };
}

export async function queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] || null;
}

export async function transaction<T>(callback: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getPool() {
  return pool;
}

export async function closePool() {
  await pool.end();
}

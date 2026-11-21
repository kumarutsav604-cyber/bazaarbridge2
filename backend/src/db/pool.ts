import { Pool, PoolClient, types } from 'pg';
import { env, readOptionalCaCert } from '../config/env.ts';

// Parse PostgreSQL int8 (bigint) as JS number for integer paise JSON responses
// (Note: all paise values in BazaarBridge are safely within Number.MAX_SAFE_INTEGER)
types.setTypeParser(20, (val) => parseInt(val, 10));

export class AppError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let pool: Pool | null = null;

export function isPgConfigured(): boolean {
  return Boolean(env.pgUri);
}

export function getPool(): Pool {
  if (!env.pgUri) {
    throw new AppError(
      503,
      'SERVICE_NOT_CONFIGURED',
      'Aiven PostgreSQL is not configured. Set PG_URI in environment variables.',
      { missing: ['PG_URI'] }
    );
  }
  if (!pool) {
    const ca = readOptionalCaCert();
    let connStr = env.pgUri;
    let needsSsl = env.pgUri.includes('sslmode=require') || env.pgUri.includes('aivencloud.com') || Boolean(ca);

    try {
      const parsed = new URL(env.pgUri);
      if (parsed.searchParams.has('sslmode')) {
        needsSsl = true;
        if (!ca) {
          parsed.searchParams.delete('sslmode');
          connStr = parsed.toString();
        }
      }
    } catch {
      // keep raw connectionString if non-standard URI
    }

    pool = new Pool({
      connectionString: connStr,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: needsSsl
        ? ca
          ? { ca: ca.toString('utf8'), rejectUnauthorized: true }
          : { rejectUnauthorized: false }
        : undefined,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function withDeadlockRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3
): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr?.code === '40P01' && attempt < maxAttempts) {
        const jitterMs = 25 + Math.floor(Math.random() * 75) * attempt;
        await new Promise((r) => setTimeout(r, jitterMs));
        continue;
      }
      throw err;
    }
  }
}

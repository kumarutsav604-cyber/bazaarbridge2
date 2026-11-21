import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { closePool, getPool, isPgConfigured } from './pool.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  if (!isPgConfigured()) {
    throw new Error('PG_URI is not set. Please configure Aiven PostgreSQL in .env');
  }
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const pool = getPool();
  await pool.query(sql);
  console.log('BazaarBridge v7.2 schema applied successfully.');
}

if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  runMigrations()
    .then(() => closePool())
    .catch(async (err) => {
      console.error('Migration failed:', err);
      await closePool();
      process.exit(1);
    });
}

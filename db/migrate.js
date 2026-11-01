import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/krusch';
const connectionString = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;

const pgBrickUrl = new URL('../../../lib/pg.js', import.meta.url);
const pgBrickSpec = '@krusch/toolkit/pg';

let createPgPool = null;
if (fs.existsSync(pgBrickUrl)) {
  try {
    ({ createPgPool } = await import(pgBrickUrl.href));
  } catch {
    createPgPool = null;
  }
}
if (!createPgPool) {
  try {
    ({ createPgPool } = await import(pgBrickSpec));
  } catch {
    createPgPool = null;
  }
}

const migratePoolLogger = {
  info() {},
  debug() {},
  warn() {},
  error(_msg, err) {
    const detail = err?.error?.message || err?.message || String(err || '');
    console.error('[krusch:migrate] PostgreSQL pool idle client error:', detail);
  },
};

function createMigrationPool(connStr) {
  if (typeof createPgPool === 'function') {
    return createPgPool(
      { connectionString: connStr },
      {
        serviceName: 'krusch-migrate',
        connectionTimeoutMillis: 5000,
        PoolClass: pg.Pool,
        logger: migratePoolLogger,
      }
    ).pool;
  }
  const PoolCtor = pg.Pool;
  const fallbackPool = new PoolCtor({ connectionString: connStr, connectionTimeoutMillis: 5000 });
  fallbackPool.on?.('error', (err) => {
    console.error('[krusch:migrate] PostgreSQL pool idle client error:', err.message);
  });
  return fallbackPool;
}

export async function migrate() {
  const pool = createMigrationPool(connectionString);
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error(`\n================================================================================`);
    console.error(`✗ Krusch Migration Error: Could not connect to PostgreSQL.`);
    console.error(`  Target Database: ${connectionString.replace(/:[^:@]+@/, ':****@')}`);
    console.error(`  Error details:   ${err.message}\n`);
    console.error(`First-run bringup:`);
    console.error(`  1. Start PostgreSQL:  docker compose up -d`);
    console.error(`  2. Apply migrations:  npm run migrate`);
    console.error(`  3. Run mock harness:  ./bin/krusch.js run "Add a test" --mock\n`);
    console.error(`Or configure DATABASE_URL in .env:`);
    console.error(`  DATABASE_URL=postgresql://postgres:postgres@localhost:5432/krusch`);
    console.error(`================================================================================\n`);
    await pool.end();
    throw err;
  }

  try {
    // 1. Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS krusch_schema_migrations (
        version VARCHAR(128) PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Fetch already applied versions
    const appliedRes = await client.query('SELECT version FROM krusch_schema_migrations');
    const appliedSet = new Set(appliedRes.rows.map(r => r.version));

    // 3. Scan and sort migration files
    const migrationsDir = path.resolve(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let appliedCount = 0;

    for (const file of files) {
      const version = path.basename(file, '.sql');
      if (!appliedSet.has(version)) {
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf-8');

        console.log(`Applying migration: ${file}...`);
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO krusch_schema_migrations (version, applied_at) VALUES ($1, NOW())',
            [version]
          );
          await client.query('COMMIT');
          console.log(`✓ Applied migration ${file}`);
          appliedCount++;
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`✗ Migration ${file} failed:`, err.message);
          throw err;
        }
      }
    }

    if (appliedCount === 0) {
      console.log('✓ Krusch database schema is up to date (no pending migrations).');
    } else {
      console.log(`✓ Applied ${appliedCount} migration(s) successfully.`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().catch(() => process.exit(1));
}

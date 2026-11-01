import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/krusch';
const connectionString = (process.env.DATABASE_URL || '').trim() || DEFAULT_DATABASE_URL;

const rawEphemeral = (process.env.KRUSCH_EPHEMERAL || '').trim().toLowerCase();
let ephemeralMode = rawEphemeral === '1' || rawEphemeral === 'true';
let pgliteInstance = null;
let activePool = null;

export function isEphemeralMode() {
  return ephemeralMode;
}

export function enableEphemeralMode() {
  ephemeralMode = true;
  process.env.KRUSCH_EPHEMERAL = '1';
}

export function disableEphemeralMode() {
  ephemeralMode = false;
  delete process.env.KRUSCH_EPHEMERAL;
}

export async function getPglite() {
  if (!pgliteInstance) {
    pgliteInstance = new PGlite();
    // Automatically apply migrations to ephemeral database
    const migrationsDir = path.resolve(__dirname, '../../db/migrations');
    if (fs.existsSync(migrationsDir)) {
      await pgliteInstance.exec(`
        CREATE TABLE IF NOT EXISTS krusch_schema_migrations (
          version VARCHAR(128) PRIMARY KEY,
          applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
      const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
      for (const f of files) {
        const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf-8');
        await pgliteInstance.exec(sql);
        const version = path.basename(f, '.sql');
        await pgliteInstance.query(
          'INSERT INTO krusch_schema_migrations (version, applied_at) VALUES ($1, NOW()) ON CONFLICT DO NOTHING',
          [version]
        );
      }
    }
  }
  return pgliteInstance;
}

const pgBrickUrl = new URL('../../../../lib/pg.js', import.meta.url);
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

const poolLogger = {
  info() {},
  debug() {},
  warn() {},
  error(_msg, err) {
    const detail = err?.error?.message || err?.message || String(err || '');
    console.error('[krusch:db] PostgreSQL pool idle client error:', detail);
  },
};

export function getPool() {
  if (ephemeralMode) {
    throw new Error('Cannot get pg.Pool in ephemeral mode. Use query() or withTransaction().');
  }
  if (!activePool || activePool.ending || activePool.ended) {
    if (typeof createPgPool === 'function') {
      activePool = createPgPool(
        { connectionString },
        {
          serviceName: 'krusch-db',
          max: 10,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
          PoolClass: pg.Pool,
          logger: poolLogger,
        }
      ).pool;
    } else {
      const PoolCtor = pg.Pool;
      activePool = new PoolCtor({
        connectionString,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });
      // Guard against uncaught idle client crashes (e.g. Postgres restart or network drops)
      activePool.on('error', (err) => {
        console.error('[krusch:db] PostgreSQL pool idle client error:', err.message);
      });
    }
  }
  return activePool;
}

export const pool = {
  query: (...args) => query(...args),
  connect: async () => {
    if (ephemeralMode) {
      const db = await getPglite();
      return {
        query: async (text, params) => {
          const res = await db.query(text, params);
          return {
            rows: res.rows || [],
            rowCount: res.affectedRows ?? res.rows?.length ?? 0
          };
        },
        release: () => {}
      };
    }
    return getPool().connect();
  },
  end: async () => {
    if (pgliteInstance) {
      try { await pgliteInstance.close(); } catch (_) {}
      pgliteInstance = null;
    }
    if (activePool) {
      await activePool.end();
      activePool = null;
    }
  },
};

export async function query(text, params, options = {}) {
  if (ephemeralMode) {
    const db = await getPglite();
    try {
      const res = await db.query(text, params);
      return {
        rows: res.rows || [],
        rowCount: res.affectedRows ?? res.rows?.length ?? 0
      };
    } catch (err) {
      if (!options.silent) {
        console.error(`[krusch:db] Ephemeral query error: "${text.slice(0, 100)}..." -> ${err.message}`);
      }
      throw err;
    }
  }

  try {
    const res = await getPool().query(text, params);
    return res;
  } catch (err) {
    if (!options.silent) {
      console.error(`[krusch:db] Query error: "${text.slice(0, 100)}..." -> ${err.message}`);
    }
    throw err;
  }
}

export async function withTransaction(callback) {
  if (ephemeralMode) {
    const db = await getPglite();
    return await db.transaction(async (tx) => {
      const client = {
        query: async (text, params) => {
          const res = await tx.query(text, params);
          return {
            rows: res.rows || [],
            rowCount: res.affectedRows ?? res.rows?.length ?? 0
          };
        },
        release: () => {}
      };
      return await callback(client);
    });
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}

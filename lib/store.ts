// PostgreSQL primary store — the durable source of truth for counts.
// Flushes use an additive UPSERT so concurrent flushes add rather than clobber;
// recent_score is decayed in SQL on each flush using the shared LAMBDA.
import { Pool } from 'pg';
import { config } from './config';
import { counters } from './metrics';
import { LAMBDA } from './ranking';
import type { TrieRow } from './trie';

let pool: Pool | null = null;

export function initPool(): void {
  if (!pool) pool = new Pool({ ...config.postgres, max: 10 });
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function db(): Pool {
  if (!pool) throw new Error('store: pool not initialized — call initPool() first');
  return pool;
}

export async function initSchema(): Promise<void> {
  await db().query(`
    CREATE TABLE IF NOT EXISTS queries (
      query         TEXT PRIMARY KEY,
      count         BIGINT NOT NULL DEFAULT 0,
      recent_score  DOUBLE PRECISION NOT NULL DEFAULT 0,
      last_searched TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
  await db().query(
    `CREATE INDEX IF NOT EXISTS idx_query_prefix ON queries (query text_pattern_ops);`,
  );
  await db().query(`CREATE INDEX IF NOT EXISTS idx_recent_score ON queries (recent_score DESC);`);
}

export async function truncate(): Promise<void> {
  await db().query('TRUNCATE queries;');
}

export async function countRows(): Promise<number> {
  const { rows } = await db().query('SELECT count(*)::int AS n FROM queries;');
  return rows[0].n;
}

// initial dataset ingestion: rows = [[query, count], ...]
export async function bulkLoad(rows: Array<[string, number]>): Promise<void> {
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const placeholders: string[] = [];
    const params: Array<string | number> = [];
    slice.forEach(([q, c], j) => {
      placeholders.push(`($${2 * j + 1}, $${2 * j + 2})`);
      params.push(q, c);
    });
    await db().query(
      `INSERT INTO queries (query, count) VALUES ${placeholders.join(',')}
       ON CONFLICT (query) DO NOTHING;`,
      params,
    );
  }
}

// apply one flush window: Map<query, increment>. Each search also +1s recency.
export async function batchUpsert(window: Map<string, number>): Promise<number> {
  const entries = [...window.entries()];
  if (entries.length === 0) return 0;

  const placeholders: string[] = [];
  const params: Array<string | number> = [];
  // count (bigint) and recent_score (double) get separate params so Postgres
  // doesn't try to infer one shared type across the two columns
  entries.forEach(([q, inc], j) => {
    placeholders.push(`($${3 * j + 1}, $${3 * j + 2}, $${3 * j + 3}, now())`);
    params.push(q, inc, inc);
  });

  await db().query(
    `INSERT INTO queries (query, count, recent_score, last_searched)
     VALUES ${placeholders.join(',')}
     ON CONFLICT (query) DO UPDATE SET
       count = queries.count + EXCLUDED.count,
       recent_score = queries.recent_score
         * exp(-${LAMBDA} * EXTRACT(EPOCH FROM (now() - queries.last_searched)))
         + EXCLUDED.recent_score,
       last_searched = now();`,
    params,
  );

  counters.dbWrites += entries.length;
  counters.dbWriteBatches += 1;
  return entries.length;
}

// every row, for a trie rebuild: [query, count, recent_score, age_seconds]
export async function loadAll(): Promise<TrieRow[]> {
  const { rows } = await db().query(
    `SELECT query, count, recent_score, EXTRACT(EPOCH FROM (now() - last_searched)) AS age
     FROM queries;`,
  );
  return rows.map((r) => [r.query, Number(r.count), Number(r.recent_score), Number(r.age) || 0]);
}

// top rows by stored recent_score: [query, recent_score, age_seconds]
export async function trendingCandidates(limit: number): Promise<Array<[string, number, number]>> {
  const { rows } = await db().query(
    `SELECT query, recent_score, EXTRACT(EPOCH FROM (now() - last_searched)) AS age
     FROM queries ORDER BY recent_score DESC LIMIT $1;`,
    [limit],
  );
  return rows.map((r) => [r.query, Number(r.recent_score), Number(r.age) || 0]);
}

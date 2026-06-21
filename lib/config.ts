// Central configuration. Every value here maps to a decision documented in
// DESIGN.md. Read once from the environment (.env via Next.js) at module load.
import 'dotenv/config';

const toInt = (key: string, fallback: number): number => {
  const raw = process.env[key];
  return raw === undefined ? fallback : parseInt(raw, 10);
};

const toFloat = (key: string, fallback: number): number => {
  const raw = process.env[key];
  return raw === undefined ? fallback : parseFloat(raw);
};

const csv = (key: string, fallback: string): string[] =>
  (process.env[key] || fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export type RankingMode = 'count' | 'hybrid';

export const config = {
  postgres: {
    host: process.env.PG_HOST || 'localhost',
    port: toInt('PG_PORT', 5433),
    user: process.env.PG_USER || 'typeahead',
    password: process.env.PG_PASSWORD || 'typeahead',
    database: process.env.PG_DB || 'typeahead',
  },

  // distributed cache nodes (host:port), routed by consistent hashing
  cacheNodes: csv('CACHE_NODES', 'localhost:6390,localhost:6391,localhost:6392'),
  vnodes: toInt('VNODES', 150),

  // invalidation: jittered TTL is the primary mechanism
  ttlSuggest: toInt('TTL_SUGGEST', 45),
  ttlTrend: toInt('TTL_TREND', 8),
  ttlJitter: toFloat('TTL_JITTER', 0.2),

  // write-back batching
  batchSize: toInt('BATCH_SIZE_N', 500),
  flushIntervalMs: toFloat('FLUSH_INTERVAL_T', 1.0) * 1000,

  // trie / suggestions
  topK: toInt('TOP_K', 10),
  precomputePrefixLen: toInt('PRECOMPUTE_PREFIX_LEN', 3),
  trieRefreshSec: toInt('TRIE_REFRESH_SEC', 120),

  // ranking
  rankingMode: (process.env.RANKING_MODE as RankingMode) || 'hybrid',
  weightPopularity: toFloat('W_POP', 1.0),
  weightRecency: toFloat('W_REC', 2.0),
  decayHalflifeSec: toFloat('DECAY_HALFLIFE_SEC', 3600),
} as const;

export function normalizeMode(value: string | null | undefined): RankingMode {
  const mode = (value || config.rankingMode).toLowerCase();
  return mode === 'count' ? 'count' : 'hybrid';
}

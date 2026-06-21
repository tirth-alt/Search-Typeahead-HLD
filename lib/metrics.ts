// Runtime counters + a rolling latency window, surfaced at GET /api/metrics.
// Kept as a single module-level object so every request mutates one source.

const LATENCY_WINDOW = 5000;

interface Counters {
  cacheHits: number;
  cacheMisses: number;
  dbReads: number; // suggestion-path DB reads — 0 by design (trie serves misses)
  dbWrites: number; // rows written via batch flush
  dbWriteBatches: number; // flush transactions
  searchesReceived: number; // POST /search calls before aggregation
}

export const counters: Counters = {
  cacheHits: 0,
  cacheMisses: 0,
  dbReads: 0,
  dbWrites: 0,
  dbWriteBatches: 0,
  searchesReceived: 0,
};

const latencySamples: number[] = [];

export function recordSuggestLatency(ms: number): void {
  latencySamples.push(ms);
  if (latencySamples.length > LATENCY_WINDOW) latencySamples.shift();
}

function percentile(p: number): number {
  if (latencySamples.length === 0) return 0;
  const sorted = [...latencySamples].sort((a, b) => a - b);
  const idx = Math.max(
    0,
    Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1))),
  );
  return Math.round(sorted[idx] * 1000) / 1000;
}

export function snapshot() {
  const lookups = counters.cacheHits + counters.cacheMisses;
  return {
    cache_hits: counters.cacheHits,
    cache_misses: counters.cacheMisses,
    cache_hit_rate: lookups ? Math.round((counters.cacheHits / lookups) * 10000) / 10000 : 0,
    db_reads: counters.dbReads,
    db_writes: counters.dbWrites,
    db_write_batches: counters.dbWriteBatches,
    searches_received: counters.searchesReceived,
    write_reduction_factor: counters.dbWrites
      ? Math.round((counters.searchesReceived / counters.dbWrites) * 100) / 100
      : null,
    suggest_latency_ms: {
      samples: latencySamples.length,
      p50: percentile(50),
      p95: percentile(95),
      p99: percentile(99),
    },
  };
}

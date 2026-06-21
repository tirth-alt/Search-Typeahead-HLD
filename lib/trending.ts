// Trending = global top-N by time-decayed recent_score, decayed at read time so
// quiet queries fall off. Cached under a short TTL on its owning node.
import { config } from './config';
import { decay } from './ranking';
import * as store from './store';
import type { CacheCluster } from './cache';

export interface TrendingEntry {
  query: string;
  score: number;
}

export async function getTrending(cache: CacheCluster, n: number): Promise<TrendingEntry[]> {
  const key = `trending:${n}`;
  const cached = await cache.readRaw(key);
  if (cached != null) return JSON.parse(cached);

  const candidates = await store.trendingCandidates(Math.max(100, n * 5));
  const ranked = candidates
    .map(([query, recent, age]): TrendingEntry => ({ query, score: decay(recent, age) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);

  await cache.writeRaw(key, JSON.stringify(ranked), config.ttlTrend);
  return ranked;
}

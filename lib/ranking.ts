// Ranking math shared by the trie, trending, and the SQL flush.
//
//   count  -> all-time popularity (sort by raw count)
//   hybrid -> w_pop * log(count) + w_rec * decayed_recency
//
// recent_score halves every `decayHalflifeSec` of inactivity, so a short-lived
// spike fades instead of ranking forever (the same aging idea as LFU).
import { config, type RankingMode } from './config';

// decay constant: score * e^(-LAMBDA * dt) halves after one half-life
export const LAMBDA = Math.log(2) / config.decayHalflifeSec;

export function decay(recentScore: number, ageSeconds: number): number {
  if (ageSeconds <= 0) return recentScore;
  return recentScore * Math.exp(-LAMBDA * ageSeconds);
}

export function hybridScore(count: number, recentScore: number): number {
  return config.weightPopularity * Math.log1p(count) + config.weightRecency * recentScore;
}

export function scoreFor(mode: RankingMode, count: number, recentScore: number): number {
  return mode === 'count' ? count : hybridScore(count, recentScore);
}

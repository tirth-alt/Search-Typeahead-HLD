// In-memory prefix trie for top-k autocomplete (O(prefix length) descent).
//
// A candidate pool is precomputed only for SHORT prefixes (<= precomputePrefixLen)
// — those are few but broad and hot. Longer prefixes are collected on demand.
// Counts and recency live in one map keyed by the full query, so the same
// structure serves both `count` and `hybrid` ranking without a rebuild.
import { config, type RankingMode } from './config';
import { decay, scoreFor } from './ranking';

const MAX_QUERY_LEN = 100;
const CANDIDATE_POOL = 50;
const DFS_CAP = 3000;

// [count, recentScore]
type Stats = [number, number];

class TrieNode {
  children = new Map<string, TrieNode>();
  isWord = false;
  pool: string[] | null = null; // precomputed candidate strings (shallow nodes)
}

export interface Suggestion {
  query: string;
  count: number;
}

// rows for build(): [query, count, recentScore, ageSeconds]
export type TrieRow = [string, number, number, number];

export class Trie {
  private root = new TrieNode();
  private stats = new Map<string, Stats>();

  private insert(query: string): void {
    let node = this.root;
    for (const ch of query) {
      let next = node.children.get(ch);
      if (!next) {
        next = new TrieNode();
        node.children.set(ch, next);
      }
      node = next;
    }
    node.isWord = true;
  }

  build(rows: TrieRow[]): void {
    this.root = new TrieNode();
    this.stats = new Map();
    for (const [query, count, recent, age] of rows) {
      const q = query.slice(0, MAX_QUERY_LEN);
      if (!q) continue;
      this.stats.set(q, [count, decay(recent, age)]);
      this.insert(q);
    }
    this.refreshPools();
  }

  private navigate(prefix: string): TrieNode | null {
    let node = this.root;
    for (const ch of prefix) {
      const next = node.children.get(ch);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  private collect(node: TrieNode, prefix: string, cap: number): string[] {
    const out: string[] = [];
    const stack: Array<[TrieNode, string]> = [[node, prefix]];
    while (stack.length && out.length < cap) {
      const [cur, pre] = stack.pop()!;
      if (cur.isWord && this.stats.has(pre)) out.push(pre);
      for (const [ch, child] of cur.children) stack.push([child, pre + ch]);
    }
    return out;
  }

  refreshPools(): void {
    this.refresh(this.root, '', 0);
  }

  private refresh(node: TrieNode, prefix: string, depth: number): void {
    if (depth > config.precomputePrefixLen) return;
    const words = this.collect(node, prefix, 10000);
    words.sort((a, b) => this.stats.get(b)![0] - this.stats.get(a)![0]);
    node.pool = words.slice(0, CANDIDATE_POOL);
    for (const [ch, child] of node.children) this.refresh(child, prefix + ch, depth + 1);
  }

  getSuggestions(rawPrefix: string, k: number, mode: RankingMode): Suggestion[] {
    const prefix = rawPrefix.toLowerCase().trim();
    if (!prefix) return [];
    const node = this.navigate(prefix);
    if (!node) return [];

    const candidates = node.pool != null ? [...node.pool] : this.collect(node, prefix, DFS_CAP);
    candidates.sort((a, b) => {
      const [ca, ra] = this.stats.get(a)!;
      const [cb, rb] = this.stats.get(b)!;
      return scoreFor(mode, cb, rb) - scoreFor(mode, ca, ra);
    });
    return candidates.slice(0, k).map((q) => ({ query: q, count: this.stats.get(q)![0] }));
  }

  // apply one flush window: counts are exact-additive, recency is rough-bumped
  applyUpdates(window: Map<string, number>): void {
    for (const [rawQuery, inc] of window) {
      const q = rawQuery.slice(0, MAX_QUERY_LEN);
      if (!q) continue;
      const cur = this.stats.get(q);
      if (cur) {
        cur[0] += inc;
        cur[1] += inc;
      } else {
        this.stats.set(q, [inc, inc]);
        this.insert(q);
      }
    }
  }

  size(): number {
    return this.stats.size;
  }
}

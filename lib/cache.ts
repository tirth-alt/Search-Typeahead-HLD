// Distributed cache over N Redis nodes, routed by the consistent-hash ring.
// Cache-aside reads, write-around writes, jittered-TTL invalidation.
import Redis from 'ioredis';
import { config, type RankingMode } from './config';
import { counters } from './metrics';
import { HashRing, type RingDebug } from './consistentHash';
import type { Suggestion } from './trie';

const suggestKey = (prefix: string, mode: RankingMode): string => `sugg:${mode}:${prefix}`;

export interface CacheRead {
  suggestions: Suggestion[] | null;
  node: string | null;
  hit: boolean;
}

export interface CacheDebug extends RingDebug {
  mode: RankingMode;
  redis_key: string;
  currently_cached: boolean;
  hit_or_miss: 'HIT' | 'MISS';
}

export class CacheCluster {
  private clients = new Map<string, Redis>();
  private ring = new HashRing(config.vnodes);

  async connect(): Promise<void> {
    this.ring = new HashRing(config.vnodes);
    for (const node of config.cacheNodes) {
      const [host, port] = node.split(':');
      this.clients.set(node, new Redis({ host, port: parseInt(port, 10), lazyConnect: false }));
      this.ring.addNode(node);
    }
    // fail fast if any node is unreachable
    await Promise.all([...this.clients.values()].map((c) => c.ping()));
  }

  disconnect(): void {
    for (const client of this.clients.values()) client.disconnect();
  }

  // spread expiries so a hot prefix's entries don't all lapse on the same tick
  private jitter(ttl: number): number {
    const delta = ttl * config.ttlJitter;
    return Math.max(1, Math.round(ttl + (Math.random() * 2 - 1) * delta));
  }

  private clientFor(key: string): Redis {
    const node = this.ring.nodeFor(key)!;
    return this.clients.get(node)!;
  }

  async readSuggestions(prefix: string, mode: RankingMode): Promise<CacheRead> {
    const node = this.ring.nodeFor(prefix);
    const raw = await this.clientFor(prefix).get(suggestKey(prefix, mode));
    if (raw == null) {
      counters.cacheMisses++;
      return { suggestions: null, node, hit: false };
    }
    counters.cacheHits++;
    return { suggestions: JSON.parse(raw), node, hit: true };
  }

  async writeSuggestions(
    prefix: string,
    mode: RankingMode,
    suggestions: Suggestion[],
    ttl: number,
  ): Promise<string | null> {
    const node = this.ring.nodeFor(prefix);
    await this.clientFor(prefix).set(
      suggestKey(prefix, mode),
      JSON.stringify(suggestions),
      'EX',
      this.jitter(ttl),
    );
    return node;
  }

  async readRaw(key: string): Promise<string | null> {
    return this.clientFor(key).get(key);
  }

  async writeRaw(key: string, value: string, ttl: number): Promise<string | null> {
    const node = this.ring.nodeFor(key);
    await this.clientFor(key).set(key, value, 'EX', this.jitter(ttl));
    return node;
  }

  async describe(prefix: string, mode: RankingMode): Promise<CacheDebug> {
    const info = this.ring.describe(prefix);
    const cached = info.owner_node
      ? (await this.clientFor(prefix).get(suggestKey(prefix, mode))) != null
      : false;
    return {
      ...info,
      mode,
      redis_key: suggestKey(prefix, mode),
      currently_cached: cached,
      hit_or_miss: cached ? 'HIT' : 'MISS',
    };
  }

  getRing(): HashRing {
    return this.ring;
  }
}

// Singleton runtime bootstrap.
//
// Express had one obvious place to start everything (app.listen). Next.js does
// not — route handlers are loaded lazily and (in dev) re-evaluated on hot
// reload. So we centralize the long-lived state (Redis cluster, the trie, the
// write buffer, the refresh timer) in one object, build it exactly once, and
// stash it on `globalThis` so a hot reload reuses it instead of reconnecting.
import { config } from './config';
import { CacheCluster } from './cache';
import { Trie } from './trie';
import { WriteBuffer } from './writeBuffer';
import * as store from './store';

export interface Runtime {
  cache: CacheCluster;
  trie: Trie;
  buffer: WriteBuffer;
  refreshTimer: ReturnType<typeof setInterval> | null;
}

const GLOBAL_KEY = Symbol.for('typeahead.runtime');
type GlobalWithRuntime = typeof globalThis & {
  [GLOBAL_KEY]?: Promise<Runtime>;
};
const globalRef = globalThis as GlobalWithRuntime;

async function buildTrie(trie: Trie): Promise<void> {
  const rows = await store.loadAll();
  trie.build(rows);
}

async function bootstrap(): Promise<Runtime> {
  store.initPool();
  await store.initSchema();

  const cache = new CacheCluster();
  await cache.connect();

  const trie = new Trie();
  await buildTrie(trie);

  // flush handler: durable additive UPSERT, then mirror the delta into the trie
  const buffer = new WriteBuffer(async (window) => {
    await store.batchUpsert(window);
    trie.applyUpdates(window);
  });
  buffer.start();

  // periodic full rebuild re-applies decay and refreshes the candidate pools
  const refreshTimer = setInterval(() => {
    buildTrie(trie).catch((e) => console.error('[trie refresh]', (e as Error).message));
  }, config.trieRefreshSec * 1000);

  console.log(
    `[runtime] trie loaded with ${trie.size()} queries; cache nodes=${config.cacheNodes.join(', ')}`,
  );

  return { cache, trie, buffer, refreshTimer };
}

// Resolve the shared runtime, building it on first call. Concurrent callers
// during startup await the same in-flight promise (no double bootstrap).
export function getRuntime(): Promise<Runtime> {
  if (!globalRef[GLOBAL_KEY]) {
    globalRef[GLOBAL_KEY] = bootstrap().catch((err) => {
      // let the next request retry instead of caching a failed bootstrap
      globalRef[GLOBAL_KEY] = undefined;
      throw err;
    });
  }
  return globalRef[GLOBAL_KEY]!;
}

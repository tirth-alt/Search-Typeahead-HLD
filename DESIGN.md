# Design Decisions & Trade-offs

One dataset, two workloads pulling in opposite directions. Every keystroke is a
**read** (a suggestion lookup); every submitted query is a **write** (a count
bump). Reads outnumber writes by roughly 5–10×. Two facts drive almost every
decision below: reads are on the hot path and must stay fast, and suggestion
data is *approximate popularity* — a little staleness never hurts anyone.

## Sizing: why a cache at all

Back-of-the-envelope for a large consumer search box:

- ~10M DAU × ~4 searches/day ≈ **460 writes/s** average.
- ~5 suggestion reads per search ≈ **2,300 reads/s** average, **~7k/s** at peak.

Query popularity is Zipfian — a small set of prefixes accounts for most of the
traffic. Cache that hot set and the database barely sees the read load. Skip the
cache and every keystroke becomes a `LIKE 'pre%'` range scan plus a sort on
Postgres; p95 falls apart the moment load arrives. So: **cache the reads.**

## Where the cache lives: global and distributed

- **Global, not per-instance.** A shared cache is one copy with one place to
  expire entries. Per-instance local caches duplicate the same hot data and need
  cross-instance invalidation (broadcast or poll) just to stay coherent — cost
  with no upside here.
- **Distributed across 3 Redis nodes, not one.** A single node would handle this
  dataset and QPS comfortably. We shard it for **fault tolerance** — losing one
  node drops 1/3 of the cache and sends 1/3 of misses to the DB, instead of a
  full stampede — and for headroom. This is a resilience decision, not a
  throughput one.

## Routing: consistent hashing

Because each node owns a *different* slice of keys, routing has to be
deterministic per key — round-robin can't work, since it forgets *where* a key
was written. Plain `hash % N` is deterministic but remaps almost every key when
`N` changes. A **hash ring with virtual nodes** (150 vnodes/node here) remaps
only ~K/N keys when a node joins or leaves. The cost is more code than `% N`; the
payoff is stability under membership change. The application tier itself is
stateless, so it sits behind an ordinary round-robin load balancer.

## Keeping the cache fresh

The cached value is a *computed top-10* list, and a single count change can
invalidate many overlapping prefixes across nodes. Tracking all of that is not
worth it, so:

- **Jittered TTL is the primary mechanism.** ~45s for suggestions, ~8s for
  trending, each jittered ±20% so a hot prefix's entries don't all expire on the
  same tick (anti-stampede). Bounded staleness, zero bookkeeping.
- **Write-around, not write-through.** A submitted search updates the store, not
  the cache; the cache refills lazily on the next read miss. Write-through would
  recompute a top-10 on every write — and most writes don't even change the
  ranking — so it's wasted work.
- **Targeted invalidation: deliberately skipped.** The short TTL already covers
  freshness; per-key invalidation adds complexity it doesn't earn.

## Eviction: LRU

Hot prefixes get re-hit constantly, so LRU naturally keeps them and sheds the
long tail. LFU matches a stable Zipf distribution slightly better but needs an
aging factor (otherwise one old viral query squats forever on its count) — not
worth the complexity, especially when short TTLs mean eviction rarely fires at
all. Each Redis node is capped at 256MB with `allkeys-lru` as the safety net.

## Consistency: eventual, PA/EL

Suggestions are approximate by nature, so we trade consistency for latency and
availability. In PACELC terms this is **PA/EL**: during a partition we serve
stale data rather than error (**AP**), and in normal operation we serve from
cache rather than re-validate against the DB (**EL**). The `"Searched"` response
is a synchronous *acknowledgement* — the count update behind it happens
asynchronously.

## Writes: write-back batching

`POST /api/search` increments an in-memory map and returns immediately. The
buffer aggregates duplicate queries and flushes on **size** (500 entries) **or**
**interval** (1s), whichever comes first, as a single additive UPSERT:
`count = count + EXCLUDED.count`, so concurrent flushes add rather than clobber.
This collapses tens of thousands of submissions into a few thousand rows across a
handful of transactions. **Trade-off:** a crash loses at most one un-flushed
window — fine for approximate, self-healing counts. True durability would need a
WAL or a durable queue (Kafka / Redis Streams).

## Store: PostgreSQL

A write-heavy-looking workload usually argues for a write-optimized LSM/NoSQL
store. But batching already cut DB writes by ~4× in rows and ~1000× in
transactions, which removes that pressure — so Postgres is the right call: a
B-tree index serves `LIKE 'pre%'` range scans, ACID gives a trustworthy count of
record, and read replicas scale the rare miss-path read. We'd reach for an LSM
store (Cassandra) only if writes were un-batchable and enormous, or if we needed
sharding plus quorum. (An LSM store buffers writes in a memtable + WAL and flushes
to immutable SSTables that compaction later merges — conceptually the same idea as
our app-layer batch buffer. Redis, the cache, is the one NoSQL store we do use.)

## Replication & quorum

Writes go to the master; miss-path reads can be served by async replicas (read
scaling + failover) at the cost of bounded replication lag, which is acceptable
given the eventual-consistency stance. Quorum tuning (`R + W > N` for strong
consistency) is a leaderless-store concern — irrelevant with Postgres, but a
Cassandra variant would pick low R/W to match the PA/EL choice.

## Serving: trie with lazy top-k

Suggestions come from an **in-memory trie**, so a lookup is O(prefix length). We
precompute a candidate pool only for **short prefixes** (≤ 3 chars — few in
number but broad and hot); longer prefixes are collected on demand with a bounded
DFS. We do *not* precompute every prefix (that's tens of millions of nodes). The
crucial detail: counts and recency are stored once per query and read live at
ranking time, so the **same trie serves both ranking modes** without a rebuild.

A cache miss is answered by the trie, never by Postgres — so DB reads on the
suggestion path are **zero by design**.

## Ranking: count vs. hybrid recency

- **count** — sort by all-time `count`. Stable, boring, correct.
- **hybrid** — `w_pop·log(count) + w_rec·recent_score`. `recent_score`
  increments on each search and **decays exponentially** (1-hour half-life), so a
  short-lived spike fades instead of ranking forever — the same aging idea LFU
  would need. Decay is applied at read time for trending so quiet queries drop
  off on their own.

## Next.js adaptation: the runtime singleton

The original of this system ran on a long-lived Express process with one obvious
startup hook (`app.listen`). Next.js has no such single entry point — Route
Handlers are loaded lazily and, in dev, re-evaluated on hot reload. So the
long-lived state (the Redis pool, the trie, the write buffer, the refresh timer)
is centralized in [lib/runtime.ts](lib/runtime.ts), built exactly once, and
cached on `globalThis`. Every handler calls `await getRuntime()`; the first call
bootstraps and concurrent callers await the same in-flight promise, so there's no
double-initialization and no reconnect storm on reload. This is the one genuinely
framework-shaped decision in the project — everything else is the same
architecture the Express version had.

## Summary

| Topic | Decision | Rejected alternative |
|---|---|---|
| Caching | cache reads | no cache → DB-bound p95 |
| Locality | global | per-instance → duplication + coherence |
| Topology | distributed (3) | single → SPOF / stampede |
| Routing | consistent hashing | round-robin (no locality), `%N` (mass remap) |
| Eviction | LRU | LFU (needs aging) |
| Freshness | write-around + jittered TTL | write-through (costly), targeted (complex) |
| Writes | write-back batching | sync per-write (DB-bound) |
| Store | PostgreSQL | NoSQL/LSM (unneeded after batching) |
| Consistency | eventual / PA-EL | strong (latency cost) |
| Serving | trie + lazy top-k | full precompute (waste), DB-only (slow) |
| Ranking | count + decayed hybrid | raw recent counter (over-ranks spikes) |
| Lifecycle | `globalThis` runtime singleton | per-request init (reconnect storm) |

## Known limits

- A single scorching-hot prefix still lands on one node (the hot-key problem) —
  mitigating it would need hot-key replication or an L1 cache in front.
- A crash loses ≤ 1 flush window of counts.
- Trie recency is approximate between periodic rebuilds.

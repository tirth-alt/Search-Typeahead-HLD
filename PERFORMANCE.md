# Performance

Setup: 1 Next.js app server (`next start -p 8000`), 1 Postgres, 3 Redis nodes
(Docker), all on one machine. Dataset: 120,000 synthetic Zipf-distributed
queries (`npm run load -- --synthetic 120000`). Reproduce with:

```bash
npm run bench -- --base http://localhost:8000 --reads 4000 --writes 6000
```

The numbers below are from one such run.

## Read latency — `GET /api/suggest`

- Server-side p95 ≈ **5 ms** (cache hit → Redis; miss → in-memory trie).
- Client-side p50 / p95 ≈ **5 ms / 12 ms** under 20 concurrent readers
  (includes HTTP + Next.js routing overhead).
- DB reads on the suggestion path = **0**: a miss is served by the trie, never
  Postgres.

> Note: the server p95 (~5 ms) is higher than a bare Express handler would post
> (~0.5 ms) — that gap is the Next.js Route Handler / framework overhead, paid
> on every request. It's a deliberate trade for the App-Router developer model.

## Cache hit rate

- ~**81%** over 4,000 mixed reads (3,255 hits / 745 misses) on a synthetic Zipf
  prefix mix.
- Climbs toward 90%+ with a more skewed (real-traffic) load or a longer
  `TTL_SUGGEST`.

## Write reduction — batching

6,000 search submissions in one run:

| Searches received | Rows written | Flush transactions |
|---|---|---|
| 6,000 | ~1,460 | 4 |

≈ **4.1× fewer rows** (duplicate aggregation) and ~**1,500× fewer transactions**
(batching). Trade-off: a crash loses at most one un-flushed window.

## Consistent hashing — distribution

5,000 sample prefixes across 3 nodes (150 vnodes each): **1,544 / 1,731 / 1,725**
≈ **30.9% / 34.6% / 34.5%** — within ~±4% of an even split. Adding or removing a
node remaps only ~1/N of keys. Inspect per-prefix routing via
`GET /api/cache/debug?prefix=<p>`.

## Reproduce

```bash
npm run bench -- --base http://localhost:8000 --reads 4000 --writes 6000
curl 'http://localhost:8000/api/cache/ring?sample=5000'
curl 'http://localhost:8000/api/metrics'
```

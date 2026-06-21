# Understand This System

A walkthrough of how the typeahead engine actually works — written to be read
top-to-bottom if you've never seen the code, and to be useful interview prep for
the system-design concepts underneath it. If you only remember one thing: this is
a **read-optimized** system that treats popularity data as approximate, and every
design choice falls out of those two facts.

---

## 1. The mental model

Two paths, and they barely touch each other:

```
READ  (every keystroke)                 WRITE (every submitted search)
─────────────────────────               ──────────────────────────────
browser                                  browser
  │ GET /api/suggest?q=ip                  │ POST /api/search {query}
  ▼                                        ▼
Route Handler                            Route Handler
  │ ask the cache                          │ buffer.add(query)   ← returns instantly
  ▼                                        ▼
Redis (1 of 3, chosen by hash ring)      in-memory WriteBuffer (a Map)
  │ HIT → return cached top-10            │ flush on 500 entries OR every 1s
  │ MISS ↓                                ▼
in-memory Trie  → compute top-10         Postgres  (one additive UPSERT)
  │ backfill cache                         │ + mirror the same deltas into the Trie
  ▼                                        ▼
return suggestions                       counts are now visible to future reads
```

The read path **never hits Postgres** — a cache miss is answered by the in-memory
trie. The write path **never blocks** — it acknowledges immediately and persists
later in batches. Those two sentences are the whole architecture.

---

## 2. Follow one read request

Start in [app/api/suggest/route.ts](app/api/suggest/route.ts):

1. Parse `q` (the prefix) and `mode` (`count` or `hybrid`).
2. `const { cache, trie } = await getRuntime()` — grab the shared singletons.
3. `cache.readSuggestions(prefix, mode)`:
   - The [HashRing](lib/consistentHash.ts) hashes the prefix and picks **which of
     the 3 Redis nodes** owns it.
   - `GET sugg:<mode>:<prefix>` on that node. Present → **HIT**, return it.
4. On a **MISS**, `trie.getSuggestions(prefix, 10, mode)` computes the top-10
   (Section 4), then `cache.writeSuggestions(...)` backfills Redis with a jittered
   TTL so the next identical request is a HIT.
5. Latency is sampled into [lib/metrics.ts](lib/metrics.ts) and the JSON response
   includes `source` (`cache`/`trie`) and the owning `node` — that's what the UI's
   `MISS → trie · localhost:6390` badge is showing you.

**Interview point:** this is the *cache-aside* (lazy-loading) pattern. The app,
not Redis, owns the read-through logic.

---

## 3. Follow one write request

Start in [app/api/search/route.ts](app/api/search/route.ts) — it's tiny on
purpose:

1. `buffer.add(query)` increments an in-memory `Map<query, count>` and returns
   `{"message":"Searched"}` **immediately**. No DB call on the request path.
2. The [WriteBuffer](lib/writeBuffer.ts) flushes when the map hits 500 entries
   **or** every 1 second. On flush it *swaps* the map for a fresh one (so new
   writes don't block on the flush) and hands the window to the flush handler in
   [lib/runtime.ts](lib/runtime.ts).
3. The handler does two things with that window:
   - `store.batchUpsert(window)` — one SQL statement with an **additive** UPSERT
     (`count = count + EXCLUDED.count`) so concurrent flushes add instead of
     overwriting. See [lib/store.ts](lib/store.ts).
   - `trie.applyUpdates(window)` — mirror the same deltas into the in-memory trie
     so reads reflect new activity without waiting for the next full rebuild.

**Interview point:** this is *write-back (write-behind) batching*. You trade a
small durability window (a crash loses the un-flushed map) for a massive drop in
DB load — here, ~6,000 submissions became ~1,460 rows in **4** transactions.

---

## 4. The trie, and "lazy top-k"

[lib/trie.ts](lib/trie.ts). A trie is a tree where each edge is a character, so
walking the prefix `"ip"` is O(2) — independent of how many queries exist.

The subtlety is ranking. Naively you'd precompute the top-10 for *every* prefix,
but that's tens of millions of nodes. Instead:

- For **short prefixes** (≤ 3 chars — few but hot), precompute a candidate pool
  of ~50 strings at build time.
- For **longer prefixes**, collect candidates on demand with a bounded DFS.
- Either way, the final sort reads `count` and `recent_score` **live** from one
  map. That's why the *same trie* serves both `count` and `hybrid` modes — the
  structure holds the words, the ranking is computed per request.

---

## 5. Consistent hashing in one paragraph

[lib/consistentHash.ts](lib/consistentHash.ts). Imagine a circle of hash values.
Each Redis node is placed at 150 points around it (**virtual nodes**, for even
spread). To route a key, hash it to a point and walk clockwise to the first node
you hit. Why not `hash % 3`? Because if you change `3` to `4`, almost every key
maps somewhere new — a cache-wide miss storm. With a ring, adding/removing a node
only re-homes the keys in that node's arcs (~1/N of them). The
`/api/cache/ring` endpoint proves the spread is even (~33% each).

---

## 6. Recency decay (the "hybrid" mode)

[lib/ranking.ts](lib/ranking.ts). All-time `count` would rank a query that was
huge five years ago above something spiking *today*. So `hybrid` adds a
`recent_score` that **decays exponentially** with a 1-hour half-life:
`score · e^(−λ·Δt)`. A spike fades on its own; nothing has to actively expire it.
The same decay runs in SQL during a flush (so stored scores stay honest) and at
read time for trending (so quiet queries fall off). Trending is just "top-N by
decayed recent_score" — see [lib/trending.ts](lib/trending.ts).

---

## 7. Why the runtime singleton exists (the Next.js bit)

[lib/runtime.ts](lib/runtime.ts). Express had one startup hook to build the trie
and open connections. Next.js doesn't — Route Handlers load lazily and re-run on
hot reload. So all long-lived state lives in one object, built once, cached on
`globalThis`. Every handler does `await getRuntime()`; the first call bootstraps
(connect Redis → init schema → build trie → start the buffer + refresh timer) and
concurrent callers share the same in-flight promise. Without this you'd rebuild
the trie and reconnect Redis on every request or every reload.

---

## 8. How the UI is wired

[components/SearchConsole.tsx](components/SearchConsole.tsx) is a client
component (`'use client'`). The interesting parts:

- **Debounce:** typing schedules `fetchSuggestions` 150ms later, cancelling any
  pending call — so a 10-character burst is ~1 request, not 10.
- **Keyboard nav:** ↑/↓ move `active`, Enter submits, Esc closes.
- **Polling:** trending refreshes every 5s, the metric gauges every 4s — that's
  what makes the hit-rate / p95 / trie-size numbers tick live.
- The masthead and footer are in the server component
  [app/page.tsx](app/page.tsx); the theme is in
  [app/globals.css](app/globals.css).

---

## 9. Map of the code

| File | Responsibility |
|---|---|
| `app/api/suggest/route.ts` | read path: cache → trie → backfill |
| `app/api/search/route.ts` | write path: buffer.add, instant ack |
| `app/api/{trending,metrics,cache}/...` | trending, metrics, ring/debug introspection |
| `lib/runtime.ts` | the one place everything is wired together |
| `lib/cache.ts` | Redis cluster + cache-aside / write-around logic |
| `lib/consistentHash.ts` | the hash ring (prefix → node) |
| `lib/trie.ts` | in-memory prefix top-k |
| `lib/store.ts` | Postgres: schema, bulk load, additive batch UPSERT |
| `lib/writeBuffer.ts` | write-back batching buffer |
| `lib/ranking.ts` | count vs. hybrid scoring + exponential decay |
| `lib/trending.ts` | global top-N by decayed score |
| `lib/metrics.ts` | counters + latency percentiles for `/api/metrics` |
| `components/SearchConsole.tsx` | the whole interactive UI |
| `scripts/loadDataset.ts` | ingest AOL log or synthetic data into Postgres |
| `scripts/benchmark.ts` | drive load and print the perf report |

---

## 10. Questions to test yourself

1. Why is a cache *miss* still cheap here, when a miss usually means "go to the
   slow store"? *(The trie answers it; Postgres is never on the read path.)*
2. What exactly is lost if the process crashes mid-second? *(One un-flushed write
   window — approximate counts that self-heal.)*
3. Why virtual nodes instead of placing each Redis node once on the ring?
   *(Even key distribution; one point per node gives lumpy arcs.)*
4. Why does `hybrid` use `log(count)` instead of `count`? *(So a mega-popular
   all-time query can't drown out a fresh spike; log compresses the scale.)*
5. Where would this break at 100× the traffic? *(A single hot prefix pins one
   Redis node — the hot-key problem in DESIGN.md's "Known limits".)*

For the *why* behind each decision (and the alternatives that were rejected), read
[DESIGN.md](DESIGN.md). For measured numbers, [PERFORMANCE.md](PERFORMANCE.md).

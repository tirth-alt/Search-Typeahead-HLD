// GET /api/suggest?q=<prefix>&mode=count|hybrid
// Read path: cache-aside. On a miss, the in-memory trie serves the result and
// backfills the cache — the suggestion path never touches Postgres.
import { NextResponse } from 'next/server';
import { config, normalizeMode } from '@/lib/config';
import { recordSuggestLatency } from '@/lib/metrics';
import { getRuntime } from '@/lib/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const started = process.hrtime.bigint();
  const { searchParams } = new URL(req.url);
  const mode = normalizeMode(searchParams.get('mode'));
  const prefix = (searchParams.get('q') || '').toLowerCase().trim();

  const finish = () => recordSuggestLatency(Number(process.hrtime.bigint() - started) / 1e6);

  if (!prefix) {
    finish();
    return NextResponse.json({ prefix, mode, source: 'empty', suggestions: [] });
  }

  const { cache, trie } = await getRuntime();
  const { suggestions: cached, node, hit } = await cache.readSuggestions(prefix, mode);

  let suggestions;
  let source: 'cache' | 'trie';
  if (hit && cached) {
    suggestions = cached;
    source = 'cache';
  } else {
    suggestions = trie.getSuggestions(prefix, config.topK, mode);
    await cache.writeSuggestions(prefix, mode, suggestions, config.ttlSuggest);
    source = 'trie';
  }

  finish();
  return NextResponse.json({ prefix, mode, source, node, suggestions });
}

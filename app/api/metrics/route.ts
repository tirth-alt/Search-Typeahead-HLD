// GET /api/metrics — hit rate, DB read/write counts, write reduction, latency.
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { snapshot } from '@/lib/metrics';
import { getRuntime } from '@/lib/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const { trie, buffer } = await getRuntime();
  return NextResponse.json({
    ...snapshot(),
    trie_size: trie.size(),
    buffer_pending: buffer.pending(),
    cache_nodes: config.cacheNodes,
  });
}

// GET /api/cache/ring?sample=N — key distribution across cache nodes, to show
// the consistent-hash ring spreads keys roughly evenly.
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { getRuntime } from '@/lib/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sample = parseInt(searchParams.get('sample') || '2000', 10);

  // deterministic synthetic 3-letter prefixes — same key set every call
  const keys: string[] = [];
  for (let i = 0; i < sample; i++) {
    keys.push(
      ALPHABET[i % 26] +
        ALPHABET[Math.floor(i / 26) % 26] +
        ALPHABET[Math.floor(i / 676) % 26],
    );
  }

  const { cache } = await getRuntime();
  return NextResponse.json({
    nodes: config.cacheNodes,
    vnodes_per_node: config.vnodes,
    sample_size: sample,
    distribution: cache.getRing().distribution(keys),
  });
}

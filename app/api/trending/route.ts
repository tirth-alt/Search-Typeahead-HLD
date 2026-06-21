// GET /api/trending?n=10 — global top-N by decayed recent score.
import { NextResponse } from 'next/server';
import { getRuntime } from '@/lib/runtime';
import { getTrending } from '@/lib/trending';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const n = parseInt(searchParams.get('n') || '10', 10);
  const { cache } = await getRuntime();
  const top = await getTrending(cache, n);
  return NextResponse.json({
    trending: top.map((t) => ({ query: t.query, score: Math.round(t.score * 10000) / 10000 })),
  });
}

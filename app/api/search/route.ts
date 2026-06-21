// POST /api/search  { "query": "..." }
// Synchronous acknowledgement; the count update behind it is asynchronous
// (write-back). The buffer aggregates and flushes on size or interval.
import { NextResponse } from 'next/server';
import { getRuntime } from '@/lib/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { buffer } = await getRuntime();
  buffer.add(String(body?.query || ''));
  return NextResponse.json({ message: 'Searched' });
}

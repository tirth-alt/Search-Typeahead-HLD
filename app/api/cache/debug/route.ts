// GET /api/cache/debug?prefix=<p>&mode=count|hybrid
// Which cache node owns the prefix, and whether it is currently HIT or MISS.
import { NextResponse } from 'next/server';
import { normalizeMode } from '@/lib/config';
import { getRuntime } from '@/lib/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = normalizeMode(searchParams.get('mode'));
  const prefix = (searchParams.get('prefix') || '').toLowerCase().trim();
  const { cache } = await getRuntime();
  return NextResponse.json(await cache.describe(prefix, mode));
}

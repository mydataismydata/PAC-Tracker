/**
 * Committee name lookup for the Know Your Mailer search box.
 *
 * Deliberately separate from `/api/entities/search`, which is behind the sign-in
 * gate and returns everything — including private individuals who gave $50 and
 * have a home address on file. This one is public, so it answers for committees
 * and parties only.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/db';
import { searchCommittees } from '@/lib/graph/committee';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  q: z.string().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(25).default(12),
});

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return Response.json({ error: 'invalid query' }, { status: 400 });

  try {
    return Response.json({ results: await searchCommittees(db, parsed.data.q, parsed.data.limit) });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

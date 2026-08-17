/**
 * Summary of a person named on committee filings.
 *
 * `key` is `role:normalizedName` — the same id the crawler gives an officer hub
 * node, minus the `officer:` prefix, so a hub selected on the canvas resolves
 * itself with what it already has.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/db';
import { officerSubject, parseOfficerKey } from '@/lib/graph/officers';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ cycle: z.string().max(32).optional() });

export async function GET(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const parts = parseOfficerKey(decodeURIComponent(key));
  if (!parts) return Response.json({ error: 'invalid officer key' }, { status: 400 });

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return Response.json({ error: 'invalid query' }, { status: 400 });

  try {
    const subject = await officerSubject(db, parts.role, parts.normalizedName, parsed.data.cycle);
    if (!subject) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(subject);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

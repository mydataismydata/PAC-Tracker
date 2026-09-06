/**
 * The crawl parameters, defined once for every route that accepts them.
 *
 * Two endpoints take the same settings object. The graph stream reads it from
 * a query string, and saved searches store it from a JSON body. Each carried
 * its own copy of the rules and the copies drifted: link mode grew a third
 * value and the cycle filter arrived, so saving a registration crawl failed
 * with "invalid body" while the identical crawl ran, and a saved cycle was
 * dropped on the way into the database.
 *
 * Numbers are coerced because query values arrive as strings. A JSON body
 * sends real numbers, and coercion passes those through unchanged.
 */

import { z } from 'zod';
import { DIRECTION_VALUES, LINK_MODE_VALUES } from '@/lib/graph/types';
import { CRAWL_DEFAULTS } from '@/lib/graph/crawl';

export const crawlParamsSchema = z.object({
  depth: z.coerce.number().int().min(1).max(6).default(CRAWL_DEFAULTS.depth),
  direction: z.enum(DIRECTION_VALUES).default(CRAWL_DEFAULTS.direction),
  linkMode: z.enum(LINK_MODE_VALUES).default(CRAWL_DEFAULTS.linkMode),
  minAmount: z.coerce.number().min(0).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Restrict edges and tile totals to one election cycle. */
  cycle: z.string().max(32).optional(),
  maxPerNode: z.coerce.number().int().min(1).max(200).default(CRAWL_DEFAULTS.maxPerNode),
  maxNodes: z.coerce.number().int().min(10).max(5000).default(CRAWL_DEFAULTS.maxNodes),
});

export type CrawlParams = z.infer<typeof crawlParamsSchema>;

// The insight group (v0.16.0): what a site counted about its own pages, read only.

import { z } from "zod";

export const NotFoundQuery = z.object({
  /** UTC days back, today included; 90 is what site-runtime's `pruneNotFound` keeps by default. */
  days: z.coerce.number().int().min(1).max(90).default(30),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** "true" adds the paths exploit scanners guess (wp-admin, .php, /.env); left out otherwise. */
  includeProbes: z.enum(["true", "false"]).default("false"),
});

/** One missing path: site-runtime's `NotFoundReportRow`. */
export const NotFoundRow = z.object({
  /** site-runtime stores at most 512 characters of it. */
  path: z.string().min(1).max(512),
  /** probe: a path an exploit scanner guesses. page: anything else, such as a broken link or a moved page. */
  kind: z.enum(["page", "probe"]),
  hits: z.number().int().min(0),
  /** The hosts that linked to it, most hits first; "" is no referrer. Only the host is ever kept. */
  referrers: z.array(z.object({ host: z.string().max(253), hits: z.number().int().min(0) })),
});

/** Most hits first, at most `limit` rows. */
export const NotFoundReport = z.object({
  rows: z.array(NotFoundRow),
});

export type NotFoundQuery = z.infer<typeof NotFoundQuery>;
export type NotFoundRow = z.infer<typeof NotFoundRow>;
export type NotFoundReport = z.infer<typeof NotFoundReport>;

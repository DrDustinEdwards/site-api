// The ids, versions and text every group of the contract shares.

import { z } from "zod";

/** Opaque to Carrel: each site decides what a version is. It should identify the item's own content (dustinedwards.info uses the git blob sha of the item's own file). */
export const Version = z.string().min(1).max(200);

/** Carrel's id for one change, carried into the site's commit or row so the two records join. */
export const ChangeId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** A site's id for one piece of content: a slug, or a row id. Never a path. */
export const ContentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);

export const Timestamp = z.iso.datetime({ offset: true });

/** Two million characters: far above any article, far below a Worker's memory. */
export const Source = z.string().max(2_000_000);

export const SortDir = z.enum(["asc", "desc"]);

export const SiteInfo = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  name: z.string().min(1).max(200),
  origin: z.url(),
});

export type SiteInfo = z.infer<typeof SiteInfo>;
export type SortDir = z.infer<typeof SortDir>;

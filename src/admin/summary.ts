// Many sites at once: a small count per site for an inbox line.

import type { ContentSource } from "./kit.js";


export interface SiteSummary {
  site: { id: string; name: string };
  /** Mentions waiting for a decision; null when the site does not moderate mentions here. */
  mentionsWaiting: number | null;
  /** Posts the host has something waiting on (Carrel's AI drafts); null when the host does not say. */
  postsWaiting: number | null;
  /** Files with no alt text; null where the site cannot say. */
  mediaWithoutAlt: number | null;
}

/** A small count for one site, for an inbox line that links to the list. */
export async function summary(source: ContentSource): Promise<SiteSummary> {
  const capabilities = (await source.client.meta()).capabilities;
  const mentionsWaiting = capabilities.mentions === true ? (await source.client.mentions.list({ status: "pending", limit: 1 })).counts.pending : null;
  // A site that answers the no-alt lens (v0.6.0) and counts can say how many files lack alt text.
  const mediaWithoutAlt =
    capabilities.media === true && (capabilities.mediaLenses ?? []).includes("no-alt")
      ? ((await source.client.media.list({ lens: "no-alt", limit: 1 })).total ?? null)
      : null;
  return {
    site: { id: source.site.id, name: source.site.name },
    mentionsWaiting,
    postsWaiting: source.waiting ? await source.waiting() : null,
    mediaWithoutAlt,
  };
}

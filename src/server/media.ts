// The media routes, mounted only when the site's adapter has media.

import { type MediaAdapter } from "../adapter.js";
import { MediaId } from "../contract.js";
import type { SiteApiStore } from "../store.js";
import { pathParam, type Log, type Route } from "./http.js";
import { bulkRoutes } from "./media/bulk.js";
import { fileRoutes } from "./media/files.js";
import { mediaHelpers } from "./media/helpers.js";
import { listingRoutes } from "./media/listing.js";

export function mediaRoutes(
  media: MediaAdapter,
  log: Log,
  siteStore?: Pick<SiteApiStore, "uploadedMedia" | "putUploadedMedia">,
): Route[] {
  const ctx = {
    media,
    log,
    siteStore,
    mediaId: (m: RegExpMatchArray) => pathParam(m[1], MediaId, "media id"),
    ...mediaHelpers(media, log, siteStore),
  };
  return [...listingRoutes(ctx), ...fileRoutes(ctx), ...bulkRoutes(ctx)];
}

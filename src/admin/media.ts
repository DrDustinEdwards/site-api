// The media half of the content kit: MediaLibrary's view data and its intents.

import type {
  MediaDetail,
  MediaKind,
  MediaLens,
  MediaOrientation,
  MediaResize,
  MediaRevision,
  MediaSort,
  MediaUploadLimits,
  SortDir,
} from "../contract.js";
import type { MediaRow, MediaSuggestionView } from "./media/data.js";
import type { Permissions } from "./kit.js";

export { loadMedia, loadMediaChanges, readMediaQuery } from "./media/data.js";
export { runMediaIntent } from "./media/intents.js";

export interface MediaQuery {
  q?: string;
  tag?: string;
  view?: "library" | "trash";
  /** v0.6.0, where the site names the lens; dropped, never sent, where it does not. */
  lens?: MediaLens;
  sort?: MediaSort;
  dir?: SortDir;
  cursor?: string;
  /** The file open in the inspector. */
  inspect?: string;
  /** v0.13.0, where the site filters (offers.filters); dropped, never sent, where it does not. */
  orientation?: MediaOrientation;
  kind?: MediaKind;
  /** v0.13.0: ask the site's model about the file in the inspector (offers.suggestions), as a "Suggest" link does. */
  suggest?: boolean;
}

export interface MediaData {
  site: { id: string; name: string };
  query: MediaQuery;
  rows: MediaRow[];
  page: {
    nextCursor: string | null;
    total?: number;
    /** True when the rows were sorted on this page only, because the site's list does not sort. */
    sortedOnPage?: boolean;
    /** v0.13.0, where offers.live: the point to poll from with loadMediaChanges. */
    changeCursor?: string;
  };
  /**
   * The file in the inspector with every place it is used; null when the site has no such file. v0.13.0: its earlier bytes
   * where offers.history, and the model's suggestions where the query asked for them.
   */
  detail?:
    | (MediaDetail & {
        src: string;
        orientation?: MediaOrientation;
        history?: MediaRevision[];
        suggestions?: MediaSuggestionView | null;
      })
    | null;
  offers: {
    /** False on a site with no media manager: every other offer is then false. */
    media: boolean;
    upload: MediaUploadLimits | null;
    alt: boolean;
    tags: boolean;
    trash: boolean;
    delete: boolean;
    /** The lenses the site answers (v0.6.0); empty where it answers none. */
    lenses: MediaLens[];
    /** v0.10.0: the site keeps a focal point, keeps a caption, and replaces a file's bytes under its own address. */
    focus: boolean;
    caption: boolean;
    replace: boolean;
    /** v0.11.0: a replace must keep the picture's size (capabilities.mediaReplaceKeepsSize), so a crop is saved as a new file. */
    replaceKeepsSize: boolean;
    // v0.13.0, each false (or null) where the site lacks it.
    /** An upload of bytes the site holds answers that file; details carry twins; the duplicates lens may be offered. */
    duplicates: boolean;
    /** Rows carry usedCount, and the site sorts by `used` (the kit sorts the page where it does not). */
    usage: boolean;
    /** The orientation and kind filters. */
    filters: boolean;
    /** The `import` intent. */
    import: boolean;
    /** The `credit` intent, and rows carry credit, license, sourceUrl and licenseExpires. */
    credit: boolean;
    /** The `transform` intent. */
    transform: boolean;
    /** The inspector's history, and the `revert` intent. */
    history: boolean;
    /** loadMediaChanges, for a screen that polls for what others changed. */
    live: boolean;
    /** What uploads shrink to, and the upload's `resize=no` box. */
    resize: MediaResize | null;
    /** The `resize` intent over stored pictures (the `oversized` lens lists them). */
    resizePass: boolean;
    /** The site fills credit, license, caption and taken date from embedded metadata at upload. */
    embedded: boolean;
    /** The query's `suggest`. */
    suggestions: boolean;
    /** v0.19.0: the `suggest` intent, the model's alt text and tags for a file before it is uploaded or imported. */
    uploadSuggestions: boolean;
  };
  can: Permissions;
}

/** What changed on the site since a cursor (v0.13.0), for a screen that polls: rows to put in place, ids to take out. */
export interface MediaChangesData {
  rows: MediaRow[];
  removed: string[];
  /** Where the next poll starts. */
  changeCursor: string;
  /** True when more changes wait: poll again at once. */
  more: boolean;
}

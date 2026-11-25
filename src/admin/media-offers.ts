// What a site's media library offers, read from its capabilities.

import type { Capabilities, MediaLens, MediaResize, MediaUploadLimits } from "../contract.js";

export interface MediaOffers {
  /** False on a site with no media manager: every other offer is then false. */
  media: boolean;
  upload: MediaUploadLimits | null;
  alt: boolean;
  tags: boolean;
  trash: boolean;
  delete: boolean;
  /** The lenses the site answers; empty where it answers none. */
  lenses: MediaLens[];
  /** The site keeps a focal point, keeps a caption, and replaces a file's bytes under its own address. */
  focus: boolean;
  caption: boolean;
  replace: boolean;
  /** A replace must keep the picture's size (capabilities.mediaReplaceKeepsSize), so a crop is saved as a new file. */
  replaceKeepsSize: boolean;
  // Each false (or null) where the site lacks it.
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
  /** The `suggest` intent, the model's alt text and tags for a file before it is uploaded or imported. */
  uploadSuggestions: boolean;
}

export function mediaOffers(capabilities: Capabilities): MediaOffers {
  const media = capabilities.media === true && capabilities.mediaUpload !== undefined;
  return {
    media,
    upload: media ? capabilities.mediaUpload! : null,
    alt: media && capabilities.mediaAlt === true,
    tags: media && capabilities.mediaTags === true,
    trash: media && capabilities.mediaTrash === true,
    delete: media,
    lenses: media ? [...(capabilities.mediaLenses ?? [])] : [],
    focus: media && capabilities.mediaFocus === true,
    caption: media && capabilities.mediaCaption === true,
    replace: media && capabilities.mediaReplace === true,
    replaceKeepsSize:
      media && capabilities.mediaReplace === true && capabilities.mediaReplaceKeepsSize === true,
    duplicates: media && capabilities.mediaDuplicates === true,
    usage: media && capabilities.mediaUsage === true,
    filters: media && capabilities.mediaFilters === true,
    import: media && capabilities.mediaImport === true,
    credit: media && capabilities.mediaCredit === true,
    transform: media && capabilities.mediaTransform === true,
    history: media && capabilities.mediaHistory === true,
    live: media && capabilities.mediaChanges === true,
    resize: media ? (capabilities.mediaResize ?? null) : null,
    resizePass:
      media && capabilities.mediaResize !== undefined && capabilities.mediaResizePass === true,
    embedded: media && capabilities.mediaEmbedded === true,
    suggestions: media && capabilities.mediaSuggestions === true,
    uploadSuggestions: media && capabilities.mediaUploadSuggestions === true,
  };
}

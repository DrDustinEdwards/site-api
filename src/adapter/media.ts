// What a site implements for its media library: the upload, the replace and the adapter methods.

import type { MediaSuggestion } from "../media-kit.js";
import type {
  MediaDetail,
  MediaItem,
  MediaList,
  MediaLens,
  MediaListQuery,
  MediaEmbeddedField,
  MediaResize,
  MediaRevision,
  MediaTransformOp,
  MediaUploadLimits,
} from "../contract.js";

/** One upload, already checked by the package against the site's own limits and the file's bytes. */
export interface MediaUpload {
  bytes: Uint8Array;
  /** One of the site's declared types, without parameters. */
  contentType: string;
  filename: string;
  /** What the picture shows: "" only when `decorative` or, since v0.30.0, when none was sent yet; any alt is already checked by altRefusal. */
  alt: string;
  /** v0.19.0: true when the person said the picture is decorative, so its alt is "" on purpose. A site that keeps it answers `decorative`. */
  decorative?: boolean;
  changeId: string;
  /**
   * v0.13.0: the upload's duplicates key, lower case hex: since v0.21.0 duplicateKey's, the SHA-256 of the bytes without
   * their private metadata, which is the stored bytes' hash unless the site converts or shrinks the picture (findByHash,
   * the duplicates lens, twins). The package always sends it; optional only so a site's own code can call upload without it.
   */
  sha256?: string;
  /** v0.13.0: true when the site shrinks the picture to its `resize`; false or absent when it has none or the upload said `resize=no`. */
  resize?: boolean;
  /** v0.13.0: on an import, the address it was fetched from, for the file's `sourceUrl`. */
  sourceUrl?: string;
}

/** What an upload answers (v0.13.0): the stored file, and, where they apply, what the site did with it. */
export type MediaUploaded = MediaItem & {
  /** The fields the site filled from the file's embedded metadata (IPTC, EXIF), each only where it was empty. */
  embedded?: MediaEmbeddedField[];
  /** The picture's size before the site shrank it. */
  resizedFrom?: { width: number; height: number; bytes: number };
};

/**
 * The media group (v0.2.0). Files stay in the site's own storage and are served by the site; Carrel
 * only lists, uploads and asks for deletes. The site's reference check decides every delete.
 */
export interface MediaAdapter {
  /** What the site accepts. The package refuses any other type, and anything larger, unread. */
  limits: MediaUploadLimits;
  /**
   * Optional (v0.6.0): the lenses `list` answers. A site that names any also sorts by `sort` and `dir`
   * and says so in the answer's `sorted`. The package answers a lens not named here with 501.
   */
  lenses?: readonly MediaLens[];
  /**
   * Optional (v0.11.0): true when `replace` refuses new bytes whose picture is not the old one's size (RefusedError),
   * because the site's addresses or pages are sized by it. The package says so in capabilities.mediaReplaceKeepsSize.
   * It does not rule out `shrink` (v0.22.0): a shrink that keeps the proportions still fits the boxes pages drew, and the
   * package checks it did. A site whose addresses carry the size leaves `shrink` out.
   */
  replaceKeepsSize?: boolean;
  /**
   * Optional (v0.13.0): true when items carry `usedCount` from the site's reference check and `list` sorts by `used`
   * (capabilities.mediaUsage). Absent: `sort=used` answers 501.
   */
  usage?: boolean;
  /** Optional (v0.13.0): true when `list` applies `orientation` and `kind` (capabilities.mediaFilters). Absent: either answers 501. */
  filters?: boolean;
  /**
   * Optional (v0.13.0): what the site shrinks large pictures to (capabilities.mediaResize). `upload` gets `resize: true` and
   * shrinks a picture whose longer edge is over `maxEdge`, keeping its proportions, and answers `resizedFrom`.
   */
  resize?: MediaResize;
  /** Optional (v0.13.0): true when `upload` fills empty credit, license, caption and takenAt from embedded metadata and names them in `embedded`. */
  readsEmbedded?: boolean;
  /**
   * Optional (v0.13.0): the fetch the package imports with (capabilities.mediaImport), such as the Worker's own `fetch`. The
   * package checks the address, fetches it, checks the answer as an upload, and hands the bytes to `upload` with `sourceUrl`.
   */
  importFetch?: typeof fetch;
  list(query: MediaListQuery): Promise<MediaList>;
  /** The file and every place it is used. null when the id does not exist. */
  get(id: string): Promise<MediaDetail | null>;
  upload(input: MediaUpload): Promise<MediaUploaded>;
  /**
   * Deletes the file. Throws MediaInUseError naming each use when the site's reference check finds
   * one, NotFoundError for a missing id, and RefusedError when the check could not run: a delete the
   * site could not check is never made.
   */
  delete(id: string, input: { changeId: string }): Promise<void>;
  /**
   * Optional (v0.4.0), each answering 501 when absent. Every one throws VersionConflictError when
   * expectedVersion is not what the site holds, NotFoundError for a missing id and RefusedError when
   * the site's own rules refuse, and returns the file's version after the write. A file's version
   * identifies its editable metadata, so each write here moves it. The write and whatever must
   * follow it (a cache purge) are one unit, run together in the method.
   */
  setAlt?(
    id: string,
    input: { alt: string; decorative?: boolean; expectedVersion: string; changeId: string },
  ): Promise<{ version: string }>;
  /** `tags` is the whole set after the write, already in the contract's spelling. */
  setTags?(
    id: string,
    input: { tags: string[]; expectedVersion: string; changeId: string },
  ): Promise<{ version: string }>;
  /** Soft delete: hides the file from list and removes nothing. Both trash and restore, or neither. */
  trash?(
    id: string,
    input: { expectedVersion: string; changeId: string },
  ): Promise<{ version: string }>;
  restore?(
    id: string,
    input: { expectedVersion: string; changeId: string },
  ): Promise<{ version: string }>;
  /**
   * Optional (v0.10.0), each answering 501 when absent, and each throwing and moving the version like the writes above.
   * `focus` is already in the form site-runtime's ./image writes (`focusOf`), or null to clear it; a site on R2 keeps it
   * as the object's customMetadata `focus` (FOCUS_METADATA), which `writeFocus` from `@dustinedwards/site-api/r2` does.
   * Every item the site answers then carries `focus`.
   */
  setFocus?(
    id: string,
    input: { focus: string | null; expectedVersion: string; changeId: string },
  ): Promise<{ version: string }>;
  /** Every item the site answers then carries `caption` ("" for none). */
  setCaption?(
    id: string,
    input: { caption: string; expectedVersion: string; changeId: string },
  ): Promise<{ version: string }>;
  /**
   * Optional (v0.10.0): replaces the file's bytes under the same id and address, so every page that uses it shows the
   * new one. The package has already checked the bytes against the site's limits, that the file exists, that its version
   * is `expectedVersion`, that it is `deletable` (the site's own static assets are never replaced) and that `contentType`
   * is the file's own type. The site keeps alt, caption and tags, clears the focal point (it named a place in the old
   * picture), measures the new picture, moves the version, and answers the item. `sizesNeedPurge` says whether its cache
   * may still serve sizes made from the old bytes: false when its image route keys the cache by the object's etag
   * (site-runtime ./image 0.27.0 and later), or when it purged them as part of the write. On R2, `replaceObject` from
   * `@dustinedwards/site-api/r2` writes the bytes and keeps the object's metadata.
   */
  replace?(id: string, input: MediaReplace): Promise<{ item: MediaItem; sizesNeedPurge: boolean }>;

  // ---------- v0.13.0, each optional, answering 501 when absent

  /**
   * The stored file whose bytes have this SHA-256 (capabilities.mediaDuplicates), trashed or not; null when none. The package
   * asks before every upload and import, and answers a match with that file and `duplicateOf`, so `upload` never runs for
   * bytes the site already holds. A site with it also answers the `duplicates` lens and `twins` on a detail.
   */
  findByHash?(sha256: string): Promise<MediaItem | null>;
  /**
   * Sets the file's credit, license, source and license end as one write, moving the version like the writes above. v0.19.0:
   * `copyright`, `licenseUrl` and `acquireLicenseUrl` where the write names them; a site that keeps them answers them on
   * every item, and one that does not ignores them.
   */
  setCredit?(
    id: string,
    input: {
      credit: string;
      license: string;
      sourceUrl: string | null;
      licenseExpires: string | null;
      copyright?: string;
      licenseUrl?: string | null;
      acquireLicenseUrl?: string | null;
      expectedVersion: string;
      changeId: string;
    },
  ): Promise<{ version: string }>;
  /**
   * Turns or mirrors the picture (capabilities.mediaTransform). The package has checked that the file exists, is at
   * `expectedVersion`, is `deletable` and is an image. In place (`asNewFile: false`): the same id and address, the old
   * bytes kept in the file's history, the focal point moved with the picture (`transformFocus`), and a new version. With
   * `asNewFile: true`, which the package sends for a quarter turn of a picture that is not square on a site whose
   * `replaceKeepsSize`, the site stores the turned picture as a new file (alt, caption, tags and credit copied) and leaves
   * the old one as it was. Throws RefusedError for a picture it cannot turn, such as an SVG.
   */
  transform?(
    id: string,
    input: { op: MediaTransformOp; asNewFile: boolean; expectedVersion: string; changeId: string },
  ): Promise<{ item: MediaItem; sizesNeedPurge: boolean }>;
  /** The file's byte history, newest first, exactly one `current` (capabilities.mediaHistory, with `revert`). null when the id does not exist. */
  history?(id: string): Promise<MediaRevision[] | null>;
  /**
   * Puts earlier bytes back under the same id and address, as a new revision (so a revert is itself undone by another).
   * The package has checked the file and its version, that `to` is in the history and is not current, and, on a site whose
   * `replaceKeepsSize`, that its size is the current one's. Alt, caption, tags and credit stay; the focal point is cleared.
   */
  revert?(
    id: string,
    input: { to: string; expectedVersion: string; changeId: string },
  ): Promise<{ item: MediaItem; sizesNeedPurge: boolean }>;
  /**
   * Every file changed since `since`, a `changeCursor` the site answered on a list (capabilities.mediaChanges: with it,
   * every `list` answer carries `changeCursor`). A change is any write that moves a file's version or bytes, an upload,
   * and a delete for good (`removed`). Each file once, as it is now, trashed ones included; at most `limit` files and
   * removed ids together, the oldest changes first, `more` when others wait. `cursor` is where the next poll starts.
   * Throws RefusedError for a cursor it can no longer answer from, and the screen reloads its page.
   */
  changes?(input: {
    since: string;
    limit: number;
  }): Promise<{ items: MediaItem[]; removed: string[]; cursor: string; more: boolean }>;
  /**
   * Shrinks one stored picture to `resize` (capabilities.mediaResizePass), in place, keeping the old bytes where the site
   * keeps history. Throws VersionConflictError, NotFoundError or RefusedError like the writes; `resized: false` and the
   * same version for a picture already within the size. On a site whose `replaceKeepsSize` (v0.22.0) the shrink must keep the
   * picture's proportions and only make it smaller, which the package checks; a site whose addresses carry the size leaves it out.
   */
  shrink?(
    id: string,
    input: { expectedVersion: string; changeId: string },
  ): Promise<{ resized: boolean; item: MediaItem }>;
  /**
   * What the site's model suggests for the file (capabilities.mediaSuggestions): tags and alt text, never applied. The
   * model is the site's choice (on Dustin's sites, Claude Haiku 5.5 straight at Anthropic). null when the id does not
   * exist. The package keeps the tags that are tags in the contract's spelling, at most 12.
   */
  suggest?(id: string): Promise<MediaSuggestion | null>;
  /**
   * Optional (v0.19.0, capabilities.mediaUploadSuggestions): what the site's model suggests for a file not yet stored, so the
   * upload form fills its alt field with a suggestion the person keeps, changes or replaces before the upload. The package
   * has checked the bytes as an upload's. Nothing is stored. With `mediaSuggester`:
   * `suggestFile: ({ bytes }) => suggest(env, new Response(toArrayBuffer(bytes)).body!)`.
   */
  suggestFile?(input: { bytes: Uint8Array; contentType: string }): Promise<MediaSuggestion>;
}

/** One replace (v0.10.0), already checked by the package. */
export interface MediaReplace {
  bytes: Uint8Array;
  /** The file's own type, without parameters. */
  contentType: string;
  /** The name the new file was sent with. */
  filename: string;
  expectedVersion: string;
  changeId: string;
}

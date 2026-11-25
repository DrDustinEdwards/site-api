// The media library: the whole media group over a site's index rows and its R2 bucket, written once. A site
// passes `mediaLibrary` its store, bucket and rules and keeps no adapter of its own.
//
// VERSIONS. A file's version is its row's `rev` (mediaVersion). Every write to its metadata or bytes moves it once, in the
// statement that checks it (the store's writeAtRev), so a stale write is a 409, never a lost update. A write that changes
// the object checks the version before any costly work, claims it (the rev moves first), then changes the object, then the
// row's byte columns (`follow`, which does not move the rev again).
//
// BYTES. A replace, turn, mirror, shrink or revert first keeps the bytes it overwrites as a copy (`history`) and records
// it on the file's revisions, so each one can be taken back. One put writes the new bytes with the object's metadata and
// the focal point that goes with them, conditional on the etag read, so nothing races it unseen.
//
// DELETES. The site's reference check runs first and refuses a file in use; the store's `remove` takes the row and its
// revisions in one batch (and may refuse atomically, against the site's own tables); then the object goes. Copies kept in
// the served bucket go with it; copies kept in a separate backups bucket stay, as backups.

import { type MediaAdapter } from "./adapter.js";
import { type MediaLibraryOptions } from "./media-library/types.js";
import { libraryCore } from "./media-library/core.js";
import { readMethods } from "./media-library/reads.js";
import { writeMethods } from "./media-library/writes.js";
export type {
  MediaBucket,
  MediaKeyInput,
  MediaLibraryEvent,
  MediaLibraryOptions,
  MediaLibraryStore,
  MediaObject,
  MediaRecord,
  MediaRecordFields,
  MediaRecordWrite,
  MediaRevisionReason,
  MediaRevisionRecord,
} from "./media-library/types.js";
export {
  PICTURE_RESIZE,
  PICTURE_TYPES,
  datedKey,
  extensionFor,
  pictureLimits,
} from "./media-library/constants.js";

export function mediaLibrary(options: MediaLibraryOptions): MediaAdapter {
  const core = libraryCore(options);
  const { resize, lenses } = core;
  const adapter: MediaAdapter = {
    limits: options.limits,
    lenses,
    filters: true,
    readsEmbedded: true,
    ...(options.replaceKeepsSize ? { replaceKeepsSize: true } : {}),
    ...(options.usage ? { usage: true } : {}),
    ...(resize ? { resize } : {}),
    ...(options.importFetch !== null
      ? { importFetch: options.importFetch ?? ((input, init) => fetch(input, init)) }
      : {}),
    ...readMethods(core, options),
    ...writeMethods(core, options),
  };

  return adapter;
}

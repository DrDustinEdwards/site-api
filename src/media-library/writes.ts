import { editImage } from "@dustinedwards/site-runtime/image";

import {
  MediaInUseError,
  NotFoundError,
  RefusedError,
  type MediaAdapter,
  type MediaUploaded,
} from "../adapter.js";
import { type MediaEmbeddedField } from "../contract.js";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";
import { kindOf, transformFocus, turnsSize } from "../media.js";
import { mediaVersion, toArrayBuffer } from "../media-kit.js";
import { REENCODED, prepareUpload } from "../media-upload.js";
import type { Encoded } from "../media-upload.js";
import { type MediaLibraryOptions } from "./types.js";
import { ALL_REVISIONS, RACED, TRANSFORMS, TRANSFORM_QUALITY, positive } from "./constants.js";
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
} from "./types.js";
export {
  PICTURE_RESIZE,
  PICTURE_TYPES,
  datedKey,
  extensionFor,
  pictureLimits,
} from "./constants.js";

import type { LibraryCore } from "./types.js";

export function writeMethods(core: LibraryCore, options: MediaLibraryOptions) {
  const {
    store,
    bucket,
    images,
    resize,
    historyBucket,
    historyPrefix,
    historyServed,
    shrinks,
    keepsRights,
    usesOf,
    itemWithUse,
    recordOf,
    atVersion,
    write,
    moveTrash,
    claim,
    objectMetadata,
    prepare,
    measured,
    keepCopy,
    storeFile,
    swapBytes,
    looks,
    listed,
  } = core;
  return {
    async upload(input): Promise<MediaUploaded> {
      // The limits again: the route checked them, and a site's own upload path calling this did not.
      const prepared = measured(
        await prepareUpload(images, input, {
          limits: options.limits,
          ...(resize ? { resize } : {}),
        }),
      );
      const found = prepared.embedded;
      const embeddable: MediaEmbeddedField[] = [
        "credit",
        "license",
        "caption",
        "takenAt",
        ...(keepsRights ? (["copyright", "licenseUrl", "acquireLicenseUrl"] as const) : []),
      ];
      const embedded = embeddable.filter((field) => found[field]);
      const record = await storeFile({
        bytes: prepared.bytes,
        contentType: prepared.contentType,
        filename: prepared.filename,
        uploadSha256: prepared.uploadSha256,
        sha256: prepared.sha256,
        width: prepared.width,
        height: prepared.height,
        fields: {
          alt: input.alt,
          ...(input.decorative ? { decorative: true } : {}),
          caption: found.caption ?? "",
          credit: found.credit ?? "",
          license: found.license ?? "",
          takenAt: found.takenAt ?? null,
          copyright: found.copyright ?? "",
          licenseUrl: found.licenseUrl ?? null,
          acquireLicenseUrl: found.acquireLicenseUrl ?? null,
          sourceUrl: input.sourceUrl ?? null,
          placeholder: prepared.placeholder,
          color: prepared.color,
        },
        reason: input.sourceUrl ? "import" : "upload",
        ...(prepared.resizedFrom && prepared.original
          ? {
              original: {
                bytes: prepared.original,
                width: prepared.resizedFrom.width,
                height: prepared.resizedFrom.height,
              },
            }
          : {}),
      });
      await options.onWrite?.({ op: "upload", id: record.key, changeId: input.changeId });
      return {
        ...(await itemWithUse(record)),
        ...(embedded.length > 0 ? { embedded } : {}),
        ...(prepared.resizedFrom ? { resizedFrom: prepared.resizedFrom } : {}),
      };
    },

    // The reference check, then the rows (refused atomically where the store guards them), then the objects, so a failure
    // leaves only bytes nothing lists.
    async delete(id, input) {
      const record = await recordOf(id);
      const uses = await usesOf([id]);
      const using = uses.get(id) ?? [];
      if (using.length > 0) throw new MediaInUseError(using);
      const copies = historyServed
        ? (await store.revisions(id, ALL_REVISIONS)).flatMap((r) => (r.copyKey ? [r.copyKey] : []))
        : [];
      if (!historyServed) {
        // A backups bucket keeps the last bytes too, so a file deleted for good can still be put back by hand.
        const last = await bucket.get(id);
        if (last) {
          const bytes = new Uint8Array(await last.arrayBuffer());
          await keepCopy(id, await sha256Hex(bytes), bytes, record.contentType);
        }
      }
      const removed = await store.remove(id, record.rev);
      if (removed === "missing") throw new NotFoundError("No such media.");
      if (removed === "stale")
        throw new RefusedError(
          "The file changed while it was being deleted, so it was kept. Reload it, then delete it again.",
        );
      if (removed === "in-use") {
        const now_ = (await usesOf([id])).get(id) ?? [];
        if (now_.length > 0) throw new MediaInUseError(now_);
        throw new RefusedError(
          "The file came into use while it was being deleted, so it was kept. Check where it is used, then try again.",
        );
      }
      const extra = historyServed ? await listed(`${historyPrefix}${id}/`) : [];
      // The file first, then its copies, at most 1000 keys a call (R2's limit).
      await bucket.delete(id);
      const gone = [...new Set([...copies, ...extra])];
      for (let n = 0; n < gone.length; n += 1000) await bucket.delete(gone.slice(n, n + 1000));
      await options.onWrite?.({ op: "delete", id, changeId: input.changeId });
    },

    setAlt: (id, input) =>
      write("alt", id, input, {
        alt: input.alt,
        ...(input.decorative !== undefined ? { decorative: input.decorative } : {}),
      }),
    setTags: (id, input) => write("tags", id, input, { tags: input.tags }),
    trash: (id, input) => moveTrash("trash", id, input),
    restore: (id, input) => moveTrash("restore", id, input),
    setCaption: (id, input) => write("caption", id, input, { caption: input.caption }),

    // The object's customMetadata `focus` is what site-runtime ./image crops around. Claimed first, then the object, then
    // the row.
    async setFocus(id, input) {
      const record = await recordOf(id);
      atVersion(record, input.expectedVersion);
      const object = await bucket.get(id);
      if (!object) throw new NotFoundError("No such media.");
      const claimed = await claim(id, input.expectedVersion);
      const after = { ...claimed, focus: input.focus };
      const written = await bucket.put(id, await object.arrayBuffer(), {
        ...(object.httpMetadata ? { httpMetadata: object.httpMetadata } : {}),
        customMetadata: objectMetadata(after, object.customMetadata),
        onlyIf: { etagMatches: object.etag },
      });
      if (!written) throw new RefusedError(RACED);
      await store.follow(id, { focus: input.focus });
      await options.onWrite?.({ op: "focus", id, changeId: input.changeId });
      return { version: mediaVersion(claimed.rev) };
    },

    setCredit: (id, input) =>
      write("credit", id, input, {
        credit: input.credit,
        license: input.license,
        sourceUrl: input.sourceUrl,
        licenseExpires: input.licenseExpires,
        ...(input.copyright !== undefined ? { copyright: input.copyright } : {}),
        ...(input.licenseUrl !== undefined ? { licenseUrl: input.licenseUrl } : {}),
        ...(input.acquireLicenseUrl !== undefined
          ? { acquireLicenseUrl: input.acquireLicenseUrl }
          : {}),
      }),

    // The image route keys each cached size on the object's etag (site-runtime ./image), so no stored size of the old
    // bytes is served after a replace.
    async replace(id, input) {
      const record = await recordOf(id);
      atVersion(record, input.expectedVersion);
      const prepared = measured(
        await prepare(input.bytes, input.contentType, input.filename, input.changeId, false),
      );
      if (
        options.replaceKeepsSize &&
        (prepared.width !== positive(record.width) || prepared.height !== positive(record.height))
      ) {
        throw new RefusedError(
          `Pages on this site hold this picture's size (${record.width ?? "?"} by ${record.height ?? "?"}), and the new one is ${prepared.width ?? "?"} by ${prepared.height ?? "?"}. Upload it as a new file instead.`,
        );
      }
      const claimed = await claim(id, input.expectedVersion);
      const after = await swapBytes(
        claimed,
        {
          bytes: prepared.bytes,
          width: prepared.width,
          height: prepared.height,
          reason: "replace",
        },
        {
          focus: null,
          filename: input.filename.slice(0, 300),
          placeholder: prepared.placeholder,
          color: prepared.color,
        },
      );
      await options.onWrite?.({ op: "replace", id, changeId: input.changeId });
      return { item: await itemWithUse(after), sizesNeedPurge: false };
    },

    // In place, unless the package asks for a new file (a quarter turn of a picture that is not square, on a site whose
    // pages hold its size): then the turned picture is stored as a new file with the old one's words, and the old is kept.
    async transform(id, input) {
      const record = await recordOf(id);
      atVersion(record, input.expectedVersion);
      if (!REENCODED.has(record.contentType))
        throw new RefusedError(
          `A ${record.contentType} file is not turned here: a GIF may be animated, and an edit would keep one frame.`,
        );
      const object = await bucket.get(id);
      if (!object) throw new NotFoundError("No such media.");
      const edited = await editImage(images, object.body, {
        ...TRANSFORMS[input.op],
        quality: TRANSFORM_QUALITY,
        format: record.contentType as Encoded,
      });
      const bytes = new Uint8Array(await edited.arrayBuffer());
      const [width, height] = turnsSize(input.op)
        ? [record.height, record.width]
        : [record.width, record.height];
      const focus = transformFocus(record.focus, input.op);
      const { placeholder, color } = await looks(bytes, width);
      if (input.asNewFile) {
        const hash = await sha256Hex(bytes);
        const created = await storeFile({
          bytes,
          contentType: record.contentType,
          filename: record.filename ?? id.split("/").pop()!,
          uploadSha256: hash,
          sha256: hash,
          width,
          height,
          fields: {
            alt: record.alt,
            ...(record.decorative !== undefined ? { decorative: record.decorative } : {}),
            caption: record.caption,
            tags: record.tags,
            focus,
            credit: record.credit,
            license: record.license,
            sourceUrl: record.sourceUrl,
            licenseExpires: record.licenseExpires,
            takenAt: record.takenAt,
            ...(record.copyright !== undefined ? { copyright: record.copyright } : {}),
            ...(record.licenseUrl !== undefined ? { licenseUrl: record.licenseUrl } : {}),
            ...(record.acquireLicenseUrl !== undefined
              ? { acquireLicenseUrl: record.acquireLicenseUrl }
              : {}),
            placeholder,
            color,
          },
          reason: "transform",
        });
        await options.onWrite?.({
          op: "transform",
          id,
          changeId: input.changeId,
          newId: created.key,
        });
        return { item: await itemWithUse(created), sizesNeedPurge: false };
      }
      const claimed = await claim(id, input.expectedVersion);
      const after = await swapBytes(
        claimed,
        { bytes, width, height, reason: "transform" },
        { focus, placeholder, color },
      );
      await options.onWrite?.({ op: "transform", id, changeId: input.changeId });
      return { item: await itemWithUse(after), sizesNeedPurge: false };
    },

    // The package has checked that `to` is an earlier revision; its bytes come back from the copy kept, as a new
    // revision, so a revert is itself undone by another.
    async revert(id, input) {
      const record = await recordOf(id);
      atVersion(record, input.expectedVersion);
      const target = (await store.revisions(id, ALL_REVISIONS)).find(
        (r) => String(r.id) === input.to,
      );
      const copy = target?.copyKey ? await historyBucket.get(target.copyKey) : null;
      if (!target || !copy)
        throw new NotFoundError("This file has no such earlier version, or its copy is gone.");
      const bytes = new Uint8Array(await copy.arrayBuffer());
      const width = positive(target.width);
      const claimed = await claim(id, input.expectedVersion);
      const after = await swapBytes(
        claimed,
        { bytes, width, height: positive(target.height), reason: "revert" },
        { focus: null, ...(await looks(bytes, width)) },
      );
      await options.onWrite?.({ op: "revert", id, changeId: input.changeId });
      return { item: await itemWithUse(after), sizesNeedPurge: false };
    },

    ...(options.suggest
      ? {
          // Never applied: Carrel shows them, and a person accepts each as an alt or tags write.
          async suggest(id: string) {
            const record = await store.record(id);
            if (!record) return null;
            if (kindOf(record.contentType) !== "image")
              throw new RefusedError("Only a picture gets suggestions.");
            const object = await bucket.get(id);
            if (!object) return null;
            try {
              return await options.suggest!(object.body, id);
            } catch (error) {
              throw new RefusedError(
                `No suggestion was made: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          },
          async suggestFile({ bytes }: { bytes: Uint8Array; contentType: string }) {
            return options.suggest!(new Response(toArrayBuffer(bytes)).body!);
          },
        }
      : {}),

    ...(shrinks && resize
      ? {
          // In place, the old bytes kept in the history; a picture already within the size answers as it is, and so does a GIF
          // (prepareUpload shrinks none: it may be animated). The focal point stays: a shrink keeps the picture's proportions.
          shrink: async (id: string, input: { expectedVersion: string; changeId: string }) => {
            const record = await recordOf(id);
            atVersion(record, input.expectedVersion);
            if (
              Math.max(record.width ?? 0, record.height ?? 0) <= resize.maxEdge ||
              !REENCODED.has(record.contentType)
            )
              return { resized: false, item: await itemWithUse(record) };
            const object = await bucket.get(id);
            if (!object) throw new NotFoundError("No such media.");
            const prepared = await prepare(
              new Uint8Array(await object.arrayBuffer()),
              record.contentType,
              record.filename ?? id,
              input.changeId,
              true,
            );
            if (!prepared.resizedFrom) return { resized: false, item: await itemWithUse(record) };
            const claimed = await claim(id, input.expectedVersion);
            const after = await swapBytes(
              claimed,
              {
                bytes: prepared.bytes,
                width: prepared.width,
                height: prepared.height,
                reason: "resize",
              },
              { placeholder: prepared.placeholder, color: prepared.color },
            );
            await options.onWrite?.({ op: "resize", id, changeId: input.changeId });
            return { resized: true, item: await itemWithUse(after) };
          },
        }
      : {}),
  } satisfies Partial<MediaAdapter>;
}

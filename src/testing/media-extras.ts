import { NotFoundError, RefusedError, type MediaAdapter } from "../adapter.js";
import type { MediaTransformOp } from "../contract.js";
import { transformFocus, turnsSize } from "../media.js";

import { type StoredMedia } from "./shared.js";

import type { MediaExtrasContext } from "./media.js";

/** The v0.13.0 methods, as a site that offers every one of them would write them. */
export function extraMedia(ctx: MediaExtrasContext): Partial<MediaAdapter> {
  const {
    now,
    mediaStore,
    changeLog,
    lastSeq,
    logChange,
    dedupe,
    resize,
    heldMedia,
    touchMedia,
    nextMediaVersion,
    keepBytes,
    shrunk,
    shown,
  } = ctx;
  return {
    ...(dedupe
      ? {
          async findByHash(sha256: string) {
            const found = [...mediaStore.values()].find((m) => m.sha256 === sha256);
            return found ? shown(found.item) : null;
          },
        }
      : {}),
    async setCredit(id, input) {
      const {
        credit,
        license,
        sourceUrl,
        licenseExpires,
        copyright,
        licenseUrl,
        acquireLicenseUrl,
      } = input;
      const named = Object.entries({ copyright, licenseUrl, acquireLicenseUrl }).filter(
        ([, v]) => v !== undefined,
      );
      return touchMedia(heldMedia(id, input.expectedVersion), {
        credit,
        license,
        sourceUrl,
        licenseExpires,
        ...Object.fromEntries(named),
      });
    },
    // The reference adapter does not decode pictures, so a turn moves the size and the focal point and keeps the bytes.
    async transform(
      id,
      input: {
        op: MediaTransformOp;
        asNewFile: boolean;
        expectedVersion: string;
        changeId: string;
      },
    ) {
      const stored = heldMedia(id, input.expectedVersion);
      const { width, height } = stored.item;
      const size = turnsSize(input.op) ? { width: height, height: width } : { width, height };
      const focus = transformFocus(stored.item.focus ?? null, input.op);
      if (input.asNewFile) {
        const newId = id.replace(/(\.[a-z0-9]+)?$/, (ext) => `-${input.op}${ext}`);
        const copy: StoredMedia = {
          item: {
            ...stored.item,
            ...size,
            focus,
            id: newId,
            url: `/media/${newId}`,
            downloadUrl: `/media/${newId}`,
            version: nextMediaVersion(),
            uploadedAt: now().toISOString(),
          },
          bytes: stored.bytes,
        };
        keepBytes(copy, stored.bytes, size, "transform");
        mediaStore.set(newId, copy);
        logChange(newId);
        return { item: shown(copy.item), sizesNeedPurge: false };
      }
      keepBytes(stored, stored.bytes, size, "transform");
      touchMedia(stored, { ...size, focus });
      return { item: shown(stored.item), sizesNeedPurge: false };
    },
    async history(id) {
      const revisions = mediaStore.get(id)?.revisions;
      if (!revisions) return null;
      return revisions
        .map(({ data: _d, ...r }, n) => ({ ...r, current: n === revisions.length - 1 }))
        .reverse();
    },
    async revert(id, input) {
      const stored = heldMedia(id, input.expectedVersion);
      const target = stored.revisions?.find((r) => r.rev === input.to);
      if (!target) throw new NotFoundError("This file has no such earlier version.");
      stored.bytes = target.data;
      keepBytes(stored, target.data, target, "revert");
      touchMedia(stored, {
        bytes: target.bytes,
        width: target.width,
        height: target.height,
        focus: null,
      });
      return { item: shown(stored.item), sizesNeedPurge: false };
    },
    async changes({ since, limit }) {
      const from = Number(since);
      if (!Number.isInteger(from) || from < 0 || from > lastSeq())
        throw new RefusedError("That change cursor is not this site's; reload the library.");
      // Each file once, at its latest change, oldest first.
      const latest = new Map<string, number>();
      for (const entry of changeLog) if (entry.seq > from) latest.set(entry.id, entry.seq);
      const order = [...latest].sort((a, b) => a[1] - b[1]);
      const taken = order.slice(0, limit);
      const more = order.length > limit;
      return {
        items: taken
          .filter(([id]) => mediaStore.has(id))
          .map(([id]) => shown(mediaStore.get(id)!.item)),
        removed: taken.filter(([id]) => !mediaStore.has(id)).map(([id]) => id),
        cursor: String(more ? taken[taken.length - 1]![1] : lastSeq()),
        more,
      };
    },
    ...(resize
      ? {
          async shrink(id: string, input: { expectedVersion: string; changeId: string }) {
            const stored = heldMedia(id, input.expectedVersion);
            const small = shrunk(stored.item.width, stored.item.height);
            if (!small) return { resized: false, item: shown(stored.item) };
            keepBytes(stored, stored.bytes, small, "resize");
            touchMedia(stored, small);
            return { resized: true, item: shown(stored.item) };
          },
        }
      : {}),
    // What a model might say, made from the file name, so tests see suggestions without one.
    async suggest(id) {
      const item = mediaStore.get(id)?.item;
      if (!item) return null;
      const words = (item.filename ?? id)
        .replace(/\.[^.]*$/, "")
        .split(/[^A-Za-z]+/)
        .filter((w) => w.length >= 3);
      return {
        tags: words.map((w) => w.toLowerCase()),
        alt: words.length > 0 ? `A picture of ${words.join(" ").toLowerCase()}.` : null,
        model: "memory-suggester",
      };
    },
    // Before an upload there is no name to go on: the model's answer is the file's size.
    async suggestFile({ bytes }) {
      return {
        tags: ["upload"],
        alt: `A picture of ${bytes.byteLength} bytes.`,
        model: "memory-suggester",
      };
    },
  };
}

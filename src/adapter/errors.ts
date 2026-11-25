import type { MediaUse } from "../contract.js";

/** The expectedVersion on a write is not what the site holds. currentVersion null: no such id. */
export class VersionConflictError extends Error {
  constructor(
    readonly currentVersion: string | null,
    message = "The content changed since it was loaded.",
  ) {
    super(message);
    this.name = "VersionConflictError";
  }
}

export class NotFoundError extends Error {
  constructor(message = "No such content.") {
    super(message);
    this.name = "NotFoundError";
  }
}

/** The site's reference check found the file in use: the delete is refused, naming every use. */
export class MediaInUseError extends Error {
  constructor(
    readonly usedBy: MediaUse[],
    message?: string,
  ) {
    super(message ?? `The file is in use: ${describeUses(usedBy)}. Remove it from each first.`);
    this.name = "MediaInUseError";
  }
}

/** "Title (detail); Other (detail)", one entry per use, for the refusal a writer reads. */
export function describeUses(uses: MediaUse[]): string {
  return uses.map((u) => `${u.title || u.id} (${u.detail})`).join("; ");
}

/** The site's own rules refused the write, such as a render failure or a policy. Shown to the writer. */
export class RefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedError";
  }
}

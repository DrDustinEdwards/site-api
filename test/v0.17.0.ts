// What v0.17.0 and v0.22.0 add to the contract, in one place for each earlier contract's test (contract-v*.test.ts):
// optional properties, one error code each at the end of the enum, new schemas and new routes. Nothing earlier changes.

const V0170_CAPABILITIES = [
  "contentPublishedAt",
  "contentFilters",
  "contentRename",
  "contentTrash",
  "postFields",
  "previewLinks",
  "render",
  "replay",
  "searchFields",
];

/** The schemas v0.17.0 extends and the optional properties each gains; [] for one that changes only through a schema it holds. */
export const V0170_ADDED: Record<string, string[]> = {
  Capabilities: V0170_CAPABILITIES,
  Meta: [],
  ErrorBody: ["detail", "status", "title", "type"],
  PublishInput: ["publishedAt"],
  ContentSummary: ["authors", "excerpt", "trashedAt"],
  ContentDoc: ["authors", "excerpt", "trashedAt"],
  ListQuery: ["author", "kind", "publishedAfter", "publishedBefore", "tag", "trashed"],
  ContentList: ["filtered"],
  Revision: ["authors"],
  RevisionList: [],
};

/**
 * v0.22.0: `actor` on every JSON write body and `actorName` on every write query (C2), `field` on an unknown-field error,
 * and three capabilities. Only the schemas an earlier fixture holds are checked against it.
 */
const ACTOR = ["actor"];
const ACTOR_NAME = ["actorName"];
export const V0220_ADDED: Record<string, string[]> = {
  // contentTranscript and transcriptVersion are v0.36.0, listed here for the same reason as transcript.
  Capabilities: ["backlinks", "contentHasDraft", "contentTranscript", "hooks", "previewLinkHours"],
  ErrorBody: ["field"],
  ContentSummary: ["hasDraft"],
  // transcript is v0.33.0: the one read-only property after v0.22.0, listed here so each earlier contract test sees it.
  ContentDoc: ["hasDraft", "transcript", "transcriptVersion"],
  SaveDraftInput: ACTOR,
  PublishInput: ACTOR,
  ScheduleInput: ACTOR,
  UnpublishInput: ACTOR,
  ContentTagsInput: ACTOR,
  ContentDeleteQuery: ACTOR_NAME,
  ScheduleCancelQuery: ACTOR_NAME,
  MediaAltInput: ACTOR,
  MediaTagsInput: ACTOR,
  MediaTrashInput: ACTOR,
  MediaFocusInput: ACTOR,
  MediaCaptionInput: ACTOR,
  MediaBulkInput: ACTOR,
  MediaTrashEmptyInput: ACTOR,
  MediaImportInput: ACTOR,
  MediaCreditInput: ACTOR,
  MediaTransformInput: ACTOR,
  MediaRevertInput: ACTOR,
  MediaResizePassInput: ACTOR,
  MediaUploadQuery: ACTOR_NAME,
  MediaDeleteQuery: ACTOR_NAME,
  MediaReplaceQuery: ACTOR_NAME,
  MentionDecideInput: ACTOR,
  MentionSweepInput: ACTOR,
  MentionDeleteQuery: ACTOR_NAME,
};

export const V0170_CODES = ["in-progress", "unknown-field"];

/** The enums v0.17.0 widens, for additiveOnly. ErrorCode itself is checked with `widened`. */
export const V0170_WIDEN: Record<string, readonly string[]> = { "ErrorBody.error": V0170_CODES };

export const V0170_SCHEMAS = [
  "AuthorName",
  "ContentTrashInput",
  "PreviewLink",
  "PreviewLinkInput",
  "PreviewLinkList",
  "PreviewLinkListQuery",
  "PreviewLinkRevokeQuery",
  "PreviewLinkRevokeResult",
  "RenameInput",
  "RenameResult",
  // v0.22.0
  "Actor",
  "ActorName",
  "Backlink",
  "BacklinkList",
  "HookRun",
  "HookRunList",
  "HookRunsQuery",
  // v0.36.0
  "TranscriptInput",
  "TranscriptText",
  "TranscriptWriteResult",
];

/** The routes v0.17.0 adds, in the route table's order, after every earlier one. */
export const V0170_ROUTES = [
  "POST /content/:id/rename",
  "POST /content/:id/trash",
  "POST /content/:id/restore",
  "POST /preview-links",
  "GET /preview-links",
  "DELETE /preview-links/:linkId",
];

/** The routes v0.22.0 adds, after the 404 report. */
export const V0220_ROUTES = [
  "GET /content/:id/backlinks",
  "GET /hooks/recent",
  // v0.36.0
  "PUT /content/:id/transcript",
];

/** An earlier test's own additions with v0.17.0's merged in, each list sorted. */
export function withV0170(added: Record<string, string[]>): Record<string, string[]> {
  const merged: Record<string, string[]> = { ...added };
  for (const [name, props] of Object.entries(V0170_ADDED))
    merged[name] = [...new Set([...(merged[name] ?? []), ...props])].sort();
  return merged;
}

/** The same with v0.22.0's additions merged in, for the schemas the fixture holds. */
export function withV0220(
  added: Record<string, string[]>,
  fixture: Record<string, unknown>,
): Record<string, string[]> {
  const merged: Record<string, string[]> = { ...added };
  for (const [name, props] of Object.entries(V0220_ADDED))
    if (name in fixture) merged[name] = [...new Set([...(merged[name] ?? []), ...props])].sort();
  return merged;
}

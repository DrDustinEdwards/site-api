// What v0.17.0 and v0.19.0 add to the contract, in one place for each earlier contract's test (contract-v*.test.ts):
// optional properties, one error code each at the end of the enum, new schemas and new routes. Nothing earlier changes.

export const V0170_CAPABILITIES = ["contentPublishedAt", "contentFilters", "contentRename", "contentTrash", "postFields", "previewLinks", "render", "replay", "searchFields"];

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
 * v0.19.0: `actor` on every JSON write body and `actorName` on every write query (C2), `field` on an unknown-field error,
 * and three capabilities. Only the schemas an earlier fixture holds are checked against it.
 */
const ACTOR = ["actor"];
const ACTOR_NAME = ["actorName"];
export const V0190_ADDED: Record<string, string[]> = {
  Capabilities: ["backlinks", "hooks", "previewLinkHours"],
  ErrorBody: ["field"],
  SaveDraftInput: ACTOR, PublishInput: ACTOR, ScheduleInput: ACTOR, UnpublishInput: ACTOR, ContentTagsInput: ACTOR,
  ContentDeleteQuery: ACTOR_NAME, ScheduleCancelQuery: ACTOR_NAME,
  MediaAltInput: ACTOR, MediaTagsInput: ACTOR, MediaTrashInput: ACTOR, MediaFocusInput: ACTOR, MediaCaptionInput: ACTOR,
  MediaBulkInput: ACTOR, MediaTrashEmptyInput: ACTOR, MediaImportInput: ACTOR, MediaCreditInput: ACTOR, MediaTransformInput: ACTOR,
  MediaRevertInput: ACTOR, MediaResizePassInput: ACTOR,
  MediaUploadQuery: ACTOR_NAME, MediaDeleteQuery: ACTOR_NAME, MediaReplaceQuery: ACTOR_NAME,
  MentionDecideInput: ACTOR, MentionSweepInput: ACTOR, MentionDeleteQuery: ACTOR_NAME,
};

export const V0170_CODES = ["in-progress", "unknown-field"];

/** The enums v0.17.0 widens, for additiveOnly. ErrorCode itself is checked with `widened`. */
export const V0170_WIDEN: Record<string, readonly string[]> = { "ErrorBody.error": V0170_CODES };

export const V0170_SCHEMAS = [
  "AuthorName", "ContentTrashInput", "PreviewLink", "PreviewLinkInput", "PreviewLinkList", "PreviewLinkListQuery",
  "PreviewLinkRevokeQuery", "PreviewLinkRevokeResult", "RenameInput", "RenameResult",
  // v0.19.0
  "Actor", "ActorName", "Backlink", "BacklinkList", "HookRun", "HookRunList", "HookRunsQuery",
];

/** The routes v0.17.0 adds, in the route table's order, after every earlier one. */
export const V0170_ROUTES = [
  "POST /content/:id/rename", "POST /content/:id/trash", "POST /content/:id/restore",
  "POST /preview-links", "GET /preview-links", "DELETE /preview-links/:linkId",
];

/** The routes v0.19.0 adds, after the 404 report. */
export const V0190_ROUTES = ["GET /content/:id/backlinks", "GET /hooks/recent"];

/** An earlier test's own additions with v0.17.0's merged in, each list sorted. */
export function withV0170(added: Record<string, string[]>, fixture: Record<string, unknown>): Record<string, string[]> {
  const merged: Record<string, string[]> = { ...added };
  for (const [name, props] of Object.entries(V0170_ADDED)) merged[name] = [...new Set([...(merged[name] ?? []), ...props])].sort();
  for (const [name, props] of Object.entries(V0190_ADDED)) if (name in fixture) merged[name] = [...new Set([...(merged[name] ?? []), ...props])].sort();
  return merged;
}

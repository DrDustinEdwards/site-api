// What v0.15.0 adds to the contract, in one place for each earlier contract's test (contract-v*.test.ts): optional
// properties, one error code at the end of the enum, new schemas and new routes. Nothing earlier changes.

export const V0150_CAPABILITIES = ["contentPublishedAt", "contentFilters", "contentRename", "contentTrash", "postFields", "render", "replay", "searchFields"];

/** The schemas v0.15.0 extends and the optional properties each gains; [] for one that changes only through a schema it holds. */
export const V0150_ADDED: Record<string, string[]> = {
  Capabilities: V0150_CAPABILITIES,
  Meta: [],
  ErrorBody: ["detail", "status", "title", "type"],
  PublishInput: ["publishedAt"],
  ContentSummary: ["authors", "excerpt", "trashedAt"],
  ContentDoc: ["authors", "excerpt", "trashedAt"],
  ListQuery: ["author", "kind", "publishedAfter", "publishedBefore", "tag", "trashed"],
  ContentList: [],
  Revision: ["authors"],
  RevisionList: [],
};

export const V0150_CODES = ["in-progress"];

/** The enums v0.15.0 widens, for additiveOnly. ErrorCode itself is checked with `widened`. */
export const V0150_WIDEN: Record<string, readonly string[]> = { "ErrorBody.error": V0150_CODES };

export const V0150_SCHEMAS = ["AuthorName", "ContentTrashInput", "RenameInput", "RenameResult"];

/** The routes v0.15.0 adds, in the route table's order, after every earlier one. */
export const V0150_ROUTES: string[] = ["POST /content/:id/rename", "POST /content/:id/trash", "POST /content/:id/restore"];

/** An earlier test's own additions with v0.15.0's merged in, each list sorted. */
export function withV0150(added: Record<string, string[]>): Record<string, string[]> {
  const merged: Record<string, string[]> = { ...added };
  for (const [name, props] of Object.entries(V0150_ADDED)) merged[name] = [...new Set([...(merged[name] ?? []), ...props])].sort();
  return merged;
}

// The contract between Carrel and a site: every request and response body, as zod schemas.
//
// A site and Carrel agree when their schema hashes match. The hash covers these schemas and the
// route table, so any change to either is a new contract, and Carrel's health check sees it.

export { POST_FIELDS, SEARCH_FIELDS, type PostField, type SearchField } from "./frontmatter.js";

export {
  Actor,
  ActorName,
  ChangeId,
  ContentId,
  SiteInfo,
  SortDir,
  Version,
} from "./contract/base.js";
export * from "./contract/content.js";
export * from "./contract/media.js";
export * from "./contract/media-writes.js";
export * from "./contract/mentions.js";
export * from "./contract/insight.js";
export * from "./contract/meta.js";
export * from "./contract/routes.js";

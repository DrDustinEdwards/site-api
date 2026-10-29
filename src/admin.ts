// The content kit: the server half of the shared posts, media and mentions screens (Capsomer's
// PostsList, MediaLibrary and MentionsList). Server only: it holds the site client, so the key never
// reaches a browser. It does three things and no more:
//
//   - turns a site client into the plain view data a component renders (loadPosts, loadMedia, loadMentions);
//   - turns a posted intent into contract calls, each with the version the person saw and a fresh change id;
//   - returns an IntentResult naming the inverse intent when the action can be undone.
//
// The host (Carrel, or a site's own admin) signs the person in, decides what they may do, picks the
// site and supplies a ContentSource. Carrel passes createSiteClient({ baseUrl, key }); a site's own
// admin passes localClient(adapter), so both run this code against the same contract. Every rule of
// the site's own stays behind the contract; the kit adds only "who may" and "what the inverse is".

export { localClient } from "./local.js";
export { askFirst } from "./admin/kit.js";
export type { Permissions, RowNote, ContentSource, Fields, IntentInput, Outcome, IntentResult, ConfirmRequest } from "./admin/kit.js";
export * from "./admin/posts.js";
export * from "./admin/media.js";
export * from "./admin/mentions.js";
export * from "./admin/summary.js";

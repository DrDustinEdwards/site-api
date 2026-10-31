// The mentions group (v0.5.0).

import { z } from "zod";
import { Actor, ActorName, ChangeId, ContentId, Timestamp, Version } from "./base.js";

/** A site's id for one received mention, as text: a row id such as 41. Never a path. */
export const MentionId = ContentId;

/**
 * Where a mention is in the site's moderation queue. unverified: received, the sender's page not yet
 * fetched. pending: the link is really there, awaiting a decision. approved: shown on the post.
 * rejected: kept, so a re-sender does not reappear as new. failed: verification found no link.
 */
export const MentionStatus = z.enum(["unverified", "pending", "approved", "rejected", "failed"]);

export const MentionItem = z.object({
  id: MentionId,
  status: MentionStatus,
  /** The page the sender says links to us. Text from a stranger: never a link. */
  sourceUrl: z.string().min(1).max(2000),
  /** The content id the mention targets, such as a post slug. */
  targetId: z.string().min(1).max(300),
  authorName: z.string().max(500).nullable(),
  authorUrl: z.string().max(2000).nullable(),
  excerpt: z.string().max(5000).nullable(),
  /** Why verification failed, in the site's fixed words; null unless failed. */
  failureReason: z.string().max(500).nullable(),
  receivedAt: Timestamp,
  verifiedAt: Timestamp.nullable(),
  decidedAt: Timestamp.nullable(),
  /** Opaque, like a content version: it must move whenever the status, the verification or the decision does. */
  version: Version,
});

export const MentionListQuery = z.object({
  status: MentionStatus.optional(),
  /** v0.6.0: words in the source address, the author or the excerpt. */
  q: z.string().max(200).optional(),
  /** v0.6.0: only the mentions of this content id, such as a post slug. */
  targetId: z.string().min(1).max(300).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** How many mentions the site holds in each status. */
export const MentionCounts = z.object({
  unverified: z.number().int().min(0),
  pending: z.number().int().min(0),
  approved: z.number().int().min(0),
  rejected: z.number().int().min(0),
  failed: z.number().int().min(0),
});

export const MentionList = z.object({
  items: z.array(MentionItem),
  nextCursor: z.string().nullable(),
  /** Across the whole queue, not the page, so a filter can show its count. */
  counts: MentionCounts,
  /** What a sweep would remove now, by status (the site's retention windows). */
  expiring: z.object({ failed: z.number().int().min(0), rejected: z.number().int().min(0) }),
  /** The filters of v0.6.0 the site applied, echoed. Absent: the site did not filter by q or targetId. */
  filtered: z.object({ q: z.string().max(200).optional(), targetId: z.string().max(300).optional() }).optional(),
});

/** `reset` (v0.6.0, optional per site) takes an approved or rejected mention back to pending, so a decision can be undone. */
export const MENTION_DECISIONS = ["approve", "reject", "reset"] as const;

export const MentionDecideInput = z.object({
  decision: z.enum(MENTION_DECISIONS),
  expectedVersion: Version,
  changeId: ChangeId,
  actor: Actor.optional(),
});

export const MentionWriteResult = z.object({
  id: MentionId,
  status: MentionStatus,
  /** The mention's version after the write. */
  version: Version,
  changeId: ChangeId,
  /** Whether the site purged the target's cached page: false when the purge failed, null when there was none to run. */
  purged: z.boolean().nullable(),
});

export const MentionDeleteQuery = z.object({
  expectedVersion: Version,
  changeId: ChangeId,
  actorName: ActorName.optional(),
});

export const MentionDeleteResult = z.object({
  id: MentionId,
  deleted: z.literal(true),
  changeId: ChangeId,
  purged: z.boolean().nullable(),
});

/** Sweeping removes the mentions past the site's retention windows: failed and rejected ones. It names no version, since it is not about one mention. */
export const MentionSweepInput = z.object({
  changeId: ChangeId,
  actor: Actor.optional(),
});

export const MentionSweepResult = z.object({
  changeId: ChangeId,
  removed: z.object({ failed: z.number().int().min(0), rejected: z.number().int().min(0) }),
});

export type MentionStatus = z.infer<typeof MentionStatus>;
export type MentionItem = z.infer<typeof MentionItem>;
export type MentionListQuery = z.infer<typeof MentionListQuery>;
export type MentionCounts = z.infer<typeof MentionCounts>;
export type MentionList = z.infer<typeof MentionList>;
export type MentionDecideInput = z.infer<typeof MentionDecideInput>;
export type MentionWriteResult = z.infer<typeof MentionWriteResult>;
export type MentionDeleteQuery = z.infer<typeof MentionDeleteQuery>;
export type MentionDeleteResult = z.infer<typeof MentionDeleteResult>;
export type MentionSweepInput = z.infer<typeof MentionSweepInput>;
export type MentionSweepResult = z.infer<typeof MentionSweepResult>;

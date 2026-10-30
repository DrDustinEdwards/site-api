// The meta route, the content routes and the preview: what every site serves.

import { createTwoFilesPatch } from "diff";
import { capabilitiesOf, NotFoundError, RefusedError, VersionConflictError, type SiteAdapter } from "../adapter.js";
import {
  ContentDeleteQuery,
  ContentDeleteResult,
  ContentDoc,
  ContentId,
  ContentList,
  ContentTagsInput,
  Diff,
  DiffQuery,
  ListQuery,
  Meta,
  PACKAGE_VERSION,
  PreviewInput,
  PublishInput,
  RenameInput,
  RenameResult,
  RevisionList,
  RevisionSource,
  SaveDraftInput,
  ScheduleCancelQuery,
  ScheduleInput,
  ScheduledUpdate,
  UnpublishInput,
  Version,
  WriteResult,
  schemaHash,
} from "../contract.js";
import { BadRequest, BASE_HEADERS, ContractBreach, ID, checked, fail, json, pathParam, readBody, readQuery, type Route } from "./http.js";

export function contentRoutes(adapter: SiteAdapter, options: { store: boolean }): Route[] {
  const id = (m: RegExpMatchArray) => pathParam(m[1], ContentId, "content id");

  const write = async (
    m: RegExpMatchArray,
    request: Request,
    run: (contentId: string, request: Request) => Promise<unknown>,
  ) => json(200, checked(WriteResult, await run(id(m), request), "write result"));

  return [
    {
      method: "GET",
      pattern: /^\/meta$/,
      run: async () =>
        json(200, checked(Meta, {
          api: "carrel-site-api",
          packageVersion: PACKAGE_VERSION,
          schemaHash: await schemaHash(),
          site: adapter.site,
          capabilities: capabilitiesOf(adapter, options),
        }, "meta")),
    },
    {
      method: "GET",
      pattern: /^\/content$/,
      run: async (_m, url) => json(200, checked(ContentList, await adapter.content.list(readQuery(url, ListQuery)), "content list")),
    },
    {
      method: "GET",
      pattern: new RegExp(`^/content/${ID}$`),
      run: async (m) => {
        const doc = await adapter.content.get(id(m));
        if (!doc) throw new NotFoundError();
        return json(200, checked(ContentDoc, doc, "content"));
      },
    },
    {
      method: "PUT",
      pattern: new RegExp(`^/content/${ID}/draft$`),
      run: (m, _u, r) => write(m, r, async (i, req) => adapter.content.saveDraft(i, await readBody(req, SaveDraftInput))),
    },
    {
      method: "POST",
      pattern: new RegExp(`^/content/${ID}/publish$`),
      run: (m, _u, r) =>
        write(m, r, async (i, req) => {
          const input = await readBody(req, PublishInput);
          if (input.publishedAt !== undefined) {
            if (!adapter.content.publishedAtSettable) throw new BadRequest("not-implemented", "This site does not set the date a post is published under.");
            // A minute's grace for the caller's clock; a later date is a schedule, which says when the post goes live.
            if (Date.parse(input.publishedAt) > Date.now() + 60_000) throw new BadRequest("invalid", "publishedAt is in the future. To publish later, schedule it.");
          }
          return adapter.content.publish(i, input);
        }),
    },
    {
      method: "POST",
      pattern: new RegExp(`^/content/${ID}/schedule$`),
      run: (m, _u, r) =>
        write(m, r, async (i, req) => {
          const input = await readBody(req, ScheduleInput);
          const current = await adapter.content.get(i);
          // v0.10.0: a live item keeps being served, and the schedule is an update that replaces it at the time.
          if (current?.status !== "published") return adapter.content.schedule(i, input);
          if (current.version !== input.expectedVersion) throw new VersionConflictError(current.version);
          if (!adapter.schedules) {
            throw new RefusedError("This site cannot schedule an update to a live post: scheduling it would take the post off the site until then. Publish the change now, or unpublish first.");
          }
          const { publishAt, expectedVersion, changeId } = input;
          return adapter.schedules.update(i, { source: input.source ?? current.source, publishAt, expectedVersion, changeId });
        }),
    },
    {
      method: "GET",
      pattern: new RegExp(`^/content/${ID}/schedule$`),
      run: async (m) => {
        const contentId = id(m);
        if (!adapter.schedules) return fail("not-implemented", "This site does not schedule updates to live posts.");
        const update = await adapter.schedules.get(contentId);
        if (!update) throw new NotFoundError("Nothing is scheduled for this item.");
        return json(200, checked(ScheduledUpdate, update, "scheduled update"));
      },
    },
    {
      method: "DELETE",
      pattern: new RegExp(`^/content/${ID}/schedule$`),
      run: async (m, url) => {
        const contentId = id(m);
        if (!adapter.schedules) return fail("not-implemented", "This site does not schedule updates to live posts.");
        return json(200, checked(WriteResult, await adapter.schedules.cancel(contentId, readQuery(url, ScheduleCancelQuery)), "schedule cancel"));
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/content/${ID}/unpublish$`),
      run: (m, _u, r) => write(m, r, async (i, req) => adapter.content.unpublish(i, await readBody(req, UnpublishInput))),
    },
    {
      method: "GET",
      pattern: new RegExp(`^/content/${ID}/revisions$`),
      run: async (m) => {
        const items = await adapter.content.revisions(id(m));
        if (!items) throw new NotFoundError();
        return json(200, checked(RevisionList, { items }, "revisions"));
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/content/${ID}/revisions/${ID}$`),
      run: async (m) => {
        const contentId = id(m);
        const version = pathParam(m[2], Version, "version");
        const source = await adapter.content.revisionSource(contentId, version);
        if (source === null) throw new NotFoundError("No such version.");
        return json(200, checked(RevisionSource, { id: contentId, version, source }, "revision source"));
      },
    },
    {
      method: "DELETE",
      pattern: new RegExp(`^/content/${ID}$`),
      run: async (m, url) => {
        const contentId = id(m);
        // A site with no delete answers 501 whatever the query says.
        if (!adapter.content.delete) return fail("not-implemented", "This site does not delete content through the API.");
        const query = readQuery(url, ContentDeleteQuery);
        await adapter.content.delete(contentId, query);
        return json(200, checked(ContentDeleteResult, { id: contentId, deleted: true, changeId: query.changeId }, "content delete"));
      },
    },
    {
      method: "PUT",
      pattern: new RegExp(`^/content/${ID}/tags$`),
      run: async (m, _u, request) => {
        const contentId = id(m);
        if (!adapter.content.setTags) return fail("not-implemented", "This site does not keep tags on posts through the API.");
        const input = await readBody(request, ContentTagsInput);
        // One spelling per tag: the first one given wins, so "News" and "news" are one tag.
        const seen = new Set<string>();
        const tags = input.tags.filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
        return json(200, checked(WriteResult, await adapter.content.setTags(contentId, { ...input, tags }), "content tags"));
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/content/${ID}/rename$`),
      run: async (m, _u, request) => {
        const contentId = id(m);
        if (!adapter.content.rename) return fail("not-implemented", "This site does not rename content through the API.");
        const input = await readBody(request, RenameInput);
        if (input.newId === contentId) throw new BadRequest("invalid", "newId is the item's own id.");
        return json(200, checked(RenameResult, await adapter.content.rename(contentId, input), "content rename"));
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/content/${ID}/diff$`),
      run: async (m, url) => {
        const contentId = id(m);
        const query = readQuery(url, DiffQuery);
        const current = await adapter.content.get(contentId);
        if (!current) throw new NotFoundError();
        const to = query.to ?? current.version;
        const [before, after] = await Promise.all([
          adapter.content.revisionSource(contentId, query.from),
          to === current.version ? current.source : adapter.content.revisionSource(contentId, to),
        ]);
        if (before === null || after === null) throw new NotFoundError("No such version.");
        const patch = createTwoFilesPatch(`${contentId}@${query.from}`, `${contentId}@${to}`, before, after);
        return json(200, checked(Diff, { id: contentId, from: query.from, to, patch }, "diff"));
      },
    },
    {
      method: "POST",
      pattern: /^\/preview$/,
      run: async (_m, _u, request) => {
        const html = await adapter.preview.render(await readBody(request, PreviewInput));
        if (typeof html !== "string") throw new ContractBreach("preview: not a string");
        return new Response(html, {
          status: 200,
          headers: { ...BASE_HEADERS, "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  ];
}

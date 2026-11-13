// The mentions routes (v0.5.0), mounted only when the site's adapter has mentions.

import { jsonResponse } from "@dustinedwards/site-runtime/http";
import type { MentionsAdapter } from "../adapter.js";
import {
  MentionDecideInput,
  MentionDeleteQuery,
  MentionDeleteResult,
  MentionId,
  MentionList,
  MentionListQuery,
  MentionSweepInput,
  MentionSweepResult,
  MentionWriteResult,
} from "../contract.js";
import {
  BASE_HEADERS,
  ID,
  checked,
  fail,
  pathParam,
  readBody,
  readQuery,
  type Route,
} from "./http.js";

export function mentionsRoutes(mentions: MentionsAdapter): Route[] {
  const mentionId = (m: RegExpMatchArray) => pathParam(m[1], MentionId, "mention id");

  return [
    {
      method: "GET",
      query: true,
      pattern: /^\/mentions$/,
      run: async (_m, url) =>
        jsonResponse(
          checked(
            MentionList,
            await mentions.list(readQuery(url, MentionListQuery)),
            "mentions list",
          ),
          200,
          BASE_HEADERS,
        ),
    },
    {
      method: "POST",
      pattern: /^\/mentions\/sweep$/,
      run: async (_m, _u, request) => {
        const input = await readBody(request, MentionSweepInput);
        const removed = await mentions.sweep(input);
        return jsonResponse(
          checked(MentionSweepResult, { changeId: input.changeId, removed }, "mentions sweep"),
          200,
          BASE_HEADERS,
        );
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/mentions/${ID}/decide$`),
      run: async (m, _u, request) => {
        const id = mentionId(m);
        const input = await readBody(request, MentionDecideInput);
        const { decision, ...rest } = input;
        let result;
        if (decision === "reset") {
          if (!mentions.reset)
            return fail("not-implemented", "This site does not take a mention decision back.");
          result = await mentions.reset(id, rest);
        } else {
          result = await mentions.decide(id, { ...rest, decision });
        }
        return jsonResponse(
          checked(
            MentionWriteResult,
            { id, ...result, changeId: input.changeId },
            "mention decision",
          ),
          200,
          BASE_HEADERS,
        );
      },
    },
    {
      method: "DELETE",
      query: true,
      pattern: new RegExp(`^/mentions/${ID}$`),
      run: async (m, url) => {
        const id = mentionId(m);
        const query = readQuery(url, MentionDeleteQuery);
        const result = await mentions.delete(id, query);
        return jsonResponse(
          checked(
            MentionDeleteResult,
            { id, deleted: true, changeId: query.changeId, purged: result.purged },
            "mention delete",
          ),
          200,
          BASE_HEADERS,
        );
      },
    },
  ];
}

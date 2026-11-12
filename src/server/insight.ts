// The insight routes (v0.16.0), mounted only when the site's adapter has insight. Read only.

import { jsonResponse } from "@dustinedwards/site-runtime/http";
import type { InsightAdapter } from "../adapter.js";
import { NotFoundQuery, NotFoundReport } from "../contract.js";
import { BASE_HEADERS, checked, readQuery, type Route } from "./http.js";

export function insightRoutes(insight: InsightAdapter): Route[] {
  return [
    {
      method: "GET",
      query: true,
      pattern: /^\/insight\/not-found$/,
      run: async (_m, url) => {
        const query = readQuery(url, NotFoundQuery);
        const rows = await insight.notFound({
          days: query.days,
          limit: query.limit,
          includeProbes: query.includeProbes === "true",
        });
        return jsonResponse(
          checked(NotFoundReport, { rows }, "not-found report"),
          200,
          BASE_HEADERS,
        );
      },
    },
  ];
}

// The insight routes (v0.16.0), mounted only when the site's adapter has insight. Read only.

import type { InsightAdapter } from "../adapter.js";
import { NotFoundQuery, NotFoundReport } from "../contract.js";
import { checked, json, readQuery, type Route } from "./http.js";

export function insightRoutes(insight: InsightAdapter): Route[] {
  return [
    {
      method: "GET",
      pattern: /^\/insight\/not-found$/,
      run: async (_m, url) => {
        const query = readQuery(url, NotFoundQuery);
        const rows = await insight.notFound({ days: query.days, limit: query.limit, includeProbes: query.includeProbes === "true" });
        return json(200, checked(NotFoundReport, { rows }, "not-found report"));
      },
    },
  ];
}

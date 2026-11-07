// The site API's log line, once for every site. A refused request is named in the OWASP logging vocabulary through
// site-runtime's scrubbing logger (a missing or wrong key is `authz_fail`, a rate-limited one
// `excess_rate_limit_exceeded`, the reason stays a field); every other line is `site_api_<name>`. It is the default
// `log` of createSiteApi, so a site passes none.
import { OWASP_EVENTS, logEvent } from "@dustinedwards/site-runtime/log";

export function siteApiLog(entry: Record<string, unknown>): void {
  if (entry.siteApi === "refused") {
    const limited = entry.reason === "rate-limited";
    const denied = entry.reason === "wrong-key" || entry.reason === "no-key";
    const event = limited
      ? OWASP_EVENTS.rateLimitExceeded
      : denied
        ? OWASP_EVENTS.authorizationFailure
        : "site_api_refused";
    logEvent(event, entry, { level: "warn" });
    return;
  }
  logEvent(`site_api_${String(entry.siteApi ?? "log")}`, entry);
}

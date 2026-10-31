// What v0.19.0 changes in the contract, in one place for each earlier contract's test (contract-v*.test.ts): optional
// properties, two schemas, one route, and the one deliberate break, an upload's alt that no longer defaults to "".

import type { JsonSchema } from "./additive.js";

const V0190_ITEM = ["acquireLicenseUrl", "copyright", "decorative", "licenseUrl"];

/** The schemas v0.19.0 extends and the optional properties each gains. */
export const V0190_ADDED: Record<string, string[]> = {
  Capabilities: ["mediaUploadSuggestions"],
  Meta: [],
  MediaItem: V0190_ITEM,
  MediaDetail: V0190_ITEM,
  MediaReplaceResult: V0190_ITEM,
  MediaAltInput: ["decorative"],
  MediaUploadQuery: ["decorative"],
};

export const V0190_SCHEMAS = ["MediaFileSuggestQuery", "MediaFileSuggestions"];

export const V0190_ROUTES = ["POST /media/suggestions"];

/**
 * An earlier contract's schemas as v0.19.0 reads them: an upload's alt no longer defaults to "" (B3), since an upload now
 * needs alt or decorative=yes, and a site answers one with neither 400. Nothing else is touched.
 */
export function asOfV0190(schemas: Record<string, JsonSchema>): Record<string, JsonSchema> {
  const upload = schemas.MediaUploadQuery;
  const alt = upload?.properties?.alt as JsonSchema | undefined;
  if (alt) delete alt.default;
  return schemas;
}

/** An earlier test's own additions with v0.19.0's merged in, each list sorted, for the schemas its contract had. */
export function withV0190(added: Record<string, string[]>, schemas: Record<string, JsonSchema>): Record<string, string[]> {
  const merged: Record<string, string[]> = { ...added };
  for (const [name, props] of Object.entries(V0190_ADDED)) if (name in schemas) merged[name] = [...new Set([...(merged[name] ?? []), ...props])].sort();
  return merged;
}

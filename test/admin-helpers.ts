// The kit tests share this setup: two permission sets, an in-memory site, and helpers to save a post and upload a file.

import { type ContentSource, type Permissions } from "../src/admin.js";
import { localClient, type SiteClient } from "../src/client.js";
import { memoryAdapter, type MemoryAdapterOptions } from "../src/testing.js";

export const OWNER: Permissions = {
  edit: true,
  publish: true,
  deleteContent: true,
  deleteMedia: true,
  decideMentions: true,
};
export const EDITOR: Permissions = {
  edit: true,
  publish: false,
  deleteContent: false,
  deleteMedia: false,
  decideMentions: false,
};
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

export function setup(options: MemoryAdapterOptions = {}, extra: Partial<ContentSource> = {}) {
  const adapter = memoryAdapter(options);
  const client = localClient(adapter, { log: () => {} });
  const records: Array<{ kind: string; ids: string[]; changeId: string }> = [];
  const source: ContentSource = {
    site: adapter.site,
    client,
    can: OWNER,
    editorHref: (id) => `/edit/${id}`,
    record: async (change) => {
      records.push(change);
    },
    log: () => {},
    ...extra,
  };
  return { adapter, client, source, records };
}

export async function post(client: SiteClient, id: string, front: string, publish = false) {
  const draft = await client.saveDraft(id, {
    source: `---\n${front}\n---\nBody of ${id}.\n`,
    expectedVersion: null,
    changeId: `c-${id}`,
  });
  return publish
    ? client.publish(id, { expectedVersion: draft.version, changeId: `p-${id}` })
    : draft;
}

export async function upload(client: SiteClient, name: string) {
  return client.media.upload({
    bytes: PNG,
    contentType: "image/png",
    filename: name,
    decorative: true,
    changeId: `u-${name.replace(/\W/g, "")}`,
  });
}

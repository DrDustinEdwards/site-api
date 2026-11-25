import type { ConformanceConfig } from "../conformance.js";
import type { Meta } from "../contract.js";

/** What every group of checks shares: the run's config, its authenticated fetch and the recording helpers. */
export interface ConformanceContext {
  config: ConformanceConfig;
  doFetch: typeof fetch;
  origin: string;
  auth: { authorization: string };
  /** What the site's /meta declared; undefined when it did not answer. */
  capabilities: Meta["capabilities"] | undefined;
  check(name: string, run: () => Promise<string>): Promise<boolean>;
  skip(name: string, why: string): void;
  /** The run's short random id, so every post and change id it makes is its own. */
  run: string;
  /** A fresh change id for a probe write. */
  probe(): string;
  errorCode(response: Response): Promise<string | null>;
  /** A JSON write to a route under the prefix, with the key. */
  send(method: string, path: string, body: unknown): Promise<Response>;
  expectStatus(response: Response, status: number, what: string): void;
  expectUnknownId(
    response: Response,
    offered: boolean,
    whenOffered: string,
    whenNot: string,
  ): Promise<string>;
}

/** An id no site should hold, so the refused write names nothing real. */
export const PROBE_ID = "carrel-conformance-probe";
/** A media id no site should hold: the refused delete names nothing real. */
export const MEDIA_PROBE_ID = "carrel-conformance-probe/no-such-file.png";
/** A type no site accepts, for the refused upload. */
export const PROBE_TYPE = "application/x-carrel-conformance-probe";
/** The smallest valid PNG: one transparent pixel. */
export const PROBE_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);
export const STALE_VERSION = "carrel-conformance-stale-version";
/** A mention id no site should hold: the refused mention writes name nothing real. */
export const MENTION_PROBE_ID = "carrel-conformance-probe";

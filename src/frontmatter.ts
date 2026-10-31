// A post's source is YAML frontmatter and a Markdown body. The frontmatter is read as top-level blocks
// (a key line and the lines that belong to it), and a write replaces only the block it names: every
// other block, comment and unknown key comes back byte for byte. No YAML parser, so it runs in a
// Worker and a browser alike. Exported as `@dustinedwards/site-api/frontmatter`.

export type Split = { front: string | null; body: string; open: string; close: string };

const FENCE = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n(?:[ \t]*\r?\n)*|$))/;

/** Cuts a source into its frontmatter text, its body and the fences between, so `open + front + close + body` is the source. Blank lines after the closing fence go with the fence, so the body starts at its first line of text. */
export function splitSource(source: string): Split {
  const m = FENCE.exec(source);
  if (!m) return { front: null, body: source, open: "", close: "" };
  return { front: m[2]!, body: source.slice(m[0].length), open: m[1]!, close: m[3]! };
}

export function joinSource(s: Split): string {
  return s.front === null ? s.body : `${s.open}${s.front}${s.close}${s.body}`;
}

type Block = { key: string | null; lines: string[] };

const KEY = /^([A-Za-z_][\w-]*):(.*)$/;

function blocks(front: string): Block[] {
  const out: Block[] = [];
  // A CRLF source reads like an LF one: a key line with a CR on it is still a key line.
  for (const line of front.split(/\r?\n/)) {
    const m = KEY.exec(line);
    if (m) out.push({ key: m[1]!, lines: [line] });
    else if (out.length > 0) out[out.length - 1]!.lines.push(line);
    else out.push({ key: null, lines: [line] });
  }
  return out;
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function listOf(block: Block): string[] {
  const first = KEY.exec(block.lines[0]!)![2]!.trim();
  if (first.startsWith("[") && first.endsWith("]")) {
    return first
      .slice(1, -1)
      .split(",")
      .map((t) => unquote(t))
      .filter(Boolean);
  }
  return block.lines
    .slice(1)
    .map((l) => /^\s*-\s+(.*)$/.exec(l)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(unquote);
}

/** One top-level key's value as one line of text, or "" when the frontmatter lacks it. */
export function readKey(front: string | null, key: string): string {
  if (front === null) return "";
  const block = blocks(front).find((b) => b.key === key);
  return block ? unquote(KEY.exec(block.lines[0]!)![2]!) : "";
}

/** One top-level key's list, flow (`[a, b]`) or block (`- a` lines), unquoted and in order; [] when the frontmatter lacks it. */
export function readList(front: string | null, key: string): string[] {
  if (front === null) return [];
  const block = blocks(front).find((b) => b.key === key);
  return block ? listOf(block) : [];
}

/** The tags the frontmatter holds now, in order. */
export function tagsOf(front: string | null): string[] {
  return readList(front, "tags").map((t) => t.trim()).filter(Boolean);
}

/**
 * The frontmatter with its tags set to exactly this list, and nothing else touched. An empty list is
 * written as `tags: []`, not removed. A list in block form comes back in flow form.
 */
export function setTags(front: string, tags: string[]): string {
  return setRawKey(front, "tags", `[${tags.map(tagItem).join(", ")}]`);
}

/** YAML 1.1 reads these plain words as booleans or null, not as the tag. */
const YAML_WORDS = /^(y|n|yes|no|true|false|on|off|null|~)$/i;

/** A tag as a flow-list item: bare when YAML reads it back as the same string, double-quoted otherwise. */
function tagItem(tag: string): string {
  const plain = /^[A-Za-z][\w .+/-]*$/.test(tag) && !/\s$/.test(tag) && !YAML_WORDS.test(tag);
  return plain ? tag : JSON.stringify(tag);
}

/** The frontmatter with a top-level key set to a raw value (`draft: true`), added at the end when absent. Every other block is returned as it was. */
export function setRawKey(front: string, key: string, raw: string): string {
  return setBlock(front, key, [`${key}: ${raw}`]);
}

/**
 * The frontmatter with one top-level key's block replaced by these lines (its key line first), added at
 * the end when absent, and removed when `lines` is empty. A block that already reads exactly so is left
 * as it was, and every other block is returned as it was.
 */
export function setBlock(front: string, key: string, lines: string[]): string {
  // Edited as LF and written back in the source's own line ending.
  const crlf = front.includes("\r\n");
  const all = blocks(front);
  const at = all.findIndex((b) => b.key === key);
  if (at >= 0) {
    const now = all[at]!.lines;
    if (now.length === lines.length && now.every((l, i) => l === lines[i])) return front;
    if (lines.length > 0) all[at] = { key, lines };
    else all.splice(at, 1);
  } else if (lines.length > 0) {
    all.push({ key, lines });
  } else {
    return front;
  }
  return all.flatMap((b) => b.lines).join(crlf ? "\r\n" : "\n");
}

/**
 * The search fields (v0.17.0): the same name on every site, kept in the frontmatter so each change is versioned
 * with the post. A site lists the ones it renders in its capabilities' `searchFields`, and Carrel shows a box for each.
 * An empty one falls back to the site's own default (the title, the opening text, the cover, the page's own address).
 */
export const SEARCH_FIELDS = ["searchTitle", "description", "image", "imageAlt", "canonical", "noindex"] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];
export type SearchValues = { searchTitle: string; description: string; image: string; imageAlt: string; canonical: string; noindex: boolean };

export function searchFieldsOf(front: string | null): SearchValues {
  return {
    searchTitle: readKey(front, "searchTitle"),
    description: readKey(front, "description"),
    image: readKey(front, "image"),
    imageAlt: readKey(front, "imageAlt"),
    canonical: readKey(front, "canonical"),
    noindex: readKey(front, "noindex") === "true",
  };
}

/** The frontmatter with these search fields set, as JSON literals so a jsonSource site reads them too. A blank text or a false noindex removes the key. */
export function setSearchFields(front: string, values: Partial<SearchValues>): string {
  let out = front;
  for (const field of SEARCH_FIELDS) {
    const value = values[field];
    if (value === undefined) continue;
    const text = typeof value === "boolean" ? (value ? "true" : "") : value.trim();
    out = setBlock(out, field, text === "" ? [] : [`${field}: ${typeof value === "boolean" ? text : JSON.stringify(text)}`]);
  }
  return out;
}

/**
 * The post fields (v0.17.0), beside the search fields and kept the same way: `excerpt` (the summary a list shows),
 * `authors` (display names in credit order, the first the primary author), `series` (its name) and `seriesPart` (a
 * positive whole number). A site lists the ones it renders in its capabilities' `postFields`.
 */
export const POST_FIELDS = ["excerpt", "authors", "series", "seriesPart"] as const;
export type PostField = (typeof POST_FIELDS)[number];
export type PostValues = { excerpt: string; authors: string[]; series: string; seriesPart: number | null };

export function postFieldsOf(front: string | null): PostValues {
  const part = Number(readKey(front, "seriesPart"));
  return {
    excerpt: readKey(front, "excerpt"),
    authors: authorsOf(front),
    series: readKey(front, "series"),
    seriesPart: Number.isInteger(part) && part > 0 ? part : null,
  };
}

/** A JSON array first, since a name may hold a comma ("Smith, Jr."); a hand-written YAML list otherwise. */
function authorsOf(front: string | null): string[] {
  const raw = readKey(front, "authors");
  let names: unknown = null;
  if (raw.startsWith("[")) {
    try {
      names = JSON.parse(raw);
    } catch {
      // Not JSON: a YAML flow list, read below.
    }
  }
  const list = Array.isArray(names) && names.every((n) => typeof n === "string") ? (names as string[]) : readList(front, "authors");
  return list.map((n) => n.trim()).filter(Boolean);
}

/** The frontmatter with these post fields set, as JSON literals like the search fields. A blank text, no authors or a null part removes the key. */
export function setPostFields(front: string, values: Partial<PostValues>): string {
  let out = front;
  for (const field of POST_FIELDS) {
    const value = values[field];
    if (value === undefined) continue;
    let literal: string | null;
    if (Array.isArray(value)) {
      const names = value.map((n) => n.trim()).filter(Boolean);
      literal = names.length > 0 ? JSON.stringify(names) : null;
    } else if (typeof value === "number" || value === null) {
      literal = value !== null && Number.isInteger(value) && value > 0 ? String(value) : null;
    } else {
      literal = value.trim() === "" ? null : JSON.stringify(value.trim());
    }
    out = setBlock(out, field, literal === null ? [] : [`${field}: ${literal}`]);
  }
  return out;
}

// The JSON source format: the front matter a site writes for Carrel when it stores its fields in columns,
// one `key: <JSON literal>` line per field, so a round trip needs no YAML. A text field may also be written
// unquoted by hand. `jsonSource` is the one reader and writer, given the site's own field list.

export type JsonFieldKind = "text" | "list" | "flag";
type JsonValue<K extends JsonFieldKind> = K extends "text" ? string | null : K extends "list" ? string[] : boolean;
export type JsonValues<F extends Record<string, JsonFieldKind>> = { [K in keyof F]?: JsonValue<F[K]> };

export class JsonSourceError extends Error {
  constructor(readonly problems: string[]) {
    super(`The front matter cannot be read:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    this.name = "JsonSourceError";
  }
}

/**
 * A reader and writer for one site's fields. `write` lists the fields that are not undefined, in the
 * field list's order, and `blankLine` puts an empty line before the body. `read` returns each key the
 * source has (a key it leaves out is undefined) and the body, and throws JsonSourceError naming every
 * problem: an unknown, repeated or malformed key, a value of the wrong kind, or a `required` field that
 * is missing or blank. With no front matter, the whole source is the body, unless a field is required.
 */
export function jsonSource<F extends Record<string, JsonFieldKind>>(fields: F, options: { required?: Array<keyof F & string>; blankLine?: boolean } = {}) {
  const keys = Object.keys(fields) as Array<keyof F & string>;
  const required = options.required ?? [];
  return {
    write(values: JsonValues<F>, body: string): string {
      const lines = keys.filter((k) => values[k] !== undefined).map((k) => `${k}: ${JSON.stringify(values[k])}`);
      return `---\n${lines.join("\n")}\n---\n${options.blankLine ? "\n" : ""}${body}`;
    },
    read(source: string): { values: JsonValues<F>; body: string } {
      const { front, body } = splitSource(source);
      if (front === null) {
        if (required.length > 0) throw new JsonSourceError(["The source must start with a front matter block between two --- lines."]);
        return { values: {}, body: source };
      }
      const problems: string[] = [];
      const values: Record<string, unknown> = {};
      for (const line of front.split(/\r?\n/)) {
        if (line.trim() === "") continue;
        const m = KEY.exec(line);
        const key = m?.[1];
        if (!m || !key) problems.push(`This front matter line is not "key: value": ${line.slice(0, 80)}`);
        else if (!Object.hasOwn(fields, key)) problems.push(`${key} is not a field. The fields are ${keys.join(", ")}.`);
        else if (key in values) problems.push(`${key} appears twice.`);
        else values[key] = jsonValue(key, fields[key]!, m[2]!.trim(), problems);
      }
      for (const key of required) {
        const v = values[key];
        if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) problems.push(`${key} is required.`);
      }
      if (problems.length > 0) throw new JsonSourceError(problems);
      return { values: values as JsonValues<F>, body };
    },
  };
}

function jsonValue(key: string, kind: JsonFieldKind, raw: string, problems: string[]): unknown {
  if (kind === "text" && !raw.startsWith('"')) return raw === "" || raw === "null" ? null : raw;
  let value: unknown;
  try {
    value = raw === "" || (kind === "list" && raw === "null") ? (kind === "list" ? [] : false) : JSON.parse(raw);
  } catch {
    problems.push(`${key}: the value is not valid JSON.`);
    return undefined;
  }
  if (kind === "text" && typeof value === "string") return value;
  if (kind === "list" && Array.isArray(value) && value.every((t) => typeof t === "string")) return value.map((t) => t.trim()).filter(Boolean);
  if (kind === "flag" && typeof value === "boolean") return value;
  problems.push(`${key} must be ${kind === "text" ? "a string" : kind === "list" ? 'a list of strings, such as ["a", "b"]' : "true or false"}.`);
  return undefined;
}

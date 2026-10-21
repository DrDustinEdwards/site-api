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
  for (const line of front.split("\n")) {
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
  return setRawKey(front, "tags", `[${tags.join(", ")}]`);
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
  return all.flatMap((b) => b.lines).join("\n");
}

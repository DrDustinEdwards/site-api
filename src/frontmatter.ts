// A post's source is YAML frontmatter and a Markdown body. The content kit changes a post's tags and
// makes a draft copy by rewriting only the frontmatter blocks it must, and every other block,
// comment and unknown key comes back byte for byte. Lifted from Carrel's app/lib/frontmatter.ts.

export type Split = { front: string | null; body: string; open: string; close: string };

const FENCE = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n(?:[ \t]*\r?\n)*|$))/;

/** Cuts a source into its frontmatter text, its body and the fences between, so `open + front + close + body` is the source. */
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

/** The tags the frontmatter holds now, in order. */
export function tagsOf(front: string | null): string[] {
  if (front === null) return [];
  const block = blocks(front).find((b) => b.key === "tags");
  return block ? listOf(block).map((t) => t.trim()).filter(Boolean) : [];
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
  const all = blocks(front);
  const line = `${key}: ${raw}`;
  const at = all.findIndex((b) => b.key === key);
  if (at >= 0) {
    if (all[at]!.lines.length === 1 && all[at]!.lines[0] === line) return front;
    all[at] = { key, lines: [line] };
  } else {
    all.push({ key, lines: [line] });
  }
  return all.flatMap((b) => b.lines).join("\n");
}

import type { CompletionRules, CompletionRulesPatch, RetryPolicy, TheoryBlock } from "@shared/syllabus";

/** Pure helpers for the syllabus builder (tested from server/syllabusBuilder.test.ts). */

/** `list` with the element at `from` moved to `to`; out-of-range indexes return the list unchanged. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const out = [...list];
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

/**
 * The full order after reordering only some members (e.g. the theory items of a lesson): the
 * slots those members occupy are refilled in their new order; everything else stays put.
 */
export function mergeSubsetOrder(allIds: readonly string[], subsetInNewOrder: readonly string[]): string[] {
  const subset = new Set(subsetInNewOrder);
  const queue = [...subsetInNewOrder];
  return allIds.map((id) => (subset.has(id) ? (queue.shift() ?? id) : id));
}

// ---------------------------------------------------------------------------
// Completion rules: override vs. inherited, field by field
// ---------------------------------------------------------------------------

type TopField = Exclude<keyof CompletionRules, "retry">;
type RetryField = `retry.${keyof RetryPolicy}`;
export type RuleField = TopField | RetryField;

export const RULE_FIELDS: readonly RuleField[] = [
  "sequentialModules",
  "sequentialLessons",
  "moduleRequiresAllLessons",
  "theory",
  "teacherPractice",
  "studentPractice",
  "practicePassPct",
  "assessment",
  "assessmentPassPct",
  "retry.maxAttempts",
  "retry.cooldownMinutes",
  "retry.scorePolicy",
  "teacherApproval",
];

const retryKey = (field: RuleField): keyof RetryPolicy | null => (field.startsWith("retry.") ? (field.slice(6) as keyof RetryPolicy) : null);

export function ruleValue(rules: CompletionRules, field: RuleField): unknown {
  const sub = retryKey(field);
  return sub ? rules.retry[sub] : rules[field as TopField];
}

/** True when this level sets the field itself instead of inheriting it. */
export function isOverridden(patch: CompletionRulesPatch | null | undefined, field: RuleField): boolean {
  if (!patch) return false;
  const sub = retryKey(field);
  return sub ? patch.retry?.[sub] !== undefined : patch[field as TopField] !== undefined;
}

export function withOverride(patch: CompletionRulesPatch | null | undefined, field: RuleField, value: unknown): CompletionRulesPatch {
  const base: CompletionRulesPatch = { ...(patch ?? {}) };
  const sub = retryKey(field);
  if (sub) return { ...base, retry: { ...(base.retry ?? {}), [sub]: value } };
  return { ...base, [field]: value };
}

/** Back to inheriting; an emptied `retry` object is dropped. */
export function withoutOverride(patch: CompletionRulesPatch | null | undefined, field: RuleField): CompletionRulesPatch {
  const base: CompletionRulesPatch = { ...(patch ?? {}) };
  const sub = retryKey(field);
  if (!sub) {
    delete base[field as TopField];
    return base;
  }
  const retry = { ...(base.retry ?? {}) };
  delete retry[sub];
  if (Object.keys(retry).length) base.retry = retry;
  else delete base.retry;
  return base;
}

export function overrideCount(patch: CompletionRulesPatch | null | undefined): number {
  return RULE_FIELDS.filter((f) => isOverridden(patch, f)).length;
}

// ---------------------------------------------------------------------------
// Theory: a small Markdown subset, parsed to a tree and rendered without HTML
// ---------------------------------------------------------------------------

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] };

export type MdBlock =
  | { t: "heading"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "paragraph"; c: Inline[] }
  | { t: "list"; ordered: boolean; items: Inline[][] }
  | { t: "quote"; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "rule" };

/** http(s) and mailto only; anything else (javascript:, data:, relative) is not linked. */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  return /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(url) ? url : null;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^`([^`]+)`/))) {
      flush();
      out.push({ t: "code", v: m[1] });
    } else if ((m = rest.match(/^\*\*(.+?)\*\*/))) {
      flush();
      out.push({ t: "strong", c: parseInline(m[1]) });
    } else if ((m = rest.match(/^\*([^*\s][^*]*?)\*/)) || (m = rest.match(/^_([^_\s][^_]*?)_/))) {
      flush();
      out.push({ t: "em", c: parseInline(m[1]) });
    } else if ((m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/))) {
      flush();
      const href = safeHref(m[2]);
      if (href) out.push({ t: "link", href, c: parseInline(m[1]) });
      else out.push(...parseInline(m[1]));
    } else {
      text += src[i];
      i += 1;
      continue;
    }
    i += m[0].length;
  }
  flush();
  return out;
}

export function parseMarkdown(md: string): MdBlock[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ t: "paragraph", c: parseInline(para.join(" ")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flushPara();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      blocks.push({ t: "code", lang: fence[1], v: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushPara();
      blocks.push({ t: "heading", level: heading[1].length as 1 | 2 | 3, c: parseInline(heading[2].trim()) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      blocks.push({ t: "rule" });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/;
    const numbered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      flushPara();
      const ordered = numbered.test(line);
      const pattern = ordered ? numbered : bullet;
      const items: Inline[][] = [];
      while (i < lines.length && pattern.test(lines[i])) items.push(parseInline(lines[i++].match(pattern)![1]));
      i -= 1;
      blocks.push({ t: "list", ordered, items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quoted.push(lines[i++].replace(/^>\s?/, ""));
      i -= 1;
      blocks.push({ t: "quote", c: parseInline(quoted.join(" ")) });
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  return blocks;
}

// ---------------------------------------------------------------------------
// Theory blocks
// ---------------------------------------------------------------------------

export type TheoryBlockType = TheoryBlock["type"];
export const THEORY_BLOCK_TYPES: readonly TheoryBlockType[] = ["markdown", "code", "image", "video", "link", "file", "material", "table"];

/** Editor-side block: the stored shape plus a client-only key for stable list rendering. */
export type EditableBlock = { key: string } & Record<string, unknown> & { type: TheoryBlockType };

let blockSeq = 0;
export const blockKey = () => `b${Date.now().toString(36)}${(blockSeq++).toString(36)}`;

export function emptyBlock(type: TheoryBlockType): EditableBlock {
  const key = blockKey();
  switch (type) {
    case "markdown":
      return { key, type, md: "" };
    case "code":
      return { key, type, language: "", code: "" };
    case "image":
      return { key, type, caption: "" };
    case "video":
      return { key, type, provider: "youtube", url: "" };
    case "link":
      return { key, type, url: "", title: "" };
    case "file":
      return { key, type, fileId: "", name: "" };
    case "material":
      return { key, type, materialId: "" };
    case "table":
      return { key, type, header: true, rows: [["", ""], ["", ""]] };
  }
}

/** Resizes a table grid, keeping existing cells; clamped to the schema limits (12 columns, 60 rows). */
export function resizeTable(rows: readonly string[][], rowCount: number, colCount: number): string[][] {
  const r = Math.min(Math.max(rowCount, 1), 60);
  const c = Math.min(Math.max(colCount, 1), 12);
  return Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => rows[i]?.[j] ?? ""));
}

/** Blocks as they are sent to the server: client keys removed, half-filled blocks dropped. */
export function blocksForSave(blocks: readonly EditableBlock[]): Record<string, unknown>[] {
  return blocks
    .map(({ key: _key, ...rest }) => rest as Record<string, unknown> & { type: TheoryBlockType })
    .filter((b) => {
      switch (b.type) {
        case "markdown":
          return typeof b.md === "string" && b.md.trim() !== "";
        case "code":
          return typeof b.code === "string" && b.code !== "";
        case "image":
          return !!b.fileId || !!b.url;
        case "video":
        case "link":
          return typeof b.url === "string" && b.url.trim() !== "";
        case "file":
          return !!b.fileId;
        case "material":
          return !!b.materialId;
        case "table":
          return Array.isArray(b.rows) && b.rows.length > 0;
      }
    })
    .map((b) => {
      if (b.type === "image") {
        const { fileId, url, ...rest } = b;
        return { ...rest, ...(fileId ? { fileId } : {}), ...(url ? { url } : {}) };
      }
      return b;
    });
}

export function blocksFromContent(content: unknown): EditableBlock[] {
  const blocks = (content as { blocks?: unknown })?.blocks;
  return Array.isArray(blocks) ? blocks.map((b) => ({ ...(b as Record<string, unknown>), key: blockKey() }) as EditableBlock) : [];
}

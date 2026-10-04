import { describe, expect, it } from "vitest";
import { isMessageKey } from "../client/src/i18n/messages";
import {
  blocksForSave,
  emptyBlock,
  isOverridden,
  mergeSubsetOrder,
  moveItem,
  overrideCount,
  parseInline,
  parseMarkdown,
  resizeTable,
  RULE_FIELDS,
  ruleValue,
  safeHref,
  THEORY_BLOCK_TYPES,
  withOverride,
  withoutOverride,
} from "../client/src/lib/syllabus";
import {
  ASSESSMENT_RULES,
  DEFAULT_COMPLETION_RULES,
  parseItemContent,
  resolveRules,
  sanitizeMarkdown,
  SCORE_POLICIES,
  STUDENT_PRACTICE_RULES,
  SUBMISSION_TYPES,
  SYLLABUS_GRANT_STATES,
  SYLLABUS_ITEM_KINDS,
  SYLLABUS_STATUSES,
  TEACHER_PRACTICE_RULES,
  THEORY_RULES,
  theoryContentSchema,
  videoEmbedUrl,
  videoProviderOf,
} from "../shared/syllabus";
import { contentRefs } from "./syllabus/authoring";
import { SAMPLE_MODULES } from "./syllabus/sample";
import { diffStructures } from "./syllabus/snapshot";
import type { ItemStub, LessonStub, ModuleStub, VersionStructure } from "./syllabus/types";

// ---------------------------------------------------------------------------
// Theory content: video whitelist, sanitizing, tables
// ---------------------------------------------------------------------------

describe("video links", () => {
  it("accepts only the supported hosts", () => {
    expect(videoProviderOf("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube");
    expect(videoProviderOf("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
    expect(videoProviderOf("https://vimeo.com/76979871")).toBe("vimeo");
    expect(videoProviderOf("https://www.loom.com/share/abcdef123456")).toBe("loom");
    expect(videoProviderOf("https://drive.google.com/file/d/1AbCdEfGh/view")).toBe("drive");
    expect(videoProviderOf("https://evil.example/youtube.com/watch?v=x")).toBeNull();
    expect(videoProviderOf("https://youtube.com.evil.example/watch?v=x")).toBeNull();
    expect(videoProviderOf("javascript:alert(1)")).toBeNull();
    expect(videoProviderOf("https://docs.google.com/file/d/1AbCdEfGh")).toBeNull();
  });

  it("builds privacy-friendly embed URLs and refuses malformed ids", () => {
    expect(videoEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(videoEmbedUrl("https://youtu.be/dQw4w9WgXcQ?t=10")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(videoEmbedUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(videoEmbedUrl("https://vimeo.com/channels/staff/76979871")).toBe("https://player.vimeo.com/video/76979871");
    expect(videoEmbedUrl("https://www.loom.com/share/abcdef123456")).toBe("https://www.loom.com/embed/abcdef123456");
    expect(videoEmbedUrl("https://drive.google.com/file/d/1AbCdEfGh/view?usp=sharing")).toBe("https://drive.google.com/file/d/1AbCdEfGh/preview");
    expect(videoEmbedUrl("https://www.youtube.com/watch?v=%22%3E%3Cscript")).toBeNull();
    expect(videoEmbedUrl("https://example.com/video.mp4")).toBeNull();
  });
});

describe("theory content schema", () => {
  it("strips HTML and unsafe link targets from text but keeps code spans", () => {
    const md = 'Hi <script>alert(1)</script><b>x</b> `<b>code</b>` [a](javascript:alert(1)) [b](https://ok.example) <!-- c -->';
    expect(sanitizeMarkdown(md)).toBe("Hi alert(1)x `<b>code</b>` [a](#)) [b](https://ok.example) ");
    const parsed = theoryContentSchema.parse({ blocks: [{ type: "markdown", md: "<img src=x onerror=alert(1)>ok" }] });
    expect(parsed.blocks[0]).toEqual({ type: "markdown", md: "ok" });
  });

  it("rejects a video whose host does not match its provider, and images without a source", () => {
    const bad = (block: unknown) => theoryContentSchema.safeParse({ blocks: [block] }).success;
    expect(bad({ type: "video", provider: "youtube", url: "https://evil.example/v" })).toBe(false);
    expect(bad({ type: "video", provider: "vimeo", url: "https://youtu.be/dQw4w9WgXcQ" })).toBe(false);
    expect(bad({ type: "video", provider: "youtube", url: "https://youtu.be/dQw4w9WgXcQ" })).toBe(true);
    expect(bad({ type: "image", caption: "x" })).toBe(false);
    expect(bad({ type: "image", url: "https://img.example/a.png" })).toBe(true);
    expect(bad({ type: "link", url: "javascript:alert(1)", title: "x" })).toBe(false);
  });

  it("accepts tables within the size limits", () => {
    const ok = theoryContentSchema.safeParse({ blocks: [{ type: "table", rows: [["a", "b"], ["1", "2"]] }] });
    expect(ok.success && ok.data.blocks[0]).toEqual({ type: "table", header: true, rows: [["a", "b"], ["1", "2"]] });
    expect(theoryContentSchema.safeParse({ blocks: [{ type: "table", rows: [] }] }).success).toBe(false);
    expect(theoryContentSchema.safeParse({ blocks: [{ type: "table", rows: [Array(13).fill("x")] }] }).success).toBe(false);
  });
});

describe("content references", () => {
  it("collects materials and files from every kind of content", () => {
    expect(
      contentRefs("THEORY", {
        blocks: [
          { type: "material", materialId: "m1" },
          { type: "image", fileId: "f1" },
          { type: "image", url: "https://x.example/a.png" },
          { type: "file", fileId: "f2", name: "a.pdf" },
          { type: "markdown", md: "x" },
        ],
      }),
    ).toEqual({ materialIds: ["m1"], fileIds: ["f1", "f2"] });
    expect(contentRefs("STUDENT_PRACTICE", { attachments: [{ fileId: "f3", name: "a", size: 1 }] })).toEqual({ materialIds: [], fileIds: ["f3"] });
    expect(contentRefs("RESOURCE", { materialId: "m2", note: "" })).toEqual({ materialIds: ["m2"], fileIds: [] });
    expect(contentRefs("ASSESSMENT", {})).toEqual({ materialIds: [], fileIds: [] });
  });
});

describe("sample syllabus", () => {
  it("has 2 modules of 2–3 lessons whose content passes teacher-input validation in every language", () => {
    expect(SAMPLE_MODULES).toHaveLength(2);
    for (const m of SAMPLE_MODULES) {
      expect(m.lessons.length).toBeGreaterThanOrEqual(2);
      expect(m.lessons.length).toBeLessThanOrEqual(3);
      for (const locale of ["az", "en", "ru"] as const) {
        expect(m.title[locale].trim()).not.toBe("");
        for (const l of m.lessons) for (const it of l.items) expect(() => parseItemContent(it.kind, it.content(locale))).not.toThrow();
      }
    }
    const kinds = new Set(SAMPLE_MODULES.flatMap((m) => m.lessons.flatMap((l) => l.items.map((i) => i.kind))));
    expect([...kinds].sort()).toEqual(["RESOURCE", "STUDENT_PRACTICE", "TEACHER_PRACTICE", "THEORY"]);
  });
});

// ---------------------------------------------------------------------------
// Publish dialog diff
// ---------------------------------------------------------------------------

const R = resolveRules();
const it_ = (id: string, over: Partial<ItemStub> = {}): ItemStub => ({
  id,
  kind: "THEORY",
  scope: "LESSON",
  title: id,
  position: 0,
  required: true,
  assessmentId: null,
  assessmentVersionId: null,
  taskId: null,
  passPct: null,
  retry: null,
  ...over,
});
const lesson = (id: string, moduleId: string, items: ItemStub[], over: Partial<LessonStub> = {}): LessonStub => ({
  id,
  moduleId,
  title: id,
  description: "",
  position: 0,
  estimatedMinutes: null,
  objectives: [],
  rules: R,
  items,
  ...over,
});
const mod = (id: string, lessons: LessonStub[], over: Partial<ModuleStub> = {}): ModuleStub => ({
  id,
  title: id,
  description: "",
  position: 0,
  estimatedMinutes: null,
  objectives: [],
  prerequisitesText: "",
  rules: R,
  lessons,
  items: [],
  ...over,
});
const tree = (modules: ModuleStub[], rules = R): VersionStructure => ({ formatVersion: 1, rules, modules, finalItems: [] });
const hashes = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("diffStructures", () => {
  const v1 = tree([mod("m1", [lesson("l1", "m1", [it_("a"), it_("b")])]), mod("m2", [lesson("l2", "m2", [it_("c")])])]);
  const h1 = hashes({ a: "1", b: "1", c: "1" });

  it("reports a first version", () => {
    const d = diffStructures(null, v1, new Map(), h1);
    expect(d).toMatchObject({ firstVersion: true, changed: true, modules: { added: 2, removed: 0, changed: 0 } });
  });

  it("finds nothing when the draft equals the current version", () => {
    const d = diffStructures(v1, v1, h1, h1);
    expect(d).toMatchObject({ firstVersion: false, changed: false, reordered: false, rulesChanged: false });
  });

  it("counts added, removed and changed nodes, reordering and rule changes", () => {
    const v2 = tree(
      [
        mod("m2", [lesson("l2", "m2", [it_("c")]), lesson("l3", "m2", [it_("d")])]),
        mod("m1", [lesson("l1", "m1", [it_("a")], { title: "renamed" })]),
      ],
      resolveRules({ theory: "OPTIONAL" }),
    );
    const d = diffStructures(v1, v2, h1, hashes({ a: "2", c: "1", d: "1" }));
    expect(d.modules).toEqual({ added: 0, removed: 0, changed: 1 });
    expect(d.lessons).toEqual({ added: 1, removed: 0, changed: 1 });
    expect(d.items).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(d.reordered).toBe(true);
    expect(d.rulesChanged).toBe(true);
    expect(d.changed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Client utilities
// ---------------------------------------------------------------------------

describe("reordering", () => {
  it("moves one element and ignores out-of-range moves", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(["a", "b"], 0, 5)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], -1, 0)).toEqual(["a", "b"]);
  });

  it("reorders a subset inside the full order", () => {
    expect(mergeSubsetOrder(["t1", "p1", "t2", "r1", "t3"], ["t3", "t1", "t2"])).toEqual(["t3", "p1", "t1", "r1", "t2"]);
    expect(mergeSubsetOrder(["a", "b"], [])).toEqual(["a", "b"]);
  });
});

describe("completion rule overrides", () => {
  it("sets and clears top-level and retry fields, dropping an empty retry object", () => {
    let patch = withOverride(null, "theory", "OPTIONAL");
    expect(patch).toEqual({ theory: "OPTIONAL" });
    patch = withOverride(patch, "retry.maxAttempts", null);
    patch = withOverride(patch, "retry.cooldownMinutes", 15);
    expect(patch).toEqual({ theory: "OPTIONAL", retry: { maxAttempts: null, cooldownMinutes: 15 } });
    expect(isOverridden(patch, "retry.maxAttempts")).toBe(true);
    expect(isOverridden(patch, "retry.scorePolicy")).toBe(false);
    expect(overrideCount(patch)).toBe(3);
    const effective = resolveRules(patch);
    expect(ruleValue(effective, "retry.maxAttempts")).toBeNull();
    expect(ruleValue(effective, "retry.scorePolicy")).toBe(DEFAULT_COMPLETION_RULES.retry.scorePolicy);
    patch = withoutOverride(patch, "retry.maxAttempts");
    patch = withoutOverride(patch, "retry.cooldownMinutes");
    expect(patch).toEqual({ theory: "OPTIONAL" });
    expect(withoutOverride(patch, "theory")).toEqual({});
  });

  it("knows every rule field", () => {
    for (const f of RULE_FIELDS) expect(ruleValue(DEFAULT_COMPLETION_RULES, f)).not.toBeUndefined();
  });
});

describe("mini markdown", () => {
  it("parses headings, paragraphs, lists, quotes, code fences and rules", () => {
    const blocks = parseMarkdown("# Title\n\nSome **bold** and *it*\ncontinued.\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n```java\nint x = 1;\n```\n\n---");
    expect(blocks.map((b) => b.t)).toEqual(["heading", "paragraph", "list", "list", "quote", "code", "rule"]);
    expect(blocks[0]).toEqual({ t: "heading", level: 1, c: [{ t: "text", v: "Title" }] });
    expect(blocks[1]).toEqual({
      t: "paragraph",
      c: [{ t: "text", v: "Some " }, { t: "strong", c: [{ t: "text", v: "bold" }] }, { t: "text", v: " and " }, { t: "em", c: [{ t: "text", v: "it" }] }, { t: "text", v: " continued." }],
    });
    expect(blocks[2]).toMatchObject({ t: "list", ordered: false, items: [[{ v: "one" }], [{ v: "two" }]] });
    expect(blocks[3]).toMatchObject({ t: "list", ordered: true });
    expect(blocks[5]).toEqual({ t: "code", lang: "java", v: "int x = 1;" });
  });

  it("links only http(s) and mailto targets and keeps code literal", () => {
    expect(parseInline("[ok](https://a.example) [bad](javascript:alert(1)) `**x**`")).toEqual([
      { t: "link", href: "https://a.example", c: [{ t: "text", v: "ok" }] },
      { t: "text", v: " " },
      { t: "text", v: "bad" },
      { t: "text", v: ") " },
      { t: "code", v: "**x**" },
    ]);
    expect(safeHref("mailto:a@b.example")).toBe("mailto:a@b.example");
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
  });
});

describe("theory blocks", () => {
  it("drops empty blocks and client keys so the result passes the server schema", () => {
    const blocks = [
      { ...emptyBlock("markdown"), md: "Hello" },
      emptyBlock("markdown"),
      { ...emptyBlock("code"), language: "java", code: "x();" },
      emptyBlock("image"),
      { ...emptyBlock("image"), url: "https://img.example/a.png", fileId: undefined },
      { ...emptyBlock("video"), url: "https://youtu.be/dQw4w9WgXcQ", provider: "youtube" },
      emptyBlock("material"),
      emptyBlock("table"),
    ];
    const saved = blocksForSave(blocks);
    expect(saved.map((b) => b.type)).toEqual(["markdown", "code", "image", "video", "table"]);
    expect(saved.every((b) => !("key" in b))).toBe(true);
    expect(saved[2]).toEqual({ type: "image", caption: "", url: "https://img.example/a.png" });
    expect(theoryContentSchema.safeParse({ blocks: saved }).success).toBe(true);
    expect(THEORY_BLOCK_TYPES.every((type) => emptyBlock(type).type === type)).toBe(true);
  });

  it("resizes tables within the limits and keeps existing cells", () => {
    expect(resizeTable([["a", "b"], ["c", "d"]], 3, 1)).toEqual([["a"], ["c"], [""]]);
    expect(resizeTable([["a"]], 0, 99)[0]).toHaveLength(12);
    expect(resizeTable([["a"]], 500, 1)).toHaveLength(60);
  });
});

describe("syllabus labels", () => {
  it("has a translation for every dynamic key the builder uses", () => {
    const keys = [
      ...SYLLABUS_ITEM_KINDS.flatMap((k) => [`syllabus.kind.${k}`, `syllabus.tabKind.${k}`, `syllabus.kindHelp.${k}`]),
      ...THEORY_BLOCK_TYPES.map((b) => `syllabus.block.${b}`),
      ...RULE_FIELDS.map((f) => `syllabus.rules.field.${f.replace("retry.", "retry_")}`),
      ...THEORY_RULES.map((v) => `syllabus.rules.theory.${v}`),
      ...TEACHER_PRACTICE_RULES.map((v) => `syllabus.rules.teacherPractice.${v}`),
      ...STUDENT_PRACTICE_RULES.map((v) => `syllabus.rules.studentPractice.${v}`),
      ...ASSESSMENT_RULES.map((v) => `syllabus.rules.assessment.${v}`),
      ...SCORE_POLICIES.map((v) => `syllabus.rules.scorePolicy.${v}`),
      ...SYLLABUS_STATUSES.map((s) => `syllabus.status.${s}`),
      ...SYLLABUS_GRANT_STATES.map((s) => `syllabus.grant.${s}`),
      ...SUBMISSION_TYPES.map((s) => `syllabus.sp.submission.${s}`),
      ...["SYLLABUS_EMPTY", "SYLLABUS_ASSESSMENT_NOT_PUBLISHED", "SYLLABUS_INVALID_CONTENT", "SYLLABUS_STALE_REVISION", "SYLLABUS_NOT_AVAILABLE"].map((c) => `error.${c}`),
    ];
    expect(keys.filter((k) => !isMessageKey(k))).toEqual([]);
  });
});

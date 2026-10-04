import { describe, expect, it } from "vitest";
import { highlightCode, normalizeLanguage } from "../client/src/lib/syllabusCode";
import { lockTarget, minutesUntil, nodeVisual, pct, safeReturnPath } from "../client/src/lib/syllabusLearn";
import { ActivityQueue, crossedMarks } from "../client/src/lib/syllabusTracker";
import { MAX_ACTIVITY_BATCH, resolveRules, type CompletionRules } from "../shared/syllabus";
import {
  buildSyllabusAccessEmail,
  buildSyllabusCompletedEmail,
  syllabusApprovalInApp,
  syllabusUnlockedInApp,
} from "./notifications/templates";
import { computeProgress } from "./syllabus/engine";
import { fileIdPattern, itemsUsingFile } from "./syllabus/fileAccess";
import { batchKey, planNotices, unseenNodes } from "./syllabus/notify";
import { assessmentState, practiceDueAt, progressSummary, type AttemptRow } from "./syllabus/studentDetails";
import type { EngineInput, EngineOutput, ItemFact, ItemStub, LessonStub, ModuleStub, PrevNode, VersionStructure } from "./syllabus/types";

// ---------------------------------------------------------------------------
// Builders (same shapes as syllabusEngine.test.ts)
// ---------------------------------------------------------------------------

function item(id: string, kind: ItemStub["kind"], over: Partial<ItemStub> = {}): ItemStub {
  return {
    id,
    kind,
    scope: "LESSON",
    title: id,
    position: 0,
    required: true,
    assessmentId: kind === "ASSESSMENT" ? `as_${id}` : null,
    assessmentVersionId: kind === "ASSESSMENT" ? `av_${id}` : null,
    taskId: kind === "STUDENT_PRACTICE" ? `t_${id}` : null,
    passPct: null,
    retry: null,
    ...over,
  };
}
const lesson = (id: string, moduleId: string, items: ItemStub[], rules: CompletionRules = resolveRules()): LessonStub => ({
  id,
  moduleId,
  title: `Lesson ${id}`,
  description: "",
  position: 0,
  estimatedMinutes: null,
  objectives: [],
  rules,
  items,
});
const mod = (id: string, lessons: LessonStub[], rules: CompletionRules = resolveRules()): ModuleStub => ({
  id,
  title: `Module ${id}`,
  description: "",
  position: 0,
  estimatedMinutes: null,
  objectives: [],
  prerequisitesText: "",
  rules,
  lessons,
  items: [],
});
const tree = (modules: ModuleStub[], rules = resolveRules()): VersionStructure => ({ formatVersion: 1, rules, modules, finalItems: [] });

function run(structure: VersionStructure, over: Partial<Omit<EngineInput, "structure">> = {}): EngineOutput {
  return computeProgress({
    structure,
    facts: new Map(),
    prevModules: new Map(),
    prevLessons: new Map(),
    openedLessons: new Set(),
    manualModules: new Set(),
    manualLessons: new Set(),
    approvals: new Set(),
    ...over,
  });
}
const persisted = (out: EngineOutput) => ({
  prevModules: new Map<string, PrevNode>(out.modules.map((m) => [m.id, { status: m.status, unlockSource: m.unlockSource }])),
  prevLessons: new Map<string, PrevNode>(out.lessons.map((l) => [l.id, { status: l.status, unlockSource: l.unlockSource }])),
});
const done: ItemFact = { completedAt: new Date("2026-01-01") };

/** m1: l1(th1), l2(th2) · m2: l3(th3) */
const basic = (rules = resolveRules()) =>
  tree(
    [mod("m1", [lesson("l1", "m1", [item("th1", "THEORY")], rules), lesson("l2", "m1", [item("th2", "THEORY")], rules)], rules), mod("m2", [lesson("l3", "m2", [item("th3", "THEORY")], rules)], rules)],
    rules,
  );

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

describe("syllabus notices", () => {
  it("announces newly unlocked lessons and modules, but not the very first ones", () => {
    const s = basic();
    const first = run(s);
    expect(planNotices(s, first).lessons).toEqual([]);
    expect(planNotices(s, first).modules).toEqual([]);

    const second = run(s, { ...persisted(first), facts: new Map([["th1", done]]) });
    expect(planNotices(s, second).lessons).toEqual([{ id: "l2", title: "Lesson l2" }]);

    const third = run(s, { ...persisted(second), facts: new Map([["th1", done], ["th2", done]]) });
    const plan = planNotices(s, third);
    expect(plan.modules).toEqual([{ id: "m2", title: "Module m2" }]);
    expect(plan.lessons.map((l) => l.id)).toEqual(["l3"]);
  });

  it("asks for approval when only the teacher's approval is missing", () => {
    const rules = resolveRules({ teacherApproval: true });
    const s = tree([mod("m1", [lesson("l1", "m1", [item("th1", "THEORY")], rules)], rules)], rules);
    const first = run(s);
    const second = run(s, { ...persisted(first), facts: new Map([["th1", done]]) });
    expect(planNotices(s, second).approvals).toContainEqual({ type: "LESSON", id: "l1" });
    const approved = run(s, { ...persisted(second), facts: new Map([["th1", done]]), approvals: new Set(["LESSON:l1", "MODULE:m1"]) });
    expect(approved.syllabusAwaitingApproval).toBe(true);
    expect(planNotices(s, approved).approvals).toContainEqual({ type: "SYLLABUS", id: "syllabus" });
    const finished = run(s, { ...persisted(approved), facts: new Map([["th1", done]]), approvals: new Set(["LESSON:l1", "MODULE:m1", "SYLLABUS:syllabus"]) });
    expect(finished.syllabusCompleted).toBe(true);
    expect(finished.syllabusAwaitingApproval).toBe(false);
  });

  it("drops what the student already opened before the batch goes out", () => {
    const batch = { lessons: [{ id: "l2", title: "a" }, { id: "l3", title: "b" }], modules: [{ id: "m2", title: "c" }] };
    expect(unseenNodes(batch, new Set(["l2"]), new Set(["m2"]))).toEqual({ lessons: [{ id: "l3", title: "b" }], modules: [] });
  });

  it("dedupe keys do not depend on order", () => {
    expect(batchKey(["l2", "m2"])).toBe(batchKey(["m2", "l2"]));
    expect(batchKey(["l2"])).not.toBe(batchKey(["l3"]));
  });

  it("renders unlock and approval notices in every locale", () => {
    for (const locale of ["az", "en", "ru"] as const) {
      const u = syllabusUnlockedInApp(locale, { syllabusTitle: "Java", lessons: ["Loops", "Arrays"], modules: [] });
      expect(u.title.length + u.body.length).toBeGreaterThan(0);
      expect(`${u.title} ${u.body}`).toContain("Java");
      const a = syllabusApprovalInApp(locale, { syllabusTitle: "Java", count: 3, studentName: null });
      expect(`${a.title} ${a.body}`).toContain("3");
    }
  });

  it("access and completion emails link to the student page and escape titles", () => {
    const access = buildSyllabusAccessEmail({ to: "s@x.az", locale: "az", syllabusId: "syl1", syllabusTitle: "<b>Java</b>", startsAt: null, appUrl: "https://resulio.az" });
    expect(access.html).toContain("https://resulio.az/student/syllabus/syl1");
    expect(access.html).not.toContain("<b>Java</b>");
    expect(access.text).toContain("Java");
    const completed = buildSyllabusCompletedEmail({ to: "s@x.az", locale: "en", syllabusId: "syl1", syllabusTitle: "Java", verificationCode: "ABC-123", appUrl: "https://resulio.az" });
    expect(completed.text).toContain("ABC-123");
  });
});

// ---------------------------------------------------------------------------
// Lesson player details
// ---------------------------------------------------------------------------

const attempt = (over: Partial<AttemptRow>): AttemptRow => ({
  attemptId: "a1",
  attemptNo: 1,
  status: "SUBMITTED",
  resultId: "r1",
  pct: 50,
  held: false,
  pending: false,
  finishedAt: new Date("2026-01-01T10:00:00Z"),
  ...over,
});

describe("assessment state in the lesson player", () => {
  const rules = { assessmentPassPct: 60, retry: { maxAttempts: 3, cooldownMinutes: 30, scorePolicy: "BEST" as const } };
  const now = new Date("2026-01-01T10:10:00Z");

  it("reports pass mark, attempts left and the cooldown", () => {
    const s = assessmentState({ passPct: null, retry: null }, rules, [attempt({})], true, now);
    expect(s).toMatchObject({ passPct: 60, used: 1, left: 2, bestPct: 50, latestPct: 50, canStart: false });
    expect(s.cooldownUntil?.toISOString()).toBe("2026-01-01T10:30:00.000Z");
    const later = assessmentState({ passPct: null, retry: null }, rules, [attempt({})], true, new Date("2026-01-01T10:31:00Z"));
    expect(later.canStart).toBe(true);
    expect(later.cooldownUntil).toBeNull();
  });

  it("uses the item's own pass mark and retry policy", () => {
    const s = assessmentState({ passPct: 80, retry: { maxAttempts: 1, cooldownMinutes: 0, scorePolicy: "LATEST" } }, rules, [attempt({})], true, now);
    expect(s).toMatchObject({ passPct: 80, maxAttempts: 1, left: 0, canStart: false, scorePolicy: "LATEST" });
  });

  it("an attempt in progress can always be resumed; withheld scores stay hidden", () => {
    const s = assessmentState({ passPct: null, retry: null }, rules, [attempt({ pct: null, held: true }), attempt({ attemptId: "a2", attemptNo: 2, status: "IN_PROGRESS", resultId: null, finishedAt: null })], true, now);
    expect(s.inProgressAttemptId).toBe("a2");
    expect(s.canStart).toBe(true);
    expect(s.bestPct).toBeNull();
    expect(s.attempts).toEqual([expect.objectContaining({ held: true, pct: null })]);
  });

  it("nothing can start while the item is not available", () => {
    expect(assessmentState({ passPct: null, retry: null }, rules, [], false, now).canStart).toBe(false);
  });
});

describe("practice due date", () => {
  it("absolute and relative deadlines", () => {
    expect(practiceDueAt({ type: "ABSOLUTE", at: "2026-02-01T09:00:00Z" }, null)?.toISOString()).toBe("2026-02-01T09:00:00.000Z");
    expect(practiceDueAt({ type: "RELATIVE_DAYS", days: 3 }, new Date("2026-01-01T00:00:00Z"))?.toISOString()).toBe("2026-01-04T00:00:00.000Z");
    expect(practiceDueAt({ type: "RELATIVE_DAYS", days: 3 }, null)).toBeNull();
    expect(practiceDueAt({ type: "NONE" }, null)).toBeNull();
    expect(practiceDueAt({ type: "ABSOLUTE", at: "nonsense" }, null)).toBeNull();
  });
});

describe("progress summary", () => {
  it("counts practice and theory, and lists only open or attempted assessments", () => {
    const s = tree([
      mod("m1", [lesson("l1", "m1", [item("th1", "THEORY"), item("sp1", "STUDENT_PRACTICE"), item("as1", "ASSESSMENT")])]),
      mod("m2", [lesson("l2", "m2", [item("as2", "ASSESSMENT")])]),
    ]);
    const facts = new Map<string, ItemFact>([["th1", done]]);
    const out = run(s, { facts });
    const summary = progressSummary(s, out, facts);
    expect(summary.theory).toEqual({ total: 1, completed: 1 });
    expect(summary.practice).toMatchObject({ total: 1, completed: 0 });
    expect(summary.assessments.map((a) => a.itemId)).toEqual(["as1"]);
  });
});

describe("syllabus file access", () => {
  it("finds the items whose content uses a file", () => {
    const rows = [
      { itemId: "th1", kind: "THEORY" as const, content: { blocks: [{ type: "file", fileId: "f1", name: "a.pdf" }] } },
      { itemId: "th2", kind: "THEORY" as const, content: { blocks: [{ type: "image", fileId: "f2" }] } },
      { itemId: "sp1", kind: "STUDENT_PRACTICE" as const, content: { instructions: "", attachments: [{ fileId: "f1", name: "x" }] } },
    ];
    expect(itemsUsingFile(rows, "f1").sort()).toEqual(["sp1", "th1"]);
    expect(itemsUsingFile(rows, "f9")).toEqual([]);
  });

  it("escapes LIKE wildcards in the id", () => {
    expect(fileIdPattern("a_b%c")).toBe('%"a\\_b\\%c"%');
  });
});

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

describe("code highlighting", () => {
  it("marks keywords, strings, comments and numbers", () => {
    const tokens = highlightCode('for i in range(10):\n    print("hi")  # done', "py");
    expect(tokens.find((t) => t.k === "keyword")?.v).toBe("for");
    expect(tokens.some((t) => t.k === "string" && t.v === '"hi"')).toBe(true);
    expect(tokens.some((t) => t.k === "comment" && t.v === "# done")).toBe(true);
    expect(tokens.some((t) => t.k === "number" && t.v === "10")).toBe(true);
    expect(tokens.map((t) => t.v).join("")).toBe('for i in range(10):\n    print("hi")  # done');
  });

  it("knows aliases and falls back for unknown languages", () => {
    expect(normalizeLanguage("JS")).toBe("javascript");
    expect(normalizeLanguage("brainfuck")).toBeNull();
    expect(highlightCode("x = 1 // c", "unknown").some((t) => t.k === "comment")).toBe(true);
  });

  it("stays linear on large input", () => {
    const code = "int x = 1; // comment\n".repeat(2500);
    const started = Date.now();
    expect(highlightCode(code, "java").map((t) => t.v).join("")).toBe(code);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("activity queue", () => {
  it("sends each 'opened' event once and merges heartbeats", () => {
    const q = new ActivityQueue();
    expect(q.push({ type: "LESSON_OPENED", lessonId: "l1" })).toBe(true);
    expect(q.push({ type: "LESSON_OPENED", lessonId: "l1" })).toBe(false);
    q.push({ type: "HEARTBEAT", lessonId: "l1", durationSeconds: 30 });
    q.push({ type: "HEARTBEAT", lessonId: "l1", durationSeconds: 30 });
    q.push({ type: "VIDEO_PROGRESS", itemId: "th1", metadata: { blockIndex: 0, pct: 25 } });
    q.push({ type: "VIDEO_PROGRESS", itemId: "th1", metadata: { blockIndex: 0, pct: 25 } });
    q.push({ type: "VIDEO_PROGRESS", itemId: "th1", metadata: { blockIndex: 0, pct: 50 } });
    const batch = q.take();
    expect(batch.map((e) => e.type)).toEqual(["LESSON_OPENED", "HEARTBEAT", "VIDEO_PROGRESS", "VIDEO_PROGRESS"]);
    expect(batch[1].durationSeconds).toBe(60);
    expect(q.size).toBe(0);
  });

  it("batches stay within the server limit and failed batches return to the front", () => {
    const q = new ActivityQueue();
    for (let i = 0; i < MAX_ACTIVITY_BATCH + 5; i++) q.push({ type: "THEORY_OPENED", itemId: `th${i}` });
    expect(q.full).toBe(true);
    const batch = q.take();
    expect(batch).toHaveLength(MAX_ACTIVITY_BATCH);
    q.restore(batch);
    expect(q.size).toBe(MAX_ACTIVITY_BATCH + 5);
    expect(q.take()[0].itemId).toBe("th0");
  });

  it("video marks are reported once each", () => {
    expect(crossedMarks(0, 30)).toEqual([25]);
    expect(crossedMarks(30, 80)).toEqual([50, 75]);
    expect(crossedMarks(80, 99)).toEqual([]);
  });
});

describe("learning path helpers", () => {
  const path = { modules: [{ id: "m1", lessons: [{ id: "l1" }, { id: "l2" }] }, { id: "m2", lessons: [{ id: "l3" }, { id: "l4" }] }] };

  it("lock reasons point at the numbered node the student sees", () => {
    expect(lockTarget({ code: "PREVIOUS_LESSON", lessonId: "l4", title: "Loops" }, path)).toEqual({ kind: "lesson", n: 2, title: "Loops" });
    expect(lockTarget({ code: "PREVIOUS_MODULE", moduleId: "m2", title: "OOP" }, path)).toEqual({ kind: "module", n: 2, title: "OOP" });
    expect(lockTarget({ code: "ALL_MODULES" }, path)?.kind).toBe("all");
    expect(lockTarget(null, path)).toBeNull();
  });

  it("node visuals", () => {
    expect(nodeVisual("COMPLETED", true)).toBe("done");
    expect(nodeVisual("LOCKED", false)).toBe("locked");
    expect(nodeVisual("AWAITING_APPROVAL", true)).toBe("waiting");
    expect(nodeVisual("IN_PROGRESS", true)).toBe("current");
    expect(nodeVisual("AVAILABLE", false)).toBe("open");
    expect(pct(1, 3)).toBe(33);
    expect(pct(0, 0)).toBe(0);
  });

  it("only syllabus pages are accepted as a return target", () => {
    expect(safeReturnPath("/student/syllabus/abc/lessons/l_1")).toBe("/student/syllabus/abc/lessons/l_1");
    expect(safeReturnPath("/student/syllabus/abc")).toBe("/student/syllabus/abc");
    expect(safeReturnPath("https://evil.example/student/syllabus/abc")).toBeNull();
    expect(safeReturnPath("//evil.example")).toBeNull();
    expect(safeReturnPath("/student/syllabus/abc/../../admin")).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
  });

  it("cooldown minutes round up", () => {
    const now = Date.parse("2026-01-01T10:00:00Z");
    expect(minutesUntil("2026-01-01T10:00:30Z", now)).toBe(1);
    expect(minutesUntil("2026-01-01T09:00:00Z", now)).toBe(0);
    expect(minutesUntil(null, now)).toBe(0);
  });
});

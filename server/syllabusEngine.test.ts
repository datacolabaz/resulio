import { describe, expect, it } from "vitest";
import { DEFAULT_COMPLETION_RULES, resolveRules, type CompletionRules, type CompletionRulesPatch } from "../shared/syllabus";
import { availableAssessmentItems, computeProgress, evaluateItem, grandfatheredLessons, locateItem } from "./syllabus/engine";
import { buildStructure, contentHash, nextVersionLabel, type DraftItem, type DraftLesson, type DraftModule } from "./syllabus/snapshot";
import type { EngineInput, EngineOutput, ItemFact, ItemStub, LessonStub, ModuleStub, PrevNode, VersionStructure } from "./syllabus/types";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const R = (patch: CompletionRulesPatch = {}) => resolveRules(patch);

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

function lesson(id: string, moduleId: string, items: ItemStub[], rules: CompletionRules = R()): LessonStub {
  return { id, moduleId, title: id, description: "", position: 0, estimatedMinutes: null, objectives: [], rules, items };
}

function mod(id: string, lessons: LessonStub[], over: Partial<ModuleStub> = {}): ModuleStub {
  return { id, title: id, description: "", position: 0, estimatedMinutes: null, objectives: [], prerequisitesText: "", rules: R(), lessons, items: [], ...over };
}

const tree = (modules: ModuleStub[], finalItems: ItemStub[] = [], rules = R()): VersionStructure => ({ formatVersion: 1, rules, modules, finalItems });

/** Two modules × two lessons, one THEORY item each: m1/l1(th1), m1/l2(th2), m2/l3(th3), m2/l4(th4). */
function basic(rules = R()) {
  return tree([
    mod("m1", [lesson("l1", "m1", [item("th1", "THEORY")], rules), lesson("l2", "m1", [item("th2", "THEORY")], rules)], { rules }),
    mod("m2", [lesson("l3", "m2", [item("th3", "THEORY")], rules), lesson("l4", "m2", [item("th4", "THEORY")], rules)], { rules }),
  ]);
}

const done: ItemFact = { completedAt: new Date("2026-01-01") };

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

/** What progression.ts would have persisted after `out`. */
function persisted(out: EngineOutput) {
  return {
    prevModules: new Map<string, PrevNode>(out.modules.map((m) => [m.id, { status: m.status, unlockSource: m.unlockSource }])),
    prevLessons: new Map<string, PrevNode>(out.lessons.map((l) => [l.id, { status: l.status, unlockSource: l.unlockSource }])),
  };
}

const lessonOf = (out: EngineOutput, id: string) => out.lessons.find((l) => l.id === id)!;
const moduleOf = (out: EngineOutput, id: string) => out.modules.find((m) => m.id === id)!;
const assessmentFact = (pcts: Array<number | "pending">, inProgress = false): ItemFact => ({
  assessment: {
    finished: pcts.length,
    inProgress,
    outcomes: pcts.map((p) => (p === "pending" ? { pct: 0, pending: true } : { pct: p, pending: false })),
    lastFinishedAt: pcts.length ? new Date() : null,
  },
});

// ---------------------------------------------------------------------------
// Rules and inheritance
// ---------------------------------------------------------------------------

describe("completion rules inheritance", () => {
  it("starts from the owner-approved defaults", () => {
    expect(resolveRules()).toEqual(DEFAULT_COMPLETION_RULES);
    expect(DEFAULT_COMPLETION_RULES).toMatchObject({
      sequentialModules: true,
      sequentialLessons: true,
      theory: "REQUIRED",
      teacherPractice: "VIEWED",
      studentPractice: "SUBMITTED",
      assessment: "PASSED",
      assessmentPassPct: 70,
      retry: { maxAttempts: 3, cooldownMinutes: 0, scorePolicy: "BEST" },
      teacherApproval: false,
    });
  });

  it("lets later layers override field by field and merges retry per field", () => {
    const rules = resolveRules(
      { assessmentPassPct: 80, retry: { maxAttempts: 5 } },
      { theory: "OPTIONAL", retry: { scorePolicy: "LATEST" } },
      { assessmentPassPct: 50, sequentialLessons: undefined },
    );
    expect(rules.assessmentPassPct).toBe(50);
    expect(rules.theory).toBe("OPTIONAL");
    expect(rules.sequentialLessons).toBe(true);
    expect(rules.retry).toEqual({ maxAttempts: 5, cooldownMinutes: 0, scorePolicy: "LATEST" });
  });

  it("does not mutate the shared defaults", () => {
    resolveRules({ retry: { maxAttempts: 9 } });
    expect(DEFAULT_COMPLETION_RULES.retry.maxAttempts).toBe(3);
  });
});

describe("snapshot (publish) structure", () => {
  const m = (id: string, position: number, over: Partial<DraftModule> = {}): DraftModule => ({
    id,
    position,
    title: id,
    description: null,
    estimatedMinutes: null,
    objectives: [],
    prerequisitesText: null,
    status: "READY",
    completionRules: null,
    ...over,
  });
  const l = (id: string, moduleId: string, position: number, over: Partial<DraftLesson> = {}): DraftLesson => ({
    id,
    moduleId,
    position,
    title: id,
    description: null,
    estimatedMinutes: null,
    objectives: [],
    status: "READY",
    completionRules: null,
    ...over,
  });
  const i = (id: string, over: Partial<DraftItem>): DraftItem => ({
    id,
    scope: "LESSON",
    moduleId: null,
    lessonId: null,
    kind: "THEORY",
    position: 0,
    title: id,
    required: true,
    content: {},
    assessmentId: null,
    taskId: null,
    ...over,
  });

  it("resolves syllabus → module → lesson rules into every lesson and keeps only READY nodes", () => {
    const { structure, problems } = buildStructure({
      syllabusRules: { assessmentPassPct: 60 },
      modules: [m("m2", 2), m("m1", 1, { completionRules: { theory: "OPTIONAL" } }), m("draft", 3, { status: "DRAFT" }), m("empty", 4)],
      lessons: [l("l1", "m1", 1, { completionRules: { assessmentPassPct: 90 } }), l("l2", "m1", 2, { status: "DRAFT" }), l("l3", "m2", 1), l("lx", "draft", 1)],
      items: [
        i("a1", { lessonId: "l1", kind: "ASSESSMENT", assessmentId: "as1", content: { maxAttempts: 1 } }),
        i("p1", { lessonId: "l3", kind: "STUDENT_PRACTICE", content: { passPct: 55 } }),
      ],
      publishedAssessments: new Map([["as1", "asv1"]]),
      frozenTaskIds: new Map([["p1", "task_frozen"]]),
    });
    expect(problems).toEqual([]);
    expect(structure.modules.map((x) => x.id)).toEqual(["m1", "m2"]);
    expect(structure.modules[0].lessons.map((x) => x.id)).toEqual(["l1"]);
    const l1 = structure.modules[0].lessons[0];
    expect(l1.rules).toMatchObject({ theory: "OPTIONAL", assessmentPassPct: 90 });
    expect(structure.modules[1].lessons[0].rules).toMatchObject({ theory: "REQUIRED", assessmentPassPct: 60 });
    expect(l1.items[0]).toMatchObject({ assessmentVersionId: "asv1", retry: { maxAttempts: 1, cooldownMinutes: 0, scorePolicy: "BEST" } });
    expect(structure.modules[1].lessons[0].items[0]).toMatchObject({ taskId: "task_frozen", passPct: 55 });
  });

  it("reports an empty syllabus and unpublished assessments", () => {
    expect(buildStructure({ syllabusRules: null, modules: [], lessons: [], items: [], publishedAssessments: new Map(), frozenTaskIds: new Map() }).problems).toEqual([
      { code: "SYLLABUS_EMPTY" },
    ]);
    const { problems } = buildStructure({
      syllabusRules: null,
      modules: [m("m1", 1)],
      lessons: [l("l1", "m1", 1)],
      items: [i("a1", { lessonId: "l1", kind: "ASSESSMENT", assessmentId: "draft_assessment" })],
      publishedAssessments: new Map(),
      frozenTaskIds: new Map(),
    });
    expect(problems).toEqual([{ code: "SYLLABUS_ASSESSMENT_NOT_PUBLISHED", itemId: "a1", title: "a1" }]);
  });

  it("hashes item meaning (including the answer key) independently of key order", () => {
    const a = { kind: "STUDENT_PRACTICE" as const, title: "T", required: true, content: { x: 1, y: [1, 2] }, assessmentId: null };
    const b = { ...a, content: { y: [1, 2], x: 1 } };
    expect(contentHash(a, "key")).toBe(contentHash(b, "key"));
    expect(contentHash(a, "key")).not.toBe(contentHash(a, "other key"));
    expect(nextVersionLabel(3)).toBe("v3.0");
  });
});

// ---------------------------------------------------------------------------
// Item rules
// ---------------------------------------------------------------------------

describe("item evaluation", () => {
  it("theory: required needs completion, optional never blocks", () => {
    expect(evaluateItem(item("t", "THEORY"), R(), undefined)).toBe("UNMET");
    expect(evaluateItem(item("t", "THEORY"), R(), done)).toBe("MET");
    expect(evaluateItem(item("t", "THEORY"), R({ theory: "OPTIONAL" }), undefined)).toBe("NOT_REQUIRED");
    expect(evaluateItem(item("t", "THEORY", { required: false }), R(), undefined)).toBe("NOT_REQUIRED");
  });

  it("teacher practice: VIEWED vs TEACHER_MARKED", () => {
    const tp = item("tp", "TEACHER_PRACTICE");
    expect(evaluateItem(tp, R(), { openedAt: new Date() })).toBe("MET");
    expect(evaluateItem(tp, R({ teacherPractice: "TEACHER_MARKED" }), { openedAt: new Date() })).toBe("UNMET");
    expect(evaluateItem(tp, R({ teacherPractice: "TEACHER_MARKED" }), { teacherMarkedAt: new Date() })).toBe("MET");
    expect(evaluateItem(tp, R({ teacherPractice: "NONE" }), undefined)).toBe("NOT_REQUIRED");
  });

  it("student practice: SUBMITTED, GRADED (pending until released), PASSED with item override", () => {
    const sp = item("sp", "STUDENT_PRACTICE");
    const submitted = (released: boolean, score: number | null): ItemFact => ({ practice: { submittedAt: new Date(), released, score } });
    expect(evaluateItem(sp, R(), undefined)).toBe("UNMET");
    expect(evaluateItem(sp, R(), submitted(false, null))).toBe("MET");
    expect(evaluateItem(sp, R({ studentPractice: "GRADED" }), submitted(false, null))).toBe("PENDING");
    expect(evaluateItem(sp, R({ studentPractice: "GRADED" }), submitted(true, 10))).toBe("MET");
    expect(evaluateItem(sp, R({ studentPractice: "PASSED" }), submitted(true, 59))).toBe("UNMET");
    expect(evaluateItem(sp, R({ studentPractice: "PASSED" }), submitted(true, 60))).toBe("MET");
    expect(evaluateItem(item("sp", "STUDENT_PRACTICE", { passPct: 90 }), R({ studentPractice: "PASSED" }), submitted(true, 80))).toBe("UNMET");
  });

  it("assessment BEST: a later pass counts, a pending answer waits, attempts can run out", () => {
    const a = item("a", "ASSESSMENT");
    expect(evaluateItem(a, R(), undefined)).toBe("UNMET");
    expect(evaluateItem(a, R(), assessmentFact([40]))).toBe("UNMET");
    expect(evaluateItem(a, R(), assessmentFact([40, 85, 30]))).toBe("MET");
    expect(evaluateItem(a, R(), assessmentFact([40, "pending"]))).toBe("PENDING");
    expect(evaluateItem(a, R(), assessmentFact([10, 20, 30]))).toBe("FAILED");
    expect(evaluateItem(a, R(), assessmentFact([10, 20, 30], true))).toBe("UNMET");
    expect(evaluateItem(a, R({ retry: { maxAttempts: null } }), assessmentFact([10, 20, 30, 40, 50]))).toBe("UNMET");
    expect(evaluateItem(a, R({ assessment: "ATTEMPTED" }), assessmentFact([5]))).toBe("MET");
    expect(evaluateItem(a, R({ assessment: "NONE" }), undefined)).toBe("NOT_REQUIRED");
  });

  it("assessment LATEST: only the newest attempt counts; item pass mark and retry override the rules", () => {
    const latest = R({ retry: { scorePolicy: "LATEST" } });
    const a = item("a", "ASSESSMENT");
    expect(evaluateItem(a, latest, assessmentFact([90, 40]))).toBe("UNMET");
    expect(evaluateItem(a, latest, assessmentFact([40, 90]))).toBe("MET");
    expect(evaluateItem(a, latest, assessmentFact([90, "pending"]))).toBe("PENDING");
    const strict = item("a", "ASSESSMENT", { passPct: 95, retry: { maxAttempts: 1, cooldownMinutes: 0, scorePolicy: "BEST" } });
    expect(evaluateItem(strict, R(), assessmentFact([90]))).toBe("FAILED");
  });

  it("resources never count", () => {
    expect(evaluateItem(item("r", "RESOURCE"), R(), undefined)).toBe("NOT_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// Progression
// ---------------------------------------------------------------------------

describe("sequential progression", () => {
  it("opens only the first lesson for a new student and explains every lock", () => {
    const out = run(basic());
    expect(lessonOf(out, "l1")).toMatchObject({ status: "AVAILABLE", unlockSource: "FIRST", lockReason: null });
    expect(lessonOf(out, "l2")).toMatchObject({ status: "LOCKED", unlockSource: null, lockReason: { code: "PREVIOUS_LESSON", lessonId: "l1" } });
    expect(lessonOf(out, "l3")).toMatchObject({ status: "LOCKED", lockReason: { code: "PREVIOUS_MODULE", moduleId: "m1" } });
    expect(moduleOf(out, "m2")).toMatchObject({ status: "LOCKED", lockReason: { code: "PREVIOUS_MODULE", moduleId: "m1" } });
    expect(out).toMatchObject({ progressPct: 0, completedLessons: 0, totalLessons: 4, currentLessonId: "l1", currentModuleId: "m1", syllabusCompleted: false });
  });

  it("completing a lesson unlocks the next one; finishing a module unlocks the next module", () => {
    let out = run(basic(), { facts: new Map([["th1", done]]) });
    expect(lessonOf(out, "l1").status).toBe("COMPLETED");
    expect(lessonOf(out, "l2")).toMatchObject({ status: "AVAILABLE", unlockSource: "SEQUENTIAL" });
    expect(out.progressPct).toBe(25);

    out = run(basic(), { facts: new Map([["th1", done], ["th2", done]]) });
    expect(moduleOf(out, "m1").status).toBe("COMPLETED");
    expect(moduleOf(out, "m2").status).toBe("AVAILABLE");
    expect(lessonOf(out, "l3").status).toBe("AVAILABLE");
    expect(lessonOf(out, "l4").status).toBe("LOCKED");
    expect(out.currentLessonId).toBe("l3");
  });

  it("marks an opened lesson IN_PROGRESS and reports transitions only on change", () => {
    const first = run(basic(), { openedLessons: new Set(["l1"]) });
    expect(lessonOf(first, "l1").status).toBe("IN_PROGRESS");
    expect(first.transitions).toEqual(
      expect.arrayContaining([
        { nodeType: "LESSON", id: "l1", from: "LOCKED", to: "IN_PROGRESS" },
        { nodeType: "MODULE", id: "m1", from: "LOCKED", to: "IN_PROGRESS" },
      ]),
    );
    const again = run(basic(), { openedLessons: new Set(["l1"]), ...persisted(first) });
    expect(again.transitions).toEqual([]);
  });

  it("free order when sequencing is off", () => {
    const out = run(basic(R({ sequentialLessons: false, sequentialModules: false })));
    expect(out.lessons.every((l) => l.status === "AVAILABLE")).toBe(true);
  });

  it("a lesson with only non-required items completes as soon as it opens", () => {
    const out = run(basic(R({ theory: "OPTIONAL" })));
    expect(out.lessons.every((l) => l.status === "COMPLETED")).toBe(true);
    expect(out.syllabusCompleted).toBe(true);
    expect(out.progressPct).toBe(100);
  });

  it("waits in AWAITING_REVIEW while a graded practice is unreleased", () => {
    const rules = R({ studentPractice: "GRADED" });
    const s = tree([mod("m1", [lesson("l1", "m1", [item("p1", "STUDENT_PRACTICE")], rules), lesson("l2", "m1", [item("t2", "THEORY")], rules)])]);
    const out = run(s, { facts: new Map([["p1", { practice: { submittedAt: new Date(), released: false, score: null } }]]) });
    expect(lessonOf(out, "l1").status).toBe("AWAITING_REVIEW");
    expect(lessonOf(out, "l2").status).toBe("LOCKED");
  });

  it("teacher approval holds a met lesson until approved", () => {
    const rules = R({ teacherApproval: true });
    const s = tree([mod("m1", [lesson("l1", "m1", [item("t1", "THEORY")], rules), lesson("l2", "m1", [item("t2", "THEORY")], rules)])]);
    const facts = new Map([["t1", done]]);
    expect(lessonOf(run(s, { facts }), "l1").status).toBe("AWAITING_APPROVAL");
    expect(lessonOf(run(s, { facts }), "l2").status).toBe("LOCKED");
    const approved = run(s, { facts, approvals: new Set(["LESSON:l1"]) });
    expect(lessonOf(approved, "l1").status).toBe("COMPLETED");
    expect(lessonOf(approved, "l2").status).toBe("AVAILABLE");
  });
});

describe("assessment pass / retry in the path", () => {
  const s = () => tree([mod("m1", [lesson("l1", "m1", [item("a1", "ASSESSMENT")]), lesson("l2", "m1", [item("t2", "THEORY")])])]);

  it("a failed attempt keeps the next lesson locked; a passing retry opens it", () => {
    let out = run(s(), { facts: new Map([["a1", assessmentFact([50])]]) });
    expect(lessonOf(out, "l1").status).toBe("IN_PROGRESS");
    expect(lessonOf(out, "l2").status).toBe("LOCKED");
    out = run(s(), { facts: new Map([["a1", assessmentFact([50, 75])]]) });
    expect(lessonOf(out, "l1").status).toBe("COMPLETED");
    expect(lessonOf(out, "l2").status).toBe("AVAILABLE");
  });

  it("exhausted attempts leave the item FAILED and the lesson incomplete (teacher can intervene)", () => {
    const out = run(s(), { facts: new Map([["a1", assessmentFact([10, 20, 30])]]) });
    expect(lessonOf(out, "l1").items[0].state).toBe("FAILED");
    expect(lessonOf(out, "l1").status).toBe("IN_PROGRESS");
    expect(lessonOf(out, "l2").status).toBe("LOCKED");
  });

  it("only assessments of unlocked nodes are startable (drives just-in-time assignments)", () => {
    const struct = tree(
      [
        mod("m1", [lesson("l1", "m1", [item("a1", "ASSESSMENT")]), lesson("l2", "m1", [item("a2", "ASSESSMENT")])], {
          items: [item("ma", "ASSESSMENT", { scope: "MODULE" })],
        }),
      ],
      [item("fa", "ASSESSMENT", { scope: "SYLLABUS" })],
    );
    expect(availableAssessmentItems(struct, run(struct)).map((i) => i.id)).toEqual(["a1"]);
    const passedAll = new Map([["a1", assessmentFact([90])], ["a2", assessmentFact([90])]]);
    expect(availableAssessmentItems(struct, run(struct, { facts: passedAll })).map((i) => i.id)).toEqual(["a1", "a2", "ma"]);
    const withModule = new Map([...passedAll, ["ma", assessmentFact([90])]]);
    const out = run(struct, { facts: withModule });
    expect(availableAssessmentItems(struct, out).map((i) => i.id)).toEqual(["a1", "a2", "ma", "fa"]);
    expect(out.syllabusCompleted).toBe(false);
    expect(run(struct, { facts: new Map([...withModule, ["fa", assessmentFact([90])]]) }).syllabusCompleted).toBe(true);
  });

  it("a module assessment gates the next module", () => {
    const struct = tree([
      mod("m1", [lesson("l1", "m1", [item("t1", "THEORY")])], { items: [item("ma", "ASSESSMENT", { scope: "MODULE" })] }),
      mod("m2", [lesson("l2", "m2", [item("t2", "THEORY")])]),
    ]);
    let out = run(struct, { facts: new Map([["t1", done]]) });
    expect(moduleOf(out, "m1").status).toBe("IN_PROGRESS");
    expect(lessonOf(out, "l2").status).toBe("LOCKED");
    out = run(struct, { facts: new Map([["t1", done], ["ma", assessmentFact([70])]]) });
    expect(moduleOf(out, "m1").status).toBe("COMPLETED");
    expect(lessonOf(out, "l2").status).toBe("AVAILABLE");
  });
});

describe("stability", () => {
  it("completion is sticky: a later lower regrade never re-locks", () => {
    const s = tree([mod("m1", [lesson("l1", "m1", [item("a1", "ASSESSMENT")]), lesson("l2", "m1", [item("t2", "THEORY")])])]);
    const passed = run(s, { facts: new Map([["a1", assessmentFact([80])]]) });
    const regraded = run(s, { facts: new Map([["a1", assessmentFact([40])]]), ...persisted(passed) });
    expect(lessonOf(regraded, "l1").status).toBe("COMPLETED");
    expect(lessonOf(regraded, "l2").status).toBe("AVAILABLE");
  });

  it("is deterministic for the same input", () => {
    const facts = new Map([["th1", done]]);
    expect(run(basic(), { facts })).toEqual(run(basic(), { facts }));
  });
});

describe("manual unlock", () => {
  it("opens one node for one student without completing it", () => {
    const out = run(basic(), { manualLessons: new Set(["l3"]) });
    expect(lessonOf(out, "l3")).toMatchObject({ status: "AVAILABLE", unlockSource: "MANUAL" });
    expect(lessonOf(out, "l4").status).toBe("LOCKED");
    expect(lessonOf(out, "l4").lockReason).toMatchObject({ code: "PREVIOUS_MODULE", moduleId: "m1" });
    expect(moduleOf(out, "m2").status).toBe("AVAILABLE");
    expect(moduleOf(out, "m2").unlockSource).toBe("MANUAL");
    expect(out.completedLessons).toBe(0);
  });

  it("a manually unlocked module opens its first lesson only", () => {
    const out = run(basic(), { manualModules: new Set(["m2"]) });
    expect(lessonOf(out, "l3").status).toBe("AVAILABLE");
    expect(lessonOf(out, "l4").status).toBe("LOCKED");
  });

  it("revoking re-locks the node unless the student already completed it", () => {
    const unlocked = run(basic(), { manualLessons: new Set(["l3"]) });
    const revoked = run(basic(), { ...persisted(unlocked) });
    expect(lessonOf(revoked, "l3").status).toBe("LOCKED");

    const completedUnderManual = run(basic(), { manualLessons: new Set(["l3"]), facts: new Map([["th3", done]]), ...persisted(unlocked) });
    expect(lessonOf(completedUnderManual, "l3").status).toBe("COMPLETED");
    const afterRevoke = run(basic(), { facts: new Map([["th3", done]]), ...persisted(completedUnderManual) });
    expect(lessonOf(afterRevoke, "l3").status).toBe("COMPLETED");
  });

  it("a sequential unlock earned while a manual one was active is kept after revoke", () => {
    const facts = new Map([["th1", done], ["th2", done]]);
    const both = run(basic(), { facts, manualLessons: new Set(["l3"]) });
    expect(lessonOf(both, "l3").unlockSource).toBe("SEQUENTIAL");
    const revoked = run(basic(), { facts, ...persisted(both) });
    expect(lessonOf(revoked, "l3").status).toBe("AVAILABLE");
  });
});

describe("version pinning and grandfathering", () => {
  const v1 = basic();
  const v2 = tree([
    mod("m1", [
      lesson("l1", "m1", [item("th1", "THEORY")]),
      lesson("l1b", "m1", [item("thNew", "THEORY")]),
      lesson("l2", "m1", [item("th2", "THEORY")]),
    ]),
    mod("m2", [lesson("l3", "m2", [item("th3", "THEORY")]), lesson("l4", "m2", [item("th4", "THEORY")])]),
  ]);

  it("a student pinned to v1 never sees lessons or items added in v2", () => {
    const out = run(v1, { facts: new Map([["th1", done], ["thNew", done]]) });
    expect(out.lessons.map((l) => l.id)).toEqual(["l1", "l2", "l3", "l4"]);
    expect(locateItem(v1, "thNew")).toBeNull();
    expect(locateItem(v2, "thNew")?.lesson?.id).toBe("l1b");
  });

  it("new lessons behind the student's frontier become optional after a move", () => {
    const onV1 = run(v1, { facts: new Map([["th1", done], ["th2", done]]) });
    const { prevLessons } = persisted(onV1);
    const grand = grandfatheredLessons(v2, prevLessons);
    expect([...grand]).toEqual(["l1b"]);

    for (const id of grand) prevLessons.set(id, { status: "AVAILABLE", unlockSource: "GRANDFATHERED" });
    const onV2 = run(v2, { facts: new Map([["th1", done], ["th2", done]]), prevModules: persisted(onV1).prevModules, prevLessons });
    expect(lessonOf(onV2, "l1b")).toMatchObject({ optional: true, status: "AVAILABLE" });
    expect(moduleOf(onV2, "m1").status).toBe("COMPLETED");
    expect(lessonOf(onV2, "l3").status).toBe("AVAILABLE");
    expect(onV2.totalLessons).toBe(4);
    expect(onV2.progressPct).toBe(50);
  });

  it("new lessons ahead of the frontier stay required", () => {
    const onV1 = run(v1, { facts: new Map([["th1", done]]) });
    expect([...grandfatheredLessons(v2, persisted(onV1).prevLessons)]).toEqual([]);
  });
});

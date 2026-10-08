import { afterEach, describe, expect, it, vi } from "vitest";
import { catalog } from "../client/src/i18n/catalog";
import {
  BUILDER_TABS,
  continueCandidates,
  gradable,
  lessonChange,
  nextStepOtherThan,
  OPTIONAL_STEPS,
  STEP_TAB,
  STUDENT_STEPS,
  TEACHER_STEPS,
  teacherSteps,
  usageMap,
} from "../client/src/lib/syllabusWorkflow";
import * as db from "./db";
import * as groups from "./modules/groups";
import { AppError } from "./modules/errors";
import { appRouter } from "./routers";
import { changedLessons, lessonChangesFor, unseenChanges } from "./syllabus/changes";
import { groupSyllabusRows, materialUsage, materialUsageCounts, syllabiForGroup } from "./syllabus/links";
import * as store from "./syllabus/store";
import type { ItemStub, LessonStub, VersionStructure } from "./syllabus/types";

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  requireDb: vi.fn(),
}));
vi.mock("./modules/groups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/groups")>()),
  assertGroupOwner: vi.fn(),
}));
vi.mock("./syllabus/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./syllabus/store")>()),
  syllabiByIds: vi.fn(),
  activeMembersWithNames: vi.fn(),
  versionById: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

const NOW = new Date("2026-10-01T12:00:00Z");
const SCOPE = { workspaceId: "ws1", userId: 7 } as never;

/** Each awaited query resolves to the next queued result; every builder method is chainable. */
function fakeDb(results: unknown[]) {
  const calls: string[] = [];
  const chain = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const value = results.shift() ?? [];
            return (resolve: (v: unknown) => void) => resolve(value);
          }
          return (..._args: unknown[]) => {
            calls.push(String(prop));
            return chain();
          };
        },
      },
    );
  return { db: { select: () => (calls.push("select"), chain()) }, calls };
}

// ---------------------------------------------------------------------------
// Group page: syllabi granted to a group
// ---------------------------------------------------------------------------

describe("group syllabi", () => {
  const syl = (id: string, ws = "ws1", archivedAt: Date | null = null) => ({ id, title: id.toUpperCase(), providerWorkspaceId: ws, archivedAt });
  const g = (syllabusId: string, over: Partial<{ status: string; startsAt: Date | null; endsAt: Date | null }> = {}) => ({
    syllabusId,
    status: "ACTIVE",
    startsAt: null,
    endsAt: null,
    ...over,
  }) as never;

  it("orders by grant state, drops revoked-only and foreign-workspace syllabi", () => {
    const rows = groupSyllabusRows({
      workspaceId: "ws1",
      grants: [g("a", { startsAt: new Date("2026-11-01") }), g("b"), g("c", { status: "REVOKED" }), g("d"), g("e", { endsAt: new Date("2026-09-01") })],
      syllabi: [syl("a"), syl("b"), syl("c"), syl("d", "other"), syl("e")],
      memberIds: [1, 2],
      enrollments: [],
      now: NOW,
    });
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ["b", "ACTIVE"],
      ["a", "PENDING"],
      ["e", "EXPIRED"],
    ]);
  });

  it("counts only current members and averages their progress", () => {
    const [row] = groupSyllabusRows({
      workspaceId: "ws1",
      grants: [g("a", { endsAt: new Date("2026-12-01") })],
      syllabi: [syl("a")],
      memberIds: [1, 2, 3],
      enrollments: [
        { syllabusId: "a", studentId: 1, progressPct: 40, status: "ACTIVE" },
        { syllabusId: "a", studentId: 2, progressPct: 100, status: "COMPLETED" },
        { syllabusId: "a", studentId: 99, progressPct: 100, status: "COMPLETED" },
      ],
      now: NOW,
    });
    expect(row).toMatchObject({ members: 3, enrolled: 2, completed: 1, averageProgressPct: 70, endsAt: new Date("2026-12-01") });
  });

  it("an open-ended active grant wins over a dated one", () => {
    const [row] = groupSyllabusRows({ workspaceId: "ws1", grants: [g("a", { endsAt: new Date("2026-12-01") }), g("a")], syllabi: [syl("a")], memberIds: [], enrollments: [], now: NOW });
    expect(row.endsAt).toBeNull();
  });

  it("a group of another workspace is NOT_FOUND before any syllabus query", async () => {
    vi.mocked(groups.assertGroupOwner).mockRejectedValue(new AppError("NOT_FOUND"));
    const { db: fake, calls } = fakeDb([]);
    vi.mocked(db.requireDb).mockReturnValue(fake as never);
    await expect(syllabiForGroup(SCOPE, "grp_foreign")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls).toEqual([]);
    expect(store.syllabiByIds).not.toHaveBeenCalled();
  });

  it("returns rows for an owned group, ignoring syllabi of other workspaces", async () => {
    vi.mocked(groups.assertGroupOwner).mockResolvedValue({} as never);
    const { db: fake } = fakeDb([
      [g("a"), g("x")],
      [{ syllabusId: "a", studentId: 1, progressPct: 50, status: "ACTIVE" }],
    ]);
    vi.mocked(db.requireDb).mockReturnValue(fake as never);
    vi.mocked(store.syllabiByIds).mockResolvedValue([syl("a"), syl("x", "ws_other")] as never);
    vi.mocked(store.activeMembersWithNames).mockResolvedValue([{ studentId: 1, name: "A" }] as never);
    const rows = await syllabiForGroup(SCOPE, "grp1");
    expect(rows.map((r) => r.id)).toEqual(["a"]);
    expect(rows[0]).toMatchObject({ enrolled: 1, averageProgressPct: 50 });
  });

  it("no grants → no further queries", async () => {
    vi.mocked(groups.assertGroupOwner).mockResolvedValue({} as never);
    vi.mocked(db.requireDb).mockReturnValue(fakeDb([[]]).db as never);
    expect(await syllabiForGroup(SCOPE, "grp1")).toEqual([]);
    expect(store.syllabiByIds).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Materials library: "used in N syllabi"
// ---------------------------------------------------------------------------

describe("material usage", () => {
  it("counts distinct syllabi per material across theory blocks and resources", () => {
    const counts = materialUsageCounts([
      { syllabusId: "s1", kind: "THEORY", content: { blocks: [{ type: "material", materialId: "m1" }, { type: "material", materialId: "m1" }, { type: "markdown", md: "x" }] } },
      { syllabusId: "s1", kind: "RESOURCE", content: { materialId: "m1" } },
      { syllabusId: "s2", kind: "RESOURCE", content: { materialId: "m1" } },
      { syllabusId: "s2", kind: "THEORY", content: { blocks: [{ type: "material", materialId: "m2" }] } },
      { syllabusId: "s3", kind: "THEORY", content: {} },
    ]);
    expect(Object.fromEntries(counts.map((c) => [c.materialId, c.syllabi]))).toEqual({ m1: 2, m2: 1 });
  });

  it("reads one workspace-scoped query", async () => {
    const { db: fake, calls } = fakeDb([[{ syllabusId: "s1", kind: "RESOURCE", content: { materialId: "m9" } }]]);
    vi.mocked(db.requireDb).mockReturnValue(fake as never);
    expect(await materialUsage(SCOPE)).toEqual([{ materialId: "m9", syllabi: 1 }]);
    expect(calls.filter((c) => c === "select")).toHaveLength(1);
    expect(calls).toContain("innerJoin");
  });

  it("client lookup maps material ids to counts", () => {
    const map = usageMap([{ materialId: "m1", syllabi: 3 }]);
    expect(map.get("m1")).toBe(3);
    expect(usageMap(undefined).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// "New" / "Updated" lesson badges after a version move
// ---------------------------------------------------------------------------

const item = (id: string, over: Partial<ItemStub> = {}): ItemStub => ({
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
const lesson = (id: string, items: ItemStub[], over: Partial<LessonStub> = {}): LessonStub =>
  ({ id, moduleId: "m1", title: id, description: "", position: 0, estimatedMinutes: null, objectives: [], rules: {} as never, items, ...over }) as LessonStub;
const structure = (lessons: LessonStub[]): VersionStructure =>
  ({ formatVersion: 1, rules: {} as never, modules: [{ id: "m1", title: "M", description: "", position: 0, estimatedMinutes: null, objectives: [], prerequisitesText: "", rules: {} as never, lessons, items: [] }], finalItems: [] }) as VersionStructure;

describe("lesson change badges", () => {
  const prev = structure([lesson("l1", [item("i1")]), lesson("l2", [item("i2")]), lesson("l3", [item("i3")]), lesson("l4", [item("i4")])]);
  const next = structure([
    lesson("l1", [item("i1")]),
    lesson("l2", [item("i2")], { title: "Renamed" }),
    lesson("l3", [item("i3"), item("i3b")]),
    lesson("l4", [item("i4")]),
    lesson("l5", [item("i5")]),
  ]);
  const hashes = new Map([["i1", "h1"], ["i2", "h2"], ["i3", "h3"], ["i4", "h4"]]);

  it("marks new lessons, renamed lessons, changed item lists and edited content", () => {
    const changes = changedLessons(prev, next, hashes, new Map([...hashes, ["i4", "h4-edited"], ["i3b", "x"], ["i5", "y"]]));
    expect(Object.fromEntries(changes)).toEqual({ l2: "UPDATED", l3: "UPDATED", l4: "UPDATED", l5: "NEW" });
  });

  it("identical versions produce no badges", () => {
    expect(changedLessons(prev, prev, hashes, hashes).size).toBe(0);
  });

  it("a badge disappears once the lesson is opened after the move", () => {
    const moved = new Date("2026-09-10T10:00:00Z");
    const changes = new Map([["l2", "UPDATED"], ["l5", "NEW"], ["l3", "UPDATED"]] as const);
    const opened = [
      { lessonId: "l2", occurredAt: new Date("2026-09-11T10:00:00Z") },
      { lessonId: "l3", occurredAt: new Date("2026-09-09T10:00:00Z") },
    ];
    expect(unseenChanges(changes, moved, opened)).toEqual({ l5: "NEW", l3: "UPDATED" });
    expect(unseenChanges(changes, null, [])).toEqual({});
  });

  it("an enrollment that was never moved costs no queries", async () => {
    expect(await lessonChangesFor({ studentId: 1, syllabusId: "s", versionId: "v2", upgradedFromVersionId: null })).toEqual({});
    expect(db.requireDb).not.toHaveBeenCalled();
    expect(store.versionById).not.toHaveBeenCalled();
  });

  it("loads hashes and the move time, then hides opened lessons", async () => {
    vi.mocked(store.versionById).mockImplementation(async (id: string) => ({ version: { id } as never, structure: id === "v1" ? prev : next }));
    const moved = new Date("2026-09-10T10:00:00Z");
    const { db: fake } = fakeDb([
      [...hashes].flatMap(([itemId, hash]) => [{ versionId: "v1", itemId, hash }, { versionId: "v2", itemId, hash }]),
      [{ occurredAt: moved }],
      [{ lessonId: "l2", occurredAt: new Date("2026-09-12T10:00:00Z") }],
    ]);
    vi.mocked(db.requireDb).mockReturnValue(fake as never);
    expect(await lessonChangesFor({ studentId: 1, syllabusId: "s", versionId: "v2", upgradedFromVersionId: "v1" })).toEqual({ l3: "UPDATED", l5: "NEW" });
  });

  it("never throws: a failing query just means no badges", async () => {
    vi.mocked(store.versionById).mockRejectedValue(new Error("boom"));
    vi.mocked(db.requireDb).mockReturnValue(fakeDb([]).db as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await lessonChangesFor({ studentId: 1, syllabusId: "s", versionId: "v2", upgradedFromVersionId: "v1" })).toEqual({});
    warn.mockRestore();
  });

  it("client lookup returns the badge or null", () => {
    expect(lessonChange({ l1: "NEW" }, "l1")).toBe("NEW");
    expect(lessonChange(undefined, "l1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Workflow indicators and "continue learning"
// ---------------------------------------------------------------------------

describe("workflow steps", () => {
  const tree = (over: { published?: boolean; lessons?: Array<{ kind: string }[]>; moduleItems?: { kind: string }[]; finalItems?: { kind: string }[] } = {}) => ({
    syllabus: { currentVersionId: over.published ? "v1" : null },
    modules: over.lessons ? [{ items: over.moduleItems ?? [], lessons: over.lessons.map((items) => ({ items })) }] : [],
    finalItems: over.finalItems ?? [],
  });
  const states = (steps: ReturnType<typeof teacherSteps>) => Object.fromEntries(steps.map((s) => [s.step, s.state]));

  it("a new syllabus points at Organize; Grade is not needed while nothing can be graded", () => {
    expect(states(teacherSteps(tree(), []))).toEqual({ create: "done", organize: "current", teach: "todo", assign: "todo", assess: "skipped", track: "todo" });
  });

  it("follows Create → Organize → Teach → Assign → (optional Grade) → Track", () => {
    expect(states(teacherSteps(tree({ lessons: [[]] }), [])).teach).toBe("current");
    expect(states(teacherSteps(tree({ lessons: [[{ kind: "THEORY" }]] }), [])).assign).toBe("current");
    expect(states(teacherSteps(tree({ published: true, lessons: [[{ kind: "THEORY" }]] }), ["REVOKED"])).assign).toBe("current");
    const noAssessment = states(teacherSteps(tree({ published: true, lessons: [[{ kind: "THEORY" }]] }), ["PENDING"]));
    expect(noAssessment).toMatchObject({ assign: "done", assess: "skipped", track: "current" });
    expect(OPTIONAL_STEPS.has("assess")).toBe(true);
    const all = states(teacherSteps(tree({ published: true, lessons: [[{ kind: "THEORY" }]], finalItems: [{ kind: "ASSESSMENT" }] }), ["ACTIVE"]));
    expect(all).toEqual({ create: "done", organize: "done", teach: "done", assign: "done", assess: "todo", track: "current" });
  });

  it("Grade becomes the next step with a count when work is waiting, never before the course is open", () => {
    const withTest = tree({ published: true, lessons: [[{ kind: "THEORY" }, { kind: "STUDENT_PRACTICE" }]] });
    const waiting = teacherSteps(withTest, ["ACTIVE"], 3);
    expect(states(waiting)).toMatchObject({ assign: "done", assess: "current", track: "todo" });
    expect(waiting.find((s) => s.step === "assess")?.count).toBe(3);
    expect(states(teacherSteps(withTest, ["REVOKED"], 3))).toMatchObject({ assign: "current", assess: "todo" });
    expect(teacherSteps(withTest, ["ACTIVE"], 0).find((s) => s.step === "assess")).toEqual({ step: "assess", state: "todo" });
  });

  it("counts tests, student practice and teacher approvals as gradable", () => {
    expect(gradable(tree({ lessons: [[{ kind: "THEORY" }]] })).any).toBe(false);
    expect(gradable(tree({ lessons: [[{ kind: "THEORY" }]], finalItems: [{ kind: "ASSESSMENT" }] })).tests).toHaveLength(1);
    expect(gradable(tree({ lessons: [[{ kind: "STUDENT_PRACTICE" }]] })).practice).toHaveLength(1);
    const approval = { ...tree({ lessons: [[{ kind: "THEORY" }]] }), syllabus: { currentVersionId: null, effectiveRules: { teacherApproval: true } } };
    expect(gradable(approval)).toMatchObject({ approvals: true, any: true });
    expect(states(teacherSteps(approval, [])).assess).toBe("todo");
  });

  it("empty tabs point to the real next step, never to themselves", () => {
    const fresh = teacherSteps(tree({ lessons: [[{ kind: "THEORY" }]] }), []);
    expect(nextStepOtherThan(fresh, "assess")).toBe("assign");
    expect(nextStepOtherThan(fresh, "track")).toBe("assign");
    const live = teacherSteps(tree({ published: true, lessons: [[{ kind: "THEORY" }]] }), ["ACTIVE"]);
    expect(nextStepOtherThan(live, "track")).toBeNull();
    expect(nextStepOtherThan(live, "assess")).toBe("track");
  });

  it("an assessment-only lesson does not count as teaching content", () => {
    expect(states(teacherSteps(tree({ lessons: [[{ kind: "ASSESSMENT" }]] }), [])).teach).toBe("current");
  });

  it("every step opens an existing builder tab and has copy in all languages", () => {
    for (const s of TEACHER_STEPS) {
      expect(BUILDER_TABS).toContain(STEP_TAB[s]);
      expect(catalog).toHaveProperty(`ux.tstep.${s}`);
      expect(catalog).toHaveProperty(`ux.thint.${s}`);
      expect(catalog).toHaveProperty(`syllabus.tab.${STEP_TAB[s]}`);
    }
    expect(STEP_TAB.assess).toBe("grading");
    expect(STEP_TAB.track).toBe("analytics");
    expect(new Set(TEACHER_STEPS.map((s) => STEP_TAB[s])).size).toBeGreaterThanOrEqual(5);
    for (const s of ["done", "current", "todo", "skipped", "optional"]) expect(catalog).toHaveProperty(`ux.state.${s}`);
    expect(catalog).toHaveProperty("ux.thint.assessSkipped");
    expect(catalog["track.emptyBody"][0]).toBe("Tələbələr syllabus-a başlayanda irəliləyiş burada görünəcək.");
    for (const s of STUDENT_STEPS) {
      expect(catalog).toHaveProperty(`ux.sstep.${s}`);
      expect(catalog).toHaveProperty(`ux.shint.${s}`);
    }
  });

  it("continue learning: active and unfinished, most recent first", () => {
    const card = (id: string, access: string, progress: { completed: boolean; lastActivityAt: Date | null } | null) => ({ id, access, progress });
    const picked = continueCandidates([
      card("never", "ACTIVE", null),
      card("old", "ACTIVE", { completed: false, lastActivityAt: new Date("2026-09-01") }),
      card("done", "ACTIVE", { completed: true, lastActivityAt: new Date("2026-09-30") }),
      card("ended", "EXPIRED", { completed: false, lastActivityAt: new Date("2026-09-29") }),
      card("recent", "ACTIVE", { completed: false, lastActivityAt: new Date("2026-09-20") }),
      card("soon", "PENDING", null),
    ]);
    expect(picked.map((c) => c.id)).toEqual(["recent", "old", "never"]);
  });
});

describe("routes", () => {
  it("the new read-only endpoints exist on the teacher syllabus router", () => {
    const procedures = appRouter._def.procedures as Record<string, unknown>;
    expect(procedures).toHaveProperty(["teacher.syllabus.forGroup"]);
    expect(procedures).toHaveProperty(["teacher.syllabus.materialUsage"]);
  });
});

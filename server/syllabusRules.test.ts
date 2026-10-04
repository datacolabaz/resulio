import { describe, expect, it } from "vitest";
import { resolveRules } from "../shared/syllabus";
import { bestGrantState, effectiveGrant, grantState, type GrantLike } from "./syllabus/accessRules";
import { clientActivityBatchSchema, validateActivity, type ClientActivityEvent } from "./syllabus/activityRules";
import { envEnables } from "./syllabus/availability";
import { studentItemContent } from "./syllabus/serialize";
import type { ItemStub, VersionStructure } from "./syllabus/types";
import { DEFAULT_PROGRESS_VISIBLE_TO_GROUP, groupmateRows } from "./syllabus/visibility";

const NOW = new Date("2026-06-01T12:00:00Z");
const day = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000);

function g(over: Partial<GrantLike> = {}): GrantLike {
  return { id: "g", groupId: "grp1", studentId: null, status: "ACTIVE", startsAt: null, endsAt: null, ...over };
}

describe("access grants", () => {
  it("derives PENDING / EXPIRED from the dates and keeps REVOKED", () => {
    expect(grantState(g(), NOW)).toBe("ACTIVE");
    expect(grantState(g({ startsAt: day(1) }), NOW)).toBe("PENDING");
    expect(grantState(g({ startsAt: day(-1), endsAt: day(1) }), NOW)).toBe("ACTIVE");
    expect(grantState(g({ endsAt: day(-1) }), NOW)).toBe("EXPIRED");
    expect(grantState(g({ endsAt: NOW }), NOW)).toBe("EXPIRED");
    expect(grantState(g({ status: "REVOKED", endsAt: day(5) }), NOW)).toBe("REVOKED");
  });

  it("access ends on the end date without any job", () => {
    const grants = [g({ endsAt: day(1) })];
    expect(effectiveGrant(grants, 5, ["grp1"], NOW)).not.toBeNull();
    expect(effectiveGrant(grants, 5, ["grp1"], day(2))).toBeNull();
    expect(bestGrantState(grants, 5, ["grp1"], day(2))).toBe("EXPIRED");
  });

  it("an individual grant wins over a group grant; group grants need active membership", () => {
    const grants = [g({ id: "group" }), g({ id: "me", groupId: null, studentId: 5 })];
    expect(effectiveGrant(grants, 5, ["grp1"], NOW)?.id).toBe("me");
    expect(effectiveGrant([g({ id: "group" })], 5, [], NOW)).toBeNull();
    expect(bestGrantState([g({ id: "group" })], 5, [], NOW)).toBeNull();
    expect(effectiveGrant([g({ id: "other", groupId: null, studentId: 6 })], 5, ["grp1"], NOW)).toBeNull();
  });

  it("revoke then re-grant restores access; the best state is shown otherwise", () => {
    const revoked = g({ id: "old", status: "REVOKED" });
    expect(effectiveGrant([revoked], 5, ["grp1"], NOW)).toBeNull();
    expect(bestGrantState([revoked], 5, ["grp1"], NOW)).toBe("REVOKED");
    expect(effectiveGrant([revoked, g({ id: "new" })], 5, ["grp1"], NOW)?.id).toBe("new");
    expect(bestGrantState([revoked, g({ endsAt: day(-1) }), g({ startsAt: day(3) })], 5, ["grp1"], NOW)).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------

const stub = (id: string, kind: ItemStub["kind"], scope: ItemStub["scope"] = "LESSON"): ItemStub => ({
  id,
  kind,
  scope,
  title: id,
  position: 0,
  required: true,
  assessmentId: kind === "ASSESSMENT" ? `as_${id}` : null,
  assessmentVersionId: null,
  taskId: null,
  passPct: null,
  retry: null,
});
const rules = resolveRules();
const STRUCTURE: VersionStructure = {
  formatVersion: 1,
  rules,
  finalItems: [stub("final", "ASSESSMENT", "SYLLABUS")],
  modules: [
    {
      id: "m1",
      title: "M1",
      description: "",
      position: 1,
      estimatedMinutes: null,
      objectives: [],
      prerequisitesText: "",
      rules,
      items: [stub("ma", "ASSESSMENT", "MODULE")],
      lessons: [
        { id: "l1", moduleId: "m1", title: "L1", description: "", position: 1, estimatedMinutes: null, objectives: [], rules, items: [stub("th1", "THEORY"), stub("sp1", "STUDENT_PRACTICE")] },
        { id: "l2", moduleId: "m1", title: "L2", description: "", position: 2, estimatedMinutes: null, objectives: [], rules, items: [stub("th2", "THEORY")] },
      ],
    },
  ],
};
const ctx = { structure: STRUCTURE, openLessons: new Set(["l1"]), openScopedItems: new Set<string>() };
const validate = (events: ClientActivityEvent[]) => validateActivity(events, ctx);

describe("learning activity validation", () => {
  it("accepts allowed client events and takes node ids from the pinned structure", () => {
    const { accepted, rejected } = validate([
      { type: "SYLLABUS_OPENED" },
      { type: "MODULE_OPENED", moduleId: "m1" },
      { type: "LESSON_OPENED", lessonId: "l1" },
      { type: "THEORY_OPENED", itemId: "th1", moduleId: "spoofed", lessonId: "l2" },
      { type: "PRACTICE_STARTED", itemId: "sp1" },
    ]);
    expect(rejected).toEqual([]);
    expect(accepted.map((a) => a.type)).toEqual(["SYLLABUS_OPENED", "MODULE_OPENED", "LESSON_OPENED", "THEORY_OPENED", "PRACTICE_STARTED"]);
    expect(accepted[3]).toMatchObject({ moduleId: "m1", lessonId: "l1", itemId: "th1" });
  });

  it("never accepts server-only outcome types from the client", () => {
    const { accepted, rejected } = validate(
      ["THEORY_COMPLETED", "LESSON_COMPLETED", "PRACTICE_SUBMITTED", "ASSESSMENT_PASSED", "LESSON_UNLOCKED", "SYLLABUS_COMPLETED", "nonsense"].map((type) => ({
        type,
        lessonId: "l1",
        itemId: "th1",
      })),
    );
    expect(accepted).toEqual([]);
    expect(rejected.every((r) => r.reason === "TYPE_NOT_ALLOWED")).toBe(true);
    expect(rejected).toHaveLength(7);
  });

  it("rejects unknown nodes, locked nodes and kind mismatches per event", () => {
    const { accepted, rejected } = validate([
      { type: "LESSON_OPENED", lessonId: "nope" },
      { type: "LESSON_OPENED", lessonId: "l2" },
      { type: "THEORY_OPENED", itemId: "th2" },
      { type: "PRACTICE_OPENED", itemId: "th1" },
      { type: "ASSESSMENT_OPENED", itemId: "ma" },
      { type: "ASSESSMENT_OPENED", itemId: "final" },
      { type: "MODULE_OPENED", moduleId: "m9" },
      { type: "HEARTBEAT", lessonId: "l1", durationSeconds: 30 },
    ]);
    expect(rejected).toEqual([
      { index: 0, reason: "UNKNOWN_NODE" },
      { index: 1, reason: "LOCKED" },
      { index: 2, reason: "LOCKED" },
      { index: 3, reason: "KIND_MISMATCH" },
      { index: 4, reason: "LOCKED" },
      { index: 5, reason: "LOCKED" },
      { index: 6, reason: "UNKNOWN_NODE" },
    ]);
    expect(accepted.map((a) => a.type)).toEqual(["HEARTBEAT"]);
  });

  it("module and final assessments open once they are available", () => {
    const { rejected } = validateActivity([{ type: "ASSESSMENT_OPENED", itemId: "ma" }], { ...ctx, openScopedItems: new Set(["ma"]) });
    expect(rejected).toEqual([]);
  });

  it("clamps durations (heartbeat ≤ 60 s, others ≤ 1 h, never negative)", () => {
    const { accepted } = validate([
      { type: "HEARTBEAT", lessonId: "l1", durationSeconds: 5000 },
      { type: "LESSON_OPENED", lessonId: "l1", durationSeconds: 99_999 },
      { type: "LESSON_OPENED", lessonId: "l1", durationSeconds: -20 },
      { type: "LESSON_OPENED", lessonId: "l1" },
    ]);
    expect(accepted.map((a) => a.durationSeconds)).toEqual([60, 3600, 0, null]);
  });

  it("video progress must be a 25/50/75 mark and video metadata is whitelisted", () => {
    const { accepted, rejected } = validate([
      { type: "VIDEO_PROGRESS", itemId: "th1", metadata: { pct: 50, blockIndex: 2 } },
      { type: "VIDEO_PROGRESS", itemId: "th1", metadata: { pct: 33 } },
      { type: "VIDEO_PROGRESS", itemId: "th1" },
      { type: "VIDEO_STARTED", itemId: "th1", metadata: { pct: 0, answer: "x" } },
      { type: "LESSON_OPENED", lessonId: "l1", metadata: { anything: "dropped" } },
    ]);
    expect(rejected).toEqual([
      { index: 1, reason: "INVALID_METADATA" },
      { index: 2, reason: "INVALID_METADATA" },
      { index: 3, reason: "INVALID_METADATA" },
    ]);
    expect(accepted[0].metadata).toEqual({ pct: 50, blockIndex: 2 });
    expect(accepted[1].metadata).toBeNull();
  });

  it("limits batch size and field sizes on the wire", () => {
    expect(clientActivityBatchSchema.safeParse([]).success).toBe(false);
    expect(clientActivityBatchSchema.safeParse(Array.from({ length: 21 }, () => ({ type: "HEARTBEAT" }))).success).toBe(false);
    expect(clientActivityBatchSchema.safeParse(Array.from({ length: 20 }, () => ({ type: "HEARTBEAT" }))).success).toBe(true);
    expect(clientActivityBatchSchema.safeParse([{ type: "LESSON_OPENED", lessonId: "x".repeat(33) }]).success).toBe(false);
    expect(clientActivityBatchSchema.safeParse([{ type: "VIDEO_PROGRESS", metadata: { pct: { nested: 1 } } }]).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("groupmate visibility rows", () => {
  it("defaults to visible (owner decision Q7)", () => {
    expect(DEFAULT_PROGRESS_VISIBLE_TO_GROUP).toBe(true);
  });

  it("carries progress fields only, sorted by progress, with not-started members included", () => {
    const rows = groupmateRows(
      [
        { studentId: 1, name: "Zaur" },
        { studentId: 2, name: "Aynur" },
        { studentId: 3, name: null },
      ],
      [
        { studentId: 1, progressPct: 50, completedLessons: 2, totalLessons: 4, currentModuleId: "m2", status: "ACTIVE" },
        { studentId: 2, progressPct: 50, completedLessons: 2, totalLessons: 4, currentModuleId: "gone", status: "ACTIVE" },
      ],
      new Map([["m2", "Funksiyalar"]]),
      1,
    );
    expect(rows.map((r) => r.name)).toEqual(["Aynur", "Zaur", "—"]);
    expect(rows[1]).toEqual({
      studentId: 1,
      name: "Zaur",
      isMe: true,
      started: true,
      completed: false,
      progressPct: 50,
      completedLessons: 2,
      totalLessons: 4,
      currentModuleTitle: "Funksiyalar",
    });
    expect(rows[0].currentModuleTitle).toBeNull();
    expect(rows[2]).toMatchObject({ started: false, progressPct: 0, totalLessons: 0 });
  });
});

describe("student content serialization", () => {
  it("strips teacher notes and the solution unless the teacher reveals it", () => {
    const content = { problem: "P", hints: ["h"], teacherOnly: { solution: "SOL", notes: "N" }, revealSolutionToStudents: false };
    expect(studentItemContent("TEACHER_PRACTICE", content)).toEqual({ problem: "P", hints: ["h"], solution: null });
    expect(studentItemContent("TEACHER_PRACTICE", { ...content, revealSolutionToStudents: true })).toEqual({ problem: "P", hints: ["h"], solution: "SOL" });
    expect(studentItemContent("THEORY", { blocks: [] })).toEqual({ blocks: [] });
  });
});

describe("feature flag env list", () => {
  it("is off unless the workspace is listed (or '*')", () => {
    expect(envEnables("ws1", [])).toBe(false);
    expect(envEnables("ws1", ["ws2"])).toBe(false);
    expect(envEnables("ws1", ["ws2", "ws1"])).toBe(true);
    expect(envEnables("ws1", ["*"])).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalog } from "../client/src/i18n/catalog";
import { assignmentOverridesSchema, scheduleSchema } from "../shared/assessment";
import { LEARNING_ACTIVITY_TYPES, resolveRules } from "../shared/syllabus";
import {
  DEFAULT_RISK_THRESHOLDS,
  FUNNEL_STAGES,
  INSIGHT_CODES,
  RISK_REASONS,
  RISK_THRESHOLD_LIMITS,
  resolveAnalyticsSettings,
} from "../shared/syllabusAnalytics";
import { inTimestampRange, timestampDate, timestampIso, TIMESTAMP_MAX } from "../shared/timestamp";
import * as db from "./db";
import { buildPopulation, digestPayload, purgeOldActivity, resetDailyJobs, retentionCutoff, runDailyDigest } from "./syllabus/analytics";
import { assessmentOutcome, computeAnalytics, mergedOutline, practiceDone, type AnalyticsData } from "./syllabus/analyticsCompute";
import { buildInsights, type InsightInput } from "./syllabus/insights";
import { riskReasons, type RiskInput } from "./syllabus/risk";
import type { ItemStub, VersionStructure } from "./syllabus/types";

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  requireDb: vi.fn(),
}));

afterEach(() => {
  vi.mocked(db.requireDb).mockReset();
  resetDailyJobs();
});

const NOW = new Date("2026-06-30T12:00:00Z");
const day = (d: string) => new Date(`2026-06-${d}T12:00:00Z`);
const TH = DEFAULT_RISK_THRESHOLDS;

// ---------------------------------------------------------------------------
// TIMESTAMP range (MySQL TIMESTAMP ends in January 2038)
// ---------------------------------------------------------------------------

describe("timestamp range guard", () => {
  it("rejects far-future and pre-epoch dates with DATE_OUT_OF_RANGE", () => {
    expect(timestampDate().safeParse(new Date("2099-12-31")).success).toBe(false);
    expect(timestampDate().safeParse(new Date("9999-01-01")).success).toBe(false);
    expect(timestampDate().safeParse(new Date("1969-12-31")).success).toBe(false);
    expect(timestampDate().safeParse(new Date("2030-05-01")).success).toBe(true);
    const bad = timestampDate().safeParse(new Date("2099-01-01"));
    expect(bad.success ? "" : bad.error.issues[0].message).toBe("DATE_OUT_OF_RANGE");
    expect(timestampIso().safeParse("2099-01-01T00:00:00.000Z").success).toBe(false);
    expect(timestampIso().safeParse("2030-01-01T00:00:00.000Z").success).toBe(true);
    expect(inTimestampRange(TIMESTAMP_MAX)).toBe(true);
    expect(inTimestampRange(new Date("2038-01-20"))).toBe(false);
  });

  it("guards the assessment schedule and assignment override dates", () => {
    expect(scheduleSchema.safeParse({ startAt: new Date("2099-01-01"), endAt: null }).success).toBe(false);
    expect(scheduleSchema.safeParse({ startAt: new Date("2030-01-01"), endAt: new Date("2030-01-02") }).success).toBe(true);
    expect(assignmentOverridesSchema.safeParse({ availableUntil: new Date("2999-01-01") }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Settings and at-risk rules (§39)
// ---------------------------------------------------------------------------

describe("analytics settings", () => {
  it("falls back per field when stored thresholds are missing or out of range", () => {
    expect(resolveAnalyticsSettings(null)).toEqual({ thresholds: DEFAULT_RISK_THRESHOLDS, digestEnabled: true });
    const r = resolveAnalyticsSettings({ thresholds: { inactiveDays: 10, failedAttempts: 0, stuckDays: "x", progressGapPct: 30 }, digestEnabled: false });
    expect(r.thresholds).toEqual({ ...DEFAULT_RISK_THRESHOLDS, inactiveDays: 10, progressGapPct: 30 });
    expect(r.digestEnabled).toBe(false);
  });
});

describe("at-risk rules", () => {
  const base: RiskInput = {
    accessActive: true,
    accessSince: day("01"),
    enrolled: true,
    completed: false,
    lastActivityAt: day("29"),
    progressPct: 50,
    failedAttempts: 0,
    groupAvgPct: 50,
    groupSize: 5,
    currentLessonOpenedAt: day("28"),
    missingPractice: 0,
  };

  it("flags nothing for an active student on track", () => {
    expect(riskReasons(base, TH, NOW)).toEqual([]);
  });

  it("returns every rule that fires with its measured value", () => {
    const r = riskReasons({ ...base, lastActivityAt: day("20"), failedAttempts: 2, progressPct: 20, currentLessonOpenedAt: day("10"), missingPractice: 3 }, TH, NOW);
    expect(r).toEqual([
      { code: "INACTIVE", value: 10 },
      { code: "FAILED_ASSESSMENTS", value: 2 },
      { code: "BELOW_GROUP", value: 30 },
      { code: "STUCK_IN_LESSON", value: 20 },
      { code: "PRACTICE_MISSING", value: 3 },
    ]);
  });

  it("uses the thresholds: exactly 7 idle days is not inactive, 8 is", () => {
    expect(riskReasons({ ...base, lastActivityAt: day("23") }, TH, NOW)).toEqual([]);
    expect(riskReasons({ ...base, lastActivityAt: day("22") }, TH, NOW)).toEqual([{ code: "INACTIVE", value: 8 }]);
    expect(riskReasons({ ...base, lastActivityAt: day("22") }, { ...TH, inactiveDays: 14 }, NOW)).toEqual([]);
  });

  it("ignores the group gap for tiny groups, and never flags completed or access-ended students", () => {
    expect(riskReasons({ ...base, progressPct: 0, groupSize: 2 }, TH, NOW)).toEqual([]);
    expect(riskReasons({ ...base, completed: true, lastActivityAt: day("01") }, TH, NOW)).toEqual([]);
    expect(riskReasons({ ...base, accessActive: false, lastActivityAt: day("01") }, TH, NOW)).toEqual([]);
  });

  it("flags a student who never started only after the inactivity window", () => {
    expect(riskReasons({ ...base, enrolled: false, accessSince: day("25") }, TH, NOW)).toEqual([]);
    expect(riskReasons({ ...base, enrolled: false, accessSince: day("10") }, TH, NOW)).toEqual([{ code: "NOT_STARTED", value: 20 }]);
  });
});

// ---------------------------------------------------------------------------
// The computation (§32–§38) on a small hand-checked class
// ---------------------------------------------------------------------------

const rules = resolveRules();
const stub = (id: string, kind: ItemStub["kind"], over: Partial<ItemStub> = {}): ItemStub => ({
  id,
  kind,
  scope: "LESSON",
  title: id.toUpperCase(),
  position: 0,
  required: true,
  assessmentId: null,
  assessmentVersionId: null,
  taskId: null,
  passPct: null,
  retry: null,
  ...over,
});
const STRUCTURE: VersionStructure = {
  formatVersion: 1,
  rules,
  finalItems: [],
  modules: [
    {
      id: "m1",
      title: "Basics",
      description: "",
      position: 1,
      estimatedMinutes: null,
      objectives: [],
      prerequisitesText: "",
      rules,
      items: [],
      lessons: [
        {
          id: "l1",
          moduleId: "m1",
          title: "Intro",
          description: "",
          position: 1,
          estimatedMinutes: null,
          objectives: [],
          rules,
          items: [stub("th1", "THEORY"), stub("p1", "STUDENT_PRACTICE", { taskId: "t1" }), stub("a1", "ASSESSMENT", { assessmentId: "as1" })],
        },
        { id: "l2", moduleId: "m1", title: "Loops", description: "", position: 2, estimatedMinutes: null, objectives: [], rules, items: [stub("th2", "THEORY")] },
      ],
    },
  ],
} as unknown as VersionStructure;

const enrollment = (id: string, studentId: number, over: Partial<AnalyticsData["enrollments"][number]>): AnalyticsData["enrollments"][number] => ({
  id,
  studentId,
  versionId: "v1",
  status: "ACTIVE",
  progressPct: 0,
  completedLessons: 0,
  totalLessons: 2,
  currentModuleId: "m1",
  currentLessonId: "l1",
  lastCompletedLessonId: null,
  lastActivityAt: null,
  enrolledAt: day("01"),
  completedAt: null,
  ...over,
});
const lesson = (enrollmentId: string, lessonId: string, status: string, openedAt: Date | null, activeSeconds = 0) => ({
  enrollmentId,
  lessonId,
  moduleId: "m1",
  status,
  unlockedAt: openedAt ?? day("10"),
  openedAt,
  completedAt: status === "COMPLETED" ? openedAt : null,
  activeSeconds,
});
const attempt = (studentId: number, attemptNo: number, pct: number) => ({ assessmentId: "as1", studentId, status: "SUBMITTED", attemptNo, finishedAt: day("15"), pct, pending: false });

/**
 * Group A: Aysel (completed), Murad (stuck on lesson 2), Nigar (inactive, 2 failed attempts, far behind),
 * Orxan (access 3 days ago, not started). Leyla: individual grant 29 days ago, never started.
 */
function classData(): AnalyticsData {
  const S = (studentId: number, name: string, groupIds: string[], accessSince = day("01")) => ({ studentId, name, access: "ACTIVE" as const, accessSince, groupIds });
  return {
    currentVersionId: "v1",
    structures: new Map([["v1", STRUCTURE]]),
    students: [S(1, "Aysel", ["g1"]), S(2, "Murad", ["g1"]), S(3, "Nigar", ["g1"]), S(4, "Orxan", ["g1"], day("27")), S(5, "Leyla", [])],
    groups: [{ id: "g1", name: "A" }],
    enrollments: [
      enrollment("e1", 1, { status: "COMPLETED", progressPct: 100, completedLessons: 2, currentModuleId: null, currentLessonId: null, lastActivityAt: day("29"), completedAt: day("11") }),
      enrollment("e2", 2, { progressPct: 50, completedLessons: 1, currentLessonId: "l2", lastActivityAt: day("28") }),
      enrollment("e3", 3, { lastActivityAt: day("10") }),
    ],
    modules: [
      { enrollmentId: "e1", moduleId: "m1", status: "COMPLETED", startedAt: day("01"), completedAt: day("11") },
      { enrollmentId: "e2", moduleId: "m1", status: "IN_PROGRESS", startedAt: day("02"), completedAt: null },
      { enrollmentId: "e3", moduleId: "m1", status: "IN_PROGRESS", startedAt: day("10"), completedAt: null },
    ],
    lessons: [
      lesson("e1", "l1", "COMPLETED", day("01"), 600),
      lesson("e1", "l2", "COMPLETED", day("05"), 300),
      lesson("e2", "l1", "COMPLETED", day("02"), 900),
      lesson("e2", "l2", "IN_PROGRESS", day("10")),
      lesson("e3", "l1", "AVAILABLE", null),
    ],
    practiceItems: [{ enrollmentId: "e1", itemId: "p1", openedAt: new Date("2026-06-01T10:00:00Z"), startedAt: new Date("2026-06-01T10:05:00Z") }],
    theoryDone: new Set(["e1", "e2"]),
    submissions: [
      { taskId: "t1", studentId: 1, submittedAt: new Date("2026-06-01T11:00:00Z"), firstSubmittedAt: new Date("2026-06-01T11:00:00Z"), score: 90, released: true },
      { taskId: "t1", studentId: 2, submittedAt: day("02"), firstSubmittedAt: day("02"), score: null, released: false },
    ],
    submitCounts: new Map([["p1:1", 2]]),
    attempts: [attempt(1, 1, 50), attempt(1, 2, 80), attempt(2, 1, 60), attempt(3, 1, 40), attempt(3, 2, 50)],
  };
}

describe("syllabus analytics computation", () => {
  const a = computeAnalytics(classData(), TH, NOW);

  it("keeps access, progress, completion and mastery apart (§43)", () => {
    expect(a.overview).toEqual({
      access: { total: 5, active: 5, pending: 0, ended: 0 },
      progress: { enrolled: 3, started: 2, active: 2, inactive: 1, avgProgressPct: 50, lessonCompletionPct: 50, progressing: 0, stuck: 1 },
      completion: { completed: 1, completionRatePct: 33.3 },
      mastery: { avgAssessmentPct: 63.3, assessedStudents: 3, passRatePct: 33.3 },
      atRisk: 3,
    });
  });

  it("explains each at-risk student", () => {
    const reasons = Object.fromEntries(a.students.map((s) => [s.name, s.reasons]));
    expect(reasons).toEqual({
      Aysel: [],
      Murad: [{ code: "STUCK_IN_LESSON", value: 20 }],
      Nigar: [
        { code: "INACTIVE", value: 20 },
        { code: "FAILED_ASSESSMENTS", value: 2 },
        { code: "BELOW_GROUP", value: 50 },
      ],
      Orxan: [],
      Leyla: [{ code: "NOT_STARTED", value: 29 }],
    });
  });

  it("fills the student table row", () => {
    const murad = a.students.find((s) => s.name === "Murad")!;
    expect(murad).toMatchObject({
      enrolled: true,
      completed: false,
      progressPct: 50,
      currentLessonTitle: "Loops",
      currentModuleTitle: "Basics",
      practice: { done: 1, total: 1, pct: 100 },
      assessment: { avgPct: 60, attempted: 1, passed: 0, failedAttempts: 1 },
      daysInactive: 2,
      active: true,
      atRisk: true,
    });
    expect(a.students.find((s) => s.name === "Aysel")!.assessment).toEqual({ avgPct: 80, attempted: 1, passed: 1, failedAttempts: 0 });
  });

  it("computes lesson, module and practice statistics", () => {
    expect(a.lessons.map((l) => [l.title, l.opened, l.completed, l.completionRatePct, l.practiceCompletionPct, l.avgScorePct, l.avgAttempts, l.avgActiveSeconds])).toEqual([
      ["Intro", 2, 2, 100, 66.7, 63.3, 1.7, 750],
      ["Loops", 2, 1, 50, null, null, null, 300],
    ]);
    expect(a.modules[0]).toMatchObject({
      title: "Basics",
      started: 3,
      completed: 1,
      completionRatePct: 33.3,
      avgScorePct: 63.3,
      avgTimeToCompleteSeconds: 10 * 86_400,
      practiceCompletionPct: 66.7,
      passRatePct: 33.3,
      retryRatePct: 66.7,
    });
    expect(a.practice[0]).toMatchObject({
      title: "P1",
      reached: 3,
      opened: 2,
      started: 2,
      submitted: 2,
      completed: 2,
      completionRatePct: 66.7,
      avgScorePct: 90,
      avgAttempts: 1.5,
      avgTimeToSubmitSeconds: 3600,
      awaitingReview: 1,
      needsHelp: 1,
    });
  });

  it("builds the learning funnel over distinct students (§38)", () => {
    expect(Object.fromEntries(a.funnel.map((f) => [f.stage, f.count]))).toEqual({
      ACCESS: 5,
      SYLLABUS_OPENED: 3,
      MODULE_STARTED: 3,
      LESSON_OPENED: 2,
      THEORY_COMPLETED: 2,
      PRACTICE_STARTED: 2,
      PRACTICE_SUBMITTED: 2,
      ASSESSMENT_ATTEMPTED: 3,
      ASSESSMENT_PASSED: 1,
      MODULE_COMPLETED: 1,
    });
    expect(a.funnel.map((f) => f.stage)).toEqual([...FUNNEL_STAGES]);
    expect(a.funnel[1].pct).toBe(60);
  });

  it("compares groups, including 'completed module N x/y' (§34)", () => {
    expect(a.groups).toEqual([
      { groupId: "g1", name: "A", students: 4, enrolled: 3, avgProgressPct: 50, avgScorePct: 63.3, completed: 1, atRisk: 2, modules: [{ moduleId: "m1", title: "Basics", completed: 1, of: 4 }] },
    ]);
  });

  it("produces rule-based insights (§40), most urgent first", () => {
    expect(a.insights).toEqual([
      { code: "AT_RISK", severity: 1, params: { count: 3 } },
      { code: "AWAITING_REVIEW", severity: 1, params: { count: 1 } },
      { code: "INACTIVE_STUDENTS", severity: 2, params: { count: 1, days: 7 } },
      { code: "NOT_STARTED", severity: 2, params: { count: 1, days: 7 } },
      { code: "HIGH_RETRY_MODULE", severity: 3, params: { module: "Basics", pct: 67 } },
    ]);
  });

  it("filters to one group without changing the group comparison", () => {
    const g = computeAnalytics(classData(), TH, NOW, "g1");
    expect(g.students.map((s) => s.name)).toEqual(["Aysel", "Murad", "Nigar", "Orxan"]);
    expect(g.overview.atRisk).toBe(2);
    expect(g.groups).toEqual(a.groups);
  });

  it("honours custom thresholds", () => {
    const strict = computeAnalytics(classData(), { ...TH, stuckDays: 30, failedAttempts: 5, progressGapPct: 60, inactiveDays: 30 }, NOW);
    expect(strict.overview.atRisk).toBe(0);
  });
});

describe("analytics building blocks", () => {
  const place = { item: stub("a1", "ASSESSMENT", { assessmentId: "as1" }), lessonId: "l1", moduleId: "m1", rules };

  it("scores assessments by BEST or LATEST and counts failures only until passed", () => {
    const tries = [attempt(1, 1, 80), attempt(1, 2, 40)];
    expect(assessmentOutcome(place, tries)).toMatchObject({ finished: 2, score: 80, passed: true, failed: 0 });
    const latest = { ...place, rules: { ...rules, retry: { ...rules.retry, scorePolicy: "LATEST" as const } } };
    expect(assessmentOutcome(latest, tries)).toMatchObject({ score: 40, passed: false, failed: 1 });
    expect(assessmentOutcome(place, [{ ...attempt(1, 1, 0), pct: null, pending: true }])).toMatchObject({ finished: 1, score: null, failed: 0 });
    expect(assessmentOutcome(place, [{ ...attempt(1, 1, 90), status: "VOIDED" }])).toMatchObject({ finished: 0, score: null });
  });

  it("reads practice completion like the progression engine", () => {
    const sub = { taskId: "t", studentId: 1, submittedAt: NOW, firstSubmittedAt: NOW, score: 50, released: true };
    expect(practiceDone(undefined, "SUBMITTED", 60)).toBe(false);
    expect(practiceDone(sub, "SUBMITTED", 60)).toBe(true);
    expect(practiceDone({ ...sub, released: false }, "GRADED", 60)).toBe(false);
    expect(practiceDone(sub, "GRADED", 60)).toBe(true);
    expect(practiceDone(sub, "PASSED", 60)).toBe(false);
    expect(practiceDone({ ...sub, score: 75 }, "PASSED", 60)).toBe(true);
  });

  it("merges versions: current order first, lessons only older versions have are kept", () => {
    const old = { ...STRUCTURE, modules: [{ ...STRUCTURE.modules[0], lessons: [...STRUCTURE.modules[0].lessons, { ...STRUCTURE.modules[0].lessons[1], id: "l_old", title: "Old" }] }] } as VersionStructure;
    const current = { ...STRUCTURE, modules: [{ ...STRUCTURE.modules[0], title: "Basics v2" }] } as VersionStructure;
    const o = mergedOutline(new Map([["v0", old], ["v1", current]]), "v1");
    expect(o.modules.map((m) => m.title)).toEqual(["Basics v2"]);
    expect(o.modules[0].lessons.map((l) => l.id)).toEqual(["l1", "l2", "l_old"]);
  });
});

describe("insight rules", () => {
  const empty: InsightInput = { overview: { atRisk: 0, progress: { inactive: 0 } }, students: [], lessons: [], modules: [], practice: [], groups: [] };

  it("stays silent on a healthy class", () => {
    expect(buildInsights(empty, TH)).toEqual([]);
  });

  it("names a weak lesson, a hard lesson, low practice and a faster group", () => {
    const res = buildInsights(
      {
        ...empty,
        lessons: [
          { title: "A", opened: 10, completionRatePct: 90, avgScorePct: 85, attempters: 5 },
          { title: "B", opened: 10, completionRatePct: 80, avgScorePct: 83, attempters: 5 },
          { title: "C", opened: 10, completionRatePct: 30, avgScorePct: 60, attempters: 5 },
        ],
        practice: [{ title: "Loop task", moduleTitle: "Module 2", reached: 10, completionRatePct: 40, awaitingReview: 0 }],
        groups: [
          { name: "Group A", modules: [{ title: "Module 2", completed: 8, of: 10 }] },
          { name: "Group B", modules: [{ title: "Module 2", completed: 3, of: 10 }] },
        ],
      },
      TH,
    );
    expect(res).toEqual([
      { code: "LOW_PRACTICE_COMPLETION", severity: 2, params: { module: "Module 2", task: "Loop task", pct: 40 } },
      { code: "LOW_LESSON_SCORE", severity: 2, params: { lesson: "C", gap: 24 } },
      { code: "HARD_LESSON", severity: 2, params: { lesson: "C", pct: 30 } },
      { code: "GROUP_AHEAD", severity: 3, params: { fast: "Group A", slow: "Group B", module: "Module 2", gap: 50 } },
    ]);
  });

  it("ignores small samples", () => {
    const res = buildInsights({ ...empty, practice: [{ title: "T", moduleTitle: "M", reached: 2, completionRatePct: 0, awaitingReview: 0 }] }, TH);
    expect(res).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Privacy (§41): who counts as "this syllabus' students"
// ---------------------------------------------------------------------------

describe("analytics population", () => {
  const grant = (over: Record<string, unknown>) => ({ status: "ACTIVE" as const, startsAt: null, endsAt: null, groupId: null, studentId: null, grantedAt: day("01"), ...over });

  it("includes own granted groups' active students, individual grants and enrolled students only", () => {
    const res = buildPopulation({
      workspaceId: "ws1",
      grants: [grant({ groupId: "own" }), grant({ groupId: "foreign" }), grant({ studentId: 50, status: "REVOKED" })],
      enrollments: [{ studentId: 60, viaGroupId: "own" }],
      groups: [
        { id: "own", name: "Own", workspaceId: "ws1" },
        { id: "foreign", name: "Other teacher", workspaceId: "ws2" },
      ],
      members: [
        { groupId: "own", userId: 10 },
        { groupId: "foreign", userId: 99 },
      ],
      names: new Map([[10, "Ali"]]),
      now: NOW,
    });
    expect(res.groups).toEqual([{ id: "own", name: "Own" }]);
    expect(res.students.map((s) => [s.studentId, s.access, s.groupIds])).toEqual([
      [10, "ACTIVE", ["own"]],
      [50, "REVOKED", []],
      [60, "NONE", ["own"]],
    ]);
    expect(res.students.some((s) => s.studentId === 99)).toBe(false);
  });

  it("takes the best grant state and the earliest active start", () => {
    const res = buildPopulation({
      workspaceId: "ws1",
      grants: [grant({ groupId: "g", status: "REVOKED" }), grant({ studentId: 10, startsAt: day("05") }), grant({ groupId: "g", startsAt: day("03") })],
      enrollments: [],
      groups: [{ id: "g", name: "G", workspaceId: "ws1" }],
      members: [{ groupId: "g", userId: 10 }],
      names: new Map(),
      now: NOW,
    });
    expect(res.students).toEqual([{ studentId: 10, name: "—", access: "ACTIVE", accessSince: day("03"), groupIds: ["g"] }]);
  });
});

// ---------------------------------------------------------------------------
// Daily digest and retention
// ---------------------------------------------------------------------------

describe("daily jobs", () => {
  it("the digest names at most five at-risk students and counts all of them", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ name: `S${i}`, atRisk: i !== 3, reasons: [] }));
    expect(digestPayload(rows)).toEqual({ count: 6, names: ["S0", "S1", "S2", "S4", "S5"] });
  });

  it("the digest waits for 08:00 Baku and does not touch the database before", async () => {
    expect(await runDailyDigest(new Date("2026-06-30T03:59:00Z"))).toBe(0);
    expect(db.requireDb).not.toHaveBeenCalled();
  });

  it("retention keeps 24 months", () => {
    expect(retentionCutoff(new Date("2026-06-30T12:00:00Z")).toISOString()).toBe("2024-06-30T12:00:00.000Z");
  });

  it("retention deletes in batches until a short batch", async () => {
    const counts = [5000, 5000, 120];
    const limit = vi.fn(async () => [{ affectedRows: counts.shift() ?? 0 }]);
    const where = vi.fn(() => ({ limit }));
    vi.mocked(db.requireDb).mockReturnValue({ delete: vi.fn(() => ({ where })) } as never);
    expect(await purgeOldActivity(NOW)).toBe(10_120);
    expect(limit).toHaveBeenCalledTimes(3);
    expect(limit).toHaveBeenCalledWith(5000);
  });

  it("retention is a no-op while the activity table does not exist", async () => {
    const missing = Object.assign(new Error("Failed query"), { cause: { errno: 1146, code: "ER_NO_SUCH_TABLE" } });
    vi.mocked(db.requireDb).mockReturnValue({ delete: () => ({ where: () => ({ limit: async () => Promise.reject(missing) }) }) } as never);
    expect(await purgeOldActivity(NOW)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Every code the server sends has AZ/EN/RU text
// ---------------------------------------------------------------------------

describe("analytics i18n", () => {
  it("has a catalog entry for every reason, insight, funnel stage, threshold and timeline event", () => {
    const keys = [
      ...RISK_REASONS.map((c) => `sa.reason.${c}`),
      ...INSIGHT_CODES.map((c) => `sa.insight.${c}`),
      ...FUNNEL_STAGES.map((c) => `sa.funnel.${c}`),
      ...Object.keys(RISK_THRESHOLD_LIMITS).map((k) => `sa.th.${k}`),
      ...LEARNING_ACTIVITY_TYPES.filter((x) => x !== "HEARTBEAT").map((x) => `sa.ev.${x}`),
      "settings.event.SYLLABUS_AT_RISK_DIGEST",
      "syllabus.tab.analytics",
      "error.DATE_OUT_OF_RANGE",
    ];
    expect(keys.filter((k) => !(k in catalog))).toEqual([]);
  });
});

beforeEach(() => {
  vi.useRealTimers();
});

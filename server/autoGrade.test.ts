import { beforeEach, describe, expect, it, vi } from "vitest";
import { submissionAiReviews, submissionGrading, taskGradingSettings, taskSubmissions } from "../drizzle/schema";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  dispatch: vi.fn(),
  recordAnnouncedScore: vi.fn(async () => {}),
}));
vi.mock("./db", () => ({ requireDb: () => mocks.db }));
vi.mock("./notifications/dispatcher", () => ({ dispatch: mocks.dispatch, setSendGuard: vi.fn() }));
vi.mock("./modules/gradeEmail", async (original) => ({ ...(await original<object>()), recordAnnouncedScore: mocks.recordAnnouncedScore }));

import {
  aiGradeDedupeKey,
  aiOverrideNeedsNotice,
  aiRegradeDedupeKey,
  applyAutoGrade,
  autoGradeBlockedBy,
  autoGradeEnabledForTasks,
  autoGradeSetting,
  clampScore,
  gradeOwner,
  planAutoGrade,
  type ReviewForGrading,
} from "./modules/autoGrade";
import { gradeEmailKind } from "./modules/gradeEmail";
import { formatAiGradeFeedback } from "./notifications/templates";

const clean: ReviewForGrading = { status: "DONE", checks: [], feedback: "Yaxşı iş", suggestedScore: 85, needsTeacherReview: false };

describe("when the AI grade may be released automatically", () => {
  it("allows a finished, clean review — late submissions too", () => {
    expect(autoGradeBlockedBy(clean)).toBeNull();
    expect(autoGradeBlockedBy({ ...clean, checks: [{ code: "LATE", level: "info" }] })).toBeNull();
  });

  it("blocks empty, failed-check, unreadable and manipulated submissions", () => {
    expect(autoGradeBlockedBy({ ...clean, checks: [{ code: "NO_CONTENT", level: "fail" }] })).toBe("EMPTY");
    expect(autoGradeBlockedBy({ ...clean, checks: [{ code: "FILE_NOT_OWNED", level: "fail" }] })).toBe("CHECKS_FAILED");
    expect(autoGradeBlockedBy({ ...clean, checks: [{ code: "TEXT_NOT_EXTRACTABLE", level: "warn" }] })).toBe("UNREADABLE_FILE");
    expect(autoGradeBlockedBy({ ...clean, checks: [{ code: "LATE", level: "info" }, { code: "INJECTION_SUSPECTED", level: "warn" }] })).toBe("INJECTION_SUSPECTED");
  });

  it("blocks when the AI failed, was skipped, gave no score or feedback, or asked for the teacher", () => {
    expect(autoGradeBlockedBy({ ...clean, status: "FAILED" })).toBe("AI_NOT_DONE");
    expect(autoGradeBlockedBy({ ...clean, status: "SKIPPED" })).toBe("AI_NOT_DONE");
    expect(autoGradeBlockedBy({ ...clean, suggestedScore: null })).toBe("AI_NOT_DONE");
    expect(autoGradeBlockedBy({ ...clean, feedback: "   " })).toBe("NO_FEEDBACK");
    expect(autoGradeBlockedBy({ ...clean, needsTeacherReview: true })).toBe("AI_ASKED_TEACHER");
  });
});

describe("planAutoGrade", () => {
  const plan = (over: Partial<Parameters<typeof planAutoGrade>[0]>) =>
    planAutoGrade({ enabled: true, owner: "NONE", block: null, currentScore: null, aiScore: 85, ...over });

  it("releases the clamped AI score on an ungraded submission", () => {
    expect(plan({})).toEqual({ kind: "RELEASE", score: 85 });
    expect(plan({ aiScore: 130 })).toEqual({ kind: "RELEASE", score: 100 });
    expect(plan({ aiScore: 72.46 })).toEqual({ kind: "RELEASE", score: 72.5 });
  });

  it("does nothing when auto-grade is off", () => {
    expect(plan({ enabled: false })).toEqual({ kind: "SKIP", why: "DISABLED" });
  });

  it("never touches a teacher's grade", () => {
    expect(plan({ owner: "TEACHER", currentScore: 60 })).toEqual({ kind: "SKIP", why: "TEACHER_GRADED" });
    expect(plan({ owner: "TEACHER", block: "INJECTION_SUSPECTED" })).toEqual({ kind: "SKIP", why: "TEACHER_GRADED" });
  });

  it("sends blocked submissions to the teacher queue", () => {
    expect(plan({ block: "INJECTION_SUSPECTED" })).toEqual({ kind: "NEEDS_TEACHER", reason: "INJECTION_SUSPECTED" });
    expect(plan({ aiScore: null })).toEqual({ kind: "NEEDS_TEACHER", reason: "AI_NOT_DONE" });
  });

  it("lets a rerun update an AI grade and says whether the score changed", () => {
    expect(plan({ owner: "AI", currentScore: 85, aiScore: 85 })).toEqual({ kind: "REGRADE", score: 85, scoreChanged: false });
    expect(plan({ owner: "AI", currentScore: 85, aiScore: 70 })).toEqual({ kind: "REGRADE", score: 70, scoreChanged: true });
  });

  it("keeps an AI grade when a rerun fails or is doubtful", () => {
    expect(plan({ owner: "AI", currentScore: 85, block: "AI_NOT_DONE" })).toEqual({ kind: "SKIP", why: "KEEP_AI_GRADE" });
  });

  it("knows who owns a grade", () => {
    expect(gradeOwner({ gradedAt: null, gradedByUserId: null })).toBe("NONE");
    expect(gradeOwner({ gradedAt: new Date(), gradedByUserId: null })).toBe("AI");
    expect(gradeOwner({ gradedAt: new Date(), gradedByUserId: 3 })).toBe("TEACHER");
    expect(clampScore(-5)).toBe(0);
  });
});

describe("teacher override notices", () => {
  const notices = (before: { score: number; feedback: string }, after: { score: number; feedback: string }) => {
    const email = gradeEmailKind({ before: { wasReleased: true, score: before.score }, after: { release: true, score: after.score } }, before.score);
    const override = aiOverrideNeedsNotice({ owner: "AI", released: true, ...before }, { release: true, ...after });
    return [email, override ? "override" : null].filter(Boolean);
  };

  it("sends exactly one 'updated' notice when the teacher changes an AI grade", () => {
    expect(notices({ score: 85, feedback: "AI" }, { score: 70, feedback: "AI" })).toEqual(["updated"]);
    expect(notices({ score: 85, feedback: "AI" }, { score: 70, feedback: "Teacher" })).toEqual(["updated"]);
    expect(notices({ score: 85, feedback: "AI" }, { score: 85, feedback: "Teacher" })).toEqual(["override"]);
    expect(notices({ score: 85, feedback: "AI" }, { score: 85, feedback: " AI " })).toEqual([]);
  });

  it("only applies to released AI grades", () => {
    expect(aiOverrideNeedsNotice({ owner: "TEACHER", released: true, score: 1, feedback: "a" }, { release: true, score: 1, feedback: "b" })).toBe(false);
    expect(aiOverrideNeedsNotice({ owner: "AI", released: true, score: 1, feedback: "a" }, { release: false, score: 1, feedback: "b" })).toBe(false);
  });

  it("uses one dedupe key per AI grade and one per rerun", () => {
    expect(aiGradeDedupeKey("s1")).toBe("ai-grade:s1");
    expect(aiRegradeDedupeKey("s1", "r2")).not.toBe(aiRegradeDedupeKey("s1", "r3"));
  });
});

describe("AI grade feedback text", () => {
  it("combines the summary, strengths and improvements", () => {
    const text = formatAiGradeFeedback("az", { feedback: "Ümumi rəy", strengths: ["Aydın"], improvements: ["Mənbə əlavə et"] });
    expect(text).toBe("Ümumi rəy\n\nGüclü tərəflər:\n- Aydın\n\nİnkişaf üçün:\n- Mənbə əlavə et");
    expect(formatAiGradeFeedback("en", { feedback: "Ok", strengths: [], improvements: [] })).toBe("Ok");
  });
});

// ---------------------------------------------------------------------------
// applyAutoGrade against a fake database
// ---------------------------------------------------------------------------

const missingTable = () => Object.assign(new Error("Table doesn't exist"), { errno: 1146 });

function fakeDb(opts: { row?: object; autoGrade?: boolean; missing?: unknown[]; affectedRows?: number }) {
  const updates: object[] = [];
  const grading: object[] = [];
  const read = async (table: unknown) => {
    if (opts.missing?.includes(table)) throw missingTable();
    if (table === submissionAiReviews) return opts.row ? [opts.row] : [];
    if (table === taskGradingSettings) return opts.autoGrade === undefined ? [] : [{ taskId: "t1", enabled: opts.autoGrade }];
    return [];
  };
  const chain = (table: unknown) => {
    const c = {
      innerJoin: () => c,
      where: () => c,
      limit: () => read(table),
      then: (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => read(table).then(ok, fail),
    };
    return c;
  };
  return {
    updates,
    grading,
    db: {
      select: () => ({ from: chain }),
      insert: (table: unknown) => ({
        values: (values: object) => ({
          onDuplicateKeyUpdate: async () => {
            if (opts.missing?.includes(table)) throw missingTable();
            if (table === submissionGrading) grading.push(values);
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (set: object) => ({
          where: async () => {
            if (table === taskSubmissions) updates.push(set);
            return [{ affectedRows: opts.affectedRows ?? 1 }];
          },
        }),
      }),
    },
  };
}

const reviewRow = (over: { sub?: object; review?: object } = {}) => ({
  sub: { id: "s1", taskId: "t1", studentId: 7, score: null, gradedAt: null, gradedByUserId: null, ...over.sub },
  taskTitle: "Essay",
  locale: "az",
  review: { status: "DONE", checks: [], feedback: "Yaxşı iş", suggestedScore: 85, details: { strengths: ["Aydın"], improvements: [], needsTeacherReview: false }, ...over.review },
});

describe("applyAutoGrade", () => {
  beforeEach(() => {
    mocks.dispatch.mockClear();
    mocks.recordAnnouncedScore.mockClear();
  });

  it("releases the AI grade and sends one 'result ready' notice", async () => {
    const fake = fakeDb({ row: reviewRow() });
    mocks.db = fake.db;
    expect(await applyAutoGrade("s1", "r1")).toEqual({ kind: "RELEASE", score: 85 });
    expect(fake.updates[0]).toMatchObject({ score: 85, gradedByUserId: null, teacherFeedback: expect.stringContaining("Yaxşı iş") });
    expect(fake.updates[0]).toHaveProperty("feedbackReleasedAt");
    expect(fake.grading[0]).toMatchObject({ source: "AI", autoStatus: "AI_GRADED", aiScore: 85, reviewRunId: "r1" });
    expect(mocks.recordAnnouncedScore).toHaveBeenCalledWith("s1", 85);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ event: "AI_GRADE_READY", userId: 7, dedupeKey: "ai-grade:s1", data: expect.objectContaining({ score: 85 }) }));
  });

  it("queues a blocked submission for the teacher without releasing or notifying", async () => {
    const fake = fakeDb({ row: reviewRow({ review: { checks: [{ code: "INJECTION_SUSPECTED", level: "warn" }] } }) });
    mocks.db = fake.db;
    expect(await applyAutoGrade("s1", "r1")).toEqual({ kind: "NEEDS_TEACHER", reason: "INJECTION_SUSPECTED" });
    expect(fake.updates).toHaveLength(0);
    expect(fake.grading[0]).toMatchObject({ autoStatus: "NEEDS_TEACHER", autoReason: "INJECTION_SUSPECTED" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("loses to a teacher who saved in the meantime", async () => {
    const fake = fakeDb({ row: reviewRow(), affectedRows: 0 });
    mocks.db = fake.db;
    expect(await applyAutoGrade("s1", "r1")).toEqual({ kind: "SKIP", why: "TEACHER_GRADED" });
    expect(fake.grading).toHaveLength(0);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("does not overwrite a teacher grade on 'Yenidən yoxla'", async () => {
    const fake = fakeDb({ row: reviewRow({ sub: { score: 60, gradedAt: new Date(), gradedByUserId: 3 } }) });
    mocks.db = fake.db;
    expect(await applyAutoGrade("s1", "r2")).toEqual({ kind: "SKIP", why: "TEACHER_GRADED" });
    expect(fake.updates).toHaveLength(0);
  });

  it("on a rerun of an AI grade notifies only if the score changed", async () => {
    const ai = { sub: { score: 85, gradedAt: new Date(), gradedByUserId: null } };
    let fake = fakeDb({ row: reviewRow(ai) });
    mocks.db = fake.db;
    expect(await applyAutoGrade("s1", "r2")).toEqual({ kind: "REGRADE", score: 85, scoreChanged: false });
    expect(mocks.dispatch).not.toHaveBeenCalled();

    fake = fakeDb({ row: reviewRow({ ...ai, review: { suggestedScore: 70 } }) });
    mocks.db = fake.db;
    expect(await applyAutoGrade("s1", "r3")).toEqual({ kind: "REGRADE", score: 70, scoreChanged: true });
    expect(fake.updates[0]).toMatchObject({ score: 70 });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ event: "GRADE_UPDATED", dedupeKey: "ai-regrade:s1:r3" }));
  });

  it("ignores a finished run that is no longer the latest", async () => {
    mocks.db = fakeDb({}).db;
    expect(await applyAutoGrade("s1", "old")).toEqual({ kind: "SKIP", why: "STALE" });
  });

  it("honours a task with auto-grade switched off", async () => {
    const fake = fakeDb({ row: reviewRow(), autoGrade: false });
    mocks.db = fake.db;
    expect(await applyAutoGrade("s1", "r1")).toEqual({ kind: "SKIP", why: "DISABLED" });
    expect(fake.updates).toHaveLength(0);
  });
});

describe("before migration 0024 has run", () => {
  it("treats auto-grade as off, so the teacher approves as before", async () => {
    const fake = fakeDb({ row: reviewRow(), missing: [taskGradingSettings, submissionGrading] });
    mocks.db = fake.db;
    expect(await autoGradeSetting("t1")).toEqual({ enabled: false, available: false });
    expect(await autoGradeEnabledForTasks(["t1"])).toEqual(new Set());
    expect(await applyAutoGrade("s1", "r1")).toEqual({ kind: "SKIP", why: "UNAVAILABLE" });
    expect(fake.updates).toHaveLength(0);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("does not release if only the grading table is missing", async () => {
    const fake = fakeDb({ row: reviewRow(), missing: [submissionGrading] });
    mocks.db = fake.db;
    expect(await applyAutoGrade("s1", "r1")).toEqual({ kind: "SKIP", why: "UNAVAILABLE" });
    expect(fake.updates).toHaveLength(0);
  });
});

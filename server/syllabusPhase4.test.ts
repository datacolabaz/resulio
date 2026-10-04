import { afterEach, describe, expect, it, vi } from "vitest";
import { builderPath, resultPath, safeSyllabusEditorPath } from "../client/src/lib/syllabusLearn";
import { TIMESTAMP_MIN } from "../shared/syllabus";
import { checkCanStart, effectiveRules } from "./modules/engine";
import * as dispatcher from "./notifications/dispatcher";
import { batchStore, enqueueNotice, flushDueNotices, mergeNotice, NOTICE_WINDOW_MS, type PendingNotice } from "./syllabus/notify";
import { syllabusAvailableFrom } from "./syllabus/progression";

vi.mock("./notifications/dispatcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./notifications/dispatcher")>()),
  dispatch: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(dispatcher.dispatch).mockReset();
  vi.useRealTimers();
});

const missingTable = () => Object.assign(new Error("Failed query"), { cause: { errno: 1146, code: "ER_NO_SUCH_TABLE" } });
const approval = (keys: string[], students: number[]): PendingNotice => ({
  key: "approval:7:syl1",
  kind: "APPROVAL",
  syllabusId: "syl1",
  payload: { syllabusTitle: "Java", teacherId: 7, keys, students },
});

// ---------------------------------------------------------------------------
// Exam engine rules for a syllabus assignment (the same functions startAttempt runs)
// ---------------------------------------------------------------------------

describe("syllabus assignment on the exam engine", () => {
  const NOW = new Date("2026-10-04T10:00:00Z");
  const exam = { status: "PUBLISHED" as const, startAt: new Date("2026-12-01T09:00:00Z"), endAt: null, currentVersionId: "v2" };
  const jit = (over: Partial<Parameters<typeof effectiveRules>[1]> = {}) => ({
    assessmentVersionId: "v1",
    availableFrom: syllabusAvailableFrom(null),
    availableUntil: null,
    durationOverrideSeconds: null,
    attemptLimitOverride: 3,
    ...over,
  });
  const canStart = (assignment: ReturnType<typeof jit>, finishedAttempts: number) => {
    const rules = effectiveRules(exam, assignment, { durationSeconds: 600, attemptsAllowed: 1 });
    return { rules, denial: checkCanStart({ assessment: exam, window: { startAt: rules.startAt, endAt: rules.endAt }, versionId: rules.versionId, attemptsAllowed: rules.attemptsAllowed, hasAccess: true, finishedAttempts, now: NOW }) };
  };

  it("runs on the pinned version even after the exam was republished", () => {
    expect(canStart(jit(), 0).rules.versionId).toBe("v1");
  });

  it("is open as soon as the item unlocks, whatever the exam's own start date", () => {
    expect(syllabusAvailableFrom(null)).toEqual(TIMESTAMP_MIN);
    expect(canStart(jit(), 0).denial).toBeNull();
  });

  it("waits out the retry cooldown", () => {
    const until = new Date(NOW.getTime() + 15 * 60_000);
    expect(canStart(jit({ availableFrom: syllabusAvailableFrom(until) }), 1).denial).toBe("NOT_STARTED");
  });

  it("uses the syllabus attempt limit instead of the exam's", () => {
    expect(canStart(jit(), 2).denial).toBeNull();
    expect(canStart(jit(), 3).denial).toBe("NO_ATTEMPTS_LEFT");
  });
});

// ---------------------------------------------------------------------------
// Return navigation
// ---------------------------------------------------------------------------

describe("return navigation", () => {
  it("the result page keeps the way back to the lesson", () => {
    expect(resultPath("r1", "/student/syllabus/s1/lessons/l1")).toBe("/student/results/r1?returnTo=%2Fstudent%2Fsyllabus%2Fs1%2Flessons%2Fl1");
    expect(resultPath("r1", null)).toBe("/student/results/r1");
    expect(resultPath("r1", "https://evil.example")).toBe("/student/results/r1");
  });

  it("the exam builder returns only to a syllabus or lesson editor page", () => {
    expect(safeSyllabusEditorPath("/teacher/syllabus/s1/lessons/l1")).toBe("/teacher/syllabus/s1/lessons/l1");
    expect(safeSyllabusEditorPath("/teacher/syllabus/s1")).toBe("/teacher/syllabus/s1");
    expect(safeSyllabusEditorPath("/teacher/syllabus/s1/preview")).toBeNull();
    expect(safeSyllabusEditorPath("//evil.example/teacher/syllabus/s1")).toBeNull();
    expect(builderPath("/teacher/assessments/new", "/teacher/syllabus/s1/lessons/l1")).toBe("/teacher/assessments/new?returnTo=%2Fteacher%2Fsyllabus%2Fs1%2Flessons%2Fl1");
    expect(builderPath("/teacher/assessments/a1/edit?step=rules", "/teacher/syllabus/s1")).toBe("/teacher/assessments/a1/edit?step=rules&returnTo=%2Fteacher%2Fsyllabus%2Fs1");
    expect(builderPath("/teacher/assessments/new", "/teacher/groups")).toBe("/teacher/assessments/new");
  });
});

// ---------------------------------------------------------------------------
// Persisted notice batches
// ---------------------------------------------------------------------------

describe("notice batches", () => {
  it("merge without duplicates, keeping first-seen order and the latest titles", () => {
    const a: PendingNotice = { key: "unlock:e1", kind: "UNLOCK", syllabusId: "s", payload: { syllabusTitle: "Old", studentId: 1, enrollmentId: "e1", lessons: [["l1", "A"]], modules: [] } };
    const b: PendingNotice = { key: "unlock:e1", kind: "UNLOCK", syllabusId: "s", payload: { syllabusTitle: "New", studentId: 1, enrollmentId: "e1", lessons: [["l2", "B"], ["l1", "A2"]], modules: [["m2", "M"]] } };
    expect(mergeNotice(a, b).payload).toEqual({ syllabusTitle: "New", studentId: 1, enrollmentId: "e1", lessons: [["l1", "A2"], ["l2", "B"]], modules: [["m2", "M"]] });
    expect(mergeNotice(approval(["k1"], [1]), approval(["k1", "k2"], [1, 2])).payload).toMatchObject({ keys: ["k1", "k2"], students: [1, 2] });
  });

  it("are written to the table, retrying once on a concurrent first write", async () => {
    const upsert = vi.spyOn(batchStore, "upsert").mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" })).mockResolvedValueOnce(undefined);
    await enqueueNotice(approval(["k1"], [1]));
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("fall back to memory for one window while the table does not exist yet", async () => {
    vi.useFakeTimers();
    vi.spyOn(batchStore, "upsert").mockRejectedValue(missingTable());
    await enqueueNotice(approval(["k1"], [1]));
    await enqueueNotice(approval(["k2"], [2]));
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(NOTICE_WINDOW_MS + 10);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({ event: "SYLLABUS_APPROVAL_NEEDED", userId: 7, data: expect.objectContaining({ count: 2, studentName: null }) }));
  });

  it("are sent after a restart by whoever claims them; a batch merged meanwhile waits for the next sweep", async () => {
    const one = approval(["k1"], [1, 2]);
    const two = { ...approval(["k9"], [3, 4]), key: "approval:7:syl2", syllabusId: "syl2" };
    vi.spyOn(batchStore, "due").mockResolvedValue([{ notice: one, revision: 0 }, { notice: two, revision: 4 }]);
    const claim = vi.spyOn(batchStore, "claim").mockImplementation(async (key) => key === one.key);
    expect(await flushDueNotices()).toBe(1);
    expect(claim).toHaveBeenCalledWith(two.key, 4);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ syllabusId: "syl1", count: 2 }) }));
  });

  it("do nothing before the migration", async () => {
    vi.spyOn(batchStore, "due").mockRejectedValue(missingTable());
    expect(await flushDueNotices()).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import {
  checkCanStart,
  computeDeadline,
  correctAnswerOf,
  DEADLINE_GRACE_MS,
  effectiveRules,
  gradeAttempt,
  gradeQuestion,
  isExpired,
  isPastGrace,
  liveStatus,
  median,
  parseNumber,
  questionOrderFor,
  rank,
  resultVisibility,
  seededShuffle,
  summarizeScores,
  toStudentQuestion,
  topicStats,
  type FrozenQuestion,
} from "./modules/engine";

function q(partial: Partial<FrozenQuestion> & Pick<FrozenQuestion, "type" | "content" | "answerKey">): FrozenQuestion {
  return {
    id: partial.id ?? `q-${partial.type}`,
    position: 1,
    text: "Question",
    points: 2,
    topic: "Algebra",
    skill: "",
    difficulty: "MEDIUM",
    explanation: "Because.",
    imageUrl: null,
    ...partial,
  } as FrozenQuestion;
}

const MC = q({ type: "MULTIPLE_CHOICE", content: { options: [{ key: "A", text: "1" }, { key: "B", text: "2" }] }, answerKey: { correct: "B" } });
const MS = q({ type: "MULTIPLE_SELECT", content: { options: [{ key: "A", text: "1" }, { key: "B", text: "2" }, { key: "C", text: "3" }] }, answerKey: { correct: ["A", "C"] } });
const TF = q({ type: "TRUE_FALSE", content: {}, answerKey: { correct: false } });
const SHORT = q({ type: "SHORT_ANSWER", content: {}, answerKey: { accepted: ["Bakı", "Baku"], caseSensitive: false } });
const LONG = q({ type: "LONG_ANSWER", content: {}, answerKey: {} });
const MATCH = q({
  type: "MATCHING",
  content: { left: [{ key: "L1", text: "Az" }, { key: "L2", text: "Fr" }], right: [{ key: "R1", text: "Baku" }, { key: "R2", text: "Paris" }] },
  answerKey: { pairs: { L1: "R1", L2: "R2" } },
});
const ORDER = q({
  type: "ORDERING",
  content: { items: [{ key: "a", text: "1" }, { key: "b", text: "2" }, { key: "c", text: "3" }] },
  answerKey: { order: ["a", "b", "c"] },
});
const BLANK = q({ type: "FILL_BLANK", content: { blankCount: 2 }, answerKey: { blanks: [["su"], ["hava", "hava axını"]], caseSensitive: false } });
const NUM = q({ type: "NUMERIC", content: { unit: "m" }, answerKey: { value: 12.5, tolerance: 0.1 } });

describe("grading", () => {
  it("grades multiple choice and multiple select exactly", () => {
    expect(gradeQuestion(MC, "B")).toMatchObject({ status: "CORRECT", earned: 2 });
    expect(gradeQuestion(MC, "A")).toMatchObject({ status: "WRONG", earned: 0 });
    expect(gradeQuestion(MS, ["C", "A"]).status).toBe("CORRECT");
    expect(gradeQuestion(MS, ["A"]).status).toBe("WRONG");
    expect(gradeQuestion(MS, ["A", "B", "C"]).status).toBe("WRONG");
  });

  it("accepts TRUE/FALSE as strings or booleans", () => {
    expect(gradeQuestion(TF, "FALSE").status).toBe("CORRECT");
    expect(gradeQuestion(TF, false).status).toBe("CORRECT");
    expect(gradeQuestion(TF, "TRUE").status).toBe("WRONG");
  });

  it("normalises short and fill-blank answers (case, whitespace)", () => {
    expect(gradeQuestion(SHORT, "  bakı ").status).toBe("CORRECT");
    expect(gradeQuestion(SHORT, "BAKU").status).toBe("CORRECT");
    expect(gradeQuestion(SHORT, "Gəncə").status).toBe("WRONG");
    expect(gradeQuestion(BLANK, ["Su", "hava  axını"]).status).toBe("CORRECT");
    expect(gradeQuestion(BLANK, ["su"]).status).toBe("WRONG");
  });

  it("requires every matching pair and the exact order", () => {
    expect(gradeQuestion(MATCH, { L1: "R1", L2: "R2" }).status).toBe("CORRECT");
    expect(gradeQuestion(MATCH, { L1: "R1" }).status).toBe("WRONG");
    expect(gradeQuestion(ORDER, ["a", "b", "c"]).status).toBe("CORRECT");
    expect(gradeQuestion(ORDER, ["b", "a", "c"]).status).toBe("WRONG");
  });

  it("grades numeric answers with tolerance and comma decimals", () => {
    expect(gradeQuestion(NUM, "12,5").status).toBe("CORRECT");
    expect(gradeQuestion(NUM, "12.6").status).toBe("CORRECT");
    expect(gradeQuestion(NUM, "12.7").status).toBe("WRONG");
    expect(gradeQuestion(NUM, "abc").status).toBe("WRONG");
    expect(parseNumber(" 1 000,5 ")).toBe(1000.5);
    expect(parseNumber("1e3")).toBe(1000);
    expect(parseNumber("12..5")).toBeNull();
  });

  it("sends answered long answers to teacher review and marks empty answers unanswered", () => {
    expect(gradeQuestion(LONG, "An essay").status).toBe("PENDING_REVIEW");
    expect(gradeQuestion(LONG, "   ").status).toBe("UNANSWERED");
    expect(gradeQuestion(MC, undefined).status).toBe("UNANSWERED");
    expect(gradeQuestion(MS, []).status).toBe("UNANSWERED");
    expect(gradeQuestion(MATCH, {}).status).toBe("UNANSWERED");
  });

  it("scores an attempt with counts and percentage", () => {
    const score = gradeAttempt([MC, TF, LONG, NUM], { [MC.id]: "B", [TF.id]: "TRUE", [LONG.id]: "text" });
    expect(score).toMatchObject({
      totalPoints: 8,
      earnedPoints: 2,
      percentage: 25,
      correctCount: 1,
      wrongCount: 1,
      unansweredCount: 1,
      pendingReviewCount: 1,
    });
  });

  it("returns the correct answer in the student's answer shape", () => {
    expect(correctAnswerOf(MC)).toBe("B");
    expect(correctAnswerOf(BLANK)).toEqual(["su", "hava"]);
    expect(correctAnswerOf(NUM)).toBe("12.5");
    expect(correctAnswerOf(LONG)).toBeUndefined();
  });
});

describe("student projection", () => {
  const all = [MC, MS, TF, SHORT, LONG, MATCH, ORDER, BLANK, NUM];

  it("never includes answer keys or explanations", () => {
    for (const question of all) {
      const view = JSON.stringify(toStudentQuestion(question, "attempt-1"));
      expect(view).not.toContain("answerKey");
      expect(view).not.toContain("correct");
      expect(view).not.toContain("explanation");
      expect(view).not.toContain("Because.");
      expect(view).not.toContain("pairs");
    }
  });

  it("does not reveal the ordering or matching solution through item order", () => {
    const ordering = toStudentQuestion(ORDER, "attempt-1");
    expect(ordering.items!.map((i) => i.key)).not.toEqual(["a", "b", "c"]);
    const matching = toStudentQuestion(MATCH, "attempt-1");
    expect(matching.right!.map((r) => r.key)).not.toEqual(["R1", "R2"]);
  });

  it("is stable for the same seed and exposes blank count and unit", () => {
    expect(toStudentQuestion(ORDER, "seed")).toEqual(toStudentQuestion(ORDER, "seed"));
    expect(toStudentQuestion(BLANK, "s").blankCount).toBe(2);
    expect(toStudentQuestion(NUM, "s").unit).toBe("m");
  });

  it("shuffles deterministically and keeps every item", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `q${i}`);
    expect(seededShuffle(ids, "x")).toEqual(seededShuffle(ids, "x"));
    expect([...seededShuffle(ids, "x")].sort()).toEqual([...ids].sort());
    expect(questionOrderFor(ids, false, "x")).toEqual(ids);
    expect(questionOrderFor(ids, true, "x")).not.toEqual(ids);
  });
});

describe("access rules", () => {
  const now = new Date("2026-05-01T10:00:00Z");
  const published = { status: "PUBLISHED" as const, currentVersionId: "v1" };
  const base = {
    assessment: published,
    window: { startAt: new Date("2026-05-01T09:00:00Z"), endAt: new Date("2026-05-01T12:00:00Z") },
    versionId: "v1",
    attemptsAllowed: 1,
    hasAccess: true,
    finishedAttempts: 0,
    now,
  };

  it("allows a valid start", () => {
    expect(checkCanStart(base)).toBeNull();
  });

  it("denies in the documented order", () => {
    expect(checkCanStart({ ...base, assessment: { status: "DRAFT", currentVersionId: null } })).toBe("NOT_PUBLISHED");
    expect(checkCanStart({ ...base, hasAccess: false })).toBe("NO_ACCESS");
    expect(checkCanStart({ ...base, window: { startAt: new Date("2026-05-01T11:00:00Z"), endAt: null } })).toBe("NOT_STARTED");
    expect(checkCanStart({ ...base, window: { startAt: null, endAt: new Date("2026-05-01T10:00:00Z") } })).toBe("CLOSED");
    expect(checkCanStart({ ...base, assessment: { status: "CLOSED", currentVersionId: "v1" } })).toBe("CLOSED");
    expect(checkCanStart({ ...base, finishedAttempts: 1 })).toBe("NO_ATTEMPTS_LEFT");
    expect(checkCanStart({ ...base, hasAccess: false, finishedAttempts: 5 })).toBe("NO_ACCESS");
  });

  it("applies assignment overrides over assessment defaults", () => {
    const assessment = { startAt: new Date("2026-05-01T09:00:00Z"), endAt: new Date("2026-05-01T12:00:00Z"), currentVersionId: "v2" };
    const settings = { durationSeconds: 1800, attemptsAllowed: 1 };
    const none = { assessmentVersionId: null, availableFrom: null, availableUntil: null, durationOverrideSeconds: null, attemptLimitOverride: null };
    expect(effectiveRules(assessment, none, settings)).toEqual({
      versionId: "v2",
      startAt: assessment.startAt,
      endAt: assessment.endAt,
      durationSeconds: 1800,
      attemptsAllowed: 1,
    });
    const override = {
      assessmentVersionId: "v1",
      availableFrom: new Date("2026-05-02T09:00:00Z"),
      availableUntil: new Date("2026-05-02T12:00:00Z"),
      durationOverrideSeconds: 2700,
      attemptLimitOverride: 3,
    };
    expect(effectiveRules(assessment, override, settings)).toEqual({
      versionId: "v1",
      startAt: override.availableFrom,
      endAt: override.availableUntil,
      durationSeconds: 2700,
      attemptsAllowed: 3,
    });
  });

  it("caps the deadline at the window end with no grace period", () => {
    const start = new Date("2026-05-01T11:50:00Z");
    const end = new Date("2026-05-01T12:00:00Z");
    expect(computeDeadline(start, 1800, end)).toEqual(end);
    expect(computeDeadline(start, 300, end)).toEqual(new Date("2026-05-01T11:55:00Z"));
    expect(computeDeadline(start, 300, null)).toEqual(new Date("2026-05-01T11:55:00Z"));
    const deadlineAt = new Date("2026-05-01T11:55:00Z");
    expect(isExpired({ status: "IN_PROGRESS", deadlineAt }, new Date("2026-05-01T11:54:59Z"))).toBe(false);
    expect(isExpired({ status: "IN_PROGRESS", deadlineAt }, deadlineAt)).toBe(true);
    expect(isExpired({ status: "SUBMITTED", deadlineAt }, new Date("2026-05-02T00:00:00Z"))).toBe(false);
  });

  it("closes an attempt for answers only after the grace period", () => {
    const deadlineAt = new Date("2026-05-01T11:55:00Z");
    const after = (ms: number) => new Date(deadlineAt.getTime() + ms);
    expect(isPastGrace({ status: "IN_PROGRESS", deadlineAt }, after(DEADLINE_GRACE_MS - 1))).toBe(false);
    expect(isPastGrace({ status: "IN_PROGRESS", deadlineAt }, after(DEADLINE_GRACE_MS))).toBe(true);
    expect(isPastGrace({ status: "AUTO_SUBMITTED", deadlineAt }, after(DEADLINE_GRACE_MS * 10))).toBe(false);
    expect(DEADLINE_GRACE_MS).toBeLessThanOrEqual(15_000);
  });

  it("derives live status from the window", () => {
    const w = { startAt: new Date("2026-05-01T09:00:00Z"), endAt: new Date("2026-05-01T12:00:00Z") };
    expect(liveStatus({ status: "DRAFT", ...w }, now)).toBe("DRAFT");
    expect(liveStatus({ status: "PUBLISHED", ...w }, new Date("2026-05-01T08:00:00Z"))).toBe("SCHEDULED");
    expect(liveStatus({ status: "PUBLISHED", ...w }, now)).toBe("ACTIVE");
    expect(liveStatus({ status: "PUBLISHED", ...w }, new Date("2026-05-01T12:00:00Z"))).toBe("COMPLETED");
  });
});

describe("result visibility", () => {
  const full = { releaseMode: "IMMEDIATE", reviewMode: "FULL", showCorrectAnswers: true, showExplanations: true } as const;

  it("releases immediately with full review", () => {
    expect(resultVisibility(full, { windowClosed: false, pendingReview: 0 })).toEqual({
      released: true,
      heldReason: null,
      showQuestions: "ALL",
      showCorrectAnswers: true,
      showExplanations: true,
    });
  });

  it("holds results until the window closes or grading finishes", () => {
    const afterClose = resultVisibility({ ...full, releaseMode: "AFTER_CLOSE" }, { windowClosed: false, pendingReview: 0 });
    expect(afterClose).toMatchObject({ released: false, heldReason: "WAITING_FOR_CLOSE", showQuestions: "NONE", showCorrectAnswers: false });
    expect(resultVisibility({ ...full, releaseMode: "AFTER_CLOSE" }, { windowClosed: true, pendingReview: 0 }).released).toBe(true);
    expect(resultVisibility({ ...full, releaseMode: "AFTER_GRADING" }, { windowClosed: true, pendingReview: 2 }).heldReason).toBe("WAITING_FOR_GRADING");
    expect(resultVisibility({ ...full, releaseMode: "AFTER_GRADING" }, { windowClosed: false, pendingReview: 0 }).released).toBe(true);
  });

  it("limits review by review mode", () => {
    const scoreOnly = resultVisibility({ ...full, reviewMode: "SCORE_ONLY" }, { windowClosed: false, pendingReview: 0 });
    expect(scoreOnly).toMatchObject({ released: true, showQuestions: "NONE", showCorrectAnswers: false, showExplanations: false });
    expect(resultVisibility({ ...full, reviewMode: "WRONG_ONLY" }, { windowClosed: false, pendingReview: 0 }).showQuestions).toBe("WRONG_ONLY");
    expect(resultVisibility({ ...full, showCorrectAnswers: false }, { windowClosed: false, pendingReview: 0 }).showCorrectAnswers).toBe(false);
  });
});

describe("analytics helpers", () => {
  it("computes median and summary", () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([10, 20, 30, 45])).toBe(25);
    expect(summarizeScores([50, 100, 75])).toEqual({ average: 75, median: 75, highest: 100, lowest: 50, count: 3 });
  });

  it("ranks by percentage then duration, sharing ranks on ties", () => {
    const ranked = rank([
      { studentId: 1, percentage: 80, durationSeconds: 600 },
      { studentId: 2, percentage: 90, durationSeconds: 900 },
      { studentId: 3, percentage: 80, durationSeconds: 600 },
      { studentId: 4, percentage: 80, durationSeconds: 300 },
    ]);
    expect(ranked.map((r) => [r.studentId, r.rank])).toEqual([[2, 1], [4, 2], [1, 3], [3, 3]]);
  });

  it("classifies topics and skills, ignoring pending reviews", () => {
    const rows = [
      { questionId: "1", status: "CORRECT" as const, earned: 1, topic: "Algebra", skill: "reading" },
      { questionId: "2", status: "WRONG" as const, earned: 0, topic: "Algebra", skill: "reading" },
      { questionId: "3", status: "CORRECT" as const, earned: 1, topic: "Geometry", skill: "" },
      { questionId: "4", status: "PENDING_REVIEW" as const, earned: 0, topic: "Geometry", skill: "" },
    ];
    const topics = topicStats(rows);
    expect(topics.find((t) => t.topic === "Algebra")).toMatchObject({ questionCount: 2, accuracyPercentage: 50, classification: "WEAK" });
    expect(topics.find((t) => t.topic === "Geometry")).toMatchObject({ questionCount: 1, classification: "STRONG" });
    expect(topicStats(rows.filter((r) => r.skill), "skill")).toEqual([
      expect.objectContaining({ topic: "reading", questionCount: 2, accuracyPercentage: 50 }),
    ]);
  });
});

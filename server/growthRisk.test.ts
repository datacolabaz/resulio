import { describe, expect, it } from "vitest";
import type { StatRow } from "./growth/mastery";
import { hashReportToken } from "./growth/reports";
import { difficultyQuota, pickRetakeQuestions, type RetakeCandidate } from "./growth/retake";
import { computeRisk, isDismissed, levelOf, repeatedMistakes, scoreDrop } from "./growth/risk";

const day = (n: number) => new Date(Date.UTC(2026, 8, n));
const quiet = { examScores: [], missedExams: 0, repeatedTopics: [], criticalTopics: [] };

describe("computeRisk", () => {
  it("is zero and NONE without signals", () => {
    expect(computeRisk(quiet)).toEqual({ score: 0, level: "NONE", reasons: [] });
  });

  it("explains each signal with its value and points", () => {
    const r = computeRisk({
      examScores: [{ at: day(1), pct: 80 }, { at: day(2), pct: 70 }, { at: day(3), pct: 75 }, { at: day(4), pct: 45 }],
      missedExams: 1,
      repeatedTopics: [{ label: "Kəsrlər", results: 3 }, { label: "Faizlər", results: 2 }],
      criticalTopics: [{ label: "Kəsrlər", mastery: 30 }, { label: "Faizlər", mastery: 40 }, { label: "Tənlik", mastery: 45 }],
    });
    // drop 30 → 30; repeated 3 → 20; missed 1 → 12.5; critical 3 avg 38.3 → 25 × 0.733 = 18.3
    expect(r.reasons.map((x) => x.code)).toEqual(["SCORE_DROP", "REPEATED_TOPIC_MISTAKES", "LOW_TOPIC_MASTERY", "MISSED_EXAMS"]);
    expect(r.reasons[0]).toEqual({ code: "SCORE_DROP", value: 30, points: 30 });
    expect(r.reasons[1]).toMatchObject({ value: 3, points: 20, topics: ["Kəsrlər", "Faizlər"] });
    expect(r.reasons.find((x) => x.code === "MISSED_EXAMS")).toEqual({ code: "MISSED_EXAMS", value: 1, points: 12.5 });
    expect(r.score).toBe(81);
    expect(r.level).toBe("HIGH");
  });

  it("ignores drops under 10 points and topics missed only once", () => {
    const r = computeRisk({ ...quiet, examScores: [{ at: day(1), pct: 70 }, { at: day(2), pct: 62 }], repeatedTopics: [{ label: "A", results: 1 }] });
    expect(r.reasons).toEqual([]);
  });

  it("caps severities, so the score never passes 100", () => {
    const r = computeRisk({
      examScores: [{ at: day(1), pct: 100 }, { at: day(2), pct: 0 }],
      missedExams: 9,
      repeatedTopics: [{ label: "A", results: 5 }],
      criticalTopics: [{ label: "A", mastery: 0 }, { label: "B", mastery: 0 }, { label: "C", mastery: 0 }, { label: "D", mastery: 0 }],
    });
    expect(r.score).toBe(100);
  });

  it("uses fixed level thresholds", () => {
    expect(levelOf(60)).toBe("HIGH");
    expect(levelOf(59)).toBe("MEDIUM");
    expect(levelOf(35)).toBe("MEDIUM");
    expect(levelOf(34)).toBe("WATCH");
    expect(levelOf(15)).toBe("WATCH");
    expect(levelOf(14)).toBe("NONE");
  });

  it("compares the last exam with up to three before it, whatever the input order", () => {
    expect(scoreDrop([{ at: day(5), pct: 50 }, { at: day(1), pct: 10 }, { at: day(2), pct: 70 }, { at: day(3), pct: 80 }, { at: day(4), pct: 90 }])).toBe(30);
    expect(scoreDrop([{ at: day(1), pct: 50 }])).toBeNull();
  });
});

describe("repeatedMistakes", () => {
  const row = (resultId: string, n: number, topicKey: string, earned: number, possible = 4): StatRow => ({
    resultId,
    completedAt: day(n),
    origin: "EXAM",
    questionCount: possible,
    pendingCount: 0,
    earned,
    possible,
    wrongPoints: possible - earned,
    dimension: "TOPIC",
    topicKey,
    questionTopicId: null,
    label: topicKey.toUpperCase(),
  });

  it("counts results below 50% per topic among the last five", () => {
    const stats = [
      row("r1", 1, "a", 0), // too old once six results exist
      row("r2", 2, "a", 1),
      row("r3", 3, "a", 1),
      row("r4", 4, "b", 1),
      row("r5", 5, "b", 3),
      row("r6", 6, "c", 0),
      row("r6", 6, "", 0),
    ];
    expect(repeatedMistakes(stats)).toEqual([{ label: "A", results: 2 }]);
  });
});

describe("dismissal", () => {
  const now = day(10);
  it("hides until the date unless the score rose by 15", () => {
    expect(isDismissed({ score: 60, dismissedUntil: day(20), dismissedScore: 60 }, now)).toBe(true);
    expect(isDismissed({ score: 74, dismissedUntil: day(20), dismissedScore: 60 }, now)).toBe(true);
    expect(isDismissed({ score: 75, dismissedUntil: day(20), dismissedScore: 60 }, now)).toBe(false);
    expect(isDismissed({ score: 60, dismissedUntil: day(5), dismissedScore: 60 }, now)).toBe(false);
    expect(isDismissed({ score: 60, dismissedUntil: null, dismissedScore: null }, now)).toBe(false);
  });
});

describe("pickRetakeQuestions", () => {
  const seq = () => {
    let i = 0;
    return () => ((i = (i * 9301 + 49297) % 233280) / 233280);
  };
  const bank = (topicKey: string, n: number, seenEvery = 0): RetakeCandidate[] =>
    Array.from({ length: n }, (_, i) => ({ id: `${topicKey}-${i}`, topicKey, difficulty: (["EASY", "MEDIUM", "HARD"] as const)[i % 3], seen: seenEvery > 0 && i % seenEvery === 0 }));

  it("splits the count 30/50/20 by difficulty", () => {
    expect(difficultyQuota(10)).toEqual({ EASY: 3, MEDIUM: 5, HARD: 2 });
    expect(difficultyQuota(3)).toEqual({ EASY: 1, MEDIUM: 2, HARD: 0 });
  });

  it("covers every topic and prefers unseen questions", () => {
    const { ids, reusedSeen } = pickRetakeQuestions([...bank("a", 12, 2), ...bank("b", 12, 2)], 10, seq());
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    expect(ids.filter((id) => id.startsWith("a-"))).toHaveLength(5);
    expect(reusedSeen).toBe(0);
  });

  it("falls back to seen questions and returns fewer when the bank is small", () => {
    const all = bank("a", 4, 1);
    const { ids, reusedSeen } = pickRetakeQuestions(all, 10, seq());
    expect(ids).toHaveLength(4);
    expect(reusedSeen).toBe(4);
  });
});

describe("report tokens", () => {
  it("stores a stable SHA-256 hex digest, never the token", () => {
    const h = hashReportToken("abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashReportToken("abc"));
    expect(h).not.toContain("abc");
  });
});

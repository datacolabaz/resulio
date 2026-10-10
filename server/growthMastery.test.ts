import { describe, expect, it } from "vitest";
import { computeMastery, feasibility, masteryRows, priorOf, statusOf, topGains, trendOf, type Evidence, type StatRow } from "./growth/mastery";
import { summarizeGroupTopics, topicHistory } from "./growth/weakness";

const day = (n: number) => new Date(Date.UTC(2026, 8, n));
const ev = (n: number, earned: number, possible: number, extra: Partial<Evidence> = {}): Evidence => ({
  resultId: `r${n}`,
  completedAt: day(n),
  origin: "EXAM",
  questionCount: possible,
  pendingCount: 0,
  earned,
  possible,
  wrongPoints: possible - earned,
  ...extra,
});
const stat = (topicKey: string, e: Evidence, dimension: StatRow["dimension"] = "TOPIC"): StatRow => ({ ...e, dimension, topicKey, questionTopicId: null, label: topicKey });

describe("computeMastery", () => {
  it("returns null without graded evidence", () => {
    expect(computeMastery([])).toBeNull();
    expect(computeMastery([ev(1, 0, 0)])).toBeNull();
    expect(computeMastery([ev(1, 0, 4, { pendingCount: 4 })])).toBeNull();
  });

  it("shrinks a single lucky question toward the prior and marks it insufficient", () => {
    const m = computeMastery([ev(1, 1, 1)], 0.6)!;
    // (1·1 + 2·0.6) / (1 + 2) = 73.3
    expect(m.mastery).toBe(73.3);
    expect(m.rawPct).toBe(100);
    expect(m.status).toBe("INSUFFICIENT");
    expect(m.trend).toBe("NEW");
  });

  it("weighs the newest result most", () => {
    const improving = computeMastery([ev(1, 0, 5), ev(2, 5, 5)], 0.5)!;
    const declining = computeMastery([ev(1, 5, 5), ev(2, 0, 5)], 0.5)!;
    expect(improving.rawPct).toBe(declining.rawPct);
    expect(improving.mastery).toBeGreaterThan(declining.mastery);
    expect(improving.trend).toBe("UP");
    expect(declining.trend).toBe("DOWN");
    expect(declining.status).toBe("CRITICAL");
  });

  it("counts retakes and practice at 0.75 of an exam", () => {
    const exam = computeMastery([ev(1, 5, 10), ev(2, 10, 10)], 0.5)!;
    const retake = computeMastery([ev(1, 5, 10), ev(2, 10, 10, { origin: "RETAKE" })], 0.5)!;
    expect(retake.mastery).toBeLessThan(exam.mastery);
    expect(retake.mastery).toBeGreaterThan(50);
  });

  it("ignores pending questions in the evidence count", () => {
    const m = computeMastery([ev(1, 2, 2, { questionCount: 5, pendingCount: 3 })])!;
    expect(m.evidenceCount).toBe(2);
    expect(m.examCount).toBe(1);
  });
});

describe("status, trend and prior", () => {
  it("uses fixed thresholds and needs three graded questions", () => {
    expect(statusOf(90, 2)).toBe("INSUFFICIENT");
    expect(statusOf(75, 3)).toBe("STRONG");
    expect(statusOf(74.9, 3)).toBe("REVIEW");
    expect(statusOf(50, 3)).toBe("REVIEW");
    expect(statusOf(49.9, 3)).toBe("CRITICAL");
  });

  it("compares the last result with the mean of the two before it", () => {
    expect(trendOf([ev(3, 8, 10), ev(2, 6, 10), ev(1, 8, 10)])).toEqual({ trend: "UP", trendDelta: 10 });
    expect(trendOf([ev(3, 7, 10), ev(2, 6, 10), ev(1, 8, 10)])).toEqual({ trend: "FLAT", trendDelta: 0 });
    expect(trendOf([ev(1, 7, 10)])).toEqual({ trend: "NEW", trendDelta: null });
  });

  it("falls back to 0.6 until the student has five graded questions", () => {
    expect(priorOf([ev(1, 4, 4)])).toBe(0.6);
    expect(priorOf([ev(1, 2, 4), ev(2, 2, 4)])).toBe(0.5);
  });
});

describe("masteryRows and topGains", () => {
  const stats: StatRow[] = [
    stat("qt:frac", ev(1, 1, 6)),
    stat("qt:frac", ev(2, 2, 6)),
    stat("qt:pct", ev(1, 4, 4)),
    stat("qt:pct", ev(2, 3, 4)),
    stat("qt:geo", ev(2, 1, 2)),
    stat("", ev(2, 2, 2)),
    stat("sk:calc", ev(2, 1, 3), "SKILL"),
  ];

  it("builds a row per topic and skill and leaves the untagged bucket out", () => {
    const rows = masteryRows(stats);
    expect(rows.map((r) => `${r.dimension}:${r.topicKey}`).sort()).toEqual(["SKILL:sk:calc", "TOPIC:qt:frac", "TOPIC:qt:geo", "TOPIC:qt:pct"]);
    const frac = rows.find((r) => r.topicKey === "qt:frac")!;
    expect(frac.status).toBe("CRITICAL");
    expect(rows.find((r) => r.topicKey === "qt:pct")!.status).toBe("STRONG");
  });

  it("ranks the topic with the biggest share and gap first, and skips strong topics", () => {
    const rows = masteryRows(stats);
    const gains = topGains(rows, stats);
    expect(gains[0].topicKey).toBe("qt:frac");
    expect(gains.find((g) => g.topicKey === "qt:pct")).toBeUndefined();
    expect(gains.find((g) => g.topicKey === "qt:geo")?.gain ?? 0).toBeLessThan(gains[0].gain);
    expect(gains.length).toBeLessThanOrEqual(3);
  });

  it("has a feasibility floor for very low mastery", () => {
    expect(feasibility(0)).toBe(0.7);
    expect(feasibility(0.4)).toBe(1);
    expect(feasibility(0.9)).toBe(1);
  });
});

describe("group summary and history", () => {
  it("puts the most widespread critical topic first", () => {
    const topics = summarizeGroupTopics([
      { studentId: 1, topicKey: "a", label: "A", mastery: 40, status: "CRITICAL" },
      { studentId: 2, topicKey: "a", label: "A", mastery: 45, status: "CRITICAL" },
      { studentId: 1, topicKey: "b", label: "B", mastery: 30, status: "CRITICAL" },
      { studentId: 2, topicKey: "b", label: "B", mastery: 90, status: "STRONG" },
      { studentId: 1, topicKey: "c", label: "C", mastery: 60, status: "REVIEW" },
    ]);
    expect(topics.map((t) => t.topicKey)).toEqual(["a", "b", "c"]);
    expect(topics[0]).toMatchObject({ studentCount: 2, avgMastery: 42.5, critical: 2 });
  });

  it("keeps the last results per topic in time order", () => {
    const h = topicHistory([stat("qt:x", ev(3, 1, 2)), stat("qt:x", ev(1, 2, 2)), stat("qt:x", ev(2, 0, 2)), stat("", ev(2, 1, 1))], 2);
    expect(h.get("qt:x")).toEqual([{ at: day(2), pct: 0 }, { at: day(3), pct: 50 }]);
    expect(h.has("")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { envEnablesGrowth } from "./growth/availability";
import { bakuHour, dailyDue } from "./growth/jobs";
import { buildCatalog, buildTopicStats, originOf, resolveSkill, resolveTopic, topicNameKey, type ResolvedTopic } from "./growth/topics";

const catalog = buildCatalog(
  [
    { id: "s1", name: "Kəsrlər", parentName: "Riyaziyyat 5" },
    { id: "s2", name: "Kəsrlər", parentName: "Riyaziyyat 6" },
    { id: "s3", name: "Faizlər", parentName: "Riyaziyyat 6" },
  ],
  [
    { aliasKey: topicNameKey("faiz"), label: "Faiz", questionTopicId: "s3" },
    { aliasKey: topicNameKey("Həndəsə əsasları"), label: "Həndəsə", questionTopicId: null },
  ],
);

describe("resolveTopic", () => {
  it("prefers the section the source question is filed in now, even if the frozen text is old", () => {
    expect(resolveTopic({ filedSectionId: "s1", frozenTopic: "Köhnə ad" }, catalog)).toEqual({ topicKey: "qt:s1", questionTopicId: "s1", label: "Riyaziyyat 5 / Kəsrlər" });
  });

  it("uses a teacher alias to a section before name matching", () => {
    expect(resolveTopic({ filedSectionId: null, frozenTopic: "FAİZ" }, catalog)?.topicKey).toBe("qt:s3");
  });

  it("keeps an alias without a section as a labelled text topic", () => {
    expect(resolveTopic({ filedSectionId: null, frozenTopic: "Həndəsə  əsasları" }, catalog)).toEqual({ topicKey: `tx:${topicNameKey("Həndəsə əsasları")}`, questionTopicId: null, label: "Həndəsə" });
  });

  it("matches a section by name only when exactly one section has that name", () => {
    expect(resolveTopic({ filedSectionId: null, frozenTopic: "faizler" }, catalog)?.topicKey).toBe("qt:s3");
    // Two subjects have "Kəsrlər": ambiguous, so it stays a text topic instead of guessing.
    expect(resolveTopic({ filedSectionId: null, frozenTopic: "Kəsrlər" }, catalog)?.topicKey).toBe(`tx:${topicNameKey("Kəsrlər")}`);
  });

  it("falls back to text, and returns null for an empty topic", () => {
    expect(resolveTopic({ filedSectionId: "missing", frozenTopic: " Tənliklər " }, catalog)).toEqual({ topicKey: `tx:${topicNameKey("Tənliklər")}`, questionTopicId: null, label: "Tənliklər" });
    expect(resolveTopic({ filedSectionId: null, frozenTopic: "  " }, catalog)).toBeNull();
  });

  it("normalizes Azerbaijani letters and punctuation in keys", () => {
    expect(topicNameKey("Kəsrlər!")).toBe(topicNameKey("kesrler"));
    expect(resolveSkill("Problem həlli")?.topicKey).toBe(`sk:${topicNameKey("problem helli")}`);
    expect(resolveSkill("")).toBeNull();
  });
});

describe("buildTopicStats", () => {
  const frac: ResolvedTopic = { topicKey: "qt:s1", questionTopicId: "s1", label: "Kəsrlər" };
  const pct: ResolvedTopic = { topicKey: "qt:s3", questionTopicId: "s3", label: "Faizlər" };

  it("sums per topic with partial credit, keeps pending items out of the points, and counts untagged items", () => {
    const rows = buildTopicStats([
      { status: "CORRECT", earned: 2, points: 2, topic: frac, skill: null },
      { status: "WRONG", earned: 0, points: 2, topic: frac, skill: null },
      { status: "WRONG", earned: 0.5, points: 1, topic: frac, skill: resolveSkill("Hesablama") },
      { status: "UNANSWERED", earned: 0, points: 1, topic: pct, skill: null },
      { status: "PENDING_REVIEW", earned: 0, points: 5, topic: pct, skill: null },
      { status: "CORRECT", earned: 1, points: 1, topic: null, skill: null },
    ]);
    const f = rows.find((r) => r.topicKey === "qt:s1")!;
    expect(f).toMatchObject({ dimension: "TOPIC", questionCount: 3, correctCount: 1, wrongCount: 2, earned: 2.5, possible: 5, wrongPoints: 3 });
    const p = rows.find((r) => r.topicKey === "qt:s3")!;
    expect(p).toMatchObject({ questionCount: 2, unansweredCount: 1, pendingCount: 1, earned: 0, possible: 1, wrongPoints: 0 });
    expect(rows.find((r) => r.topicKey === "")).toMatchObject({ questionCount: 1, earned: 1 });
    expect(rows.filter((r) => r.dimension === "SKILL")).toHaveLength(1);
  });

  it("never gives more than the question's points or less than zero", () => {
    const [row] = buildTopicStats([{ status: "CORRECT", earned: 9, points: 2, topic: frac, skill: null }, { status: "WRONG", earned: -1, points: 2, topic: frac, skill: null }]);
    expect(row.earned).toBe(2);
    expect(row.possible).toBe(4);
  });

  it("maps assessment origins, defaulting to a regular exam", () => {
    expect(originOf("RETAKE")).toBe("RETAKE");
    expect(originOf("PRACTICE")).toBe("PRACTICE");
    expect(originOf(undefined)).toBe("EXAM");
    expect(originOf("weird")).toBe("EXAM");
  });
});

describe("growth jobs schedule and flag", () => {
  it("runs the daily pass once per Baku day after 03:00", () => {
    const early = new Date("2026-10-10T22:30:00Z"); // 02:30 Baku on the 11th
    const late = new Date("2026-10-10T23:30:00Z"); // 03:30 Baku on the 11th
    expect(bakuHour(early)).toBe(2);
    expect(dailyDue(early, null)).toBe(false);
    expect(dailyDue(late, null)).toBe(true);
    expect(dailyDue(late, "2026-10-11")).toBe(false);
  });

  it("enables workspaces from the env list or a star", () => {
    expect(envEnablesGrowth("w1", ["w1", "w2"])).toBe(true);
    expect(envEnablesGrowth("w3", ["w1"])).toBe(false);
    expect(envEnablesGrowth("w3", ["*"])).toBe(true);
    expect(envEnablesGrowth("w3", [])).toBe(false);
  });
});

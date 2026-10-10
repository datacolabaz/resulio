import { describe, expect, it } from "vitest";
import type { MasteryStatus } from "../shared/growth";
import type { StatRow } from "./growth/mastery";
import { levelUps, syncReleasedXp, type ReleasedXpDeps } from "./growth/releasedXp";
import { XP } from "./growth/xp";

const stat = (resultId: string, day: number, earned: number, possible = 10): StatRow => ({
  resultId,
  dimension: "TOPIC",
  topicKey: "qt:frac",
  questionTopicId: "frac",
  label: "Kəsrlər",
  origin: "EXAM",
  completedAt: new Date(Date.UTC(2026, 9, day)),
  questionCount: possible,
  pendingCount: 0,
  earned,
  possible,
  wrongPoints: possible - earned,
});

/** In-memory stand-in for the database: a ledger unique by refKey, like `xp_events`. */
function fakeWorld() {
  const stats: StatRow[] = [];
  const released = new Set<string>();
  const levels = new Map<string, MasteryStatus>();
  const ledger = new Map<string, { type: string; points: number }>();
  const practice = new Map<string, { assessmentId: string; percentage: number }>();
  const deps: ReleasedXpDeps = {
    stats: async () => stats,
    releasedIds: async () => new Set(released),
    seenLevels: async () => new Map(levels),
    saveLevels: async (_w, _s, rows) => {
      for (const r of rows) levels.set(r.topicKey, r.status);
    },
    goodPractice: async (_w, _s, ids) => ids.flatMap((id) => (practice.has(id) && practice.get(id)!.percentage >= XP.PRACTICE_GOOD_AT ? [practice.get(id)!.assessmentId] : [])),
    award: async (input) => {
      if (input.points <= 0 || ledger.has(input.refKey)) return false;
      ledger.set(input.refKey, { type: input.type, points: input.points });
      return true;
    },
  };
  const sync = () => syncReleasedXp("ws1", 42, deps);
  const total = () => [...ledger.values()].reduce((s, e) => s + e.points, 0);
  return { stats, released, levels, ledger, practice, sync, total };
}

describe("level-up XP from released results only", () => {
  it("a first sight of a topic earns nothing; only steps up count", () => {
    expect(levelUps(new Map(), [{ topicKey: "a", status: "STRONG" }])).toEqual([]);
    expect(levelUps(new Map([["a", "CRITICAL" as const]]), [{ topicKey: "a", status: "REVIEW" }])).toEqual([{ topicKey: "a", status: "REVIEW", points: XP.CRITICAL_TO_REVIEW }]);
    expect(levelUps(new Map([["a", "STRONG" as const]]), [{ topicKey: "a", status: "REVIEW" }])).toEqual([]);
  });

  it("an unreleased result that would raise the level grants no XP; after release it is granted once", async () => {
    const w = fakeWorld();
    w.stats.push(stat("r1", 1, 2));
    w.released.add("r1");
    await w.sync();
    expect(w.levels.get("qt:frac")).toBe("CRITICAL");
    expect(w.total()).toBe(0);

    // A strong second exam, graded but not released yet: with it the topic would be REVIEW.
    w.stats.push(stat("r2", 5, 10));
    await w.sync();
    await w.sync();
    expect(w.levels.get("qt:frac")).toBe("CRITICAL");
    expect(w.ledger.size).toBe(0);

    w.released.add("r2");
    await w.sync();
    expect(w.levels.get("qt:frac")).toBe("REVIEW");
    expect([...w.ledger.entries()]).toEqual([["status:ws1:qt:frac:REVIEW", { type: "STATUS_UP", points: XP.CRITICAL_TO_REVIEW }]]);

    await w.sync();
    w.levels.set("qt:frac", "CRITICAL");
    await w.sync();
    expect(w.ledger.size).toBe(1);
    expect(w.total()).toBe(XP.CRITICAL_TO_REVIEW);
  });

  it("the practice bonus for 70%+ waits for the released result", async () => {
    const w = fakeWorld();
    w.practice.set("pr1", { assessmentId: "as1", percentage: 90 });
    w.practice.set("pr2", { assessmentId: "as2", percentage: 50 });
    await w.sync();
    expect(w.ledger.size).toBe(0);

    w.released.add("pr1");
    w.released.add("pr2");
    await w.sync();
    await w.sync();
    expect([...w.ledger.keys()]).toEqual(["practice-good:as1"]);
    expect(w.total()).toBe(XP.PRACTICE_GOOD_BONUS);
  });
});

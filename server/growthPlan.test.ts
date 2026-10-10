import { describe, expect, it } from "vitest";
import { addDays, buildPlan, daysBetween, MINUTES, planTarget, planTopics, rollover, type PlanTopic } from "./growth/plan";
import { weekStart } from "./growth/planStore";
import { levelOf, levelProgress, nextStreak, statusUpXp, xpForLevel } from "./growth/xp";

const topic = (key: string, status: PlanTopic["status"], gain: number, mastery = 40): PlanTopic => ({ topicKey: key, label: key.toUpperCase(), mastery, status, gain });

describe("plan target date", () => {
  const today = "2026-10-10";
  it("prefers the nearest assigned exam, then the profile date, then two weeks", () => {
    expect(planTarget(today, "2026-10-20", "2026-11-01")).toEqual({ targetDay: "2026-10-20", source: "EXAM" });
    expect(planTarget(today, null, "2026-11-01")).toEqual({ targetDay: "2026-11-01", source: "TARGET_DATE" });
    expect(planTarget(today, null, null)).toEqual({ targetDay: "2026-10-24", source: "DEFAULT" });
  });

  it("ignores past dates and caps far ones at six weeks", () => {
    expect(planTarget(today, "2026-10-10", "2026-10-01").source).toBe("DEFAULT");
    expect(planTarget(today, "2027-03-01", null)).toEqual({ targetDay: addDays(today, 42), source: "EXAM" });
  });

  it("does day arithmetic on calendar days", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-10-10", "2026-10-24")).toBe(14);
  });
});

describe("buildPlan", () => {
  const today = "2026-10-10";
  const topics = [topic("a", "CRITICAL", 20, 30), topic("b", "REVIEW", 10, 60), topic("c", "STRONG", 0, 90), topic("d", "INSUFFICIENT", 0, 40)];

  it("plans only priority and review topics, highest gain first", () => {
    expect(planTopics(topics).map((t) => t.topicKey)).toEqual(["a", "b"]);
  });

  it("schedules material, practice, then reviews 3 and 7 days later", () => {
    const items = buildPlan({ today, targetDay: "2026-10-24", dailyMinutes: 60, topics });
    const a = items.filter((i) => i.topicKey === "a");
    expect(a[0]).toMatchObject({ dayKey: today, kind: "MATERIAL", minutes: MINUTES.MATERIAL });
    expect(a[1]).toMatchObject({ dayKey: today, kind: "PRACTICE" });
    expect(a.filter((i) => i.kind === "REVIEW").map((i) => i.dayKey)).toEqual(expect.arrayContaining([addDays(today, 3), addDays(today, 7)]));
    expect(items.some((i) => i.topicKey === "c" || i.topicKey === "d")).toBe(false);
  });

  it("never exceeds the daily minutes, and keeps the last two days for review", () => {
    const items = buildPlan({ today, targetDay: "2026-10-24", dailyMinutes: 30, topics: [topic("a", "CRITICAL", 30), topic("b", "CRITICAL", 20), topic("e", "REVIEW", 10)] });
    const perDay = new Map<string, number>();
    for (const i of items) perDay.set(i.dayKey, (perDay.get(i.dayKey) ?? 0) + i.minutes);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(30);
    const lastTwo = [addDays("2026-10-24", -1), addDays("2026-10-24", -2)];
    expect(items.filter((i) => lastTwo.includes(i.dayKey)).every((i) => i.kind === "REVIEW")).toBe(true);
    expect(items.every((i) => i.dayKey < "2026-10-24")).toBe(true);
  });

  it("gives a priority topic a second cycle when the plan is long", () => {
    const items = buildPlan({ today, targetDay: "2026-10-31", dailyMinutes: 60, topics: [topic("a", "CRITICAL", 20)] });
    expect(items.filter((i) => i.kind === "MATERIAL")).toHaveLength(2);
  });

  it("still plans a day when the target is tomorrow", () => {
    const items = buildPlan({ today, targetDay: "2026-10-11", dailyMinutes: 60, topics: [topic("a", "CRITICAL", 20)] });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.dayKey === today)).toBe(true);
  });
});

describe("rollover", () => {
  it("moves past items to the first day with room and skips them after three moves", () => {
    const { moves, skips } = rollover(
      [
        { id: "1", dayKey: "2026-10-08", minutes: 20, rolloverCount: 0 },
        { id: "2", dayKey: "2026-10-09", minutes: 20, rolloverCount: 3 },
        { id: "3", dayKey: "2026-10-12", minutes: 10, rolloverCount: 0 },
      ],
      [{ dayKey: "2026-10-10", minutes: 20 }],
      "2026-10-10",
      "2026-10-20",
      30,
    );
    expect(moves).toEqual([{ id: "1", dayKey: "2026-10-11", rolloverCount: 1 }]);
    expect(skips).toEqual(["2"]);
  });
});

describe("xp", () => {
  it("levels by the square root of XP over 50", () => {
    expect(levelOf(0)).toBe(0);
    expect(levelOf(49)).toBe(0);
    expect(levelOf(50)).toBe(1);
    expect(levelOf(199)).toBe(1);
    expect(levelOf(200)).toBe(2);
    expect(xpForLevel(3)).toBe(450);
    expect(levelProgress(125)).toEqual({ level: 1, xp: 125, from: 50, to: 200, pct: 50 });
  });

  it("rewards only upward moves", () => {
    expect(statusUpXp("CRITICAL", "REVIEW")).toBe(30);
    expect(statusUpXp("REVIEW", "STRONG")).toBe(50);
    expect(statusUpXp("CRITICAL", "STRONG")).toBe(80);
    expect(statusUpXp("STRONG", "REVIEW")).toBe(0);
    expect(statusUpXp(null, "STRONG")).toBe(0);
  });

  it("extends a streak on consecutive days and restarts after a gap", () => {
    const start = { streak: 0, longestStreak: 0, lastActiveDay: null };
    const d1 = nextStreak(start, "2026-10-10");
    expect(d1).toMatchObject({ streak: 1, extended: true });
    expect(nextStreak(d1, "2026-10-10")).toMatchObject({ streak: 1, extended: false });
    const d2 = nextStreak(d1, "2026-10-11");
    expect(d2).toMatchObject({ streak: 2, longestStreak: 2 });
    expect(nextStreak(d2, "2026-10-14")).toMatchObject({ streak: 1, longestStreak: 2 });
  });

  it("finds the Monday of a plan week", () => {
    expect(weekStart("2026-10-10")).toBe("2026-10-05");
    expect(weekStart("2026-10-05")).toBe("2026-10-05");
    expect(weekStart("2026-10-11")).toBe("2026-10-05");
  });
});

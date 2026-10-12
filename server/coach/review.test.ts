import { describe, expect, it } from "vitest";
import { MAX_INTERVAL_DAYS, nextReview, overdueDays, sortDue } from "./review";

const now = new Date(Date.UTC(2026, 9, 12, 8));
const DAY = 86_400_000;

describe("spaced review", () => {
  const next = (percentage: number | null, previousInterval: number, status: "STRONG" | "REVIEW" | "CRITICAL" | "INSUFFICIENT" = "REVIEW") =>
    nextReview({ percentage, mastery: 60, status, previousInterval, now });

  it("brings weak results back tomorrow", () => {
    expect(next(30, 20).intervalDays).toBe(1);
    expect(next(30, 20).nextReviewAt).toEqual(new Date(now.getTime() + DAY));
  });

  it("starts at 2-3 days and grows with good results", () => {
    expect(next(60, 0).intervalDays).toBe(2);
    expect(next(90, 0).intervalDays).toBe(3);
    expect(next(90, 3).intervalDays).toBe(7);
    expect(next(90, 7).intervalDays).toBe(15);
    expect(next(60, 10).intervalDays).toBe(12);
  });

  it("gives strong topics a little extra and caps the interval", () => {
    expect(next(90, 7, "STRONG").intervalDays).toBe(19);
    expect(next(100, 50, "STRONG").intervalDays).toBe(MAX_INTERVAL_DAYS);
  });

  it("keeps the schedule when nothing was graded yet", () => {
    expect(next(null, 0)).toEqual({ intervalDays: 0, nextReviewAt: null });
    expect(next(null, 4).intervalDays).toBe(4);
  });

  it("counts overdue days and sorts the most overdue, then the weakest, first", () => {
    expect(overdueDays(null, now)).toBe(0);
    expect(overdueDays(new Date(now.getTime() + DAY), now)).toBe(0);
    expect(overdueDays(new Date(now.getTime() - 3.5 * DAY), now)).toBe(3);
    const rows = [
      { id: "a", nextReviewAt: new Date(now.getTime() - DAY), mastery: 80 },
      { id: "b", nextReviewAt: new Date(now.getTime() - 5 * DAY), mastery: 90 },
      { id: "c", nextReviewAt: new Date(now.getTime() - DAY), mastery: 30 },
    ];
    expect(sortDue(rows).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
});

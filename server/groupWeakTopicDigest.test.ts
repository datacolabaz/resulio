import { describe, expect, it } from "vitest";
import { digestTopicsOf } from "./modules/groupWeakTopicDigest";

/**
 * `digestTopicsOf` decides which of a group's WEAK topics make it into the GROUP_WEAK_TOPIC_DIGEST
 * notification: weakest first, capped at 5 named, and -- mirroring `rankableQuestion`'s
 * minimum-sample guard -- a topic seen on too few answered questions is noise, not a signal, and
 * is left out entirely rather than alarming the teacher over one bad guess.
 */
describe("digestTopicsOf", () => {
  const t = (topic: string, questionCount: number, accuracyPercentage: number) => ({ topic, questionCount, accuracyPercentage });

  it("drops topics under the minimum sample", () => {
    expect(digestTopicsOf([t("Cəbr", 2, 0)], 5)).toEqual({ count: 0, topics: [] });
    expect(digestTopicsOf([t("Cəbr", 5, 40)], 5)).toEqual({ count: 1, topics: ["Cəbr"] });
  });

  it("orders weakest (lowest accuracy) first", () => {
    const r = digestTopicsOf([t("A", 10, 55), t("B", 10, 20), t("C", 10, 45)], 5);
    expect(r).toEqual({ count: 3, topics: ["B", "C", "A"] });
  });

  it("caps named topics at 5 but keeps the true count", () => {
    const topics = Array.from({ length: 8 }, (_, i) => t(`T${i}`, 10, i));
    const r = digestTopicsOf(topics, 5);
    expect(r.count).toBe(8);
    expect(r.topics).toEqual(["T0", "T1", "T2", "T3", "T4"]);
  });

  it("returns nothing when there are no weak topics", () => {
    expect(digestTopicsOf([], 5)).toEqual({ count: 0, topics: [] });
  });

  it("respects a custom minimum sample", () => {
    expect(digestTopicsOf([t("A", 2, 10)], 2)).toEqual({ count: 1, topics: ["A"] });
    expect(digestTopicsOf([t("A", 1, 10)], 2)).toEqual({ count: 0, topics: [] });
  });
});

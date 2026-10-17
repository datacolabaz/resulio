import { describe, expect, it } from "vitest";
import {
  daysUntilProviderDeletion,
  derivedLessonStatus,
  occurrenceStarts,
  recordingRetentionExpired,
  recurrenceNeedsUntil,
  withinJoinWindow,
  zoomRecordFileKind,
} from "../../shared/lessonIntegration";

describe("recurrenceNeedsUntil", () => {
  it("is false for ONCE and true for recurring patterns", () => {
    expect(recurrenceNeedsUntil("ONCE")).toBe(false);
    expect(recurrenceNeedsUntil("WEEKLY")).toBe(true);
    expect(recurrenceNeedsUntil("BIWEEKLY")).toBe(true);
  });
});

describe("occurrenceStarts", () => {
  const start = new Date("2026-10-19T10:00:00Z"); // Monday

  it("ONCE yields exactly the start time, ignoring `until`", () => {
    expect(occurrenceStarts(start, "ONCE", new Date("2026-12-01T00:00:00Z"))).toEqual([start]);
  });

  it("WEEKLY steps by 7 days up to and including `until`", () => {
    const until = new Date("2026-11-02T10:00:00Z"); // 3rd Monday after start
    const dates = occurrenceStarts(start, "WEEKLY", until);
    expect(dates).toHaveLength(3);
    expect(dates[1].getTime() - dates[0].getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(dates.at(-1)!.getTime()).toBeLessThanOrEqual(until.getTime());
  });

  it("BIWEEKLY steps by 14 days", () => {
    const until = new Date("2026-11-16T10:00:00Z");
    const dates = occurrenceStarts(start, "BIWEEKLY", until);
    expect(dates.every((_, i) => i === 0 || dates[i].getTime() - dates[i - 1].getTime() === 14 * 24 * 60 * 60 * 1000)).toBe(true);
  });

  it("respects the safety limit so a missing/huge `until` can never generate unbounded rows", () => {
    const farUntil = new Date("2099-01-01T00:00:00Z");
    expect(occurrenceStarts(start, "WEEKLY", farUntil, 5)).toHaveLength(5);
  });

  it("a null `until` on a recurring pattern falls back to a single occurrence rather than looping forever", () => {
    expect(occurrenceStarts(start, "WEEKLY", null)).toEqual([start]);
  });
});

describe("withinJoinWindow", () => {
  const base = { startsAt: new Date("2026-10-19T10:00:00Z"), endsAt: new Date("2026-10-19T11:00:00Z"), joinWindowBeforeMin: 10, joinWindowAfterMin: 30 };

  it("closed well before the window opens", () => {
    expect(withinJoinWindow({ ...base, status: "SCHEDULED" }, new Date("2026-10-19T09:00:00Z"))).toBe(false);
  });

  it("opens joinWindowBeforeMin minutes before the start", () => {
    expect(withinJoinWindow({ ...base, status: "SCHEDULED" }, new Date("2026-10-19T09:50:00Z"))).toBe(true);
    expect(withinJoinWindow({ ...base, status: "SCHEDULED" }, new Date("2026-10-19T09:49:59Z"))).toBe(false);
  });

  it("stays open through the lesson and the after-grace period", () => {
    expect(withinJoinWindow({ ...base, status: "LIVE" }, new Date("2026-10-19T10:30:00Z"))).toBe(true);
    expect(withinJoinWindow({ ...base, status: "ENDED" }, new Date("2026-10-19T11:29:59Z"))).toBe(true);
  });

  it("closes joinWindowAfterMin minutes after the end", () => {
    expect(withinJoinWindow({ ...base, status: "ENDED" }, new Date("2026-10-19T11:30:01Z"))).toBe(false);
  });

  it("a cancelled lesson is never joinable, even inside the time window", () => {
    expect(withinJoinWindow({ ...base, status: "CANCELLED" }, new Date("2026-10-19T10:30:00Z"))).toBe(false);
  });
});

describe("derivedLessonStatus", () => {
  const lesson = { startsAt: new Date("2026-10-19T10:00:00Z"), endsAt: new Date("2026-10-19T11:00:00Z") };

  it("SCHEDULED before start, LIVE during, ENDED after", () => {
    expect(derivedLessonStatus(lesson, new Date("2026-10-19T09:00:00Z"))).toBe("SCHEDULED");
    expect(derivedLessonStatus(lesson, new Date("2026-10-19T10:30:00Z"))).toBe("LIVE");
    expect(derivedLessonStatus(lesson, new Date("2026-10-19T12:00:00Z"))).toBe("ENDED");
  });
});

describe("daysUntilProviderDeletion", () => {
  it("is null for Zoom (no fixed Resulio-tracked retention clock)", () => {
    expect(daysUntilProviderDeletion("ZOOM", new Date("2026-10-19T11:00:00Z"), new Date("2026-10-20T11:00:00Z"))).toBeNull();
  });

  it("counts down from 30 days after the lesson ended for Google Meet", () => {
    const endedAt = new Date("2026-10-19T11:00:00Z");
    expect(daysUntilProviderDeletion("GOOGLE_MEET", endedAt, endedAt)).toBe(30);
    expect(daysUntilProviderDeletion("GOOGLE_MEET", endedAt, new Date("2026-11-17T11:00:00Z"))).toBe(1);
    // Past the provider's own deletion point: negative, signalling the rescue window already closed.
    expect(daysUntilProviderDeletion("GOOGLE_MEET", endedAt, new Date("2026-11-20T11:00:00Z"))).toBeLessThan(0);
  });
});

describe("recordingRetentionExpired", () => {
  const endedAt = new Date("2026-10-19T11:00:00Z");

  it("is never expired for Zoom, which has no Resulio-tracked retention clock", () => {
    expect(recordingRetentionExpired("ZOOM", endedAt, new Date("2030-01-01T00:00:00Z"))).toBe(false);
  });

  it("is false for Google Meet before the 30-day mark and true after it", () => {
    expect(recordingRetentionExpired("GOOGLE_MEET", endedAt, new Date("2026-11-17T11:00:00Z"))).toBe(false);
    expect(recordingRetentionExpired("GOOGLE_MEET", endedAt, new Date("2026-11-20T11:00:00Z"))).toBe(true);
  });
});

describe("zoomRecordFileKind", () => {
  it("maps the Zoom recording file types Resulio rescues", () => {
    expect(zoomRecordFileKind("MP4")).toBe("RECORDING");
    expect(zoomRecordFileKind("TRANSCRIPT")).toBe("TRANSCRIPT");
    expect(zoomRecordFileKind("CHAT")).toBe("CHAT_LOG");
    expect(zoomRecordFileKind("SUMMARY")).toBe("AI_SUMMARY");
  });

  it("is case-insensitive", () => {
    expect(zoomRecordFileKind("mp4")).toBe("RECORDING");
  });

  it("is null for file types Resulio doesn't keep a copy of", () => {
    expect(zoomRecordFileKind("M4A")).toBeNull();
    expect(zoomRecordFileKind("CC")).toBeNull();
    expect(zoomRecordFileKind("TIMELINE")).toBeNull();
  });
});

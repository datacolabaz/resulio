import { describe, expect, it } from "vitest";
import { RETENTION_DAYS } from "../../shared/coach";
import { EVENT_RETENTION_DAYS, isIdle, retentionCutoffs } from "./retention";
import { dedupeTargets, pickSummary } from "./shares";

const DAY = 86_400_000;
const now = new Date(Date.UTC(2026, 9, 12, 8));

describe("share targets", () => {
  const row = (teacherId: number, workspaceId: string, displayName: string, ownerName: string | null, title = "") => ({ teacherId, workspaceId, displayName, title, ownerName });

  it("lists each teacher workspace once even when the student is in several of its groups", () => {
    const out = dedupeTargets([row(7, "w1", "Riyaziyyat kursu", "Aynur"), row(7, "w1", "Riyaziyyat kursu", "Aynur"), row(9, "w2", "", "Elvin", "Fizika")]);
    expect(out.map((t) => [t.teacherId, t.workspaceId])).toEqual([
      [7, "w1"],
      [9, "w2"],
    ]);
  });

  it("names the target by owner and workspace without repeating identical names", () => {
    const [a, b, c] = dedupeTargets([row(1, "a", "Aynur", "Aynur"), row(2, "b", "Kimya", "Bəhruz"), row(3, "c", "  ", null, "Tarix")]);
    expect(a.name).toBe("Aynur");
    expect(b.name).toBe("Bəhruz · Kimya");
    expect(c.name).toBe("Tarix");
  });

  it("keeps the same teacher's separate workspaces apart", () => {
    expect(dedupeTargets([row(5, "x", "A", "T"), row(5, "y", "B", "T")])).toHaveLength(2);
  });
});

describe("teacher summary pick", () => {
  const s = (kind: string, locale: string) => ({ kind, locale });

  it("prefers the teacher's language, then the short summary", () => {
    expect(pickSummary([s("SUMMARY_DETAILED", "az"), s("SUMMARY_SHORT", "ru"), s("SUMMARY_EXAM", "az")], "az")).toEqual(s("SUMMARY_DETAILED", "az"));
    expect(pickSummary([s("SUMMARY_DETAILED", "az"), s("SUMMARY_SHORT", "az")], "az")).toEqual(s("SUMMARY_SHORT", "az"));
  });

  it("falls back to another language rather than nothing", () => {
    expect(pickSummary([s("SUMMARY_EXAM", "ru")], "en")).toEqual(s("SUMMARY_EXAM", "ru"));
  });

  it("never exposes non-summary artifacts", () => {
    expect(pickSummary([s("CONCEPTS", "az"), s("FLASHCARDS", "az")], "az")).toBeNull();
  });
});

describe("retention", () => {
  it("computes cutoffs from the documented windows", () => {
    const c = retentionCutoffs(now);
    expect(now.getTime() - c.messages.getTime()).toBe(RETENTION_DAYS.tutorMessages * DAY);
    expect(now.getTime() - c.failed.getTime()).toBe(RETENTION_DAYS.failedMaterials * DAY);
    expect(now.getTime() - c.idle.getTime()).toBe(RETENTION_DAYS.idleMaterials * DAY);
    expect(now.getTime() - c.events.getTime()).toBe(EVENT_RETENTION_DAYS * DAY);
  });

  it("keeps events long enough to cover the current and previous quota month", () => {
    expect(EVENT_RETENTION_DAYS).toBeGreaterThan(366);
  });

  it("treats a material as idle by last open, or by creation when never opened", () => {
    const cutoff = retentionCutoffs(now).idle;
    const old = new Date(cutoff.getTime() - DAY);
    const recent = new Date(cutoff.getTime() + DAY);
    expect(isIdle({ lastOpenedAt: null, createdAt: old }, cutoff)).toBe(true);
    expect(isIdle({ lastOpenedAt: recent, createdAt: old }, cutoff)).toBe(false);
    expect(isIdle({ lastOpenedAt: null, createdAt: recent }, cutoff)).toBe(false);
  });
});

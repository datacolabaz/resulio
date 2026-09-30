import { describe, expect, it } from "vitest";
import type { attempts } from "../drizzle/schema";
import { INACTIVITY_THRESHOLDS } from "../shared/assessment";
import { buildParticipants, summarize } from "./modules/activity";
import { countsTowardLimit, isInactive, participantState, throttleElapsed } from "./modules/engine";

type AttemptRow = typeof attempts.$inferSelect;

const NOW = new Date("2026-09-29T10:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const minutesFromNow = (m: number) => new Date(NOW.getTime() + m * 60_000);

function attempt(over: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: "t1",
    assessmentId: "a1",
    versionId: "v1",
    assignmentId: 1,
    studentId: 1,
    attemptNo: 1,
    status: "IN_PROGRESS",
    questionOrder: ["q1", "q2", "q3", "q4"],
    startedAt: minutesAgo(20),
    deadlineAt: minutesFromNow(40),
    submittedAt: null,
    lastActivityAt: minutesAgo(1),
    lastAutosaveAt: null,
    lastHeartbeatAt: null,
    answeredCount: 2,
    totalQuestionCount: 4,
    autoSubmittedAt: null,
    voidedBy: null,
    voidedAt: null,
    ...over,
  };
}

describe("inactivity (derived, never stored)", () => {
  it.each(INACTIVITY_THRESHOLDS)("flags an open session idle for %i minutes", (threshold) => {
    expect(isInactive(attempt({ lastActivityAt: minutesAgo(threshold - 1) }), threshold, NOW)).toBe(false);
    expect(isInactive(attempt({ lastActivityAt: minutesAgo(threshold) }), threshold, NOW)).toBe(true);
  });

  it("is off when the teacher disables it", () => {
    expect(isInactive(attempt({ lastActivityAt: minutesAgo(600) }), null, NOW)).toBe(false);
  });

  it("falls back to the start time before any activity", () => {
    expect(isInactive(attempt({ lastActivityAt: null, startedAt: minutesAgo(11) }), 10, NOW)).toBe(true);
    expect(isInactive(attempt({ lastActivityAt: null, startedAt: minutesAgo(3) }), 10, NOW)).toBe(false);
  });

  it("does not let a heartbeat reset inactivity", () => {
    const a = attempt({ lastActivityAt: minutesAgo(12), lastHeartbeatAt: minutesAgo(0) });
    expect(isInactive(a, 10, NOW)).toBe(true);
    expect(participantState({ viewedAt: null, attempt: a, pendingReviewCount: null, thresholdMinutes: 10 }, NOW)).toBe("INACTIVE");
  });

  it("never applies to expired or finished sessions", () => {
    expect(isInactive(attempt({ lastActivityAt: minutesAgo(30), deadlineAt: minutesAgo(1) }), 10, NOW)).toBe(false);
    expect(isInactive(attempt({ status: "SUBMITTED", lastActivityAt: minutesAgo(30) }), 10, NOW)).toBe(false);
  });

  it("returns to IN_PROGRESS as soon as the student acts again", () => {
    const idle = attempt({ lastActivityAt: minutesAgo(15) });
    const back = { ...idle, lastActivityAt: NOW };
    const s = (a: AttemptRow) => participantState({ viewedAt: null, attempt: a, pendingReviewCount: null, thresholdMinutes: 10 }, NOW);
    expect(s(idle)).toBe("INACTIVE");
    expect(s(back)).toBe("IN_PROGRESS");
  });
});

describe("participant state", () => {
  const state = (over: Partial<Parameters<typeof participantState>[0]>) =>
    participantState({ viewedAt: null, attempt: null, pendingReviewCount: null, thresholdMinutes: 10, ...over }, NOW);

  it("separates never-opened from viewed-but-not-started", () => {
    expect(state({})).toBe("NOT_STARTED");
    expect(state({ viewedAt: minutesAgo(5) })).toBe("VIEWED");
  });

  it("treats a voided attempt as not started", () => {
    expect(state({ attempt: attempt({ status: "VOIDED" }) })).toBe("NOT_STARTED");
    expect(state({ attempt: attempt({ status: "VOIDED" }), viewedAt: minutesAgo(5) })).toBe("VIEWED");
  });

  it("shows an unswept expired session as auto-submitted, never abandoned", () => {
    expect(state({ attempt: attempt({ deadlineAt: minutesAgo(1) }) })).toBe("AUTO_SUBMITTED");
  });

  it("maps stored lifecycle statuses", () => {
    expect(state({ attempt: attempt({ status: "SUBMITTED" }) })).toBe("COMPLETED");
    expect(state({ attempt: attempt({ status: "AUTO_SUBMITTED" }) })).toBe("AUTO_SUBMITTED");
    expect(state({ attempt: attempt({ status: "EXPIRED_NO_ANSWERS" }) })).toBe("EXPIRED_NO_ANSWERS");
  });

  it("derives pending review from the result, not the attempt", () => {
    expect(state({ attempt: attempt({ status: "SUBMITTED" }), pendingReviewCount: 2 })).toBe("PENDING_REVIEW");
    expect(state({ attempt: attempt({ status: "AUTO_SUBMITTED" }), pendingReviewCount: 1 })).toBe("PENDING_REVIEW");
    expect(state({ attempt: attempt({ status: "SUBMITTED" }), pendingReviewCount: 0 })).toBe("COMPLETED");
  });
});

describe("attempt limits and throttling", () => {
  it("does not count voided attempts toward the limit", () => {
    expect(countsTowardLimit("VOIDED")).toBe(false);
    for (const s of ["IN_PROGRESS", "SUBMITTED", "AUTO_SUBMITTED", "EXPIRED_NO_ANSWERS"] as const) expect(countsTowardLimit(s)).toBe(true);
  });

  it("throttles repeated writes inside the window", () => {
    expect(throttleElapsed(null, 30_000, NOW)).toBe(true);
    expect(throttleElapsed(new Date(NOW.getTime() - 10_000), 30_000, NOW)).toBe(false);
    expect(throttleElapsed(new Date(NOW.getTime() - 30_000), 30_000, NOW)).toBe(true);
  });
});

describe("participants report and dashboard summary", () => {
  const people = new Map(
    [
      [1, "Aysel"],
      [2, "Bəhruz"],
      [3, "Cavid"],
      [4, "Dilarə"],
      [5, "Elvin"],
      [6, "Fidan"],
      [7, "Gülnar"],
      [8, "Həsən"],
    ].map(([id, name]) => [id as number, { name: name as string, email: null }]),
  );

  const input = {
    assessment: { inactivityThresholdMinutes: 10 },
    rosterIds: [1, 2, 3, 4, 5, 6, 7],
    people,
    progress: [
      { studentId: 2, viewedAt: minutesAgo(30), latestActivityAt: minutesAgo(30) },
      { studentId: 3, viewedAt: minutesAgo(25), latestActivityAt: minutesAgo(2) },
    ],
    attempts: [
      attempt({ id: "t3", studentId: 3, lastActivityAt: minutesAgo(2), lastHeartbeatAt: minutesAgo(0) }),
      attempt({ id: "t4", studentId: 4, lastActivityAt: minutesAgo(14) }),
      attempt({ id: "t5", studentId: 5, status: "SUBMITTED", submittedAt: minutesAgo(5), answeredCount: 4 }),
      attempt({ id: "t6", studentId: 6, status: "EXPIRED_NO_ANSWERS", answeredCount: 0 }),
      attempt({ id: "t7a", studentId: 7, status: "SUBMITTED", attemptNo: 1, submittedAt: minutesAgo(50) }),
      attempt({ id: "t7b", studentId: 7, status: "VOIDED", attemptNo: 2 }),
      attempt({ id: "t8", studentId: 8, status: "AUTO_SUBMITTED", submittedAt: minutesAgo(3) }),
    ],
    results: [
      { attemptId: "t5", id: "r5", percentage: 80, pendingReviewCount: 0 },
      { attemptId: "t7a", id: "r7", percentage: 60, pendingReviewCount: 1 },
      { attemptId: "t8", id: "r8", percentage: 40, pendingReviewCount: 0 },
    ],
    now: NOW,
  };

  const participants = buildParticipants(input);
  const byId = new Map(participants.map((p) => [p.studentId, p]));

  it("gives every roster student and every past attempter exactly one row", () => {
    expect(participants.map((p) => p.studentId).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(byId.get(8)?.onRoster).toBe(false);
  });

  it("assigns the expected state to each student", () => {
    expect(Object.fromEntries(participants.map((p) => [p.studentId, p.state]))).toEqual({
      1: "NOT_STARTED",
      2: "VIEWED",
      3: "IN_PROGRESS",
      4: "INACTIVE",
      5: "COMPLETED",
      6: "EXPIRED_NO_ANSWERS",
      7: "PENDING_REVIEW",
      8: "AUTO_SUBMITTED",
    });
  });

  it("ignores voided attempts for state, counts and results", () => {
    const p = byId.get(7)!;
    expect(p.attemptId).toBe("t7a");
    expect(p.attemptsUsed).toBe(1);
    expect(p.resultId).toBe("r7");
  });

  it("reports answered/total and server remaining time for open sessions only", () => {
    expect(byId.get(3)).toMatchObject({ answeredCount: 2, totalQuestionCount: 4, remainingSeconds: 40 * 60 });
    expect(byId.get(5)?.remainingSeconds).toBeNull();
  });

  it("sorts sessions that need attention first", () => {
    expect(participants[0].state).toBe("INACTIVE");
    expect(participants.at(-1)?.state).toBe("NOT_STARTED");
  });

  it("produces dashboard counts that equal the report rows", () => {
    const s = summarize(participants);
    const fromRows = (state: string) => participants.filter((p) => p.state === state).length;
    for (const [state, n] of Object.entries(s.counts)) expect(n).toBe(fromRows(state));
    expect(Object.values(s.counts).reduce((a, b) => a + b, 0)).toBe(s.total);
    expect(s).toMatchObject({ assigned: 7, total: 8, started: 6, finished: 3 });
    expect(s.counts.EXPIRED_NO_ANSWERS).toBe(1);
  });

  it("excludes students with no submitted answers from the average", () => {
    expect(summarize(participants).averagePercentage).toBe(60);
  });

  it("reflects the teacher's threshold without changing stored data", () => {
    const relaxed = buildParticipants({ ...input, assessment: { inactivityThresholdMinutes: 15 } });
    const off = buildParticipants({ ...input, assessment: { inactivityThresholdMinutes: null } });
    expect(relaxed.find((p) => p.studentId === 4)?.state).toBe("IN_PROGRESS");
    expect(off.every((p) => p.state !== "INACTIVE")).toBe(true);
  });
});

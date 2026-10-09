import { and, count, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  assessmentStudentProgress,
  attempts,
  resultItems,
  results,
  studentActivityEvents,
  studentAnswers,
  users,
} from "../../drizzle/schema";
import type { ActivityEventType } from "../../shared/assessment";
import { resetRateLimits } from "../_core/rateLimit";
import * as activity from "../modules/activity";
import * as sessions from "../modules/attempts";
import { caller, db, expire, makeGroup, makeTeacher, makeUser, outcome, publishedAssessment, questionIdsOf } from "./fixtures";

beforeEach(() => resetRateLimits());

async function setup(opts: { attemptsAllowed?: number; students?: number } = {}) {
  const teacher = await makeTeacher("Müəllim");
  const students = [];
  for (let i = 0; i < (opts.students ?? 1); i++) students.push(await makeUser(`Tələbə ${i + 1}`));
  const group = await makeGroup(teacher.scope, students);
  const assessment = await publishedAssessment(teacher.scope, {
    groupIds: [group.id],
    settings: { attemptsAllowed: opts.attemptsAllowed ?? 1, durationSeconds: 600 },
  });
  return { teacher, students, student: students[0], group, assessment };
}

const rowsOf = async (assessmentId: string, studentId: number) =>
  db().select().from(attempts).where(and(eq(attempts.assessmentId, assessmentId), eq(attempts.studentId, studentId)));
const progressOf = async (assessmentId: string, studentId: number) =>
  db()
    .select()
    .from(assessmentStudentProgress)
    .where(and(eq(assessmentStudentProgress.assessmentId, assessmentId), eq(assessmentStudentProgress.studentId, studentId)));
const eventsOf = async (assessmentId: string, eventType: ActivityEventType) =>
  db()
    .select()
    .from(studentActivityEvents)
    .where(and(eq(studentActivityEvents.entityId, assessmentId), eq(studentActivityEvents.eventType, eventType)));
const resultCount = async (attemptId: string) =>
  Number((await db().select({ n: count() }).from(results).where(eq(results.attemptId, attemptId)))[0].n);

describe("database clock", () => {
  it("stores DEFAULT now() timestamps in UTC, matching application time", async () => {
    const before = Date.now();
    const u = await makeUser("Saat");
    const [row] = await db().select({ createdAt: users.createdAt }).from(users).where(eq(users.id, u.id));
    expect(Math.abs(row.createdAt.getTime() - before)).toBeLessThan(5_000);
  });
});

describe("concurrent session start", () => {
  it("two tabs starting at once share one attempt, one progress row and one attempt count", async () => {
    const { assessment, student } = await setup();
    const [a, b] = await Promise.all([
      sessions.startAttempt(assessment.id, student.id),
      sessions.startAttempt(assessment.id, student.id),
    ]);
    expect(a.attemptId).toBe(b.attemptId);
    expect([a.resumed, b.resumed].sort()).toEqual([false, true]);
    expect(await rowsOf(assessment.id, student.id)).toHaveLength(1);
    const progress = await progressOf(assessment.id, student.id);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ attemptCount: 1, activeAttemptId: a.attemptId });
    expect(await eventsOf(assessment.id, "ASSESSMENT_STARTED")).toHaveLength(1);
  });

  it("stays idempotent under a burst of parallel starts through the API", async () => {
    const { assessment, student } = await setup({ attemptsAllowed: 3 });
    const api = caller(student);
    const out = await Promise.all(Array.from({ length: 6 }, () => api.student.start({ assessmentId: assessment.id })));
    expect(new Set(out.map((o) => o.attemptId)).size).toBe(1);
    const rows = await rowsOf(assessment.id, student.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("IN_PROGRESS");
    expect((await progressOf(assessment.id, student.id))[0].attemptCount).toBe(1);
  });

  it("parallel starts after a finished attempt create exactly one next attempt", async () => {
    const { assessment, student } = await setup({ attemptsAllowed: 2 });
    const first = await sessions.startAttempt(assessment.id, student.id);
    await sessions.submitAttempt(first.attemptId, student.id);
    const out = await Promise.all([1, 2, 3].map(() => sessions.startAttempt(assessment.id, student.id)));
    expect(new Set(out.map((o) => o.attemptId)).size).toBe(1);
    const rows = await rowsOf(assessment.id, student.id);
    expect(rows.map((r) => r.attemptNo).sort()).toEqual([1, 2]);
    expect(rows.filter((r) => r.status === "IN_PROGRESS")).toHaveLength(1);
    expect((await progressOf(assessment.id, student.id))[0].attemptCount).toBe(2);
  });

  it("does not let parallel starts exceed the attempt limit", async () => {
    const { assessment, student } = await setup({ attemptsAllowed: 1 });
    const first = await sessions.startAttempt(assessment.id, student.id);
    await sessions.submitAttempt(first.attemptId, student.id);
    const out = await Promise.all([1, 2].map(() => outcome(sessions.startAttempt(assessment.id, student.id))));
    expect(out).toEqual(["THROWN:NO_ATTEMPTS_LEFT", "THROWN:NO_ATTEMPTS_LEFT"]);
    expect(await rowsOf(assessment.id, student.id)).toHaveLength(1);
  });

  it("a finished attempt can never get a second result", async () => {
    const { assessment, student } = await setup();
    const { attemptId } = await sessions.startAttempt(assessment.id, student.id);
    const ids = await Promise.all([1, 2, 3].map(() => sessions.submitAttempt(attemptId, student.id)));
    expect(new Set(ids.map((x) => x.resultId)).size).toBe(1);
    expect(await resultCount(attemptId)).toBe(1);
  });
});

describe("resume", () => {
  it("returns the same session with saved answers and server-side remaining time", async () => {
    const { assessment, student } = await setup();
    const { attemptId } = await sessions.startAttempt(assessment.id, student.id);
    const [q1] = await questionIdsOf(attemptId);
    await sessions.saveAnswers(attemptId, student.id, [{ questionId: q1, answer: "a", revision: 1 }]);
    const again = await sessions.startAttempt(assessment.id, student.id);
    expect(again).toEqual({ attemptId, resumed: true });
    const view = await sessions.attemptView(attemptId, student.id);
    if (view.done) throw new Error("expected open session");
    expect(view.answers[q1]).toBe("a");
    expect(view.revision).toBe(1);
    const [listed] = await sessions.studentAssessments(student.id);
    expect(listed.resume).toMatchObject({ answeredCount: 1, totalQuestionCount: 3 });
    expect(listed.resume!.remainingSeconds).toBeGreaterThan(590);
    expect(listed.resume!.remainingSeconds).toBeLessThanOrEqual(600);
  });
});

describe("autosave revisions", () => {
  it("never lets an older retry overwrite a newer answer", async () => {
    const { assessment, student } = await setup();
    const { attemptId } = await sessions.startAttempt(assessment.id, student.id);
    const [q1] = await questionIdsOf(attemptId);
    await sessions.saveAnswers(attemptId, student.id, [{ questionId: q1, answer: "b", revision: 2 }]);
    await sessions.saveAnswers(attemptId, student.id, [{ questionId: q1, answer: "a", revision: 1 }]);
    const [row] = await db().select().from(studentAnswers).where(eq(studentAnswers.attemptId, attemptId));
    expect(row).toMatchObject({ answer: "b", revision: 2 });
    await sessions.saveAnswers(attemptId, student.id, [{ questionId: q1, answer: "c" }]);
    const [legacy] = await db().select().from(studentAnswers).where(eq(studentAnswers.attemptId, attemptId));
    expect(legacy).toMatchObject({ answer: "c", revision: 3 });
  });

  it("keeps answeredCount in step with stored answers", async () => {
    const { assessment, student } = await setup();
    const { attemptId } = await sessions.startAttempt(assessment.id, student.id);
    const [q1, q2] = await questionIdsOf(attemptId);
    const saved = await sessions.saveAnswers(attemptId, student.id, [
      { questionId: q1, answer: "a", revision: 1 },
      { questionId: q2, answer: "", revision: 1 },
    ]);
    expect(saved.answeredCount).toBe(1);
    const [row] = await rowsOf(assessment.id, student.id);
    expect(row.answeredCount).toBe(1);
    expect(row.lastAutosaveAt).not.toBeNull();
  });

  it("rejects answers for questions outside the attempt", async () => {
    const { assessment, student } = await setup();
    const { attemptId } = await sessions.startAttempt(assessment.id, student.id);
    expect(await outcome(sessions.saveAnswers(attemptId, student.id, [{ questionId: "not-in-attempt", answer: "a" }]))).toBe(
      "THROWN:UNKNOWN_QUESTION",
    );
  });
});

describe("expiry and auto-submit", () => {
  it("expired session with saved answers is auto-submitted once, graded from saved answers", async () => {
    const { teacher, assessment, student } = await setup();
    const { attemptId } = await sessions.startAttempt(assessment.id, student.id);
    const [q1, q2] = await questionIdsOf(attemptId);
    await sessions.saveAnswers(attemptId, student.id, [
      { questionId: q1, answer: "a", revision: 1 },
      { questionId: q2, answer: "b", revision: 1 },
    ]);
    await expire(attemptId);
    await sessions.sweepExpiredAttempts();
    await sessions.sweepExpiredAttempts();

    const [row] = await rowsOf(assessment.id, student.id);
    expect(row.status).toBe("AUTO_SUBMITTED");
    expect(row.submittedAt?.getTime()).toBe(row.deadlineAt.getTime());
    expect(row.autoSubmittedAt?.getTime()).toBe(row.deadlineAt.getTime());
    expect(await resultCount(attemptId)).toBe(1);
    const [result] = await db().select().from(results).where(eq(results.attemptId, attemptId));
    expect(result).toMatchObject({ correctCount: 1, wrongCount: 1, unansweredCount: 1, totalPoints: 3, earnedPoints: 1 });
    expect(result.percentage).toBeGreaterThanOrEqual(0);
    expect(result.percentage).toBeLessThanOrEqual(100);
    expect(await db().select().from(studentAnswers).where(eq(studentAnswers.attemptId, attemptId))).toHaveLength(2);
    expect(await eventsOf(assessment.id, "ASSESSMENT_EXPIRED")).toHaveLength(1);

    const report = await activity.assessmentParticipants(teacher.scope, assessment.id);
    expect(report.participants.find((p) => p.studentId === student.id)?.state).toBe("AUTO_SUBMITTED");
    expect(report.summary.counts.AUTO_SUBMITTED).toBe(1);
    expect(report.summary.finished).toBe(1);
  });

  it("expired session with zero answers becomes EXPIRED_NO_ANSWERS without a result", async () => {
    const { teacher, assessment, student } = await setup();
    const { attemptId } = await sessions.startAttempt(assessment.id, student.id);
    await expire(attemptId);
    await sessions.sweepExpiredAttempts();

    const [row] = await rowsOf(assessment.id, student.id);
    expect(row.status).toBe("EXPIRED_NO_ANSWERS");
    expect(row.submittedAt).toBeNull();
    expect(await resultCount(attemptId)).toBe(0);
    expect((await progressOf(assessment.id, student.id))[0].expiredAt).not.toBeNull();

    const [listed] = await sessions.studentAssessments(student.id);
    expect(listed).toMatchObject({ attemptStatus: "EXPIRED_NO_ANSWERS", resume: null, resultId: null, attemptsUsed: 1 });
    const report = await activity.assessmentParticipants(teacher.scope, assessment.id);
    expect(report.summary.counts.EXPIRED_NO_ANSWERS).toBe(1);
    expect(report.summary.averagePercentage).toBeNull();
    expect(await sessions.submitAttempt(attemptId, student.id)).toEqual({ resultId: null });
  });

  it("submit pressed just after the deadline is recorded as auto-submitted at the deadline", async () => {
    const { assessment, student } = await setup();
    const { attemptId } = await sessions.startAttempt(assessment.id, student.id);
    const [q1] = await questionIdsOf(attemptId);
    await sessions.saveAnswers(attemptId, student.id, [{ questionId: q1, answer: "a", revision: 1 }]);
    // `timestamp` columns have second precision (MySQL rounds), so "just passed" is one second.
    await expire(attemptId, 1);
    const { resultId } = await sessions.submitAttempt(attemptId, student.id);
    expect(resultId).toBeTruthy();
    const [row] = await rowsOf(assessment.id, student.id);
    expect(row.status).toBe("AUTO_SUBMITTED");
    expect(row.submittedAt?.getTime()).toBe(row.deadlineAt.getTime());
  });

  it("submit racing the sweeper and concurrent sweepers produce one result", async () => {
    const { assessment, students } = await setup({ students: 2 });
    const [s1, s2] = students;
    const one = await sessions.startAttempt(assessment.id, s1.id);
    const two = await sessions.startAttempt(assessment.id, s2.id);
    for (const [s, a] of [[s1, one], [s2, two]] as const) {
      const [q] = await questionIdsOf(a.attemptId);
      await sessions.saveAnswers(a.attemptId, s.id, [{ questionId: q, answer: "a", revision: 1 }]);
      await expire(a.attemptId);
    }
    const [submitted] = await Promise.all([
      sessions.submitAttempt(one.attemptId, s1.id),
      sessions.sweepExpiredAttempts(),
      sessions.sweepExpiredAttempts(),
      sessions.finalizeAttempt(two.attemptId, { auto: true }),
    ]);
    expect(submitted.resultId).toBeTruthy();
    expect(await resultCount(one.attemptId)).toBe(1);
    expect(await resultCount(two.attemptId)).toBe(1);
    expect(await eventsOf(assessment.id, "ASSESSMENT_EXPIRED")).toHaveLength(2);
    const retry = await sessions.submitAttempt(one.attemptId, s1.id);
    expect(retry.resultId).toBe(submitted.resultId);
  });

  it("rejects an autosave that arrives after the deadline and its grace period, and keeps the saved answer", async () => {
    const { assessment, student } = await setup();
    const { attemptId } = await sessions.startAttempt(assessment.id, student.id);
    const [q1] = await questionIdsOf(attemptId);
    await sessions.saveAnswers(attemptId, student.id, [{ questionId: q1, answer: "a", revision: 1 }]);
    await expire(attemptId);
    expect(await outcome(sessions.saveAnswers(attemptId, student.id, [{ questionId: q1, answer: "b", revision: 2 }]))).toBe(
      "THROWN:ATTEMPT_CLOSED",
    );
    const [row] = await db().select().from(studentAnswers).where(eq(studentAnswers.attemptId, attemptId));
    expect(row).toMatchObject({ answer: "a", revision: 1 });
    expect((await rowsOf(assessment.id, student.id))[0].status).toBe("AUTO_SUBMITTED");
    expect(await outcome(caller(student).student.save({ attemptId, entries: [{ questionId: q1, answer: "c", revision: 3 }] }))).toBe(
      "PRECONDITION_FAILED:ATTEMPT_CLOSED",
    );
  });

  it("never stores an answer that the graded result does not reflect (autosave racing submit)", async () => {
    const { assessment, students } = await setup({ students: 8 });
    await Promise.all(
      students.map(async (s) => {
        const { attemptId } = await sessions.startAttempt(assessment.id, s.id);
        const [q1] = await questionIdsOf(attemptId);
        await Promise.all([
          outcome(sessions.saveAnswers(attemptId, s.id, [{ questionId: q1, answer: "a", revision: 1 }])),
          sessions.submitAttempt(attemptId, s.id),
        ]);
        const stored = await db().select().from(studentAnswers).where(eq(studentAnswers.attemptId, attemptId));
        const [result] = await db().select().from(results).where(eq(results.attemptId, attemptId));
        const [item] = await db()
          .select()
          .from(resultItems)
          .where(and(eq(resultItems.resultId, result.id), eq(resultItems.versionQuestionId, q1)));
        expect(item.status === "UNANSWERED").toBe(stored.length === 0);
      }),
    );
  });

  it("ping after expiry closes the session instead of extending it", async () => {
    const { assessment, student } = await setup();
    const { attemptId } = await sessions.startAttempt(assessment.id, student.id);
    await expire(attemptId);
    expect(await sessions.sessionPing(attemptId, student.id, true)).toEqual({ open: false });
    const [row] = await rowsOf(assessment.id, student.id);
    expect(row.status).toBe("EXPIRED_NO_ANSWERS");
  });

  it("accepts an autosave still in flight within the grace period; the late submit is graded at the deadline", async () => {
    const { assessment, student } = await setup();
    const { attemptId } = await sessions.startAttempt(assessment.id, student.id);
    const [q1] = await questionIdsOf(attemptId);
    await expire(attemptId, 2);

    expect(await sessions.sessionPing(attemptId, student.id, false)).toMatchObject({ open: true });
    expect((await sessions.attemptView(attemptId, student.id)).done).toBe(false);
    await sessions.sweepExpiredAttempts();
    expect((await rowsOf(assessment.id, student.id))[0].status).toBe("IN_PROGRESS");

    await sessions.saveAnswers(attemptId, student.id, [{ questionId: q1, answer: "a", revision: 1 }]);
    const { resultId } = await sessions.submitAttempt(attemptId, student.id);
    const [row] = await rowsOf(assessment.id, student.id);
    expect(row.status).toBe("AUTO_SUBMITTED");
    expect(row.submittedAt?.getTime()).toBe(row.deadlineAt.getTime());
    const [item] = await db()
      .select()
      .from(resultItems)
      .where(and(eq(resultItems.resultId, resultId!), eq(resultItems.versionQuestionId, q1)));
    expect(item.status).not.toBe("UNANSWERED");
  });

  it("closes an abandoned attempt (browser closed) once the grace period has passed", async () => {
    const { assessment, student } = await setup();
    const { attemptId } = await sessions.startAttempt(assessment.id, student.id);
    const [q1] = await questionIdsOf(attemptId);
    await sessions.saveAnswers(attemptId, student.id, [{ questionId: q1, answer: "a", revision: 1 }]);
    await expire(attemptId, 2);
    expect(await sessions.sweepExpiredAttempts()).toBe(0);
    await expire(attemptId);
    expect(await sessions.sweepExpiredAttempts()).toBe(1);
    const [row] = await rowsOf(assessment.id, student.id);
    expect(row.status).toBe("AUTO_SUBMITTED");
    expect(await resultCount(attemptId)).toBe(1);
  });
});

describe("server deadline", () => {
  it("a refresh or resume returns the original deadline, never a fresh full duration", async () => {
    const { assessment, student } = await setup();
    const { attemptId } = await sessions.startAttempt(assessment.id, student.id);
    const [row] = await rowsOf(assessment.id, student.id);
    expect(row.deadlineAt.getTime() - row.startedAt.getTime()).toBe(600_000);

    const first = await sessions.attemptView(attemptId, student.id);
    expect(await sessions.startAttempt(assessment.id, student.id)).toEqual({ attemptId, resumed: true });
    const second = await sessions.attemptView(attemptId, student.id);
    if (first.done || second.done) throw new Error("expected open session");
    expect(first.deadlineAt.getTime()).toBe(row.deadlineAt.getTime());
    expect(second.deadlineAt.getTime()).toBe(row.deadlineAt.getTime());
    expect(Math.abs(second.serverNow.getTime() - Date.now())).toBeLessThan(5000);
    const ping = await sessions.sessionPing(attemptId, student.id, false);
    if (!ping.open) throw new Error("expected open session");
    expect(ping.deadlineAt.getTime()).toBe(row.deadlineAt.getTime());
  });
});

describe("inactivity on real rows", () => {
  it("heartbeat keeps the page-open signal but does not reset inactivity", async () => {
    const { teacher, assessment, student } = await setup();
    const { attemptId } = await sessions.startAttempt(assessment.id, student.id);
    await db().update(attempts).set({ lastActivityAt: new Date(Date.now() - 11 * 60_000) }).where(eq(attempts.id, attemptId));
    await sessions.sessionPing(attemptId, student.id, false);
    let report = await activity.assessmentParticipants(teacher.scope, assessment.id);
    const p = report.participants.find((x) => x.studentId === student.id)!;
    expect(p.state).toBe("INACTIVE");
    expect(p.lastHeartbeatAt).not.toBeNull();

    await sessions.sessionPing(attemptId, student.id, true);
    report = await activity.assessmentParticipants(teacher.scope, assessment.id);
    expect(report.participants.find((x) => x.studentId === student.id)?.state).toBe("IN_PROGRESS");

    await activity.setInactivityThreshold(teacher.scope, assessment.id, null);
    await db().update(attempts).set({ lastActivityAt: new Date(Date.now() - 60 * 60_000) }).where(eq(attempts.id, attemptId));
    report = await activity.assessmentParticipants(teacher.scope, assessment.id);
    expect(report.participants.find((x) => x.studentId === student.id)?.state).toBe("IN_PROGRESS");
    expect((await rowsOf(assessment.id, student.id))[0].status).toBe("IN_PROGRESS");
  });

  it("dashboard card counts equal the participants report", async () => {
    const { teacher, assessment, students } = await setup({ students: 4 });
    const [s1, s2, s3] = students;
    await activity.markAssessmentViewed(assessment.id, s1.id);
    const a2 = await sessions.startAttempt(assessment.id, s2.id);
    const a3 = await sessions.startAttempt(assessment.id, s3.id);
    await sessions.submitAttempt(a3.attemptId, s3.id);
    await db().update(attempts).set({ lastActivityAt: new Date(Date.now() - 20 * 60_000) }).where(eq(attempts.id, a2.attemptId));

    const report = await activity.assessmentParticipants(teacher.scope, assessment.id);
    const cards = await activity.assessmentActivityCards(teacher.scope);
    const card = cards.cards.find((c) => c.id === assessment.id)!;
    expect(card.summary.counts).toEqual(report.summary.counts);
    expect(report.summary.counts).toMatchObject({ VIEWED: 1, INACTIVE: 1, COMPLETED: 1, NOT_STARTED: 1 });
    expect(cards.totals.inactiveNow).toBe(1);
  });
});

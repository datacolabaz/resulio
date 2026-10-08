import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  assessmentAssignments,
  assessments,
  assessmentVersions,
  attempts,
  providerWorkspaces,
  resultItems,
  resultPenalties,
  results,
  studentAnswers,
  users,
  versionQuestions,
  type Assessment,
  type AssessmentAssignment,
  type Attempt,
  type Result,
} from "../../drizzle/schema";
import type { StudentAnswer } from "../../shared/assessment";
import { requireDb, type DbOrTx } from "../db";
import * as notifications from "./notifications";
import {
  AUTOSAVE_EVENT_THROTTLE_MS,
  HEARTBEAT_THROTTLE_MS,
  recordEvent,
  upsertAssessmentProgress,
} from "./activity";
import { accessibleAssessmentIds, loadVersion, resolveAssignment, summary, syllabusAssignment } from "./assessments";
import {
  checkCanStart,
  computeDeadline,
  correctAnswerOf,
  countsTowardLimit,
  effectiveRules,
  gradeAttempt,
  isAnswered,
  isExpired,
  liveStatus,
  penaltyRule,
  throttleElapsed,
  questionOrderFor,
  resultVisibility,
  round1,
  scoreItems,
  toStudentQuestion,
  type FrozenQuestion,
  type PenaltyOutcome,
  type ResultVisibility,
} from "./engine";
import { isMissingTable } from "../notifications/preferences";
import type { TeacherScope } from "./access";
import { AppError } from "./errors";
import { emitLearningEvent } from "./learningEvents";
import { syllabusOwnedAssignments } from "./syllabusLinks";

/** drizzle wraps driver errors (DrizzleQueryError), so the MySQL code may sit on `cause`. */
const isDuplicateKey = (e: unknown): boolean => {
  for (let cur = e, depth = 0; cur && typeof cur === "object" && depth < 5; cur = (cur as { cause?: unknown }).cause, depth++) {
    if ((cur as { code?: unknown }).code === "ER_DUP_ENTRY") return true;
  }
  return false;
};

async function ownAttempt(attemptId: string, studentId: number, db: DbOrTx = requireDb()) {
  const [row] = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.id, attemptId), eq(attempts.studentId, studentId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

async function answersOf(attemptId: string, db: DbOrTx = requireDb()) {
  const rows = await db.select().from(studentAnswers).where(eq(studentAnswers.attemptId, attemptId));
  return Object.fromEntries(rows.map((r) => [r.versionQuestionId, r.answer ?? null])) as Record<string, StudentAnswer>;
}

const answeredIn = (order: string[], answers: Record<string, StudentAnswer>) => order.filter((id) => isAnswered(answers[id])).length;

async function workspaceOfAssessment(assessmentId: string, db: DbOrTx) {
  const [row] = await db
    .select({ workspaceId: assessments.providerWorkspaceId, ownerUserId: providerWorkspaces.ownerUserId })
    .from(assessments)
    .innerJoin(providerWorkspaces, eq(providerWorkspaces.id, assessments.providerWorkspaceId))
    .where(eq(assessments.id, assessmentId));
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

function windowClosed(a: Assessment, assignment: AssessmentAssignment | null | undefined, now = new Date()) {
  if (a.status === "CLOSED") return true;
  const endAt = assignment?.availableUntil ?? a.endAt;
  return Boolean(endAt && endAt.getTime() <= now.getTime());
}

/** Visibility of many results at once (batch loads versions and assignments). */
export async function visibilityForResults(
  rows: { result: Result; assessment: Assessment; assignmentId: number | null }[],
  db: DbOrTx = requireDb(),
): Promise<Map<string, ResultVisibility>> {
  const out = new Map<string, ResultVisibility>();
  if (!rows.length) return out;
  const versionIds = [...new Set(rows.map((r) => r.result.versionId))];
  const assignmentIds = [...new Set(rows.flatMap((r) => (r.assignmentId ? [r.assignmentId] : [])))];
  const versions = await db.select().from(assessmentVersions).where(inArray(assessmentVersions.id, versionIds));
  const assignments = assignmentIds.length
    ? await db.select().from(assessmentAssignments).where(inArray(assessmentAssignments.id, assignmentIds))
    : [];
  const now = new Date();
  for (const r of rows) {
    const version = versions.find((v) => v.id === r.result.versionId);
    if (!version) continue;
    const assignment = assignments.find((x) => x.id === r.assignmentId);
    out.set(
      r.result.id,
      resultVisibility(version.settings, {
        windowClosed: windowClosed(r.assessment, assignment, now),
        pendingReview: r.result.pendingReviewCount,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/**
 * Server-side start chain: published → access → window → attempt limit. `viaAssignmentId` is the
 * syllabus path: the attempt runs on that per-student assignment and its pinned version.
 */
export async function startAttempt(assessmentId: string, studentId: number, viaAssignmentId?: number) {
  const db = requireDb();
  const [a] = await db.select().from(assessments).where(eq(assessments.id, assessmentId)).limit(1);
  if (!a) throw new AppError("NOT_FOUND");
  if (a.status === "DRAFT" || !a.currentVersionId) throw new AppError("NOT_PUBLISHED");

  const assignment =
    viaAssignmentId !== undefined ? await syllabusAssignment(viaAssignmentId, assessmentId, studentId, db) : await resolveAssignment(assessmentId, studentId, db);
  if (!assignment) throw new AppError("NO_ACCESS");

  const existing = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.assessmentId, assessmentId), eq(attempts.studentId, studentId)))
    .orderBy(asc(attempts.attemptNo));

  const open = existing.find((x) => x.status === "IN_PROGRESS");
  if (open) {
    if (!isExpired(open)) {
      const now = new Date();
      if (throttleElapsed(open.lastActivityAt, 60_000, now)) {
        await db.transaction(async (tx) => {
          await tx.update(attempts).set({ lastActivityAt: now }).where(and(eq(attempts.id, open.id), eq(attempts.status, "IN_PROGRESS")));
          await upsertAssessmentProgress(tx, assessmentId, studentId, { latestActivityAt: now, activeAttemptId: open.id });
          await recordEvent(tx, {
            userId: studentId,
            workspaceId: a.providerWorkspaceId,
            groupId: assignment.groupId,
            entityType: "ASSESSMENT",
            entityId: assessmentId,
            eventType: "ASSESSMENT_RESUMED",
            metadata: { attemptId: open.id, answeredCount: open.answeredCount },
          });
        });
      }
      return { attemptId: open.id, resumed: true };
    }
    await finalizeAttempt(open.id, { auto: true });
  }

  const pinnedVersionId = assignment.assessmentVersionId ?? a.currentVersionId;
  const { version, questions } = await loadVersion(pinnedVersionId, db);
  const rules = effectiveRules(a, assignment, version.settings);
  const denial = checkCanStart({
    assessment: a,
    window: { startAt: rules.startAt, endAt: rules.endAt },
    versionId: rules.versionId,
    attemptsAllowed: rules.attemptsAllowed,
    hasAccess: true,
    finishedAttempts: existing.filter((x) => countsTowardLimit(x.status)).length,
  });
  if (denial) throw new AppError(denial);

  const id = nanoid();
  const startedAt = new Date();
  const attemptNo = existing.reduce((m, x) => Math.max(m, x.attemptNo), 0) + 1;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(attempts).values({
        id,
        assessmentId,
        versionId: version.id,
        assignmentId: assignment.id,
        studentId,
        attemptNo,
        status: "IN_PROGRESS",
        questionOrder: questionOrderFor(questions.map((q) => q.id), version.settings.randomize, id),
        startedAt,
        deadlineAt: computeDeadline(startedAt, rules.durationSeconds, rules.endAt),
        lastActivityAt: startedAt,
        totalQuestionCount: questions.length,
      });
      await upsertAssessmentProgress(tx, assessmentId, studentId, {
        assignmentId: assignment.id,
        versionId: version.id,
        startedAt,
        latestActivityAt: startedAt,
        activeAttemptId: id,
        incrementAttempts: true,
      });
      await recordEvent(tx, {
        userId: studentId,
        workspaceId: a.providerWorkspaceId,
        groupId: assignment.groupId,
        entityType: "ASSESSMENT",
        entityId: assessmentId,
        eventType: "ASSESSMENT_STARTED",
        metadata: { attemptId: id, attemptNo, versionId: version.id },
      });
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const [concurrent] = await db
      .select()
      .from(attempts)
      .where(and(eq(attempts.assessmentId, assessmentId), eq(attempts.studentId, studentId), eq(attempts.status, "IN_PROGRESS")))
      .limit(1);
    if (!concurrent) throw new AppError("NO_ATTEMPTS_LEFT");
    return { attemptId: concurrent.id, resumed: true };
  }
  return { attemptId: id, resumed: false };
}

// ---------------------------------------------------------------------------
// Attempt view and autosave
// ---------------------------------------------------------------------------

export async function attemptView(attemptId: string, studentId: number) {
  let attempt = await ownAttempt(attemptId, studentId);
  if (isExpired(attempt)) {
    await finalizeAttempt(attempt.id, { auto: true });
    attempt = await ownAttempt(attemptId, studentId);
  }
  if (attempt.status !== "IN_PROGRESS") {
    const [result] = await requireDb().select({ id: results.id }).from(results).where(eq(results.attemptId, attempt.id)).limit(1);
    return { done: true as const, resultId: result?.id ?? null };
  }
  const { version, questions } = await loadVersion(attempt.versionId);
  const byId = new Map(questions.map((q) => [q.id, q]));
  const ordered = attempt.questionOrder.map((id) => byId.get(id)).filter((q): q is FrozenQuestion => Boolean(q));
  return {
    done: false as const,
    attemptId: attempt.id,
    assessmentId: attempt.assessmentId,
    title: version.settings.title,
    instructions: version.settings.instructions,
    startedAt: attempt.startedAt,
    deadlineAt: attempt.deadlineAt,
    serverNow: new Date(),
    questions: ordered.map((q, i) => ({ ...toStudentQuestion(q, `${attempt.id}:${q.id}`), position: i + 1 })),
    answers: await answersOf(attempt.id),
    /** Highest stored answer revision; the client continues from here (also after switching device). */
    revision: await maxRevision(attempt.id),
  };
}

async function maxRevision(attemptId: string, db: DbOrTx = requireDb()) {
  const [row] = await db
    .select({ max: sql<number | null>`max(${studentAnswers.revision})` })
    .from(studentAnswers)
    .where(eq(studentAnswers.attemptId, attemptId));
  return Number(row?.max ?? 0);
}

/**
 * Idempotent autosave. With a `revision`, a write only replaces a stored answer with a lower
 * revision, so a delayed retry can never overwrite a newer answer. Without one (older clients)
 * the write always applies.
 */
export async function saveAnswers(
  attemptId: string,
  studentId: number,
  entries: { questionId: string; answer: StudentAnswer; revision?: number }[],
) {
  const db = requireDb();
  const attempt = await ownAttempt(attemptId, studentId);
  if (attempt.status !== "IN_PROGRESS") throw new AppError("ATTEMPT_CLOSED");
  if (isExpired(attempt)) {
    await finalizeAttempt(attempt.id, { auto: true });
    throw new AppError("ATTEMPT_CLOSED");
  }
  const allowed = new Set(attempt.questionOrder);
  if (!entries.every((e) => allowed.has(e.questionId))) throw new AppError("UNKNOWN_QUESTION");
  let now = new Date();
  let closed = false;
  const answeredCount = await db.transaction(async (tx) => {
    // Same row lock as finalizeAttempt: an autosave either lands before grading or is rejected.
    const [locked] = await tx
      .select({ status: attempts.status, deadlineAt: attempts.deadlineAt })
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .for("update");
    now = new Date();
    if (!locked || locked.status !== "IN_PROGRESS" || isExpired(locked, now)) {
      closed = true;
      return 0;
    }
    for (const e of entries) {
      const insert = tx.insert(studentAnswers).values({ attemptId, versionQuestionId: e.questionId, answer: e.answer, revision: e.revision ?? 0 });
      if (e.revision === undefined) {
        await insert.onDuplicateKeyUpdate({ set: { answer: e.answer, revision: sql`${studentAnswers.revision} + 1` } });
      } else {
        // `answer` must be assigned before `revision`: MySQL evaluates SET left to right.
        await insert.onDuplicateKeyUpdate({
          set: {
            answer: sql`IF(VALUES(${studentAnswers.revision}) > ${studentAnswers.revision}, VALUES(${studentAnswers.answer}), ${studentAnswers.answer})`,
            revision: sql`GREATEST(${studentAnswers.revision}, VALUES(${studentAnswers.revision}))`,
          },
        });
      }
    }
    const count = answeredIn(attempt.questionOrder, await answersOf(attemptId, tx));
    await tx
      .update(attempts)
      .set({ answeredCount: count, lastActivityAt: now, lastAutosaveAt: now })
      .where(and(eq(attempts.id, attemptId), eq(attempts.status, "IN_PROGRESS")));
    if (throttleElapsed(attempt.lastAutosaveAt, AUTOSAVE_EVENT_THROTTLE_MS, now)) {
      const { workspaceId } = await workspaceOfAssessment(attempt.assessmentId, tx);
      await upsertAssessmentProgress(tx, attempt.assessmentId, studentId, { latestActivityAt: now });
      await recordEvent(tx, {
        userId: studentId,
        workspaceId,
        entityType: "ASSESSMENT",
        entityId: attempt.assessmentId,
        eventType: "ASSESSMENT_AUTOSAVED",
        metadata: { attemptId, answeredCount: count },
      });
    }
    return count;
  });
  if (closed) {
    await finalizeAttempt(attempt.id, { auto: true });
    throw new AppError("ATTEMPT_CLOSED");
  }
  return { savedAt: now, deadlineAt: attempt.deadlineAt, answeredCount };
}

/**
 * Session ping from an open exam page. Always refreshes the page-open heartbeat (throttled);
 * refreshes `lastActivityAt` only when the student navigated or interacted since the last ping.
 */
export async function sessionPing(attemptId: string, studentId: number, interacted: boolean) {
  const attempt = await ownAttempt(attemptId, studentId);
  if (attempt.status !== "IN_PROGRESS") return { open: false as const };
  if (isExpired(attempt)) {
    await finalizeAttempt(attempt.id, { auto: true });
    return { open: false as const };
  }
  const now = new Date();
  const set: { lastHeartbeatAt?: Date; lastActivityAt?: Date } = {};
  if (throttleElapsed(attempt.lastHeartbeatAt, HEARTBEAT_THROTTLE_MS, now)) set.lastHeartbeatAt = now;
  if (interacted) set.lastActivityAt = now;
  if (set.lastHeartbeatAt || set.lastActivityAt) {
    await requireDb()
      .update(attempts)
      .set(set)
      .where(and(eq(attempts.id, attempt.id), eq(attempts.status, "IN_PROGRESS")));
  }
  return { open: true as const, deadlineAt: attempt.deadlineAt, serverNow: now };
}

// ---------------------------------------------------------------------------
// Submit / finalize (transactional, idempotent)
// ---------------------------------------------------------------------------

/** `resultId` is null when the deadline had already passed with no saved answers. */
export async function submitAttempt(attemptId: string, studentId: number) {
  await ownAttempt(attemptId, studentId);
  const resultId = await finalizeAttempt(attemptId, { auto: false });
  return { resultId };
}

/**
 * Grades and closes an attempt exactly once. Concurrent or repeated calls return the
 * existing result. Answers saved before the deadline are always graded. An expired attempt
 * with no answers becomes EXPIRED_NO_ANSWERS without a result (returns null).
 */
export async function finalizeAttempt(attemptId: string, opts: { auto: boolean }): Promise<string | null> {
  const db = requireDb();
  let notify: { ownerUserId: number | null; studentId: number; title: string; percentage: number } | null = null;

  const resultId = await db.transaction(async (tx): Promise<string | null> => {
    const [attempt] = await tx.select().from(attempts).where(eq(attempts.id, attemptId)).for("update");
    if (!attempt) throw new AppError("NOT_FOUND");
    if (attempt.status !== "IN_PROGRESS") {
      const [existing] = await tx.select({ id: results.id }).from(results).where(eq(results.attemptId, attemptId)).limit(1);
      if (existing) return existing.id;
      if (attempt.status === "EXPIRED_NO_ANSWERS" || attempt.status === "VOIDED") return null;
      throw new AppError("NOT_FOUND");
    }

    const now = new Date();
    const late = now >= attempt.deadlineAt;
    const auto = opts.auto || late;
    const submittedAt = late ? attempt.deadlineAt : now;
    const answers = await answersOf(attempt.id, tx);
    const answeredCount = answeredIn(attempt.questionOrder, answers);
    const owner = await workspaceOfAssessment(attempt.assessmentId, tx);
    const event = { userId: attempt.studentId, workspaceId: owner.workspaceId, entityType: "ASSESSMENT" as const, entityId: attempt.assessmentId };

    if (auto && answeredCount === 0) {
      await tx
        .update(attempts)
        .set({ status: "EXPIRED_NO_ANSWERS", autoSubmittedAt: attempt.deadlineAt, answeredCount: 0 })
        .where(eq(attempts.id, attempt.id));
      await upsertAssessmentProgress(tx, attempt.assessmentId, attempt.studentId, { expiredAt: attempt.deadlineAt, activeAttemptId: null });
      await recordEvent(tx, { ...event, eventType: "ASSESSMENT_EXPIRED", metadata: { attemptId, answeredCount: 0, autoSubmitted: false } });
      return null;
    }

    const { version, questions } = await loadVersion(attempt.versionId, tx);
    const score = gradeAttempt(questions, answers, penaltyRule(version.settings));

    const id = nanoid();
    await tx.insert(results).values({
      id,
      attemptId: attempt.id,
      assessmentId: attempt.assessmentId,
      versionId: attempt.versionId,
      studentId: attempt.studentId,
      totalPoints: score.totalPoints,
      earnedPoints: score.earnedPoints,
      percentage: score.percentage,
      correctCount: score.correctCount,
      wrongCount: score.wrongCount,
      unansweredCount: score.unansweredCount,
      pendingReviewCount: score.pendingReviewCount,
      durationSeconds: Math.max(0, Math.round((submittedAt.getTime() - attempt.startedAt.getTime()) / 1000)),
      completedAt: submittedAt,
    });
    await tx.insert(resultItems).values(
      score.items.map((item) => ({
        resultId: id,
        versionQuestionId: item.questionId,
        status: item.status,
        earned: item.earned,
        topic: item.topic,
        skill: item.skill,
      })),
    );
    if (score.penalty) await savePenalty(tx, id, score.penalty);
    await tx
      .update(attempts)
      .set({ status: auto ? "AUTO_SUBMITTED" : "SUBMITTED", submittedAt, answeredCount, autoSubmittedAt: auto ? submittedAt : null })
      .where(eq(attempts.id, attempt.id));
    await upsertAssessmentProgress(tx, attempt.assessmentId, attempt.studentId, {
      completedAt: submittedAt,
      ...(auto ? { expiredAt: attempt.deadlineAt } : { latestActivityAt: now }),
      activeAttemptId: null,
    });
    await recordEvent(tx, {
      ...event,
      eventType: auto ? "ASSESSMENT_EXPIRED" : "ASSESSMENT_SUBMITTED",
      metadata: { attemptId, answeredCount, autoSubmitted: auto, resultId: id },
    });

    notify = { ownerUserId: owner.ownerUserId, studentId: attempt.studentId, title: version.settings.title, percentage: score.percentage };
    return id;
  });

  emitLearningEvent({ type: "ATTEMPT_FINISHED", attemptId });
  if (notify) {
    const n = notify as { ownerUserId: number | null; studentId: number; title: string; percentage: number };
    if (n.ownerUserId) await notifications.notify(n.ownerUserId, "İmtahan tamamlandı", `${n.title}: ${n.percentage}%`);
    await notifications.notify(n.studentId, "Nəticəniz hazırdır", n.title);
  }
  return resultId;
}

/** Before migration 0031 the deduction is still applied to the score, only not itemized. */
async function savePenalty(tx: DbOrTx, resultId: string, penalty: PenaltyOutcome) {
  try {
    await tx
      .insert(resultPenalties)
      .values({ resultId, ...penalty })
      .onDuplicateKeyUpdate({ set: { ratio: penalty.ratio, wrongCount: penalty.wrongCount, closedEarned: penalty.closedEarned, penaltyPoints: penalty.penaltyPoints } });
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
}

/** The itemized deduction of a result, or null (rule off, or not migrated yet). */
export async function penaltyOf(resultId: string, db: DbOrTx = requireDb()): Promise<PenaltyOutcome | null> {
  try {
    const [row] = await db.select().from(resultPenalties).where(eq(resultPenalties.resultId, resultId)).limit(1);
    return row ? { ratio: row.ratio, wrongCount: row.wrongCount, closedEarned: row.closedEarned, penaltyPoints: row.penaltyPoints } : null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

/** Background sweep: close attempts whose server deadline has passed. */
export async function sweepExpiredAttempts(limit = 100) {
  const db = requireDb();
  const expired = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(and(eq(attempts.status, "IN_PROGRESS"), lte(attempts.deadlineAt, new Date())))
    .limit(limit);
  for (const row of expired) {
    try {
      await finalizeAttempt(row.id, { auto: true });
    } catch (error) {
      console.error("[Sweeper] Failed to finalize attempt", row.id, error);
    }
  }
  return expired.length;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function reviewQuestions(
  questions: FrozenQuestion[],
  order: string[],
  items: Map<string, { status: string; earned: number }>,
  answers: Record<string, StudentAnswer>,
  seedPrefix: string,
  opts: { correctAnswers: boolean; explanations: boolean; filter: (status: string) => boolean },
) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  return order
    .map((id) => byId.get(id))
    .filter((q): q is FrozenQuestion => Boolean(q))
    .map((q, i) => {
      const item = items.get(q.id);
      const status = item?.status ?? "UNANSWERED";
      return {
        ...toStudentQuestion(q, `${seedPrefix}:${q.id}`),
        position: i + 1,
        maxPoints: q.points,
        status,
        earned: item?.earned ?? 0,
        studentAnswer: answers[q.id] ?? null,
        ...(opts.correctAnswers ? { correctAnswer: correctAnswerOf(q) ?? null } : {}),
        ...(opts.explanations && q.explanation ? { explanation: q.explanation } : {}),
      };
    })
    .filter((q) => opts.filter(q.status));
}

export async function resultForStudent(resultId: string, studentId: number) {
  const db = requireDb();
  const [result] = await db
    .select()
    .from(results)
    .where(and(eq(results.id, resultId), eq(results.studentId, studentId)))
    .limit(1);
  if (!result) throw new AppError("NOT_FOUND");
  const [a] = await db.select().from(assessments).where(eq(assessments.id, result.assessmentId)).limit(1);
  const [attempt] = await db.select().from(attempts).where(eq(attempts.id, result.attemptId)).limit(1);
  const vis = (await visibilityForResults([{ result, assessment: a, assignmentId: attempt?.assignmentId ?? null }], db)).get(result.id)!;
  const { version, questions } = await loadVersion(result.versionId, db);

  let reviewed: ReturnType<typeof reviewQuestions> = [];
  if (vis.showQuestions !== "NONE") {
    const items = await db.select().from(resultItems).where(eq(resultItems.resultId, result.id));
    reviewed = reviewQuestions(
      questions,
      attempt?.questionOrder ?? questions.map((q) => q.id),
      new Map(items.map((i) => [i.versionQuestionId, i])),
      await answersOf(result.attemptId, db),
      result.attemptId,
      {
        correctAnswers: vis.showCorrectAnswers,
        explanations: vis.showExplanations,
        filter: (s) => vis.showQuestions === "ALL" || s !== "CORRECT",
      },
    );
  }

  return {
    id: result.id,
    assessmentId: result.assessmentId,
    type: a.type,
    title: version.settings.title,
    completedAt: result.completedAt,
    durationSeconds: result.durationSeconds,
    released: vis.released,
    visibility: vis,
    ...(vis.released
      ? {
          totalPoints: result.totalPoints,
          earnedPoints: result.earnedPoints,
          percentage: result.percentage,
          correctCount: result.correctCount,
          wrongCount: result.wrongCount,
          unansweredCount: result.unansweredCount,
          pendingReviewCount: result.pendingReviewCount,
          penalty: await penaltyOf(result.id, db),
        }
      : {}),
    questions: reviewed,
  };
}

/** Student's assessment list with per-student effective window, attempts and released score. */
export async function studentAssessments(studentId: number) {
  const db = requireDb();
  const ids = await accessibleAssessmentIds(studentId);
  if (!ids.length) return [];
  const rows = await db.select().from(assessments).where(inArray(assessments.id, ids)).orderBy(desc(assessments.createdAt));
  const mine = await db
    .select({ a: attempts, result: results })
    .from(attempts)
    .leftJoin(results, eq(results.attemptId, attempts.id))
    .where(and(eq(attempts.studentId, studentId), inArray(attempts.assessmentId, ids)))
    .orderBy(desc(attempts.attemptNo));
  const withResults = mine.flatMap((m) =>
    m.result ? [{ result: m.result, assessment: rows.find((a) => a.id === m.a.assessmentId)!, assignmentId: m.a.assignmentId }] : [],
  );
  const vis = await visibilityForResults(withResults.filter((x) => x.assessment), db);
  const now = new Date();
  const out = [];
  const resolved = new Map<string, AssessmentAssignment>();
  for (const a of rows) {
    if (a.status === "DRAFT" || !a.currentVersionId) continue;
    const assignment = await resolveAssignment(a.id, studentId, db);
    if (assignment) resolved.set(a.id, assignment);
  }
  // Syllabus assessments are taken from inside their lesson, not from the general exam list.
  const syllabusOwned = await syllabusOwnedAssignments([...resolved.values()].map((x) => x.id), db);
  for (const a of rows) {
    const assignment = resolved.get(a.id);
    if (!assignment || syllabusOwned.has(assignment.id)) continue;
    const rules = effectiveRules(a, assignment, a.settings);
    const counted = mine.filter((m) => m.a.assessmentId === a.id && countsTowardLimit(m.a.status));
    const latest = counted[0];
    const latestVis = latest?.result ? vis.get(latest.result.id) : undefined;
    const resumable = latest?.a.status === "IN_PROGRESS" && !isExpired(latest.a, now) ? latest.a : null;
    out.push({
      ...summary(a, now),
      startAt: rules.startAt,
      endAt: rules.endAt,
      durationSeconds: rules.durationSeconds,
      attemptsAllowed: rules.attemptsAllowed,
      liveStatus: liveStatus({ status: a.status, startAt: rules.startAt, endAt: rules.endAt }, now),
      attemptId: latest?.a.id ?? null,
      attemptStatus: latest?.a.status ?? null,
      attemptsUsed: counted.length,
      resultId: latest?.result?.id ?? null,
      myPercentage: latestVis?.released ? (latest?.result?.percentage ?? null) : null,
      resume: resumable
        ? {
            answeredCount: resumable.answeredCount,
            totalQuestionCount: resumable.totalQuestionCount,
            remainingSeconds: Math.max(0, Math.round((resumable.deadlineAt.getTime() - now.getTime()) / 1000)),
          }
        : null,
    });
  }
  return out;
}

/** Student-facing detail page before starting: rules, window, attempts left. */
export async function studentAssessmentDetail(assessmentId: string, studentId: number) {
  const list = await studentAssessments(studentId);
  const item = list.find((x) => x.id === assessmentId);
  if (!item) throw new AppError("NO_ACCESS");
  const db = requireDb();
  const [a] = await db.select().from(assessments).where(eq(assessments.id, assessmentId)).limit(1);
  const { version, questions } = await loadVersion(a.currentVersionId!, db);
  return {
    ...item,
    description: version.settings.description,
    instructions: version.settings.instructions,
    questionCount: questions.length,
    totalPoints: round1(questions.reduce((s, q) => s + q.points, 0)),
    releaseMode: version.settings.releaseMode,
  };
}

/** Student's results list; score shown only when released. */
export async function studentResults(studentId: number) {
  const db = requireDb();
  const rows = await db
    .select({ result: results, assessment: assessments, assignmentId: attempts.assignmentId })
    .from(results)
    .innerJoin(assessments, eq(assessments.id, results.assessmentId))
    .innerJoin(attempts, eq(attempts.id, results.attemptId))
    .where(eq(results.studentId, studentId))
    .orderBy(desc(results.completedAt));
  const vis = await visibilityForResults(rows, db);
  return rows.map((r) => {
    const v = vis.get(r.result.id);
    return {
      id: r.result.id,
      assessmentId: r.assessment.id,
      type: r.assessment.type,
      title: r.assessment.settings.title,
      completedAt: r.result.completedAt,
      released: Boolean(v?.released),
      heldReason: v?.heldReason ?? null,
      percentage: v?.released ? r.result.percentage : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Teacher: results list, result detail and review of open answers
// ---------------------------------------------------------------------------

async function ownedResult(scope: TeacherScope, resultId: string, db: DbOrTx) {
  const [row] = await db
    .select({ r: results, a: assessments })
    .from(results)
    .innerJoin(assessments, eq(assessments.id, results.assessmentId))
    .where(and(eq(results.id, resultId), eq(assessments.providerWorkspaceId, scope.workspaceId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

export async function teacherResults(
  scope: TeacherScope,
  filter: { assessmentId?: string; studentId?: number; pendingOnly?: boolean },
) {
  const conds = [eq(assessments.providerWorkspaceId, scope.workspaceId)];
  if (filter.assessmentId) conds.push(eq(results.assessmentId, filter.assessmentId));
  if (filter.studentId) conds.push(eq(results.studentId, filter.studentId));
  const rows = await requireDb()
    .select({ r: results, a: assessments, studentName: users.name, attemptNo: attempts.attemptNo, attemptStatus: attempts.status })
    .from(results)
    .innerJoin(assessments, eq(assessments.id, results.assessmentId))
    .innerJoin(users, eq(users.id, results.studentId))
    .innerJoin(attempts, eq(attempts.id, results.attemptId))
    .where(and(...conds))
    .orderBy(desc(results.completedAt))
    .limit(500);
  return rows
    .filter((x) => (filter.pendingOnly ? x.r.pendingReviewCount > 0 : true))
    .map((x) => ({
      id: x.r.id,
      assessmentId: x.a.id,
      assessmentTitle: x.a.settings.title,
      type: x.a.type,
      studentId: x.r.studentId,
      studentName: x.studentName,
      attemptNo: x.attemptNo,
      versionId: x.r.versionId,
      latestVariant: !x.a.currentVersionId || x.r.versionId === x.a.currentVersionId,
      autoSubmitted: x.attemptStatus === "AUTO_SUBMITTED",
      percentage: x.r.percentage,
      earnedPoints: x.r.earnedPoints,
      totalPoints: x.r.totalPoints,
      pendingReviewCount: x.r.pendingReviewCount,
      durationSeconds: x.r.durationSeconds,
      completedAt: x.r.completedAt,
    }));
}

/** Full attempt review for the teacher: every answer, correct answers and manual grading targets. */
export async function resultForTeacher(scope: TeacherScope, resultId: string) {
  const db = requireDb();
  const { r: result, a } = await ownedResult(scope, resultId, db);
  const [attempt] = await db.select().from(attempts).where(eq(attempts.id, result.attemptId)).limit(1);
  const [student] = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, result.studentId));
  const { version, questions } = await loadVersion(result.versionId, db);
  const items = await db.select().from(resultItems).where(eq(resultItems.resultId, result.id));
  return {
    id: result.id,
    assessmentId: a.id,
    title: version.settings.title,
    versionNo: version.versionNo,
    latestVariant: !a.currentVersionId || result.versionId === a.currentVersionId,
    student,
    attemptNo: attempt?.attemptNo ?? 1,
    attemptStatus: attempt?.status ?? "SUBMITTED",
    startedAt: attempt?.startedAt ?? null,
    completedAt: result.completedAt,
    durationSeconds: result.durationSeconds,
    totalPoints: result.totalPoints,
    earnedPoints: result.earnedPoints,
    percentage: result.percentage,
    correctCount: result.correctCount,
    wrongCount: result.wrongCount,
    unansweredCount: result.unansweredCount,
    pendingReviewCount: result.pendingReviewCount,
    penalty: await penaltyOf(result.id, db),
    questions: reviewQuestions(
      questions,
      attempt?.questionOrder ?? questions.map((q) => q.id),
      new Map(items.map((i) => [i.versionQuestionId, i])),
      await answersOf(result.attemptId, db),
      result.attemptId,
      { correctAnswers: true, explanations: true, filter: () => true },
    ).map((q) => ({ ...q, reviewable: q.type === "LONG_ANSWER" && q.status !== "UNANSWERED" })),
  };
}

export async function pendingReviews(scope: TeacherScope, assessmentId?: string) {
  const db = requireDb();
  const conds = [eq(assessments.providerWorkspaceId, scope.workspaceId), eq(resultItems.status, "PENDING_REVIEW")];
  if (assessmentId) conds.push(eq(results.assessmentId, assessmentId));
  const rows = await db
    .select({
      resultId: results.id,
      attemptId: results.attemptId,
      assessmentTitle: assessments.settings,
      studentId: results.studentId,
      studentName: users.name,
      questionId: resultItems.versionQuestionId,
      questionText: versionQuestions.text,
      maxPoints: versionQuestions.points,
      earned: resultItems.earned,
      status: resultItems.status,
    })
    .from(resultItems)
    .innerJoin(results, eq(results.id, resultItems.resultId))
    .innerJoin(assessments, eq(assessments.id, results.assessmentId))
    .innerJoin(versionQuestions, eq(versionQuestions.id, resultItems.versionQuestionId))
    .innerJoin(users, eq(users.id, results.studentId))
    .where(and(...conds));
  const out = [];
  for (const r of rows) {
    const [ans] = await db
      .select({ answer: studentAnswers.answer })
      .from(studentAnswers)
      .where(and(eq(studentAnswers.attemptId, r.attemptId), eq(studentAnswers.versionQuestionId, r.questionId)))
      .limit(1);
    out.push({ ...r, assessmentTitle: r.assessmentTitle.title, answer: ans?.answer ?? null });
  }
  return out;
}

export async function gradeOpenAnswer(scope: TeacherScope, resultId: string, questionId: string, points: number) {
  const db = requireDb();
  const outcome = await db.transaction(async (tx) => {
    const { r: result } = await ownedResult(scope, resultId, tx);
    const { version, questions } = await loadVersion(result.versionId, tx);
    const q = questions.find((x) => x.id === questionId);
    if (!q) throw new AppError("UNKNOWN_QUESTION");
    if (q.type !== "LONG_ANSWER") throw new AppError("NOT_REVIEWABLE");
    if (!Number.isFinite(points) || points < 0 || points > q.points) throw new AppError("POINTS_OUT_OF_RANGE");
    const [item] = await tx
      .select()
      .from(resultItems)
      .where(and(eq(resultItems.resultId, resultId), eq(resultItems.versionQuestionId, questionId)))
      .for("update");
    if (!item || item.status === "UNANSWERED") throw new AppError("NOT_REVIEWABLE");

    await tx
      .update(resultItems)
      .set({ earned: points, status: points >= q.points ? "CORRECT" : "WRONG" })
      .where(and(eq(resultItems.resultId, resultId), eq(resultItems.versionQuestionId, questionId)));

    const items = await tx.select().from(resultItems).where(eq(resultItems.resultId, resultId));
    const totals = scoreItems(
      questions,
      items.map((i) => ({ questionId: i.versionQuestionId, status: i.status, earned: i.earned, topic: i.topic, skill: i.skill })),
      penaltyRule(version.settings),
    );
    if (totals.penalty) await savePenalty(tx, resultId, totals.penalty);
    await tx
      .update(results)
      .set({
        earnedPoints: round1(totals.earnedPoints),
        percentage: totals.percentage,
        correctCount: totals.correctCount,
        wrongCount: totals.wrongCount,
        unansweredCount: totals.unansweredCount,
        pendingReviewCount: totals.pendingReviewCount,
      })
      .where(eq(results.id, resultId));
    return { resultId, studentId: result.studentId, ...totals };
  });
  emitLearningEvent({ type: "ASSESSMENT_RESULT_CHANGED", resultId });
  if (outcome.pendingReviewCount === 0) await notifications.notify(outcome.studentId, "Yoxlama tamamlandı", "Açıq cavablarınız qiymətləndirildi");
  return outcome;
}

export type { Attempt };

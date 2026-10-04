import { and, asc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  assessmentAssignments,
  attempts,
  results,
  syllabusApprovals,
  syllabusAssessmentAssignments,
  syllabusCompletions,
  syllabusEnrollments,
  syllabusItemProgress,
  syllabusLessonProgress,
  syllabusManualUnlocks,
  syllabusModuleProgress,
  syllabusPracticeTasks,
  taskSubmissions,
  type Syllabus,
  type SyllabusEnrollment,
} from "../../drizzle/schema";
import { MAX_ATTEMPTS_LIMIT, TIMESTAMP_MIN, type UnlockTargetType } from "../../shared/syllabus";
import { requireDb, type DbOrTx, type Tx } from "../db";
import { AppError } from "../modules/errors";
import { onLearningEvent, type LearningEvent } from "../modules/learningEvents";
import { isMissingTable } from "../notifications/preferences";
import { logActivity, type ActivityRow } from "./activityLog";
import { allItems, availableAssessmentItems, computeProgress, grandfatheredLessons, locateItem, locateLesson } from "./engine";
import * as notify from "./notify";
import * as store from "./store";
import type { EngineInput, EngineOutput, ItemFact, PrevNode, VersionStructure } from "./types";

/**
 * Recompute = load facts → run the pure engine → write the diff (§8.2). Serialized per student by
 * a row lock on the enrollment; safe to run any number of times.
 */

export const cooldownUntil = (lastFinishedAt: Date | null, minutes: number) =>
  lastFinishedAt && minutes > 0 ? new Date(lastFinishedAt.getTime() + minutes * 60_000) : null;

/**
 * `availableFrom` of a syllabus assignment: the retry cooldown, otherwise "open now". Never null, so
 * the exam's own start date (meant for its group sitting) does not hold back syllabus students.
 */
export const syllabusAvailableFrom = (cooldown: Date | null) => cooldown ?? TIMESTAMP_MIN;

interface LoadedInput extends EngineInput {
  /** itemId → the per-student assessment assignment created for it. */
  jit: Map<string, { assignmentId: number; assessmentId: string; assessmentVersionId: string | null; availableFrom: Date | null; attemptLimitOverride: number | null }>;
  moduleRows: Map<string, typeof syllabusModuleProgress.$inferSelect>;
  lessonRows: Map<string, typeof syllabusLessonProgress.$inferSelect>;
  /** Approval decisions recorded so far (any target). */
  decisions: number;
}

export async function loadInput(e: SyllabusEnrollment, structure: VersionStructure, db: DbOrTx): Promise<LoadedInput> {
  const items = allItems(structure);
  const facts = new Map<string, ItemFact>();
  const fact = (id: string) => facts.get(id) ?? (facts.set(id, {}), facts.get(id)!);

  const [itemRows, moduleRows, lessonRows, unlocks, approvalRows, jitRows] = await Promise.all([
    db.select().from(syllabusItemProgress).where(eq(syllabusItemProgress.enrollmentId, e.id)),
    db.select().from(syllabusModuleProgress).where(eq(syllabusModuleProgress.enrollmentId, e.id)),
    db.select().from(syllabusLessonProgress).where(eq(syllabusLessonProgress.enrollmentId, e.id)),
    db.select().from(syllabusManualUnlocks).where(and(eq(syllabusManualUnlocks.enrollmentId, e.id), isNull(syllabusManualUnlocks.revokedAt))),
    db.select().from(syllabusApprovals).where(eq(syllabusApprovals.enrollmentId, e.id)).orderBy(asc(syllabusApprovals.createdAt)),
    db
      .select({ itemId: syllabusAssessmentAssignments.itemId, a: assessmentAssignments })
      .from(syllabusAssessmentAssignments)
      .innerJoin(assessmentAssignments, eq(assessmentAssignments.id, syllabusAssessmentAssignments.assignmentId))
      .where(eq(syllabusAssessmentAssignments.enrollmentId, e.id)),
  ]);

  for (const r of itemRows) {
    const f = fact(r.itemId);
    f.openedAt = r.openedAt;
    f.completedAt = r.completedAt;
    f.teacherMarkedAt = r.teacherMarkedAt;
  }

  const practice = items.filter((it) => it.kind === "STUDENT_PRACTICE" && it.taskId);
  if (practice.length) {
    const subs = await db
      .select()
      .from(taskSubmissions)
      .where(and(eq(taskSubmissions.studentId, e.studentId), inArray(taskSubmissions.taskId, practice.map((it) => it.taskId!))));
    for (const it of practice) {
      const s = subs.find((x) => x.taskId === it.taskId);
      if (s) fact(it.id).practice = { submittedAt: s.submittedAt, released: s.feedbackReleasedAt !== null, score: s.score };
    }
  }

  // Every attempt on the assessment counts, the same way startAttempt counts them against the limit.
  const assessed = items.filter((it) => it.kind === "ASSESSMENT" && it.assessmentId);
  if (assessed.length) {
    const ids = [...new Set(assessed.map((it) => it.assessmentId!))];
    const rows = await db
      .select({ a: attempts, r: results })
      .from(attempts)
      .leftJoin(results, eq(results.attemptId, attempts.id))
      .where(and(eq(attempts.studentId, e.studentId), inArray(attempts.assessmentId, ids)))
      .orderBy(asc(attempts.attemptNo));
    for (const it of assessed) {
      const mine = rows.filter((x) => x.a.assessmentId === it.assessmentId && x.a.status !== "VOIDED");
      const finished = mine.filter((x) => x.a.status !== "IN_PROGRESS");
      fact(it.id).assessment = {
        finished: finished.length,
        inProgress: mine.some((x) => x.a.status === "IN_PROGRESS"),
        outcomes: finished.flatMap((x) => (x.r ? [{ pct: x.r.percentage, pending: x.r.pendingReviewCount > 0 }] : [])),
        lastFinishedAt: finished.reduce<Date | null>((m, x) => {
          const at = x.r?.completedAt ?? x.a.submittedAt ?? x.a.deadlineAt;
          return !m || at > m ? at : m;
        }, null),
      };
    }
  }

  const latestDecision = new Map<string, string>();
  for (const a of approvalRows) latestDecision.set(`${a.targetType}:${a.targetId}`, a.decision);

  const prev = <T extends { status: string; unlockSource: string | null }>(rows: T[], key: (r: T) => string) =>
    new Map(rows.map((r) => [key(r), { status: r.status, unlockSource: r.unlockSource } as PrevNode]));

  return {
    structure,
    facts,
    prevModules: prev(moduleRows, (r) => r.moduleId),
    prevLessons: prev(lessonRows, (r) => r.lessonId),
    openedLessons: new Set(lessonRows.filter((r) => r.openedAt).map((r) => r.lessonId)),
    manualModules: new Set(unlocks.filter((u) => u.targetType === "MODULE").map((u) => u.targetId)),
    manualLessons: new Set(unlocks.filter((u) => u.targetType === "LESSON").map((u) => u.targetId)),
    approvals: new Set([...latestDecision].filter(([, d]) => d === "APPROVED").map(([k]) => k)),
    jit: new Map(
      jitRows.map((r) => [r.itemId, { assignmentId: r.a.id, assessmentId: r.a.assessmentId, assessmentVersionId: r.a.assessmentVersionId, availableFrom: r.a.availableFrom, attemptLimitOverride: r.a.attemptLimitOverride }]),
    ),
    moduleRows: new Map(moduleRows.map((r) => [r.moduleId, r])),
    lessonRows: new Map(lessonRows.map((r) => [r.lessonId, r])),
    decisions: approvalRows.length,
  };
}

const UNLOCKED = (s: string) => s !== "LOCKED";
const STARTED = (s: string) => s === "IN_PROGRESS" || s === "AWAITING_REVIEW" || s === "AWAITING_APPROVAL" || s === "COMPLETED";

async function writeProgress(tx: Tx, e: SyllabusEnrollment, input: LoadedInput, out: EngineOutput, now: Date) {
  for (const m of out.modules) {
    const row = input.moduleRows.get(m.id);
    const values = {
      status: m.status,
      unlockSource: m.unlockSource,
      unlockedAt: row?.unlockedAt ?? (UNLOCKED(m.status) ? now : null),
      startedAt: row?.startedAt ?? (STARTED(m.status) ? now : null),
      completedAt: row?.completedAt ?? (m.status === "COMPLETED" ? now : null),
      completedLessons: m.completedLessons,
      totalLessons: m.totalLessons,
    };
    if (!row) await tx.insert(syllabusModuleProgress).values({ enrollmentId: e.id, moduleId: m.id, syllabusId: e.syllabusId, ...values });
    else if (row.status !== m.status || row.unlockSource !== m.unlockSource || row.completedLessons !== m.completedLessons || row.totalLessons !== m.totalLessons) {
      await tx.update(syllabusModuleProgress).set(values).where(and(eq(syllabusModuleProgress.enrollmentId, e.id), eq(syllabusModuleProgress.moduleId, m.id)));
    }
  }
  for (const l of out.lessons) {
    const row = input.lessonRows.get(l.id);
    const requirements = { items: l.items.map((i) => ({ itemId: i.itemId, kind: i.kind, state: i.state })) };
    const theoryDone = l.items.filter((i) => i.kind === "THEORY").every((i) => i.state === "MET" || i.state === "NOT_REQUIRED");
    const values = {
      status: l.status,
      unlockSource: l.unlockSource,
      unlockedAt: row?.unlockedAt ?? (UNLOCKED(l.status) ? now : null),
      startedAt: row?.startedAt ?? (STARTED(l.status) ? now : null),
      completedAt: row?.completedAt ?? (l.status === "COMPLETED" ? now : null),
      theoryCompletedAt: row?.theoryCompletedAt ?? (UNLOCKED(l.status) && theoryDone && l.items.some((i) => i.kind === "THEORY") ? now : null),
      requirements,
    };
    if (!row) await tx.insert(syllabusLessonProgress).values({ enrollmentId: e.id, lessonId: l.id, syllabusId: e.syllabusId, moduleId: l.moduleId, ...values });
    else if (
      row.status !== l.status ||
      row.unlockSource !== l.unlockSource ||
      JSON.stringify(row.requirements ?? null) !== JSON.stringify(requirements) ||
      (values.theoryCompletedAt && !row.theoryCompletedAt)
    ) {
      await tx.update(syllabusLessonProgress).set(values).where(and(eq(syllabusLessonProgress.enrollmentId, e.id), eq(syllabusLessonProgress.lessonId, l.id)));
    }
  }
}

/** Just-in-time per-student assignment for every assessment item the student may start now (§9.2, §8.3). */
async function syncAssessmentAssignments(tx: Tx, e: SyllabusEnrollment, syllabus: Syllabus, input: LoadedInput, out: EngineOutput) {
  const evals = new Map([...out.lessons.flatMap((l) => l.items), ...out.modules.flatMap((m) => m.items), ...out.finalItems].map((x) => [x.itemId, x]));
  for (const item of availableAssessmentItems(input.structure, out)) {
    if (!item.assessmentVersionId) continue;
    const located = locateItem(input.structure, item.id);
    const retry = item.retry ?? located?.rules.retry ?? input.structure.rules.retry;
    const limit = retry.maxAttempts ?? MAX_ATTEMPTS_LIMIT;
    const met = evals.get(item.id)?.state === "MET";
    const from = syllabusAvailableFrom(met ? null : cooldownUntil(input.facts.get(item.id)?.assessment?.lastFinishedAt ?? null, retry.cooldownMinutes));
    let existing = input.jit.get(item.id);
    // The item points at another exam in this syllabus version: retire the old assignment.
    if (existing && existing.assessmentId !== item.assessmentId) {
      await tx.update(assessmentAssignments).set({ status: "REVOKED" }).where(eq(assessmentAssignments.id, existing.assignmentId));
      await tx.delete(syllabusAssessmentAssignments).where(eq(syllabusAssessmentAssignments.assignmentId, existing.assignmentId));
      existing = undefined;
    }
    if (!existing) {
      const [created] = await tx
        .insert(assessmentAssignments)
        .values({
          assessmentId: item.assessmentId!,
          assessmentVersionId: item.assessmentVersionId,
          studentId: e.studentId,
          attemptLimitOverride: limit,
          availableFrom: from,
          assignedBy: syllabus.createdBy,
        })
        .$returningId();
      await tx.insert(syllabusAssessmentAssignments).values({ assignmentId: created.id, syllabusId: e.syllabusId, enrollmentId: e.id, itemId: item.id });
    } else if (
      existing.assessmentVersionId !== item.assessmentVersionId ||
      existing.availableFrom?.getTime() !== from.getTime() ||
      existing.attemptLimitOverride !== limit
    ) {
      // A student moved to a newer syllabus version takes the exam version pinned there (in-progress attempts keep theirs).
      await tx
        .update(assessmentAssignments)
        .set({ assessmentVersionId: item.assessmentVersionId, availableFrom: from, attemptLimitOverride: limit, status: "ACTIVE" })
        .where(eq(assessmentAssignments.id, existing.assignmentId));
    }
  }
}

function bestFinalPct(input: LoadedInput) {
  const pcts = input.structure.finalItems.flatMap((it) => input.facts.get(it.id)?.assessment?.outcomes.filter((o) => !o.pending).map((o) => o.pct) ?? []);
  return pcts.length ? Math.max(...pcts) : null;
}

function transitionActivity(e: SyllabusEnrollment, syllabus: Syllabus, out: EngineOutput, completedNow: boolean): ActivityRow[] {
  const base = { userId: e.studentId, workspaceId: syllabus.providerWorkspaceId, syllabusId: e.syllabusId, versionId: e.versionId, source: "SERVER" as const };
  const rows: ActivityRow[] = [];
  for (const t of out.transitions) {
    const key = t.nodeType === "MODULE" ? { moduleId: t.id } : { lessonId: t.id, moduleId: out.lessons.find((l) => l.id === t.id)?.moduleId ?? null };
    if (t.from === "LOCKED" && t.to !== "LOCKED") rows.push({ ...base, ...key, activityType: t.nodeType === "MODULE" ? "MODULE_UNLOCKED" : "LESSON_UNLOCKED" });
    if (t.to === "COMPLETED") rows.push({ ...base, ...key, activityType: t.nodeType === "MODULE" ? "MODULE_COMPLETED" : "LESSON_COMPLETED" });
  }
  if (completedNow) rows.push({ ...base, activityType: "SYLLABUS_COMPLETED" });
  return rows;
}

export interface EnrollmentState {
  enrollment: SyllabusEnrollment;
  structure: VersionStructure;
  output: EngineOutput;
  /** What the student has done per item (scores, attempts); absent in some test doubles. */
  facts?: ReadonlyMap<string, ItemFact>;
}

export async function recompute(enrollmentId: string): Promise<EnrollmentState | null> {
  const db = requireDb();
  let activity: ActivityRow[] = [];
  let announce: (() => void) | null = null;
  const state = await db.transaction(async (tx): Promise<EnrollmentState | null> => {
    const [e] = await tx.select().from(syllabusEnrollments).where(eq(syllabusEnrollments.id, enrollmentId)).for("update");
    if (!e) return null;
    const [syllabus, version] = await Promise.all([store.syllabusById(e.syllabusId, tx), store.versionById(e.versionId, tx)]);
    if (!syllabus || !version) return null;
    const input = await loadInput(e, version.structure, tx);
    const out = computeProgress(input);
    const now = new Date();
    await writeProgress(tx, e, input, out, now);
    await syncAssessmentAssignments(tx, e, syllabus, input, out);

    const completedNow = out.syllabusCompleted && e.status !== "COMPLETED";
    if (completedNow) {
      await tx
        .insert(syllabusCompletions)
        .values({
          id: nanoid(),
          enrollmentId: e.id,
          syllabusId: e.syllabusId,
          versionId: e.versionId,
          studentId: e.studentId,
          completedAt: now,
          overallPct: out.progressPct,
          finalAssessmentPct: bestFinalPct(input),
          verificationCode: nanoid(20),
          snapshot: { syllabusTitle: syllabus.title, versionLabel: version.version.label, completedLessons: out.completedLessons, totalLessons: out.totalLessons },
        })
        .onDuplicateKeyUpdate({ set: { enrollmentId: e.id } });
    }
    const lastCompleted = [...out.transitions].reverse().find((t) => t.nodeType === "LESSON" && t.to === "COMPLETED");
    const changed =
      out.transitions.length > 0 ||
      e.progressPct !== out.progressPct ||
      e.completedLessons !== out.completedLessons ||
      e.totalLessons !== out.totalLessons ||
      e.currentLessonId !== out.currentLessonId;
    const next = {
      progressPct: out.progressPct,
      completedLessons: out.completedLessons,
      totalLessons: out.totalLessons,
      currentModuleId: out.currentModuleId,
      currentLessonId: out.currentLessonId,
      lastCompletedLessonId: lastCompleted?.id ?? e.lastCompletedLessonId,
      status: out.syllabusCompleted || e.status === "COMPLETED" ? ("COMPLETED" as const) : ("ACTIVE" as const),
      completedAt: e.completedAt ?? (out.syllabusCompleted ? now : null),
      dirtyAt: null,
      stateRevision: e.stateRevision + (changed ? 1 : 0),
    };
    await tx.update(syllabusEnrollments).set(next).where(eq(syllabusEnrollments.id, e.id));
    activity = transitionActivity(e, syllabus, out, completedNow);
    const enrollment = { ...e, ...next };
    announce = () => notify.afterRecompute(enrollment, syllabus, version.structure, out, completedNow, input.decisions);
    return { enrollment, structure: version.structure, output: out, facts: input.facts };
  });
  await logActivity(activity);
  (announce as (() => void) | null)?.();
  return state;
}

/** State for a read: evaluated without a lock, persisted only when something changed. */
export async function current(enrollment: SyllabusEnrollment): Promise<EnrollmentState | null> {
  const version = await store.versionById(enrollment.versionId);
  if (!version) return null;
  const input = await loadInput(enrollment, version.structure, requireDb());
  const out = computeProgress(input);
  const needsWrite = enrollment.dirtyAt !== null || out.transitions.length > 0 || out.lessons.some((l) => !input.lessonRows.has(l.id));
  if (needsWrite) return recompute(enrollment.id);
  return { enrollment, structure: version.structure, output: out, facts: input.facts };
}

export async function markDirty(enrollmentIds: readonly string[], db: DbOrTx = requireDb()) {
  if (!enrollmentIds.length) return;
  await db.update(syllabusEnrollments).set({ dirtyAt: new Date() }).where(inArray(syllabusEnrollments.id, [...enrollmentIds]));
}

/** Facts changed outside a request (grading, AI, sweeper): flag first so the reconciler can finish a crashed run. */
export async function touch(enrollmentIds: readonly string[]) {
  if (!enrollmentIds.length) return;
  await markDirty(enrollmentIds);
  for (const id of new Set(enrollmentIds)) await recompute(id);
}

// ---------------------------------------------------------------------------
// Enrollment and version moves
// ---------------------------------------------------------------------------

export async function enroll(syllabus: Syllabus, studentId: number, viaGroupId: string | null) {
  if (!syllabus.currentVersionId) throw new AppError("SYLLABUS_NOT_PUBLISHED");
  const db = requireDb();
  const existing = await store.enrollmentOf(syllabus.id, studentId);
  if (existing) return existing;
  await db
    .insert(syllabusEnrollments)
    .values({ id: nanoid(), syllabusId: syllabus.id, studentId, versionId: syllabus.currentVersionId, viaGroupId, startedAt: new Date() })
    .onDuplicateKeyUpdate({ set: { studentId } });
  const row = await store.enrollmentOf(syllabus.id, studentId);
  if (!row) throw new AppError("NOT_FOUND");
  await logActivity([{ userId: studentId, workspaceId: syllabus.providerWorkspaceId, syllabusId: syllabus.id, versionId: row.versionId, groupId: viaGroupId, activityType: "SYLLABUS_STARTED", source: "SERVER" }]);
  return row;
}

/**
 * Moves an enrollment to another version of the same syllabus. Completed nodes stay completed
 * (ids are stable); new lessons before the student's frontier become optional (GRANDFATHERED).
 */
export async function moveEnrollment(enrollment: SyllabusEnrollment, versionId: string, workspaceId: string) {
  if (enrollment.versionId === versionId) return { moved: false };
  const db = requireDb();
  const version = await store.versionById(versionId);
  if (!version || version.version.syllabusId !== enrollment.syllabusId) throw new AppError("SYLLABUS_INVALID_TARGET");
  const lessonRows = await db.select().from(syllabusLessonProgress).where(eq(syllabusLessonProgress.enrollmentId, enrollment.id));
  const prev = new Map(lessonRows.map((r) => [r.lessonId, { status: r.status, unlockSource: r.unlockSource } as PrevNode]));
  const optional = grandfatheredLessons(version.structure, prev);
  const now = new Date();
  await db.transaction(async (tx) => {
    for (const lessonId of optional) {
      const found = locateLesson(version.structure, lessonId);
      if (!found) continue;
      await tx.insert(syllabusLessonProgress).values({
        enrollmentId: enrollment.id,
        lessonId,
        syllabusId: enrollment.syllabusId,
        moduleId: found.module.id,
        status: "AVAILABLE",
        unlockSource: "GRANDFATHERED",
        unlockedAt: now,
      });
    }
    await tx
      .update(syllabusEnrollments)
      .set({ versionId, upgradedFromVersionId: enrollment.versionId, dirtyAt: now })
      .where(eq(syllabusEnrollments.id, enrollment.id));
  });
  await logActivity([
    { userId: enrollment.studentId, workspaceId, syllabusId: enrollment.syllabusId, versionId, activityType: "VERSION_UPGRADED", source: "SERVER", metadata: { from: enrollment.versionId, grandfathered: optional.size } },
  ]);
  await recompute(enrollment.id);
  return { moved: true, grandfathered: optional.size };
}

// ---------------------------------------------------------------------------
// Manual unlocks and approvals
// ---------------------------------------------------------------------------

/** Runs inside the transaction that writes the unlock row (the admin path appends its audit entry here). */
type InTx = (tx: Tx, rowId: string) => Promise<void>;

export async function addManualUnlock(
  input: {
    enrollment: SyllabusEnrollment;
    workspaceId: string;
    targetType: UnlockTargetType;
    targetId: string;
    reason: string;
    actorUserId: number;
    actorKind: "TEACHER" | "ADMIN";
  },
  inTx?: InTx,
) {
  const { enrollment: e } = input;
  const version = await store.versionById(e.versionId);
  const exists =
    input.targetType === "MODULE"
      ? version?.structure.modules.some((m) => m.id === input.targetId)
      : version
        ? locateLesson(version.structure, input.targetId) !== null
        : false;
  if (!exists) throw new AppError("SYLLABUS_INVALID_TARGET");
  const id = nanoid();
  await requireDb().transaction(async (tx) => {
    await tx
      .insert(syllabusManualUnlocks)
      .values({ id, syllabusId: e.syllabusId, enrollmentId: e.id, studentId: e.studentId, targetType: input.targetType, targetId: input.targetId, reason: input.reason, unlockedBy: input.actorUserId, actorKind: input.actorKind });
    if (inTx) await inTx(tx, id);
  });
  await logActivity([
    {
      userId: e.studentId,
      workspaceId: input.workspaceId,
      syllabusId: e.syllabusId,
      versionId: e.versionId,
      ...(input.targetType === "MODULE" ? { moduleId: input.targetId } : { lessonId: input.targetId }),
      activityType: "MANUAL_UNLOCK",
      source: "SERVER",
      metadata: { unlockId: id, actorKind: input.actorKind, actorUserId: input.actorUserId },
    },
  ]);
  await recompute(e.id);
  return { id };
}

export async function revokeManualUnlock(unlockId: string, enrollmentId: string, actorUserId: number, inTx?: InTx) {
  const db = requireDb();
  const [row] = await db
    .select()
    .from(syllabusManualUnlocks)
    .where(and(eq(syllabusManualUnlocks.id, unlockId), eq(syllabusManualUnlocks.enrollmentId, enrollmentId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  if (!row.revokedAt) {
    await db.transaction(async (tx) => {
      await tx.update(syllabusManualUnlocks).set({ revokedAt: new Date(), revokedBy: actorUserId }).where(eq(syllabusManualUnlocks.id, unlockId));
      if (inTx) await inTx(tx, unlockId);
    });
    await recompute(enrollmentId);
  }
  return row;
}

export async function manualUnlocksOf(enrollmentId: string) {
  return requireDb().select().from(syllabusManualUnlocks).where(eq(syllabusManualUnlocks.enrollmentId, enrollmentId)).orderBy(asc(syllabusManualUnlocks.createdAt));
}

// ---------------------------------------------------------------------------
// Hooks (after-commit, best effort) and the reconciler
// ---------------------------------------------------------------------------

async function enrollmentsForSubmission(submissionId: string) {
  const db = requireDb();
  const [sub] = await db.select({ taskId: taskSubmissions.taskId, studentId: taskSubmissions.studentId }).from(taskSubmissions).where(eq(taskSubmissions.id, submissionId)).limit(1);
  if (!sub) return [];
  const links = await db.select({ syllabusId: syllabusPracticeTasks.syllabusId }).from(syllabusPracticeTasks).where(eq(syllabusPracticeTasks.taskId, sub.taskId));
  if (!links.length) return [];
  const rows = await db
    .select({ id: syllabusEnrollments.id })
    .from(syllabusEnrollments)
    .where(and(eq(syllabusEnrollments.studentId, sub.studentId), inArray(syllabusEnrollments.syllabusId, links.map((l) => l.syllabusId))));
  return rows.map((r) => r.id);
}

async function enrollmentsForAttempt(attemptId: string) {
  const db = requireDb();
  const [a] = await db.select({ assessmentId: attempts.assessmentId, studentId: attempts.studentId }).from(attempts).where(eq(attempts.id, attemptId)).limit(1);
  if (!a) return [];
  const rows = await db
    .select({ id: syllabusAssessmentAssignments.enrollmentId })
    .from(syllabusAssessmentAssignments)
    .innerJoin(assessmentAssignments, eq(assessmentAssignments.id, syllabusAssessmentAssignments.assignmentId))
    .where(and(eq(assessmentAssignments.assessmentId, a.assessmentId), eq(assessmentAssignments.studentId, a.studentId)));
  return [...new Set(rows.map((r) => r.id))];
}

/** The per-student assignment this enrollment's assessment item runs on (created when the item unlocks). */
export async function assignmentForItem(enrollmentId: string, itemId: string): Promise<number | null> {
  const [row] = await requireDb()
    .select({ id: syllabusAssessmentAssignments.assignmentId })
    .from(syllabusAssessmentAssignments)
    .where(and(eq(syllabusAssessmentAssignments.enrollmentId, enrollmentId), eq(syllabusAssessmentAssignments.itemId, itemId)))
    .limit(1);
  return row?.id ?? null;
}

export async function handleLearningEvent(event: LearningEvent) {
  try {
    let ids: string[] = [];
    if (event.type === "TASK_SUBMISSION_CHANGED") ids = await enrollmentsForSubmission(event.submissionId);
    else if (event.type === "ATTEMPT_FINISHED") ids = await enrollmentsForAttempt(event.attemptId);
    else {
      const [r] = await requireDb().select({ attemptId: results.attemptId }).from(results).where(eq(results.id, event.resultId)).limit(1);
      if (r) ids = await enrollmentsForAttempt(r.attemptId);
    }
    await touch(ids);
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
}

let hooksInstalled = false;
export function installSyllabusHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  onLearningEvent(handleLearningEvent);
}

/** Recomputes enrollments a crashed or interrupted hook left dirty for more than `olderThanMs`. */
export async function reconcileDirty(limit = 50, olderThanMs = 60_000) {
  try {
    const rows = await requireDb()
      .select({ id: syllabusEnrollments.id })
      .from(syllabusEnrollments)
      .where(and(isNotNull(syllabusEnrollments.dirtyAt), lte(syllabusEnrollments.dirtyAt, new Date(Date.now() - olderThanMs))))
      .limit(limit);
    for (const r of rows) await recompute(r.id);
    return rows.length;
  } catch (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
}

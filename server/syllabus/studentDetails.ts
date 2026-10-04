import { and, eq, inArray } from "drizzle-orm";
import {
  assessments,
  attempts,
  materials,
  results,
  submissionAiReviews,
  syllabusLessonProgress,
  syllabusModuleProgress,
  taskSubmissions,
} from "../../drizzle/schema";
import { MAX_ATTEMPTS_LIMIT, type RetryPolicy, type SyllabusGrantState } from "../../shared/syllabus";
import { requireDb } from "../db";
import { visibilityForResults } from "../modules/attempts";
import { autoGradeEnabledForTasks } from "../modules/autoGrade";
import { AppError } from "../modules/errors";
import { activeGroupIdsOfStudent } from "../modules/groups";
import { pendingState, studentSubmissionView } from "../modules/tasks";
import { bestGrantState } from "./accessRules";
import { contentRefs } from "./authoring";
import { syllabusEnabledFor } from "./availability";
import { allItems, locateItem } from "./engine";
import { cooldownUntil } from "./progression";
import * as store from "./store";
import type { EngineOutput, ItemFact, ItemStub, VersionStructure } from "./types";

/** Extra per-item data of the lesson player and the progress panel. Every read is the student's own. */

// ---------------------------------------------------------------------------
// Assessment attempts (score shown only when the assessment's release rule allows it)
// ---------------------------------------------------------------------------

export interface AttemptRow {
  attemptId: string;
  attemptNo: number;
  status: string;
  resultId: string | null;
  /** null while the result is withheld (release rule) or not graded yet. */
  pct: number | null;
  held: boolean;
  pending: boolean;
  finishedAt: Date | null;
}

export async function attemptsOf(studentId: number, assessmentIds: readonly string[]) {
  const out = new Map<string, AttemptRow[]>();
  if (!assessmentIds.length) return out;
  const db = requireDb();
  const rows = await db
    .select({ a: attempts, r: results, assessment: assessments })
    .from(attempts)
    .innerJoin(assessments, eq(assessments.id, attempts.assessmentId))
    .leftJoin(results, eq(results.attemptId, attempts.id))
    .where(and(eq(attempts.studentId, studentId), inArray(attempts.assessmentId, [...new Set(assessmentIds)])));
  const vis = await visibilityForResults(
    rows.flatMap((x) => (x.r ? [{ result: x.r, assessment: x.assessment, assignmentId: x.a.assignmentId }] : [])),
    db,
  );
  for (const x of rows.sort((p, q) => p.a.attemptNo - q.a.attemptNo)) {
    if (x.a.status === "VOIDED") continue;
    const released = x.r ? (vis.get(x.r.id)?.released ?? false) : false;
    const list = out.get(x.a.assessmentId) ?? [];
    list.push({
      attemptId: x.a.id,
      attemptNo: x.a.attemptNo,
      status: x.a.status,
      resultId: x.r?.id ?? null,
      pct: x.r && released ? Math.round(x.r.percentage * 10) / 10 : null,
      held: !!x.r && !released,
      pending: (x.r?.pendingReviewCount ?? 0) > 0,
      finishedAt: x.r?.completedAt ?? x.a.submittedAt ?? null,
    });
    out.set(x.a.assessmentId, list);
  }
  return out;
}

/** Pure: what the lesson player shows for one assessment item. */
export function assessmentState(
  item: Pick<ItemStub, "passPct" | "retry">,
  rules: { assessmentPassPct: number; retry: RetryPolicy },
  rows: readonly AttemptRow[],
  available: boolean,
  now: Date,
) {
  const retry = item.retry ?? rules.retry;
  const passPct = item.passPct ?? rules.assessmentPassPct;
  const finished = rows.filter((r) => r.status !== "IN_PROGRESS");
  const inProgress = rows.find((r) => r.status === "IN_PROGRESS") ?? null;
  const shown = finished.flatMap((r) => (r.pct === null ? [] : [r.pct]));
  const lastFinishedAt = finished.reduce<Date | null>((m, r) => (r.finishedAt && (!m || r.finishedAt > m) ? r.finishedAt : m), null);
  const maxAttempts = retry.maxAttempts ?? MAX_ATTEMPTS_LIMIT;
  const cooldown = cooldownUntil(lastFinishedAt, retry.cooldownMinutes);
  const waiting = cooldown && cooldown > now ? cooldown : null;
  const left = Math.max(0, maxAttempts - finished.length);
  return {
    passPct,
    maxAttempts: retry.maxAttempts,
    scorePolicy: retry.scorePolicy,
    cooldownMinutes: retry.cooldownMinutes,
    used: finished.length,
    left,
    bestPct: shown.length ? Math.max(...shown) : null,
    latestPct: finished.length ? finished[finished.length - 1].pct : null,
    inProgressAttemptId: inProgress?.attemptId ?? null,
    cooldownUntil: waiting,
    canStart: available && (!!inProgress || (left > 0 && !waiting)),
    attempts: finished.map((r) => ({ attemptNo: r.attemptNo, resultId: r.resultId, pct: r.pct, held: r.held, pending: r.pending, finishedAt: r.finishedAt })),
  };
}

// ---------------------------------------------------------------------------
// Practice submission (the existing task core's student view: grade, AI feedback, pending state)
// ---------------------------------------------------------------------------

export async function practiceSubmissions(studentId: number, taskIds: readonly string[]) {
  const out = new Map<string, ReturnType<typeof studentSubmissionView>>();
  if (!taskIds.length) return out;
  const db = requireDb();
  const subs = await db.select().from(taskSubmissions).where(and(eq(taskSubmissions.studentId, studentId), inArray(taskSubmissions.taskId, [...taskIds])));
  if (!subs.length) return out;
  const reviews = await db
    .select({ submissionId: submissionAiReviews.submissionId, status: submissionAiReviews.status, createdAt: submissionAiReviews.createdAt, feedback: submissionAiReviews.feedback, details: submissionAiReviews.details })
    .from(submissionAiReviews)
    .where(inArray(submissionAiReviews.submissionId, subs.map((s) => s.id)));
  const auto = await autoGradeEnabledForTasks(subs.filter((s) => !s.feedbackReleasedAt).map((s) => s.taskId));
  const now = Date.now();
  for (const s of subs) {
    const review = reviews.find((r) => r.submissionId === s.id);
    out.set(s.taskId, studentSubmissionView(s, review, pendingState(s, review, auto.has(s.taskId), now)));
  }
  return out;
}

/** Pure: the due date of a practice deadline (relative = days after the lesson opened for this student). */
export function practiceDueAt(deadline: unknown, lessonUnlockedAt: Date | null): Date | null {
  const d = deadline as { type?: string; days?: number; at?: string | Date } | undefined;
  if (d?.type === "ABSOLUTE" && d.at) {
    const at = new Date(d.at);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  if (d?.type === "RELATIVE_DAYS" && d.days && lessonUnlockedAt) return new Date(lessonUnlockedAt.getTime() + d.days * 86_400_000);
  return null;
}

export async function lessonUnlockedAt(enrollmentId: string, lessonId: string) {
  const [row] = await requireDb()
    .select({ unlockedAt: syllabusLessonProgress.unlockedAt })
    .from(syllabusLessonProgress)
    .where(and(eq(syllabusLessonProgress.enrollmentId, enrollmentId), eq(syllabusLessonProgress.lessonId, lessonId)))
    .limit(1);
  return row?.unlockedAt ?? null;
}

// ---------------------------------------------------------------------------
// Materials referenced by items (shown by reference, never copied)
// ---------------------------------------------------------------------------

export async function referencedMaterials(workspaceId: string, contents: ReadonlyArray<{ kind: ItemStub["kind"]; content: Record<string, unknown> }>) {
  const ids = [...new Set(contents.flatMap((c) => contentRefs(c.kind, c.content).materialIds))];
  if (!ids.length) return [];
  return requireDb()
    .select({ id: materials.id, title: materials.title, fileId: materials.fileId })
    .from(materials)
    .where(and(inArray(materials.id, ids), eq(materials.providerWorkspaceId, workspaceId)));
}

// ---------------------------------------------------------------------------
// Progress panel
// ---------------------------------------------------------------------------

/** Pure: counts and the assessment items worth listing (open now, or already attempted). Names only for open nodes. */
export function progressSummary(structure: VersionStructure, out: EngineOutput, facts: ReadonlyMap<string, ItemFact> | undefined) {
  const evals = new Map([...out.lessons.flatMap((l) => l.items), ...out.modules.flatMap((m) => m.items), ...out.finalItems].map((e) => [e.itemId, e]));
  const openLessons = new Set(out.lessons.filter((l) => l.status !== "LOCKED").map((l) => l.id));
  const lessonItems = structure.modules.flatMap((m) => m.lessons.flatMap((l) => l.items.map((it) => ({ it, lessonId: l.id }))));
  const practice = lessonItems.filter((x) => x.it.kind === "STUDENT_PRACTICE");
  const theory = lessonItems.filter((x) => x.it.kind === "THEORY");
  const count = (list: typeof lessonItems, pred: (s: string | undefined, f: ItemFact | undefined, id: string) => boolean) =>
    list.filter((x) => pred(evals.get(x.it.id)?.state, facts?.get(x.it.id), x.it.id)).length;
  const assessmentsList = allItems(structure)
    .filter((it) => it.kind === "ASSESSMENT")
    .flatMap((it) => {
      const where = locateItem(structure, it.id)!;
      const ev = evals.get(it.id);
      const attempted = (facts?.get(it.id)?.assessment?.finished ?? 0) > 0;
      const open = where.lesson ? openLessons.has(where.lesson.id) : !!ev?.available;
      if (!open && !attempted) return [];
      return [{ itemId: it.id, assessmentId: it.assessmentId, title: it.title, scope: it.scope, lessonId: where.lesson?.id ?? null, moduleId: where.module?.id ?? null, state: ev?.state ?? "UNMET" }];
    });
  return {
    practice: {
      total: practice.length,
      completed: count(practice, (s) => s === "MET"),
      pending: count(practice, (s) => s === "PENDING"),
      submitted: count(practice, (_s, f) => !!f?.practice?.submittedAt),
    },
    theory: { total: theory.length, completed: count(theory, (s, f) => s === "MET" || !!f?.completedAt) },
    assessments: assessmentsList,
  };
}

// ---------------------------------------------------------------------------
// Ended access: progress stays visible, content is closed
// ---------------------------------------------------------------------------

export async function endedView(userId: number, syllabusId: string) {
  const syllabus = await store.syllabusById(syllabusId);
  if (!syllabus || !(await syllabusEnabledFor(syllabus.providerWorkspaceId))) throw new AppError("NOT_FOUND");
  const groupIds = await activeGroupIdsOfStudent(userId);
  const grants = await store.grantsForSyllabus(syllabusId);
  const access: SyllabusGrantState | null = bestGrantState(grants, userId, groupIds, new Date());
  const enrollment = await store.enrollmentOf(syllabusId, userId);
  if (!access && !enrollment) throw new AppError("NOT_FOUND");
  const startsAt =
    access === "PENDING"
      ? (grants.map((g) => g.startsAt).filter((d): d is Date => !!d && d.getTime() > Date.now()).sort((a, b) => a.getTime() - b.getTime())[0] ?? null)
      : null;
  const head = { id: syllabus.id, title: syllabus.title, description: syllabus.description ?? "", subject: syllabus.subject, level: syllabus.level };
  if (!enrollment) return { syllabus: head, access, startsAt, progress: null, modules: [], completion: null };
  const db = requireDb();
  const [version, moduleRows, lessonRows, completion] = await Promise.all([
    store.versionById(enrollment.versionId),
    db.select().from(syllabusModuleProgress).where(eq(syllabusModuleProgress.enrollmentId, enrollment.id)),
    db.select().from(syllabusLessonProgress).where(eq(syllabusLessonProgress.enrollmentId, enrollment.id)),
    store.completionOf(enrollment.id),
  ]);
  return {
    syllabus: head,
    access,
    startsAt,
    progress: {
      progressPct: enrollment.progressPct,
      completedLessons: enrollment.completedLessons,
      totalLessons: enrollment.totalLessons,
      completed: enrollment.status === "COMPLETED",
      lastActivityAt: enrollment.lastActivityAt,
    },
    modules: (version?.structure.modules ?? []).map((m) => {
      const mr = moduleRows.find((r) => r.moduleId === m.id);
      return {
        id: m.id,
        title: m.title,
        status: mr?.status ?? "LOCKED",
        completedLessons: mr?.completedLessons ?? 0,
        totalLessons: mr?.totalLessons ?? m.lessons.length,
        lessons: m.lessons.map((l) => ({ id: l.id, title: l.title, status: lessonRows.find((r) => r.lessonId === l.id)?.status ?? "LOCKED" })),
      };
    }),
    completion: completion ? completionView(completion, version?.version.label ?? "") : null,
  };
}

export function completionView(c: NonNullable<Awaited<ReturnType<typeof store.completionOf>>>, versionLabel: string) {
  return {
    completedAt: c.completedAt,
    overallPct: c.overallPct,
    finalAssessmentPct: c.finalAssessmentPct,
    verificationCode: c.verificationCode,
    versionLabel: (c.snapshot as { versionLabel?: string } | null)?.versionLabel ?? versionLabel,
  };
}

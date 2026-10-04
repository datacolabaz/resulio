import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { submissionAiReviews, submissionGrading, taskGradingSettings, taskSubmissions, tasks, users, type SubmissionGrading } from "../../drizzle/schema";
import { serverLocale } from "../_core/locale";
import { requireDb } from "../db";
import { dispatch, setSendGuard } from "../notifications/dispatcher";
import { isMissingTable } from "../notifications/preferences";
import { cleanAiFeedback, formatAiGradeFeedback } from "../notifications/templates";
import type { TeacherScope } from "./access";
import { AppError } from "./errors";
import { recordAnnouncedScore } from "./gradeEmail";
import { emitLearningEvent } from "./learningEvents";

/**
 * Automatic grading: when a task has auto-grade on (the default) and the AI review of a
 * submission finishes cleanly, its score and feedback become the student's released grade at once.
 * Anything doubtful is left to the teacher. A teacher's grade always wins over the AI's.
 */

/** Grades are on a 0–100 scale with one decimal, for teachers and the AI alike. */
export const clampScore = (n: number) => Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;

export type AutoGradeBlock =
  | "EMPTY"
  | "CHECKS_FAILED"
  | "UNREADABLE_FILE"
  | "INJECTION_SUSPECTED"
  | "AI_NOT_DONE"
  | "NO_FEEDBACK"
  | "AI_ASKED_TEACHER";

export interface ReviewForGrading {
  status: string;
  checks: Array<{ code: string; level: string }>;
  feedback: string | null;
  suggestedScore: number | null;
  needsTeacherReview: boolean;
}

/** Why this review must not be released automatically, or null if it may be. */
export function autoGradeBlockedBy(review: ReviewForGrading): AutoGradeBlock | null {
  const codes = new Set(review.checks.map((c) => c.code));
  if (codes.has("NO_CONTENT")) return "EMPTY";
  if (review.checks.some((c) => c.level === "fail")) return "CHECKS_FAILED";
  if (codes.has("TEXT_NOT_EXTRACTABLE")) return "UNREADABLE_FILE";
  if (codes.has("INJECTION_SUSPECTED")) return "INJECTION_SUSPECTED";
  if (review.status !== "DONE" || review.suggestedScore === null || !Number.isFinite(review.suggestedScore)) return "AI_NOT_DONE";
  if (!review.feedback?.trim()) return "NO_FEEDBACK";
  if (review.needsTeacherReview) return "AI_ASKED_TEACHER";
  return null;
}

export type GradeOwner = "NONE" | "AI" | "TEACHER";

/** A teacher's save always records the teacher; an AI grade has no user. */
export function gradeOwner(s: { gradedAt: Date | null; gradedByUserId: number | null }): GradeOwner {
  if (!s.gradedAt) return "NONE";
  return s.gradedByUserId === null ? "AI" : "TEACHER";
}

export type AutoGradeAction =
  | { kind: "SKIP"; why: "DISABLED" | "TEACHER_GRADED" | "KEEP_AI_GRADE" }
  | { kind: "NEEDS_TEACHER"; reason: AutoGradeBlock }
  | { kind: "RELEASE"; score: number }
  | { kind: "REGRADE"; score: number; scoreChanged: boolean };

export function planAutoGrade(input: { enabled: boolean; owner: GradeOwner; block: AutoGradeBlock | null; currentScore: number | null; aiScore: number | null }): AutoGradeAction {
  if (!input.enabled) return { kind: "SKIP", why: "DISABLED" };
  if (input.owner === "TEACHER") return { kind: "SKIP", why: "TEACHER_GRADED" };
  if (input.block || input.aiScore === null) {
    // A rerun that fails or is doubtful does not take back a grade the student already has.
    return input.owner === "AI" ? { kind: "SKIP", why: "KEEP_AI_GRADE" } : { kind: "NEEDS_TEACHER", reason: input.block ?? "AI_NOT_DONE" };
  }
  const score = clampScore(input.aiScore);
  if (input.owner === "AI") return { kind: "REGRADE", score, scoreChanged: input.currentScore !== score };
  return { kind: "RELEASE", score };
}

/**
 * A teacher re-saving an AI grade with the same score but new feedback: one "updated" notice.
 * (A changed score is announced by the grade e-mail flow already.)
 */
export function aiOverrideNeedsNotice(
  before: { owner: GradeOwner; released: boolean; score: number | null; feedback: string | null },
  after: { release: boolean; score: number | null; feedback: string | null },
): boolean {
  if (before.owner !== "AI" || !before.released || !after.release || before.score !== after.score) return false;
  return (before.feedback ?? "").trim() !== (after.feedback ?? "").trim();
}

export const aiGradeDedupeKey = (submissionId: string) => `ai-grade:${submissionId}`;
export const aiRegradeDedupeKey = (submissionId: string, runId: string) => `ai-regrade:${submissionId}:${runId}`;

// ---------------------------------------------------------------------------
// Per-task setting
// ---------------------------------------------------------------------------

/** `available` is false until migration 0024 runs; auto-grade is then off (teacher approval as before). */
export async function autoGradeSetting(taskId: string): Promise<{ enabled: boolean; available: boolean }> {
  try {
    const [row] = await requireDb().select({ enabled: taskGradingSettings.autoGrade }).from(taskGradingSettings).where(eq(taskGradingSettings.taskId, taskId)).limit(1);
    return { enabled: row?.enabled ?? true, available: true };
  } catch (error) {
    if (isMissingTable(error)) return { enabled: false, available: false };
    throw error;
  }
}

export async function autoGradeEnabledForTasks(taskIds: string[]): Promise<Set<string>> {
  if (!taskIds.length) return new Set();
  try {
    const rows = await requireDb().select({ taskId: taskGradingSettings.taskId, enabled: taskGradingSettings.autoGrade }).from(taskGradingSettings);
    const off = new Set(rows.filter((r) => !r.enabled).map((r) => r.taskId));
    return new Set(taskIds.filter((id) => !off.has(id)));
  } catch (error) {
    if (isMissingTable(error)) return new Set();
    throw error;
  }
}

export async function setAutoGrade(scope: TeacherScope, taskId: string, enabled: boolean) {
  const db = requireDb();
  const [task] = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.providerWorkspaceId, scope.workspaceId))).limit(1);
  if (!task) throw new AppError("NOT_FOUND");
  try {
    await db.insert(taskGradingSettings).values({ taskId, autoGrade: enabled }).onDuplicateKeyUpdate({ set: { autoGrade: enabled } });
  } catch (error) {
    if (isMissingTable(error)) throw new AppError("DATABASE_UNAVAILABLE");
    throw error;
  }
  return { autoGrade: enabled };
}

// ---------------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------------

type GradingPatch = Partial<Pick<SubmissionGrading, "source" | "autoStatus" | "autoReason" | "aiScore" | "reviewRunId">>;

/** Best effort: false if the table is not migrated yet. */
async function writeGrading(submissionId: string, patch: GradingPatch): Promise<boolean> {
  try {
    await requireDb().insert(submissionGrading).values({ submissionId, ...patch }).onDuplicateKeyUpdate({ set: patch });
    return true;
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

/** Records that the teacher now owns this grade (never throws for a missing table). */
export function recordTeacherGrade(submissionId: string) {
  return writeGrading(submissionId, { source: "TEACHER", autoStatus: null, autoReason: null });
}

async function gradingTableReady(): Promise<boolean> {
  try {
    await requireDb().select({ id: submissionGrading.submissionId }).from(submissionGrading).limit(1);
    return true;
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/**
 * Runs after the AI review run `runId` finished. Releases, updates, or leaves the grade to the
 * teacher per `planAutoGrade`. Every write is conditional so a teacher's concurrent save wins.
 */
export async function applyAutoGrade(submissionId: string, runId: string): Promise<AutoGradeAction | { kind: "SKIP"; why: "STALE" | "UNAVAILABLE" }> {
  const db = requireDb();
  const [row] = await db
    .select({ sub: taskSubmissions, taskTitle: tasks.title, review: submissionAiReviews, locale: users.preferredLocale })
    .from(submissionAiReviews)
    .innerJoin(taskSubmissions, eq(taskSubmissions.id, submissionAiReviews.submissionId))
    .innerJoin(tasks, eq(tasks.id, taskSubmissions.taskId))
    .innerJoin(users, eq(users.id, taskSubmissions.studentId))
    .where(and(eq(submissionAiReviews.submissionId, submissionId), eq(submissionAiReviews.runId, runId)))
    .limit(1);
  if (!row) return { kind: "SKIP", why: "STALE" };
  const { sub, review } = row;
  const setting = await autoGradeSetting(sub.taskId);
  if (!setting.available) return { kind: "SKIP", why: "UNAVAILABLE" };

  const details = (review.details ?? {}) as { strengths?: unknown; improvements?: unknown; needsTeacherReview?: unknown };
  const ai = { feedback: review.feedback ?? "", strengths: strings(details.strengths), improvements: strings(details.improvements) };
  const action = planAutoGrade({
    enabled: setting.enabled,
    owner: gradeOwner(sub),
    block: autoGradeBlockedBy({
      status: review.status,
      checks: (review.checks ?? []) as ReviewForGrading["checks"],
      feedback: review.feedback,
      suggestedScore: review.suggestedScore,
      needsTeacherReview: details.needsTeacherReview === true,
    }),
    currentScore: sub.score,
    aiScore: review.suggestedScore,
  });

  if (action.kind === "NEEDS_TEACHER") {
    await writeGrading(submissionId, { autoStatus: "NEEDS_TEACHER", autoReason: action.reason, reviewRunId: runId });
    return action;
  }
  if (action.kind !== "RELEASE" && action.kind !== "REGRADE") return action;
  if (!(await gradingTableReady())) return { kind: "SKIP", why: "UNAVAILABLE" };

  const now = new Date();
  const feedback = formatAiGradeFeedback(serverLocale(row.locale), ai);
  const t = taskSubmissions;
  const [updated] =
    action.kind === "RELEASE"
      ? await db
          .update(t)
          .set({ score: action.score, teacherFeedback: feedback, gradedAt: now, gradedByUserId: null, feedbackReleasedAt: now, aiFeedbackReleased: false })
          .where(and(eq(t.id, submissionId), isNull(t.gradedAt)))
      : await db
          .update(t)
          .set({ score: action.score, teacherFeedback: feedback, gradedAt: now })
          .where(and(eq(t.id, submissionId), isNotNull(t.gradedAt), isNull(t.gradedByUserId)));
  // The teacher graded in the meantime.
  if (updated.affectedRows !== 1) return { kind: "SKIP", why: "TEACHER_GRADED" };

  await writeGrading(submissionId, { source: "AI", autoStatus: "AI_GRADED", autoReason: null, aiScore: action.score, reviewRunId: runId });
  emitLearningEvent({ type: "TASK_SUBMISSION_CHANGED", submissionId });
  if (action.kind === "RELEASE") {
    await recordAnnouncedScore(submissionId, action.score);
    dispatch({
      event: "AI_GRADE_READY",
      userId: sub.studentId,
      dedupeKey: aiGradeDedupeKey(submissionId),
      data: { submissionId, taskTitle: row.taskTitle, score: action.score, ...cleanAiFeedback(ai) },
    });
  } else if (action.scoreChanged) {
    await recordAnnouncedScore(submissionId, action.score);
    dispatch({ event: "GRADE_UPDATED", userId: sub.studentId, dedupeKey: aiRegradeDedupeKey(submissionId, runId), data: { taskTitle: row.taskTitle, score: action.score } });
  }
  return action;
}

/** Called after every finished review run; never throws (the review itself is already saved). */
export async function autoGradeAfterReview(submissionId: string, runId: string) {
  try {
    await applyAutoGrade(submissionId, runId);
  } catch (error) {
    console.error("[autoGrade] failed", submissionId, error instanceof Error ? error.message : error);
  }
}

// A queued retry of the "result ready" notice is dropped if the teacher changed the grade meanwhile.
setSendGuard("AI_GRADE_READY", async ({ submissionId, score }) => {
  const [sub] = await requireDb()
    .select({ score: taskSubmissions.score, gradedByUserId: taskSubmissions.gradedByUserId, releasedAt: taskSubmissions.feedbackReleasedAt })
    .from(taskSubmissions)
    .where(eq(taskSubmissions.id, submissionId))
    .limit(1);
  if (!sub) return "NOT_FOUND";
  return sub.gradedByUserId === null && sub.releasedAt && sub.score === score ? null : "GRADE_CHANGED";
});

import { and, eq } from "drizzle-orm";
import { submissionAiReviews, taskNotificationSettings, taskSubmissions, tasks } from "../../drizzle/schema";
import { requireDb } from "../db";
import { dispatch, setSendGuard } from "../notifications/dispatcher";
import { isMissingTable } from "../notifications/preferences";
import { cleanAiFeedback } from "../notifications/templates";
import type { TeacherScope } from "./access";
import { AppError } from "./errors";

/**
 * Sends the student the AI pre-review text (never the suggested score or teacher notes) by
 * e-mail/push once the review is done. Teachers can turn it off per task (on by default).
 */

export type AiFeedbackBlock = "NOT_DONE" | "INJECTION_SUSPECTED" | "NO_FEEDBACK" | "ALREADY_GRADED" | "DISABLED_BY_TEACHER";

export function aiFeedbackBlockedBy(state: {
  status: string;
  checks: Array<{ code: string }>;
  feedback: string | null;
  gradedAt: Date | null;
  feedbackReleasedAt: Date | null;
  enabledForTask: boolean;
}): AiFeedbackBlock | null {
  if (state.status !== "DONE") return "NOT_DONE";
  if (state.checks.some((c) => c.code === "INJECTION_SUSPECTED")) return "INJECTION_SUSPECTED";
  if (!state.feedback?.trim()) return "NO_FEEDBACK";
  if (state.gradedAt || state.feedbackReleasedAt) return "ALREADY_GRADED";
  if (!state.enabledForTask) return "DISABLED_BY_TEACHER";
  return null;
}

export async function aiFeedbackEnabledForTask(taskId: string): Promise<boolean> {
  try {
    const [row] = await requireDb()
      .select({ enabled: taskNotificationSettings.aiFeedbackToStudent })
      .from(taskNotificationSettings)
      .where(eq(taskNotificationSettings.taskId, taskId))
      .limit(1);
    return row?.enabled ?? true;
  } catch (error) {
    if (isMissingTable(error)) return true;
    throw error;
  }
}

export async function setAiFeedbackToStudent(scope: TeacherScope, taskId: string, enabled: boolean) {
  const db = requireDb();
  const [task] = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.providerWorkspaceId, scope.workspaceId))).limit(1);
  if (!task) throw new AppError("NOT_FOUND");
  try {
    await db.insert(taskNotificationSettings).values({ taskId, aiFeedbackToStudent: enabled }).onDuplicateKeyUpdate({ set: { aiFeedbackToStudent: enabled } });
  } catch (error) {
    if (isMissingTable(error)) throw new AppError("DATABASE_UNAVAILABLE");
    throw error;
  }
  return { aiFeedbackToStudent: enabled };
}

async function loadState(submissionId: string) {
  const [row] = await requireDb()
    .select({
      studentId: taskSubmissions.studentId,
      taskId: taskSubmissions.taskId,
      taskTitle: tasks.title,
      gradedAt: taskSubmissions.gradedAt,
      feedbackReleasedAt: taskSubmissions.feedbackReleasedAt,
      status: submissionAiReviews.status,
      checks: submissionAiReviews.checks,
      feedback: submissionAiReviews.feedback,
      details: submissionAiReviews.details,
    })
    .from(submissionAiReviews)
    .innerJoin(taskSubmissions, eq(taskSubmissions.id, submissionAiReviews.submissionId))
    .innerJoin(tasks, eq(tasks.id, taskSubmissions.taskId))
    .where(eq(submissionAiReviews.submissionId, submissionId))
    .limit(1);
  if (!row) return null;
  const blocked = aiFeedbackBlockedBy({
    ...row,
    checks: (row.checks ?? []) as Array<{ code: string }>,
    enabledForTask: await aiFeedbackEnabledForTask(row.taskId),
  });
  return { row, blocked };
}

const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** Called after a review finishes; queues the e-mail unless a send condition fails. Never throws. */
export async function notifyAiFeedbackReady(submissionId: string) {
  try {
    const state = await loadState(submissionId);
    if (!state || state.blocked) return;
    const { row } = state;
    const details = (row.details ?? {}) as { strengths?: unknown; improvements?: unknown };
    const cleaned = cleanAiFeedback({ feedback: row.feedback ?? "", strengths: strings(details.strengths), improvements: strings(details.improvements) });
    dispatch({
      event: "AI_FEEDBACK_READY",
      userId: row.studentId,
      // One per submission: a rerun only re-sends if the earlier one was skipped or failed.
      dedupeKey: `ai-feedback:${submissionId}`,
      data: { submissionId, taskTitle: row.taskTitle, ...cleaned },
    });
  } catch (error) {
    console.error("[aiFeedback] could not queue", submissionId, error instanceof Error ? error.message : error);
  }
}

setSendGuard("AI_FEEDBACK_READY", async ({ submissionId }) => {
  const state = await loadState(submissionId);
  return state ? state.blocked : "NOT_FOUND";
});

import { and, eq, sql } from "drizzle-orm";
import { gradeEmailLog, taskSubmissions, tasks } from "../../drizzle/schema";
import { requireDb } from "../db";
import { dispatchNow } from "../notifications/dispatcher";
import { isMissingTable } from "../notifications/preferences";
import type { GradeEmailKind } from "../notifications/templates";

export type { GradeEmailKind } from "../notifications/templates";
export { buildGradeEmail } from "../notifications/templates";

/**
 * "Your grade is ready" e-mail (and push) to the student when the teacher releases a grade, and
 * an "updated" one (also in-app) when the released score later changes. The teacher's feedback
 * text is never included.
 */

const sameScore = (a: number | null, b: number | null) => a === b;

export interface GradeSave {
  before: { wasReleased: boolean; score: number | null };
  after: { release: boolean; score: number | null };
}

/**
 * What (if anything) to e-mail after a grade save. `emailedScore` is the score of the last grade
 * e-mail for this submission, `undefined` if none was sent. Plain re-saves, and hiding then
 * showing the same score again, send nothing.
 */
export function gradeEmailKind({ before, after }: GradeSave, emailedScore: number | null | undefined): GradeEmailKind | null {
  if (!after.release) return null;
  if (before.wasReleased && sameScore(before.score, after.score)) return null;
  if (emailedScore !== undefined && sameScore(emailedScore, after.score)) return null;
  return emailedScore !== undefined || before.wasReleased ? "updated" : "released";
}

/**
 * Decides, claims the e-mail in `grade_email_log` (so double clicks and concurrent saves send
 * once), then sends. Runs in the background after the grade is saved; the caller swallows errors.
 */
export async function deliverGradeEmail(submissionId: string, save: GradeSave) {
  if (gradeEmailKind(save, undefined) === null) return;
  const db = requireDb();
  const score = save.after.score;
  const [row] = await db
    .select({ title: tasks.title, studentId: taskSubmissions.studentId, score: taskSubmissions.score, releasedAt: taskSubmissions.feedbackReleasedAt })
    .from(taskSubmissions)
    .innerJoin(tasks, eq(tasks.id, taskSubmissions.taskId))
    .where(eq(taskSubmissions.id, submissionId))
    .limit(1);
  // A newer save may already have hidden the grade or changed the score; that save decides then.
  if (!row || !row.releasedAt || !sameScore(row.score, score)) return;

  const [log] = await db.select({ score: gradeEmailLog.score }).from(gradeEmailLog).where(eq(gradeEmailLog.submissionId, submissionId)).limit(1);
  const kind = gradeEmailKind(save, log ? log.score : undefined);
  if (!kind) return;
  const now = new Date();
  const [claim] = log
    ? await db
        .update(gradeEmailLog)
        .set({ score, sentAt: now })
        .where(and(eq(gradeEmailLog.submissionId, submissionId), sql`NOT (${gradeEmailLog.score} <=> ${score})`))
    : await db.insert(gradeEmailLog).ignore().values({ submissionId, score, sentAt: now });
  if (claim.affectedRows !== 1) return;

  await dispatchNow({
    event: kind === "released" ? "GRADE_RELEASED" : "GRADE_UPDATED",
    userId: row.studentId,
    dedupeKey: `grade-email:${submissionId}:${now.getTime()}`,
    // The in-app "graded" message of a first release is sent by the grading request itself.
    channels: kind === "released" ? ["EMAIL", "PUSH"] : ["IN_APP", "EMAIL", "PUSH"],
    data: { taskTitle: row.title, score },
  });
}

/** Remembers a score announced outside this flow (automatic AI grade), so re-saving it sends nothing. */
export async function recordAnnouncedScore(submissionId: string, score: number | null) {
  const sentAt = new Date();
  try {
    await requireDb().insert(gradeEmailLog).values({ submissionId, score, sentAt }).onDuplicateKeyUpdate({ set: { score, sentAt } });
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
}

import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { files, submissionAiReviews, taskSubmissions, tasks, type SubmissionAiReview, type Task, type TaskAccessMode, type TaskSubmission } from "../../drizzle/schema";
import type { MaterialDetails } from "../../shared/materialTemplates";
import { sendEmailInBackground } from "../_core/email";
import { deleteMeta, saveMeta } from "../materials/meta";
import { requireDb } from "../db";
import { dispatch } from "../notifications/dispatcher";
import { managedWorkspaces, type TeacherScope } from "./access";
import { scheduleAiReview, STALE_PENDING_MS, submissionInScope } from "./aiReview";
import { aiOverrideNeedsNotice, autoGradeEnabledForTasks, clampScore, gradeOwner, recordTeacherGrade } from "./autoGrade";
import { AppError } from "./errors";
import { deliverGradeEmail, gradeEmailKind } from "./gradeEmail";
import { activeGroupIdsOfStudent } from "./groups";
import { emitLearningEvent } from "./learningEvents";
import * as notifications from "./notifications";
import { syllabusContainerTaskIds } from "./syllabusLinks";
import { canSeeTaskContent, taskReachesStudent, taskViewerAccess, type TaskAccessSubject, type TaskViewerAccess } from "./taskAccess";
import { notifyTaskSaved } from "./taskNotify";
import { workspaceOwnerId } from "./workspaces";

/**
 * Assignments ("tapşırıq") and materials a teacher shares with a group and/or individual
 * students, plus the submissions students send back. Promoted from an in-memory store (where
 * everything here was lost on every server restart — every Railway deploy) to MySQL, following
 * the same scope-checked CRUD pattern as server/modules/groups.ts.
 */

const newShareCode = () => nanoid(10).replace(/[-_]/g, "x").toUpperCase();

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export interface AssignmentInput {
  title: string;
  description: string;
  instructions: string;
  deadline: Date;
  groupIds: string[];
  studentIds: number[];
  attachments: Array<{ fileId: string; name: string; size: number }>;
  /** Omitted = the column default, PUBLIC. */
  accessMode?: TaskAccessMode;
}

/** Throws NOT_FOUND if the assignment doesn't exist or belongs to another workspace. */
export async function assignmentOf(scope: TeacherScope, id: string) {
  const [row] = await requireDb()
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.providerWorkspaceId, scope.workspaceId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

export async function listForWorkspace(workspaceId: string) {
  const db = requireDb();
  const all = await db.select().from(tasks).where(eq(tasks.providerWorkspaceId, workspaceId)).orderBy(tasks.createdAt);
  // Syllabus practice containers are edited only through the syllabus builder.
  const containers = await syllabusContainerTaskIds(all.map((r) => r.id));
  const rows = containers.size ? all.filter((r) => !containers.has(r.id)) : all;
  if (!rows.length) return [];
  const subs = await db
    .select()
    .from(taskSubmissions)
    .where(inArray(taskSubmissions.taskId, rows.map((r) => r.id)));
  const byTask = new Map<string, typeof subs>();
  for (const s of subs) byTask.set(s.taskId, [...(byTask.get(s.taskId) ?? []), s]);
  return rows.map((r) => ({ ...r, submissions: byTask.get(r.id) ?? [] }));
}

/** `notify` false: the teacher unticked "Tələbələrə bildiriş göndər" for this save. */
export interface SaveOptions {
  notify?: boolean;
  /** Template details of a task made from the material form ("Tapşırıq kimi yarat"). */
  meta?: MaterialDetails;
}

const TASK_META_PUBLISHING = { status: "PUBLISHED", publishAt: null, visibility: "LINK", notify: true, url: null } as const;

export async function createAssignment(scope: TeacherScope, input: AssignmentInput, opts: SaveOptions = {}) {
  const db = requireDb();
  const id = nanoid();
  const values = { id, providerWorkspaceId: scope.workspaceId, createdBy: scope.userId, shareCode: newShareCode(), ...input };
  const meta = opts.meta;
  if (meta) {
    await db.transaction(async (tx) => {
      await tx.insert(tasks).values(values);
      await saveMeta(tx, { type: "TASK", id, workspaceId: scope.workspaceId }, meta, TASK_META_PUBLISHING);
    });
  } else {
    await db.insert(tasks).values(values);
  }
  const row = await assignmentOf(scope, id);
  notifyTaskSaved({ task: row, before: null, notify: opts.notify ?? true, teacherId: scope.userId });
  return row;
}

/**
 * Edits an existing assignment in place (fixing a forgotten recipient, a wrong deadline, etc.).
 * Only students the task newly reaches get the "new task" notice; a moved deadline is announced
 * to the others.
 */
export async function updateAssignment(scope: TeacherScope, id: string, patch: Partial<AssignmentInput>, opts: SaveOptions = {}) {
  const before = await assignmentOf(scope, id);
  if (Object.keys(patch).length) await requireDb().update(tasks).set(patch).where(eq(tasks.id, id));
  if (opts.meta) await saveMeta(requireDb(), { type: "TASK", id, workspaceId: scope.workspaceId }, opts.meta, TASK_META_PUBLISHING);
  const row = await assignmentOf(scope, id);
  notifyTaskSaved({ task: row, before, notify: opts.notify ?? true, teacherId: scope.userId });
  return row;
}

export async function deleteAssignment(scope: TeacherScope, id: string) {
  await assignmentOf(scope, id);
  if ((await syllabusContainerTaskIds([id])).size) throw new AppError("SYLLABUS_PRACTICE_TASK_IN_USE");
  const db = requireDb();
  await db.delete(submissionAiReviews).where(eq(submissionAiReviews.taskId, id));
  await db.delete(taskSubmissions).where(eq(taskSubmissions.taskId, id));
  await db.delete(tasks).where(eq(tasks.id, id));
  await deleteMeta(db, "TASK", id);
  return { ok: true };
}

/** While ungraded: the AI is still checking, or (auto-grade on) it was left to the teacher. */
export type SubmissionPending = "AI_CHECKING" | "TEACHER_REVIEW" | null;

export function pendingState(
  s: Pick<TaskSubmission, "feedbackReleasedAt">,
  review: Pick<SubmissionAiReview, "status" | "createdAt"> | undefined,
  autoGrade: boolean,
  now: number,
): SubmissionPending {
  if (s.feedbackReleasedAt || !autoGrade || !review) return null;
  if (review.status === "PENDING") return now - review.createdAt.getTime() <= STALE_PENDING_MS ? "AI_CHECKING" : "TEACHER_REVIEW";
  return "TEACHER_REVIEW";
}

/**
 * What a student may see of their own submission: the grade only once released (by the teacher,
 * or automatically by the AI), and the AI review text only if the teacher shared it on release.
 */
export function studentSubmissionView(
  s: TaskSubmission,
  review: Pick<SubmissionAiReview, "status" | "feedback" | "details"> | undefined,
  pending: SubmissionPending = null,
) {
  const released = s.feedbackReleasedAt !== null;
  const ai = released && s.aiFeedbackReleased && review?.status === "DONE" && review.feedback
    ? { feedback: review.feedback, strengths: review.details?.strengths ?? [], improvements: review.details?.improvements ?? [] }
    : null;
  const source = gradeOwner(s) === "AI" ? ("AI" as const) : ("TEACHER" as const);
  return {
    id: s.id,
    status: s.status,
    files: s.files,
    submittedAt: s.submittedAt,
    answerText: s.comment ?? "",
    grade: released ? { score: s.score, feedback: s.teacherFeedback ?? "", releasedAt: s.feedbackReleasedAt, source, ai } : null,
    pending: released ? null : pending,
  };
}

/** Assignments reaching this student (by group membership or direct targeting), each with its own submission if any. */
export async function studentAssignments(studentId: number, groupIds: string[]) {
  const db = requireDb();
  const rows = await db.select().from(tasks);
  const relevant = rows.filter((t) => taskReachesStudent(t, studentId, groupIds));
  if (!relevant.length) return [];
  const subs = await db
    .select()
    .from(taskSubmissions)
    .where(and(eq(taskSubmissions.studentId, studentId), inArray(taskSubmissions.taskId, relevant.map((t) => t.id))));
  const reviews = subs.length
    ? await db
        .select({
          submissionId: submissionAiReviews.submissionId,
          status: submissionAiReviews.status,
          createdAt: submissionAiReviews.createdAt,
          feedback: submissionAiReviews.feedback,
          details: submissionAiReviews.details,
        })
        .from(submissionAiReviews)
        .where(inArray(submissionAiReviews.submissionId, subs.map((s) => s.id)))
    : [];
  const reviewBySub = new Map(reviews.map((r) => [r.submissionId, r]));
  const autoGraded = await autoGradeEnabledForTasks(subs.filter((s) => !s.feedbackReleasedAt).map((s) => s.taskId));
  const byTask = new Map(subs.map((s) => [s.taskId, s]));
  const now = Date.now();
  return relevant.map((t) => {
    const s = byTask.get(t.id);
    if (!s) return { ...t, submission: undefined };
    const review = reviewBySub.get(s.id);
    return { ...t, submission: studentSubmissionView(s, review, pendingState(s, review, autoGraded.has(t.id), now)) };
  });
}

export const MAX_ANSWER_TEXT = 20_000;

/**
 * Files must be the student's own uploads for this task's workspace (names and sizes come from
 * the stored rows, not the client). A graded submission is final; a typed answer, files, or both.
 */
export async function submitAssignment(
  studentId: number,
  groupIds: string[],
  assignmentId: string,
  fileRefs: Array<{ fileId: string }>,
  answerText = "",
) {
  const [task] = await requireDb().select().from(tasks).where(eq(tasks.id, assignmentId)).limit(1);
  if (!task) throw new AppError("NOT_FOUND");
  if (!taskReachesStudent(task, studentId, groupIds)) throw new AppError(task.accessMode === "GROUPS" ? "TASK_NO_ACCESS" : "NOT_FOUND");
  return submitToTask(studentId, task, fileRefs, answerText);
}

/** The write half of a submission; callers have already decided the student may submit to `task`. */
export async function submitToTask(studentId: number, task: Task, fileRefs: Array<{ fileId: string }>, answerText = "") {
  const db = requireDb();
  const assignmentId = task.id;
  const text = answerText.trim().slice(0, MAX_ANSWER_TEXT);
  const ids = [...new Set(fileRefs.map((f) => f.fileId))];
  const owned = ids.length ? await db.select({ id: files.id, fileName: files.fileName, sizeBytes: files.sizeBytes, uploadedBy: files.uploadedBy, workspaceId: files.workspaceId }).from(files).where(inArray(files.id, ids)) : [];
  if (owned.length !== ids.length || owned.some((f) => f.uploadedBy !== studentId || f.workspaceId !== task.providerWorkspaceId)) {
    throw new AppError("FORBIDDEN");
  }
  const byId = new Map(owned.map((f) => [f.id, f]));
  const filesJson = ids.map((id) => ({ fileId: id, name: byId.get(id)!.fileName, size: byId.get(id)!.sizeBytes }));
  if (!filesJson.length && !text) throw new AppError("SUBMISSION_EMPTY");

  const status = task.deadline.getTime() < Date.now() ? ("LATE" as const) : ("SUBMITTED" as const);
  const [existing] = await db
    .select()
    .from(taskSubmissions)
    .where(and(eq(taskSubmissions.taskId, assignmentId), eq(taskSubmissions.studentId, studentId)))
    .limit(1);
  if (existing?.gradedAt) throw new AppError("SUBMISSION_ALREADY_GRADED");
  const now = new Date();
  if (existing) {
    await db
      .update(taskSubmissions)
      .set({ status, files: filesJson, comment: text || null, submittedAt: now, firstSubmittedAt: existing.firstSubmittedAt ?? existing.submittedAt ?? now })
      .where(eq(taskSubmissions.id, existing.id));
  } else {
    await db.insert(taskSubmissions).values({ id: nanoid(), taskId: assignmentId, studentId, status, files: filesJson, comment: text || null, submittedAt: now, firstSubmittedAt: now });
  }
  const ownerId = await workspaceOwnerId(task.providerWorkspaceId);
  if (ownerId) await notifications.notify(ownerId, "Yeni təslim", "Tələbə tapşırıq göndərdi");

  const [row] = await db.select().from(taskSubmissions).where(and(eq(taskSubmissions.taskId, assignmentId), eq(taskSubmissions.studentId, studentId))).limit(1);
  await scheduleAiReview(row.id);
  emitLearningEvent({ type: "TASK_SUBMISSION_CHANGED", submissionId: row.id });
  return studentSubmissionView(row, undefined);
}

/** The teacher's final word. `release` makes score and feedback visible to the student. */
export async function gradeSubmission(
  scope: TeacherScope,
  input: { submissionId: string; score: number | null; feedback: string; release: boolean; shareAiFeedback: boolean },
) {
  const current = await submissionInScope(scope, input.submissionId);
  const now = new Date();
  const score = input.score === null ? null : clampScore(input.score);
  const feedback = input.feedback.trim() || null;
  await requireDb()
    .update(taskSubmissions)
    .set({
      score,
      teacherFeedback: feedback,
      gradedAt: now,
      gradedByUserId: scope.userId,
      feedbackReleasedAt: input.release ? (current.feedbackReleasedAt ?? now) : null,
      aiFeedbackReleased: input.release && input.shareAiFeedback,
    })
    .where(eq(taskSubmissions.id, input.submissionId));
  await recordTeacherGrade(input.submissionId);
  emitLearningEvent({ type: "TASK_SUBMISSION_CHANGED", submissionId: input.submissionId });
  const taskTitle = async () => (await requireDb().select({ title: tasks.title }).from(tasks).where(eq(tasks.id, current.taskId)).limit(1))[0]?.title ?? "";
  if (input.release && !current.feedbackReleasedAt) {
    dispatch({
      event: "GRADE_RELEASED",
      userId: current.studentId,
      dedupeKey: `grade-inapp:${input.submissionId}:${now.getTime()}`,
      channels: ["IN_APP"],
      data: { taskTitle: await taskTitle(), score },
    });
  }
  const before = { owner: gradeOwner(current), released: current.feedbackReleasedAt !== null, score: current.score, feedback: current.teacherFeedback };
  if (aiOverrideNeedsNotice(before, { release: input.release, score, feedback })) {
    dispatch({ event: "GRADE_UPDATED", userId: current.studentId, dedupeKey: `grade-override:${input.submissionId}`, data: { taskTitle: await taskTitle(), score } });
  }
  const save = { before: { wasReleased: current.feedbackReleasedAt !== null, score: current.score }, after: { release: input.release, score } };
  if (gradeEmailKind(save, undefined)) sendEmailInBackground(() => deliverGradeEmail(input.submissionId, save));
  return submissionInScope(scope, input.submissionId);
}

export async function assignmentByShareCode(shareCode: string) {
  const [row] = await requireDb().select().from(tasks).where(eq(tasks.shareCode, shareCode)).limit(1);
  return row ?? null;
}

/** Resolves what `userId` (null = signed out) may see of this task on its share page. */
export async function viewerAccess(
  task: TaskAccessSubject & { providerWorkspaceId: string },
  userId: number | null,
): Promise<TaskViewerAccess> {
  if (userId === null) return taskViewerAccess(task, null);
  const [owned, groupIds] = await Promise.all([managedWorkspaces(userId), activeGroupIdsOfStudent(userId)]);
  return taskViewerAccess(task, { userId, managesWorkspace: owned.some((w) => w.id === task.providerWorkspaceId), groupIds });
}

/**
 * Self-enrolling via a teacher's share link: adds the student as an individual recipient. A
 * group-restricted task is only claimable by a member of one of its groups, who it already
 * reaches through that group — so nothing is appended to `studentIds` then.
 */
export async function claimAssignment(userId: number, userName: string | null, shareCode: string) {
  const db = requireDb();
  const [row] = await db.select().from(tasks).where(eq(tasks.shareCode, shareCode)).limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  if (row.accessMode === "GROUPS") {
    if (!canSeeTaskContent(await viewerAccess(row, userId))) throw new AppError("TASK_NO_ACCESS");
    return { id: row.id };
  }
  if (!row.studentIds.includes(userId)) {
    await db.update(tasks).set({ studentIds: [...row.studentIds, userId] }).where(eq(tasks.id, row.id));
    await notifications.notify(row.createdBy, "Qoşuldu", `${userName ?? "Tələbə"} → ${row.title}`);
  }
  return { id: row.id };
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

// Moved to server/materials/service.ts (templates, publishing, visibility); re-exported for existing callers.
export {
  claimMaterial,
  createMaterial,
  deleteMaterial,
  listMaterialsForWorkspace,
  materialByShareCode,
  materialOf,
  studentMaterials,
  updateMaterial,
  type MaterialInput,
} from "../materials/service";

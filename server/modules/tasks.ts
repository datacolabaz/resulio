import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { files, materials, submissionAiReviews, taskSubmissions, tasks, type SubmissionAiReview, type TaskAccessMode, type TaskSubmission } from "../../drizzle/schema";
import { requireDb } from "../db";
import { managedWorkspaces, type TeacherScope } from "./access";
import { clampScore, scheduleAiReview, submissionInScope } from "./aiReview";
import { AppError } from "./errors";
import { activeGroupIdsOfStudent } from "./groups";
import * as notifications from "./notifications";
import { canSeeTaskContent, taskReachesStudent, taskViewerAccess, type TaskAccessSubject, type TaskViewerAccess } from "./taskAccess";
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
  const rows = await db.select().from(tasks).where(eq(tasks.providerWorkspaceId, workspaceId)).orderBy(tasks.createdAt);
  if (!rows.length) return [];
  const subs = await db
    .select()
    .from(taskSubmissions)
    .where(inArray(taskSubmissions.taskId, rows.map((r) => r.id)));
  const byTask = new Map<string, typeof subs>();
  for (const s of subs) byTask.set(s.taskId, [...(byTask.get(s.taskId) ?? []), s]);
  return rows.map((r) => ({ ...r, submissions: byTask.get(r.id) ?? [] }));
}

export async function createAssignment(scope: TeacherScope, input: AssignmentInput, recipientIds: number[]) {
  const db = requireDb();
  const id = nanoid();
  await db.insert(tasks).values({ id, providerWorkspaceId: scope.workspaceId, createdBy: scope.userId, shareCode: newShareCode(), ...input });
  for (const sid of new Set(recipientIds)) await notifications.notify(sid, "Yeni tapşırıq", input.title);
  return assignmentOf(scope, id);
}

/**
 * Edits an existing assignment in place (fixing a forgotten recipient, a wrong deadline, etc.).
 * Does not re-notify recipients — `createAssignment` already did, and an edit is not a new
 * assignment; the caller can call `notifications.notify` itself for newly added recipients.
 */
export async function updateAssignment(scope: TeacherScope, id: string, patch: Partial<AssignmentInput>) {
  await assignmentOf(scope, id);
  if (Object.keys(patch).length) await requireDb().update(tasks).set(patch).where(eq(tasks.id, id));
  return assignmentOf(scope, id);
}

export async function deleteAssignment(scope: TeacherScope, id: string) {
  await assignmentOf(scope, id);
  const db = requireDb();
  await db.delete(submissionAiReviews).where(eq(submissionAiReviews.taskId, id));
  await db.delete(taskSubmissions).where(eq(taskSubmissions.taskId, id));
  await db.delete(tasks).where(eq(tasks.id, id));
  return { ok: true };
}

/**
 * What a student may see of their own submission: the grade only once the teacher released it,
 * and the AI pre-review text only if the teacher chose to share it on release.
 */
export function studentSubmissionView(s: TaskSubmission, review: Pick<SubmissionAiReview, "status" | "feedback" | "details"> | undefined) {
  const released = s.feedbackReleasedAt !== null;
  const ai = released && s.aiFeedbackReleased && review?.status === "DONE" && review.feedback
    ? { feedback: review.feedback, strengths: review.details?.strengths ?? [], improvements: review.details?.improvements ?? [] }
    : null;
  return {
    id: s.id,
    status: s.status,
    files: s.files,
    submittedAt: s.submittedAt,
    answerText: s.comment ?? "",
    grade: released ? { score: s.score, feedback: s.teacherFeedback ?? "", releasedAt: s.feedbackReleasedAt, ai } : null,
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
  const sharedAi = subs.filter((s) => s.feedbackReleasedAt && s.aiFeedbackReleased).map((s) => s.id);
  const reviews = sharedAi.length
    ? await db
        .select({ submissionId: submissionAiReviews.submissionId, status: submissionAiReviews.status, feedback: submissionAiReviews.feedback, details: submissionAiReviews.details })
        .from(submissionAiReviews)
        .where(inArray(submissionAiReviews.submissionId, sharedAi))
    : [];
  const reviewBySub = new Map(reviews.map((r) => [r.submissionId, r]));
  const byTask = new Map(subs.map((s) => [s.taskId, s]));
  return relevant.map((t) => {
    const s = byTask.get(t.id);
    return { ...t, submission: s ? studentSubmissionView(s, reviewBySub.get(s.id)) : undefined };
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
  const db = requireDb();
  const [task] = await db.select().from(tasks).where(eq(tasks.id, assignmentId)).limit(1);
  if (!task) throw new AppError("NOT_FOUND");
  if (!taskReachesStudent(task, studentId, groupIds)) throw new AppError(task.accessMode === "GROUPS" ? "TASK_NO_ACCESS" : "NOT_FOUND");

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
  return studentSubmissionView(row, undefined);
}

/** The teacher's final word. `release` makes score and feedback visible to the student. */
export async function gradeSubmission(
  scope: TeacherScope,
  input: { submissionId: string; score: number | null; feedback: string; release: boolean; shareAiFeedback: boolean },
) {
  const current = await submissionInScope(scope, input.submissionId);
  const now = new Date();
  await requireDb()
    .update(taskSubmissions)
    .set({
      score: input.score === null ? null : clampScore(input.score),
      teacherFeedback: input.feedback.trim() || null,
      gradedAt: now,
      gradedByUserId: scope.userId,
      feedbackReleasedAt: input.release ? (current.feedbackReleasedAt ?? now) : null,
      aiFeedbackReleased: input.release && input.shareAiFeedback,
    })
    .where(eq(taskSubmissions.id, input.submissionId));
  if (input.release && !current.feedbackReleasedAt) await notifications.notify(current.studentId, "Tapşırıq qiymətləndirildi", "Müəllim rəy yazdı");
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

export interface MaterialInput {
  title: string;
  description: string;
  subject: string;
  topic: string;
  fileName: string;
  fileId: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  groupIds: string[];
  studentIds: number[];
}

/** Throws NOT_FOUND if the material doesn't exist or belongs to another workspace. */
export async function materialOf(scope: TeacherScope, id: string) {
  const [row] = await requireDb()
    .select()
    .from(materials)
    .where(and(eq(materials.id, id), eq(materials.providerWorkspaceId, scope.workspaceId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

export async function listMaterialsForWorkspace(workspaceId: string) {
  return requireDb().select().from(materials).where(eq(materials.providerWorkspaceId, workspaceId)).orderBy(materials.uploadedAt);
}

export async function createMaterial(scope: TeacherScope, input: MaterialInput) {
  const db = requireDb();
  const id = nanoid();
  await db.insert(materials).values({ id, providerWorkspaceId: scope.workspaceId, createdBy: scope.userId, shareCode: newShareCode(), ...input });
  return materialOf(scope, id);
}

export async function updateMaterial(scope: TeacherScope, id: string, patch: Partial<MaterialInput>) {
  await materialOf(scope, id);
  if (Object.keys(patch).length) await requireDb().update(materials).set(patch).where(eq(materials.id, id));
  return materialOf(scope, id);
}

export async function deleteMaterial(scope: TeacherScope, id: string) {
  await materialOf(scope, id);
  await requireDb().delete(materials).where(eq(materials.id, id));
  return { ok: true };
}

export async function studentMaterials(studentId: number, groupIds: string[]) {
  const rows = await requireDb().select().from(materials);
  return rows.filter((m) => m.studentIds.includes(studentId) || m.groupIds.some((g) => groupIds.includes(g)));
}

export async function materialByShareCode(shareCode: string) {
  const [row] = await requireDb().select().from(materials).where(eq(materials.shareCode, shareCode)).limit(1);
  return row ?? null;
}

export async function claimMaterial(userId: number, shareCode: string) {
  const db = requireDb();
  const [row] = await db.select().from(materials).where(eq(materials.shareCode, shareCode)).limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  if (!row.studentIds.includes(userId)) {
    await db.update(materials).set({ studentIds: [...row.studentIds, userId] }).where(eq(materials.id, row.id));
  }
  return { id: row.id };
}

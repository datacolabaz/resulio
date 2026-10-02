import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { materials, taskSubmissions, tasks } from "../../drizzle/schema";
import { requireDb } from "../db";
import type { TeacherScope } from "./access";
import { AppError } from "./errors";
import * as notifications from "./notifications";
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
  await db.delete(taskSubmissions).where(eq(taskSubmissions.taskId, id));
  await db.delete(tasks).where(eq(tasks.id, id));
  return { ok: true };
}

/** Assignments reaching this student (by group membership or direct targeting), each with its own submission if any. */
export async function studentAssignments(studentId: number, groupIds: string[]) {
  const db = requireDb();
  const rows = await db.select().from(tasks);
  const relevant = rows.filter((t) => t.studentIds.includes(studentId) || t.groupIds.some((g) => groupIds.includes(g)));
  if (!relevant.length) return [];
  const subs = await db
    .select()
    .from(taskSubmissions)
    .where(and(eq(taskSubmissions.studentId, studentId), inArray(taskSubmissions.taskId, relevant.map((t) => t.id))));
  const byTask = new Map(subs.map((s) => [s.taskId, s]));
  return relevant.map((t) => ({ ...t, submission: byTask.get(t.id) }));
}

export async function submitAssignment(
  studentId: number,
  groupIds: string[],
  assignmentId: string,
  files: Array<{ fileId: string; name: string; size: number }>,
) {
  const db = requireDb();
  const [task] = await db.select().from(tasks).where(eq(tasks.id, assignmentId)).limit(1);
  if (!task) throw new AppError("NOT_FOUND");
  const reaches = task.studentIds.includes(studentId) || task.groupIds.some((g) => groupIds.includes(g));
  if (!reaches) throw new AppError("NOT_FOUND");

  const status = task.deadline.getTime() < Date.now() ? ("LATE" as const) : ("SUBMITTED" as const);
  const filesJson = files;
  const [existing] = await db
    .select()
    .from(taskSubmissions)
    .where(and(eq(taskSubmissions.taskId, assignmentId), eq(taskSubmissions.studentId, studentId)))
    .limit(1);
  if (existing) {
    await db.update(taskSubmissions).set({ status, files: filesJson, submittedAt: new Date() }).where(eq(taskSubmissions.id, existing.id));
  } else {
    await db.insert(taskSubmissions).values({ id: nanoid(), taskId: assignmentId, studentId, status, files: filesJson, submittedAt: new Date() });
  }
  const ownerId = await workspaceOwnerId(task.providerWorkspaceId);
  if (ownerId) await notifications.notify(ownerId, "Yeni təslim", "Tələbə tapşırıq göndərdi");

  const [row] = await db.select().from(taskSubmissions).where(and(eq(taskSubmissions.taskId, assignmentId), eq(taskSubmissions.studentId, studentId))).limit(1);
  return row;
}

export async function assignmentByShareCode(shareCode: string) {
  const [row] = await requireDb().select().from(tasks).where(eq(tasks.shareCode, shareCode)).limit(1);
  return row ?? null;
}

/** Self-enrolling via a teacher's share link: adds the student as an individual recipient. */
export async function claimAssignment(userId: number, userName: string | null, shareCode: string) {
  const db = requireDb();
  const [row] = await db.select().from(tasks).where(eq(tasks.shareCode, shareCode)).limit(1);
  if (!row) throw new AppError("NOT_FOUND");
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

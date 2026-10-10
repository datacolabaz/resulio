import { asc, eq, inArray, or, sql } from "drizzle-orm";
import { groups, materials, type MaterialRow } from "../../drizzle/schema";
import { requireDb } from "../db";
import { visibleToStudents, withMeta, type ContentMetaView } from "./meta";

/**
 * Who may see a material. Recipients are its groups' active students plus individually listed
 * students (including those who claimed the share link). Students only ever see it once it is
 * visible (published, publish time reached). A LINK material is also open to anyone holding the
 * link; a RECIPIENTS one only to its recipients (and the teacher).
 */

export type MaterialRecipients = Pick<MaterialRow, "groupIds" | "studentIds">;

export function materialReachesStudent(m: MaterialRecipients, studentId: number, groupIds: readonly string[]): boolean {
  return m.studentIds.includes(studentId) || m.groupIds.some((g) => groupIds.includes(g));
}

/** Visible and shared by link: the public page shows it and its file is served without a session. */
export const openByLink = (meta: Pick<ContentMetaView, "status" | "publishAt" | "visibility">, now: Date = new Date()) =>
  visibleToStudents(meta, now) && meta.visibility === "LINK";

/**
 * Materials reaching the student, filtered in SQL: those of the workspaces of the student's
 * groups (indexed) plus any listing the student individually (JSON_CONTAINS), then by recipients.
 */
export async function materialsReachingStudent(studentId: number, groupIds: readonly string[]): Promise<MaterialRow[]> {
  const db = requireDb();
  const workspaceIds = groupIds.length
    ? (await db.selectDistinct({ id: groups.providerWorkspaceId }).from(groups).where(inArray(groups.id, [...groupIds]))).map((r) => r.id)
    : [];
  const listed = sql`json_contains(${materials.studentIds}, ${String(studentId)})`;
  const rows = await db
    .select()
    .from(materials)
    .where(workspaceIds.length ? or(inArray(materials.providerWorkspaceId, workspaceIds), listed) : listed)
    .orderBy(asc(materials.uploadedAt));
  return rows.filter((m) => materialReachesStudent(m, studentId, groupIds));
}

/** The student's materials list: reaching them and visible now, with their details. */
export async function visibleMaterialsOfStudent(studentId: number, groupIds: readonly string[], now: Date = new Date()) {
  const rows = await withMeta(await materialsReachingStudent(studentId, groupIds));
  return rows.filter((m) => visibleToStudents(m.meta, now));
}

/** Materials whose file this is (normally one). */
export async function materialsUsingFile(fileId: string): Promise<MaterialRow[]> {
  return requireDb().select().from(materials).where(eq(materials.fileId, fileId));
}

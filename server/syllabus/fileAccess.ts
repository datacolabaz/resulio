import { and, inArray, sql } from "drizzle-orm";
import { syllabusVersionItems } from "../../drizzle/schema";
import type { SyllabusItemKind } from "../../shared/syllabus";
import { requireDb } from "../db";
import { activeGroupIdsOfStudent } from "../modules/groups";
import { isMissingTable } from "../notifications/preferences";
import { contentRefs } from "./authoring";
import { syllabusEnabledFor } from "./availability";
import { canOpenItem } from "./learning";
import * as store from "./store";

/**
 * Who may download a file that a teacher put into syllabus content (theory image/file blocks,
 * practice attachments), or open a library material a lesson references. Same shape as the
 * task-attachment rule in modules/files.ts: the student must be able to open the item that uses
 * it right now — live grant, feature on, and the containing lesson (or module/final item) unlocked
 * in the version they are pinned to. A cover image is shown on the syllabus card, so it is allowed
 * for any syllabus that reaches the student.
 */

/** LIKE pattern matching the file id as a JSON string value. */
export function fileIdPattern(fileId: string) {
  return `%"${fileId.replace(/[\\%_]/g, (c) => `\\${c}`)}"%`;
}

type ItemRow = { itemId: string; kind: SyllabusItemKind; content: Record<string, unknown> };

/** Pure: the version items (of the student's pinned versions) that really reference the file. */
export function itemsUsingFile(rows: ReadonlyArray<ItemRow>, fileId: string) {
  return rows.filter((r) => contentRefs(r.kind, r.content).fileIds.includes(fileId)).map((r) => r.itemId);
}

/** Pure: the version items that really reference the material. */
export function itemsUsingMaterial(rows: ReadonlyArray<ItemRow>, materialId: string) {
  return rows.filter((r) => contentRefs(r.kind, r.content).materialIds.includes(materialId)).map((r) => r.itemId);
}

async function reachableThroughSyllabus(
  studentId: number,
  workspaceId: string,
  refId: string,
  itemsUsing: (rows: ReadonlyArray<ItemRow>, id: string) => string[],
  coverFileId: string | null,
): Promise<boolean> {
  try {
    const groupIds = await activeGroupIdsOfStudent(studentId);
    const [enrollments, grants] = await Promise.all([store.enrollmentsOfStudent(studentId), store.grantsReachingStudent(studentId, groupIds)]);
    const syllabusIds = [...new Set([...enrollments.map((e) => e.syllabusId), ...grants.filter((g) => g.status === "ACTIVE").map((g) => g.syllabusId)])];
    if (!syllabusIds.length) return false;
    const rows = (await store.syllabiByIds(syllabusIds)).filter((s) => s.providerWorkspaceId === workspaceId);
    if (!rows.length || !(await syllabusEnabledFor(workspaceId))) return false;
    if (coverFileId && rows.some((s) => s.coverFileId === coverFileId)) return true;

    const pinned = enrollments.filter((e) => rows.some((s) => s.id === e.syllabusId));
    if (!pinned.length) return false;
    const candidates = await requireDb()
      .select({ versionId: syllabusVersionItems.versionId, itemId: syllabusVersionItems.itemId, kind: syllabusVersionItems.kind, content: syllabusVersionItems.content })
      .from(syllabusVersionItems)
      .where(and(inArray(syllabusVersionItems.versionId, pinned.map((e) => e.versionId)), sql`cast(${syllabusVersionItems.content} as char) like ${fileIdPattern(refId)}`))
      .limit(50);
    for (const e of pinned) {
      for (const itemId of itemsUsing(candidates.filter((c) => c.versionId === e.versionId), refId)) {
        if (await canOpenItem(studentId, e.syllabusId, itemId)) return true;
      }
    }
    return false;
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

export function studentMayDownloadSyllabusFile(studentId: number, file: { id: string; workspaceId: string }): Promise<boolean> {
  return reachableThroughSyllabus(studentId, file.workspaceId, file.id, itemsUsingFile, file.id);
}

/** A lesson the student can open now references this material (its file, or its link). */
export function studentMayOpenSyllabusMaterial(studentId: number, material: { id: string; providerWorkspaceId: string }): Promise<boolean> {
  return reachableThroughSyllabus(studentId, material.providerWorkspaceId, material.id, itemsUsingMaterial, null);
}

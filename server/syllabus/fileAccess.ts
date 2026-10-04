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
 * practice attachments). Same shape as the task-attachment rule in modules/files.ts: the student
 * must be able to open the item that uses the file right now — live grant, feature on, and the
 * containing lesson (or module/final item) unlocked in the version they are pinned to. A cover
 * image is shown on the syllabus card, so it is allowed for any syllabus that reaches the student.
 */

/** LIKE pattern matching the file id as a JSON string value. */
export function fileIdPattern(fileId: string) {
  return `%"${fileId.replace(/[\\%_]/g, (c) => `\\${c}`)}"%`;
}

/** Pure: the version items (of the student's pinned versions) that really reference the file. */
export function itemsUsingFile(rows: ReadonlyArray<{ itemId: string; kind: SyllabusItemKind; content: Record<string, unknown> }>, fileId: string) {
  return rows.filter((r) => contentRefs(r.kind, r.content).fileIds.includes(fileId)).map((r) => r.itemId);
}

export async function studentMayDownloadSyllabusFile(studentId: number, file: { id: string; workspaceId: string }): Promise<boolean> {
  try {
    const groupIds = await activeGroupIdsOfStudent(studentId);
    const [enrollments, grants] = await Promise.all([store.enrollmentsOfStudent(studentId), store.grantsReachingStudent(studentId, groupIds)]);
    const syllabusIds = [...new Set([...enrollments.map((e) => e.syllabusId), ...grants.filter((g) => g.status === "ACTIVE").map((g) => g.syllabusId)])];
    if (!syllabusIds.length) return false;
    const rows = (await store.syllabiByIds(syllabusIds)).filter((s) => s.providerWorkspaceId === file.workspaceId);
    if (!rows.length || !(await syllabusEnabledFor(file.workspaceId))) return false;
    if (rows.some((s) => s.coverFileId === file.id)) return true;

    const pinned = enrollments.filter((e) => rows.some((s) => s.id === e.syllabusId));
    if (!pinned.length) return false;
    const candidates = await requireDb()
      .select({ versionId: syllabusVersionItems.versionId, itemId: syllabusVersionItems.itemId, kind: syllabusVersionItems.kind, content: syllabusVersionItems.content })
      .from(syllabusVersionItems)
      .where(and(inArray(syllabusVersionItems.versionId, pinned.map((e) => e.versionId)), sql`cast(${syllabusVersionItems.content} as char) like ${fileIdPattern(file.id)}`))
      .limit(50);
    for (const e of pinned) {
      for (const itemId of itemsUsingFile(candidates.filter((c) => c.versionId === e.versionId), file.id)) {
        if (await canOpenItem(studentId, e.syllabusId, itemId)) return true;
      }
    }
    return false;
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

import { and, eq, inArray, or } from "drizzle-orm";
import {
  groupLearningSettings,
  groupMembers,
  groups,
  users,
  syllabi,
  syllabusAccessGrants,
  syllabusCompletions,
  syllabusEnrollments,
  syllabusVersionItems,
  syllabusVersions,
  type SyllabusVersion,
} from "../../drizzle/schema";
import { requireDb, type DbOrTx } from "../db";
import { isMissingTable } from "../notifications/preferences";
import { DEFAULT_PROGRESS_VISIBLE_TO_GROUP } from "./visibility";
import type { VersionStructure } from "./types";

/** Reads shared by the student and teacher services. Kept small so permission tests can mock it. */

export async function syllabusById(id: string, db: DbOrTx = requireDb()) {
  const [row] = await db.select().from(syllabi).where(eq(syllabi.id, id)).limit(1);
  return row ?? null;
}

const versionCache = new Map<string, { version: SyllabusVersion; structure: VersionStructure }>();
const VERSION_CACHE_MAX = 200;

/** Versions are immutable (except `status`), so the parsed structure is cached by id. */
export async function versionById(id: string, db: DbOrTx = requireDb()) {
  const hit = versionCache.get(id);
  if (hit) return hit;
  const [version] = await db.select().from(syllabusVersions).where(eq(syllabusVersions.id, id)).limit(1);
  if (!version) return null;
  const entry = { version, structure: version.structure as unknown as VersionStructure };
  if (versionCache.size >= VERSION_CACHE_MAX) versionCache.delete(versionCache.keys().next().value!);
  versionCache.set(id, entry);
  return entry;
}

export async function versionItems(versionId: string, itemIds: readonly string[], db: DbOrTx = requireDb()) {
  if (!itemIds.length) return [];
  return db
    .select()
    .from(syllabusVersionItems)
    .where(and(eq(syllabusVersionItems.versionId, versionId), inArray(syllabusVersionItems.itemId, [...itemIds])));
}

export async function grantsForSyllabus(syllabusId: string, db: DbOrTx = requireDb()) {
  return db.select().from(syllabusAccessGrants).where(eq(syllabusAccessGrants.syllabusId, syllabusId));
}

/** Every grant row (any status) that names this student or one of their active groups. */
export async function grantsReachingStudent(studentId: number, groupIds: readonly string[], db: DbOrTx = requireDb()) {
  const conds = [eq(syllabusAccessGrants.studentId, studentId)];
  if (groupIds.length) conds.push(inArray(syllabusAccessGrants.groupId, [...groupIds]));
  return db.select().from(syllabusAccessGrants).where(or(...conds));
}

export async function enrollmentOf(syllabusId: string, studentId: number, db: DbOrTx = requireDb()) {
  const [row] = await db
    .select()
    .from(syllabusEnrollments)
    .where(and(eq(syllabusEnrollments.syllabusId, syllabusId), eq(syllabusEnrollments.studentId, studentId)))
    .limit(1);
  return row ?? null;
}

export async function enrollmentsOfStudent(studentId: number, db: DbOrTx = requireDb()) {
  return db.select().from(syllabusEnrollments).where(eq(syllabusEnrollments.studentId, studentId));
}

export async function syllabiByIds(ids: readonly string[], db: DbOrTx = requireDb()) {
  if (!ids.length) return [];
  return db.select().from(syllabi).where(inArray(syllabi.id, [...ids]));
}

export async function groupById(groupId: string, db: DbOrTx = requireDb()) {
  const [row] = await db.select({ id: groups.id, name: groups.name, workspaceId: groups.providerWorkspaceId }).from(groups).where(eq(groups.id, groupId)).limit(1);
  return row ?? null;
}

export async function activeMembersWithNames(groupId: string, db: DbOrTx = requireDb()) {
  return db
    .select({ studentId: groupMembers.userId, name: users.name })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.status, "ACTIVE"), eq(groupMembers.membershipRole, "STUDENT")));
}

export async function enrollmentsOfStudents(syllabusId: string, studentIds: readonly number[], db: DbOrTx = requireDb()) {
  if (!studentIds.length) return [];
  return db
    .select()
    .from(syllabusEnrollments)
    .where(and(eq(syllabusEnrollments.syllabusId, syllabusId), inArray(syllabusEnrollments.studentId, [...studentIds])));
}

export async function groupsByIds(ids: readonly string[], db: DbOrTx = requireDb()) {
  if (!ids.length) return [];
  return db.select({ id: groups.id, name: groups.name, workspaceId: groups.providerWorkspaceId }).from(groups).where(inArray(groups.id, [...ids]));
}

export async function completionOf(enrollmentId: string, db: DbOrTx = requireDb()) {
  const [row] = await db.select().from(syllabusCompletions).where(eq(syllabusCompletions.enrollmentId, enrollmentId)).limit(1);
  return row ?? null;
}

/** No row (or no table yet) = the default: groupmates see each other's progress. */
export async function progressVisibleToGroup(groupId: string, db: DbOrTx = requireDb()) {
  try {
    const [row] = await db
      .select({ v: groupLearningSettings.progressVisibleToGroup })
      .from(groupLearningSettings)
      .where(eq(groupLearningSettings.groupId, groupId))
      .limit(1);
    return row?.v ?? DEFAULT_PROGRESS_VISIBLE_TO_GROUP;
  } catch (error) {
    if (isMissingTable(error)) return DEFAULT_PROGRESS_VISIBLE_TO_GROUP;
    throw error;
  }
}

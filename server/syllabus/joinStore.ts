import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  groups,
  providerWorkspaces,
  syllabi,
  syllabusGroupListings,
  syllabusJoinRequests,
  syllabusShareLinks,
  users,
  type SyllabusJoinRequest,
} from "../../drizzle/schema";
import type { JoinRequestStatus } from "../../shared/syllabusJoin";
import { requireDb, type DbOrTx } from "../db";
import type { ListingCandidate } from "./joinRules";

/** Reads and writes of the share-link / join-request tables. Kept small so the service tests can mock it. */

export function isDuplicateKey(error: unknown): boolean {
  let e = error as { errno?: number; code?: string; cause?: unknown } | undefined;
  for (let i = 0; e && i < 5; i++) {
    if (e.errno === 1062 || e.code === "ER_DUP_ENTRY") return true;
    e = e.cause as typeof e;
  }
  return false;
}

export async function shareLinkOf(syllabusId: string, db: DbOrTx = requireDb()) {
  const [row] = await db.select().from(syllabusShareLinks).where(eq(syllabusShareLinks.syllabusId, syllabusId)).limit(1);
  return row ?? null;
}

export async function shareLinkByCode(code: string, db: DbOrTx = requireDb()) {
  const [row] = await db.select().from(syllabusShareLinks).where(eq(syllabusShareLinks.code, code)).limit(1);
  return row ?? null;
}

export async function shareLinksOf(syllabusIds: readonly string[], db: DbOrTx = requireDb()) {
  if (!syllabusIds.length) return [];
  return db.select().from(syllabusShareLinks).where(inArray(syllabusShareLinks.syllabusId, [...syllabusIds]));
}

export async function insertShareLink(row: { syllabusId: string; code: string; createdBy: number }, db: DbOrTx = requireDb()) {
  await db.insert(syllabusShareLinks).values({ ...row, active: true });
}

export async function updateShareLink(syllabusId: string, patch: { code?: string; active?: boolean }, db: DbOrTx = requireDb()) {
  await db.update(syllabusShareLinks).set(patch).where(eq(syllabusShareLinks.syllabusId, syllabusId));
}

export async function listedGroupIds(syllabusId: string, db: DbOrTx = requireDb()) {
  const rows = await db.select({ groupId: syllabusGroupListings.groupId }).from(syllabusGroupListings).where(eq(syllabusGroupListings.syllabusId, syllabusId));
  return rows.map((r) => r.groupId);
}

export async function setListing(syllabusId: string, groupId: string, listed: boolean, userId: number, db: DbOrTx = requireDb()) {
  if (listed) {
    await db.insert(syllabusGroupListings).values({ syllabusId, groupId, createdBy: userId }).onDuplicateKeyUpdate({ set: { createdBy: userId } });
  } else {
    await db.delete(syllabusGroupListings).where(and(eq(syllabusGroupListings.syllabusId, syllabusId), eq(syllabusGroupListings.groupId, groupId)));
  }
}

export async function listingCandidates(groupIds: readonly string[], db: DbOrTx = requireDb()): Promise<ListingCandidate[]> {
  if (!groupIds.length) return [];
  return db
    .select({
      id: groups.id,
      name: groups.name,
      workspaceId: groups.providerWorkspaceId,
      startDate: groups.startDate,
      classSchedule: groups.classSchedule,
      scheduleVisible: groups.scheduleVisible,
      format: groups.format,
      language: groups.language,
    })
    .from(groups)
    .where(inArray(groups.id, [...groupIds]));
}

/** The name the public pages show for a workspace (as on the group invite preview) and its owner's avatar. */
export async function teacherOfWorkspace(workspaceId: string, db: DbOrTx = requireDb()) {
  const [row] = await db
    .select({
      ownerUserId: providerWorkspaces.ownerUserId,
      publicDisplayName: providerWorkspaces.publicDisplayName,
      title: providerWorkspaces.title,
      avatarUrl: users.avatarUrl,
    })
    .from(providerWorkspaces)
    .leftJoin(users, eq(users.id, providerWorkspaces.ownerUserId))
    .where(eq(providerWorkspaces.id, workspaceId))
    .limit(1);
  if (!row) return null;
  return { ownerUserId: row.ownerUserId, name: row.publicDisplayName || row.title, avatarUrl: row.avatarUrl ?? null };
}

export async function userName(userId: number, db: DbOrTx = requireDb()) {
  const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.name ?? null;
}

export async function groupName(groupId: string, db: DbOrTx = requireDb()) {
  const [row] = await db.select({ name: groups.name }).from(groups).where(eq(groups.id, groupId)).limit(1);
  return row?.name ?? null;
}

export async function insertRequest(row: typeof syllabusJoinRequests.$inferInsert, db: DbOrTx = requireDb()) {
  await db.insert(syllabusJoinRequests).values(row);
}

export async function requestById(id: string, db: DbOrTx = requireDb()) {
  const [row] = await db.select().from(syllabusJoinRequests).where(eq(syllabusJoinRequests.id, id)).limit(1);
  return row ?? null;
}

export async function requestByOpenKey(openKey: string, db: DbOrTx = requireDb()) {
  const [row] = await db.select().from(syllabusJoinRequests).where(eq(syllabusJoinRequests.openKey, openKey)).limit(1);
  return row ?? null;
}

export async function requestsOfStudentForSyllabus(syllabusId: string, studentId: number, db: DbOrTx = requireDb()) {
  return db
    .select()
    .from(syllabusJoinRequests)
    .where(and(eq(syllabusJoinRequests.syllabusId, syllabusId), eq(syllabusJoinRequests.studentId, studentId)))
    .orderBy(desc(syllabusJoinRequests.createdAt));
}

/** Moves a request out of PENDING only if it still is (a double click or two tabs cannot decide twice). Returns whether it moved. */
export async function closeRequest(
  id: string,
  patch: { status: Exclude<JoinRequestStatus, "PENDING">; decidedBy: number | null; decisionNote: string | null },
  db: DbOrTx = requireDb(),
): Promise<boolean> {
  const [res] = await db
    .update(syllabusJoinRequests)
    .set({ ...patch, openKey: null, decidedAt: new Date() })
    .where(and(eq(syllabusJoinRequests.id, id), eq(syllabusJoinRequests.status, "PENDING")));
  return res.affectedRows === 1;
}

/** Undo of `closeRequest` when the decision's side effect failed. */
export async function reopenRequest(request: SyllabusJoinRequest, openKey: string, db: DbOrTx = requireDb()) {
  await db
    .update(syllabusJoinRequests)
    .set({ status: "PENDING", openKey, decidedBy: null, decidedAt: null, decisionNote: null })
    .where(eq(syllabusJoinRequests.id, request.id));
}

/** Requests of one syllabus with the student's name and e-mail (the teacher follows up) and the group's name. */
export async function requestsOfSyllabus(syllabusId: string, db: DbOrTx = requireDb()) {
  return db
    .select({
      id: syllabusJoinRequests.id,
      type: syllabusJoinRequests.type,
      status: syllabusJoinRequests.status,
      groupId: syllabusJoinRequests.groupId,
      groupName: groups.name,
      message: syllabusJoinRequests.message,
      decisionNote: syllabusJoinRequests.decisionNote,
      decidedAt: syllabusJoinRequests.decidedAt,
      createdAt: syllabusJoinRequests.createdAt,
      studentId: syllabusJoinRequests.studentId,
      studentName: users.name,
      studentEmail: users.email,
      studentAvatarUrl: users.avatarUrl,
    })
    .from(syllabusJoinRequests)
    .innerJoin(users, eq(users.id, syllabusJoinRequests.studentId))
    .leftJoin(groups, eq(groups.id, syllabusJoinRequests.groupId))
    .where(eq(syllabusJoinRequests.syllabusId, syllabusId))
    .orderBy(desc(syllabusJoinRequests.createdAt))
    .limit(500);
}

/** Open requests across the workspace's own syllabi, newest first, for the inbox on the syllabus list. */
export async function pendingRequestsOfWorkspace(workspaceId: string, db: DbOrTx = requireDb()) {
  return db
    .select({
      id: syllabusJoinRequests.id,
      syllabusId: syllabusJoinRequests.syllabusId,
      syllabusTitle: syllabi.title,
      type: syllabusJoinRequests.type,
      groupId: syllabusJoinRequests.groupId,
      groupName: groups.name,
      message: syllabusJoinRequests.message,
      createdAt: syllabusJoinRequests.createdAt,
      studentId: syllabusJoinRequests.studentId,
      studentName: users.name,
      studentEmail: users.email,
    })
    .from(syllabusJoinRequests)
    .innerJoin(syllabi, eq(syllabi.id, syllabusJoinRequests.syllabusId))
    .innerJoin(users, eq(users.id, syllabusJoinRequests.studentId))
    .leftJoin(groups, eq(groups.id, syllabusJoinRequests.groupId))
    .where(
      and(
        eq(syllabusJoinRequests.workspaceId, workspaceId),
        eq(syllabi.providerWorkspaceId, workspaceId),
        eq(syllabusJoinRequests.status, "PENDING"),
      ),
    )
    .orderBy(desc(syllabusJoinRequests.createdAt))
    .limit(100);
}

export async function pendingCountsOfWorkspace(workspaceId: string, db: DbOrTx = requireDb()) {
  const rows = await db
    .select({ syllabusId: syllabusJoinRequests.syllabusId, n: sql<number>`count(*)` })
    .from(syllabusJoinRequests)
    .where(and(eq(syllabusJoinRequests.workspaceId, workspaceId), eq(syllabusJoinRequests.status, "PENDING")))
    .groupBy(syllabusJoinRequests.syllabusId);
  return rows.map((r) => ({ syllabusId: r.syllabusId, count: Number(r.n) }));
}

/** A student's own requests across syllabi, newest first, with what their dashboard card shows. */
export async function requestsOfStudent(studentId: number, db: DbOrTx = requireDb()) {
  return db
    .select({
      id: syllabusJoinRequests.id,
      type: syllabusJoinRequests.type,
      status: syllabusJoinRequests.status,
      groupName: groups.name,
      decisionNote: syllabusJoinRequests.decisionNote,
      decidedAt: syllabusJoinRequests.decidedAt,
      createdAt: syllabusJoinRequests.createdAt,
      syllabusTitle: syllabi.title,
      shareCode: syllabusShareLinks.code,
      shareActive: syllabusShareLinks.active,
    })
    .from(syllabusJoinRequests)
    .innerJoin(syllabi, eq(syllabi.id, syllabusJoinRequests.syllabusId))
    .leftJoin(groups, eq(groups.id, syllabusJoinRequests.groupId))
    .leftJoin(syllabusShareLinks, eq(syllabusShareLinks.syllabusId, syllabusJoinRequests.syllabusId))
    .where(eq(syllabusJoinRequests.studentId, studentId))
    .orderBy(desc(syllabusJoinRequests.createdAt))
    .limit(50);
}

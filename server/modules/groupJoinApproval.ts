import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  groupJoinDeclines,
  groupJoinSettings,
  groupMembers,
  groupMemberSources,
  groups,
  providerWorkspaces,
  syllabi,
  syllabusAccessGrants,
  syllabusJoinRequests,
} from "../../drizzle/schema";
import { JOIN_REQUEST_COOLDOWN_MS } from "../../shared/groupJoinPolicy";
import { requireDb, type DbOrTx } from "../db";
import { isMissingTable } from "../notifications/preferences";

/** Missing table = migration 0044 not applied yet: no group requires approval, nothing is on cooldown. */
async function tolerant<T>(fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    return fallback;
  }
}

export interface JoinSettings {
  approvalRequired: boolean;
  /** Under APPROVAL: students already known to the group's owner skip the queue. On unless the teacher turned it off. */
  autoApproveKnown: boolean;
}

const DEFAULT_SETTINGS: JoinSettings = { approvalRequired: false, autoApproveKnown: true };

/** Join settings of `groupIds`; a group without a row has the defaults. */
export async function joinSettingsOf(groupIds: readonly string[], db: DbOrTx = requireDb()): Promise<Map<string, JoinSettings>> {
  const out = new Map<string, JoinSettings>();
  if (!groupIds.length) return out;
  return tolerant(out, async () => {
    const rows = await db
      .select({ groupId: groupJoinSettings.groupId, approvalRequired: groupJoinSettings.approvalRequired, autoApproveKnown: groupJoinSettings.autoApproveKnown })
      .from(groupJoinSettings)
      .where(inArray(groupJoinSettings.groupId, [...new Set(groupIds)]));
    for (const { groupId, ...settings } of rows) out.set(groupId, settings);
    return out;
  });
}

export async function joinSettings(groupId: string, db: DbOrTx = requireDb()): Promise<JoinSettings> {
  return (await joinSettingsOf([groupId], db)).get(groupId) ?? DEFAULT_SETTINGS;
}

/** Groups (of `groupIds`) whose code/link joins wait for the teacher's approval. */
export async function approvalGroupIds(groupIds: readonly string[], db: DbOrTx = requireDb()): Promise<Set<string>> {
  const settings = await joinSettingsOf(groupIds, db);
  return new Set([...settings].filter(([, s]) => s.approvalRequired).map(([id]) => id));
}

export async function approvalRequired(groupId: string, db: DbOrTx = requireDb()): Promise<boolean> {
  return (await joinSettings(groupId, db)).approvalRequired;
}

/**
 * Throws before migration 0044, so a teacher never believes approval is on while links still admit
 * people at once. `autoApproveKnown` undefined keeps the stored choice.
 */
export async function setApprovalRequired(db: DbOrTx, groupId: string, required: boolean, actorUserId: number, autoApproveKnown?: boolean): Promise<void> {
  const set = { approvalRequired: required, updatedBy: actorUserId, ...(autoApproveKnown === undefined ? {} : { autoApproveKnown }) };
  try {
    await db.insert(groupJoinSettings).values({ groupId, ...set }).onDuplicateKeyUpdate({ set });
  } catch (error) {
    if (!required && isMissingTable(error)) return;
    throw error;
  }
}

export async function recordDecline(db: DbOrTx, groupId: string, userId: number, declinedBy: number, at = new Date()): Promise<void> {
  await tolerant(undefined, async () => {
    await db
      .insert(groupJoinDeclines)
      .values({ groupId, userId, declinedBy, declinedAt: at })
      .onDuplicateKeyUpdate({ set: { declinedBy, declinedAt: at } });
  });
}

/** Pure: whether a decline at `declinedAt` still blocks a new request at `now`. */
export const onCooldown = (declinedAt: Date | null, now: Date) => !!declinedAt && now.getTime() - declinedAt.getTime() < JOIN_REQUEST_COOLDOWN_MS;

export async function lastDeclineAt(db: DbOrTx, groupId: string, userId: number): Promise<Date | null> {
  return tolerant(null, async () => {
    const [row] = await db
      .select({ at: groupJoinDeclines.declinedAt })
      .from(groupJoinDeclines)
      .where(and(eq(groupJoinDeclines.groupId, groupId), eq(groupJoinDeclines.userId, userId)))
      .limit(1);
    return row?.at ?? null;
  });
}

export type KnownStudentReason = "OTHER_GROUP" | "FORMER_MEMBER" | "SYLLABUS_REQUEST" | "SYLLABUS_GRANT";

/**
 * Why `userId` already counts as a student of `ownerUserId` (the owner of the group being joined),
 * or null. Across every workspace that teacher owns, excluding the group being joined:
 * - OTHER_GROUP: an ACTIVE member of another of their groups (a PENDING request doesn't count);
 * - FORMER_MEMBER: once an ACTIVE member of another of their groups and since removed — the
 *   membership's `group_member_sources` row outlives it (declined or removed requests leave none);
 * - SYLLABUS_REQUEST: one of their syllabus join requests was accepted for this student;
 * - SYLLABUS_GRANT: the student was given individual access to one of their syllabi (even if later revoked).
 */
export async function knownStudentReason(db: DbOrTx, input: { ownerUserId: number; groupId: string; userId: number }): Promise<KnownStudentReason | null> {
  const workspaceIds = (await db.select({ id: providerWorkspaces.id }).from(providerWorkspaces).where(eq(providerWorkspaces.ownerUserId, input.ownerUserId))).map((w) => w.id);
  if (!workspaceIds.length) return null;
  const otherGroupIds = (
    await db
      .select({ id: groups.id })
      .from(groups)
      .where(and(inArray(groups.providerWorkspaceId, workspaceIds), ne(groups.id, input.groupId)))
  ).map((g) => g.id);

  if (otherGroupIds.length) {
    const [active] = await db
      .select({ id: groupMembers.id })
      .from(groupMembers)
      .where(and(eq(groupMembers.userId, input.userId), inArray(groupMembers.groupId, otherGroupIds), eq(groupMembers.status, "ACTIVE")))
      .limit(1);
    if (active) return "OTHER_GROUP";
    const former = await tolerant(undefined, async () => {
      const [row] = await db
        .select({ id: groupMemberSources.membershipId })
        .from(groupMemberSources)
        .leftJoin(groupMembers, eq(groupMembers.id, groupMemberSources.membershipId))
        .where(and(eq(groupMemberSources.userId, input.userId), inArray(groupMemberSources.groupId, otherGroupIds), isNull(groupMembers.id)))
        .limit(1);
      return row;
    });
    if (former) return "FORMER_MEMBER";
  }

  const [request] = await db
    .select({ id: syllabusJoinRequests.id })
    .from(syllabusJoinRequests)
    .where(and(eq(syllabusJoinRequests.studentId, input.userId), inArray(syllabusJoinRequests.workspaceId, workspaceIds), eq(syllabusJoinRequests.status, "ACCEPTED")))
    .limit(1);
  if (request) return "SYLLABUS_REQUEST";
  const [grant] = await db
    .select({ id: syllabusAccessGrants.id })
    .from(syllabusAccessGrants)
    .innerJoin(syllabi, eq(syllabi.id, syllabusAccessGrants.syllabusId))
    .where(and(eq(syllabusAccessGrants.studentId, input.userId), inArray(syllabi.providerWorkspaceId, workspaceIds)))
    .limit(1);
  if (grant) return "SYLLABUS_GRANT";
  return null;
}

import { and, eq, inArray } from "drizzle-orm";
import { groupJoinDeclines, groupJoinSettings } from "../../drizzle/schema";
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

/** Groups (of `groupIds`) whose code/link joins wait for the teacher's approval. */
export async function approvalGroupIds(groupIds: readonly string[], db: DbOrTx = requireDb()): Promise<Set<string>> {
  if (!groupIds.length) return new Set();
  return tolerant(new Set<string>(), async () => {
    const rows = await db
      .select({ groupId: groupJoinSettings.groupId })
      .from(groupJoinSettings)
      .where(and(inArray(groupJoinSettings.groupId, [...new Set(groupIds)]), eq(groupJoinSettings.approvalRequired, true)));
    return new Set(rows.map((r) => r.groupId));
  });
}

export async function approvalRequired(groupId: string, db: DbOrTx = requireDb()): Promise<boolean> {
  return (await approvalGroupIds([groupId], db)).has(groupId);
}

/** Throws before migration 0044, so a teacher never believes approval is on while links still admit people at once. */
export async function setApprovalRequired(db: DbOrTx, groupId: string, required: boolean, actorUserId: number): Promise<void> {
  try {
    await db
      .insert(groupJoinSettings)
      .values({ groupId, approvalRequired: required, updatedBy: actorUserId })
      .onDuplicateKeyUpdate({ set: { approvalRequired: required, updatedBy: actorUserId } });
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

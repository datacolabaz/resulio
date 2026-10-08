import { inArray } from "drizzle-orm";
import { users } from "../../drizzle/schema";
import { requireDb } from "../db";
import { dispatch } from "../notifications/dispatcher";
import { activatePendingLinkJoins, type LinkJoin } from "./groups";
import { notifyOpenTasksOnJoin } from "./taskNotify";

/** Teacher notice key for a code/link join; a removed student who re-joins gets a new membership row, hence a new notice. */
export const linkJoinKey = (membershipId: number) => `group-join:${membershipId}`;
/** Teacher notice key for a single-use invite link, which can only ever be redeemed once. */
export const singleUseLinkJoinKey = (linkId: string) => `group-join-link:${linkId}`;

/**
 * What a student joining through an invite link triggers besides the ACTIVE membership row itself
 * (group tasks, materials, syllabi, the group board and analytics all follow from that row on
 * read): the student's one TASK_ASSIGNED notice for the group's open tasks, and the teacher's
 * informational GROUP_MEMBER_JOINED notice. Both run in the background.
 */
export function afterLinkJoin(join: Pick<LinkJoin, "groupId" | "groupName" | "ownerUserId" | "userId">, studentName: string | null, dedupeKey: string) {
  notifyOpenTasksOnJoin(join.groupId, join.userId);
  dispatch({
    event: "GROUP_MEMBER_JOINED",
    userId: join.ownerUserId,
    dedupeKey,
    data: { groupId: join.groupId, groupName: join.groupName, studentName },
  });
}

/** Startup one-off, see `activatePendingLinkJoins`. Returns how many waiting requests it activated. */
export async function runPendingLinkJoinBackfill(): Promise<number> {
  const activated = await activatePendingLinkJoins();
  if (!activated.length) return 0;
  const rows = await requireDb()
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, [...new Set(activated.map((a) => a.userId))]));
  const names = new Map(rows.map((r) => [r.id, r.name]));
  for (const join of activated) afterLinkJoin(join, names.get(join.userId) ?? null, linkJoinKey(join.membershipId));
  console.log(`[Groups] Activated ${activated.length} pending join request(s) made through a still-valid invite link`);
  return activated.length;
}

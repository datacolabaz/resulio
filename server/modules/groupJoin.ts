import { dispatch } from "../notifications/dispatcher";
import { announceGroupJoin } from "../syllabus/notify";
import type { JoinDecision, LinkJoin } from "./groups";
import { notifyOpenTasksOnJoin } from "./taskNotify";

/** Teacher notice key for a code/link join; a removed student who re-joins gets a new membership row, hence a new notice. */
export const linkJoinKey = (membershipId: number) => `group-join:${membershipId}`;
/** Teacher notice key for a single-use invite link, which can only ever be redeemed once. */
export const singleUseLinkJoinKey = (linkId: string) => `group-join-link:${linkId}`;
/** Teacher notice key for a code request (APPROVAL policy); a declined student who asks again later is a new row. */
export const joinRequestKey = (membershipId: number) => `group-join-request:${membershipId}`;
/** Student notice key for the teacher's answer to one request. */
export const joinDecisionKey = (membershipId: number) => `group-join-decided:${membershipId}`;

/** What becoming an ACTIVE member triggers besides the row itself: the student's TASK_ASSIGNED notice for open group tasks and syllabus notices. */
function onActivated(groupId: string, userId: number) {
  notifyOpenTasksOnJoin(groupId, userId);
  announceGroupJoin(groupId, userId);
}

/**
 * What a student joining through an invite link triggers besides the ACTIVE membership row itself
 * (group tasks, materials, syllabi, the group board and analytics all follow from that row on
 * read): the student's one TASK_ASSIGNED notice for the group's open tasks, and the teacher's
 * informational GROUP_MEMBER_JOINED notice. Both run in the background.
 */
export function afterLinkJoin(join: Pick<LinkJoin, "groupId" | "groupName" | "ownerUserId" | "userId">, studentName: string | null, dedupeKey: string) {
  onActivated(join.groupId, join.userId);
  dispatch({
    event: "GROUP_MEMBER_JOINED",
    userId: join.ownerUserId,
    dedupeKey,
    data: { groupId: join.groupId, groupName: join.groupName, studentName },
  });
}

/** A new code request (APPROVAL policy): only the teacher hears of it, with a link to the requests tab. */
export function afterJoinRequest(join: Pick<LinkJoin, "groupId" | "groupName" | "ownerUserId" | "membershipId">, studentName: string | null) {
  dispatch({
    event: "GROUP_MEMBER_JOINED",
    userId: join.ownerUserId,
    dedupeKey: joinRequestKey(join.membershipId),
    data: { groupId: join.groupId, groupName: join.groupName, studentName, pending: true },
  });
}

/** The teacher answered requests: approved students get the group's open tasks, and everyone hears the outcome. */
export function afterJoinDecisions(group: { id: string; name: string }, decisions: readonly JoinDecision[], decision: "APPROVED" | "DECLINED") {
  for (const d of decisions) {
    if (decision === "APPROVED") onActivated(group.id, d.userId);
    dispatch({
      event: "GROUP_JOIN_DECIDED",
      userId: d.userId,
      dedupeKey: joinDecisionKey(d.membershipId),
      data: { groupId: group.id, groupName: group.name, decision },
    });
  }
}

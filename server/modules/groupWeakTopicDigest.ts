import { eq } from "drizzle-orm";
import { groups, providerWorkspaces } from "../../drizzle/schema";
import { requireDb } from "../db";
import { groupAnalytics } from "./analytics";
import { dayKey } from "./motivation";
import { dispatch } from "../notifications/dispatcher";
import { MIN_QUESTION_SAMPLE } from "../../shared/assessment";
import { isMissingTable } from "../notifications/preferences";

/**
 * GROUP_WEAK_TOPIC_DIGEST: once a day while it holds, tells a group's teacher which topics the
 * group as a whole is weak on across its exams, with a deep link that opens a new exam draft
 * already targeted at the group and pre-filled to the weakest topic (teacherWeakTopicExamPath).
 * Follows the same shape as the Growth Engine's daily risk digest and the syllabus at-risk digest
 * (dedupe by day, re-fires every day the condition still holds), but is NOT gated behind the
 * Growth Engine's feature flag -- weak-topic analytics is a plain assessment feature available to
 * every workspace, so this runs its own daily pass instead of piggybacking on `onGrowthDaily`.
 */

/** At most this many topics are named in one digest; `count` still carries the true total. */
const DIGEST_TOPICS = 5;

/**
 * Pure: which of a group's WEAK topics are worth telling the teacher about, and in what order.
 * Mirrors `rankableQuestion`'s minimum-sample guard (shared/assessment.MIN_QUESTION_SAMPLE) at the
 * topic level -- a topic seen on only one or two answered questions is noise, not a signal.
 */
export function digestTopicsOf(weakTopics: ReadonlyArray<{ topic: string; questionCount: number; accuracyPercentage: number }>, minSample = MIN_QUESTION_SAMPLE) {
  const named = weakTopics
    .filter((t) => t.questionCount >= minSample)
    .sort((a, b) => a.accuracyPercentage - b.accuracyPercentage)
    .map((t) => t.topic);
  return { count: named.length, topics: named.slice(0, DIGEST_TOPICS) };
}

export async function sendGroupWeakTopicDigestFor(group: { id: string; name: string; workspaceId: string; ownerUserId: number }, now = new Date()) {
  const full = await groupAnalytics({ workspaceId: group.workspaceId, userId: group.ownerUserId }, group.id);
  const { count, topics } = digestTopicsOf(full.weakTopics);
  if (!count) return false;
  dispatch({
    event: "GROUP_WEAK_TOPIC_DIGEST",
    userId: group.ownerUserId,
    dedupeKey: `group-weak-topic:${group.id}:${dayKey(now)}`,
    data: { groupId: group.id, groupName: group.name, count, topics },
  });
  return true;
}

/** Matches the syllabus at-risk digest's cadence: once a day, after the morning hour, Baku time. */
const DIGEST_HOUR_BAKU = 8;
const bakuHour = (now: Date) => new Date(now.getTime() + 4 * 3_600_000).getUTCHours();

let lastDigestDay: string | null = null;

/** Once a day after 08:00 Baku; several instances are safe because the dedupe key is per group and day. */
export async function runGroupWeakTopicDigest(now = new Date()) {
  const day = dayKey(now);
  if (lastDigestDay === day || bakuHour(now) < DIGEST_HOUR_BAKU) return 0;
  lastDigestDay = day;
  const db = requireDb();
  let rows: { id: string; name: string; workspaceId: string; ownerUserId: number }[];
  try {
    rows = await db
      .select({ id: groups.id, name: groups.name, workspaceId: groups.providerWorkspaceId, ownerUserId: providerWorkspaces.ownerUserId })
      .from(groups)
      .innerJoin(providerWorkspaces, eq(providerWorkspaces.id, groups.providerWorkspaceId));
  } catch (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
  let sent = 0;
  for (const g of rows) {
    try {
      if (await sendGroupWeakTopicDigestFor(g, now)) sent++;
    } catch (error) {
      console.error("[groups] weak-topic digest failed", g.id, error instanceof Error ? error.message : error);
    }
  }
  return sent;
}

import { and, eq, inArray, sql } from "drizzle-orm";
import { assessmentOrigins, releasedTopicLevels, results, studentTopicMastery } from "../../drizzle/schema";
import type { MasteryStatus } from "../../shared/growth";
import { requireDb } from "../db";
import { masteryRows, type StatRow } from "./mastery";
import { onlyReleased, releasedResultIds } from "./released";
import { studentStats } from "./weakness";
import { statusUpXp, XP } from "./xp";
import { awardXp } from "./xpStore";

/**
 * Grade-dependent XP (a topic moving up a level, the practice bonus for 70%+) comes only from
 * results the student can already see, so XP never gives away a grade before it is released.
 * Run after every recompute, daily (release by a closing window has no event), and when the student
 * opens the plan. Every award is idempotent by its ledger key.
 */

/** Pure: XP for topics above the level the student last saw. A topic seen for the first time earns nothing. */
export function levelUps(seen: ReadonlyMap<string, MasteryStatus>, current: { topicKey: string; status: MasteryStatus }[]) {
  return current.flatMap((c) => {
    const points = statusUpXp(seen.get(c.topicKey) ?? null, c.status);
    return points > 0 ? [{ topicKey: c.topicKey, status: c.status, points }] : [];
  });
}

export interface ReleasedXpDeps {
  stats: (workspaceId: string, studentId: number) => Promise<StatRow[]>;
  releasedIds: (workspaceId: string, studentId: number) => Promise<Set<string>>;
  seenLevels: (workspaceId: string, studentId: number) => Promise<Map<string, MasteryStatus>>;
  saveLevels: (workspaceId: string, studentId: number, levels: { topicKey: string; status: MasteryStatus }[]) => Promise<void>;
  goodPractice: (workspaceId: string, studentId: number, resultIds: string[]) => Promise<string[]>;
  award: typeof awardXp;
}

export async function syncReleasedXp(workspaceId: string, studentId: number, deps: ReleasedXpDeps = dbDeps, now = new Date()) {
  const released = await deps.releasedIds(workspaceId, studentId);
  const topics = masteryRows(onlyReleased(await deps.stats(workspaceId, studentId), released))
    .filter((m) => m.dimension === "TOPIC")
    .map((m) => ({ topicKey: m.topicKey, status: m.status }));
  for (const up of levelUps(await deps.seenLevels(workspaceId, studentId), topics)) {
    await deps.award({ studentId, workspaceId, type: "STATUS_UP", points: up.points, refKey: `status:${workspaceId}:${up.topicKey}:${up.status}` }, now);
  }
  if (topics.length) await deps.saveLevels(workspaceId, studentId, topics);
  for (const assessmentId of await deps.goodPractice(workspaceId, studentId, [...released])) {
    await deps.award({ studentId, workspaceId, type: "PRACTICE_DONE", points: XP.PRACTICE_GOOD_BONUS, refKey: `practice-good:${assessmentId}` }, now);
  }
}

const LEVEL_CHUNK = 400;

const dbDeps: ReleasedXpDeps = {
  stats: (workspaceId, studentId) => studentStats(workspaceId, studentId),
  releasedIds: (workspaceId, studentId) => releasedResultIds(workspaceId, studentId),
  async seenLevels(workspaceId, studentId) {
    const rows = await requireDb()
      .select({ topicKey: releasedTopicLevels.topicKey, status: releasedTopicLevels.status })
      .from(releasedTopicLevels)
      .where(and(eq(releasedTopicLevels.workspaceId, workspaceId), eq(releasedTopicLevels.studentId, studentId)));
    return new Map(rows.map((r) => [r.topicKey, r.status]));
  },
  async saveLevels(workspaceId, studentId, levels) {
    const db = requireDb();
    for (let i = 0; i < levels.length; i += LEVEL_CHUNK) {
      await db
        .insert(releasedTopicLevels)
        .values(levels.slice(i, i + LEVEL_CHUNK).map((l) => ({ workspaceId, studentId, topicKey: l.topicKey, status: l.status })))
        .onDuplicateKeyUpdate({ set: { status: sql`values(${releasedTopicLevels.status})` } });
    }
  },
  async goodPractice(workspaceId, studentId, resultIds) {
    if (!resultIds.length) return [];
    const rows = await requireDb()
      .select({ assessmentId: results.assessmentId, percentage: results.percentage })
      .from(results)
      .innerJoin(assessmentOrigins, eq(assessmentOrigins.assessmentId, results.assessmentId))
      .where(and(eq(assessmentOrigins.workspaceId, workspaceId), eq(results.studentId, studentId), inArray(results.id, resultIds)));
    return rows.filter((r) => r.percentage != null && r.percentage >= XP.PRACTICE_GOOD_AT).map((r) => r.assessmentId);
  },
  award: awardXp,
};

/** Daily: every student with mastery in the workspace, to catch results released by a closing window. */
export async function dailyReleasedXpPass(workspaceId: string) {
  const students = await requireDb()
    .selectDistinct({ studentId: studentTopicMastery.studentId })
    .from(studentTopicMastery)
    .where(eq(studentTopicMastery.workspaceId, workspaceId));
  for (const s of students) await syncReleasedXp(workspaceId, s.studentId);
}

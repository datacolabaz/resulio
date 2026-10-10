import { requireDb } from "../db";
import { studentGroupWorkspace, studentGrowthGroups } from "./availability";
import { masteryRows, topGains, type MasteryRow } from "./mastery";
import { onlyReleased, releasedResultIds } from "./released";
import { studentStats } from "./weakness";

/**
 * The student's own topic map. Recomputed on read from released results only, so it never shows
 * a grade the exam still withholds; the teacher's materialized mastery is not used here.
 */

/** One entry per teacher (workspace) the student learns with, named by their groups there. */
export async function studentSpaces(userId: number) {
  const spaces = new Map<string, { groupId: string; groups: string[] }>();
  for (const g of await studentGrowthGroups(userId)) {
    const s = spaces.get(g.workspaceId) ?? { groupId: g.groupId, groups: [] };
    s.groups.push(g.name);
    spaces.set(g.workspaceId, s);
  }
  return [...spaces.values()];
}

export async function releasedMastery(workspaceId: string, studentId: number) {
  const db = requireDb();
  const released = await releasedResultIds(workspaceId, studentId, db);
  const stats = onlyReleased(await studentStats(workspaceId, studentId, db), released);
  return { stats, mastery: masteryRows(stats) };
}

const byWeakest = (a: MasteryRow, b: MasteryRow) => a.mastery - b.mastery || a.label.localeCompare(b.label);

export async function studentWeaknessMap(userId: number, groupId: string) {
  const { workspaceId } = await studentGroupWorkspace(userId, groupId);
  const { stats, mastery } = await releasedMastery(workspaceId, userId);
  const strip = (m: MasteryRow) => ({
    topicKey: m.topicKey,
    label: m.label,
    mastery: m.mastery,
    status: m.status,
    trend: m.trend,
    trendDelta: m.trendDelta,
    evidenceCount: m.evidenceCount,
    lastEvidenceAt: m.lastEvidenceAt,
  });
  return {
    topics: mastery.filter((m) => m.dimension === "TOPIC").sort(byWeakest).map(strip),
    skills: mastery.filter((m) => m.dimension === "SKILL").sort(byWeakest).map(strip),
    gains: topGains(mastery, stats),
  };
}

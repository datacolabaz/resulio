import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { resultTopicStats, studentTopicMastery, users } from "../../drizzle/schema";
import { requireDb, type DbOrTx } from "../db";
import type { TeacherScope } from "../modules/access";
import { activeStudentIdsOfGroups, assertGroupOwner, assertTeacherHasStudent } from "../modules/groups";
import { masteryRows, topGains, type MasteryRow, type StatRow } from "./mastery";
import { markDirty } from "./store";
import { statusUpXp } from "./xp";
import { awardXp } from "./xpStore";
import { UNTAGGED_TOPIC_KEY, type MasteryStatus } from "../../shared/growth";

/** Weakness map: materialized mastery per student and topic, and the teacher's group and student views of it. */

const INSERT_CHUNK = 400;
const GROUP_TOPICS_MAX = 40;
const HISTORY_POINTS = 6;

export async function studentStats(workspaceId: string, studentId: number, db: DbOrTx = requireDb()): Promise<StatRow[]> {
  return db
    .select({
      resultId: resultTopicStats.resultId,
      dimension: resultTopicStats.dimension,
      topicKey: resultTopicStats.topicKey,
      questionTopicId: resultTopicStats.questionTopicId,
      label: resultTopicStats.label,
      origin: resultTopicStats.origin,
      completedAt: resultTopicStats.completedAt,
      questionCount: resultTopicStats.questionCount,
      pendingCount: resultTopicStats.pendingCount,
      earned: resultTopicStats.earned,
      possible: resultTopicStats.possible,
      wrongPoints: resultTopicStats.wrongPoints,
    })
    .from(resultTopicStats)
    .where(and(eq(resultTopicStats.workspaceId, workspaceId), eq(resultTopicStats.studentId, studentId)))
    .orderBy(asc(resultTopicStats.completedAt));
}

/** Recompute step after the stats: rewrites the student's mastery rows. */
export async function writeMastery(workspaceId: string, studentId: number) {
  const db = requireDb();
  const rows = masteryRows(await studentStats(workspaceId, studentId, db));
  const before = new Map(
    (await studentMastery(workspaceId, [studentId], db)).filter((m) => m.dimension === "TOPIC").map((m) => [m.topicKey, m.status]),
  );
  await db.transaction(async (tx) => {
    await tx.delete(studentTopicMastery).where(and(eq(studentTopicMastery.workspaceId, workspaceId), eq(studentTopicMastery.studentId, studentId)));
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx.insert(studentTopicMastery).values(rows.slice(i, i + INSERT_CHUNK).map((r) => ({ ...r, workspaceId, studentId })));
    }
  });
  // A topic moving up earns XP once per topic and level; moving down never costs any.
  for (const r of rows) {
    if (r.dimension !== "TOPIC") continue;
    const points = statusUpXp(before.get(r.topicKey) ?? null, r.status);
    if (points > 0) await awardXp({ studentId, workspaceId, type: "STATUS_UP", points, refKey: `status:${workspaceId}:${r.topicKey}:${r.status}` });
  }
}

/** Students with tagged evidence but no mastery rows yet (stats written before this step existed). */
export async function markMissingMastery(workspaceId: string, limit = 2000) {
  const db = requireDb();
  const rows = await db
    .selectDistinct({ studentId: resultTopicStats.studentId })
    .from(resultTopicStats)
    .leftJoin(
      studentTopicMastery,
      and(eq(studentTopicMastery.workspaceId, resultTopicStats.workspaceId), eq(studentTopicMastery.studentId, resultTopicStats.studentId)),
    )
    .where(and(eq(resultTopicStats.workspaceId, workspaceId), ne(resultTopicStats.topicKey, UNTAGGED_TOPIC_KEY), isNull(studentTopicMastery.studentId)))
    .limit(limit);
  await markDirty(workspaceId, rows.map((r) => r.studentId), "backfill", db);
  return rows.length;
}

export async function studentMastery(workspaceId: string, studentIds: number[], db: DbOrTx = requireDb()): Promise<(MasteryRow & { studentId: number })[]> {
  if (!studentIds.length) return [];
  const rows = await db
    .select()
    .from(studentTopicMastery)
    .where(and(eq(studentTopicMastery.workspaceId, workspaceId), inArray(studentTopicMastery.studentId, studentIds)));
  return rows.map((r) => ({ ...r, status: r.status as MasteryStatus, trend: r.trend as MasteryRow["trend"] }));
}

/** Per topic, the student's last few results on it (percent), oldest first: the sparkline of the detail view. */
export function topicHistory(stats: StatRow[], limit = HISTORY_POINTS) {
  const out = new Map<string, { at: Date; pct: number }[]>();
  for (const s of stats) {
    if (s.dimension !== "TOPIC" || s.topicKey === UNTAGGED_TOPIC_KEY || s.possible <= 0) continue;
    const list = out.get(s.topicKey) ?? [];
    list.push({ at: s.completedAt, pct: Math.round((s.earned / s.possible) * 1000) / 10 });
    out.set(s.topicKey, list);
  }
  for (const [k, list] of out) out.set(k, list.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(-limit));
  return out;
}

const byWeakest = (a: MasteryRow, b: MasteryRow) => a.mastery - b.mastery || a.label.localeCompare(b.label);

export async function studentWeakness(scope: TeacherScope, studentId: number) {
  await assertTeacherHasStudent(scope, studentId);
  const db = requireDb();
  const [student] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, studentId)).limit(1);
  const [mastery, stats] = await Promise.all([studentMastery(scope.workspaceId, [studentId], db), studentStats(scope.workspaceId, studentId, db)]);
  const history = topicHistory(stats);
  return {
    student: { id: studentId, name: student?.name ?? "" },
    topics: mastery
      .filter((m) => m.dimension === "TOPIC")
      .sort(byWeakest)
      .map((m) => ({ ...m, history: history.get(m.topicKey) ?? [] })),
    skills: mastery.filter((m) => m.dimension === "SKILL").sort(byWeakest),
    gains: topGains(mastery, stats),
  };
}

export interface GroupTopic {
  topicKey: string;
  label: string;
  studentCount: number;
  avgMastery: number;
  critical: number;
  review: number;
}

/** Topics of a group, the most widespread weakness first; only students with enough evidence count as weak. */
export function summarizeGroupTopics(cells: Pick<MasteryRow & { studentId: number }, "topicKey" | "label" | "mastery" | "status" | "studentId">[], limit = GROUP_TOPICS_MAX): GroupTopic[] {
  const map = new Map<string, GroupTopic & { sum: number }>();
  for (const c of cells) {
    const t = map.get(c.topicKey) ?? { topicKey: c.topicKey, label: c.label, studentCount: 0, avgMastery: 0, critical: 0, review: 0, sum: 0 };
    t.studentCount++;
    t.sum += c.mastery;
    if (c.status === "CRITICAL") t.critical++;
    if (c.status === "REVIEW") t.review++;
    map.set(c.topicKey, t);
  }
  return [...map.values()]
    .map(({ sum, ...t }) => ({ ...t, avgMastery: Math.round((sum / t.studentCount) * 10) / 10 }))
    .sort((a, b) => b.critical - a.critical || a.avgMastery - b.avgMastery || a.label.localeCompare(b.label))
    .slice(0, limit);
}

export async function groupWeakness(scope: TeacherScope, groupId: string) {
  await assertGroupOwner(scope, groupId);
  const db = requireDb();
  const studentIds = await activeStudentIdsOfGroups([groupId], db);
  const students = studentIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, studentIds)) : [];
  const cells = (await studentMastery(scope.workspaceId, studentIds, db)).filter((m) => m.dimension === "TOPIC");
  const topics = summarizeGroupTopics(cells);
  const shown = new Set(topics.map((t) => t.topicKey));
  return {
    students: students.map((s) => ({ id: s.id, name: s.name ?? "" })).sort((a, b) => a.name.localeCompare(b.name)),
    topics,
    cells: cells
      .filter((c) => shown.has(c.topicKey))
      .map((c) => ({ studentId: c.studentId, topicKey: c.topicKey, mastery: c.mastery, status: c.status, trend: c.trend, evidenceCount: c.evidenceCount })),
  };
}

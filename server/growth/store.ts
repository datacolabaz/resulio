import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import {
  assessmentOrigins,
  assessments,
  attempts,
  growthDirty,
  questionMeta,
  questionTopics,
  resultItems,
  resultTopicStats,
  results,
  topicAliases,
  versionQuestions,
} from "../../drizzle/schema";
import { requireDb, type DbOrTx } from "../db";
import { isMissingTable } from "../notifications/preferences";
import { isSchemaBehind } from "../syllabus/availability";
import { buildCatalog, buildTopicStats, originOf, resolveSkill, resolveTopic, type CatalogSection, type TopicAlias, type TopicCatalog } from "./topics";

/**
 * Loading and writing the Growth Engine's evidence: result_topic_stats per (workspace, student),
 * rebuilt from results whenever something changes, plus the dirty queue that drives it.
 * Every write here is idempotent: a student's rows are deleted and rebuilt in one transaction.
 */

const INSERT_CHUNK = 400;

export async function loadCatalog(workspaceId: string, db: DbOrTx = requireDb()): Promise<TopicCatalog> {
  let topics: { id: string; name: string; parentId: string | null }[] = [];
  try {
    topics = await db
      .select({ id: questionTopics.id, name: questionTopics.name, parentId: questionTopics.parentId })
      .from(questionTopics)
      .where(eq(questionTopics.providerWorkspaceId, workspaceId));
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  const names = new Map(topics.map((t) => [t.id, t.name]));
  const sections: CatalogSection[] = topics.filter((t) => t.parentId).map((t) => ({ id: t.id, name: t.name, parentName: names.get(t.parentId!) ?? null }));
  const aliases: TopicAlias[] = await db
    .select({ aliasKey: topicAliases.aliasKey, label: topicAliases.label, questionTopicId: topicAliases.questionTopicId })
    .from(topicAliases)
    .where(eq(topicAliases.workspaceId, workspaceId));
  return buildCatalog(sections, aliases);
}

/** Result rows of one student in one workspace that count as evidence (voided attempts never do). */
export async function studentResults(workspaceId: string, studentId: number, db: DbOrTx = requireDb()) {
  return db
    .select({
      id: results.id,
      assessmentId: results.assessmentId,
      versionId: results.versionId,
      percentage: results.percentage,
      completedAt: results.completedAt,
      pendingReviewCount: results.pendingReviewCount,
      attemptStatus: attempts.status,
    })
    .from(results)
    .innerJoin(assessments, eq(assessments.id, results.assessmentId))
    .innerJoin(attempts, eq(attempts.id, results.attemptId))
    .where(and(eq(assessments.providerWorkspaceId, workspaceId), eq(results.studentId, studentId), ne(attempts.status, "VOIDED")))
    .orderBy(asc(results.completedAt));
}

export async function originsOf(assessmentIds: string[], db: DbOrTx = requireDb()) {
  if (!assessmentIds.length) return new Map<string, string>();
  const rows = await db
    .select({ assessmentId: assessmentOrigins.assessmentId, origin: assessmentOrigins.origin })
    .from(assessmentOrigins)
    .where(inArray(assessmentOrigins.assessmentId, [...new Set(assessmentIds)]));
  return new Map(rows.map((r) => [r.assessmentId, r.origin]));
}

async function filedSections(questionIds: string[], db: DbOrTx) {
  if (!questionIds.length) return new Map<string, string>();
  try {
    const rows = await db
      .select({ questionId: questionMeta.questionId, sectionId: questionMeta.sectionId })
      .from(questionMeta)
      .where(and(inArray(questionMeta.questionId, questionIds), isNotNull(questionMeta.sectionId)));
    return new Map(rows.map((r) => [r.questionId, r.sectionId!]));
  } catch (error) {
    if (isMissingTable(error)) return new Map<string, string>();
    throw error;
  }
}

/** Rebuilds every result_topic_stats row of one student in one workspace. Returns how many results it covered. */
export async function rebuildStudentStats(workspaceId: string, studentId: number, catalog?: TopicCatalog): Promise<number> {
  const db = requireDb();
  const cat = catalog ?? (await loadCatalog(workspaceId, db));
  const rs = await studentResults(workspaceId, studentId, db);
  const resultIds = rs.map((r) => r.id);
  const items = resultIds.length ? await db.select().from(resultItems).where(inArray(resultItems.resultId, resultIds)) : [];
  const vqIds = [...new Set(items.map((i) => i.versionQuestionId))];
  const vqs = vqIds.length
    ? await db.select({ id: versionQuestions.id, points: versionQuestions.points, sourceQuestionId: versionQuestions.sourceQuestionId }).from(versionQuestions).where(inArray(versionQuestions.id, vqIds))
    : [];
  const vqById = new Map(vqs.map((q) => [q.id, q]));
  const sections = await filedSections([...new Set(vqs.map((q) => q.sourceQuestionId).filter((x): x is string => !!x))], db);
  const origins = await originsOf(rs.map((r) => r.assessmentId), db);

  const rows: (typeof resultTopicStats.$inferInsert)[] = [];
  for (const r of rs) {
    const mine = items.filter((i) => i.resultId === r.id);
    const stats = buildTopicStats(
      mine.map((i) => {
        const vq = vqById.get(i.versionQuestionId);
        return {
          status: i.status,
          earned: i.earned,
          points: vq?.points ?? 0,
          topic: resolveTopic({ filedSectionId: vq?.sourceQuestionId ? (sections.get(vq.sourceQuestionId) ?? null) : null, frozenTopic: i.topic }, cat),
          skill: resolveSkill(i.skill),
        };
      }),
    );
    for (const s of stats) {
      rows.push({ ...s, resultId: r.id, workspaceId, studentId, assessmentId: r.assessmentId, origin: originOf(origins.get(r.assessmentId)), completedAt: r.completedAt });
    }
  }
  await db.transaction(async (tx) => {
    await tx.delete(resultTopicStats).where(and(eq(resultTopicStats.workspaceId, workspaceId), eq(resultTopicStats.studentId, studentId)));
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) await tx.insert(resultTopicStats).values(rows.slice(i, i + INSERT_CHUNK));
  });
  return rs.length;
}

// ---------------------------------------------------------------------------
// Dirty queue
// ---------------------------------------------------------------------------

export type RecomputeStep = (workspaceId: string, studentId: number) => Promise<void>;
const steps: RecomputeStep[] = [];

/** Later stages (mastery, risk) register here; they run in order after the stats are rebuilt. */
export function onStudentRecomputed(step: RecomputeStep) {
  steps.push(step);
}

export async function recomputeStudent(workspaceId: string, studentId: number) {
  await rebuildStudentStats(workspaceId, studentId);
  for (const step of steps) await step(workspaceId, studentId);
}

export async function markDirty(workspaceId: string, studentIds: number[], reason: string, db: DbOrTx = requireDb()) {
  const ids = [...new Set(studentIds)];
  if (!ids.length) return;
  const now = new Date();
  for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
    await db
      .insert(growthDirty)
      .values(ids.slice(i, i + INSERT_CHUNK).map((studentId) => ({ workspaceId, studentId, reason: reason.slice(0, 32), dirtyAt: now })))
      .onDuplicateKeyUpdate({ set: { reason: sql`values(${growthDirty.reason})`, dirtyAt: sql`values(${growthDirty.dirtyAt})` } });
  }
}

/** Marks every student with evidence in the workspace, e.g. after the topic mapping changed. */
export async function markWorkspaceDirty(workspaceId: string, reason: string) {
  const db = requireDb();
  const rows = await db.selectDistinct({ studentId: resultTopicStats.studentId }).from(resultTopicStats).where(eq(resultTopicStats.workspaceId, workspaceId));
  await markDirty(workspaceId, rows.map((r) => r.studentId), reason, db);
  return rows.length;
}

/** Processes one queued student; a mark made while it ran survives (only the exact dirtyAt seen is cleared). */
async function processDirty(row: { workspaceId: string; studentId: number; dirtyAt: Date }) {
  const db = requireDb();
  try {
    await recomputeStudent(row.workspaceId, row.studentId);
    await db.delete(growthDirty).where(and(eq(growthDirty.workspaceId, row.workspaceId), eq(growthDirty.studentId, row.studentId), eq(growthDirty.dirtyAt, row.dirtyAt)));
  } catch (error) {
    console.error("[Growth] recompute failed", row.workspaceId, row.studentId, error instanceof Error ? error.message : error);
    // To the back of the queue so one bad student never blocks the rest.
    await db
      .update(growthDirty)
      .set({ dirtyAt: new Date(), reason: "retry" })
      .where(and(eq(growthDirty.workspaceId, row.workspaceId), eq(growthDirty.studentId, row.studentId), eq(growthDirty.dirtyAt, row.dirtyAt)))
      .catch(() => undefined);
  }
}

export async function recomputeNow(workspaceId: string, studentId: number) {
  const [row] = await requireDb()
    .select()
    .from(growthDirty)
    .where(and(eq(growthDirty.workspaceId, workspaceId), eq(growthDirty.studentId, studentId)))
    .limit(1);
  if (row) await processDirty(row);
}

/** Sweeper body: the oldest queued students first. Quietly does nothing before migration 0049. */
export async function reconcileGrowth(limit = 50): Promise<number> {
  let queued: { workspaceId: string; studentId: number; dirtyAt: Date }[];
  try {
    queued = await requireDb().select().from(growthDirty).orderBy(asc(growthDirty.dirtyAt)).limit(limit);
  } catch (error) {
    if (isSchemaBehind(error)) return 0;
    throw error;
  }
  for (const row of queued) await processDirty(row);
  return queued.length;
}

/**
 * Students of the workspace with a counted result that has no stats yet (new data, or the backfill
 * after the flag was turned on). Results whose items have no topic still get their untagged row, so
 * nothing is picked up twice.
 */
export async function markMissingStats(workspaceId: string, limit = 2000): Promise<number> {
  const db = requireDb();
  const rows = await db
    .selectDistinct({ studentId: results.studentId })
    .from(results)
    .innerJoin(assessments, eq(assessments.id, results.assessmentId))
    .innerJoin(attempts, eq(attempts.id, results.attemptId))
    .leftJoin(resultTopicStats, eq(resultTopicStats.resultId, results.id))
    .where(and(eq(assessments.providerWorkspaceId, workspaceId), ne(attempts.status, "VOIDED"), isNull(resultTopicStats.resultId)))
    .limit(limit);
  await markDirty(workspaceId, rows.map((r) => r.studentId), "backfill", db);
  return rows.length;
}

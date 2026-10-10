import { and, asc, eq, sql } from "drizzle-orm";
import { questionTopics, resultTopicStats, topicAliases } from "../../drizzle/schema";
import { TEXT_KEY_PREFIX, UNTAGGED_TOPIC_KEY, isSectionKey } from "../../shared/growth";
import { requireDb } from "../db";
import type { TeacherScope } from "../modules/access";
import { AppError } from "../modules/errors";
import { markMissingStats, markWorkspaceDirty } from "./store";
import { sectionLabel, topicNameKey } from "./topics";

/**
 * Topic data quality for the teacher: how much of the evidence lands on bank sections, on free-text
 * topics no section matches, or on no topic at all — and the alias mapping that fixes it.
 */

export interface TopicHealth {
  totalQuestions: number;
  sectionQuestions: number;
  untaggedQuestions: number;
  textTopics: { aliasKey: string; label: string; questionCount: number; studentCount: number; mapped: boolean }[];
  aliases: { aliasKey: string; label: string; questionTopicId: string | null; sectionLabel: string | null }[];
  sections: { id: string; label: string }[];
}

async function sectionsOf(workspaceId: string) {
  const rows = await requireDb()
    .select({ id: questionTopics.id, name: questionTopics.name, parentId: questionTopics.parentId, position: questionTopics.position })
    .from(questionTopics)
    .where(eq(questionTopics.providerWorkspaceId, workspaceId))
    .orderBy(asc(questionTopics.position), asc(questionTopics.name));
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return rows.filter((r) => r.parentId).map((r) => ({ id: r.id, label: sectionLabel({ id: r.id, name: r.name, parentName: names.get(r.parentId!) ?? null }) }));
}

export async function topicHealth(scope: TeacherScope): Promise<TopicHealth> {
  const db = requireDb();
  await markMissingStats(scope.workspaceId, 200);
  const grouped = await db
    .select({
      topicKey: resultTopicStats.topicKey,
      label: sql<string>`max(${resultTopicStats.label})`,
      questions: sql<number>`sum(${resultTopicStats.questionCount})`,
      students: sql<number>`count(distinct ${resultTopicStats.studentId})`,
    })
    .from(resultTopicStats)
    .where(and(eq(resultTopicStats.workspaceId, scope.workspaceId), eq(resultTopicStats.dimension, "TOPIC")))
    .groupBy(resultTopicStats.topicKey);
  const aliasRows = await db.select().from(topicAliases).where(eq(topicAliases.workspaceId, scope.workspaceId));
  const sections = await sectionsOf(scope.workspaceId);
  const sectionById = new Map(sections.map((s) => [s.id, s.label]));
  const aliasKeys = new Set(aliasRows.map((a) => a.aliasKey));
  let total = 0;
  let onSections = 0;
  let untagged = 0;
  const textTopics: TopicHealth["textTopics"] = [];
  for (const g of grouped) {
    const n = Number(g.questions) || 0;
    total += n;
    if (g.topicKey === UNTAGGED_TOPIC_KEY) untagged += n;
    else if (isSectionKey(g.topicKey)) onSections += n;
    else if (g.topicKey.startsWith(TEXT_KEY_PREFIX)) {
      const aliasKey = g.topicKey.slice(TEXT_KEY_PREFIX.length);
      textTopics.push({ aliasKey, label: g.label, questionCount: n, studentCount: Number(g.students) || 0, mapped: aliasKeys.has(aliasKey) });
    }
  }
  return {
    totalQuestions: total,
    sectionQuestions: onSections,
    untaggedQuestions: untagged,
    textTopics: textTopics.sort((a, b) => b.questionCount - a.questionCount),
    aliases: aliasRows.map((a) => ({ aliasKey: a.aliasKey, label: a.label, questionTopicId: a.questionTopicId, sectionLabel: a.questionTopicId ? (sectionById.get(a.questionTopicId) ?? null) : null })),
    sections,
  };
}

/** Points a free-text topic at a bank section (or only renames it). Every affected student is recomputed. */
export async function mapAlias(scope: TeacherScope, input: { aliasKey: string; label: string; questionTopicId: string | null }) {
  const db = requireDb();
  const aliasKey = topicNameKey(input.aliasKey);
  if (!aliasKey) throw new AppError("NOT_FOUND");
  if (input.questionTopicId) {
    const [section] = await db
      .select({ id: questionTopics.id, parentId: questionTopics.parentId })
      .from(questionTopics)
      .where(and(eq(questionTopics.id, input.questionTopicId), eq(questionTopics.providerWorkspaceId, scope.workspaceId)))
      .limit(1);
    if (!section) throw new AppError("NOT_FOUND");
    if (!section.parentId) throw new AppError("SECTION_REQUIRED");
  }
  const label = input.label.trim().slice(0, 120) || aliasKey;
  await db
    .insert(topicAliases)
    .values({ workspaceId: scope.workspaceId, aliasKey, label, questionTopicId: input.questionTopicId, updatedBy: scope.userId })
    .onDuplicateKeyUpdate({ set: { label, questionTopicId: input.questionTopicId, updatedBy: scope.userId } });
  await markWorkspaceDirty(scope.workspaceId, "alias");
  return { ok: true };
}

export async function removeAlias(scope: TeacherScope, aliasKey: string) {
  await requireDb()
    .delete(topicAliases)
    .where(and(eq(topicAliases.workspaceId, scope.workspaceId), eq(topicAliases.aliasKey, topicNameKey(aliasKey))));
  await markWorkspaceDirty(scope.workspaceId, "alias");
  return { ok: true };
}

export async function recomputeWorkspace(scope: TeacherScope) {
  const missing = await markMissingStats(scope.workspaceId);
  const queued = await markWorkspaceDirty(scope.workspaceId, "manual");
  return { queued: queued + missing };
}

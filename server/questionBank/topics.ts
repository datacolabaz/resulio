import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { questionMeta, questions, questionTopics, syllabi, syllabusLessons, syllabusModules, type QuestionTopic } from "../../drizzle/schema";
import { normalizeForMatch, type TopicInput } from "../../shared/questionImport";
import { requireDb, type DbOrTx } from "../db";
import type { TeacherScope } from "../modules/access";
import { AppError } from "../modules/errors";
import { isMissingTable } from "../notifications/preferences";

/**
 * The question bank's topic tree. Topics are per workspace; a question's topic lives in
 * `question_meta.topicId`, and `questions.topic` mirrors the leaf name so older readers (filters,
 * frozen exam versions, analytics) keep seeing the topic as text.
 */

export const PATH_SEPARATOR = " / ";

export const nameKey = (name: string) => normalizeForMatch(name).slice(0, 120);

function isDuplicateEntry(error: unknown) {
  let e = error as { errno?: number; code?: string; cause?: unknown } | undefined;
  for (let i = 0; e && i < 5; i++) {
    if (e.errno === 1062 || e.code === "ER_DUP_ENTRY") return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** Topic tables (migration 0030) missing → a stable error instead of a 500. */
export async function guardBankTables<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isMissingTable(error)) throw new AppError("QUESTION_BANK_NOT_READY");
    throw error;
  }
}

export async function topicsOf(workspaceId: string, db: DbOrTx = requireDb()): Promise<QuestionTopic[]> {
  return db.select().from(questionTopics).where(eq(questionTopics.providerWorkspaceId, workspaceId)).orderBy(asc(questionTopics.position), asc(questionTopics.name));
}

/** "Parent / Child" for every topic; a broken parent chain (never written by this code) stops the walk. */
export function topicPaths(rows: Pick<QuestionTopic, "id" | "parentId" | "name">[]): Map<string, string> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, string>();
  for (const row of rows) {
    const names: string[] = [];
    const seen = new Set<string>();
    let cur: (typeof rows)[number] | undefined = row;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      names.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    out.set(row.id, names.join(PATH_SEPARATOR));
  }
  return out;
}

/** The topic and everything below it. */
export function descendantIds(rows: Pick<QuestionTopic, "id" | "parentId">[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const r of rows) if (r.parentId === out[i] && !out.includes(r.id)) out.push(r.id);
  return out;
}

export async function ownedTopic(scope: TeacherScope, id: string, db: DbOrTx = requireDb()): Promise<QuestionTopic> {
  const [row] = await db
    .select()
    .from(questionTopics)
    .where(and(eq(questionTopics.id, id), eq(questionTopics.providerWorkspaceId, scope.workspaceId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

/** A module/lesson link must point into one of the teacher's own syllabi, and agree with each other. */
async function resolveLinks(scope: TeacherScope, input: Pick<TopicInput, "syllabusId" | "syllabusModuleId" | "syllabusLessonId">, db: DbOrTx) {
  let syllabusId = input.syllabusId ?? null;
  let moduleId = input.syllabusModuleId ?? null;
  const lessonId = input.syllabusLessonId ?? null;
  if (lessonId) {
    const [lesson] = await db.select({ syllabusId: syllabusLessons.syllabusId, moduleId: syllabusLessons.moduleId }).from(syllabusLessons).where(eq(syllabusLessons.id, lessonId)).limit(1);
    if (!lesson || (moduleId && moduleId !== lesson.moduleId)) throw new AppError("NOT_FOUND");
    moduleId = lesson.moduleId;
    syllabusId = syllabusId ?? lesson.syllabusId;
    if (syllabusId !== lesson.syllabusId) throw new AppError("NOT_FOUND");
  }
  if (moduleId) {
    const [mod] = await db.select({ syllabusId: syllabusModules.syllabusId }).from(syllabusModules).where(eq(syllabusModules.id, moduleId)).limit(1);
    if (!mod || (syllabusId && syllabusId !== mod.syllabusId)) throw new AppError("NOT_FOUND");
    syllabusId = mod.syllabusId;
  }
  if (syllabusId) {
    const [own] = await db
      .select({ id: syllabi.id })
      .from(syllabi)
      .where(and(eq(syllabi.id, syllabusId), eq(syllabi.providerWorkspaceId, scope.workspaceId)))
      .limit(1);
    if (!own) throw new AppError("NOT_FOUND");
  }
  return { syllabusId, syllabusModuleId: moduleId, syllabusLessonId: lessonId };
}

export async function createTopic(scope: TeacherScope, input: TopicInput, db: DbOrTx = requireDb()): Promise<QuestionTopic> {
  const parentId = input.parentId ?? null;
  if (parentId) await ownedTopic(scope, parentId, db).catch(() => Promise.reject(new AppError("TOPIC_INVALID_PARENT")));
  const links = await resolveLinks(scope, input, db);
  const id = nanoid();
  const name = input.name.trim().slice(0, 120);
  try {
    await db.insert(questionTopics).values({
      id,
      providerWorkspaceId: scope.workspaceId,
      parentId,
      parentKey: parentId ?? "",
      name,
      nameKey: nameKey(name),
      ...links,
      createdBy: scope.userId,
    });
  } catch (error) {
    if (isDuplicateEntry(error)) throw new AppError("TOPIC_EXISTS");
    throw error;
  }
  return ownedTopic(scope, id, db);
}

/** The sibling with this name under `parentId`, created if missing. */
export async function ensureTopic(scope: TeacherScope, name: string, parentId: string | null, db: DbOrTx = requireDb(), links: Partial<TopicInput> = {}): Promise<QuestionTopic> {
  const find = async () => {
    const [row] = await db
      .select()
      .from(questionTopics)
      .where(and(eq(questionTopics.providerWorkspaceId, scope.workspaceId), eq(questionTopics.parentKey, parentId ?? ""), eq(questionTopics.nameKey, nameKey(name))))
      .limit(1);
    return row;
  };
  const existing = await find();
  if (existing) return existing;
  try {
    return await createTopic(scope, { ...links, name, parentId }, db);
  } catch (error) {
    const raced = error instanceof AppError && error.code === "TOPIC_EXISTS" ? await find() : undefined;
    if (raced) return raced;
    throw error;
  }
}

export async function updateTopic(scope: TeacherScope, id: string, patch: Partial<TopicInput>) {
  const db = requireDb();
  const topic = await ownedTopic(scope, id);
  const all = await topicsOf(scope.workspaceId);
  const parentId = patch.parentId === undefined ? topic.parentId : patch.parentId;
  if (parentId && (descendantIds(all, id).includes(parentId) || !all.some((t) => t.id === parentId))) throw new AppError("TOPIC_INVALID_PARENT");
  const name = patch.name?.trim().slice(0, 120) ?? topic.name;
  const linkPatch =
    patch.syllabusId !== undefined || patch.syllabusModuleId !== undefined || patch.syllabusLessonId !== undefined
      ? await resolveLinks(scope, { syllabusId: patch.syllabusId, syllabusModuleId: patch.syllabusModuleId, syllabusLessonId: patch.syllabusLessonId }, db)
      : {};
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(questionTopics)
        .set({ name, nameKey: nameKey(name), parentId: parentId ?? null, parentKey: parentId ?? "", ...linkPatch })
        .where(eq(questionTopics.id, id));
      if (name !== topic.name) await syncQuestionTopicText(tx, scope.workspaceId, [id], name);
    });
  } catch (error) {
    if (isDuplicateEntry(error)) throw new AppError("TOPIC_EXISTS");
    throw error;
  }
  return ownedTopic(scope, id);
}

async function syncQuestionTopicText(tx: DbOrTx, workspaceId: string, topicIds: string[], name: string) {
  const ids = (
    await tx
      .select({ id: questionMeta.questionId })
      .from(questionMeta)
      .where(and(eq(questionMeta.providerWorkspaceId, workspaceId), inArray(questionMeta.topicId, topicIds)))
  ).map((r) => r.id);
  if (ids.length) await tx.update(questions).set({ topic: name.slice(0, 120) }).where(and(eq(questions.providerWorkspaceId, workspaceId), inArray(questions.id, ids)));
}

/** Children and questions move up to the deleted topic's parent; nothing else is deleted. */
export async function deleteTopic(scope: TeacherScope, id: string) {
  const topic = await ownedTopic(scope, id);
  const parent = topic.parentId ? await ownedTopic(scope, topic.parentId).catch(() => null) : null;
  try {
    await requireDb().transaction(async (tx) => {
      await tx
        .update(questionTopics)
        .set({ parentId: parent?.id ?? null, parentKey: parent?.id ?? "" })
        .where(and(eq(questionTopics.providerWorkspaceId, scope.workspaceId), eq(questionTopics.parentId, id)));
      if (parent) await syncQuestionTopicText(tx, scope.workspaceId, [id], parent.name);
      await tx
        .update(questionMeta)
        .set({ topicId: parent?.id ?? null })
        .where(and(eq(questionMeta.providerWorkspaceId, scope.workspaceId), eq(questionMeta.topicId, id)));
      await tx.delete(questionTopics).where(eq(questionTopics.id, id));
    });
  } catch (error) {
    if (isDuplicateEntry(error)) throw new AppError("TOPIC_EXISTS");
    throw error;
  }
  return { ok: true };
}

/** Moves bank questions under a topic (or out of every topic with null). */
export async function assignTopic(scope: TeacherScope, questionIds: string[], topicId: string | null) {
  const db = requireDb();
  const topic = topicId ? await ownedTopic(scope, topicId) : null;
  const owned = (
    await db
      .select({ id: questions.id })
      .from(questions)
      .where(and(eq(questions.providerWorkspaceId, scope.workspaceId), inArray(questions.id, questionIds)))
  ).map((r) => r.id);
  if (owned.length !== new Set(questionIds).size) throw new AppError("NOT_FOUND");
  await db.transaction(async (tx) => {
    for (const questionId of owned) {
      await tx
        .insert(questionMeta)
        .values({ questionId, providerWorkspaceId: scope.workspaceId, topicId: topic?.id ?? null })
        .onDuplicateKeyUpdate({ set: { topicId: topic?.id ?? null } });
    }
    if (topic) await tx.update(questions).set({ topic: topic.name }).where(inArray(questions.id, owned));
  });
  return { ok: true, count: owned.length };
}

/** Topic per bank question; empty when the topic tables are not migrated yet. */
export async function topicIdsOf(workspaceId: string, questionIds: string[]): Promise<Map<string, string | null>> {
  if (!questionIds.length) return new Map();
  try {
    const rows = await requireDb()
      .select({ questionId: questionMeta.questionId, topicId: questionMeta.topicId })
      .from(questionMeta)
      .where(and(eq(questionMeta.providerWorkspaceId, workspaceId), inArray(questionMeta.questionId, questionIds)));
    return new Map(rows.map((r) => [r.questionId, r.topicId]));
  } catch (error) {
    if (isMissingTable(error)) return new Map();
    throw error;
  }
}

/** Ids of bank questions under the topic or any of its subtopics. */
export async function questionIdsUnder(scope: TeacherScope, topicId: string): Promise<string[]> {
  const db = requireDb();
  const all = await topicsOf(scope.workspaceId);
  if (!all.some((t) => t.id === topicId)) throw new AppError("NOT_FOUND");
  const rows = await db
    .select({ id: questionMeta.questionId })
    .from(questionMeta)
    .where(and(eq(questionMeta.providerWorkspaceId, scope.workspaceId), inArray(questionMeta.topicId, descendantIds(all, topicId))));
  return rows.map((r) => r.id);
}

export async function listTopics(scope: TeacherScope) {
  const db = requireDb();
  const rows = await topicsOf(scope.workspaceId);
  const counts = await db
    .select({ topicId: questionMeta.topicId, n: sql<number>`count(*)` })
    .from(questionMeta)
    .innerJoin(questions, eq(questions.id, questionMeta.questionId))
    .where(eq(questionMeta.providerWorkspaceId, scope.workspaceId))
    .groupBy(questionMeta.topicId);
  const countOf = new Map(counts.map((c) => [c.topicId, Number(c.n)]));
  const paths = topicPaths(rows);
  return rows
    .map((r) => ({
      id: r.id,
      parentId: r.parentId,
      name: r.name,
      path: paths.get(r.id) ?? r.name,
      syllabusId: r.syllabusId,
      syllabusModuleId: r.syllabusModuleId,
      syllabusLessonId: r.syllabusLessonId,
      questionCount: countOf.get(r.id) ?? 0,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The teacher's syllabi with their live modules and lessons, for linking topics. */
export async function syllabusOutline(scope: TeacherScope) {
  const db = requireDb();
  const list = await db
    .select({ id: syllabi.id, title: syllabi.title })
    .from(syllabi)
    .where(and(eq(syllabi.providerWorkspaceId, scope.workspaceId), isNull(syllabi.archivedAt)))
    .orderBy(asc(syllabi.title));
  if (!list.length) return [];
  const ids = list.map((s) => s.id);
  const mods = await db
    .select({ id: syllabusModules.id, syllabusId: syllabusModules.syllabusId, title: syllabusModules.title })
    .from(syllabusModules)
    .where(and(inArray(syllabusModules.syllabusId, ids), isNull(syllabusModules.deletedAt)))
    .orderBy(asc(syllabusModules.position));
  const lessons = await db
    .select({ id: syllabusLessons.id, moduleId: syllabusLessons.moduleId, title: syllabusLessons.title })
    .from(syllabusLessons)
    .where(and(inArray(syllabusLessons.syllabusId, ids), isNull(syllabusLessons.deletedAt)))
    .orderBy(asc(syllabusLessons.position));
  return list.map((s) => ({
    ...s,
    modules: mods.filter((m) => m.syllabusId === s.id).map((m) => ({ id: m.id, title: m.title, lessons: lessons.filter((l) => l.moduleId === m.id).map((l) => ({ id: l.id, title: l.title })) })),
  }));
}

/** Builds (or completes) a topic branch mirroring a syllabus: syllabus → modules → lessons. */
export async function topicsFromSyllabus(scope: TeacherScope, syllabusId: string) {
  const outline = (await syllabusOutline(scope)).find((s) => s.id === syllabusId);
  if (!outline) throw new AppError("NOT_FOUND");
  const db = requireDb();
  const root = await ensureTopic(scope, outline.title.slice(0, 120), null, db, { syllabusId });
  let created = 0;
  for (const mod of outline.modules) {
    const modTopic = await ensureTopic(scope, mod.title.slice(0, 120), root.id, db, { syllabusModuleId: mod.id });
    created++;
    for (const lesson of mod.lessons) {
      await ensureTopic(scope, lesson.title.slice(0, 120), modTopic.id, db, { syllabusLessonId: lesson.id });
      created++;
    }
  }
  return { rootId: root.id, count: created };
}

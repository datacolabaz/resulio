import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { questionMeta, questions, questionTopics, syllabi, syllabusModules, type QuestionTopic } from "../../drizzle/schema";
import { normalizeForMatch, type TopicInput } from "../../shared/questionImport";
import { requireDb, type DbOrTx } from "../db";
import type { TeacherScope } from "../modules/access";
import { AppError } from "../modules/errors";
import { isMissingTable } from "../notifications/preferences";

/**
 * The question bank's structure: subjects, each with sections, and a numbered list of questions
 * per section ("Informatika / İnformasiya prosesləri / #12").
 *
 * Numbering: every section row holds `nextNumber`. Filing a question locks that row
 * (SELECT … FOR UPDATE), takes the number and bumps the counter in the same transaction, so two
 * teachers adding to one section at once get consecutive numbers; the unique index on
 * (sectionId, bankNumber) is the backstop. Numbers are never reused or recompacted: a question
 * moved to another section gets that section's next number and its old number stays retired, so a
 * printed "#12" always means the same question. Source numbers from imported files are kept in
 * `question_meta.sourceNumber` for traceability only.
 */

export const PATH_SEPARATOR = " / ";

export const nameKey = (name: string) => normalizeForMatch(name).slice(0, 120);

export function isDuplicateEntry(error: unknown) {
  let e = error as { errno?: number; code?: string; cause?: unknown } | undefined;
  for (let i = 0; e && i < 5; i++) {
    if (e.errno === 1062 || e.code === "ER_DUP_ENTRY") return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** Bank tables (migration 0030) missing → a stable error instead of a 500. */
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

/** "Subject / Section" for sections, the name for subjects. */
export function topicPaths(rows: Pick<QuestionTopic, "id" | "parentId" | "name">[]): Map<string, string> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return new Map(rows.map((r) => {
    const parent = r.parentId ? byId.get(r.parentId) : undefined;
    return [r.id, parent ? `${parent.name}${PATH_SEPARATOR}${r.name}` : r.name];
  }));
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

/** Questions can only be filed in a section, never directly in a subject. */
export async function ownedSection(scope: TeacherScope, id: string, db: DbOrTx = requireDb()): Promise<QuestionTopic> {
  const row = await ownedTopic(scope, id, db);
  if (!row.parentId) throw new AppError("SECTION_REQUIRED");
  return row;
}

/** A subject may point at one of the teacher's syllabi, a section at one of its modules. */
async function resolveLinks(scope: TeacherScope, input: Pick<TopicInput, "syllabusId" | "syllabusModuleId">, db: DbOrTx) {
  let syllabusId = input.syllabusId ?? null;
  const moduleId = input.syllabusModuleId ?? null;
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
  return { syllabusId, syllabusModuleId: moduleId };
}

/** The parent of a new or moved section must be a subject of this workspace. */
async function subjectParent(scope: TeacherScope, parentId: string, db: DbOrTx) {
  const parent = await ownedTopic(scope, parentId, db).catch(() => null);
  if (!parent || parent.parentId) throw new AppError("TOPIC_INVALID_PARENT");
  return parent;
}

/** A subject (no `parentId`) or a section of the subject `parentId`. */
export async function createTopic(scope: TeacherScope, input: TopicInput, db: DbOrTx = requireDb()): Promise<QuestionTopic> {
  const parentId = input.parentId ?? null;
  if (parentId) await subjectParent(scope, parentId, db);
  const links = await resolveLinks(scope, parentId ? { syllabusModuleId: input.syllabusModuleId } : { syllabusId: input.syllabusId }, db);
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

/** Rename, relink, or move a section to another subject (its questions keep their numbers). */
export async function updateTopic(scope: TeacherScope, id: string, patch: Partial<TopicInput>) {
  const db = requireDb();
  const topic = await ownedTopic(scope, id);
  const parentId = patch.parentId === undefined ? topic.parentId : patch.parentId;
  if (!!parentId !== !!topic.parentId) throw new AppError("TOPIC_INVALID_PARENT");
  if (parentId && parentId !== topic.parentId) await subjectParent(scope, parentId, db);
  const name = patch.name?.trim().slice(0, 120) ?? topic.name;
  const linkPatch = topic.parentId
    ? patch.syllabusModuleId !== undefined
      ? await resolveLinks(scope, { syllabusModuleId: patch.syllabusModuleId }, db)
      : {}
    : patch.syllabusId !== undefined
      ? await resolveLinks(scope, { syllabusId: patch.syllabusId }, db)
      : {};
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(questionTopics)
        .set({ name, nameKey: nameKey(name), parentId: parentId ?? null, parentKey: parentId ?? "", ...linkPatch })
        .where(eq(questionTopics.id, id));
      if (topic.parentId && name !== topic.name) await syncQuestionTopicText(tx, scope.workspaceId, id, name);
    });
  } catch (error) {
    if (isDuplicateEntry(error)) throw new AppError("TOPIC_EXISTS");
    throw error;
  }
  return ownedTopic(scope, id);
}

async function syncQuestionTopicText(tx: DbOrTx, workspaceId: string, sectionId: string, name: string) {
  const ids = (
    await tx
      .select({ id: questionMeta.questionId })
      .from(questionMeta)
      .where(and(eq(questionMeta.providerWorkspaceId, workspaceId), eq(questionMeta.sectionId, sectionId)))
  ).map((r) => r.id);
  if (ids.length) await tx.update(questions).set({ topic: name.slice(0, 120) }).where(and(eq(questions.providerWorkspaceId, workspaceId), inArray(questions.id, ids)));
}

/** Only empty: a section without questions, or a subject whose sections are all empty (they go with it). */
export async function deleteTopic(scope: TeacherScope, id: string) {
  const topic = await ownedTopic(scope, id);
  const db = requireDb();
  const sectionIds = topic.parentId
    ? [id]
    : (await db.select({ id: questionTopics.id }).from(questionTopics).where(and(eq(questionTopics.providerWorkspaceId, scope.workspaceId), eq(questionTopics.parentId, id)))).map((r) => r.id);
  await db.transaction(async (tx) => {
    if (sectionIds.length) {
      const [used] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(questionMeta)
        .where(and(eq(questionMeta.providerWorkspaceId, scope.workspaceId), inArray(questionMeta.sectionId, sectionIds)));
      if (Number(used?.n ?? 0) > 0) throw new AppError("TOPIC_NOT_EMPTY");
      await tx.delete(questionTopics).where(and(eq(questionTopics.providerWorkspaceId, scope.workspaceId), inArray(questionTopics.id, sectionIds)));
    }
    await tx.delete(questionTopics).where(eq(questionTopics.id, id));
  });
  return { ok: true };
}

export interface ImportProvenance {
  importJobId: string;
  sourceFileName: string;
  sourcePage: number | null;
  sourceNumber: string | null;
  answerSource: "SOURCE" | "AI" | "TEACHER";
  aiConfidence: "LOW" | "MEDIUM" | "HIGH";
}

/**
 * Files questions (in the given order) into a section, giving each the section's next bank
 * number. Must run inside a transaction: the section row stays locked until it commits. A question
 * already in this section keeps its number.
 */
export async function fileInSection(
  tx: DbOrTx,
  workspaceId: string,
  sectionId: string,
  questionIds: string[],
  provenance?: ImportProvenance,
): Promise<Map<string, number>> {
  const [section] = await tx
    .select({ id: questionTopics.id, name: questionTopics.name, parentId: questionTopics.parentId, nextNumber: questionTopics.nextNumber })
    .from(questionTopics)
    .where(and(eq(questionTopics.id, sectionId), eq(questionTopics.providerWorkspaceId, workspaceId)))
    .for("update");
  if (!section) throw new AppError("NOT_FOUND");
  if (!section.parentId) throw new AppError("SECTION_REQUIRED");
  const current = questionIds.length
    ? await tx
        .select({ questionId: questionMeta.questionId, sectionId: questionMeta.sectionId, bankNumber: questionMeta.bankNumber })
        .from(questionMeta)
        .where(inArray(questionMeta.questionId, questionIds))
    : [];
  const plan = planNumbers(sectionId, section.nextNumber, questionIds, current);
  for (const w of plan.writes) {
    // A plain insert/update, not an upsert: a (sectionId, bankNumber) collision must fail loudly.
    if (w.hasMeta) await tx.update(questionMeta).set({ sectionId, bankNumber: w.bankNumber }).where(eq(questionMeta.questionId, w.questionId));
    else await tx.insert(questionMeta).values({ questionId: w.questionId, providerWorkspaceId: workspaceId, sectionId, bankNumber: w.bankNumber, ...provenance });
  }
  if (plan.writes.length) {
    await tx.update(questionTopics).set({ nextNumber: plan.nextNumber }).where(eq(questionTopics.id, sectionId));
    await tx.update(questions).set({ topic: section.name }).where(and(eq(questions.providerWorkspaceId, workspaceId), inArray(questions.id, plan.writes.map((w) => w.questionId))));
  }
  return plan.numbers;
}

/**
 * Bank numbers for questions filed into a section whose counter stands at `nextNumber`: in the
 * given order, each new arrival takes the next number; one already numbered in this section keeps
 * it. Numbers of questions that left or were deleted are never handed out again.
 */
export function planNumbers(
  sectionId: string,
  nextNumber: number,
  questionIds: string[],
  current: { questionId: string; sectionId: string | null; bankNumber: number | null }[],
) {
  const numbers = new Map<string, number>();
  const writes: { questionId: string; bankNumber: number; hasMeta: boolean }[] = [];
  let next = nextNumber;
  for (const questionId of questionIds) {
    if (numbers.has(questionId)) continue;
    const had = current.find((c) => c.questionId === questionId);
    if (had?.sectionId === sectionId && had.bankNumber) {
      numbers.set(questionId, had.bankNumber);
      continue;
    }
    const bankNumber = next++;
    writes.push({ questionId, bankNumber, hasMeta: Boolean(had) });
    numbers.set(questionId, bankNumber);
  }
  return { numbers, writes, nextNumber: next };
}

/** Moves bank questions into a section; they keep their relative order and get new numbers there. */
export async function moveQuestions(scope: TeacherScope, questionIds: string[], sectionId: string) {
  const db = requireDb();
  await ownedSection(scope, sectionId);
  const owned = await db
    .select({ id: questions.id, createdAt: questions.createdAt, bankNumber: questionMeta.bankNumber })
    .from(questions)
    .leftJoin(questionMeta, eq(questionMeta.questionId, questions.id))
    .where(and(eq(questions.providerWorkspaceId, scope.workspaceId), inArray(questions.id, questionIds)));
  if (owned.length !== new Set(questionIds).size) throw new AppError("NOT_FOUND");
  const ordered = owned
    .sort((a, b) => (a.bankNumber ?? Number.MAX_SAFE_INTEGER) - (b.bankNumber ?? Number.MAX_SAFE_INTEGER) || a.createdAt.getTime() - b.createdAt.getTime())
    .map((r) => r.id);
  await db.transaction((tx) => fileInSection(tx, scope.workspaceId, sectionId, ordered));
  return { ok: true, count: ordered.length };
}

export interface Placement {
  sectionId: string | null;
  bankNumber: number | null;
}

/** Section and number per question; empty when the bank tables are not migrated yet. */
export async function placementsOf(workspaceId: string, questionIds: string[]): Promise<Map<string, Placement>> {
  if (!questionIds.length) return new Map();
  try {
    const rows = await requireDb()
      .select({ questionId: questionMeta.questionId, sectionId: questionMeta.sectionId, bankNumber: questionMeta.bankNumber })
      .from(questionMeta)
      .where(and(eq(questionMeta.providerWorkspaceId, workspaceId), inArray(questionMeta.questionId, questionIds)));
    return new Map(rows.map((r) => [r.questionId, { sectionId: r.sectionId, bankNumber: r.bankNumber }]));
  } catch (error) {
    if (isMissingTable(error)) return new Map();
    throw error;
  }
}

/** Ids of bank questions in the section, or in every section of the subject. */
export async function questionIdsUnder(scope: TeacherScope, topicId: string): Promise<string[]> {
  const db = requireDb();
  const all = await topicsOf(scope.workspaceId);
  const topic = all.find((t) => t.id === topicId);
  if (!topic) throw new AppError("NOT_FOUND");
  const sectionIds = topic.parentId ? [topicId] : all.filter((t) => t.parentId === topicId).map((t) => t.id);
  if (!sectionIds.length) return [];
  const rows = await db
    .select({ id: questionMeta.questionId })
    .from(questionMeta)
    .where(and(eq(questionMeta.providerWorkspaceId, scope.workspaceId), inArray(questionMeta.sectionId, sectionIds)));
  return rows.map((r) => r.id);
}

/** Subjects, each followed by its sections, with question counts. */
export async function listTopics(scope: TeacherScope) {
  const db = requireDb();
  const rows = await topicsOf(scope.workspaceId);
  const counts = await db
    .select({ sectionId: questionMeta.sectionId, n: sql<number>`count(*)` })
    .from(questionMeta)
    .innerJoin(questions, eq(questions.id, questionMeta.questionId))
    .where(eq(questionMeta.providerWorkspaceId, scope.workspaceId))
    .groupBy(questionMeta.sectionId);
  const countOf = new Map(counts.map((c) => [c.sectionId, Number(c.n)]));
  const paths = topicPaths(rows);
  const view = (r: QuestionTopic) => ({
    id: r.id,
    parentId: r.parentId,
    kind: r.parentId ? ("SECTION" as const) : ("SUBJECT" as const),
    name: r.name,
    path: paths.get(r.id) ?? r.name,
    syllabusId: r.syllabusId,
    syllabusModuleId: r.syllabusModuleId,
    questionCount: r.parentId ? (countOf.get(r.id) ?? 0) : rows.filter((s) => s.parentId === r.id).reduce((n, s) => n + (countOf.get(s.id) ?? 0), 0),
  });
  const byName = (a: QuestionTopic, b: QuestionTopic) => a.position - b.position || a.name.localeCompare(b.name);
  const subjects = rows.filter((r) => !r.parentId).sort(byName);
  // Sections whose subject row is gone (never written by this code) are listed last rather than lost.
  const orphans = rows.filter((r) => r.parentId && !rows.some((s) => s.id === r.parentId));
  return [...subjects.flatMap((s) => [view(s), ...rows.filter((r) => r.parentId === s.id).sort(byName).map(view)]), ...orphans.map(view)];
}

/** The teacher's syllabi with their live modules, for linking subjects and sections. */
export async function syllabusOutline(scope: TeacherScope) {
  const db = requireDb();
  const list = await db
    .select({ id: syllabi.id, title: syllabi.title })
    .from(syllabi)
    .where(and(eq(syllabi.providerWorkspaceId, scope.workspaceId), isNull(syllabi.archivedAt)))
    .orderBy(asc(syllabi.title));
  if (!list.length) return [];
  const mods = await db
    .select({ id: syllabusModules.id, syllabusId: syllabusModules.syllabusId, title: syllabusModules.title })
    .from(syllabusModules)
    .where(and(inArray(syllabusModules.syllabusId, list.map((s) => s.id)), isNull(syllabusModules.deletedAt)))
    .orderBy(asc(syllabusModules.position));
  return list.map((s) => ({ ...s, modules: mods.filter((m) => m.syllabusId === s.id).map((m) => ({ id: m.id, title: m.title })) }));
}

/** A subject named after the syllabus with one section per module (existing ones are reused). */
export async function topicsFromSyllabus(scope: TeacherScope, syllabusId: string) {
  const outline = (await syllabusOutline(scope)).find((s) => s.id === syllabusId);
  if (!outline) throw new AppError("NOT_FOUND");
  const db = requireDb();
  const subject = await ensureTopic(scope, outline.title.slice(0, 120), null, db, { syllabusId });
  for (const mod of outline.modules) await ensureTopic(scope, mod.title.slice(0, 120), subject.id, db, { syllabusModuleId: mod.id });
  return { subjectId: subject.id, count: outline.modules.length };
}

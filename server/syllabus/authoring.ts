import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  assessments,
  files,
  materials,
  syllabi,
  syllabusAccessGrants,
  syllabusEnrollments,
  syllabusItems,
  syllabusLessons,
  syllabusModules,
  syllabusVersions,
  type Syllabus,
  type SyllabusItemRow,
} from "../../drizzle/schema";
import {
  parseItemContent,
  resolveRules,
  type CompletionRulesPatch,
  type SyllabusItemKind,
  type SyllabusItemScope,
  type SyllabusNodeStatus,
} from "../../shared/syllabus";
import { requireDb, type DbOrTx } from "../db";
import type { TeacherScope } from "../modules/access";
import { AppError } from "../modules/errors";
import { ownedSyllabus } from "./access";
import { cloneContainer, createContainer, syncContainer } from "./practiceTasks";

/**
 * Draft editing. Students never read these tables (they read the pinned version), so every edit
 * here is invisible to learners until the teacher publishes. Deletes are soft: ids stay stable.
 */

export interface SyllabusFields {
  title: string;
  description: string;
  subject: string;
  level: string;
  language: string;
  estimatedDurationLabel: string;
  estimatedHours: number | null;
  coverFileId: string | null;
  completionRules: CompletionRulesPatch;
}

export interface ModuleFields {
  title: string;
  description: string;
  estimatedMinutes: number | null;
  objectives: string[];
  prerequisitesText: string;
  status: SyllabusNodeStatus;
  completionRules: CompletionRulesPatch | null;
}

export type LessonFields = Omit<ModuleFields, "prerequisitesText">;

export interface ItemFields {
  title: string;
  required: boolean;
  content: Record<string, unknown>;
  assessmentId: string | null;
}

const defined = <T extends object>(patch: T) => Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;

function validContent(kind: SyllabusItemKind, raw: unknown) {
  try {
    return parseItemContent(kind, raw) as Record<string, unknown>;
  } catch {
    throw new AppError("SYLLABUS_INVALID_CONTENT");
  }
}

/** Every draft write bumps the revision; a stale `expectedRevision` (another tab) is refused. */
async function touchDraft(syllabus: Syllabus, expectedRevision: number | undefined, db: DbOrTx = requireDb()) {
  if (syllabus.archivedAt) throw new AppError("SYLLABUS_ARCHIVED");
  if (expectedRevision !== undefined && expectedRevision !== syllabus.draftRevision) throw new AppError("SYLLABUS_STALE_REVISION");
  await db
    .update(syllabi)
    .set({ draftRevision: sql`${syllabi.draftRevision} + 1`, hasDraftChanges: true })
    .where(eq(syllabi.id, syllabus.id));
}

async function nextPosition(table: typeof syllabusModules | typeof syllabusLessons | typeof syllabusItems, where: ReturnType<typeof and>) {
  const [row] = await requireDb()
    .select({ max: sql<number>`coalesce(max(${table.position}), 0)` })
    .from(table)
    .where(where);
  return Number(row?.max ?? 0) + 1;
}

async function ownedModule(scope: TeacherScope, moduleId: string) {
  const [m] = await requireDb().select().from(syllabusModules).where(and(eq(syllabusModules.id, moduleId), isNull(syllabusModules.deletedAt))).limit(1);
  if (!m) throw new AppError("NOT_FOUND");
  return { module: m, syllabus: await ownedSyllabus(scope, m.syllabusId) };
}

async function ownedLesson(scope: TeacherScope, lessonId: string) {
  const [l] = await requireDb().select().from(syllabusLessons).where(and(eq(syllabusLessons.id, lessonId), isNull(syllabusLessons.deletedAt))).limit(1);
  if (!l) throw new AppError("NOT_FOUND");
  return { lesson: l, syllabus: await ownedSyllabus(scope, l.syllabusId) };
}

async function ownedItem(scope: TeacherScope, itemId: string) {
  const [it] = await requireDb().select().from(syllabusItems).where(and(eq(syllabusItems.id, itemId), isNull(syllabusItems.deletedAt))).limit(1);
  if (!it) throw new AppError("NOT_FOUND");
  return { item: it, syllabus: await ownedSyllabus(scope, it.syllabusId) };
}

/** Materials and uploaded files an item points at (theory blocks, attachments, resource). */
export function contentRefs(kind: SyllabusItemKind, content: Record<string, unknown>) {
  const materialIds: string[] = [];
  const fileIds: string[] = [];
  const attachments = (list: unknown) => {
    if (Array.isArray(list)) for (const a of list) if (a && typeof a.fileId === "string") fileIds.push(a.fileId);
  };
  if (kind === "THEORY" && Array.isArray(content.blocks)) {
    for (const b of content.blocks as Array<Record<string, unknown>>) {
      if (b.type === "material" && typeof b.materialId === "string") materialIds.push(b.materialId);
      if ((b.type === "image" || b.type === "file") && typeof b.fileId === "string") fileIds.push(b.fileId);
    }
  }
  if (kind === "TEACHER_PRACTICE" || kind === "STUDENT_PRACTICE") attachments(content.attachments);
  if (kind === "RESOURCE" && typeof content.materialId === "string") materialIds.push(content.materialId);
  return { materialIds: [...new Set(materialIds)], fileIds: [...new Set(fileIds)] };
}

async function assertOwnRefs(scope: TeacherScope, refs: { materialIds: string[]; fileIds: string[] }) {
  const db = requireDb();
  if (refs.materialIds.length) {
    const rows = await db
      .select({ id: materials.id })
      .from(materials)
      .where(and(inArray(materials.id, refs.materialIds), eq(materials.providerWorkspaceId, scope.workspaceId)));
    if (rows.length !== refs.materialIds.length) throw new AppError("NOT_FOUND");
  }
  await assertOwnFiles(scope, refs.fileIds);
}

export async function assertOwnFiles(scope: TeacherScope, fileIds: string[]) {
  if (!fileIds.length) return;
  const rows = await requireDb()
    .select({ id: files.id })
    .from(files)
    .where(and(inArray(files.id, fileIds), eq(files.workspaceId, scope.workspaceId)));
  if (rows.length !== fileIds.length) throw new AppError("NOT_FOUND");
}

async function assertOwnAssessment(scope: TeacherScope, assessmentId: string | null) {
  if (!assessmentId) return;
  const [a] = await requireDb()
    .select({ id: assessments.id })
    .from(assessments)
    .where(and(eq(assessments.id, assessmentId), eq(assessments.providerWorkspaceId, scope.workspaceId)))
    .limit(1);
  if (!a) throw new AppError("NOT_FOUND");
}

// ---------------------------------------------------------------------------
// Syllabus
// ---------------------------------------------------------------------------

export async function listSyllabi(scope: TeacherScope) {
  const db = requireDb();
  const rows = await db.select().from(syllabi).where(eq(syllabi.providerWorkspaceId, scope.workspaceId)).orderBy(asc(syllabi.createdAt));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [moduleCounts, lessonCounts, enrollmentStats, grantCounts, versions] = await Promise.all([
    db.select({ id: syllabusModules.syllabusId, n: sql<number>`count(*)` }).from(syllabusModules).where(and(inArray(syllabusModules.syllabusId, ids), isNull(syllabusModules.deletedAt))).groupBy(syllabusModules.syllabusId),
    db.select({ id: syllabusLessons.syllabusId, n: sql<number>`count(*)` }).from(syllabusLessons).where(and(inArray(syllabusLessons.syllabusId, ids), isNull(syllabusLessons.deletedAt))).groupBy(syllabusLessons.syllabusId),
    db
      .select({ id: syllabusEnrollments.syllabusId, n: sql<number>`count(*)`, avg: sql<number>`coalesce(avg(${syllabusEnrollments.progressPct}), 0)` })
      .from(syllabusEnrollments)
      .where(inArray(syllabusEnrollments.syllabusId, ids))
      .groupBy(syllabusEnrollments.syllabusId),
    db.select({ id: syllabusAccessGrants.syllabusId, n: sql<number>`count(*)` }).from(syllabusAccessGrants).where(and(inArray(syllabusAccessGrants.syllabusId, ids), eq(syllabusAccessGrants.status, "ACTIVE"))).groupBy(syllabusAccessGrants.syllabusId),
    db.select({ id: syllabusVersions.id, label: syllabusVersions.label }).from(syllabusVersions).where(inArray(syllabusVersions.syllabusId, ids)),
  ]);
  const count = (list: Array<{ id: string; n: number }>, id: string) => Number(list.find((x) => x.id === id)?.n ?? 0);
  return rows.map((r) => {
    const e = enrollmentStats.find((x) => x.id === r.id);
    return {
      ...r,
      moduleCount: count(moduleCounts, r.id),
      lessonCount: count(lessonCounts, r.id),
      activeGrantCount: count(grantCounts, r.id),
      enrolledCount: Number(e?.n ?? 0),
      averageProgressPct: Math.round(Number(e?.avg ?? 0) * 10) / 10,
      currentVersionLabel: versions.find((v) => v.id === r.currentVersionId)?.label ?? null,
    };
  });
}

export async function createSyllabus(scope: TeacherScope, input: Partial<SyllabusFields> & { title: string }) {
  if (input.coverFileId) await assertOwnFiles(scope, [input.coverFileId]);
  const id = nanoid();
  await requireDb()
    .insert(syllabi)
    .values({
      id,
      providerWorkspaceId: scope.workspaceId,
      createdBy: scope.userId,
      title: input.title,
      description: input.description ?? null,
      subject: input.subject ?? "",
      level: input.level ?? "",
      language: input.language ?? "",
      estimatedDurationLabel: input.estimatedDurationLabel ?? "",
      estimatedHours: input.estimatedHours ?? null,
      coverFileId: input.coverFileId ?? null,
      completionRules: input.completionRules ?? {},
    });
  return ownedSyllabus(scope, id);
}

export async function updateSyllabus(scope: TeacherScope, id: string, patch: Partial<SyllabusFields>, expectedRevision?: number) {
  const syllabus = await ownedSyllabus(scope, id);
  if (patch.coverFileId) await assertOwnFiles(scope, [patch.coverFileId]);
  await touchDraft(syllabus, expectedRevision);
  const values = defined(patch);
  if (Object.keys(values).length) await requireDb().update(syllabi).set(values).where(eq(syllabi.id, id));
  return ownedSyllabus(scope, id);
}

/** Archived: no new grants or enrollments; existing grants keep working until they end. */
export async function setArchived(scope: TeacherScope, id: string, archived: boolean) {
  await ownedSyllabus(scope, id);
  await requireDb()
    .update(syllabi)
    .set(archived ? { archivedAt: new Date(), status: "ARCHIVED" } : { archivedAt: null, status: sql`case when ${syllabi.currentVersionId} is null then 'DRAFT' else 'PUBLISHED' end` })
    .where(eq(syllabi.id, id));
  return ownedSyllabus(scope, id);
}

/** The whole draft tree for the builder, with effective (inherited) rules per node. */
export async function draftTree(scope: TeacherScope, id: string) {
  const syllabus = await ownedSyllabus(scope, id);
  const db = requireDb();
  const [modules, lessons, items] = await Promise.all([
    db.select().from(syllabusModules).where(and(eq(syllabusModules.syllabusId, id), isNull(syllabusModules.deletedAt))).orderBy(asc(syllabusModules.position)),
    db.select().from(syllabusLessons).where(and(eq(syllabusLessons.syllabusId, id), isNull(syllabusLessons.deletedAt))).orderBy(asc(syllabusLessons.position)),
    db.select().from(syllabusItems).where(and(eq(syllabusItems.syllabusId, id), isNull(syllabusItems.deletedAt))).orderBy(asc(syllabusItems.position)),
  ]);
  return {
    syllabus: { ...syllabus, effectiveRules: resolveRules(syllabus.completionRules) },
    modules: modules.map((m) => ({
      ...m,
      effectiveRules: resolveRules(syllabus.completionRules, m.completionRules),
      items: items.filter((it) => it.scope === "MODULE" && it.moduleId === m.id),
      lessons: lessons
        .filter((l) => l.moduleId === m.id)
        .map((l) => ({
          ...l,
          effectiveRules: resolveRules(syllabus.completionRules, m.completionRules, l.completionRules),
          items: items.filter((it) => it.scope === "LESSON" && it.lessonId === l.id),
        })),
    })),
    finalItems: items.filter((it) => it.scope === "SYLLABUS"),
  };
}

// ---------------------------------------------------------------------------
// Modules and lessons
// ---------------------------------------------------------------------------

export async function createModule(scope: TeacherScope, syllabusId: string, input: Partial<ModuleFields> & { title: string }, expectedRevision?: number) {
  const syllabus = await ownedSyllabus(scope, syllabusId);
  await touchDraft(syllabus, expectedRevision);
  const id = nanoid();
  const position = await nextPosition(syllabusModules, and(eq(syllabusModules.syllabusId, syllabusId), isNull(syllabusModules.deletedAt)));
  await requireDb()
    .insert(syllabusModules)
    .values({
      id,
      syllabusId,
      position,
      title: input.title,
      description: input.description ?? null,
      estimatedMinutes: input.estimatedMinutes ?? null,
      objectives: input.objectives ?? [],
      prerequisitesText: input.prerequisitesText ?? null,
      status: input.status ?? "READY",
      completionRules: input.completionRules ?? null,
    });
  return (await ownedModule(scope, id)).module;
}

export async function updateModule(scope: TeacherScope, moduleId: string, patch: Partial<ModuleFields>, expectedRevision?: number) {
  const { syllabus } = await ownedModule(scope, moduleId);
  await touchDraft(syllabus, expectedRevision);
  const values = defined(patch);
  if (Object.keys(values).length) await requireDb().update(syllabusModules).set(values).where(eq(syllabusModules.id, moduleId));
  return (await ownedModule(scope, moduleId)).module;
}

export async function deleteModule(scope: TeacherScope, moduleId: string, expectedRevision?: number) {
  const { syllabus } = await ownedModule(scope, moduleId);
  await touchDraft(syllabus, expectedRevision);
  const db = requireDb();
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(syllabusModules).set({ deletedAt: now }).where(eq(syllabusModules.id, moduleId));
    await tx.update(syllabusLessons).set({ deletedAt: now }).where(and(eq(syllabusLessons.moduleId, moduleId), isNull(syllabusLessons.deletedAt)));
    await tx.update(syllabusItems).set({ deletedAt: now }).where(and(eq(syllabusItems.moduleId, moduleId), isNull(syllabusItems.deletedAt)));
  });
  return { ok: true };
}

export async function createLesson(scope: TeacherScope, moduleId: string, input: Partial<LessonFields> & { title: string }, expectedRevision?: number) {
  const { module, syllabus } = await ownedModule(scope, moduleId);
  await touchDraft(syllabus, expectedRevision);
  const id = nanoid();
  const position = await nextPosition(syllabusLessons, and(eq(syllabusLessons.moduleId, moduleId), isNull(syllabusLessons.deletedAt)));
  await requireDb()
    .insert(syllabusLessons)
    .values({
      id,
      syllabusId: module.syllabusId,
      moduleId,
      position,
      title: input.title,
      description: input.description ?? null,
      estimatedMinutes: input.estimatedMinutes ?? null,
      objectives: input.objectives ?? [],
      status: input.status ?? "READY",
      completionRules: input.completionRules ?? null,
    });
  return (await ownedLesson(scope, id)).lesson;
}

export async function updateLesson(scope: TeacherScope, lessonId: string, patch: Partial<LessonFields>, expectedRevision?: number) {
  const { syllabus } = await ownedLesson(scope, lessonId);
  await touchDraft(syllabus, expectedRevision);
  const values = defined(patch);
  if (Object.keys(values).length) await requireDb().update(syllabusLessons).set(values).where(eq(syllabusLessons.id, lessonId));
  return (await ownedLesson(scope, lessonId)).lesson;
}

/** Moves a lesson to the end of another module of the same syllabus. */
export async function moveLesson(scope: TeacherScope, lessonId: string, targetModuleId: string, expectedRevision?: number) {
  const { lesson, syllabus } = await ownedLesson(scope, lessonId);
  const { module: target } = await ownedModule(scope, targetModuleId);
  if (target.syllabusId !== lesson.syllabusId) throw new AppError("SYLLABUS_INVALID_TARGET");
  await touchDraft(syllabus, expectedRevision);
  const position = await nextPosition(syllabusLessons, and(eq(syllabusLessons.moduleId, targetModuleId), isNull(syllabusLessons.deletedAt)));
  const db = requireDb();
  await db.update(syllabusLessons).set({ moduleId: targetModuleId, position }).where(eq(syllabusLessons.id, lessonId));
  await db.update(syllabusItems).set({ moduleId: targetModuleId }).where(eq(syllabusItems.lessonId, lessonId));
  return (await ownedLesson(scope, lessonId)).lesson;
}

export async function deleteLesson(scope: TeacherScope, lessonId: string, expectedRevision?: number) {
  const { syllabus } = await ownedLesson(scope, lessonId);
  await touchDraft(syllabus, expectedRevision);
  const now = new Date();
  await requireDb().transaction(async (tx) => {
    await tx.update(syllabusLessons).set({ deletedAt: now }).where(eq(syllabusLessons.id, lessonId));
    await tx.update(syllabusItems).set({ deletedAt: now }).where(and(eq(syllabusItems.lessonId, lessonId), isNull(syllabusItems.deletedAt)));
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export interface ItemPlacement {
  scope: SyllabusItemScope;
  moduleId?: string | null;
  lessonId?: string | null;
}

async function resolvePlacement(scope: TeacherScope, syllabusId: string, p: ItemPlacement) {
  if (p.scope === "LESSON") {
    if (!p.lessonId) throw new AppError("SYLLABUS_INVALID_TARGET");
    const { lesson } = await ownedLesson(scope, p.lessonId);
    if (lesson.syllabusId !== syllabusId) throw new AppError("SYLLABUS_INVALID_TARGET");
    return { moduleId: lesson.moduleId, lessonId: lesson.id };
  }
  if (p.scope === "MODULE") {
    if (!p.moduleId) throw new AppError("SYLLABUS_INVALID_TARGET");
    const { module } = await ownedModule(scope, p.moduleId);
    if (module.syllabusId !== syllabusId) throw new AppError("SYLLABUS_INVALID_TARGET");
    return { moduleId: module.id, lessonId: null };
  }
  return { moduleId: null, lessonId: null };
}

const placementWhere = (syllabusId: string, scope: SyllabusItemScope, moduleId: string | null, lessonId: string | null) =>
  and(
    eq(syllabusItems.syllabusId, syllabusId),
    eq(syllabusItems.scope, scope),
    lessonId ? eq(syllabusItems.lessonId, lessonId) : moduleId ? eq(syllabusItems.moduleId, moduleId) : undefined,
    isNull(syllabusItems.deletedAt),
  );

export async function createItem(
  scope: TeacherScope,
  syllabusId: string,
  placement: ItemPlacement,
  input: { kind: SyllabusItemKind } & Partial<ItemFields> & { title: string },
  expectedRevision?: number,
) {
  const syllabus = await ownedSyllabus(scope, syllabusId);
  // Module and final scopes hold assessments only (module test, final exam).
  if (placement.scope !== "LESSON" && input.kind !== "ASSESSMENT") throw new AppError("SYLLABUS_INVALID_TARGET");
  const where = await resolvePlacement(scope, syllabusId, placement);
  const content = validContent(input.kind, input.content ?? {});
  const assessmentId = input.kind === "ASSESSMENT" ? (input.assessmentId ?? null) : null;
  await assertOwnAssessment(scope, assessmentId);
  await assertOwnRefs(scope, contentRefs(input.kind, content));
  await touchDraft(syllabus, expectedRevision);
  const id = nanoid();
  const position = await nextPosition(syllabusItems, placementWhere(syllabusId, placement.scope, where.moduleId, where.lessonId));
  const db = requireDb();
  await db.transaction(async (tx) => {
    const taskId =
      input.kind === "STUDENT_PRACTICE"
        ? await createContainer(tx, { workspaceId: scope.workspaceId, userId: scope.userId }, { syllabusId, itemId: id, versionId: null }, input.title, content)
        : null;
    await tx.insert(syllabusItems).values({
      id,
      syllabusId,
      scope: placement.scope,
      moduleId: where.moduleId,
      lessonId: where.lessonId,
      kind: input.kind,
      position,
      title: input.title,
      required: input.required ?? true,
      content,
      assessmentId,
      materialId: resourceMaterialId(input.kind, content),
      taskId,
    });
  });
  return (await ownedItem(scope, id)).item;
}

const resourceMaterialId = (kind: SyllabusItemKind, content: Record<string, unknown>) =>
  kind === "RESOURCE" && typeof content.materialId === "string" ? content.materialId : null;

export async function updateItem(scope: TeacherScope, itemId: string, patch: Partial<ItemFields>, expectedRevision?: number) {
  const { item, syllabus } = await ownedItem(scope, itemId);
  const content = patch.content !== undefined ? validContent(item.kind, patch.content) : undefined;
  if (patch.assessmentId !== undefined && item.kind !== "ASSESSMENT") throw new AppError("SYLLABUS_INVALID_TARGET");
  if (patch.assessmentId) await assertOwnAssessment(scope, patch.assessmentId);
  if (content) await assertOwnRefs(scope, contentRefs(item.kind, content));
  await touchDraft(syllabus, expectedRevision);
  const values = defined({
    title: patch.title,
    required: patch.required,
    content,
    assessmentId: patch.assessmentId,
    materialId: content && item.kind === "RESOURCE" ? resourceMaterialId(item.kind, content) : undefined,
  });
  const db = requireDb();
  if (Object.keys(values).length) await db.update(syllabusItems).set(values).where(eq(syllabusItems.id, itemId));
  if (item.kind === "STUDENT_PRACTICE" && item.taskId && (content || patch.title)) {
    await syncContainer(db, item.taskId, patch.title ?? item.title, content ?? item.content);
  }
  return (await ownedItem(scope, itemId)).item;
}

export async function deleteItem(scope: TeacherScope, itemId: string, expectedRevision?: number) {
  const { syllabus } = await ownedItem(scope, itemId);
  await touchDraft(syllabus, expectedRevision);
  await requireDb().update(syllabusItems).set({ deletedAt: new Date() }).where(eq(syllabusItems.id, itemId));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reorder (full ordered id list, same as assessments.reorder) and duplicate
// ---------------------------------------------------------------------------

function assertSameSet(current: readonly string[], ordered: readonly string[]) {
  if (current.length !== ordered.length || new Set(ordered).size !== ordered.length || !ordered.every((id) => current.includes(id))) {
    throw new AppError("SYLLABUS_INVALID_TARGET");
  }
}

export async function reorderModules(scope: TeacherScope, syllabusId: string, orderedIds: string[], expectedRevision?: number) {
  const syllabus = await ownedSyllabus(scope, syllabusId);
  const db = requireDb();
  const rows = await db.select({ id: syllabusModules.id }).from(syllabusModules).where(and(eq(syllabusModules.syllabusId, syllabusId), isNull(syllabusModules.deletedAt)));
  assertSameSet(rows.map((r) => r.id), orderedIds);
  await touchDraft(syllabus, expectedRevision);
  await db.transaction(async (tx) => {
    for (const [i, id] of orderedIds.entries()) await tx.update(syllabusModules).set({ position: i + 1 }).where(eq(syllabusModules.id, id));
  });
  return { ok: true };
}

export async function reorderLessons(scope: TeacherScope, moduleId: string, orderedIds: string[], expectedRevision?: number) {
  const { syllabus } = await ownedModule(scope, moduleId);
  const db = requireDb();
  const rows = await db.select({ id: syllabusLessons.id }).from(syllabusLessons).where(and(eq(syllabusLessons.moduleId, moduleId), isNull(syllabusLessons.deletedAt)));
  assertSameSet(rows.map((r) => r.id), orderedIds);
  await touchDraft(syllabus, expectedRevision);
  await db.transaction(async (tx) => {
    for (const [i, id] of orderedIds.entries()) await tx.update(syllabusLessons).set({ position: i + 1 }).where(eq(syllabusLessons.id, id));
  });
  return { ok: true };
}

export async function reorderItems(scope: TeacherScope, syllabusId: string, placement: ItemPlacement, orderedIds: string[], expectedRevision?: number) {
  const syllabus = await ownedSyllabus(scope, syllabusId);
  const where = await resolvePlacement(scope, syllabusId, placement);
  const db = requireDb();
  const rows = await db.select({ id: syllabusItems.id }).from(syllabusItems).where(placementWhere(syllabusId, placement.scope, where.moduleId, where.lessonId));
  assertSameSet(rows.map((r) => r.id), orderedIds);
  await touchDraft(syllabus, expectedRevision);
  await db.transaction(async (tx) => {
    for (const [i, id] of orderedIds.entries()) await tx.update(syllabusItems).set({ position: i + 1 }).where(eq(syllabusItems.id, id));
  });
  return { ok: true };
}

async function copyItems(tx: DbOrTx, scope: TeacherScope, source: SyllabusItemRow[], target: { syllabusId: string; moduleId: string | null; lessonId: string | null }) {
  for (const it of source) {
    const id = nanoid();
    const taskId =
      it.kind === "STUDENT_PRACTICE" && it.taskId
        ? await cloneContainer(tx, it.taskId, { workspaceId: scope.workspaceId, userId: scope.userId }, { syllabusId: target.syllabusId, itemId: id, versionId: null }, it.title, it.content)
        : null;
    await tx.insert(syllabusItems).values({
      id,
      syllabusId: target.syllabusId,
      scope: it.scope,
      moduleId: target.moduleId,
      lessonId: target.lessonId,
      kind: it.kind,
      position: it.position,
      title: it.title,
      required: it.required,
      content: it.content,
      assessmentId: it.assessmentId,
      materialId: it.materialId,
      taskId,
    });
  }
}

const liveItems = (where: ReturnType<typeof and>) => requireDb().select().from(syllabusItems).where(and(where, isNull(syllabusItems.deletedAt)));

/** Deep copy (new ids) placed right after the original; practice containers are cloned with their answer keys. */
export async function duplicateLesson(scope: TeacherScope, lessonId: string, expectedRevision?: number) {
  const { lesson, syllabus } = await ownedLesson(scope, lessonId);
  await touchDraft(syllabus, expectedRevision);
  const items = await liveItems(eq(syllabusItems.lessonId, lessonId));
  const id = nanoid();
  await requireDb().transaction(async (tx) => {
    await tx
      .update(syllabusLessons)
      .set({ position: sql`${syllabusLessons.position} + 1` })
      .where(and(eq(syllabusLessons.moduleId, lesson.moduleId), sql`${syllabusLessons.position} > ${lesson.position}`));
    await tx.insert(syllabusLessons).values({
      id,
      syllabusId: lesson.syllabusId,
      moduleId: lesson.moduleId,
      position: lesson.position + 1,
      title: `${lesson.title} (copy)`.slice(0, 255),
      description: lesson.description,
      estimatedMinutes: lesson.estimatedMinutes,
      objectives: lesson.objectives,
      status: lesson.status,
      completionRules: lesson.completionRules,
    });
    await copyItems(tx, scope, items, { syllabusId: lesson.syllabusId, moduleId: lesson.moduleId, lessonId: id });
  });
  return (await ownedLesson(scope, id)).lesson;
}

export async function duplicateModule(scope: TeacherScope, moduleId: string, expectedRevision?: number) {
  const { module, syllabus } = await ownedModule(scope, moduleId);
  await touchDraft(syllabus, expectedRevision);
  const db = requireDb();
  const lessons = await db.select().from(syllabusLessons).where(and(eq(syllabusLessons.moduleId, moduleId), isNull(syllabusLessons.deletedAt)));
  const items = await liveItems(eq(syllabusItems.moduleId, moduleId));
  const id = nanoid();
  await db.transaction(async (tx) => {
    await tx
      .update(syllabusModules)
      .set({ position: sql`${syllabusModules.position} + 1` })
      .where(and(eq(syllabusModules.syllabusId, module.syllabusId), sql`${syllabusModules.position} > ${module.position}`));
    await tx.insert(syllabusModules).values({
      id,
      syllabusId: module.syllabusId,
      position: module.position + 1,
      title: `${module.title} (copy)`.slice(0, 255),
      description: module.description,
      estimatedMinutes: module.estimatedMinutes,
      objectives: module.objectives,
      prerequisitesText: module.prerequisitesText,
      status: module.status,
      completionRules: module.completionRules,
    });
    await copyItems(tx, scope, items.filter((it) => it.scope === "MODULE"), { syllabusId: module.syllabusId, moduleId: id, lessonId: null });
    for (const l of lessons) {
      const lessonCopy = nanoid();
      await tx.insert(syllabusLessons).values({
        id: lessonCopy,
        syllabusId: module.syllabusId,
        moduleId: id,
        position: l.position,
        title: l.title,
        description: l.description,
        estimatedMinutes: l.estimatedMinutes,
        objectives: l.objectives,
        status: l.status,
        completionRules: l.completionRules,
      });
      await copyItems(tx, scope, items.filter((it) => it.scope === "LESSON" && it.lessonId === l.id), { syllabusId: module.syllabusId, moduleId: id, lessonId: lessonCopy });
    }
  });
  return (await ownedModule(scope, id)).module;
}

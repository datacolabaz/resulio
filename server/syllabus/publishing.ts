import { and, asc, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { syllabi, syllabusEnrollments, syllabusVersionItems, syllabusVersions } from "../../drizzle/schema";
import { requireDb } from "../db";
import type { TeacherScope } from "../modules/access";
import { AppError } from "../modules/errors";
import { ownedSyllabus } from "./access";
import { loadDraft } from "./draft";
import { allItems } from "./engine";
import { announceFirstPublish } from "./notify";
import { answerKeyOf, cloneContainer, createContainer } from "./practiceTasks";
import { buildStructure, contentHash, nextVersionLabel } from "./snapshot";
import * as store from "./store";

/**
 * Publish = freeze the draft into an immutable version (§4.4). Existing enrollments stay on the
 * version they started with; only new enrollments (and explicit moves) get this one.
 */
export async function publish(scope: TeacherScope, syllabusId: string, opts: { label?: string; changeNote?: string } = {}) {
  const { syllabus, modules, lessons, items, problems, publishedAssessments } = await loadDraft(scope, syllabusId);
  if (syllabus.archivedAt) throw new AppError("SYLLABUS_ARCHIVED");
  const db = requireDb();

  const dryRun = buildStructure({ syllabusRules: syllabus.completionRules, modules, lessons, items, publishedAssessments, frozenTaskIds: new Map() });
  problems.push(...dryRun.problems);
  if (problems.length) return { published: false as const, problems };

  const included = new Set(allItems(dryRun.structure).map((it) => it.id));
  const draftItems = items.filter((it) => included.has(it.id));
  const answerKeys = new Map<string, string | null>();
  for (const it of draftItems) if (it.kind === "STUDENT_PRACTICE" && it.taskId) answerKeys.set(it.id, await answerKeyOf(db, it.taskId));

  const result = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(syllabi).where(eq(syllabi.id, syllabusId)).for("update");
    const previous = locked.currentVersionId
      ? await tx.select().from(syllabusVersionItems).where(eq(syllabusVersionItems.versionId, locked.currentVersionId))
      : [];
    const prevById = new Map(previous.map((p) => [p.itemId, p]));
    const [{ maxNo }] = await tx
      .select({ maxNo: sql<number>`coalesce(max(${syllabusVersions.versionNo}), 0)` })
      .from(syllabusVersions)
      .where(eq(syllabusVersions.syllabusId, syllabusId));
    const versionNo = Number(maxNo) + 1;
    const versionId = nanoid();
    const owner = { workspaceId: scope.workspaceId, userId: scope.userId };

    // Copy-on-publish: an unchanged practice keeps its frozen container (existing submissions stay valid).
    const hashes = new Map<string, string>();
    const frozenTaskIds = new Map<string, string>();
    for (const it of draftItems) {
      const hash = contentHash(it, answerKeys.get(it.id) ?? null);
      hashes.set(it.id, hash);
      if (it.kind !== "STUDENT_PRACTICE") continue;
      const prev = prevById.get(it.id);
      if (prev?.taskId && prev.contentHash === hash) frozenTaskIds.set(it.id, prev.taskId);
      else {
        const link = { syllabusId, itemId: it.id, versionId };
        frozenTaskIds.set(it.id, it.taskId ? await cloneContainer(tx, it.taskId, owner, link, it.title, it.content) : await createContainer(tx, owner, link, it.title, it.content));
      }
    }

    const { structure } = buildStructure({ syllabusRules: locked.completionRules, modules, lessons, items, publishedAssessments, frozenTaskIds });
    const stubs = new Map(allItems(structure).map((s) => [s.id, s]));
    const lessonOf = new Map(structure.modules.flatMap((m) => m.lessons.map((l) => [l.id, m.id] as const)));
    await tx.update(syllabusVersions).set({ status: "ARCHIVED" }).where(and(eq(syllabusVersions.syllabusId, syllabusId), eq(syllabusVersions.status, "PUBLISHED")));
    await tx.insert(syllabusVersions).values({
      id: versionId,
      syllabusId,
      versionNo,
      label: (opts.label?.trim() || nextVersionLabel(versionNo)).slice(0, 16),
      structure: structure as unknown as Record<string, unknown>,
      meta: {
        title: locked.title,
        description: locked.description ?? "",
        subject: locked.subject,
        level: locked.level,
        language: locked.language,
        estimatedDurationLabel: locked.estimatedDurationLabel,
        estimatedHours: locked.estimatedHours,
        coverFileId: locked.coverFileId,
      },
      changeNote: opts.changeNote?.trim() || null,
      publishedBy: scope.userId,
    });
    await tx.insert(syllabusVersionItems).values(
      draftItems.map((it) => {
        const s = stubs.get(it.id)!;
        return {
          versionId,
          itemId: it.id,
          moduleId: it.lessonId ? (lessonOf.get(it.lessonId) ?? it.moduleId) : it.moduleId,
          lessonId: it.lessonId,
          kind: it.kind,
          content: it.content,
          taskId: s.taskId,
          assessmentId: s.assessmentId,
          assessmentVersionId: s.assessmentVersionId,
          contentHash: hashes.get(it.id)!,
        };
      }),
    );
    await tx
      .update(syllabi)
      .set({ currentVersionId: versionId, status: "PUBLISHED", hasDraftChanges: false })
      .where(eq(syllabi.id, syllabusId));
    return {
      published: true as const,
      versionId,
      versionNo,
      reusedPracticeContainers: [...frozenTaskIds].filter(([id, taskId]) => prevById.get(id)?.taskId === taskId).length,
    };
  });
  if (result.versionNo === 1) announceFirstPublish({ ...syllabus, currentVersionId: result.versionId }, await store.grantsForSyllabus(syllabusId));
  return result;
}

export async function listVersions(scope: TeacherScope, syllabusId: string) {
  await ownedSyllabus(scope, syllabusId);
  const db = requireDb();
  const rows = await db.select().from(syllabusVersions).where(eq(syllabusVersions.syllabusId, syllabusId)).orderBy(desc(syllabusVersions.versionNo));
  const counts = await db
    .select({ versionId: syllabusEnrollments.versionId, n: sql<number>`count(*)` })
    .from(syllabusEnrollments)
    .where(eq(syllabusEnrollments.syllabusId, syllabusId))
    .groupBy(syllabusEnrollments.versionId);
  return rows.map((v) => ({
    id: v.id,
    versionNo: v.versionNo,
    label: v.label,
    status: v.status,
    changeNote: v.changeNote,
    publishedAt: v.publishedAt,
    publishedBy: v.publishedBy,
    enrolledCount: Number(counts.find((c) => c.versionId === v.id)?.n ?? 0),
  }));
}

/** A frozen version as the teacher sees it (full content, incl. teacher-only fields). */
export async function versionDetail(scope: TeacherScope, syllabusId: string, versionId: string) {
  await ownedSyllabus(scope, syllabusId);
  const db = requireDb();
  const [version] = await db.select().from(syllabusVersions).where(and(eq(syllabusVersions.id, versionId), eq(syllabusVersions.syllabusId, syllabusId))).limit(1);
  if (!version) throw new AppError("NOT_FOUND");
  const items = await db.select().from(syllabusVersionItems).where(eq(syllabusVersionItems.versionId, versionId)).orderBy(asc(syllabusVersionItems.itemId));
  return { version, items };
}

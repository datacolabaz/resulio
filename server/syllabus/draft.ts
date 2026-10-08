import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { assessments, syllabusItems, syllabusLessons, syllabusModules, syllabusVersionItems, syllabusVersions } from "../../drizzle/schema";
import { parseItemContent } from "../../shared/syllabus";
import { requireDb } from "../db";
import type { TeacherScope } from "../modules/access";
import { ownedSyllabus } from "./access";
import { allItems, computeProgress } from "./engine";
import { changedDetailModules, draftModuleDetails, versionModuleDetails } from "./moduleDetails";
import { answerKeyOf } from "./practiceTasks";
import { studentLessonView, studentPathView } from "./serialize";
import { buildStructure, contentHash, diffStructures, nextVersionLabel, type DraftItem, type PublishProblem } from "./snapshot";
import type { VersionStructure } from "./types";

/** The current draft, parsed and checked the way publish sees it (publish, preview and the publish dialog share this). */
export async function loadDraft(scope: TeacherScope, syllabusId: string) {
  const syllabus = await ownedSyllabus(scope, syllabusId);
  const db = requireDb();
  const [modules, lessons, itemRows] = await Promise.all([
    db.select().from(syllabusModules).where(and(eq(syllabusModules.syllabusId, syllabusId), isNull(syllabusModules.deletedAt))),
    db.select().from(syllabusLessons).where(and(eq(syllabusLessons.syllabusId, syllabusId), isNull(syllabusLessons.deletedAt))),
    db.select().from(syllabusItems).where(and(eq(syllabusItems.syllabusId, syllabusId), isNull(syllabusItems.deletedAt))),
  ]);
  const problems: PublishProblem[] = [];
  const items: DraftItem[] = [];
  for (const it of itemRows) {
    try {
      items.push({ ...it, content: parseItemContent(it.kind, it.content) as Record<string, unknown> });
    } catch {
      problems.push({ code: "SYLLABUS_INVALID_CONTENT", itemId: it.id, title: it.title });
    }
  }
  const assessmentIds = [...new Set(items.flatMap((it) => (it.kind === "ASSESSMENT" && it.assessmentId ? [it.assessmentId] : [])))];
  const published = assessmentIds.length
    ? await db
        .select({ id: assessments.id, versionId: assessments.currentVersionId, status: assessments.status })
        .from(assessments)
        .where(and(inArray(assessments.id, assessmentIds), eq(assessments.providerWorkspaceId, scope.workspaceId)))
    : [];
  const publishedAssessments = new Map(published.flatMap((a) => (a.status === "PUBLISHED" && a.versionId ? [[a.id, a.versionId] as const] : [])));
  return { syllabus, modules, lessons, items, problems, publishedAssessments };
}

export type LoadedDraft = Awaited<ReturnType<typeof loadDraft>>;

/** Draft rows excluded from publishing because they are still marked DRAFT (or sit in a DRAFT module). */
function excludedCounts(d: LoadedDraft, structure: VersionStructure) {
  const includedLessons = new Set(structure.modules.flatMap((m) => m.lessons.map((l) => l.id)));
  return {
    modules: d.modules.filter((m) => !structure.modules.some((s) => s.id === m.id)).length,
    lessons: d.lessons.filter((l) => !includedLessons.has(l.id)).length,
  };
}

/** What "Publish" would do now: problems, what is left out, and a short diff against the current version. */
export async function publishPreview(scope: TeacherScope, syllabusId: string) {
  const d = await loadDraft(scope, syllabusId);
  const db = requireDb();
  const { structure, problems } = buildStructure({
    syllabusRules: d.syllabus.completionRules,
    modules: d.modules,
    lessons: d.lessons,
    items: d.items,
    publishedAssessments: d.publishedAssessments,
    frozenTaskIds: new Map(),
  });
  const included = new Set(allItems(structure).map((it) => it.id));
  const nextHashes = new Map<string, string>();
  for (const it of d.items) {
    if (!included.has(it.id)) continue;
    const key = it.kind === "STUDENT_PRACTICE" && it.taskId ? await answerKeyOf(db, it.taskId) : null;
    nextHashes.set(it.id, contentHash(it, key));
  }
  let previous: VersionStructure | null = null;
  const prevHashes = new Map<string, string>();
  if (d.syllabus.currentVersionId) {
    const [version] = await db.select().from(syllabusVersions).where(eq(syllabusVersions.id, d.syllabus.currentVersionId)).limit(1);
    if (version) {
      previous = version.structure as unknown as VersionStructure;
      const rows = await db.select({ itemId: syllabusVersionItems.itemId, hash: syllabusVersionItems.contentHash }).from(syllabusVersionItems).where(eq(syllabusVersionItems.versionId, version.id));
      for (const r of rows) prevHashes.set(r.itemId, r.hash);
    }
  }
  const [{ maxNo }] = await db
    .select({ maxNo: sql<number>`coalesce(max(${syllabusVersions.versionNo}), 0)` })
    .from(syllabusVersions)
    .where(eq(syllabusVersions.syllabusId, syllabusId));
  const [draftDetails, publishedDetails] = await Promise.all([
    draftModuleDetails(syllabusId, db),
    d.syllabus.currentVersionId ? versionModuleDetails(d.syllabus.currentVersionId, db) : Promise.resolve(new Map()),
  ]);
  const detailsChanged = changedDetailModules(draftDetails, publishedDetails, structure.modules.map((m) => m.id));
  return {
    problems: [...d.problems, ...problems],
    excluded: excludedCounts(d, structure),
    diff: diffStructures(previous, structure, prevHashes, nextHashes, detailsChanged),
    nextLabel: nextVersionLabel(Number(maxNo) + 1),
    hasDraftChanges: d.syllabus.hasDraftChanges,
  };
}

/**
 * "Preview as student": the draft rendered through the student serializers with every lesson
 * opened (locks bypassed), so the teacher sees exactly what a student would see, minus progress.
 */
export async function preview(scope: TeacherScope, syllabusId: string) {
  const d = await loadDraft(scope, syllabusId);
  const { structure, problems } = buildStructure({
    syllabusRules: d.syllabus.completionRules,
    modules: d.modules,
    lessons: d.lessons,
    items: d.items,
    publishedAssessments: d.publishedAssessments,
    frozenTaskIds: new Map(d.items.flatMap((it) => (it.taskId ? [[it.id, it.taskId] as const] : []))),
  });
  const output = computeProgress({
    structure,
    facts: new Map(),
    prevModules: new Map(),
    prevLessons: new Map(),
    openedLessons: new Set(),
    manualModules: new Set(structure.modules.map((m) => m.id)),
    manualLessons: new Set(structure.modules.flatMap((m) => m.lessons.map((l) => l.id))),
    approvals: new Set(),
  });
  const byId = new Map(d.items.map((it) => [it.id, it]));
  const lessons = structure.modules.flatMap((m) =>
    m.lessons.map((l) => {
      const contents = l.items.flatMap((stub) => {
        const it = byId.get(stub.id);
        return it ? [{ itemId: it.id, kind: it.kind, content: it.content }] : [];
      });
      return studentLessonView(structure, output, l.id, contents);
    }),
  );
  return {
    syllabus: {
      id: d.syllabus.id,
      title: d.syllabus.title,
      description: d.syllabus.description ?? "",
      subject: d.syllabus.subject,
      level: d.syllabus.level,
      coverFileId: d.syllabus.coverFileId,
    },
    path: studentPathView(structure, output, await draftModuleDetails(syllabusId)),
    lessons: lessons.filter((l): l is NonNullable<typeof l> & { locked: false } => !!l && !l.locked),
    problems: [...d.problems, ...problems],
    excluded: excludedCounts(d, structure),
  };
}

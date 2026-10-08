import { eq, inArray } from "drizzle-orm";
import { syllabusTiming, syllabusVersionTiming } from "../../drizzle/schema";
import { emptyTiming, parseTiming, timingFor, type CourseTiming, type Duration, type SyllabusTiming } from "../../shared/syllabusTiming";
import { requireDb, type DbOrTx } from "../db";
import { isMissingTable } from "../notifications/preferences";

/**
 * Course pacing (shared/syllabusTiming.ts). One JSON row per draft, copied per version on publish,
 * like the end-of-module blocks. Before migration 0035 runs the tables are missing: reads return
 * empty timing, so syllabi work exactly as before.
 */

async function tolerant<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isMissingTable(error)) return fallback;
    throw error;
  }
}

const json = (t: SyllabusTiming) => t as unknown as Record<string, unknown>;

export async function draftTiming(syllabusId: string, db: DbOrTx = requireDb()): Promise<SyllabusTiming> {
  return tolerant(emptyTiming(), async () => {
    const [row] = await db.select({ timing: syllabusTiming.timing }).from(syllabusTiming).where(eq(syllabusTiming.syllabusId, syllabusId)).limit(1);
    return row ? parseTiming(row.timing) : emptyTiming();
  });
}

export async function versionTiming(versionId: string, db: DbOrTx = requireDb()): Promise<SyllabusTiming> {
  return tolerant(emptyTiming(), async () => {
    const [row] = await db.select({ timing: syllabusVersionTiming.timing }).from(syllabusVersionTiming).where(eq(syllabusVersionTiming.versionId, versionId)).limit(1);
    return row ? parseTiming(row.timing) : emptyTiming();
  });
}

export async function saveDraftTiming(syllabusId: string, timing: SyllabusTiming, db: DbOrTx = requireDb()) {
  await db.insert(syllabusTiming).values({ syllabusId, timing: json(timing) }).onDuplicateKeyUpdate({ set: { timing: json(timing) } });
}

/** Read-modify-write under a row lock, so two quick edits (course + a module) never lose each other. */
export async function patchDraftTiming(syllabusId: string, patch: (t: SyllabusTiming) => SyllabusTiming) {
  await requireDb().transaction(async (tx) => {
    const [row] = await tx.select({ timing: syllabusTiming.timing }).from(syllabusTiming).where(eq(syllabusTiming.syllabusId, syllabusId)).for("update");
    await saveDraftTiming(syllabusId, patch(row ? parseTiming(row.timing) : emptyTiming()), tx);
  });
}

export const withCourse = (course: CourseTiming) => (t: SyllabusTiming): SyllabusTiming => ({ ...t, course });

export const withModuleDuration = (moduleId: string, duration: Duration | null) => (t: SyllabusTiming): SyllabusTiming => {
  const modules = { ...t.modules };
  if (duration) modules[moduleId] = duration;
  else delete modules[moduleId];
  return { ...t, modules };
};

/** Publish: the draft timing limited to the modules that made it into the version. */
export async function freezeTiming(tx: DbOrTx, versionId: string, timing: SyllabusTiming, moduleIds: readonly string[]) {
  const frozen = timingFor(timing, moduleIds);
  if (!frozen.course.duration && !frozen.course.lessonsPerWeek && !Object.keys(frozen.modules).length) return;
  await tx.insert(syllabusVersionTiming).values({ versionId, timing: json(frozen) });
}

export async function purgeTiming(tx: DbOrTx, syllabusId: string, versionIds: readonly string[]) {
  await tolerant(undefined, async () => {
    if (versionIds.length) await tx.delete(syllabusVersionTiming).where(inArray(syllabusVersionTiming.versionId, [...versionIds]));
    await tx.delete(syllabusTiming).where(eq(syllabusTiming.syllabusId, syllabusId));
  });
}
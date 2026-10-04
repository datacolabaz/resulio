import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { learningActivity, syllabusVersionItems } from "../../drizzle/schema";
import { requireDb } from "../db";
import * as store from "./store";
import type { LessonStub, VersionStructure } from "./types";

/**
 * "New" / "Updated" lesson badges after a student was moved to a newer version. A badge stays until
 * the student opens that lesson after the move; nothing here affects progress or access.
 */

export type LessonChange = "NEW" | "UPDATED";

const lessonsOf = (s: VersionStructure) => s.modules.flatMap((m) => m.lessons);

const itemSignature = (l: LessonStub, hashes: ReadonlyMap<string, string>) =>
  l.items.map((it) => [it.id, it.kind, it.title, it.required, hashes.get(it.id) ?? ""].join("\u0001")).join("\u0002");

export function changedLessons(
  prev: VersionStructure,
  next: VersionStructure,
  prevHashes: ReadonlyMap<string, string>,
  nextHashes: ReadonlyMap<string, string>,
): Map<string, LessonChange> {
  const before = new Map(lessonsOf(prev).map((l) => [l.id, l]));
  const out = new Map<string, LessonChange>();
  for (const l of lessonsOf(next)) {
    const old = before.get(l.id);
    if (!old) out.set(l.id, "NEW");
    else if (old.title !== l.title || old.description !== l.description || itemSignature(old, prevHashes) !== itemSignature(l, nextHashes)) out.set(l.id, "UPDATED");
  }
  return out;
}

/** Drops lessons the student has opened since the move. Without a known move time nothing is shown. */
export function unseenChanges(changes: ReadonlyMap<string, LessonChange>, movedAt: Date | null, opened: ReadonlyArray<{ lessonId: string | null; occurredAt: Date }>) {
  if (!movedAt) return {};
  const seen = new Set(opened.filter((o) => o.lessonId && o.occurredAt.getTime() >= movedAt.getTime()).map((o) => o.lessonId!));
  const out: Record<string, LessonChange> = {};
  for (const [id, change] of changes) if (!seen.has(id)) out[id] = change;
  return out;
}

/** Runs only for an enrollment that was actually moved (versions are cached). Never throws. */
export async function lessonChangesFor(enrollment: { studentId: number; syllabusId: string; versionId: string; upgradedFromVersionId: string | null }): Promise<Record<string, LessonChange>> {
  const fromId = enrollment.upgradedFromVersionId;
  if (!fromId || fromId === enrollment.versionId) return {};
  try {
    const db = requireDb();
    const [prev, next] = await Promise.all([store.versionById(fromId), store.versionById(enrollment.versionId)]);
    if (!prev || !next) return {};
    const [hashes, [moved]] = await Promise.all([
      db
        .select({ versionId: syllabusVersionItems.versionId, itemId: syllabusVersionItems.itemId, hash: syllabusVersionItems.contentHash })
        .from(syllabusVersionItems)
        .where(inArray(syllabusVersionItems.versionId, [fromId, enrollment.versionId])),
      db
        .select({ occurredAt: learningActivity.occurredAt })
        .from(learningActivity)
        .where(
          and(
            eq(learningActivity.userId, enrollment.studentId),
            eq(learningActivity.syllabusId, enrollment.syllabusId),
            eq(learningActivity.activityType, "VERSION_UPGRADED"),
            eq(learningActivity.versionId, enrollment.versionId),
          ),
        )
        .orderBy(desc(learningActivity.occurredAt))
        .limit(1),
    ]);
    const changes = changedLessons(
      prev.structure,
      next.structure,
      new Map(hashes.filter((h) => h.versionId === fromId).map((h) => [h.itemId, h.hash])),
      new Map(hashes.filter((h) => h.versionId === enrollment.versionId).map((h) => [h.itemId, h.hash])),
    );
    if (!changes.size || !moved) return {};
    const opened = await db
      .select({ lessonId: learningActivity.lessonId, occurredAt: learningActivity.occurredAt })
      .from(learningActivity)
      .where(
        and(
          eq(learningActivity.userId, enrollment.studentId),
          eq(learningActivity.syllabusId, enrollment.syllabusId),
          eq(learningActivity.activityType, "LESSON_OPENED"),
          gte(learningActivity.occurredAt, moved.occurredAt),
        ),
      );
    return unseenChanges(changes, moved.occurredAt, opened);
  } catch (error) {
    console.warn("[syllabus] lesson change badges skipped", error);
    return {};
  }
}

import { and, asc, desc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { coachMaterials, coachMistakes, coachTopicMastery, coachTopics } from "../../drizzle/schema";
import type { MistakeCause } from "../../shared/coach";
import type { MasteryStatus } from "../../shared/growth";
import { requireDb } from "../db";
import { AppError } from "../modules/errors";
import { logEvent, settingsOf } from "./store";

/**
 * Review: when each topic should be practised again (spaced repetition on the coach's own quiz
 * results), the queue of due topics, open mistakes, and "AI yaddaşı" — what the coach remembers
 * about the student, which they can delete.
 */

const DAY = 86_400_000;
export const MAX_INTERVAL_DAYS = 60;

/**
 * Next review from this quiz: a weak result comes back tomorrow; a good one pushes the interval
 * out (about ×2.2 when ≥ 80 %, ×1.2 when 50–80 %). Strong mastery adds a little; capped at 60 days.
 */
export function nextReview(input: { percentage: number | null; mastery: number; status: MasteryStatus; previousInterval: number; now: Date }): { intervalDays: number; nextReviewAt: Date | null } {
  if (input.percentage === null) return { intervalDays: input.previousInterval, nextReviewAt: input.previousInterval ? new Date(input.now.getTime() + input.previousInterval * DAY) : null };
  const prev = Math.max(0, input.previousInterval);
  let days: number;
  if (input.percentage < 50) days = 1;
  else if (input.percentage < 80) days = prev ? Math.max(2, Math.round(prev * 1.2)) : 2;
  else days = prev ? Math.max(3, Math.round(prev * 2.2)) : 3;
  if (input.status === "STRONG" && input.percentage >= 80) days = Math.round(days * 1.25);
  days = Math.min(MAX_INTERVAL_DAYS, Math.max(1, days));
  return { intervalDays: days, nextReviewAt: new Date(input.now.getTime() + days * DAY) };
}

/** Whole days a review is overdue (0 = due today or not yet due). */
export const overdueDays = (nextReviewAt: Date | null, now: Date) => (nextReviewAt && nextReviewAt <= now ? Math.floor((now.getTime() - nextReviewAt.getTime()) / DAY) : 0);

/** Most overdue first, then the weakest. */
export function sortDue<T extends { nextReviewAt: Date | null; mastery: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.nextReviewAt?.getTime() ?? 0) - (b.nextReviewAt?.getTime() ?? 0) || a.mastery - b.mastery);
}

export async function reviewQueue(studentId: number, now = new Date(), limit = 10) {
  const db = requireDb();
  const rows = await db
    .select({
      topicId: coachTopicMastery.topicId,
      mastery: coachTopicMastery.mastery,
      status: coachTopicMastery.status,
      nextReviewAt: coachTopicMastery.nextReviewAt,
      title: coachTopics.title,
      materialId: coachTopics.materialId,
      materialTitle: coachMaterials.title,
    })
    .from(coachTopicMastery)
    .innerJoin(coachTopics, eq(coachTopics.id, coachTopicMastery.topicId))
    .innerJoin(coachMaterials, eq(coachMaterials.id, coachTopics.materialId))
    .where(and(eq(coachTopicMastery.studentId, studentId), isNotNull(coachTopicMastery.nextReviewAt), lte(coachTopicMastery.nextReviewAt, now)))
    .orderBy(asc(coachTopicMastery.nextReviewAt))
    .limit(50);
  const mistakes = await openMistakeCounts(studentId);
  return sortDue(rows)
    .slice(0, limit)
    .map((r) => ({ ...r, overdueDays: overdueDays(r.nextReviewAt, now), openMistakes: mistakes.get(r.topicId) ?? 0 }));
}

async function openMistakeCounts(studentId: number) {
  const rows = await requireDb()
    .select({ topicId: coachMistakes.topicId, n: sql<number>`count(*)` })
    .from(coachMistakes)
    .where(and(eq(coachMistakes.studentId, studentId), isNull(coachMistakes.fixedAt)))
    .groupBy(coachMistakes.topicId);
  return new Map(rows.filter((r) => r.topicId).map((r) => [r.topicId as string, Number(r.n)]));
}

/** Counts for the student home card; null when reminders are off. */
export async function homeSummary(studentId: number, now = new Date()) {
  const settings = await settingsOf(studentId);
  if (!settings.consentAt || !settings.reminders) return null;
  const db = requireDb();
  const [due] = await db
    .select({ n: sql<number>`count(*)` })
    .from(coachTopicMastery)
    .where(and(eq(coachTopicMastery.studentId, studentId), isNotNull(coachTopicMastery.nextReviewAt), lte(coachTopicMastery.nextReviewAt, now)));
  const [open] = await db
    .select({ n: sql<number>`count(*)` })
    .from(coachMistakes)
    .where(and(eq(coachMistakes.studentId, studentId), isNull(coachMistakes.fixedAt)));
  return { due: Number(due?.n ?? 0), openMistakes: Number(open?.n ?? 0) };
}

export async function listMistakes(studentId: number, includeFixed = false) {
  const rows = await requireDb()
    .select({
      id: coachMistakes.id,
      topicId: coachMistakes.topicId,
      quizId: coachMistakes.quizId,
      cause: coachMistakes.cause,
      question: coachMistakes.question,
      fixedAt: coachMistakes.fixedAt,
      createdAt: coachMistakes.createdAt,
      topicTitle: coachTopics.title,
      materialTitle: coachMaterials.title,
    })
    .from(coachMistakes)
    .leftJoin(coachTopics, eq(coachTopics.id, coachMistakes.topicId))
    .leftJoin(coachMaterials, eq(coachMaterials.id, coachMistakes.materialId))
    .where(includeFixed ? eq(coachMistakes.studentId, studentId) : and(eq(coachMistakes.studentId, studentId), isNull(coachMistakes.fixedAt)))
    .orderBy(desc(coachMistakes.createdAt))
    .limit(200);
  return rows.map((r) => ({ ...r, cause: r.cause as MistakeCause }));
}

/** The student marks a mistake as worked through. */
export async function markMistakeFixed(studentId: number, id: string) {
  const db = requireDb();
  const [row] = await db.select({ id: coachMistakes.id, fixedAt: coachMistakes.fixedAt }).from(coachMistakes).where(and(eq(coachMistakes.id, id), eq(coachMistakes.studentId, studentId))).limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  if (!row.fixedAt) {
    await db.update(coachMistakes).set({ fixedAt: new Date() }).where(eq(coachMistakes.id, id));
    await logEvent(studentId, "MISTAKE_FIXED", id);
  }
  return { ok: true as const };
}

/** Mastery per topic of one material (for badges on the material page). */
export async function materialProgress(studentId: number, materialId: string) {
  const rows = await requireDb()
    .select({ topicId: coachTopicMastery.topicId, mastery: coachTopicMastery.mastery, status: coachTopicMastery.status, nextReviewAt: coachTopicMastery.nextReviewAt })
    .from(coachTopicMastery)
    .where(and(eq(coachTopicMastery.studentId, studentId), eq(coachTopicMastery.materialId, materialId)));
  return rows;
}

/** "AI yaddaşı": topics the coach tracks and the mistakes it remembers. */
export async function memory(studentId: number) {
  const topics = await requireDb()
    .select({
      topicId: coachTopicMastery.topicId,
      mastery: coachTopicMastery.mastery,
      status: coachTopicMastery.status,
      attempts: coachTopicMastery.attempts,
      lastPracticedAt: coachTopicMastery.lastPracticedAt,
      nextReviewAt: coachTopicMastery.nextReviewAt,
      title: coachTopics.title,
      materialTitle: coachMaterials.title,
    })
    .from(coachTopicMastery)
    .leftJoin(coachTopics, eq(coachTopics.id, coachTopicMastery.topicId))
    .leftJoin(coachMaterials, eq(coachMaterials.id, coachTopicMastery.materialId))
    .where(eq(coachTopicMastery.studentId, studentId))
    .orderBy(desc(coachTopicMastery.lastPracticedAt))
    .limit(500);
  return { topics, mistakes: await listMistakes(studentId, true) };
}

/** Forgets one topic: its mastery, schedule and mistakes (quizzes stay in the history). */
export async function forgetTopic(studentId: number, topicId: string) {
  const db = requireDb();
  await db.delete(coachTopicMastery).where(and(eq(coachTopicMastery.studentId, studentId), eq(coachTopicMastery.topicId, topicId)));
  await db.delete(coachMistakes).where(and(eq(coachMistakes.studentId, studentId), eq(coachMistakes.topicId, topicId)));
  return { ok: true as const };
}

export async function forgetMistake(studentId: number, id: string) {
  await requireDb().delete(coachMistakes).where(and(eq(coachMistakes.studentId, studentId), eq(coachMistakes.id, id)));
  return { ok: true as const };
}

export async function forgetAll(studentId: number) {
  const db = requireDb();
  await db.delete(coachTopicMastery).where(eq(coachTopicMastery.studentId, studentId));
  await db.delete(coachMistakes).where(eq(coachMistakes.studentId, studentId));
  return { ok: true as const };
}
import { and, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { coachEvents, coachMaterials, coachMessages, coachMistakes, coachQuizItems, coachQuizzes, coachSettings, coachThreads, coachTopicMastery } from "../../drizzle/schema";
import { RETENTION_DAYS, type CoachEventType } from "../../shared/coach";
import { periodStart } from "../../shared/aiUsage";
import { requireDb } from "../db";
import { deleteMaterials } from "./materials";
import { deleteSharesOf } from "./shares";

/**
 * Data lifecycle: daily retention (tutor messages after 90 days, failed uploads after 7, materials
 * not opened for a year, old event rows) and "delete all my coach data".
 */

const DAY = 86_400_000;
/** Event rows are only needed for caps and simple counts. */
export const EVENT_RETENTION_DAYS = 400;
/** Kept through "delete all my data" for the current month so caps cannot be reset by deleting. */
export const CAP_EVENTS: CoachEventType[] = ["OCR", "UPLOAD", "QUIZ_STARTED", "TUTOR_ASKED", "PRO_GRADE"];

export function retentionCutoffs(now: Date) {
  return {
    messages: new Date(now.getTime() - RETENTION_DAYS.tutorMessages * DAY),
    failed: new Date(now.getTime() - RETENTION_DAYS.failedMaterials * DAY),
    idle: new Date(now.getTime() - RETENTION_DAYS.idleMaterials * DAY),
    events: new Date(now.getTime() - EVENT_RETENTION_DAYS * DAY),
  };
}

/** A material nobody opened (or created, if never opened) before the cutoff. */
export const isIdle = (m: { lastOpenedAt: Date | null; createdAt: Date }, cutoff: Date) => (m.lastOpenedAt ?? m.createdAt) < cutoff;

const BATCH = 200;

export async function runCoachRetention(now = new Date()) {
  const db = requireDb();
  const cut = retentionCutoffs(now);
  await db.delete(coachMessages).where(lt(coachMessages.createdAt, cut.messages));
  // Conversations left without messages go too.
  await db.delete(coachThreads).where(and(lt(coachThreads.lastMessageAt, cut.messages), sql`not exists (select 1 from coach_messages m where m.threadId = ${coachThreads.id})`));

  let materials = 0;
  for (;;) {
    const rows = await db
      .select({ id: coachMaterials.id, studentId: coachMaterials.studentId })
      .from(coachMaterials)
      .where(
        or(
          and(eq(coachMaterials.status, "FAILED"), lt(coachMaterials.updatedAt, cut.failed)),
          and(isNull(coachMaterials.lastOpenedAt), lt(coachMaterials.createdAt, cut.idle)),
          lt(coachMaterials.lastOpenedAt, cut.idle),
        ),
      )
      .limit(BATCH);
    if (!rows.length) break;
    const byStudent = new Map<number, string[]>();
    for (const r of rows) byStudent.set(r.studentId, [...(byStudent.get(r.studentId) ?? []), r.id]);
    for (const [studentId, ids] of byStudent) materials += await deleteMaterials(studentId, ids);
    if (rows.length < BATCH) break;
  }
  await db.delete(coachEvents).where(lt(coachEvents.createdAt, cut.events));
  if (materials) console.info(`[coach] retention: ${materials} materials removed`);
  return { materials };
}

/** "Bütün məlumatlarımı sil": every coach row of the student, files included; consent is reset. */
export async function deleteAllCoachData(studentId: number, now = new Date()) {
  const db = requireDb();
  const ids = (await db.select({ id: coachMaterials.id }).from(coachMaterials).where(eq(coachMaterials.studentId, studentId))).map((r) => r.id);
  for (let i = 0; i < ids.length; i += BATCH) await deleteMaterials(studentId, ids.slice(i, i + BATCH));
  const threads = (await db.select({ id: coachThreads.id }).from(coachThreads).where(eq(coachThreads.studentId, studentId))).map((r) => r.id);
  if (threads.length) await db.delete(coachMessages).where(inArray(coachMessages.threadId, threads));
  await db.delete(coachMessages).where(eq(coachMessages.studentId, studentId));
  await db.delete(coachThreads).where(eq(coachThreads.studentId, studentId));
  const quizzes = (await db.select({ id: coachQuizzes.id }).from(coachQuizzes).where(eq(coachQuizzes.studentId, studentId))).map((r) => r.id);
  if (quizzes.length) await db.delete(coachQuizItems).where(inArray(coachQuizItems.quizId, quizzes));
  await db.delete(coachQuizzes).where(eq(coachQuizzes.studentId, studentId));
  await db.delete(coachTopicMastery).where(eq(coachTopicMastery.studentId, studentId));
  await db.delete(coachMistakes).where(eq(coachMistakes.studentId, studentId));
  await deleteSharesOf(studentId);
  const month = periodStart("month", now);
  await db.delete(coachEvents).where(and(eq(coachEvents.studentId, studentId), or(notInArray(coachEvents.type, CAP_EVENTS), lt(coachEvents.createdAt, month))));
  await db.update(coachEvents).set({ refId: null }).where(eq(coachEvents.studentId, studentId));
  await db.delete(coachSettings).where(eq(coachSettings.studentId, studentId));
  return { ok: true as const, materials: ids.length };
}

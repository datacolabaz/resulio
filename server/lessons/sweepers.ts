import { and, eq, gte } from "drizzle-orm";
import { lessonMeetings, lessons, type LessonRow } from "../../drizzle/schema";
import { getDb, requireDb } from "../db";
import { createMeetingForLesson } from "./meetings";
import { connectionById } from "./tokenStore";

const SWEEP_INTERVAL_MS = 2 * 60_000;
/** Only retry meetings for lessons that haven't started yet -- a FAILED meeting for a lesson already over is not worth retrying. */
async function pendingOrFailedUpcoming(): Promise<LessonRow[]> {
  const db = requireDb();
  const now = new Date();
  const candidates = await db
    .select({ lesson: lessons, meetingStatus: lessonMeetings.status, connectionId: lessonMeetings.connectionId })
    .from(lessons)
    .leftJoin(lessonMeetings, eq(lessonMeetings.lessonId, lessons.id))
    .where(and(eq(lessons.status, "SCHEDULED"), gte(lessons.startsAt, now)));
  return candidates.filter((c) => !c.meetingStatus || c.meetingStatus === "FAILED" || c.meetingStatus === "PENDING").map((c) => c.lesson);
}

/** Retries meeting creation for lessons that have none yet (provider wasn't connected at save time) or whose creation failed. */
export async function retryPendingMeetings(): Promise<void> {
  const toRetry = await pendingOrFailedUpcoming();
  for (const lesson of toRetry) {
    const [existingMeeting] = await requireDb().select().from(lessonMeetings).where(eq(lessonMeetings.lessonId, lesson.id)).limit(1);
    const connection = existingMeeting ? await connectionById(existingMeeting.connectionId) : await connectionForTeacher(lesson);
    if (!connection || connection.status !== "ACTIVE") continue;
    await createMeetingForLesson(lesson, connection);
  }
}

async function connectionForTeacher(lesson: LessonRow) {
  const { connectionOf } = await import("./tokenStore");
  return connectionOf(lesson.createdBy, lesson.platform);
}

export function startLessonMeetingSweeper(): void {
  if (!getDb()) return;
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await retryPendingMeetings();
    } catch (error) {
      console.error("[Lessons] Meeting sweep failed", error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  }, SWEEP_INTERVAL_MS).unref();
}

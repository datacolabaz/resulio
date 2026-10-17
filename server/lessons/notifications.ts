import { dispatchMany } from "../notifications/dispatcher";

/** LESSON_SCHEDULED to the lesson's roster, one dedupe key per (lesson, student) so a resend never duplicates. */
export async function notifyLessonScheduled(studentIds: number[], lessonId: string, title: string, startsAt: Date): Promise<void> {
  if (!studentIds.length) return;
  dispatchMany(
    studentIds.map((userId) => ({
      event: "LESSON_SCHEDULED" as const,
      userId,
      dedupeKey: `lesson:${lessonId}:${userId}`,
      data: { lessonId, title, startsAt: startsAt.toISOString() },
    })),
  );
}

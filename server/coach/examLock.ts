import { and, eq, gt } from "drizzle-orm";
import { attempts } from "../../drizzle/schema";
import { requireDb } from "../db";
import { AppError } from "../modules/errors";

/** True while the student has an exam attempt running (read-only on the attempts table). */
export async function inExam(studentId: number, now = new Date()): Promise<boolean> {
  const [row] = await requireDb()
    .select({ id: attempts.id })
    .from(attempts)
    .where(and(eq(attempts.status, "IN_PROGRESS"), gt(attempts.deadlineAt, now), eq(attempts.studentId, studentId)))
    .limit(1);
  return !!row;
}

/** No AI help (tutor, new summaries, new quizzes) while an exam attempt is open. */
export async function assertNotInExam(studentId: number) {
  if (await inExam(studentId)) throw new AppError("COACH_LOCKED_DURING_EXAM");
}

import { and, eq, inArray } from "drizzle-orm";
import { assessmentAssignments, syllabusAssessmentAssignments, syllabusPracticeTasks } from "../../drizzle/schema";
import { requireDb, type DbOrTx } from "../db";
import { isMissingTable } from "../notifications/preferences";

/**
 * What the existing task/assessment code needs to know about syllabus-owned rows, without
 * importing the syllabus feature. Missing tables (migration not run yet) mean "none".
 */

async function tolerant<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isMissingTable(error)) return fallback;
    throw error;
  }
}

/** Which of these tasks are hidden syllabus practice containers. */
export async function syllabusContainerTaskIds(taskIds: readonly string[], db: DbOrTx = requireDb()): Promise<Set<string>> {
  if (!taskIds.length) return new Set();
  return tolerant(new Set<string>(), async () => {
    const rows = await db
      .select({ taskId: syllabusPracticeTasks.taskId })
      .from(syllabusPracticeTasks)
      .where(inArray(syllabusPracticeTasks.taskId, [...taskIds]));
    return new Set(rows.map((r) => r.taskId));
  });
}

/** Per-student assignments a syllabus created for this assessment (pinned to a syllabus version). */
export async function syllabusAssignmentIds(assessmentId: string, db: DbOrTx = requireDb()): Promise<number[]> {
  return tolerant([] as number[], async () => {
    const rows = await db
      .select({ id: syllabusAssessmentAssignments.assignmentId })
      .from(syllabusAssessmentAssignments)
      .innerJoin(assessmentAssignments, eq(assessmentAssignments.id, syllabusAssessmentAssignments.assignmentId))
      .where(and(eq(assessmentAssignments.assessmentId, assessmentId)));
    return rows.map((r) => r.id);
  });
}

/** Of these assignment ids, the ones a syllabus owns. */
export async function syllabusOwnedAssignments(assignmentIds: readonly number[], db: DbOrTx = requireDb()): Promise<Set<number>> {
  if (!assignmentIds.length) return new Set();
  return tolerant(new Set<number>(), async () => {
    const rows = await db
      .select({ id: syllabusAssessmentAssignments.assignmentId })
      .from(syllabusAssessmentAssignments)
      .where(inArray(syllabusAssessmentAssignments.assignmentId, [...assignmentIds]));
    return new Set(rows.map((r) => r.id));
  });
}

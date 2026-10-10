import { and, eq, ne } from "drizzle-orm";
import { assessments, attempts, results } from "../../drizzle/schema";
import { requireDb, type DbOrTx } from "../db";
import { visibilityForResults } from "../modules/attempts";
import type { StatRow } from "./mastery";

/**
 * Student-facing views (the student's own map and plan, the parent report) use only results the
 * student may already see: released by the exam's rules, not waiting for grading or for the window
 * to close. The teacher's views use every counted result.
 */
export async function releasedResultIds(workspaceId: string, studentId: number, db: DbOrTx = requireDb()): Promise<Set<string>> {
  const rows = await db
    .select({ result: results, assessment: assessments, assignmentId: attempts.assignmentId })
    .from(results)
    .innerJoin(assessments, eq(assessments.id, results.assessmentId))
    .innerJoin(attempts, eq(attempts.id, results.attemptId))
    .where(and(eq(assessments.providerWorkspaceId, workspaceId), eq(results.studentId, studentId), ne(attempts.status, "VOIDED")));
  const visibility = await visibilityForResults(rows.map((r) => ({ result: r.result, assessment: r.assessment, assignmentId: r.assignmentId })), db);
  return new Set([...visibility.entries()].filter(([, v]) => v.released).map(([id]) => id));
}

export const onlyReleased = (stats: StatRow[], released: Set<string>) => stats.filter((s) => released.has(s.resultId));

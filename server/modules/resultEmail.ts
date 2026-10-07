import { and, asc, eq, gt, gte, isNull, sql } from "drizzle-orm";
import { assessments, attempts, resultEmailLog, results, users } from "../../drizzle/schema";
import { requireDb } from "../db";
import { dispatchNow } from "../notifications/dispatcher";
import type { ExamResultNotice } from "../notifications/events";
import { isMissingTable } from "../notifications/preferences";
import { penaltyOf, visibilityForResults } from "./attempts";

/**
 * "E-mail results to students": once a result of an exam with the setting on is final (nothing
 * waits for manual grading) and released to the student, they get one e-mail with the score and
 * the wrong-answer deduction. `result_email_log` claims each result once, so re-runs, restarts
 * and parallel servers never send twice. Results that were final before the box was ticked are
 * picked up too, within `LOOKBACK_DAYS`.
 */

const LOOKBACK_DAYS = 30;

export type ResultEmailAction = "WAIT" | "NO_EMAIL" | "SEND";

export function resultEmailAction(state: { released: boolean; pendingReviewCount: number; email: string | null }): ResultEmailAction {
  if (!state.released || state.pendingReviewCount > 0) return "WAIT";
  return state.email?.trim() ? "SEND" : "NO_EMAIL";
}

export function examResultNotice(result: typeof results.$inferSelect, title: string, penalty: ExamResultNotice["penalty"]): ExamResultNotice {
  return {
    resultId: result.id,
    title,
    earnedPoints: result.earnedPoints,
    totalPoints: result.totalPoints,
    percentage: result.percentage,
    correctCount: result.correctCount,
    wrongCount: result.wrongCount,
    penalty: penalty && { ratio: penalty.ratio, wrongCount: penalty.wrongCount, penaltyPoints: penalty.penaltyPoints },
  };
}

/** Pages through all candidates (keyset on the result id), so results still held back never starve newer ones. */
export async function sweepResultEmails(pageSize = 100, maxPages = 50) {
  const db = requireDb();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  let cursor = "";
  let sent = 0;
  for (let page = 0; page < maxPages; page++) {
    let rows;
    try {
      rows = await db
        .select({ result: results, assessment: assessments, assignmentId: attempts.assignmentId, email: users.email })
        .from(results)
        .innerJoin(assessments, eq(assessments.id, results.assessmentId))
        .innerJoin(attempts, eq(attempts.id, results.attemptId))
        .innerJoin(users, eq(users.id, results.studentId))
        .leftJoin(resultEmailLog, eq(resultEmailLog.resultId, results.id))
        .where(
          and(
            gt(results.id, cursor),
            isNull(resultEmailLog.resultId),
            eq(results.pendingReviewCount, 0),
            gte(results.completedAt, since),
            sql`JSON_EXTRACT(${assessments.settings}, '$.emailResults') = CAST('true' AS JSON)`,
          ),
        )
        .orderBy(asc(results.id))
        .limit(pageSize);
    } catch (error) {
      if (isMissingTable(error)) return sent;
      throw error;
    }
    if (!rows.length) break;
    sent += await sendPage(rows);
    cursor = rows[rows.length - 1].result.id;
    if (rows.length < pageSize) break;
  }
  return sent;
}

type Candidate = {
  result: typeof results.$inferSelect;
  assessment: typeof assessments.$inferSelect;
  assignmentId: number | null;
  email: string | null;
};

async function sendPage(rows: Candidate[]) {
  const db = requireDb();
  const vis = await visibilityForResults(rows, db);
  let sent = 0;
  for (const row of rows) {
    const action = resultEmailAction({
      released: vis.get(row.result.id)?.released ?? false,
      pendingReviewCount: row.result.pendingReviewCount,
      email: row.email,
    });
    if (action === "WAIT") continue;
    const [claim] = await db
      .insert(resultEmailLog)
      .ignore()
      .values({ resultId: row.result.id, studentId: row.result.studentId, status: action === "SEND" ? "SENT" : "NO_EMAIL" });
    if (claim.affectedRows !== 1) continue;
    if (action === "NO_EMAIL") {
      console.warn("[ResultEmail] Student has no e-mail address; skipped", { resultId: row.result.id, studentId: row.result.studentId });
      continue;
    }
    try {
      await dispatchNow({
        event: "EXAM_RESULT_READY",
        userId: row.result.studentId,
        dedupeKey: `exam-result:${row.result.id}`,
        data: examResultNotice(row.result, row.assessment.settings.title, await penaltyOf(row.result.id, db)),
      });
      sent++;
    } catch (error) {
      console.error("[ResultEmail] Failed to send", row.result.id, error);
    }
  }
  return sent;
}

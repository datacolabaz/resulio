import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { assessmentAssignments, assessmentOrigins, assessmentQuestions, assessmentVersions, assessments, attempts, versionQuestions } from "../../drizzle/schema";
import { requireDb, type DbOrTx } from "../db";

/**
 * Which bank questions may be shown with their answers outside the exam they came from (personal
 * retakes, self-practice). A question stays blocked while any assessment holding it — in its draft
 * list or in any published version (`version_questions.sourceQuestionId`) — is not closed for
 * everyone. Results released at submission (IMMEDIATE) say nothing about classmates who have not
 * sat the exam yet, so release is never the test. Growth's own personal tests (assessment_origins)
 * are neither protected nor a source.
 */

export interface AssessmentWindow {
  status: "DRAFT" | "PUBLISHED" | "CLOSED";
  endAt: Date | null;
}

/**
 * Closed for everyone: no attempt is in progress, and the assessment was closed by the teacher or
 * its window is over for every active assignment. An assignment without its own end follows the
 * assessment's; a missing end anywhere means the window never closes. A draft or an upcoming exam
 * is never closed.
 */
export function isClosedForEveryone(a: AssessmentWindow, assignmentEnds: readonly (Date | null)[], inProgress: boolean, now: Date): boolean {
  if (inProgress) return false;
  if (a.status === "CLOSED") return true;
  if (a.status !== "PUBLISHED") return false;
  const ends = [a.endAt, ...assignmentEnds.map((end) => end ?? a.endAt)];
  return ends.every((end) => end !== null && end.getTime() <= now.getTime());
}

export interface QuestionLink {
  questionId: string;
  assessmentId: string;
  /** In a published version (students have seen it), not only in the draft list. */
  published: boolean;
}

export interface QuestionExposure {
  /** In at least one assessment that is not closed for everyone. */
  blocked: Set<string>;
  /** Per question: the closed-for-everyone assessments whose published versions held it. */
  closedIn: Map<string, Set<string>>;
}

export function exposureOf(links: readonly QuestionLink[], closed: ReadonlySet<string>): QuestionExposure {
  const blocked = new Set<string>();
  const closedIn = new Map<string, Set<string>>();
  for (const l of links) {
    if (!closed.has(l.assessmentId)) blocked.add(l.questionId);
    else if (l.published) closedIn.set(l.questionId, (closedIn.get(l.questionId) ?? new Set()).add(l.assessmentId));
  }
  return { blocked, closedIn };
}

/** Questions that appeared in an exam closed for everyone and sit in no other open, upcoming or draft one. */
export const closedForEveryoneIds = (exposure: QuestionExposure): Set<string> => new Set([...exposure.closedIn.keys()].filter((id) => !exposure.blocked.has(id)));

const CHUNK = 1000;
const chunks = <T>(list: readonly T[]) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));

/** Five queries whatever the number of questions (more only past 1000 ids per list). */
export async function questionExposure(workspaceId: string, questionIds: readonly string[], now = new Date(), db: DbOrTx = requireDb()): Promise<QuestionExposure> {
  const ids = [...new Set(questionIds)];
  if (!ids.length) return { blocked: new Set(), closedIn: new Map() };
  const notPersonal = and(eq(assessments.providerWorkspaceId, workspaceId), isNull(assessmentOrigins.assessmentId));
  const linkRows = await Promise.all(
    chunks(ids).flatMap((part) => [
      db
        .selectDistinct({ questionId: versionQuestions.sourceQuestionId, assessmentId: assessments.id })
        .from(versionQuestions)
        .innerJoin(assessmentVersions, eq(assessmentVersions.id, versionQuestions.versionId))
        .innerJoin(assessments, eq(assessments.id, assessmentVersions.assessmentId))
        .leftJoin(assessmentOrigins, eq(assessmentOrigins.assessmentId, assessments.id))
        .where(and(notPersonal, isNotNull(versionQuestions.sourceQuestionId), inArray(versionQuestions.sourceQuestionId, part)))
        .then((rows) => rows.map((r) => ({ questionId: r.questionId!, assessmentId: r.assessmentId, published: true }))),
      db
        .selectDistinct({ questionId: assessmentQuestions.questionId, assessmentId: assessments.id })
        .from(assessmentQuestions)
        .innerJoin(assessments, eq(assessments.id, assessmentQuestions.assessmentId))
        .leftJoin(assessmentOrigins, eq(assessmentOrigins.assessmentId, assessments.id))
        .where(and(notPersonal, inArray(assessmentQuestions.questionId, part)))
        .then((rows) => rows.map((r) => ({ ...r, published: false }))),
    ]),
  );
  const links: QuestionLink[] = linkRows.flat();
  const assessmentIds = [...new Set(links.map((l) => l.assessmentId))];
  if (!assessmentIds.length) return { blocked: new Set(), closedIn: new Map() };
  const [windows, assignments, running] = await Promise.all([
    Promise.all(chunks(assessmentIds).map((part) => db.select({ id: assessments.id, status: assessments.status, endAt: assessments.endAt }).from(assessments).where(inArray(assessments.id, part)))),
    Promise.all(
      chunks(assessmentIds).map((part) =>
        db
          .select({ assessmentId: assessmentAssignments.assessmentId, availableUntil: assessmentAssignments.availableUntil })
          .from(assessmentAssignments)
          .where(and(inArray(assessmentAssignments.assessmentId, part), eq(assessmentAssignments.status, "ACTIVE"))),
      ),
    ),
    Promise.all(
      chunks(assessmentIds).map((part) =>
        db.selectDistinct({ assessmentId: attempts.assessmentId }).from(attempts).where(and(inArray(attempts.assessmentId, part), eq(attempts.status, "IN_PROGRESS"))),
      ),
    ),
  ]);
  const endsOf = new Map<string, (Date | null)[]>();
  for (const a of assignments.flat()) endsOf.set(a.assessmentId, [...(endsOf.get(a.assessmentId) ?? []), a.availableUntil]);
  const inProgress = new Set(running.flat().map((r) => r.assessmentId));
  const closed = new Set(windows.flat().filter((w) => isClosedForEveryone(w, endsOf.get(w.id) ?? [], inProgress.has(w.id), now)).map((w) => w.id));
  return exposureOf(links, closed);
}

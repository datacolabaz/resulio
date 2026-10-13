import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { assessmentAssignments, assessmentQuestions, assessments as assessmentsTable } from "../../drizzle/schema";
import { TEXT_KEY_PREFIX } from "../../shared/growth";
import { resetRateLimits } from "../_core/rateLimit";
import { retakeCandidates, topicCandidates } from "../growth/actions";
import { closedForEveryoneIds, questionExposure } from "../growth/eligibility";
import { assignedAssessmentIds, practisable } from "../growth/practice";
import { topicNameKey } from "../growth/topics";
import * as assessments from "../modules/assessments";
import * as sessions from "../modules/attempts";
import { db, makeGroup, makeTeacher, makeUser, mcQuestion, publishedAssessment, questionIdsOf } from "./fixtures";

/**
 * Personal retakes and self-practice show correct answers, so they must never reuse a question of an
 * exam some student can still sit — even when results are released at submission (IMMEDIATE).
 */

beforeEach(() => resetRateLimits());

const HOUR = 3_600_000;
const TOPIC = `${TEXT_KEY_PREFIX}${topicNameKey("Test")}`;

async function setup() {
  const teacher = await makeTeacher("Müəllim");
  const student = await makeUser("Tələbə");
  const classmate = await makeUser("Sinif yoldaşı");
  const group = await makeGroup(teacher.scope, [student, classmate]);
  const exam = await publishedAssessment(teacher.scope, { groupIds: [group.id], settings: { releaseMode: "IMMEDIATE", showCorrectAnswers: true, attemptsAllowed: 1 } });
  await setEnd(exam.id, new Date(Date.now() + 2 * HOUR));
  const bankIds = (await db().select({ id: assessmentQuestions.questionId }).from(assessmentQuestions).where(eq(assessmentQuestions.assessmentId, exam.id))).map((r) => r.id);
  return { teacher, student, classmate, group, exam, bankIds };
}

const setEnd = (assessmentId: string, endAt: Date | null) => db().update(assessmentsTable).set({ endAt }).where(eq(assessmentsTable.id, assessmentId));

async function sit(assessmentId: string, studentId: number) {
  const { attemptId } = await sessions.startAttempt(assessmentId, studentId);
  return attemptId;
}

async function finish(attemptId: string, studentId: number) {
  const ids = await questionIdsOf(attemptId);
  await sessions.saveAnswers(attemptId, studentId, ids.map((questionId) => ({ questionId, answer: "b", revision: 1 })));
  await sessions.submitAttempt(attemptId, studentId);
}

async function practicePool(s: Awaited<ReturnType<typeof setup>>) {
  const [{ candidates, exposure }, assigned] = await Promise.all([topicCandidates(s.teacher.workspaceId, s.student.id, [TOPIC]), assignedAssessmentIds(s.teacher.workspaceId, s.student.id, [s.group.id])]);
  return practisable(candidates, exposure, assigned).map((c) => c.id).sort();
}

const retakeIds = async (s: Awaited<ReturnType<typeof setup>>) => (await retakeCandidates(s.teacher.workspaceId, s.student.id, [TOPIC])).map((c) => c.id).sort();

describe("personal tests never reuse questions of an exam that is still open", () => {
  it("an exam the student finished (result released at once) stays out while classmates can still sit it", async () => {
    const s = await setup();
    await finish(await sit(s.exam.id, s.student.id), s.student.id);

    expect(await practicePool(s)).toEqual([]);
    expect(await retakeIds(s)).toEqual([]);
    const exposure = await questionExposure(s.teacher.workspaceId, s.bankIds);
    expect([...exposure.blocked].sort()).toEqual([...s.bankIds].sort());
  });

  it("once the window is over for everyone the questions become available", async () => {
    const s = await setup();
    await finish(await sit(s.exam.id, s.student.id), s.student.id);
    await setEnd(s.exam.id, new Date(Date.now() - HOUR));

    expect(await practicePool(s)).toEqual([...s.bankIds].sort());
    expect(await retakeIds(s)).toEqual([...s.bankIds].sort());
  });

  it("an attempt still in progress keeps them out after the window passed", async () => {
    const s = await setup();
    await sit(s.exam.id, s.classmate.id);
    await setEnd(s.exam.id, new Date(Date.now() - HOUR));

    expect(await practicePool(s)).toEqual([]);
    expect(await retakeIds(s)).toEqual([]);
  });

  it("one student's later availableUntil keeps the exam open for everyone", async () => {
    const s = await setup();
    await assessments.setTargets(s.teacher.scope, s.exam.id, { groupIds: [s.group.id], studentIds: [s.classmate.id] });
    await setEnd(s.exam.id, new Date(Date.now() - HOUR));
    await db()
      .update(assessmentAssignments)
      .set({ availableUntil: new Date(Date.now() + 24 * HOUR) })
      .where(and(eq(assessmentAssignments.assessmentId, s.exam.id), eq(assessmentAssignments.studentId, s.classmate.id)));

    expect(await practicePool(s)).toEqual([]);
    expect(await retakeIds(s)).toEqual([]);
  });

  it("drafts and upcoming exams holding a question block it", async () => {
    const s = await setup();
    await setEnd(s.exam.id, new Date(Date.now() - HOUR));
    const [inDraft, inUpcoming, free] = s.bankIds;

    const draft = await assessments.createAssessment(s.teacher.scope, { type: "EXAM", settings: { title: "Qaralama" } });
    await assessments.addQuestionsToAssessment(s.teacher.scope, draft.id, [inDraft]);
    const upcoming = await assessments.createAssessment(s.teacher.scope, { type: "EXAM", settings: { title: "Gələcək" } });
    await assessments.addQuestionsToAssessment(s.teacher.scope, upcoming.id, [inUpcoming]);
    await assessments.setTargets(s.teacher.scope, upcoming.id, { groupIds: [s.group.id], studentIds: [] });
    await assessments.publish(s.teacher.scope, upcoming.id);
    await db()
      .update(assessmentsTable)
      .set({ startAt: new Date(Date.now() + 24 * HOUR), endAt: new Date(Date.now() + 26 * HOUR) })
      .where(eq(assessmentsTable.id, upcoming.id));

    expect(await practicePool(s)).toEqual([free]);
    expect(await retakeIds(s)).toEqual([free]);
  });

  it("a question removed from an open exam's draft is still blocked by the published version that holds it", async () => {
    const s = await setup();
    const [removed] = s.bankIds;
    await assessments.removeQuestionFromAssessment(s.teacher.scope, s.exam.id, removed);

    const exposure = await questionExposure(s.teacher.workspaceId, [removed]);
    expect(exposure.blocked.has(removed)).toBe(true);
    expect(await retakeIds(s)).not.toContain(removed);

    await setEnd(s.exam.id, new Date(Date.now() - HOUR));
    const later = await questionExposure(s.teacher.workspaceId, [removed]);
    expect(closedForEveryoneIds(later).has(removed)).toBe(true);
  });

  it("a retake may still use a bank question no exam has used; self-practice may not", async () => {
    const s = await setup();
    await setEnd(s.exam.id, new Date(Date.now() - HOUR));
    const unused = await assessments.createQuestion(s.teacher.scope, mcQuestion("Heç istifadə olunmayıb"));

    expect(await retakeIds(s)).toContain(unused.id);
    expect(await practicePool(s)).not.toContain(unused.id);
  });
});

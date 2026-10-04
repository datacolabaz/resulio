import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { assessmentAssignments, attempts, syllabusAssessmentAssignments, syllabusEnrollments } from "../../drizzle/schema";
import { resetRateLimits } from "../_core/rateLimit";
import * as assessments from "../modules/assessments";
import * as sessions from "../modules/attempts";
import * as access from "../syllabus/access";
import * as authoring from "../syllabus/authoring";
import { setWorkspaceEnabled } from "../syllabus/availability";
import * as learning from "../syllabus/learning";
import * as progression from "../syllabus/progression";
import * as publishing from "../syllabus/publishing";
import { db, makeGroup, makeTeacher, makeUser, mcQuestion, outcome, publishedAssessment, questionIdsOf } from "./fixtures";

/**
 * Syllabus assessments end to end on the real exam engine: the per-student assignment, the pinned
 * version, and the separation from the teacher's normal exam lists.
 */

beforeEach(() => resetRateLimits());

async function setup() {
  const teacher = await makeTeacher("Müəllim");
  const student = await makeUser("Tələbə");
  const classmate = await makeUser("Sinif yoldaşı");
  const group = await makeGroup(teacher.scope, [student, classmate]);
  await setWorkspaceEnabled(teacher.workspaceId, true, teacher.user.id);
  const exam = await publishedAssessment(teacher.scope, { settings: { attemptsAllowed: 1, durationSeconds: 600 } });
  const syllabus = await authoring.createSyllabus(teacher.scope, { title: "Java" });
  const mod = await authoring.createModule(teacher.scope, syllabus.id, { title: "Əsaslar" });
  const lesson = await authoring.createLesson(teacher.scope, mod.id, { title: "Dərs 1" });
  const item = await authoring.createItem(
    teacher.scope,
    syllabus.id,
    { scope: "LESSON", lessonId: lesson.id },
    { kind: "ASSESSMENT", title: "Test", assessmentId: exam.id, content: { maxAttempts: 3, cooldownMinutes: 0 } },
  );
  await publishing.publish(teacher.scope, syllabus.id, { label: "v1" });
  await access.grantAccess(teacher.scope, syllabus.id, { groupIds: [group.id], studentIds: [], startsAt: null, endsAt: null });
  return { teacher, student, classmate, group, exam, syllabus, lesson, item };
}

const enrollmentOf = async (syllabusId: string, studentId: number) =>
  (await db().select().from(syllabusEnrollments).where(and(eq(syllabusEnrollments.syllabusId, syllabusId), eq(syllabusEnrollments.studentId, studentId))))[0];

async function finish(attemptId: string, studentId: number, answer = "a") {
  const ids = await questionIdsOf(attemptId);
  await sessions.saveAnswers(attemptId, studentId, ids.map((questionId) => ({ questionId, answer, revision: 1 })));
  await sessions.submitAttempt(attemptId, studentId);
}

describe("syllabus assessment on the exam engine", () => {
  it("starts on the per-student assignment and the version pinned at syllabus publish", async () => {
    const s = await setup();
    await learning.learningPath(s.student.id, s.syllabus.id);
    const started = await learning.startAssessment(s.student.id, s.syllabus.id, s.item.id);
    const [attempt] = await db().select().from(attempts).where(eq(attempts.id, started.attemptId));
    const [link] = await db().select().from(syllabusAssessmentAssignments).where(eq(syllabusAssessmentAssignments.itemId, s.item.id));
    expect(attempt.assignmentId).toBe(link.assignmentId);
    expect(attempt.versionId).toBe(s.exam.currentVersionId);
  });

  it("a republished exam (even with 'move assignments') does not change the pinned syllabus version", async () => {
    const s = await setup();
    await learning.learningPath(s.student.id, s.syllabus.id);
    const first = await learning.startAssessment(s.student.id, s.syllabus.id, s.item.id);
    await finish(first.attemptId, s.student.id, "b");

    await assessments.createQuestionInAssessment(s.teacher.scope, s.exam.id, mcQuestion("Yeni sual"));
    const republished = await assessments.publish(s.teacher.scope, s.exam.id, { moveAssignments: true });
    expect(republished.versionId).not.toBe(s.exam.currentVersionId);

    const enrollment = await enrollmentOf(s.syllabus.id, s.student.id);
    await progression.recompute(enrollment.id);
    const [link] = await db().select().from(syllabusAssessmentAssignments).where(eq(syllabusAssessmentAssignments.itemId, s.item.id));
    const [jit] = await db().select().from(assessmentAssignments).where(eq(assessmentAssignments.id, link.assignmentId));
    expect(jit.assessmentVersionId).toBe(s.exam.currentVersionId);

    const second = await learning.startAssessment(s.student.id, s.syllabus.id, s.item.id);
    const [attempt] = await db().select().from(attempts).where(eq(attempts.id, second.attemptId));
    expect(attempt.versionId).toBe(s.exam.currentVersionId);
  });

  it("syllabus attempts follow the syllabus retry limit, not the exam's own limit of 1", async () => {
    const s = await setup();
    await learning.learningPath(s.student.id, s.syllabus.id);
    const first = await learning.startAssessment(s.student.id, s.syllabus.id, s.item.id);
    await finish(first.attemptId, s.student.id, "b");
    await progression.recompute((await enrollmentOf(s.syllabus.id, s.student.id)).id);
    const second = await learning.startAssessment(s.student.id, s.syllabus.id, s.item.id);
    expect(second.attemptId).not.toBe(first.attemptId);
  });

  it("is hidden from the general exam list and cannot be started outside the lesson", async () => {
    const s = await setup();
    await learning.learningPath(s.student.id, s.syllabus.id);
    expect((await sessions.studentAssessments(s.student.id)).map((a) => a.id)).not.toContain(s.exam.id);
    expect(await outcome(sessions.startAttempt(s.exam.id, s.student.id))).toBe("THROWN:NO_ACCESS");
  });

  it("does not hide or replace the teacher's normal group assignment of the same exam", async () => {
    const s = await setup();
    await assessments.setTargets(s.teacher.scope, s.exam.id, { groupIds: [s.group.id], studentIds: [] });
    await learning.learningPath(s.student.id, s.syllabus.id);
    expect((await sessions.studentAssessments(s.student.id)).map((a) => a.id)).toContain(s.exam.id);
    const general = await sessions.startAttempt(s.exam.id, s.student.id);
    const [attempt] = await db().select().from(attempts).where(eq(attempts.id, general.attemptId));
    const [link] = await db().select().from(syllabusAssessmentAssignments).where(eq(syllabusAssessmentAssignments.itemId, s.item.id));
    expect(attempt.assignmentId).not.toBe(link.assignmentId);
    expect((await assessments.getTargets(s.exam.id)).studentIds).toEqual([]);
  });

  it("another student's syllabus assignment is never usable", async () => {
    const s = await setup();
    await learning.learningPath(s.student.id, s.syllabus.id);
    const [link] = await db().select().from(syllabusAssessmentAssignments).where(eq(syllabusAssessmentAssignments.itemId, s.item.id));
    expect(await outcome(sessions.startAttempt(s.exam.id, s.classmate.id, link.assignmentId))).toBe("THROWN:NO_ACCESS");
  });
});

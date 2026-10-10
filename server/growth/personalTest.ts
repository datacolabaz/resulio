import { requireDb } from "../db";
import { assessmentOrigins } from "../../drizzle/schema";
import type { EvidenceOrigin } from "../../shared/growth";
import type { TeacherScope } from "../modules/access";
import { addQuestionsToAssessment, createAssessment, publish, setTargets, updateSchedule } from "../modules/assessments";

const DAY_MS = 86_400_000;

/**
 * A one-student test through the regular exam pipeline (create, add bank questions, schedule,
 * publish, target). The assessment_origins row is written before anything else, so the test never
 * shows up in the teacher's exam list, even for a moment.
 */
export async function createPersonalTest(
  scope: TeacherScope,
  input: { studentId: number; origin: Exclude<EvidenceOrigin, "EXAM">; topicKeys: string[]; questionIds: string[]; title: string; days: number; sourceRef: string; createdBy: number },
) {
  const now = new Date();
  const a = await createAssessment(scope, {
    type: "EXAM",
    settings: { title: input.title.slice(0, 255), durationSeconds: Math.max(600, input.questionIds.length * 120), attemptsAllowed: 1, showCorrectAnswers: true, showExplanations: true },
  });
  await requireDb().insert(assessmentOrigins).values({
    assessmentId: a.id,
    workspaceId: scope.workspaceId,
    studentId: input.studentId,
    origin: input.origin,
    topicKeys: input.topicKeys,
    sourceRef: input.sourceRef.slice(0, 64),
    createdBy: input.createdBy,
  });
  await addQuestionsToAssessment(scope, a.id, input.questionIds);
  await updateSchedule(scope, a.id, { startAt: now, endAt: new Date(now.getTime() + input.days * DAY_MS), timezone: "Asia/Baku" });
  await publish(scope, a.id);
  await setTargets(scope, a.id, { groupIds: [], studentIds: [input.studentId] });
  return a.id;
}

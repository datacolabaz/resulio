import { and, desc, eq, gt, inArray, isNotNull, ne, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  assessmentOrigins,
  assessmentQuestions,
  assessments,
  questionMeta,
  questions,
  resultItems,
  riskActions,
  riskHistory,
  teacherStudentNotes,
  users,
  versionQuestions,
} from "../../drizzle/schema";
import { isSectionKey, isTextKey, sectionIdOfKey, TEXT_KEY_PREFIX, type RiskActionType } from "../../shared/growth";
import { requireDb } from "../db";
import { materialOf, updateMaterial } from "../materials/service";
import type { TeacherScope } from "../modules/access";
import { addQuestionsToAssessment, createAssessment, publish, setTargets, updateSchedule } from "../modules/assessments";
import { AppError } from "../modules/errors";
import { assertTeacherHasStudent, teacherStudents } from "../modules/groups";
import { dayKey } from "../modules/motivation";
import { dispatch } from "../notifications/dispatcher";
import { isDismissed } from "./risk";
import { dismissRisk, growthSettingsOf, risksOf } from "./riskStore";
import { pickRetakeQuestions, RETAKE_MIN, type RetakeCandidate } from "./retake";
import { studentResults } from "./store";
import { topicNameKey } from "./topics";
import { studentMastery } from "./weakness";

/** Risk Radar: the teacher's list and detail, and what they can do about a student. */

const DAY_MS = 86_400_000;
const RETAKE_DAYS = 7;
const DISMISS_DAYS = 14;

export async function logAction(scope: TeacherScope, studentId: number, type: RiskActionType, refId: string | null = null) {
  await requireDb().insert(riskActions).values({ id: nanoid(), workspaceId: scope.workspaceId, studentId, type, refId, createdBy: scope.userId });
}

export async function riskList(scope: TeacherScope, groupId: string | null) {
  const settings = await growthSettingsOf(scope.workspaceId);
  if (!settings.riskEnabled) return { enabled: false, rows: [], dismissed: 0 };
  const students = new Map(
    (await teacherStudents(scope)).filter((s) => !groupId || s.groupIds.includes(groupId)).map((s) => [s.id, { name: s.name ?? "", groups: s.groups }]),
  );
  const now = new Date();
  const risks = (await risksOf(scope.workspaceId, [...students.keys()])).filter((r) => r.level !== "NONE");
  const visible = risks.filter((r) => !isDismissed(r, now));
  return {
    enabled: true,
    dismissed: risks.length - visible.length,
    rows: visible
      .map((r) => ({ ...r, name: students.get(r.studentId)?.name ?? "", groups: students.get(r.studentId)?.groups ?? [] }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
  };
}

export async function riskDetail(scope: TeacherScope, studentId: number) {
  await assertTeacherHasStudent(scope, studentId);
  const db = requireDb();
  const since = dayKey(new Date(Date.now() - 30 * DAY_MS));
  const [[risk], history, notes, actions, settings] = await Promise.all([
    risksOf(scope.workspaceId, [studentId], db),
    db
      .select({ dayKey: riskHistory.dayKey, score: riskHistory.score, level: riskHistory.level })
      .from(riskHistory)
      .where(and(eq(riskHistory.workspaceId, scope.workspaceId), eq(riskHistory.studentId, studentId), gt(riskHistory.dayKey, since)))
      .orderBy(riskHistory.dayKey),
    db
      .select({ id: teacherStudentNotes.id, body: teacherStudentNotes.body, createdAt: teacherStudentNotes.createdAt, author: users.name })
      .from(teacherStudentNotes)
      .leftJoin(users, eq(users.id, teacherStudentNotes.createdBy))
      .where(and(eq(teacherStudentNotes.workspaceId, scope.workspaceId), eq(teacherStudentNotes.studentId, studentId)))
      .orderBy(desc(teacherStudentNotes.createdAt))
      .limit(50),
    db
      .select({ id: riskActions.id, type: riskActions.type, refId: riskActions.refId, createdAt: riskActions.createdAt })
      .from(riskActions)
      .where(and(eq(riskActions.workspaceId, scope.workspaceId), eq(riskActions.studentId, studentId)))
      .orderBy(desc(riskActions.createdAt))
      .limit(20),
    growthSettingsOf(scope.workspaceId, db),
  ]);
  return { risk: risk ?? null, dismissed: risk ? isDismissed(risk) : false, history, notes, actions, parentReports: settings.parentReports };
}

export async function dismiss(scope: TeacherScope, studentId: number) {
  await assertTeacherHasStudent(scope, studentId);
  await dismissRisk(scope.workspaceId, studentId, DISMISS_DAYS);
  await logAction(scope, studentId, "DISMISS");
}

export async function addNote(scope: TeacherScope, studentId: number, body: string) {
  await assertTeacherHasStudent(scope, studentId);
  const id = nanoid();
  await requireDb().insert(teacherStudentNotes).values({ id, workspaceId: scope.workspaceId, studentId, body, createdBy: scope.userId });
  await logAction(scope, studentId, "NOTE", id);
  return { id };
}

export async function deleteNote(scope: TeacherScope, noteId: string) {
  await requireDb().delete(teacherStudentNotes).where(and(eq(teacherStudentNotes.id, noteId), eq(teacherStudentNotes.workspaceId, scope.workspaceId)));
}

export async function shareMaterial(scope: TeacherScope, studentId: number, materialId: string) {
  await assertTeacherHasStudent(scope, studentId);
  const material = await materialOf(scope, materialId);
  const studentIds = material.studentIds ?? [];
  if (!studentIds.includes(studentId)) await updateMaterial(scope, materialId, { studentIds: [...studentIds, studentId] });
  await logAction(scope, studentId, "MATERIAL", materialId);
}

/**
 * Bank questions on the chosen topics that may go into a retake: never one sitting in a draft or a
 * not-yet-started exam (that would leak it), never a long answer (it needs manual grading).
 */
export async function retakeCandidates(workspaceId: string, studentId: number, topicKeys: string[]): Promise<RetakeCandidate[]> {
  const db = requireDb();
  const sectionIds = topicKeys.filter(isSectionKey).map((k) => sectionIdOfKey(k)!);
  const textKeys = new Set(topicKeys.filter(isTextKey).map((k) => k.slice(TEXT_KEY_PREFIX.length)));
  const rows: { id: string; type: string; difficulty: RetakeCandidate["difficulty"]; topicKey: string }[] = [];
  if (sectionIds.length) {
    const found = await db
      .select({ id: questions.id, type: questions.type, difficulty: questions.difficulty, sectionId: questionMeta.sectionId })
      .from(questions)
      .innerJoin(questionMeta, eq(questionMeta.questionId, questions.id))
      .where(and(eq(questions.providerWorkspaceId, workspaceId), inArray(questionMeta.sectionId, sectionIds)));
    for (const q of found) rows.push({ id: q.id, type: q.type, difficulty: q.difficulty, topicKey: `qt:${q.sectionId}` });
  }
  if (textKeys.size) {
    const found = await db
      .select({ id: questions.id, type: questions.type, difficulty: questions.difficulty, topic: questions.topic })
      .from(questions)
      .where(and(eq(questions.providerWorkspaceId, workspaceId), ne(questions.topic, "")))
      .limit(5000);
    for (const q of found) {
      const key = topicNameKey(q.topic);
      if (textKeys.has(key)) rows.push({ id: q.id, type: q.type, difficulty: q.difficulty, topicKey: `${TEXT_KEY_PREFIX}${key}` });
    }
  }
  const usable = rows.filter((r) => r.type !== "LONG_ANSWER");
  if (!usable.length) return [];
  const now = new Date();
  const upcoming = await db
    .selectDistinct({ questionId: assessmentQuestions.questionId })
    .from(assessmentQuestions)
    .innerJoin(assessments, eq(assessments.id, assessmentQuestions.assessmentId))
    .where(
      and(
        eq(assessments.providerWorkspaceId, workspaceId),
        inArray(assessmentQuestions.questionId, usable.map((r) => r.id)),
        or(eq(assessments.status, "DRAFT"), and(eq(assessments.status, "PUBLISHED"), gt(assessments.startAt, now))),
      ),
    );
  const blocked = new Set(upcoming.map((u) => u.questionId));
  const resultIds = (await studentResults(workspaceId, studentId, db)).map((r) => r.id);
  const seenRows = resultIds.length
    ? await db
        .selectDistinct({ questionId: versionQuestions.sourceQuestionId })
        .from(resultItems)
        .innerJoin(versionQuestions, eq(versionQuestions.id, resultItems.versionQuestionId))
        .where(and(inArray(resultItems.resultId, resultIds), isNotNull(versionQuestions.sourceQuestionId)))
    : [];
  const seen = new Set(seenRows.map((s) => s.questionId));
  return usable.filter((r) => !blocked.has(r.id)).map((r) => ({ id: r.id, topicKey: r.topicKey, difficulty: r.difficulty, seen: seen.has(r.id) }));
}

export async function retakePreview(scope: TeacherScope, studentId: number, topicKeys: string[]) {
  await assertTeacherHasStudent(scope, studentId);
  const candidates = await retakeCandidates(scope.workspaceId, studentId, topicKeys);
  return { available: candidates.length, unseen: candidates.filter((c) => !c.seen).length };
}

/** A personal retake through the regular exam pipeline, marked RETAKE so it stays out of the teacher's list. */
export async function createRetake(scope: TeacherScope, input: { studentId: number; topicKeys: string[]; count: number }) {
  await assertTeacherHasStudent(scope, input.studentId);
  const db = requireDb();
  const { ids, reusedSeen } = pickRetakeQuestions(await retakeCandidates(scope.workspaceId, input.studentId, input.topicKeys), input.count);
  if (ids.length < RETAKE_MIN) throw new AppError("GROWTH_NOT_ENOUGH_QUESTIONS");
  const labels = (await studentMastery(scope.workspaceId, [input.studentId], db)).filter((m) => input.topicKeys.includes(m.topicKey)).map((m) => m.label);
  const title = `Fərdi təkrar: ${labels.join(", ") || "mövzular"}`.slice(0, 255);
  const now = new Date();
  const a = await createAssessment(scope, {
    type: "EXAM",
    settings: { title, durationSeconds: Math.max(600, ids.length * 120), attemptsAllowed: 1, showCorrectAnswers: true, showExplanations: true },
  });
  await db.insert(assessmentOrigins).values({
    assessmentId: a.id,
    workspaceId: scope.workspaceId,
    studentId: input.studentId,
    origin: "RETAKE",
    topicKeys: input.topicKeys,
    sourceRef: "risk",
    createdBy: scope.userId,
  });
  await addQuestionsToAssessment(scope, a.id, ids);
  await updateSchedule(scope, a.id, { startAt: now, endAt: new Date(now.getTime() + RETAKE_DAYS * DAY_MS), timezone: "Asia/Baku" });
  await publish(scope, a.id);
  await setTargets(scope, a.id, { groupIds: [], studentIds: [input.studentId] });
  await logAction(scope, input.studentId, "RETAKE", a.id);
  const [teacher] = await db.select({ name: users.name }).from(users).where(eq(users.id, scope.userId)).limit(1);
  dispatch({
    event: "RETAKE_ASSIGNED",
    userId: input.studentId,
    dedupeKey: `growth-retake:${a.id}`,
    data: { assessmentId: a.id, topics: labels.slice(0, 5), from: teacher?.name ?? "" },
  });
  return { assessmentId: a.id, questionCount: ids.length, reusedSeen };
}

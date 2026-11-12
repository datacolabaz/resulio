import { and, desc, eq, gt, inArray, isNotNull, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  growthDirty,
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
import { AppError } from "../modules/errors";
import { assertTeacherHasStudent, teacherStudents } from "../modules/groups";
import { dayKey } from "../modules/motivation";
import { dispatch } from "../notifications/dispatcher";
import { questionExposure, type QuestionExposure } from "./eligibility";
import { isDismissed } from "./risk";
import { dismissRisk, growthSettingsOf, risksOf } from "./riskStore";
import { createPersonalTest } from "./personalTest";
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

/**
 * Why the "no risk shown" list can be empty, for students whose level isn't WATCH/MEDIUM/HIGH -- the
 * teacher sees an identical empty row either way otherwise, which reads as "nothing to see" even when
 * nothing has been computed yet. Read-only classification over what's already stored; does not touch
 * risk.ts's scoring, weights or the SCORE_DROP eligibility rule.
 *   - NOT_YET_COMPUTED: no student_risk row at all (new student, or the flag/backfill hasn't reached them).
 *   - COMPUTATION_ERROR: queued in growth_dirty with reason "retry" -- the last recompute attempt threw.
 *   - INSUFFICIENT_DATA: a row exists, level is NONE, and none of the four signals had enough evidence
 *     to register any points (an approximation: a few real "all clear" students can legitimately have
 *     zero reasons too, so this reads as "likely too little data" rather than a guarantee).
 *   - NO_RISK: a row exists, level is NONE, and at least one signal was actually measured.
 */
export type NoRiskReason = "NOT_YET_COMPUTED" | "COMPUTATION_ERROR" | "INSUFFICIENT_DATA" | "NO_RISK";

export async function riskList(scope: TeacherScope, groupId: string | null) {
  const settings = await growthSettingsOf(scope.workspaceId);
  if (!settings.riskEnabled) return { enabled: false, rows: [], dismissed: 0, noRisk: {} as Record<NoRiskReason, number> };
  const students = new Map(
    (await teacherStudents(scope)).filter((s) => !groupId || s.groupIds.includes(groupId)).map((s) => [s.id, { name: s.name ?? "", groups: s.groups }]),
  );
  const now = new Date();
  const allRisks = await risksOf(scope.workspaceId, [...students.keys()]);
  const risksByStudent = new Map(allRisks.map((r) => [r.studentId, r]));
  const retrying = new Set(
    (await requireDb().select({ studentId: growthDirty.studentId }).from(growthDirty).where(and(eq(growthDirty.workspaceId, scope.workspaceId), eq(growthDirty.reason, "retry"))))
      .map((r) => r.studentId),
  );
  const noRisk: Record<NoRiskReason, number> = { NOT_YET_COMPUTED: 0, COMPUTATION_ERROR: 0, INSUFFICIENT_DATA: 0, NO_RISK: 0 };
  for (const studentId of students.keys()) {
    const r = risksByStudent.get(studentId);
    if (r && r.level !== "NONE") continue; // shown as an active risk row below, not part of the "no risk" breakdown
    const reason: NoRiskReason = retrying.has(studentId) ? "COMPUTATION_ERROR" : !r ? "NOT_YET_COMPUTED" : r.reasons.length === 0 ? "INSUFFICIENT_DATA" : "NO_RISK";
    noRisk[reason]++;
  }
  const risks = allRisks.filter((r) => r.level !== "NONE");
  const visible = risks.filter((r) => !isDismissed(r, now));
  return {
    enabled: true,
    dismissed: risks.length - visible.length,
    noRisk,
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
 * Bank questions on the chosen topics that may go into a retake: never one held by an assessment
 * that is not closed for everyone — a draft, an upcoming or running exam, or one with an attempt in
 * progress (a retake shows its answers, so that would leak it) — and never a long answer (it needs
 * manual grading).
 */
export async function retakeCandidates(workspaceId: string, studentId: number, topicKeys: string[]): Promise<RetakeCandidate[]> {
  const { candidates, exposure } = await topicCandidates(workspaceId, studentId, topicKeys);
  return candidates.filter((c) => !exposure.blocked.has(c.id));
}

/** Every usable bank question on the topics, with where each one has been used (see eligibility.ts). */
export async function topicCandidates(workspaceId: string, studentId: number, topicKeys: string[], now = new Date()): Promise<{ candidates: RetakeCandidate[]; exposure: QuestionExposure }> {
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
  if (!usable.length) return { candidates: [], exposure: { blocked: new Set(), closedIn: new Map() } };
  const exposure = await questionExposure(workspaceId, usable.map((r) => r.id), now, db);
  const resultIds = (await studentResults(workspaceId, studentId, db)).map((r) => r.id);
  const seenRows = resultIds.length
    ? await db
        .selectDistinct({ questionId: versionQuestions.sourceQuestionId })
        .from(resultItems)
        .innerJoin(versionQuestions, eq(versionQuestions.id, resultItems.versionQuestionId))
        .where(and(inArray(resultItems.resultId, resultIds), isNotNull(versionQuestions.sourceQuestionId)))
    : [];
  const seen = new Set(seenRows.map((s) => s.questionId));
  return { candidates: usable.map((r) => ({ id: r.id, topicKey: r.topicKey, difficulty: r.difficulty, seen: seen.has(r.id) })), exposure };
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
  const assessmentId = await createPersonalTest(scope, {
    studentId: input.studentId,
    origin: "RETAKE",
    topicKeys: input.topicKeys,
    questionIds: ids,
    title: `Fərdi təkrar: ${labels.join(", ") || "mövzular"}`,
    days: RETAKE_DAYS,
    sourceRef: "risk",
    createdBy: scope.userId,
  });
  const a = { id: assessmentId };
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

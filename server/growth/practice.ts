import { and, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { assessmentAssignments, assessmentOrigins, assessments, groupGrowthSettings, groups, providerWorkspaces } from "../../drizzle/schema";
import { requireDb } from "../db";
import type { TeacherScope } from "../modules/access";
import { AppError } from "../modules/errors";
import { assertGroupOwner } from "../modules/groups";
import { dayKey } from "../modules/motivation";
import { studentGroupWorkspace, studentGrowthGroups } from "./availability";
import { topicCandidates } from "./actions";
import { closedForEveryoneIds, type QuestionExposure } from "./eligibility";
import { createPersonalTest } from "./personalTest";
import { pickRetakeQuestions, RETAKE_MIN, type RetakeCandidate } from "./retake";
import { releasedMastery } from "./studentView";

/**
 * Self-practice: a student starts a short test on one topic. Off per group until the teacher turns
 * it on, and it only reuses questions of exams assigned to that group or student that are closed
 * for everyone — never an upcoming or running exam, even one the student has already taken.
 */

export const PRACTICE_QUESTIONS = 10;
export const PRACTICE_PER_DAY = 3;
const PRACTICE_DAYS = 2;

export async function groupPracticeSettings(scope: TeacherScope) {
  const db = requireDb();
  const list = await db.select({ id: groups.id, name: groups.name }).from(groups).where(eq(groups.providerWorkspaceId, scope.workspaceId));
  const on = list.length ? await db.select().from(groupGrowthSettings).where(inArray(groupGrowthSettings.groupId, list.map((g) => g.id))) : [];
  const enabled = new Set(on.filter((r) => r.selfPractice).map((r) => r.groupId));
  return list.map((g) => ({ ...g, selfPractice: enabled.has(g.id) }));
}

export async function setGroupPractice(scope: TeacherScope, groupId: string, enabled: boolean) {
  await assertGroupOwner(scope, groupId);
  await requireDb()
    .insert(groupGrowthSettings)
    .values({ groupId, selfPractice: enabled, updatedBy: scope.userId })
    .onDuplicateKeyUpdate({ set: { selfPractice: enabled, updatedBy: scope.userId } });
}

/** The student's groups in the workspace that allow self-practice. */
export async function practiceGroups(userId: number, workspaceId: string): Promise<string[]> {
  const mine = (await studentGrowthGroups(userId)).filter((g) => g.workspaceId === workspaceId).map((g) => g.groupId);
  if (!mine.length) return [];
  const rows = await requireDb()
    .select({ groupId: groupGrowthSettings.groupId })
    .from(groupGrowthSettings)
    .where(and(inArray(groupGrowthSettings.groupId, mine), eq(groupGrowthSettings.selfPractice, true)));
  return rows.map((r) => r.groupId);
}

/** Exams (not personal tests) assigned to these groups or to the student. */
export async function assignedAssessmentIds(workspaceId: string, studentId: number, groupIds: string[]): Promise<Set<string>> {
  const target = groupIds.length ? or(eq(assessmentAssignments.studentId, studentId), inArray(assessmentAssignments.groupId, groupIds)) : eq(assessmentAssignments.studentId, studentId);
  const rows = await requireDb()
    .selectDistinct({ id: assessments.id })
    .from(assessmentAssignments)
    .innerJoin(assessments, eq(assessments.id, assessmentAssignments.assessmentId))
    .leftJoin(assessmentOrigins, eq(assessmentOrigins.assessmentId, assessments.id))
    .where(and(eq(assessments.providerWorkspaceId, workspaceId), eq(assessmentAssignments.status, "ACTIVE"), isNull(assessmentOrigins.assessmentId), target));
  return new Set(rows.map((r) => r.id));
}

/**
 * Candidates a student may practise: from an exam assigned to them that is closed for everyone
 * (having taken it is not enough — classmates may still be sitting it), and in no exam that is
 * still open, upcoming or a draft.
 */
export function practisable(candidates: RetakeCandidate[], exposure: QuestionExposure, assigned: ReadonlySet<string>): RetakeCandidate[] {
  const eligible = closedForEveryoneIds(exposure);
  return candidates.filter((c) => eligible.has(c.id) && [...(exposure.closedIn.get(c.id) ?? [])].some((a) => assigned.has(a)));
}

async function practicesToday(workspaceId: string, studentId: number, now: Date) {
  const start = new Date(`${dayKey(now)}T00:00:00+04:00`);
  const rows = await requireDb()
    .select({ id: assessmentOrigins.assessmentId })
    .from(assessmentOrigins)
    .where(and(eq(assessmentOrigins.workspaceId, workspaceId), eq(assessmentOrigins.studentId, studentId), eq(assessmentOrigins.origin, "PRACTICE"), gte(assessmentOrigins.createdAt, start), lt(assessmentOrigins.createdAt, new Date(start.getTime() + 86_400_000))));
  return rows.length;
}

export async function startPractice(userId: number, input: { groupId: string; topicKey: string }, now = new Date()) {
  const { workspaceId } = await studentGroupWorkspace(userId, input.groupId);
  const allowed = await practiceGroups(userId, workspaceId);
  if (!allowed.length) throw new AppError("GROWTH_PRACTICE_OFF");
  if ((await practicesToday(workspaceId, userId, now)) >= PRACTICE_PER_DAY) throw new AppError("GROWTH_PRACTICE_LIMIT");
  const [{ candidates, exposure }, assigned] = await Promise.all([topicCandidates(workspaceId, userId, [input.topicKey], now), assignedAssessmentIds(workspaceId, userId, allowed)]);
  const { ids } = pickRetakeQuestions(practisable(candidates, exposure, assigned), PRACTICE_QUESTIONS);
  if (ids.length < RETAKE_MIN) throw new AppError("GROWTH_NOT_ENOUGH_QUESTIONS");
  const db = requireDb();
  const [ws] = await db.select({ ownerUserId: providerWorkspaces.ownerUserId }).from(providerWorkspaces).where(eq(providerWorkspaces.id, workspaceId)).limit(1);
  if (!ws) throw new AppError("NOT_FOUND");
  const label = (await releasedMastery(workspaceId, userId)).mastery.find((m) => m.topicKey === input.topicKey)?.label ?? "";
  const assessmentId = await createPersonalTest(
    { workspaceId, userId: ws.ownerUserId },
    { studentId: userId, origin: "PRACTICE", topicKeys: [input.topicKey], questionIds: ids, title: `Məşq: ${label || "mövzu"}`, days: PRACTICE_DAYS, sourceRef: "practice", createdBy: userId },
  );
  return { assessmentId, questionCount: ids.length };
}

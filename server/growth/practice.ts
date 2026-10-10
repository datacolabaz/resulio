import { and, eq, gte, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import {
  assessmentAssignments,
  assessmentOrigins,
  assessmentVersions,
  assessments,
  groupGrowthSettings,
  groups,
  providerWorkspaces,
  results,
  versionQuestions,
} from "../../drizzle/schema";
import { requireDb } from "../db";
import type { TeacherScope } from "../modules/access";
import { AppError } from "../modules/errors";
import { assertGroupOwner } from "../modules/groups";
import { dayKey } from "../modules/motivation";
import { studentGroupWorkspace, studentGrowthGroups } from "./availability";
import { retakeCandidates } from "./actions";
import { createPersonalTest } from "./personalTest";
import { pickRetakeQuestions, RETAKE_MIN } from "./retake";
import { releasedMastery } from "./studentView";

/**
 * Self-practice: a student starts a short test on one topic. Off per group until the teacher turns
 * it on, and it only reuses questions of exams already assigned to that group or student whose
 * window has closed (or that the student already took) — never an upcoming or running exam.
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

/** Bank question ids that appeared in exams already behind the student (assigned to these groups or to them). */
export async function pastExamQuestionIds(workspaceId: string, studentId: number, groupIds: string[], now = new Date()): Promise<Set<string>> {
  const db = requireDb();
  const target = groupIds.length ? or(eq(assessmentAssignments.studentId, studentId), inArray(assessmentAssignments.groupId, groupIds)) : eq(assessmentAssignments.studentId, studentId);
  const assigned = await db
    .select({ id: assessments.id, endAt: assessments.endAt, availableUntil: assessmentAssignments.availableUntil, status: assessments.status })
    .from(assessmentAssignments)
    .innerJoin(assessments, eq(assessments.id, assessmentAssignments.assessmentId))
    .leftJoin(assessmentOrigins, eq(assessmentOrigins.assessmentId, assessments.id))
    .where(and(eq(assessments.providerWorkspaceId, workspaceId), eq(assessmentAssignments.status, "ACTIVE"), isNull(assessmentOrigins.assessmentId), target));
  if (!assigned.length) return new Set();
  const taken = new Set(
    (await db.selectDistinct({ id: results.assessmentId }).from(results).where(and(eq(results.studentId, studentId), inArray(results.assessmentId, assigned.map((a) => a.id))))).map((r) => r.id),
  );
  const closed = assigned.filter((a) => a.status === "CLOSED" || taken.has(a.id) || ((a.availableUntil ?? a.endAt)?.getTime() ?? Infinity) < now.getTime()).map((a) => a.id);
  if (!closed.length) return new Set();
  const rows = await db
    .selectDistinct({ questionId: versionQuestions.sourceQuestionId })
    .from(versionQuestions)
    .innerJoin(assessmentVersions, eq(assessmentVersions.id, versionQuestions.versionId))
    .where(and(inArray(assessmentVersions.assessmentId, [...new Set(closed)]), isNotNull(versionQuestions.sourceQuestionId)));
  return new Set(rows.map((r) => r.questionId!));
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
  const pool = await pastExamQuestionIds(workspaceId, userId, allowed, now);
  const candidates = (await retakeCandidates(workspaceId, userId, [input.topicKey])).filter((c) => pool.has(c.id));
  const { ids } = pickRetakeQuestions(candidates, PRACTICE_QUESTIONS);
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

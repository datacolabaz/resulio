import { and, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  assessmentAssignments,
  assessmentOrigins,
  assessments,
  attempts,
  groupMembers,
  growthSettings,
  providerWorkspaces,
  riskHistory,
  studentRisk,
  users,
} from "../../drizzle/schema";
import { requireDb, type DbOrTx } from "../db";
import { teacherStudentIds } from "../modules/groups";
import { dayKey } from "../modules/motivation";
import { dispatch } from "../notifications/dispatcher";
import type { RiskLevel, RiskReason } from "../../shared/growth";
import { computeRisk, isDismissed, MISSED_WINDOW_DAYS, repeatedMistakes } from "./risk";
import { originsOf, studentResults } from "./store";
import { studentMastery, studentStats } from "./weakness";

const DAY_MS = 86_400_000;
const DIGEST_NAMES = 5;

export interface GrowthSettings {
  riskEnabled: boolean;
  digestEnabled: boolean;
  parentReports: boolean;
}

export const DEFAULT_GROWTH_SETTINGS: GrowthSettings = { riskEnabled: true, digestEnabled: true, parentReports: false };

export async function growthSettingsOf(workspaceId: string, db: DbOrTx = requireDb()): Promise<GrowthSettings> {
  const [row] = await db.select().from(growthSettings).where(eq(growthSettings.workspaceId, workspaceId)).limit(1);
  return row ? { riskEnabled: row.riskEnabled, digestEnabled: row.digestEnabled, parentReports: row.parentReports } : DEFAULT_GROWTH_SETTINGS;
}

export async function updateGrowthSettings(workspaceId: string, userId: number, patch: Partial<GrowthSettings>) {
  const next = { ...(await growthSettingsOf(workspaceId)), ...patch };
  await requireDb()
    .insert(growthSettings)
    .values({ workspaceId, ...next, updatedBy: userId })
    .onDuplicateKeyUpdate({ set: { ...next, updatedBy: userId } });
  return next;
}

/**
 * Exams assigned to the student (directly or through a group they were already in) whose window
 * closed in the last 30 days without any attempt. Generated retakes and practice do not count.
 */
export async function missedExamCount(workspaceId: string, studentId: number, now = new Date(), db: DbOrTx = requireDb()): Promise<number> {
  const memberships = await db
    .select({ groupId: groupMembers.groupId, joinedAt: groupMembers.joinedAt })
    .from(groupMembers)
    .where(and(eq(groupMembers.userId, studentId), eq(groupMembers.status, "ACTIVE"), eq(groupMembers.membershipRole, "STUDENT")));
  const joined = new Map(memberships.map((m) => [m.groupId, m.joinedAt]));
  const groupIds = [...joined.keys()];
  const target = groupIds.length ? or(eq(assessmentAssignments.studentId, studentId), inArray(assessmentAssignments.groupId, groupIds)) : eq(assessmentAssignments.studentId, studentId);
  const rows = await db
    .select({ assessmentId: assessments.id, endAt: assessments.endAt, availableUntil: assessmentAssignments.availableUntil, groupId: assessmentAssignments.groupId })
    .from(assessmentAssignments)
    .innerJoin(assessments, eq(assessments.id, assessmentAssignments.assessmentId))
    .leftJoin(assessmentOrigins, eq(assessmentOrigins.assessmentId, assessments.id))
    .where(and(eq(assessments.providerWorkspaceId, workspaceId), ne(assessments.status, "DRAFT"), eq(assessmentAssignments.status, "ACTIVE"), isNull(assessmentOrigins.assessmentId), target));
  const from = now.getTime() - MISSED_WINDOW_DAYS * DAY_MS;
  const due = new Set<string>();
  for (const r of rows) {
    const end = r.availableUntil ?? r.endAt;
    if (!end || end.getTime() < from || end.getTime() >= now.getTime()) continue;
    if (r.groupId && (joined.get(r.groupId)?.getTime() ?? Infinity) >= end.getTime()) continue;
    due.add(r.assessmentId);
  }
  if (!due.size) return 0;
  const tried = await db
    .selectDistinct({ assessmentId: attempts.assessmentId })
    .from(attempts)
    .where(and(eq(attempts.studentId, studentId), inArray(attempts.assessmentId, [...due])));
  return due.size - tried.length;
}

/** Recompute step and daily pass: the student's risk now, and today's point in the history. */
export async function writeRisk(workspaceId: string, studentId: number, now = new Date()) {
  const db = requireDb();
  if (!(await growthSettingsOf(workspaceId, db)).riskEnabled) return;
  const [stats, mastery, rs, missed] = await Promise.all([
    studentStats(workspaceId, studentId, db),
    studentMastery(workspaceId, [studentId], db),
    studentResults(workspaceId, studentId, db),
    missedExamCount(workspaceId, studentId, now, db),
  ]);
  const origins = await originsOf(rs.map((r) => r.assessmentId), db);
  const risk = computeRisk({
    examScores: rs.filter((r) => !origins.has(r.assessmentId) && r.percentage != null && !r.pendingReviewCount).map((r) => ({ at: r.completedAt, pct: r.percentage! })),
    missedExams: missed,
    repeatedTopics: repeatedMistakes(stats),
    criticalTopics: mastery.filter((m) => m.dimension === "TOPIC" && m.status === "CRITICAL").map((m) => ({ label: m.label, mastery: m.mastery })),
  });
  await db
    .insert(studentRisk)
    .values({ workspaceId, studentId, ...risk, computedAt: now })
    .onDuplicateKeyUpdate({ set: { score: risk.score, level: risk.level, reasons: risk.reasons, computedAt: now } });
  await db
    .insert(riskHistory)
    .values({ workspaceId, studentId, dayKey: dayKey(now), score: risk.score, level: risk.level })
    .onDuplicateKeyUpdate({ set: { score: risk.score, level: risk.level } });
  return risk;
}

export interface RiskRow {
  studentId: number;
  score: number;
  level: RiskLevel;
  reasons: RiskReason[];
  computedAt: Date;
  dismissedUntil: Date | null;
  dismissedScore: number | null;
}

export async function risksOf(workspaceId: string, studentIds: number[], db: DbOrTx = requireDb()): Promise<RiskRow[]> {
  if (!studentIds.length) return [];
  return db
    .select({
      studentId: studentRisk.studentId,
      score: studentRisk.score,
      level: studentRisk.level,
      reasons: studentRisk.reasons,
      computedAt: studentRisk.computedAt,
      dismissedUntil: studentRisk.dismissedUntil,
      dismissedScore: studentRisk.dismissedScore,
    })
    .from(studentRisk)
    .where(and(eq(studentRisk.workspaceId, workspaceId), inArray(studentRisk.studentId, studentIds)));
}

/** Students who are HIGH today and were not HIGH on their previous recorded day. */
export async function newlyHigh(workspaceId: string, now: Date, db: DbOrTx = requireDb()): Promise<number[]> {
  const today = dayKey(now);
  const high = await db
    .select({ studentId: riskHistory.studentId })
    .from(riskHistory)
    .where(and(eq(riskHistory.workspaceId, workspaceId), eq(riskHistory.dayKey, today), eq(riskHistory.level, "HIGH")));
  if (!high.length) return [];
  const ids = high.map((h) => h.studentId);
  const before = await db
    .select({ studentId: riskHistory.studentId, level: riskHistory.level, dayKey: riskHistory.dayKey })
    .from(riskHistory)
    .where(and(eq(riskHistory.workspaceId, workspaceId), inArray(riskHistory.studentId, ids), lt(riskHistory.dayKey, today), gte(riskHistory.dayKey, dayKey(new Date(now.getTime() - 60 * DAY_MS)))));
  const last = new Map<number, { level: string; dayKey: string }>();
  for (const b of before) if ((last.get(b.studentId)?.dayKey ?? "") < b.dayKey) last.set(b.studentId, b);
  const risks = new Map((await risksOf(workspaceId, ids, db)).map((r) => [r.studentId, r]));
  return ids.filter((id) => last.get(id)?.level !== "HIGH" && !(risks.get(id) && isDismissed(risks.get(id)!, now)));
}

/** Daily step: every active student of the workspace (missed exams change with time), then the digest. */
export async function dailyRiskPass(workspaceId: string, now: Date) {
  const db = requireDb();
  const settings = await growthSettingsOf(workspaceId, db);
  if (!settings.riskEnabled) return;
  for (const studentId of await teacherStudentIds({ workspaceId, userId: 0 })) {
    try {
      await writeRisk(workspaceId, studentId, now);
    } catch (error) {
      console.error("[Growth] risk failed", workspaceId, studentId, error instanceof Error ? error.message : error);
    }
  }
  if (!settings.digestEnabled) return;
  const ids = await newlyHigh(workspaceId, now, db);
  if (!ids.length) return;
  const [ws] = await db.select({ ownerUserId: providerWorkspaces.ownerUserId }).from(providerWorkspaces).where(eq(providerWorkspaces.id, workspaceId)).limit(1);
  if (!ws) return;
  const names = await db.select({ name: users.name }).from(users).where(inArray(users.id, ids.slice(0, DIGEST_NAMES)));
  dispatch({
    event: "GROWTH_RISK_DIGEST",
    userId: ws.ownerUserId,
    dedupeKey: `growth-risk:${workspaceId}:${dayKey(now)}`,
    data: { count: ids.length, names: names.map((n) => n.name ?? "").filter(Boolean) },
  });
}

export async function dismissRisk(workspaceId: string, studentId: number, days: number, now = new Date()) {
  await requireDb()
    .update(studentRisk)
    .set({ dismissedUntil: new Date(now.getTime() + days * DAY_MS), dismissedScore: sql`${studentRisk.score}` })
    .where(and(eq(studentRisk.workspaceId, workspaceId), eq(studentRisk.studentId, studentId)));
}

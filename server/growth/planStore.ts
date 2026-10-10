import { and, asc, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  assessmentAssignments,
  assessmentOrigins,
  assessments,
  attempts,
  groupMembers,
  groups,
  reviewPlanItems,
  reviewPlans,
  studentGrowthSettings,
  users,
} from "../../drizzle/schema";
import type { PlanItemStatus } from "../../shared/growth";
import { requireDb, type DbOrTx } from "../db";
import { AppError } from "../modules/errors";
import { activeGroupIdsOfStudent } from "../modules/groups";
import { dayKey } from "../modules/motivation";
import { dispatch } from "../notifications/dispatcher";
import { studentGroupWorkspace } from "./availability";
import { topGains } from "./mastery";
import { buildPlan, planTarget, rollover, type PlanTopic } from "./plan";
import { practiceGroups } from "./practice";
import { releasedMastery } from "./studentView";
import { syncReleasedXp } from "./releasedXp";
import { XP } from "./xp";
import { awardXp, xpSummary } from "./xpStore";

const DEFAULT_MINUTES = 30;

export async function studentSettingsOf(workspaceId: string, studentId: number, db: DbOrTx = requireDb()) {
  const [row] = await db
    .select()
    .from(studentGrowthSettings)
    .where(and(eq(studentGrowthSettings.workspaceId, workspaceId), eq(studentGrowthSettings.studentId, studentId)))
    .limit(1);
  return { dailyMinutes: row?.dailyMinutes ?? DEFAULT_MINUTES, reminders: row?.reminders ?? true };
}

export async function saveStudentSettings(userId: number, groupId: string, patch: { dailyMinutes?: number; reminders?: boolean }) {
  const { workspaceId } = await studentGroupWorkspace(userId, groupId);
  const next = { ...(await studentSettingsOf(workspaceId, userId)), ...patch };
  await requireDb()
    .insert(studentGrowthSettings)
    .values({ workspaceId, studentId: userId, ...next })
    .onDuplicateKeyUpdate({ set: next });
  return next;
}

/** Day (Baku) of the nearest exam assigned to the student in this workspace that has not started yet. */
export async function nextExamDay(workspaceId: string, studentId: number, now = new Date(), db: DbOrTx = requireDb()): Promise<string | null> {
  const groupIds = await activeGroupIdsOfStudent(studentId, db);
  const target = groupIds.length ? or(eq(assessmentAssignments.studentId, studentId), inArray(assessmentAssignments.groupId, groupIds)) : eq(assessmentAssignments.studentId, studentId);
  const rows = await db
    .select({ startAt: assessments.startAt, availableFrom: assessmentAssignments.availableFrom })
    .from(assessmentAssignments)
    .innerJoin(assessments, eq(assessments.id, assessmentAssignments.assessmentId))
    .leftJoin(assessmentOrigins, eq(assessmentOrigins.assessmentId, assessments.id))
    .where(and(eq(assessments.providerWorkspaceId, workspaceId), eq(assessments.status, "PUBLISHED"), eq(assessmentAssignments.status, "ACTIVE"), isNull(assessmentOrigins.assessmentId), target));
  const starts = rows.map((r) => r.availableFrom ?? r.startAt).filter((d): d is Date => !!d && d.getTime() > now.getTime());
  if (!starts.length) return null;
  return dayKey(new Date(Math.min(...starts.map((d) => d.getTime()))));
}

async function activePlan(workspaceId: string, studentId: number, db: DbOrTx = requireDb()) {
  const [plan] = await db
    .select()
    .from(reviewPlans)
    .where(and(eq(reviewPlans.workspaceId, workspaceId), eq(reviewPlans.studentId, studentId), eq(reviewPlans.status, "ACTIVE")))
    .limit(1);
  return plan ?? null;
}

/** Builds a new plan from the student's released mastery; an earlier active plan is marked REPLACED. */
export async function createPlan(userId: number, groupId: string, dailyMinutes: number, now = new Date()) {
  const { workspaceId } = await studentGroupWorkspace(userId, groupId);
  const db = requireDb();
  await saveStudentSettings(userId, groupId, { dailyMinutes });
  const { stats, mastery } = await releasedMastery(workspaceId, userId);
  const gains = new Map(topGains(mastery, stats, 10).map((g) => [g.topicKey, g.gain]));
  const topics: PlanTopic[] = mastery
    .filter((m) => m.dimension === "TOPIC")
    .map((m) => ({ topicKey: m.topicKey, label: m.label, mastery: m.mastery, status: m.status, gain: gains.get(m.topicKey) ?? 0 }));
  const today = dayKey(now);
  const [user] = await db.select({ targetExamDate: users.targetExamDate }).from(users).where(eq(users.id, userId)).limit(1);
  const { targetDay, source } = planTarget(today, await nextExamDay(workspaceId, userId, now, db), user?.targetExamDate ? dayKey(user.targetExamDate) : null);
  const drafts = buildPlan({ today, targetDay, dailyMinutes, topics });
  const id = nanoid();
  await db.transaction(async (tx) => {
    await tx
      .update(reviewPlans)
      .set({ status: "REPLACED" })
      .where(and(eq(reviewPlans.workspaceId, workspaceId), eq(reviewPlans.studentId, userId), eq(reviewPlans.status, "ACTIVE")));
    await tx.insert(reviewPlans).values({ id, workspaceId, studentId: userId, status: "ACTIVE", startDay: today, targetDay, targetSource: source, dailyMinutes });
    if (drafts.length) {
      await tx.insert(reviewPlanItems).values(drafts.map((d, i) => ({ ...d, id: nanoid(), planId: id, position: i, status: "TODO" as PlanItemStatus })));
    }
  });
  return { id, items: drafts.length };
}

export async function getPlan(userId: number, groupId: string) {
  const { workspaceId } = await studentGroupWorkspace(userId, groupId);
  const db = requireDb();
  const plan = await activePlan(workspaceId, userId, db);
  const items = plan ? await db.select().from(reviewPlanItems).where(eq(reviewPlanItems.planId, plan.id)).orderBy(asc(reviewPlanItems.dayKey), asc(reviewPlanItems.position)) : [];
  await syncReleasedXp(workspaceId, userId);
  return {
    plan,
    items,
    settings: await studentSettingsOf(workspaceId, userId, db),
    xp: await xpSummary(userId),
    selfPractice: (await practiceGroups(userId, workspaceId)).length > 0,
  };
}

async function ownItem(userId: number, itemId: string) {
  const db = requireDb();
  const [row] = await db
    .select({ item: reviewPlanItems, plan: reviewPlans })
    .from(reviewPlanItems)
    .innerJoin(reviewPlans, eq(reviewPlans.id, reviewPlanItems.planId))
    .where(and(eq(reviewPlanItems.id, itemId), eq(reviewPlans.studentId, userId), eq(reviewPlans.status, "ACTIVE")))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

/** Monday of the week a day key falls in. */
export const weekStart = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
};

async function markDone(itemId: string, now: Date) {
  await requireDb().update(reviewPlanItems).set({ status: "DONE", doneAt: now }).where(and(eq(reviewPlanItems.id, itemId), ne(reviewPlanItems.status, "DONE")));
}

/** All of a plan week's items done (and the week has items) → the weekly bonus, once. */
async function checkWeek(plan: { id: string; workspaceId: string; studentId: number }, day: string, now: Date) {
  const week = weekStart(day);
  const items = await requireDb().select({ dayKey: reviewPlanItems.dayKey, status: reviewPlanItems.status }).from(reviewPlanItems).where(eq(reviewPlanItems.planId, plan.id));
  const inWeek = items.filter((i) => weekStart(i.dayKey) === week);
  if (inWeek.length && inWeek.every((i) => i.status === "DONE")) {
    await awardXp({ studentId: plan.studentId, workspaceId: plan.workspaceId, type: "WEEK_COMPLETE", points: XP.WEEK_COMPLETE, refKey: `week:${plan.id}:${week}` }, now);
  }
}

export async function completeItem(userId: number, itemId: string, now = new Date()) {
  const { item, plan } = await ownItem(userId, itemId);
  if (item.status === "DONE") return { awarded: false };
  await markDone(item.id, now);
  const awarded = await awardXp({ studentId: userId, workspaceId: plan.workspaceId, type: "ITEM_DONE", points: XP.ITEM_DONE, refKey: `item:${item.id}`, activity: true }, now);
  await checkWeek(plan, item.dayKey, now);
  return { awarded };
}

export async function completePlan(userId: number, planId: string, now = new Date()) {
  await requireDb()
    .update(reviewPlans)
    .set({ status: "COMPLETED", completedAt: now })
    .where(and(eq(reviewPlans.id, planId), eq(reviewPlans.studentId, userId), eq(reviewPlans.status, "ACTIVE")));
}

export async function linkPracticeToItem(userId: number, itemId: string, assessmentId: string) {
  await ownItem(userId, itemId);
  await requireDb().update(reviewPlanItems).set({ refId: assessmentId }).where(eq(reviewPlanItems.id, itemId));
}

/**
 * A finished retake or practice: practice XP for finishing, and the plan item it came from is done.
 * The 70%+ bonus waits for the released result (`releasedXp.ts`).
 */
export async function onPracticeAttempt(attemptId: string, now = new Date()) {
  const db = requireDb();
  const [row] = await db
    .select({ studentId: attempts.studentId, assessmentId: attempts.assessmentId, workspaceId: assessmentOrigins.workspaceId })
    .from(attempts)
    .innerJoin(assessmentOrigins, eq(assessmentOrigins.assessmentId, attempts.assessmentId))
    .where(eq(attempts.id, attemptId))
    .limit(1);
  if (!row || row.studentId == null) return;
  await awardXp({ studentId: row.studentId, workspaceId: row.workspaceId, type: "PRACTICE_DONE", points: XP.PRACTICE_DONE, refKey: `practice:${row.assessmentId}`, activity: true }, now);
  const linked = await db
    .select({ item: reviewPlanItems, plan: reviewPlans })
    .from(reviewPlanItems)
    .innerJoin(reviewPlans, eq(reviewPlans.id, reviewPlanItems.planId))
    .where(and(eq(reviewPlanItems.refId, row.assessmentId), eq(reviewPlans.studentId, row.studentId)));
  for (const { item, plan } of linked) {
    await markDone(item.id, now);
    await checkWeek(plan, item.dayKey, now);
  }
}

/** Daily step: past-due items roll over (or are skipped after three times); finished plans close. */
export async function dailyPlanPass(workspaceId: string, now: Date) {
  const db = requireDb();
  const today = dayKey(now);
  const plans = await db.select().from(reviewPlans).where(and(eq(reviewPlans.workspaceId, workspaceId), eq(reviewPlans.status, "ACTIVE")));
  for (const plan of plans) {
    if (plan.targetDay <= today) {
      await db.update(reviewPlans).set({ status: "COMPLETED", completedAt: now }).where(eq(reviewPlans.id, plan.id));
      continue;
    }
    const items = await db.select().from(reviewPlanItems).where(and(eq(reviewPlanItems.planId, plan.id), eq(reviewPlanItems.status, "TODO")));
    const { moves, skips } = rollover(items, items.filter((i) => i.dayKey >= today), today, plan.targetDay, plan.dailyMinutes);
    for (const m of moves) await db.update(reviewPlanItems).set({ dayKey: m.dayKey, rolloverCount: m.rolloverCount }).where(eq(reviewPlanItems.id, m.id));
    if (skips.length) await db.update(reviewPlanItems).set({ status: "SKIPPED" }).where(inArray(reviewPlanItems.id, skips));
  }
}

export interface PlanReminder {
  studentId: number;
  planId: string;
  items: number;
  minutes: number;
}

/** One reminder per plan with unfinished steps today; students who turned reminders off get none. */
export function groupReminders(rows: { studentId: number; planId: string; minutes: number }[], optedOut: ReadonlySet<number>): PlanReminder[] {
  const byPlan = new Map<string, PlanReminder>();
  for (const r of rows) {
    if (optedOut.has(r.studentId)) continue;
    const hit = byPlan.get(r.planId) ?? { studentId: r.studentId, planId: r.planId, items: 0, minutes: 0 };
    hit.items += 1;
    hit.minutes += r.minutes;
    byPlan.set(r.planId, hit);
  }
  return [...byPlan.values()];
}

export async function planReminders(workspaceId: string, now: Date): Promise<PlanReminder[]> {
  const today = dayKey(now);
  const db = requireDb();
  const rows = await db
    .select({ studentId: reviewPlans.studentId, planId: reviewPlans.id, minutes: reviewPlanItems.minutes })
    .from(reviewPlans)
    .innerJoin(reviewPlanItems, eq(reviewPlanItems.planId, reviewPlans.id))
    .where(and(eq(reviewPlans.workspaceId, workspaceId), eq(reviewPlans.status, "ACTIVE"), eq(reviewPlanItems.dayKey, today), eq(reviewPlanItems.status, "TODO"), gt(reviewPlans.targetDay, today)));
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => r.studentId))];
  const off = await db
    .select({ studentId: studentGrowthSettings.studentId })
    .from(studentGrowthSettings)
    .where(and(eq(studentGrowthSettings.workspaceId, workspaceId), eq(studentGrowthSettings.reminders, false), inArray(studentGrowthSettings.studentId, ids)));
  const members = await db
    .selectDistinct({ studentId: groupMembers.userId })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groups.providerWorkspaceId, workspaceId), eq(groupMembers.status, "ACTIVE"), eq(groupMembers.membershipRole, "STUDENT"), inArray(groupMembers.userId, ids)));
  const stillIn = new Set(members.map((m) => m.studentId));
  return groupReminders(rows, new Set([...off.map((r) => r.studentId), ...ids.filter((id) => !stillIn.has(id))]));
}

/** The afternoon reminder; the dedupe key keeps it to one per plan and day, across restarts too. */
export async function sendPlanReminders(workspaceId: string, now: Date) {
  const today = dayKey(now);
  for (const r of await planReminders(workspaceId, now)) {
    dispatch({ event: "PLAN_REMINDER", userId: r.studentId, dedupeKey: `growth-plan:${r.planId}:${today}`, data: { planId: r.planId, items: r.items, minutes: r.minutes } });
  }
}

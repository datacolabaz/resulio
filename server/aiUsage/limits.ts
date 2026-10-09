import { and, eq, gte, sql } from "drizzle-orm";
import { AI_LIMIT_WARN_RATIO, effectiveLimit, nextPeriodStart, periodStart, type LimitValue } from "../../shared/aiUsage";
import { aiRequestLogs, aiTeacherLimits } from "../../drizzle/schema";
import { requireDb } from "../db";
import { AppError } from "../modules/errors";
import { getPlatformSettings } from "../platformSettings";

/**
 * Per-teacher AI limits, checked before a teacher-started AI action. Usage is read from
 * ai_request_logs (no counters to race on); an action already running is not cut off, so one
 * action may take a teacher past the quota. See shared/aiUsage.ts for the null / 0 semantics.
 */

export interface TeacherLimits {
  monthlyTokenQuota: number | null;
  dailyRequestCap: number | null;
}
export interface TeacherUsage {
  monthTokens: number;
  dayOperations: number;
}
export interface LimitOverride {
  monthlyTokenQuota: LimitValue;
  dailyRequestCap: LimitValue;
  usageResetAt: Date | null;
}

export type LimitCheck = { ok: true } | { ok: false; reason: "MONTHLY" | "DAILY"; resetsAt: Date };

export function resolveLimits(defaults: { monthlyTokenQuota: LimitValue; dailyRequestCap: LimitValue }, override: LimitOverride | null): TeacherLimits {
  return {
    monthlyTokenQuota: effectiveLimit(defaults.monthlyTokenQuota, override?.monthlyTokenQuota ?? null),
    dailyRequestCap: effectiveLimit(defaults.dailyRequestCap, override?.dailyRequestCap ?? null),
  };
}

/** Where the current month's and day's counts start: the period start, or a later admin reset. */
export function countingFrom(now: Date, usageResetAt: Date | null) {
  const month = periodStart("month", now);
  const day = periodStart("day", now);
  const reset = usageResetAt?.getTime() ?? 0;
  return { month: new Date(Math.max(month.getTime(), reset)), day: new Date(Math.max(day.getTime(), reset)) };
}

export function checkLimits(usage: TeacherUsage, limits: TeacherLimits, now: Date): LimitCheck {
  if (limits.monthlyTokenQuota !== null && usage.monthTokens >= limits.monthlyTokenQuota) return { ok: false, reason: "MONTHLY", resetsAt: nextPeriodStart("month", now) };
  if (limits.dailyRequestCap !== null && usage.dayOperations >= limits.dailyRequestCap) return { ok: false, reason: "DAILY", resetsAt: nextPeriodStart("day", now) };
  return { ok: true };
}

const ratio = (used: number, limit: number | null) => (limit ? Math.min(1, used / limit) : 0);

/** What the teacher sees next to AI actions. */
export function quotaView(usage: TeacherUsage, limits: TeacherLimits, now: Date) {
  const monthly = { used: usage.monthTokens, limit: limits.monthlyTokenQuota, ratio: ratio(usage.monthTokens, limits.monthlyTokenQuota), resetsAt: nextPeriodStart("month", now) };
  const daily = { used: usage.dayOperations, limit: limits.dailyRequestCap, ratio: ratio(usage.dayOperations, limits.dailyRequestCap), resetsAt: nextPeriodStart("day", now) };
  const check = checkLimits(usage, limits, now);
  return {
    monthly,
    daily,
    limited: limits.monthlyTokenQuota !== null || limits.dailyRequestCap !== null,
    warn: Math.max(monthly.ratio, daily.ratio) >= AI_LIMIT_WARN_RATIO,
    blocked: check.ok ? null : check.reason,
  };
}

async function overrideOf(userId: number): Promise<LimitOverride | null> {
  const [row] = await requireDb().select().from(aiTeacherLimits).where(eq(aiTeacherLimits.userId, userId)).limit(1);
  return row ? { monthlyTokenQuota: row.monthlyTokenQuota, dailyRequestCap: row.dailyRequestCap, usageResetAt: row.usageResetAt } : null;
}

export async function usageSince(userId: number, from: { month: Date; day: Date }): Promise<TeacherUsage> {
  const db = requireDb();
  const [month] = await db
    .select({ tokens: sql<number>`coalesce(sum(${aiRequestLogs.totalTokens}), 0)` })
    .from(aiRequestLogs)
    .where(and(eq(aiRequestLogs.userId, userId), gte(aiRequestLogs.createdAt, from.month)));
  const [day] = await db
    .select({ ops: sql<number>`count(distinct ${aiRequestLogs.operationId})` })
    .from(aiRequestLogs)
    .where(and(eq(aiRequestLogs.userId, userId), gte(aiRequestLogs.createdAt, from.day)));
  return { monthTokens: Number(month?.tokens ?? 0), dayOperations: Number(day?.ops ?? 0) };
}

async function teacherState(userId: number, now: Date) {
  const settings = await getPlatformSettings();
  const override = await overrideOf(userId);
  const limits = resolveLimits({ monthlyTokenQuota: settings["ai.defaultMonthlyTokenQuota"], dailyRequestCap: settings["ai.defaultDailyRequestCap"] }, override);
  const unlimited = limits.monthlyTokenQuota === null && limits.dailyRequestCap === null;
  const usage = unlimited ? null : await usageSince(userId, countingFrom(now, override?.usageResetAt ?? null));
  return { limits, usage };
}

/** Limit state for one teacher; fails open (allowed) if the tables cannot be read, so AI keeps working. */
export async function aiLimitCheck(userId: number, now = new Date()): Promise<LimitCheck> {
  try {
    const { limits, usage } = await teacherState(userId, now);
    return usage ? checkLimits(usage, limits, now) : { ok: true };
  } catch (error) {
    console.warn("[aiUsage] limit check failed; allowing the call", error instanceof Error ? error.message : error);
    return { ok: true };
  }
}

/** Throws AI_TEACHER_MONTHLY_LIMIT / AI_TEACHER_DAILY_LIMIT before a teacher-started AI action. */
export async function assertAiAllowed(userId: number, now = new Date()) {
  const check = await aiLimitCheck(userId, now);
  if (!check.ok) throw new AppError(check.reason === "MONTHLY" ? "AI_TEACHER_MONTHLY_LIMIT" : "AI_TEACHER_DAILY_LIMIT");
}

/** For the teacher's own usage indicator. */
export async function myAiQuota(userId: number, now = new Date()) {
  try {
    const { limits, usage } = await teacherState(userId, now);
    if (usage) return quotaView(usage, limits, now);
    // Unlimited: still show this month's tokens, without a bar.
    const used = await usageSince(userId, countingFrom(now, null));
    return quotaView(used, limits, now);
  } catch {
    return quotaView({ monthTokens: 0, dayOperations: 0 }, { monthlyTokenQuota: null, dailyRequestCap: null }, now);
  }
}

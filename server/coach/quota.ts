import { and, eq, gte, sql } from "drizzle-orm";
import { coachEvents } from "../../drizzle/schema";
import { COACH_DEFAULT_DAILY_ACTIONS, COACH_DEFAULT_LIMITS, COACH_DEFAULT_MONTHLY_TOKENS, type CoachEventType, type CoachLimits } from "../../shared/coach";
import { periodStart } from "../../shared/aiUsage";
import { checkLimits, countingFrom, limitOverrideOf, quotaView, usageSince, type TeacherLimits } from "../aiUsage/limits";
import { requireDb } from "../db";
import { AppError } from "../modules/errors";
import { getPlatformSettings } from "../platformSettings";

/**
 * The student's own coach quota (free beta): monthly tokens and daily AI actions over COACH_*
 * features only, plus per-feature caps counted from coach_events. A teacher's quota is never used.
 * Settings: platform_settings `coach.studentMonthlyTokenQuota`, `coach.studentDailyActionCap`
 * (null = beta default, 0 = unlimited) and `coach.limits`; an admin's per-user override in
 * ai_teacher_limits (keyed by user) wins for that student.
 */

/** null setting = the beta default; 0 = unlimited; > 0 = that cap. Override: null = setting, 0 = unlimited. */
export function coachLimitValue(setting: number | null, fallback: number, override: number | null): number | null {
  if (override !== null && override !== undefined) return override > 0 ? override : null;
  const v = setting === null || setting === undefined ? fallback : setting;
  return v > 0 ? v : null;
}

export function mergeLimits(partial: Partial<CoachLimits> | null): CoachLimits {
  return { ...COACH_DEFAULT_LIMITS, ...(partial ?? {}) };
}

export async function coachLimits(): Promise<CoachLimits> {
  try {
    return mergeLimits((await getPlatformSettings())["coach.limits"]);
  } catch {
    return { ...COACH_DEFAULT_LIMITS };
  }
}

async function coachState(userId: number, now: Date) {
  const settings = await getPlatformSettings();
  const override = await limitOverrideOf(userId);
  const limits: TeacherLimits = {
    monthlyTokenQuota: coachLimitValue(settings["coach.studentMonthlyTokenQuota"], COACH_DEFAULT_MONTHLY_TOKENS, override?.monthlyTokenQuota ?? null),
    dailyRequestCap: coachLimitValue(settings["coach.studentDailyActionCap"], COACH_DEFAULT_DAILY_ACTIONS, override?.dailyRequestCap ?? null),
  };
  const usage = await usageSince(userId, countingFrom(now, override?.usageResetAt ?? null), "coach");
  return { limits, usage };
}

/** Throws COACH_MONTHLY_LIMIT / COACH_DAILY_LIMIT before a coach AI action; fails open if the tables cannot be read. */
export async function assertCoachAiAllowed(userId: number, now = new Date()) {
  let check;
  try {
    const { limits, usage } = await coachState(userId, now);
    check = checkLimits(usage, limits, now);
  } catch (error) {
    console.warn("[coach] quota check failed; allowing the call", error instanceof Error ? error.message : error);
    return;
  }
  if (!check.ok) throw new AppError(check.reason === "MONTHLY" ? "COACH_MONTHLY_LIMIT" : "COACH_DAILY_LIMIT");
}

/** For the student's usage line. */
export async function coachQuota(userId: number, now = new Date()) {
  try {
    const { limits, usage } = await coachState(userId, now);
    return quotaView(usage, limits, now);
  } catch {
    return quotaView({ monthTokens: 0, dayOperations: 0 }, { monthlyTokenQuota: null, dailyRequestCap: null }, now);
  }
}

export async function countEvents(studentId: number, type: CoachEventType, since: Date): Promise<number> {
  const [row] = await requireDb()
    .select({ n: sql<number>`count(*)` })
    .from(coachEvents)
    .where(and(eq(coachEvents.studentId, studentId), eq(coachEvents.type, type), gte(coachEvents.createdAt, since)));
  return Number(row?.n ?? 0);
}

/** Per-day caps counted from coach_events since Baku midnight (0 = no cap). */
export async function assertDailyCap(studentId: number, type: CoachEventType, cap: number, now = new Date()) {
  if (cap <= 0) return;
  if ((await countEvents(studentId, type, periodStart("day", now))) >= cap) throw new AppError("COACH_FEATURE_LIMIT");
}

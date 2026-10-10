import { eq } from "drizzle-orm";
import { assessments, attempts, results } from "../../drizzle/schema";
import { getDb, requireDb } from "../db";
import { onLearningEvent, type LearningEvent } from "../modules/learningEvents";
import { dayKey } from "../modules/motivation";
import { isSchemaBehind } from "../syllabus/availability";
import { growthEnabledFor, growthWorkspaceIds } from "./availability";
import { markDirty, markMissingStats, onStudentRecomputed, reconcileGrowth, recomputeNow } from "./store";
import { markMissingMastery, writeMastery } from "./weakness";
import { dailyRiskPass, writeRisk } from "./riskStore";
import { dailyPlanPass, onPracticeAttempt } from "./planStore";
import { dailyReleasedXpPass, syncReleasedXp } from "./releasedXp";

let stepsRegistered = false;

/** The per-student pipeline after the stats, in order. Later stages append here. */
export function registerGrowthSteps() {
  if (stepsRegistered) return;
  stepsRegistered = true;
  onStudentRecomputed(writeMastery);
  onStudentRecomputed(async (workspaceId, studentId) => {
    await writeRisk(workspaceId, studentId);
  });
  onStudentRecomputed(async (workspaceId, studentId) => {
    await syncReleasedXp(workspaceId, studentId);
  });
  onGrowthDaily(dailyRiskPass);
  onGrowthDaily(dailyPlanPass);
  onGrowthDaily(dailyReleasedXpPass);
}

/**
 * Triggers: a finished attempt or a regraded result marks the student dirty and is processed at
 * once; a sweeper reconciles whatever is left (a crash, a mapping change, the backfill); a daily
 * pass (after 03:00 Baku) catches time-based changes. Every step is idempotent.
 */

const RECONCILE_MS = 2 * 60_000;
const DAILY_CHECK_MS = 15 * 60_000;
const DAILY_HOUR_BAKU = 3;

async function studentOf(event: LearningEvent): Promise<{ workspaceId: string; studentId: number } | null> {
  const db = requireDb();
  if (event.type === "ATTEMPT_FINISHED") {
    const [row] = await db
      .select({ studentId: attempts.studentId, workspaceId: assessments.providerWorkspaceId })
      .from(attempts)
      .innerJoin(assessments, eq(assessments.id, attempts.assessmentId))
      .where(eq(attempts.id, event.attemptId))
      .limit(1);
    return row ?? null;
  }
  if (event.type === "ASSESSMENT_RESULT_CHANGED") {
    const [row] = await db
      .select({ studentId: results.studentId, workspaceId: assessments.providerWorkspaceId })
      .from(results)
      .innerJoin(assessments, eq(assessments.id, results.assessmentId))
      .where(eq(results.id, event.resultId))
      .limit(1);
    return row ?? null;
  }
  return null;
}

export async function handleGrowthEvent(event: LearningEvent) {
  try {
    const target = await studentOf(event);
    if (!target || !(await growthEnabledFor(target.workspaceId))) return;
    await markDirty(target.workspaceId, [target.studentId], event.type === "ATTEMPT_FINISHED" ? "attempt" : "regrade");
    await recomputeNow(target.workspaceId, target.studentId);
    if (event.type === "ATTEMPT_FINISHED") await onPracticeAttempt(event.attemptId);
  } catch (error) {
    if (isSchemaBehind(error)) return;
    throw error;
  }
}

export type DailyStep = (workspaceId: string, now: Date) => Promise<void>;
const dailySteps: DailyStep[] = [];

/** Later stages (risk, plan rollover, digests) add their once-a-day work here. */
export function onGrowthDaily(step: DailyStep) {
  dailySteps.push(step);
}

/** Every enabled workspace: queue students with unprocessed results, then the registered daily steps. */
export async function runGrowthDaily(now = new Date()) {
  for (const workspaceId of await growthWorkspaceIds()) {
    try {
      await markMissingStats(workspaceId);
      await markMissingMastery(workspaceId);
      for (const step of dailySteps) await step(workspaceId, now);
    } catch (error) {
      if (isSchemaBehind(error)) return;
      console.error("[Growth] daily pass failed", workspaceId, error instanceof Error ? error.message : error);
    }
  }
}

let lastDaily: string | null = null;

/** Hour of an instant in Baku (UTC+4, no DST). */
export const bakuHour = (now: Date) => (now.getUTCHours() + 4) % 24;

export function dailyDue(now: Date, last: string | null) {
  return bakuHour(now) >= DAILY_HOUR_BAKU && dayKey(now) !== last;
}

export function startGrowthJobs() {
  if (!getDb()) return;
  registerGrowthSteps();
  onLearningEvent(handleGrowthEvent);
  let reconciling = false;
  setInterval(async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      await reconcileGrowth();
    } catch (error) {
      console.error("[Growth] reconcile failed", error);
    } finally {
      reconciling = false;
    }
  }, RECONCILE_MS).unref();
  let daily = false;
  setInterval(async () => {
    const now = new Date();
    if (daily || !dailyDue(now, lastDaily)) return;
    daily = true;
    try {
      await runGrowthDaily(now);
      lastDaily = dayKey(now);
    } catch (error) {
      console.error("[Growth] daily jobs failed", error);
    } finally {
      daily = false;
    }
  }, DAILY_CHECK_MS).unref();
  // Startup backfill: results that arrived before the flag was on (or before this deploy).
  void (async () => {
    try {
      for (const workspaceId of await growthWorkspaceIds()) {
        await markMissingStats(workspaceId);
        await markMissingMastery(workspaceId);
      }
    } catch (error) {
      if (!isSchemaBehind(error)) console.error("[Growth] backfill failed", error instanceof Error ? error.message : error);
    }
  })();
}

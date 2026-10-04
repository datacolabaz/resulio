import { z } from "zod";

/**
 * Syllabus analytics (spec §23, §31–§44): at-risk thresholds, reason/insight codes and funnel stages.
 * Codes are rendered by the client catalog (AZ/EN/RU); the server never sends prose.
 */

export const RISK_THRESHOLD_LIMITS = {
  inactiveDays: { min: 1, max: 90 },
  failedAttempts: { min: 1, max: 20 },
  progressGapPct: { min: 5, max: 100 },
  stuckDays: { min: 1, max: 180 },
  missingPractice: { min: 1, max: 50 },
  practiceGraceDays: { min: 1, max: 90 },
} as const;

export type RiskThresholdKey = keyof typeof RISK_THRESHOLD_LIMITS;

export const riskThresholdsSchema = z.object({
  /** No learning activity for more than N days (§39). */
  inactiveDays: z.number().int().min(1).max(90),
  /** Failed assessment attempts (finished, graded, below the pass mark) across the syllabus (§39). */
  failedAttempts: z.number().int().min(1).max(20),
  /** Progress at least N percentage points below the student's group average (§39). */
  progressGapPct: z.number().int().min(5).max(100),
  /** Still on the same lesson N days after first opening it (§39 "unusually long"). */
  stuckDays: z.number().int().min(1).max(180),
  /** At least N practice tasks not submitted although their lesson has been open for `practiceGraceDays` (or the due date passed). */
  missingPractice: z.number().int().min(1).max(50),
  practiceGraceDays: z.number().int().min(1).max(90),
});
export type RiskThresholds = z.infer<typeof riskThresholdsSchema>;

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  inactiveDays: 7,
  failedAttempts: 2,
  progressGapPct: 25,
  stuckDays: 14,
  missingPractice: 2,
  practiceGraceDays: 7,
};

/** The group average is only meaningful with a few peers. */
export const MIN_GROUP_FOR_GAP = 3;

export const analyticsSettingsSchema = z.object({
  thresholds: riskThresholdsSchema,
  /** Daily at-risk digest to the teacher (in-app; e-mail is an opt-in in notification settings). */
  digestEnabled: z.boolean(),
});
export type AnalyticsSettings = z.infer<typeof analyticsSettingsSchema>;

export const DEFAULT_ANALYTICS_SETTINGS: AnalyticsSettings = { thresholds: DEFAULT_RISK_THRESHOLDS, digestEnabled: true };

/** Stored thresholds may predate a new field or a narrower range: every field falls back on its own. */
export function resolveAnalyticsSettings(raw: { thresholds?: unknown; digestEnabled?: boolean | null } | null | undefined): AnalyticsSettings {
  const stored = (raw?.thresholds ?? {}) as Record<string, unknown>;
  const thresholds = { ...DEFAULT_RISK_THRESHOLDS };
  for (const key of Object.keys(RISK_THRESHOLD_LIMITS) as RiskThresholdKey[]) {
    const v = stored[key];
    const { min, max } = RISK_THRESHOLD_LIMITS[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) thresholds[key] = v;
  }
  return { thresholds, digestEnabled: raw?.digestEnabled ?? true };
}

export const RISK_REASONS = ["NOT_STARTED", "INACTIVE", "FAILED_ASSESSMENTS", "BELOW_GROUP", "STUCK_IN_LESSON", "PRACTICE_MISSING"] as const;
export type RiskReasonCode = (typeof RISK_REASONS)[number];
export interface RiskReason {
  code: RiskReasonCode;
  /** Days, attempts, percentage points or task count — whatever the code measures. */
  value: number;
}

/** §38, in order. Every stage counts distinct students of the population. */
export const FUNNEL_STAGES = [
  "ACCESS",
  "SYLLABUS_OPENED",
  "MODULE_STARTED",
  "LESSON_OPENED",
  "THEORY_COMPLETED",
  "PRACTICE_STARTED",
  "PRACTICE_SUBMITTED",
  "ASSESSMENT_ATTEMPTED",
  "ASSESSMENT_PASSED",
  "MODULE_COMPLETED",
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const INSIGHT_CODES = [
  "AT_RISK",
  "INACTIVE_STUDENTS",
  "LOW_PRACTICE_COMPLETION",
  "LOW_LESSON_SCORE",
  "HARD_LESSON",
  "HIGH_RETRY_MODULE",
  "GROUP_AHEAD",
  "AWAITING_REVIEW",
  "NOT_STARTED",
] as const;
export type InsightCode = (typeof INSIGHT_CODES)[number];
export interface Insight {
  code: InsightCode;
  /** 1 = act now, 2 = worth a look, 3 = for information. */
  severity: 1 | 2 | 3;
  params: Record<string, string | number>;
}

/** Raw learning events are kept this long (owner decision Q11); progress and completion records are kept forever. */
export const ACTIVITY_RETENTION_MONTHS = 24;

import { MIN_GROUP_FOR_GAP, type RiskReason, type RiskThresholds } from "../../shared/syllabusAnalytics";

/**
 * At-risk rules (§39), pure. A student is at risk when any rule fires; every fired rule is returned
 * with its measured value so the teacher sees why ("9 days without activity", "2 failed attempts").
 */

const DAY_MS = 86_400_000;

export interface RiskInput {
  /** Current access allows learning (grant ACTIVE). Students whose access ended are not flagged. */
  accessActive: boolean;
  /** When access started for the student (earliest active grant start), for "has not started". */
  accessSince: Date | null;
  enrolled: boolean;
  completed: boolean;
  lastActivityAt: Date | null;
  progressPct: number;
  failedAttempts: number;
  /** Average progress of the student's group(s) and how many students it is based on. */
  groupAvgPct: number | null;
  groupSize: number;
  /** First opening of the lesson the student is on now, if not completed yet. */
  currentLessonOpenedAt: Date | null;
  missingPractice: number;
}

export const daysSince = (at: Date | null, now: Date) => (at ? Math.floor((now.getTime() - at.getTime()) / DAY_MS) : null);

export function riskReasons(s: RiskInput, th: RiskThresholds, now: Date): RiskReason[] {
  if (s.completed || !s.accessActive) return [];
  const reasons: RiskReason[] = [];
  if (!s.enrolled) {
    const waited = daysSince(s.accessSince, now);
    if (waited !== null && waited > th.inactiveDays) reasons.push({ code: "NOT_STARTED", value: waited });
    return reasons;
  }
  const idle = daysSince(s.lastActivityAt, now);
  if (idle !== null && idle > th.inactiveDays) reasons.push({ code: "INACTIVE", value: idle });
  if (s.failedAttempts >= th.failedAttempts) reasons.push({ code: "FAILED_ASSESSMENTS", value: s.failedAttempts });
  if (s.groupAvgPct !== null && s.groupSize >= MIN_GROUP_FOR_GAP) {
    const gap = Math.round(s.groupAvgPct - s.progressPct);
    if (gap >= th.progressGapPct) reasons.push({ code: "BELOW_GROUP", value: gap });
  }
  const onLesson = daysSince(s.currentLessonOpenedAt, now);
  if (onLesson !== null && onLesson >= th.stuckDays) reasons.push({ code: "STUCK_IN_LESSON", value: onLesson });
  if (s.missingPractice >= th.missingPractice) reasons.push({ code: "PRACTICE_MISSING", value: s.missingPractice });
  return reasons;
}

import { UNTAGGED_TOPIC_KEY, type RiskCode, type RiskLevel, type RiskReason } from "../../shared/growth";
import type { StatRow } from "./mastery";

/**
 * Risk score, pure and explainable. Four signals with fixed weights (v1, not configurable); each
 * signal has a 0–1 severity and contributes weight × severity points to a 0–100 score. Every
 * signal that fires is returned as a reason with its measured value, so the teacher sees why.
 */

export const RISK_WEIGHTS: Record<RiskCode, number> = {
  SCORE_DROP: 30,
  REPEATED_TOPIC_MISTAKES: 20,
  MISSED_EXAMS: 25,
  LOW_TOPIC_MASTERY: 25,
};

export const HIGH_AT = 60;
export const MEDIUM_AT = 35;
export const WATCH_AT = 15;
/** A drop smaller than this many points is noise. */
export const MIN_DROP = 10;
export const MISSED_WINDOW_DAYS = 30;
export const RECENT_RESULTS = 5;
export const MISTAKE_BELOW = 0.5;
/** A dismissed risk comes back before its time only if the score rose this much. */
export const DISMISS_RESURFACE = 15;

export interface RiskInput {
  /** Regular exam results (not retakes or practice), oldest first, in percent. */
  examScores: { at: Date; pct: number }[];
  missedExams: number;
  /** Topics the student scored below 50% on in more than one recent result. */
  repeatedTopics: { label: string; results: number }[];
  /** Topics with status CRITICAL (enough evidence, mastery below 50). */
  criticalTopics: { label: string; mastery: number }[];
}

export interface RiskResult {
  score: number;
  level: RiskLevel;
  reasons: RiskReason[];
}

export function levelOf(score: number): RiskLevel {
  if (score >= HIGH_AT) return "HIGH";
  if (score >= MEDIUM_AT) return "MEDIUM";
  if (score >= WATCH_AT) return "WATCH";
  return "NONE";
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const points = (code: RiskCode, severity: number) => Math.round(RISK_WEIGHTS[code] * clamp01(severity) * 10) / 10;

/** The last exam against the mean of up to three before it; positive means a drop. */
export function scoreDrop(examScores: RiskInput["examScores"]): number | null {
  if (examScores.length < 2) return null;
  const sorted = [...examScores].sort((a, b) => a.at.getTime() - b.at.getTime());
  const last = sorted[sorted.length - 1].pct;
  const before = sorted.slice(-4, -1);
  return Math.round((before.reduce((s, e) => s + e.pct, 0) / before.length - last) * 10) / 10;
}

export function computeRisk(input: RiskInput): RiskResult {
  const reasons: RiskReason[] = [];
  const drop = scoreDrop(input.examScores);
  if (drop != null && drop >= MIN_DROP) reasons.push({ code: "SCORE_DROP", value: drop, points: points("SCORE_DROP", drop / 30) });

  const repeated = [...input.repeatedTopics].filter((t) => t.results >= 2).sort((a, b) => b.results - a.results);
  if (repeated.length) {
    const worst = repeated[0].results;
    reasons.push({ code: "REPEATED_TOPIC_MISTAKES", value: worst, points: points("REPEATED_TOPIC_MISTAKES", (worst - 1) / 2), topics: repeated.slice(0, 3).map((t) => t.label) });
  }

  if (input.missedExams > 0) reasons.push({ code: "MISSED_EXAMS", value: input.missedExams, points: points("MISSED_EXAMS", input.missedExams / 2) });

  const critical = [...input.criticalTopics].sort((a, b) => a.mastery - b.mastery);
  if (critical.length) {
    const avg = critical.reduce((s, t) => s + t.mastery, 0) / critical.length;
    const gap = clamp01((75 - avg) / 50);
    reasons.push({ code: "LOW_TOPIC_MASTERY", value: critical.length, points: points("LOW_TOPIC_MASTERY", Math.min(1, critical.length / 3) * gap), topics: critical.slice(0, 3).map((t) => t.label) });
  }

  const fired = reasons.filter((r) => r.points > 0).sort((a, b) => b.points - a.points);
  const score = Math.min(100, Math.round(fired.reduce((s, r) => s + r.points, 0)));
  return { score, level: levelOf(score), reasons: fired };
}

/** Per topic, in how many of the student's last results it was below 50% (topics only, untagged left out). */
export function repeatedMistakes(stats: StatRow[], lastResults = RECENT_RESULTS): RiskInput["repeatedTopics"] {
  const topicRows = stats.filter((s) => s.dimension === "TOPIC" && s.topicKey !== UNTAGGED_TOPIC_KEY && s.possible > 0);
  const recent = new Map<string, Date>();
  for (const s of topicRows) recent.set(s.resultId, s.completedAt);
  const keep = new Set(
    [...recent.entries()]
      .sort((a, b) => b[1].getTime() - a[1].getTime())
      .slice(0, lastResults)
      .map(([id]) => id),
  );
  const out = new Map<string, { label: string; results: number }>();
  for (const s of topicRows) {
    if (!keep.has(s.resultId) || s.earned / s.possible >= MISTAKE_BELOW) continue;
    const t = out.get(s.topicKey) ?? { label: s.label, results: 0 };
    t.results++;
    out.set(s.topicKey, t);
  }
  return [...out.values()].filter((t) => t.results >= 2);
}

/** Hidden by a dismissal: still inside the window and not risen by DISMISS_RESURFACE points since. */
export function isDismissed(risk: { score: number; dismissedUntil: Date | null; dismissedScore: number | null }, now = new Date()) {
  if (!risk.dismissedUntil || risk.dismissedUntil.getTime() <= now.getTime()) return false;
  return risk.score < (risk.dismissedScore ?? 0) + DISMISS_RESURFACE;
}

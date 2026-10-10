import { UNTAGGED_TOPIC_KEY, type EvidenceOrigin, type GrowthDimension, type MasteryStatus, type MasteryTrend } from "../../shared/growth";

/**
 * Mastery, pure. One topic's evidence is one row per result (result_topic_stats). Newer results
 * weigh more (0.7 per step back), retakes and practice weigh 0.75 of an exam, and a topic with few
 * graded questions is pulled toward the student's overall accuracy (m = 2 questions' worth), so
 * one lucky or unlucky question never makes a topic "strong" or "critical".
 */

export const RECENCY_DECAY = 0.7;
export const NON_EXAM_WEIGHT = 0.75;
export const SHRINK_QUESTIONS = 2;
export const DEFAULT_PRIOR = 0.6;
export const MIN_EVIDENCE = 3;
export const STRONG_AT = 75;
export const REVIEW_AT = 50;
export const TREND_POINTS = 10;
export const TARGET_MASTERY = 0.85;

export interface Evidence {
  resultId: string;
  completedAt: Date;
  origin: EvidenceOrigin;
  questionCount: number;
  pendingCount: number;
  earned: number;
  possible: number;
  wrongPoints: number;
}

export interface TopicMastery {
  /** 0–100. */
  mastery: number;
  rawPct: number;
  /** Graded questions. */
  evidenceCount: number;
  /** Results with at least one graded question on the topic. */
  examCount: number;
  trend: MasteryTrend;
  trendDelta: number | null;
  status: MasteryStatus;
  lastEvidenceAt: Date;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const graded = (e: Evidence) => Math.max(0, e.questionCount - e.pendingCount);
const pct = (e: Evidence) => e.earned / e.possible;

export function statusOf(mastery: number, evidenceCount: number): MasteryStatus {
  if (evidenceCount < MIN_EVIDENCE) return "INSUFFICIENT";
  if (mastery >= STRONG_AT) return "STRONG";
  if (mastery >= REVIEW_AT) return "REVIEW";
  return "CRITICAL";
}

/** Last result against the mean of the two before it; NEW until there are two results. */
export function trendOf(newestFirst: Evidence[]): { trend: MasteryTrend; trendDelta: number | null } {
  if (newestFirst.length < 2) return { trend: "NEW", trendDelta: null };
  const [last, ...rest] = newestFirst;
  const before = rest.slice(0, 2);
  const delta = round1((pct(last) - before.reduce((s, e) => s + pct(e), 0) / before.length) * 100);
  return { trend: delta >= TREND_POINTS ? "UP" : delta <= -TREND_POINTS ? "DOWN" : "FLAT", trendDelta: delta };
}

/** Overall accuracy of the student, the prior every topic shrinks toward; the default until there are enough graded questions. */
export function priorOf(rows: Pick<Evidence, "questionCount" | "pendingCount" | "earned" | "possible">[]): number {
  let earned = 0;
  let possible = 0;
  let count = 0;
  for (const r of rows) {
    earned += r.earned;
    possible += r.possible;
    count += graded(r as Evidence);
  }
  return count >= 5 && possible > 0 ? earned / possible : DEFAULT_PRIOR;
}

export function computeMastery(evidence: Evidence[], prior = DEFAULT_PRIOR): TopicMastery | null {
  const usable = evidence.filter((e) => e.possible > 0 && graded(e) > 0).sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());
  if (!usable.length) return null;
  let wSum = 0;
  let wHit = 0;
  let earned = 0;
  let possible = 0;
  let count = 0;
  usable.forEach((e, k) => {
    const w = RECENCY_DECAY ** k * (e.origin === "EXAM" ? 1 : NON_EXAM_WEIGHT) * graded(e);
    wSum += w;
    wHit += w * Math.min(1, pct(e));
    earned += e.earned;
    possible += e.possible;
    count += graded(e);
  });
  const mastery = round1(((wHit + SHRINK_QUESTIONS * prior) / (wSum + SHRINK_QUESTIONS)) * 100);
  return {
    mastery,
    rawPct: round1((earned / possible) * 100),
    evidenceCount: count,
    examCount: usable.length,
    ...trendOf(usable),
    status: statusOf(mastery, count),
    lastEvidenceAt: usable[0].completedAt,
  };
}

export interface StatRow extends Evidence {
  dimension: GrowthDimension;
  topicKey: string;
  questionTopicId: string | null;
  label: string;
}

export interface MasteryRow extends TopicMastery {
  dimension: GrowthDimension;
  topicKey: string;
  questionTopicId: string | null;
  label: string;
}

/** Every topic and skill of one student; the untagged bucket only feeds the prior. */
export function masteryRows(stats: StatRow[]): MasteryRow[] {
  const prior = priorOf(stats.filter((s) => s.dimension === "TOPIC"));
  const groups = new Map<string, StatRow[]>();
  for (const s of stats) {
    if (s.topicKey === UNTAGGED_TOPIC_KEY) continue;
    const id = `${s.dimension}|${s.topicKey}`;
    groups.set(id, [...(groups.get(id) ?? []), s]);
  }
  const out: MasteryRow[] = [];
  for (const rows of groups.values()) {
    const m = computeMastery(rows, prior);
    if (!m) continue;
    const newest = rows.reduce((a, b) => (b.completedAt > a.completedAt ? b : a));
    out.push({ ...m, dimension: newest.dimension, topicKey: newest.topicKey, questionTopicId: newest.questionTopicId, label: newest.label });
  }
  return out;
}

export interface TopicGain {
  topicKey: string;
  label: string;
  mastery: number;
  status: MasteryStatus;
  /** Expected exam percentage points won by bringing the topic to the target. */
  gain: number;
  /** Share of the student's questions that were on this topic, 0–1. */
  share: number;
}

/** Low mastery is easier to lift a little from 40% than from 5%: a floor of 0.7 below 40%. */
export const feasibility = (m: number) => 0.7 + 0.3 * Math.min(1, m / 0.4);

/**
 * The topics worth the most exam points: how much of the exams the topic is (share), how far it is
 * below the target, how feasible the lift is, nudged up by how much of the lost points it caused.
 */
export function topGains(mastery: Pick<MasteryRow, "dimension" | "topicKey" | "label" | "mastery" | "status" | "evidenceCount">[], stats: StatRow[], limit = 3): TopicGain[] {
  const topicStats = stats.filter((s) => s.dimension === "TOPIC");
  const totalQuestions = topicStats.reduce((s, r) => s + r.questionCount, 0);
  const totalWrong = topicStats.reduce((s, r) => s + r.wrongPoints, 0);
  if (!totalQuestions) return [];
  const perTopic = new Map<string, { q: number; wrong: number }>();
  for (const s of topicStats) {
    const p = perTopic.get(s.topicKey) ?? { q: 0, wrong: 0 };
    p.q += s.questionCount;
    p.wrong += s.wrongPoints;
    perTopic.set(s.topicKey, p);
  }
  const gains: TopicGain[] = [];
  for (const m of mastery) {
    if (m.dimension !== "TOPIC" || m.evidenceCount < 2 || m.status === "STRONG") continue;
    const p = perTopic.get(m.topicKey);
    if (!p) continue;
    const share = p.q / totalQuestions;
    const level = m.mastery / 100;
    const wrongShare = totalWrong > 0 ? p.wrong / totalWrong : 0;
    const gain = share * 100 * Math.max(0, TARGET_MASTERY - level) * feasibility(level) * (1 + wrongShare);
    if (gain <= 0) continue;
    gains.push({ topicKey: m.topicKey, label: m.label, mastery: m.mastery, status: m.status, gain: round1(gain), share: Math.round(share * 1000) / 1000 });
  }
  return gains.sort((a, b) => b.gain - a.gain || a.mastery - b.mastery).slice(0, limit);
}

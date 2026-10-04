import type { Insight, RiskThresholds } from "../../shared/syllabusAnalytics";

/**
 * Rule-based teacher insights (§40), pure. Each insight is a code + numbers/names; the client turns
 * it into a sentence in the teacher's language. Thresholds below keep small samples from shouting.
 */

const MIN_SAMPLE = 3;
const LOW_PRACTICE_PCT = 60;
const LOW_SCORE_GAP = 15;
const HARD_LESSON_PCT = 50;
const HIGH_RETRY_PCT = 50;
const GROUP_GAP_PCT = 20;
const MAX_INSIGHTS = 8;

export interface InsightInput {
  overview: { atRisk: number; progress: { inactive: number } };
  students: ReadonlyArray<{ reasons: ReadonlyArray<{ code: string }> }>;
  lessons: ReadonlyArray<{ title: string; opened: number; completionRatePct: number | null; avgScorePct: number | null; attempters: number }>;
  modules: ReadonlyArray<{ title: string; retryRatePct: number | null; attempters: number }>;
  practice: ReadonlyArray<{ title: string; moduleTitle: string; reached: number; completionRatePct: number | null; awaitingReview: number }>;
  groups: ReadonlyArray<{ name: string; modules: ReadonlyArray<{ title: string; completed: number; of: number }> }>;
}

export function buildInsights(a: InsightInput, th: RiskThresholds): Insight[] {
  const out: Insight[] = [];
  if (a.overview.atRisk > 0) out.push({ code: "AT_RISK", severity: 1, params: { count: a.overview.atRisk } });

  const awaiting = a.practice.reduce((n, p) => n + p.awaitingReview, 0);
  if (awaiting > 0) out.push({ code: "AWAITING_REVIEW", severity: 1, params: { count: awaiting } });

  if (a.overview.progress.inactive > 0) out.push({ code: "INACTIVE_STUDENTS", severity: 2, params: { count: a.overview.progress.inactive, days: th.inactiveDays } });

  const notStarted = a.students.filter((s) => s.reasons.some((r) => r.code === "NOT_STARTED")).length;
  if (notStarted > 0) out.push({ code: "NOT_STARTED", severity: 2, params: { count: notStarted, days: th.inactiveDays } });

  a.practice
    .filter((p) => p.reached >= MIN_SAMPLE && p.completionRatePct !== null && p.completionRatePct < LOW_PRACTICE_PCT)
    .sort((x, y) => x.completionRatePct! - y.completionRatePct!)
    .slice(0, 2)
    .forEach((p) => out.push({ code: "LOW_PRACTICE_COMPLETION", severity: 2, params: { module: p.moduleTitle, task: p.title, pct: Math.round(p.completionRatePct!) } }));

  const scored = a.lessons.filter((l) => l.avgScorePct !== null && l.attempters >= MIN_SAMPLE);
  if (scored.length >= 2) {
    scored
      .map((l) => {
        const others = scored.filter((o) => o !== l);
        const avg = others.reduce((s, o) => s + o.avgScorePct!, 0) / others.length;
        return { l, gap: Math.round(avg - l.avgScorePct!) };
      })
      .filter((x) => x.gap >= LOW_SCORE_GAP)
      .sort((p, q) => q.gap - p.gap)
      .slice(0, 2)
      .forEach(({ l, gap }) => out.push({ code: "LOW_LESSON_SCORE", severity: 2, params: { lesson: l.title, gap } }));
  }

  const hard = a.lessons
    .filter((l) => l.opened >= MIN_SAMPLE && l.completionRatePct !== null && l.completionRatePct < HARD_LESSON_PCT)
    .sort((x, y) => x.completionRatePct! - y.completionRatePct!)[0];
  if (hard) out.push({ code: "HARD_LESSON", severity: 2, params: { lesson: hard.title, pct: Math.round(hard.completionRatePct!) } });

  const retry = a.modules
    .filter((m) => m.attempters >= MIN_SAMPLE && m.retryRatePct !== null && m.retryRatePct >= HIGH_RETRY_PCT)
    .sort((x, y) => y.retryRatePct! - x.retryRatePct!)[0];
  if (retry) out.push({ code: "HIGH_RETRY_MODULE", severity: 3, params: { module: retry.title, pct: Math.round(retry.retryRatePct!) } });

  // Group A finishes a module much more often than group B (spec example: "Group A Module 2-də Group B-dən sürətli").
  const comparable = a.groups.filter((g) => g.modules.length && g.modules[0].of >= 2);
  let best: { fast: string; slow: string; module: string; gap: number } | null = null;
  for (let i = 0; i < (comparable[0]?.modules.length ?? 0); i++) {
    const rates = comparable.map((g) => ({ name: g.name, title: g.modules[i]?.title ?? "", pct: g.modules[i] ? (g.modules[i].completed / g.modules[i].of) * 100 : 0 }));
    if (rates.length < 2) break;
    const sorted = [...rates].sort((p, q) => q.pct - p.pct);
    const gap = Math.round(sorted[0].pct - sorted[sorted.length - 1].pct);
    if (gap >= GROUP_GAP_PCT && (!best || gap > best.gap)) best = { fast: sorted[0].name, slow: sorted[sorted.length - 1].name, module: sorted[0].title, gap };
  }
  if (best) out.push({ code: "GROUP_AHEAD", severity: 3, params: best });

  return out.sort((p, q) => p.severity - q.severity).slice(0, MAX_INSIGHTS);
}

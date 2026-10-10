import type { MasteryStatus, PlanItemKind, PlanTargetSource } from "../../shared/growth";

/**
 * Review plan, pure. Weak topics (by expected point gain) get a cycle: study the material, practise,
 * then short reviews 3 and 7 days later (spaced repetition). A day never holds more than the
 * student's daily minutes; the last two days before the target are for review only. Undone items
 * roll over to the next free day at most three times, then they are skipped.
 */

const DAY_MS = 86_400_000;
export const DEFAULT_PLAN_DAYS = 14;
export const MAX_PLAN_DAYS = 42;
export const MAX_PLAN_TOPICS = 5;
export const MAX_ROLLOVERS = 3;
export const REVIEW_ONLY_DAYS = 2;
export const REVIEW_OFFSETS = [3, 7];
export const MINUTES: Record<PlanItemKind, number> = { MATERIAL: 20, PRACTICE: 15, REVIEW: 10 };

export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Nearest assigned exam, else the student's target exam date, else two weeks from today. */
export function planTarget(today: string, nextExamDay: string | null, targetExamDay: string | null): { targetDay: string; source: PlanTargetSource } {
  const future = (d: string | null) => (d && daysBetween(today, d) >= 1 ? d : null);
  const exam = future(nextExamDay);
  if (exam) return { targetDay: daysBetween(today, exam) > MAX_PLAN_DAYS ? addDays(today, MAX_PLAN_DAYS) : exam, source: "EXAM" };
  const target = future(targetExamDay);
  if (target) return { targetDay: daysBetween(today, target) > MAX_PLAN_DAYS ? addDays(today, MAX_PLAN_DAYS) : target, source: "TARGET_DATE" };
  return { targetDay: addDays(today, DEFAULT_PLAN_DAYS), source: "DEFAULT" };
}

export interface PlanTopic {
  topicKey: string;
  label: string;
  mastery: number;
  status: MasteryStatus;
  gain: number;
}

export interface PlanItemDraft {
  dayKey: string;
  topicKey: string;
  label: string;
  kind: PlanItemKind;
  minutes: number;
}

/** Topics worth planning: priority and review ones, highest gain first. */
export function planTopics(topics: PlanTopic[]): PlanTopic[] {
  return topics
    .filter((t) => t.status === "CRITICAL" || t.status === "REVIEW")
    .sort((a, b) => b.gain - a.gain || a.mastery - b.mastery)
    .slice(0, MAX_PLAN_TOPICS);
}

export function buildPlan(input: { today: string; targetDay: string; dailyMinutes: number; topics: PlanTopic[] }): PlanItemDraft[] {
  const span = Math.max(1, Math.min(MAX_PLAN_DAYS, daysBetween(input.today, input.targetDay)));
  const days = Array.from({ length: span }, (_, i) => addDays(input.today, i));
  const capacity = Math.max(MINUTES.REVIEW, input.dailyMinutes);
  const used = new Map(days.map((d) => [d, 0]));
  const lastStudyIndex = Math.max(0, days.length - 1 - REVIEW_ONLY_DAYS);
  const items: PlanItemDraft[] = [];

  /** First day at or after `from` (and not after `until`) with room for `minutes`; null when none. */
  const slot = (from: number, minutes: number, until = days.length - 1) => {
    for (let i = Math.max(0, from); i <= until; i++) if (used.get(days[i])! + minutes <= capacity) return i;
    return null;
  };
  const put = (i: number, t: PlanTopic, kind: PlanItemKind) => {
    used.set(days[i], used.get(days[i])! + MINUTES[kind]);
    items.push({ dayKey: days[i], topicKey: t.topicKey, label: t.label, kind, minutes: MINUTES[kind] });
  };

  const topics = planTopics(input.topics);
  // A second cycle for priority topics when the plan is long enough.
  const cycles = topics.flatMap((t) => (t.status === "CRITICAL" && days.length >= 10 ? [t, t] : [t]));
  const order = [...topics, ...cycles.slice(topics.length)];
  let cursor = 0;
  const lastCycleDay = new Map<string, number>();
  for (const t of order) {
    const from = lastCycleDay.has(t.topicKey) ? lastCycleDay.get(t.topicKey)! + 4 : cursor;
    const study = slot(from, MINUTES.MATERIAL, lastStudyIndex);
    if (study == null) continue;
    put(study, t, "MATERIAL");
    const practice = slot(study, MINUTES.PRACTICE, lastStudyIndex);
    if (practice != null) put(practice, t, "PRACTICE");
    for (const offset of REVIEW_OFFSETS) {
      const review = slot(study + offset, MINUTES.REVIEW);
      if (review != null && study + offset < days.length) put(review, t, "REVIEW");
    }
    lastCycleDay.set(t.topicKey, study);
    cursor = study + 1 >= lastStudyIndex ? 0 : study + 1;
  }
  // Final review days: the most valuable topics once more, if not already reviewed that day.
  for (let i = Math.max(0, days.length - REVIEW_ONLY_DAYS); i < days.length; i++) {
    for (const t of topics) {
      if (items.some((x) => x.dayKey === days[i] && x.topicKey === t.topicKey)) continue;
      if (used.get(days[i])! + MINUTES.REVIEW <= capacity) put(i, t, "REVIEW");
    }
  }
  return items.sort((a, b) => a.dayKey.localeCompare(b.dayKey) || kindOrder(a.kind) - kindOrder(b.kind));
}

const kindOrder = (k: PlanItemKind) => ({ MATERIAL: 0, PRACTICE: 1, REVIEW: 2 })[k];

export interface OpenItem {
  id: string;
  dayKey: string;
  minutes: number;
  rolloverCount: number;
}

/**
 * Undone items from past days: to the first day from today with room (the plan end at the latest),
 * one more rollover each; after the third they are skipped.
 */
export function rollover(open: OpenItem[], scheduled: { dayKey: string; minutes: number }[], today: string, targetDay: string, dailyMinutes: number) {
  const used = new Map<string, number>();
  for (const s of scheduled) if (s.dayKey >= today) used.set(s.dayKey, (used.get(s.dayKey) ?? 0) + s.minutes);
  const last = daysBetween(today, targetDay) >= 1 ? addDays(targetDay, -1) : today;
  const moves: { id: string; dayKey: string; rolloverCount: number }[] = [];
  const skips: string[] = [];
  for (const item of [...open].sort((a, b) => a.dayKey.localeCompare(b.dayKey))) {
    if (item.dayKey >= today) continue;
    if (item.rolloverCount >= MAX_ROLLOVERS) {
      skips.push(item.id);
      continue;
    }
    let day = today;
    while (day < last && (used.get(day) ?? 0) + item.minutes > Math.max(dailyMinutes, item.minutes)) day = addDays(day, 1);
    used.set(day, (used.get(day) ?? 0) + item.minutes);
    moves.push({ id: item.id, dayKey: day, rolloverCount: item.rolloverCount + 1 });
  }
  return { moves, skips };
}

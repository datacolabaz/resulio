import type { MasteryStatus } from "../../shared/growth";
import { addDays } from "./plan";

/** XP, pure. Personal only: XP, level and streak; there is no leaderboard. */

export const XP = {
  ITEM_DONE: 10,
  PRACTICE_DONE: 20,
  PRACTICE_GOOD_BONUS: 10,
  PRACTICE_GOOD_AT: 70,
  WEEK_COMPLETE: 50,
  CRITICAL_TO_REVIEW: 30,
  REVIEW_TO_STRONG: 50,
  STREAK_DAY: 5,
} as const;

export const levelOf = (xp: number) => Math.floor(Math.sqrt(Math.max(0, xp) / 50));
export const xpForLevel = (level: number) => 50 * level * level;

export function levelProgress(xp: number) {
  const level = levelOf(xp);
  const from = xpForLevel(level);
  const to = xpForLevel(level + 1);
  return { level, xp, from, to, pct: Math.round(((xp - from) / (to - from)) * 100) };
}

/** Points for a topic moving up; 0 for anything else (moving down never costs XP). */
export function statusUpXp(from: MasteryStatus | null, to: MasteryStatus): number {
  if (from === "CRITICAL" && to === "REVIEW") return XP.CRITICAL_TO_REVIEW;
  if (from === "REVIEW" && to === "STRONG") return XP.REVIEW_TO_STRONG;
  if (from === "CRITICAL" && to === "STRONG") return XP.CRITICAL_TO_REVIEW + XP.REVIEW_TO_STRONG;
  return 0;
}

/** Activity on `today` (Baku day key): same day keeps the streak, the next day extends it, a gap restarts it. */
export function nextStreak(prev: { streak: number; longestStreak: number; lastActiveDay: string | null }, today: string) {
  if (prev.lastActiveDay === today) return { ...prev, extended: false };
  const streak = prev.lastActiveDay && addDays(prev.lastActiveDay, 1) === today ? prev.streak + 1 : 1;
  return { streak, longestStreak: Math.max(prev.longestStreak, streak), lastActiveDay: today, extended: true };
}

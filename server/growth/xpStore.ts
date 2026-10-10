import { desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { studentXp, xpEvents } from "../../drizzle/schema";
import type { XpType } from "../../shared/growth";
import { requireDb } from "../db";
import { dayKey } from "../modules/motivation";
import { levelOf, levelProgress, nextStreak, XP } from "./xp";

const isDuplicateKey = (e: unknown): boolean => {
  for (let cur = e, depth = 0; cur && typeof cur === "object" && depth < 5; cur = (cur as { cause?: unknown }).cause, depth++) {
    if ((cur as { code?: unknown }).code === "ER_DUP_ENTRY") return true;
  }
  return false;
};

/**
 * One XP award, at most once per (student, refKey). `activity` awards (a finished item or practice)
 * also move the daily streak, and the first activity of a new day earns the streak bonus.
 * Returns whether this call awarded it.
 */
export async function awardXp(input: { studentId: number; workspaceId: string; type: XpType; points: number; refKey: string; activity?: boolean }, now = new Date()): Promise<boolean> {
  if (input.points <= 0) return false;
  const db = requireDb();
  try {
    await db.insert(xpEvents).values({ id: nanoid(), studentId: input.studentId, workspaceId: input.workspaceId, type: input.type, points: input.points, refKey: input.refKey.slice(0, 191) });
  } catch (error) {
    if (isDuplicateKey(error)) return false;
    throw error;
  }
  const [prev] = await db.select().from(studentXp).where(eq(studentXp.studentId, input.studentId)).limit(1);
  const streak = input.activity
    ? nextStreak({ streak: prev?.streak ?? 0, longestStreak: prev?.longestStreak ?? 0, lastActiveDay: prev?.lastActiveDay ?? null }, dayKey(now))
    : { streak: prev?.streak ?? 0, longestStreak: prev?.longestStreak ?? 0, lastActiveDay: prev?.lastActiveDay ?? null, extended: false };
  await syncTotals(input.studentId, streak);
  if (streak.extended && streak.streak > 1) {
    await awardXp({ studentId: input.studentId, workspaceId: input.workspaceId, type: "STREAK_DAY", points: XP.STREAK_DAY, refKey: `streak:${streak.lastActiveDay}` }, now);
  }
  return true;
}

/** Totals are always the ledger's sum, so a retried award can never double them. */
async function syncTotals(studentId: number, streak: { streak: number; longestStreak: number; lastActiveDay: string | null }) {
  const db = requireDb();
  const [sum] = await db.select({ xp: sql<number>`coalesce(sum(${xpEvents.points}), 0)` }).from(xpEvents).where(eq(xpEvents.studentId, studentId));
  const xp = Number(sum?.xp ?? 0);
  const values = { xp, level: levelOf(xp), streak: streak.streak, longestStreak: streak.longestStreak, lastActiveDay: streak.lastActiveDay };
  await db.insert(studentXp).values({ studentId, ...values }).onDuplicateKeyUpdate({ set: values });
}

export async function xpSummary(studentId: number, now = new Date()) {
  const db = requireDb();
  const [row] = await db.select().from(studentXp).where(eq(studentXp.studentId, studentId)).limit(1);
  const recent = await db
    .select({ type: xpEvents.type, points: xpEvents.points, createdAt: xpEvents.createdAt })
    .from(xpEvents)
    .where(eq(xpEvents.studentId, studentId))
    .orderBy(desc(xpEvents.createdAt))
    .limit(10);
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000));
  // A streak whose last day is before yesterday is already broken.
  const alive = row?.lastActiveDay === today || row?.lastActiveDay === yesterday;
  return { ...levelProgress(row?.xp ?? 0), streak: alive ? (row?.streak ?? 0) : 0, longestStreak: row?.longestStreak ?? 0, activeToday: row?.lastActiveDay === today, recent };
}

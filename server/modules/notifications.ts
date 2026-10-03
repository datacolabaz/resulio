import { and, desc, eq, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { notificationDedupe, notifications } from "../../drizzle/schema";
import { requireDb } from "../db";

export async function notify(userId: number, title: string, body: string) {
  await requireDb().insert(notifications).values({ id: nanoid(), userId, title, body });
}

/** A deduplicated notification may go out again once its last send is at or before this instant. */
export function dedupeCutoff(now: Date, windowMs: number): Date {
  return new Date(now.getTime() - windowMs);
}

/**
 * Like `notify`, but skipped if this user already got the notification `dedupeKey` within
 * `windowMs`. The claim is a single INSERT IGNORE / conditional UPDATE, so concurrent callers
 * (several reviews finishing at once, several server instances) send it once.
 */
export async function notifyOnce(userId: number, dedupeKey: string, windowMs: number, title: string, body: string): Promise<boolean> {
  const db = requireDb();
  const now = new Date();
  const [inserted] = await db.insert(notificationDedupe).ignore().values({ userId, dedupeKey, lastSentAt: now });
  if (inserted.affectedRows !== 1) {
    const [renewed] = await db
      .update(notificationDedupe)
      .set({ lastSentAt: now })
      .where(and(eq(notificationDedupe.userId, userId), eq(notificationDedupe.dedupeKey, dedupeKey), lte(notificationDedupe.lastSentAt, dedupeCutoff(now, windowMs))));
    if (renewed.affectedRows !== 1) return false;
  }
  await notify(userId, title, body);
  return true;
}

/** Newest first, capped at 100 — matches the in-memory store's prior behavior before this was persisted. */
export async function listFor(userId: number) {
  return requireDb()
    .select({ id: notifications.id, title: notifications.title, body: notifications.body, read: notifications.isRead, createdAt: notifications.createdAt })
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(100);
}

export async function markRead(userId: number, id: string) {
  await requireDb().update(notifications).set({ isRead: true }).where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
}

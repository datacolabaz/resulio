import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { notifications } from "../../drizzle/schema";
import { requireDb } from "../db";

export async function notify(userId: number, title: string, body: string) {
  await requireDb().insert(notifications).values({ id: nanoid(), userId, title, body });
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

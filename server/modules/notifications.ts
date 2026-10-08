import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { notificationDedupe, notificationDeliveries, notifications } from "../../drizzle/schema";
import { requireDb } from "../db";
import { isMissingTable } from "../notifications/preferences";
import { notificationPath } from "../notifications/render";

/**
 * An in-app notice sent through the outbox gets the id `d<deliveryId>`: the inbox finds its event
 * (and so its link) through that row, and a retried delivery cannot store the notice twice.
 */
export const inAppNotificationId = (deliveryId: number) => `d${deliveryId}`;
const deliveryIdOf = (notificationId: string) => (/^d\d{1,18}$/.test(notificationId) ? Number(notificationId.slice(1)) : null);

export async function notify(userId: number, title: string, body: string, deliveryId?: number) {
  if (deliveryId === undefined) {
    await requireDb().insert(notifications).values({ id: nanoid(), userId, title, body });
    return;
  }
  await requireDb().insert(notifications).ignore().values({ id: inAppNotificationId(deliveryId), userId, title, body });
}

/** A deduplicated notification may go out again once its last send is at or before this instant. */
export function dedupeCutoff(now: Date, windowMs: number): Date {
  return new Date(now.getTime() - windowMs);
}

/**
 * True at most once per `windowMs` for this user and `dedupeKey` (throttle for repeating alerts).
 * The claim is a single INSERT IGNORE / conditional UPDATE, so concurrent callers (several
 * reviews finishing at once, several server instances) get true once.
 */
export async function claimOnce(userId: number, dedupeKey: string, windowMs: number): Promise<boolean> {
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
  return true;
}

/** The app path each outbox-sent notice leads to (deliveryId → path), read from this user's own deliveries. */
async function pathsOf(userId: number, deliveryIds: number[]) {
  const paths = new Map<number, string>();
  if (!deliveryIds.length) return paths;
  try {
    const rows = await requireDb()
      .select({ id: notificationDeliveries.id, event: notificationDeliveries.event, payload: notificationDeliveries.payload })
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.userId, userId), inArray(notificationDeliveries.id, deliveryIds)));
    for (const r of rows) {
      const path = notificationPath(r.event, r.payload);
      if (path) paths.set(r.id, path);
    }
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  return paths;
}

/** Newest first, capped at 100 — matches the in-memory store's prior behavior before this was persisted. */
export async function listFor(userId: number) {
  const rows = await requireDb()
    .select({ id: notifications.id, title: notifications.title, body: notifications.body, read: notifications.isRead, createdAt: notifications.createdAt })
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(100);
  const paths = await pathsOf(userId, rows.flatMap((r) => deliveryIdOf(r.id) ?? []));
  return rows.map((r) => {
    const deliveryId = deliveryIdOf(r.id);
    return { ...r, path: deliveryId === null ? null : (paths.get(deliveryId) ?? null) };
  });
}

export async function markRead(userId: number, id: string) {
  await requireDb().update(notifications).set({ isRead: true }).where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
}

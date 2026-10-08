import { randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, like, sql } from "drizzle-orm";
import {
  audiencePlan,
  pickAnnouncementText,
  type AnnouncementAudience,
  type AnnouncementLanguage,
  type AnnouncementStatus,
  type AnnouncementTexts,
} from "../../shared/announcements";
import { announcementDeliveries, announcements, groupMembers, notificationDeliveries, providerWorkspaces, users } from "../../drizzle/schema";
import { getDb, requireDb } from "../db";
import { appendAudit } from "../modules/admin/audit";
import type { AdminContext } from "../modules/admin/authz";
import { AppError } from "../modules/errors";
import { dispatchManyNow, type DispatchInput } from "./dispatcher";
import { isMissingTable } from "./preferences";
import { anonymousSubscriptions, dbStoreOps, deliverWebPush, webPushSendFromEnv, type WebPushSend, type WebPushStoreOps, type WebPushTarget } from "./webPush";

/**
 * Admin announcements. Signed-in recipients go through the notification dispatcher (event
 * ANNOUNCEMENT: in-app feed + every push device, preferences respected, one outbox row per user so
 * a resumed run never repeats). Anonymous browser subscribers get Web Push directly; each one is
 * claimed in `announcement_deliveries` before sending. Runs in the background after the request.
 */

export interface AnnouncementRecord {
  id: number;
  audience: AnnouncementAudience;
  language: AnnouncementLanguage;
  texts: AnnouncementTexts;
  url: string;
}

export interface AnnouncementTotals {
  targetUsers: number;
  targetAnonymous: number;
  inAppSent: number;
  pushSent: number;
  pushFailed: number;
}

export type AnonymousTarget = WebPushTarget & { locale: string };

export interface AnnouncementRunnerDeps {
  /** QUEUED/SENDING -> SENDING; null when the announcement is finished or unknown. */
  claim(id: number): Promise<AnnouncementRecord | null>;
  userBatch(segment: "ALL" | "TEACHERS" | "STUDENTS", afterId: number, limit: number): Promise<number[]>;
  dispatchMany(inputs: DispatchInput[]): Promise<void>;
  anonymousBatch(afterId: number, limit: number): Promise<AnonymousTarget[]>;
  /** Claims a delivery row per subscription; returns only the ids this call claimed (never claimed before). */
  claimDeliveries(announcementId: number, subscriptionIds: number[]): Promise<number[]>;
  finishDeliveries(announcementId: number, rows: Array<{ subscriptionId: number; status: "SENT" | "FAILED" | "GONE" }>): Promise<void>;
  send: () => WebPushSend | null;
  ops: WebPushStoreOps;
  /** Totals of the user part, read from the dispatcher's outbox. */
  userTotals(announcementId: number): Promise<{ inAppSent: number; pushSent: number; pushFailed: number }>;
  anonymousTotals(announcementId: number): Promise<{ sent: number; failed: number }>;
  finish(id: number, status: AnnouncementStatus, totals: AnnouncementTotals, error: string | null): Promise<void>;
}

export const BATCH_SIZE = 500;
export const announcementDedupeKey = (announcementId: number, userId: number) => `announcement:${announcementId}:${userId}`;
const ANNOUNCEMENT_PUSH = { ttlSeconds: 3 * 24 * 60 * 60, urgency: "normal" } as const;

export function createAnnouncementRunner(deps: AnnouncementRunnerDeps) {
  return async function run(id: number): Promise<AnnouncementTotals | null> {
    const a = await deps.claim(id);
    if (!a) return null;
    const plan = audiencePlan(a.audience);
    const totals: AnnouncementTotals = { targetUsers: 0, targetAnonymous: 0, inAppSent: 0, pushSent: 0, pushFailed: 0 };
    try {
      if (plan.users) {
        const data = { announcementId: a.id, language: a.language, texts: a.texts, url: a.url };
        for (let after = 0; ; ) {
          const ids = await deps.userBatch(plan.users, after, BATCH_SIZE);
          if (!ids.length) break;
          totals.targetUsers += ids.length;
          await deps.dispatchMany(ids.map((userId) => ({ event: "ANNOUNCEMENT", userId, dedupeKey: announcementDedupeKey(a.id, userId), data })));
          after = ids[ids.length - 1];
        }
      }
      const send = deps.send();
      if (plan.anonymous && send) {
        for (let after = 0; ; ) {
          const batch = await deps.anonymousBatch(after, BATCH_SIZE);
          if (!batch.length) break;
          totals.targetAnonymous += batch.length;
          after = batch[batch.length - 1].id;
          const claimed = new Set(await deps.claimDeliveries(a.id, batch.map((s) => s.id)));
          const byLocale = new Map<string, AnonymousTarget[]>();
          for (const s of batch) if (claimed.has(s.id)) byLocale.set(s.locale, [...(byLocale.get(s.locale) ?? []), s]);
          for (const [locale, targets] of byLocale) {
            const text = pickAnnouncementText(a.texts, a.language, locale);
            if (!text) continue;
            const summary = await deliverWebPush(targets, { title: text.title, body: text.body, url: a.url, tag: `announcement-${a.id}` }, send, deps.ops, ANNOUNCEMENT_PUSH, 10);
            await deps.finishDeliveries(
              a.id,
              targets.map((t, i) => {
                const r = summary.results[i];
                return { subscriptionId: t.id, status: r.ok ? "SENT" : r.gone ? "GONE" : "FAILED" };
              }),
            );
          }
        }
      }
      const user = await deps.userTotals(a.id);
      const anon = await deps.anonymousTotals(a.id);
      Object.assign(totals, { inAppSent: user.inAppSent, pushSent: user.pushSent + anon.sent, pushFailed: user.pushFailed + anon.failed });
      await deps.finish(a.id, "SENT", totals, null);
    } catch (error) {
      await deps.finish(a.id, "FAILED", totals, (error instanceof Error ? error.message : "ERROR").slice(0, 255));
    }
    return totals;
  };
}

// ---------------------------------------------------------------------------
// MySQL wiring
// ---------------------------------------------------------------------------

const ACTIVE_USER = eq(users.accountStatus, "ACTIVE");

const mysqlDeps: AnnouncementRunnerDeps = {
  async claim(id) {
    const db = requireDb();
    const [result] = await db
      .update(announcements)
      .set({ status: "SENDING", startedAt: sql`coalesce(${announcements.startedAt}, now())` })
      .where(and(eq(announcements.id, id), inArray(announcements.status, ["QUEUED", "SENDING"])));
    if (result.affectedRows !== 1) return null;
    const [row] = await db.select().from(announcements).where(eq(announcements.id, id)).limit(1);
    return row ? { id: row.id, audience: row.audience, language: row.language as AnnouncementLanguage, texts: row.texts, url: row.url } : null;
  },
  async userBatch(segment, afterId, limit) {
    const db = requireDb();
    const filters = [ACTIVE_USER, gt(users.id, afterId)];
    if (segment === "TEACHERS") filters.push(inArray(users.id, db.select({ id: providerWorkspaces.ownerUserId }).from(providerWorkspaces)));
    if (segment === "STUDENTS") filters.push(inArray(users.id, db.select({ id: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.status, "ACTIVE"))));
    const rows = await db.select({ id: users.id }).from(users).where(and(...filters)).orderBy(asc(users.id)).limit(limit);
    return rows.map((r) => r.id);
  },
  dispatchMany: (inputs) => dispatchManyNow(inputs, 8),
  anonymousBatch: anonymousSubscriptions,
  /**
   * INSERT IGNORE with a per-call token as the status, then read back the rows carrying it: only
   * those were claimed here, even when two API instances run the same announcement at once. A row
   * left with a token after a crash is never retried (at most once beats a duplicate push).
   */
  async claimDeliveries(announcementId, subscriptionIds) {
    if (!subscriptionIds.length) return [];
    const db = requireDb();
    const token = `C${randomBytes(6).toString("hex")}`;
    await db.insert(announcementDeliveries).ignore().values(subscriptionIds.map((subscriptionId) => ({ announcementId, subscriptionId, status: token })));
    const mine = await db
      .select({ id: announcementDeliveries.subscriptionId })
      .from(announcementDeliveries)
      .where(and(eq(announcementDeliveries.announcementId, announcementId), eq(announcementDeliveries.status, token)));
    return mine.map((r) => r.id);
  },
  async finishDeliveries(announcementId, rows) {
    const db = requireDb();
    for (const status of ["SENT", "FAILED", "GONE"] as const) {
      const ids = rows.filter((r) => r.status === status).map((r) => r.subscriptionId);
      if (ids.length) await db.update(announcementDeliveries).set({ status }).where(and(eq(announcementDeliveries.announcementId, announcementId), inArray(announcementDeliveries.subscriptionId, ids)));
    }
  },
  send: () => webPushSendFromEnv(),
  ops: dbStoreOps,
  async userTotals(announcementId) {
    const t = notificationDeliveries;
    const rows = await requireDb()
      .select({ channel: t.channel, status: t.status, n: count() })
      .from(t)
      .where(like(t.dedupeKey, `announcement:${announcementId}:%`))
      .groupBy(t.channel, t.status);
    const n = (channel: string, status: string) => Number(rows.find((r) => r.channel === channel && r.status === status)?.n ?? 0);
    return { inAppSent: n("IN_APP", "SENT"), pushSent: n("PUSH", "SENT"), pushFailed: n("PUSH", "FAILED") };
  },
  async anonymousTotals(announcementId) {
    const rows = await requireDb()
      .select({ status: announcementDeliveries.status, n: count() })
      .from(announcementDeliveries)
      .where(eq(announcementDeliveries.announcementId, announcementId))
      .groupBy(announcementDeliveries.status);
    const n = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
    return { sent: n("SENT"), failed: n("FAILED") + n("GONE") };
  },
  async finish(id, status, totals, error) {
    await requireDb().update(announcements).set({ status, ...totals, error, finishedAt: new Date() }).where(eq(announcements.id, id));
  },
};

const runAnnouncement = createAnnouncementRunner(mysqlDeps);
const running = new Set<number>();

function startInBackground(id: number) {
  if (running.has(id)) return;
  running.add(id);
  setImmediate(() => {
    runAnnouncement(id)
      .catch((error) => console.error("[announcements] run failed", id, error instanceof Error ? error.message : error))
      .finally(() => running.delete(id));
  });
}

export interface NewAnnouncement {
  audience: AnnouncementAudience;
  language: AnnouncementLanguage;
  texts: AnnouncementTexts;
  url: string;
}

/** Stores the announcement (audited) and starts sending; returns at once. */
export async function createAnnouncement(admin: AdminContext, input: NewAnnouncement) {
  const db = requireDb();
  const id = await db
    .transaction(async (tx) => {
      const [result] = await tx.insert(announcements).values({ ...input, createdByUserId: admin.userId });
      const newId = Number(result.insertId);
      await appendAudit(
        tx,
        admin,
        { action: "ANNOUNCEMENT_SENT", targetType: "ANNOUNCEMENT", targetId: newId, after: { audience: input.audience, language: input.language, url: input.url } },
        admin.meta,
      );
      return newId;
    })
    .catch((error) => {
      throw isMissingTable(error) ? new AppError("DATABASE_UNAVAILABLE") : error;
    });
  startInBackground(id);
  return { id };
}

export async function listAnnouncements(limit = 50) {
  try {
    return await requireDb().select().from(announcements).orderBy(desc(announcements.id)).limit(limit);
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

/** After a restart: finish whatever was queued or half-sent (idempotent, see above). */
export async function resumeAnnouncements() {
  if (!getDb()) return;
  try {
    const rows = await requireDb()
      .select({ id: announcements.id })
      .from(announcements)
      .where(inArray(announcements.status, ["QUEUED", "SENDING"]))
      .orderBy(asc(announcements.id));
    for (const r of rows) startInBackground(r.id);
  } catch (error) {
    if (!isMissingTable(error)) console.error("[announcements] resume failed", error instanceof Error ? error.message : error);
  }
}

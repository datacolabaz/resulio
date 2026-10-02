import { and, eq, sql } from "drizzle-orm";
import { shareEvents } from "../../drizzle/schema";
import type { ShareCampaign, ShareChannel, ShareEventType, ShareFunnel, ShareTargetType } from "../../shared/shareTracking";
import { SHARE_CHANNELS } from "../../shared/shareTracking";
import { getDb, requireDb } from "../db";

/**
 * Best-effort write: a missed click/open/join log must never break the page that triggered it
 * (the public join flow, the teacher's share panel, ...), so every failure is swallowed here --
 * the same choice server/modules/files.ts makes for recordDownload.
 */
export async function recordShareEvent(e: {
  targetType: ShareTargetType;
  targetId: string;
  channel: ShareChannel;
  eventType: ShareEventType;
  campaign?: ShareCampaign | string | null;
  actorUserId?: number | null;
}) {
  try {
    const db = getDb();
    if (!db) return;
    await db.insert(shareEvents).values({
      targetType: e.targetType,
      targetId: e.targetId,
      channel: e.channel,
      eventType: e.eventType,
      campaign: e.campaign ?? null,
      actorUserId: e.actorUserId ?? null,
    });
  } catch (error) {
    console.error("[shareTracking] recordShareEvent failed", error);
  }
}

/** Teacher/partner-facing read: how many clicks/opens/joins each channel produced for one share target. */
export async function shareFunnel(targetType: ShareTargetType, targetId: string): Promise<ShareFunnel> {
  const rows = await requireDb()
    .select({ channel: shareEvents.channel, eventType: shareEvents.eventType, count: sql<number>`count(*)` })
    .from(shareEvents)
    .where(and(eq(shareEvents.targetType, targetType), eq(shareEvents.targetId, targetId)))
    .groupBy(shareEvents.channel, shareEvents.eventType);

  const byChannel = Object.fromEntries(
    SHARE_CHANNELS.map((c) => [c, { clicked: 0, opened: 0, joined: 0 }]),
  ) as ShareFunnel["byChannel"];
  const totals = { clicked: 0, opened: 0, joined: 0 };
  for (const r of rows) {
    const n = Number(r.count);
    const key = r.eventType === "CLICKED" ? "clicked" : r.eventType === "OPENED" ? "opened" : "joined";
    byChannel[r.channel][key] += n;
    totals[key] += n;
  }
  return { byChannel, totals };
}

import { and, eq } from "drizzle-orm";
import { shareEvents } from "../../drizzle/schema";
import type {
  ShareCampaign,
  ShareChannel,
  ShareChannelStats,
  ShareEventType,
  ShareFunnel,
  ShareTargetType,
} from "../../shared/shareTracking";
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
  visitorId?: string | null;
}) {
  try {
    const db = getDb();
    if (!db) return;
    // A student re-claiming the same task (or re-joining) is still one join.
    if (e.eventType === "JOINED" && e.actorUserId) {
      const [already] = await db
        .select({ id: shareEvents.id })
        .from(shareEvents)
        .where(
          and(
            eq(shareEvents.targetType, e.targetType),
            eq(shareEvents.targetId, e.targetId),
            eq(shareEvents.eventType, "JOINED"),
            eq(shareEvents.actorUserId, e.actorUserId),
          ),
        )
        .limit(1);
      if (already) return;
    }
    await db.insert(shareEvents).values({
      targetType: e.targetType,
      targetId: e.targetId,
      channel: e.channel,
      eventType: e.eventType,
      campaign: e.campaign ?? null,
      actorUserId: e.actorUserId ?? null,
      visitorId: e.visitorId ?? null,
    });
  } catch (error) {
    console.error("[shareTracking] recordShareEvent failed", error);
  }
}

export type ShareEventRow = {
  id: number;
  channel: ShareChannel;
  eventType: ShareEventType;
  actorUserId: number | null;
  visitorId: string | null;
  createdAt: Date;
};

export async function shareEventsFor(targetType: ShareTargetType, targetId: string): Promise<ShareEventRow[]> {
  return requireDb()
    .select({
      id: shareEvents.id,
      channel: shareEvents.channel,
      eventType: shareEvents.eventType,
      actorUserId: shareEvents.actorUserId,
      visitorId: shareEvents.visitorId,
      createdAt: shareEvents.createdAt,
    })
    .from(shareEvents)
    .where(and(eq(shareEvents.targetType, targetType), eq(shareEvents.targetId, targetId)))
    .orderBy(shareEvents.createdAt, shareEvents.id);
}

/**
 * Resolves who is behind each recipient-side row: the signed-in user, else the user that same
 * browser (visitorId) later signed in as, else the anonymous browser itself. Rows from before
 * visitor ids existed count as one person each.
 */
export function identifyPeople(rows: ShareEventRow[]) {
  const userOfVisitor = new Map<string, number>();
  for (const r of rows) if (r.visitorId && r.actorUserId && !userOfVisitor.has(r.visitorId)) userOfVisitor.set(r.visitorId, r.actorUserId);
  const userOf = (r: ShareEventRow): number | null => r.actorUserId ?? (r.visitorId ? userOfVisitor.get(r.visitorId) ?? null : null);
  const personKey = (r: ShareEventRow): string => {
    const userId = userOf(r);
    if (userId !== null) return `u:${userId}`;
    return r.visitorId ? `v:${r.visitorId}` : `r:${r.id}`;
  };
  return { userOf, personKey };
}

const emptyStats = (): ShareChannelStats => ({ clicked: 0, opened: 0, openedUnique: 0, downloaded: 0, downloadedUnique: 0, joined: 0, submitted: 0 });

/**
 * Pure: per-channel counts. CLICKED is the sender's own button press and is always kept; every
 * recipient-side row belonging to `excludeUserIds` (the link's owner previewing it) is dropped.
 * `submittedUserIds` credits each submitter to the channel of their first recipient-side event.
 */
export function buildFunnel(rows: ShareEventRow[], opts: { excludeUserIds?: number[]; submittedUserIds?: number[] } = {}): ShareFunnel {
  const { userOf, personKey } = identifyPeople(rows);
  const excluded = new Set(opts.excludeUserIds ?? []);
  const byChannel = Object.fromEntries(SHARE_CHANNELS.map((c) => [c, emptyStats()])) as ShareFunnel["byChannel"];
  const totals = emptyStats();
  const unique = { opened: new Map<ShareChannel, Set<string>>(), downloaded: new Map<ShareChannel, Set<string>>() };
  const uniqueTotals = { opened: new Set<string>(), downloaded: new Set<string>() };
  const firstChannelOfUser = new Map<number, ShareChannel>();

  for (const r of rows) {
    if (r.eventType === "CLICKED") {
      byChannel[r.channel].clicked++;
      totals.clicked++;
      continue;
    }
    const userId = userOf(r);
    if (userId !== null && excluded.has(userId)) continue;
    if (userId !== null && !firstChannelOfUser.has(userId)) firstChannelOfUser.set(userId, r.channel);
    if (r.eventType === "JOINED") {
      byChannel[r.channel].joined++;
      totals.joined++;
      continue;
    }
    const kind = r.eventType === "OPENED" ? "opened" : "downloaded";
    byChannel[r.channel][kind]++;
    totals[kind]++;
    const key = personKey(r);
    const perChannel = unique[kind].get(r.channel) ?? new Set<string>();
    perChannel.add(key);
    unique[kind].set(r.channel, perChannel);
    uniqueTotals[kind].add(key);
  }
  for (const c of SHARE_CHANNELS) {
    byChannel[c].openedUnique = unique.opened.get(c)?.size ?? 0;
    byChannel[c].downloadedUnique = unique.downloaded.get(c)?.size ?? 0;
  }
  totals.openedUnique = uniqueTotals.opened.size;
  totals.downloadedUnique = uniqueTotals.downloaded.size;
  for (const userId of new Set(opts.submittedUserIds ?? [])) {
    const channel = firstChannelOfUser.get(userId);
    if (!channel) continue;
    byChannel[channel].submitted++;
    totals.submitted++;
  }
  return { byChannel, totals };
}

/** Teacher/partner-facing read: what each channel produced for one share target, excluding the owner's own visits. */
export async function shareFunnel(targetType: ShareTargetType, targetId: string, opts: { excludeUserIds?: number[] } = {}): Promise<ShareFunnel> {
  return buildFunnel(await shareEventsFor(targetType, targetId), opts);
}

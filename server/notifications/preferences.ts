import { eq } from "drizzle-orm";
import { notificationPreferences } from "../../drizzle/schema";
import { requireDb } from "../db";
import { AppError } from "../modules/errors";
import { CHANNELS, EVENT_TYPES, EVENTS, type Channel, type EventType } from "./events";

/** True for MySQL "table doesn't exist" — the notification migration has not been applied yet. */
export function isMissingTable(error: unknown): boolean {
  let e = error as { errno?: number; code?: string; cause?: unknown } | undefined;
  for (let i = 0; e && i < 5; i++) {
    if (e.errno === 1146 || e.code === "ER_NO_SUCH_TABLE") return true;
    e = e.cause as typeof e;
  }
  return false;
}

export type PreferenceMap = Map<string, boolean>;
const prefKey = (event: EventType, channel: Channel) => `${event}:${channel}`;

/** A stored choice wins; otherwise every channel the event supports is on. Unsupported channels are always off. */
export function channelEnabled(prefs: PreferenceMap, event: EventType, channel: Channel): boolean {
  if (!EVENTS[event].channels.includes(channel)) return false;
  return prefs.get(prefKey(event, channel)) ?? true;
}

export async function loadPreferences(userId: number): Promise<PreferenceMap> {
  try {
    const rows = await requireDb().select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
    return new Map(rows.map((r) => [`${r.event}:${r.channel}`, r.enabled]));
  } catch (error) {
    if (isMissingTable(error)) return new Map();
    throw error;
  }
}

/** Every event with the channels it supports and the user's current choice (for Settings). */
export async function preferencesFor(userId: number) {
  const prefs = await loadPreferences(userId);
  return EVENT_TYPES.map((event) => ({
    event,
    channels: CHANNELS.filter((c) => EVENTS[event].channels.includes(c)).map((channel) => ({ channel, enabled: channelEnabled(prefs, event, channel) })),
  }));
}

export async function setPreference(userId: number, event: EventType, channel: Channel, enabled: boolean) {
  if (!EVENTS[event].channels.includes(channel)) throw new AppError("NOT_FOUND");
  try {
    await requireDb()
      .insert(notificationPreferences)
      .values({ userId, event, channel, enabled })
      .onDuplicateKeyUpdate({ set: { enabled } });
  } catch (error) {
    if (isMissingTable(error)) throw new AppError("DATABASE_UNAVAILABLE");
    throw error;
  }
  return { ok: true };
}

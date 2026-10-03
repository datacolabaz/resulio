import { createHash } from "node:crypto";
import { and, asc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import { notificationDeliveries, users } from "../../drizzle/schema";
import { publicAppUrl } from "../_core/email";
import { serverLocale } from "../_core/locale";
import { getDb, requireDb } from "../db";
import { ADAPTERS, type ChannelAdapter, type ChannelResult } from "./channels";
import { EVENTS, isChannel, isEventType, type Channel, type EventData, type EventType } from "./events";
import { channelEnabled, isMissingTable, loadPreferences, type PreferenceMap } from "./preferences";
import { renderNotification, type Recipient } from "./render";

/**
 * Single entry point for user notifications: domain event -> preferences -> outbox row per
 * channel (unique dedupe key) -> channel adapter. Runs after the request; retries transient
 * failures with backoff. See docs/NOTIFICATIONS.md.
 */

export type DeliveryStatus = "QUEUED" | "SENDING" | "SENT" | "SKIPPED" | "FAILED";

export interface DispatchInput<E extends EventType = EventType> {
  event: E;
  userId: number;
  /** Identifies this notice; the same key never delivers twice per channel. */
  dedupeKey: string;
  data: EventData[E];
  /** Restrict to some of the event's channels (e.g. the in-app part of a grade release). */
  channels?: Channel[];
}

export const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
const STUCK_SENDING_MS = 10 * 60_000;
const ORPHAN_QUEUED_MS = 2 * 60_000;
const WORKER_INTERVAL_MS = 60_000;

export const retryDelayMs = (attempts: number) => RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1];

/** Outbox key per channel; hashed when it would not fit the column. */
export function deliveryKey(dedupeKey: string, channel: Channel): string {
  const key = `${dedupeKey}:${channel}`;
  return key.length <= 191 ? key : `h:${createHash("sha256").update(key).digest("hex")}`;
}

export interface PlannedDelivery {
  channel: Channel;
  dedupeKey: string;
  status: "QUEUED" | "SKIPPED";
  error: string | null;
}

/** Which channels get a row and in which state, before anything is written. */
export function planDeliveries(input: Pick<DispatchInput, "event" | "dedupeKey" | "channels">, prefs: PreferenceMap): PlannedDelivery[] {
  const supported = EVENTS[input.event].channels;
  const channels = input.channels ? supported.filter((c) => input.channels!.includes(c)) : supported;
  return channels.map((channel) => {
    const on = channelEnabled(prefs, input.event, channel);
    return { channel, dedupeKey: deliveryKey(input.dedupeKey, channel), status: on ? "QUEUED" : "SKIPPED", error: on ? null : "OPTED_OUT" };
  });
}

/** Row state after an attempt; transient failures are retried until MAX_ATTEMPTS. */
export function settle(result: ChannelResult, attempts: number, now: Date): { status: DeliveryStatus; error: string | null; nextAttemptAt: Date | null } {
  if (result.status === "SENT") return { status: "SENT", error: null, nextAttemptAt: null };
  if (result.status === "SKIPPED") return { status: "SKIPPED", error: result.reason, nextAttemptAt: null };
  if (result.retryable && attempts < MAX_ATTEMPTS) return { status: "QUEUED", error: result.reason, nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)) };
  return { status: "FAILED", error: result.reason, nextAttemptAt: null };
}

type SendGuard<E extends EventType> = (data: EventData[E]) => Promise<string | null>;
export type SendGuards = { [E in EventType]?: SendGuard<E> };
const guards: SendGuards = {};

/** Checked right before every attempt (retries included); a returned reason skips the delivery. */
export function setSendGuard<E extends EventType>(event: E, guard: SendGuard<E>) {
  (guards as Record<E, SendGuard<E>>)[event] = guard;
}

export interface DeliveryRow {
  id: number;
  event: string;
  userId: number;
  channel: string;
  payload: Record<string, unknown>;
  /** Including the attempt that is starting. */
  attempts: number;
}

export interface NewDelivery {
  dedupeKey: string;
  event: EventType;
  userId: number;
  channel: Channel;
  status: "QUEUED" | "SKIPPED";
  error: string | null;
  payload: Record<string, unknown>;
}

/** Outbox persistence. Methods throw the driver error when the table is missing. */
export interface OutboxStore {
  /** Inserts unless the dedupe key exists; the new id, or null for a duplicate. */
  insert(row: NewDelivery): Promise<number | null>;
  /** QUEUED -> SENDING with attempts + 1; null if not QUEUED (another worker has it). */
  claim(id: number): Promise<DeliveryRow | null>;
  finish(id: number, outcome: ReturnType<typeof settle>): Promise<void>;
  /** Unsticks crashed sends, then returns ids of QUEUED rows that are due. */
  due(now: Date, limit: number): Promise<number[]>;
}

export interface DispatcherDeps {
  store: OutboxStore;
  adapters: Record<Channel, ChannelAdapter>;
  preferences(userId: number): Promise<PreferenceMap>;
  recipient(userId: number): Promise<Recipient | null>;
  appUrl(): string;
  /** Defaults to the guards registered with `setSendGuard`. */
  guards?: SendGuards;
}

export function createDispatcher(deps: DispatcherDeps) {
  async function attempt(channel: Channel, event: EventType, userId: number, data: unknown): Promise<ChannelResult> {
    try {
      const guard = (deps.guards ?? guards)[event] as SendGuard<EventType> | undefined;
      const blocked = guard ? await guard(data as EventData[EventType]) : null;
      if (blocked) return { status: "SKIPPED", reason: blocked };
      const recipient = await deps.recipient(userId);
      if (!recipient) return { status: "SKIPPED", reason: "NO_USER" };
      const content = renderNotification(event, data as EventData[EventType], recipient, deps.appUrl());
      return await deps.adapters[channel].send(userId, content, event);
    } catch (error) {
      return { status: "FAILED", reason: (error instanceof Error ? error.message : "ERROR").slice(0, 200), retryable: true };
    }
  }

  /** Claims a QUEUED row, sends it through its channel and records the outcome. */
  async function processDelivery(id: number) {
    const row = await deps.store.claim(id);
    if (!row) return;
    const result: ChannelResult =
      isEventType(row.event) && isChannel(row.channel)
        ? await attempt(row.channel, row.event, row.userId, row.payload)
        : { status: "SKIPPED", reason: "UNKNOWN_EVENT" };
    const next = settle(result, row.attempts, new Date());
    await deps.store.finish(id, { ...next, error: next.error?.slice(0, 255) ?? null });
  }

  /** Records the deliveries and sends the queued ones now. Prefer `dispatch` from request handlers. */
  async function dispatchNow<E extends EventType>(input: DispatchInput<E>) {
    const plan = planDeliveries(input, await deps.preferences(input.userId));
    const payload = input.data as unknown as Record<string, unknown>;
    const queued: number[] = [];
    for (const p of plan) {
      try {
        const id = await deps.store.insert({ dedupeKey: p.dedupeKey, event: input.event, userId: input.userId, channel: p.channel, status: p.status, error: p.error, payload });
        if (id !== null && p.status === "QUEUED") queued.push(id);
      } catch (error) {
        if (!isMissingTable(error)) throw error;
        // Migration not applied yet: deliver directly, unlogged and without retries.
        if (p.status === "QUEUED") await attempt(p.channel, input.event, input.userId, input.data);
      }
    }
    for (const id of queued) await processDelivery(id);
  }

  /** Retries due rows, revives rows orphaned by a restart and unsticks crashed sends. */
  async function runDeliveryWorker(now = new Date()) {
    for (const id of await deps.store.due(now, 25)) await processDelivery(id);
  }

  return { dispatchNow, processDelivery, runDeliveryWorker };
}

const mysqlStore: OutboxStore = {
  async insert(row) {
    const [result] = await requireDb().insert(notificationDeliveries).ignore().values(row);
    return result.affectedRows === 1 ? Number(result.insertId) : null;
  },
  async claim(id) {
    const db = requireDb();
    const t = notificationDeliveries;
    const [result] = await db
      .update(t)
      .set({ status: "SENDING", attempts: sql`${t.attempts} + 1` })
      .where(and(eq(t.id, id), eq(t.status, "QUEUED")));
    if (result.affectedRows !== 1) return null;
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    return row ?? null;
  },
  async finish(id, outcome) {
    await requireDb().update(notificationDeliveries).set(outcome).where(eq(notificationDeliveries.id, id));
  },
  async due(now, limit) {
    const db = requireDb();
    const t = notificationDeliveries;
    const stuckBefore = new Date(now.getTime() - STUCK_SENDING_MS);
    await db.update(t).set({ status: "QUEUED", nextAttemptAt: now }).where(and(eq(t.status, "SENDING"), lt(t.updatedAt, stuckBefore), lt(t.attempts, MAX_ATTEMPTS)));
    await db.update(t).set({ status: "FAILED", error: "STUCK" }).where(and(eq(t.status, "SENDING"), lt(t.updatedAt, stuckBefore), gte(t.attempts, MAX_ATTEMPTS)));
    const orphanedBefore = new Date(now.getTime() - ORPHAN_QUEUED_MS);
    const rows = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.status, "QUEUED"), or(lte(t.nextAttemptAt, now), and(isNull(t.nextAttemptAt), lt(t.createdAt, orphanedBefore)))))
      .orderBy(asc(t.id))
      .limit(limit);
    return rows.map((r) => r.id);
  },
};

async function loadRecipient(userId: number): Promise<Recipient | null> {
  const [row] = await requireDb().select({ email: users.email, locale: users.preferredLocale }).from(users).where(eq(users.id, userId)).limit(1);
  return row ? { email: row.email?.trim() || null, locale: serverLocale(row.locale) } : null;
}

export const { dispatchNow, processDelivery, runDeliveryWorker } = createDispatcher({
  store: mysqlStore,
  adapters: ADAPTERS,
  preferences: loadPreferences,
  recipient: loadRecipient,
  appUrl: () => publicAppUrl(),
});

/** Fire-and-forget: never blocks or fails the caller. */
export function dispatch<E extends EventType>(input: DispatchInput<E>) {
  setImmediate(() => {
    dispatchNow(input).catch((error) => console.error("[notifications] dispatch failed", input.event, error instanceof Error ? error.message : error));
  });
}

let warnedMissing = false;

export function startNotificationWorker() {
  if (!getDb()) return;
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runDeliveryWorker();
    } catch (error) {
      if (!isMissingTable(error)) console.error("[notifications] worker failed", error instanceof Error ? error.message : error);
      else if (!warnedMissing) {
        warnedMissing = true;
        console.warn("[notifications] outbox table missing; apply migration 0023 (pnpm db:migrate). Notifications fall back to direct delivery.");
      }
    } finally {
      running = false;
    }
  }, WORKER_INTERVAL_MS).unref();
}

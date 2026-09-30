import { eq, sql } from "drizzle-orm";
import type { SecurityEventType, SecuritySeverity } from "../../shared/adminPermissions";
import { securityEvents } from "../../drizzle/schema";
import { getDb } from "../db";

export type SecuritySignal = {
  type: SecurityEventType;
  severity: SecuritySeverity;
  userId?: number | null;
  workspaceId?: string | null;
  ipHash?: string | null;
  details?: Record<string, unknown>;
};

const WINDOW_MS = 5 * 60 * 1000;
const FLUSH_EVERY = 20;
/** Repeated admin refusals from one source are escalated for review. */
const ESCALATE_AFTER = 10;

type Window = { rowId: number | null; pending: number; total: number; startedAt: number; ready: Promise<void> };

const windows = new Map<string, Window>();
const inflight = new Set<Promise<void>>();

/**
 * Records a signal without delaying the request. Repeats of the same signal (type, user, IP,
 * workspace) within five minutes increment `occurrences` on one row instead of inserting.
 */
export function recordSecurityEvent(signal: SecuritySignal): void {
  const p = record(signal)
    .catch((error) => console.error("[Security] event write failed", error instanceof Error ? error.message : error))
    .finally(() => inflight.delete(p));
  inflight.add(p);
}

async function record(signal: SecuritySignal) {
  const db = getDb();
  if (!db) return;
  const key = [signal.type, signal.userId ?? "", signal.ipHash ?? "", signal.workspaceId ?? ""].join("|");
  const now = Date.now();
  const current = windows.get(key);
  if (current && now - current.startedAt < WINDOW_MS) {
    current.pending += 1;
    current.total += 1;
    await current.ready;
    if (current.pending >= FLUSH_EVERY) await flush(signal.type, current);
    return;
  }
  if (current) await flush(signal.type, current);
  const next: Window = { rowId: null, pending: 0, total: 1, startedAt: now, ready: Promise.resolve() };
  next.ready = db
    .insert(securityEvents)
    .values({
      type: signal.type,
      severity: signal.severity,
      userId: signal.userId ?? null,
      workspaceId: signal.workspaceId ?? null,
      ipHash: signal.ipHash ?? null,
      details: signal.details ?? null,
    })
    .$returningId()
    .then(([row]) => {
      next.rowId = row.id;
    });
  windows.set(key, next);
  await next.ready;
}

async function flush(type: SecurityEventType, w: Window) {
  const db = getDb();
  if (!db || !w.rowId || w.pending === 0) return;
  const n = w.pending;
  w.pending = 0;
  await db
    .update(securityEvents)
    .set({
      occurrences: sql`${securityEvents.occurrences} + ${n}`,
      lastSeenAt: new Date(),
      ...(type === "ADMIN_ACCESS_DENIED" && w.total >= ESCALATE_AFTER ? { severity: "HIGH" as const } : {}),
    })
    .where(eq(securityEvents.id, w.rowId));
}

/** Waits for pending writes and folds buffered repeats into their rows. */
export async function settleSecurityEvents() {
  await Promise.all([...inflight]);
  const now = Date.now();
  for (const [key, w] of windows) {
    await flush(key.split("|")[0] as SecurityEventType, w);
    if (now - w.startedAt >= WINDOW_MS) windows.delete(key);
  }
}

export function resetSecurityEventWindows() {
  windows.clear();
}

setInterval(() => {
  settleSecurityEvents().catch((error) => console.error("[Security] flush failed", error));
}, 60_000).unref?.();

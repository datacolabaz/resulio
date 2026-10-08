import { createHash } from "node:crypto";
import { and, asc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import webpush from "web-push";
import { z } from "zod";
import { webPushSubscriptions } from "../../drizzle/schema";
import { envString } from "../_core/env";
import { requireDb } from "../db";
import { AppError } from "../modules/errors";
import { isMissingTable } from "./preferences";

/**
 * Browser push (Web Push + VAPID). Off unless the three WEB_PUSH_* variables are set on the API
 * service. Subscriptions belong to a signed-in user or to an anonymous visitor (userId null).
 * Endpoints and keys are sensitive: never log or return them. See docs/NOTIFICATIONS.md.
 */

export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const b64urlBytes = (s: string) => (B64URL.test(s) ? Buffer.from(s, "base64url").length : -1);

/** Null (web push off) unless both VAPID keys have the right size and the subject is mailto:/https:. */
export function webPushConfig(env: NodeJS.ProcessEnv = process.env): WebPushConfig | null {
  const publicKey = envString("WEB_PUSH_VAPID_PUBLIC_KEY", env);
  const privateKey = envString("WEB_PUSH_VAPID_PRIVATE_KEY", env);
  const subject = envString("WEB_PUSH_SUBJECT", env);
  if (b64urlBytes(publicKey) !== 65 || b64urlBytes(privateKey) !== 32) return null;
  if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

export const webPushEnabled = (env: NodeJS.ProcessEnv = process.env) => webPushConfig(env) !== null;

let statusLogged = false;

/** One line at startup so a missing or malformed configuration is visible in the deploy log. */
export function logWebPushStatus(env: NodeJS.ProcessEnv = process.env) {
  if (statusLogged) return;
  statusLogged = true;
  if (webPushConfig(env)) console.log("[web-push] Enabled.");
  else
    console.warn(
      "[web-push] Disabled: set WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY and WEB_PUSH_SUBJECT (mailto:…) on the API service (keys: node scripts/generate-vapid-keys.mjs).",
    );
}

// ---------------------------------------------------------------------------
// Subscription input
// ---------------------------------------------------------------------------

/** Only real browser push services; anything else would let a visitor make the server POST to arbitrary hosts. */
export const PUSH_SERVICE_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];

export function isPushServiceEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
    const host = url.hostname.toLowerCase();
    return PUSH_SERVICE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export const webPushSubscriptionInput = z.object({
  endpoint: z.string().max(2048).refine(isPushServiceEndpoint, "INVALID_ENDPOINT"),
  keys: z.object({
    p256dh: z.string().max(128).refine((k) => b64urlBytes(k) === 65, "INVALID_KEY"),
    auth: z.string().max(64).refine((k) => b64urlBytes(k) === 16, "INVALID_KEY"),
  }),
});
export type WebPushSubscriptionInput = z.infer<typeof webPushSubscriptionInput>;

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface WebPushTarget {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface WebPushMessage {
  title: string;
  body: string;
  /** In-app path or absolute https URL opened on click. */
  url: string;
  /** Same tag replaces an earlier notification instead of stacking. */
  tag?: string;
}

export const PUSH_ICON = "/brand/resulio-icon.png";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The JSON the service worker reads (client/public/sw.js); kept far below the 4 KB push limit. */
export function buildPushPayload(m: WebPushMessage): string {
  return JSON.stringify({ title: clip(m.title, 120), body: clip(m.body, 300), url: m.url || "/", tag: m.tag, icon: PUSH_ICON, badge: PUSH_ICON });
}

export type WebPushResult = { ok: true } | { ok: false; gone: boolean; retryable: boolean; error: string };
export interface SendOptions {
  ttlSeconds: number;
  urgency: "very-low" | "low" | "normal" | "high";
}
export type WebPushSend = (target: WebPushTarget, payload: string, options: SendOptions) => Promise<WebPushResult>;

const SEND_TIMEOUT_MS = 10_000;

export function createWebPushSend(config: WebPushConfig, lib: Pick<typeof webpush, "sendNotification"> = webpush): WebPushSend {
  return async (target, payload, options) => {
    try {
      await lib.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload, {
        vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
        TTL: options.ttlSeconds,
        urgency: options.urgency,
        timeout: SEND_TIMEOUT_MS,
      });
      return { ok: true };
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      // 404/410: the browser dropped the subscription; 400/413: it can never accept this payload.
      if (status === 404 || status === 410) return { ok: false, gone: true, retryable: false, error: `HTTP_${status}` };
      return { ok: false, gone: false, retryable: !status || status === 429 || status >= 500, error: status ? `HTTP_${status}` : "NETWORK" };
    }
  };
}

/** The sender for the current environment, or null when web push is off. */
export function webPushSendFromEnv(env: NodeJS.ProcessEnv = process.env): WebPushSend | null {
  const config = webPushConfig(env);
  return config ? createWebPushSend(config) : null;
}

export interface WebPushStoreOps {
  /** Push service said the subscription no longer exists (404/410). */
  remove(ids: number[]): Promise<void>;
  failed(ids: number[]): Promise<void>;
  succeeded(ids: number[]): Promise<void>;
}

export interface DeliverySummary {
  sent: number;
  failed: number;
  gone: number;
  /** Some failure may succeed later (network, 429, 5xx). */
  retryable: boolean;
  firstError: string | null;
  results: WebPushResult[];
}

/** Sends one message to each target (a few at a time) and keeps the subscription table tidy. */
export async function deliverWebPush(
  targets: WebPushTarget[],
  message: WebPushMessage,
  send: WebPushSend,
  ops: WebPushStoreOps,
  options: SendOptions = { ttlSeconds: 24 * 60 * 60, urgency: "normal" },
  concurrency = 6,
): Promise<DeliverySummary> {
  const payload = buildPushPayload(message);
  const results: WebPushResult[] = new Array(targets.length);
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const i = next++;
      results[i] = await send(targets[i], payload, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

  const ids = (pick: (r: WebPushResult) => boolean) => targets.filter((_, i) => pick(results[i])).map((t) => t.id);
  const okIds = ids((r) => r.ok);
  const goneIds = ids((r) => !r.ok && r.gone);
  const failedIds = ids((r) => !r.ok && !r.gone);
  if (okIds.length) await ops.succeeded(okIds);
  if (goneIds.length) await ops.remove(goneIds);
  if (failedIds.length) await ops.failed(failedIds);
  const firstFailure = results.find((r): r is Extract<WebPushResult, { ok: false }> => !r.ok);
  return {
    sent: okIds.length,
    failed: failedIds.length + goneIds.length,
    gone: goneIds.length,
    retryable: results.some((r) => !r.ok && r.retryable),
    firstError: firstFailure?.error ?? null,
    results,
  };
}

// ---------------------------------------------------------------------------
// Subscription store
// ---------------------------------------------------------------------------

/** A subscription that kept failing this many times in a row is dropped. */
export const MAX_FAILURES = 10;

export const endpointHash = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex");

function wrapMissing<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error) => {
    throw isMissingTable(error) ? new AppError("DATABASE_UNAVAILABLE") : error;
  });
}

/**
 * Upsert by endpoint. The owner follows the current session: signing in attaches an anonymous
 * subscription to the user, signing out (the next sync) makes it anonymous again.
 */
export async function saveSubscription(input: WebPushSubscriptionInput & { userId: number | null; locale: string; userAgent: string | null }) {
  const now = new Date();
  const row = {
    endpoint: input.endpoint,
    p256dh: input.keys.p256dh,
    auth: input.keys.auth,
    userId: input.userId,
    locale: input.locale,
    userAgent: input.userAgent?.slice(0, 255) ?? null,
    lastSeenAt: now,
    failureCount: 0,
  };
  await wrapMissing(
    requireDb()
      .insert(webPushSubscriptions)
      .values({ ...row, endpointHash: endpointHash(input.endpoint) })
      .onDuplicateKeyUpdate({ set: row }),
  );
  return { ok: true };
}

export async function deleteSubscription(endpoint: string) {
  await wrapMissing(requireDb().delete(webPushSubscriptions).where(eq(webPushSubscriptions.endpointHash, endpointHash(endpoint))));
  return { ok: true };
}

const targetColumns = { id: webPushSubscriptions.id, endpoint: webPushSubscriptions.endpoint, p256dh: webPushSubscriptions.p256dh, auth: webPushSubscriptions.auth };

/** A user's browsers; empty when the table is not migrated yet. */
export async function subscriptionsForUser(userId: number): Promise<WebPushTarget[]> {
  try {
    return await requireDb().select(targetColumns).from(webPushSubscriptions).where(eq(webPushSubscriptions.userId, userId));
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

export async function anonymousSubscriptions(afterId: number, limit: number): Promise<Array<WebPushTarget & { locale: string }>> {
  return requireDb()
    .select({ ...targetColumns, locale: webPushSubscriptions.locale })
    .from(webPushSubscriptions)
    .where(and(isNull(webPushSubscriptions.userId), gt(webPushSubscriptions.id, afterId)))
    .orderBy(asc(webPushSubscriptions.id))
    .limit(limit);
}

export const dbStoreOps: WebPushStoreOps = {
  async remove(ids) {
    await requireDb().delete(webPushSubscriptions).where(inArray(webPushSubscriptions.id, ids));
  },
  async failed(ids) {
    const db = requireDb();
    await db.update(webPushSubscriptions).set({ failureCount: sql`${webPushSubscriptions.failureCount} + 1` }).where(inArray(webPushSubscriptions.id, ids));
    await db.delete(webPushSubscriptions).where(and(inArray(webPushSubscriptions.id, ids), gte(webPushSubscriptions.failureCount, MAX_FAILURES)));
  },
  async succeeded(ids) {
    await requireDb().update(webPushSubscriptions).set({ failureCount: 0 }).where(and(inArray(webPushSubscriptions.id, ids), gt(webPushSubscriptions.failureCount, 0)));
  },
};

/** Subscriber totals for the admin page. */
export async function subscriberCounts(): Promise<{ total: number; signedIn: number; anonymous: number }> {
  try {
    const [row] = await requireDb()
      .select({ total: sql<number>`count(*)`, anonymous: sql<number>`coalesce(sum(${webPushSubscriptions.userId} is null), 0)` })
      .from(webPushSubscriptions);
    const total = Number(row?.total ?? 0);
    const anonymous = Number(row?.anonymous ?? 0);
    return { total, signedIn: total - anonymous, anonymous };
  } catch (error) {
    if (isMissingTable(error)) return { total: 0, signedIn: 0, anonymous: 0 };
    throw error;
  }
}

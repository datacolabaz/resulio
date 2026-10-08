import type { Locale } from "@/i18n/types";

/**
 * Browser push subscription. The service worker (client/public/sw.js) is registered only where push
 * can work: a secure context with service workers, PushManager and the Notification API. Everything
 * here swallows errors; push is an extra and must never break a page.
 */

export const SYNC_STORAGE_KEY = "resulio.webPush.v1";
/** A synced subscription is re-sent at most this often, which keeps lastSeenAt fresh without a request per page. */
export const RESYNC_MS = 24 * 60 * 60 * 1000;

export interface WebPushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface WebPushApi {
  config(): Promise<{ enabled: boolean; publicKey: string | null }>;
  subscribe(input: { subscription: WebPushSubscriptionJson; locale: Locale }): Promise<unknown>;
}

export type SyncResult = "unsupported" | "not-granted" | "disabled" | "fresh" | "subscribed" | "failed";

export function webPushSupported(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      window.isSecureContext &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    );
  } catch {
    return false;
  }
}

export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function sameKey(current: ArrayBuffer | null | undefined, wanted: Uint8Array): boolean {
  if (!current) return false;
  const a = new Uint8Array(current);
  return a.length === wanted.length && a.every((byte, i) => byte === wanted[i]);
}

/** What was last sent to the server; a change of endpoint, account or language forces a re-send. */
export function syncFingerprint(endpoint: string, userId: number | null, locale: Locale): string {
  return `${endpoint}|${userId ?? "anon"}|${locale}`;
}

export function needsResync(stored: string | null, fingerprint: string, now: number): boolean {
  if (!stored) return true;
  const [savedAt, ...rest] = stored.split("\n");
  return rest.join("\n") !== fingerprint || !(now - Number(savedAt) < RESYNC_MS);
}

function readSynced(): string | null {
  try {
    return localStorage.getItem(SYNC_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeSynced(fingerprint: string, now: number) {
  try {
    localStorage.setItem(SYNC_STORAGE_KEY, `${now}\n${fingerprint}`);
  } catch {
    // Private mode: the next visit simply syncs again.
  }
}

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

/** Registers /sw.js once per page load with root scope; resolves to null when unsupported or it fails. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!webPushSupported()) return Promise.resolve(null);
  registration ??= navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then(() => navigator.serviceWorker.ready)
    .catch(() => null);
  return registration;
}

/**
 * Makes sure this browser has a push subscription for the current VAPID key and that the server
 * knows it (and which account is signed in). Only runs once permission is granted.
 */
export async function syncWebPush(api: WebPushApi, opts: { userId: number | null; locale: Locale; force?: boolean }): Promise<SyncResult> {
  if (!webPushSupported()) return "unsupported";
  if (Notification.permission !== "granted") return "not-granted";
  try {
    const reg = await registerServiceWorker();
    if (!reg) return "failed";
    const config = await api.config();
    if (!config.enabled || !config.publicKey) return "disabled";
    const key = urlBase64ToUint8Array(config.publicKey);
    let subscription = await reg.pushManager.getSubscription();
    if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return "failed";
    const fingerprint = syncFingerprint(json.endpoint, opts.userId, opts.locale);
    const now = Date.now();
    if (!opts.force && !needsResync(readSynced(), fingerprint, now)) return "fresh";
    await api.subscribe({ subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }, locale: opts.locale });
    writeSynced(fingerprint, now);
    return "subscribed";
  } catch {
    return "failed";
  }
}

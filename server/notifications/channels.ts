import { sendEmail } from "../_core/email";
import { notify } from "../modules/notifications";
import type { Channel, EventType } from "./events";
import { activeTokens, pushProvider, revokeTokens, type PushProvider, type PushProviderName, type PushTicket } from "./push";
import type { RenderedNotification } from "./render";
import { dbStoreOps, deliverWebPush, subscriptionsForUser, webPushSendFromEnv, type WebPushSend, type WebPushStoreOps, type WebPushTarget } from "./webPush";

export type ChannelResult =
  | { status: "SENT" }
  | { status: "SKIPPED"; reason: string }
  | { status: "FAILED"; reason: string; retryable: boolean };

export interface ChannelAdapter {
  /** `deliveryId`: the outbox row being sent (absent when delivering without the outbox). */
  send(userId: number, content: RenderedNotification, event: EventType, deliveryId?: number): Promise<ChannelResult>;
}

const inApp: ChannelAdapter = {
  async send(userId, content, _event, deliveryId) {
    await notify(userId, content.title.slice(0, 255), content.body, deliveryId);
    return { status: "SENT" };
  },
};

const email: ChannelAdapter = {
  async send(_userId, content) {
    if (!content.email) return { status: "SKIPPED", reason: "NO_TEMPLATE" };
    if (!content.email.to.trim()) return { status: "SKIPPED", reason: "NO_EMAIL" };
    const result = await sendEmail(content.email);
    if (result.ok) return { status: "SENT" };
    if (result.reason === "NOT_CONFIGURED") return { status: "SKIPPED", reason: "EMAIL_NOT_CONFIGURED" };
    return { status: "FAILED", reason: result.reason, retryable: result.retryable };
  },
};

export interface PushAdapterDeps {
  expo: () => PushProvider | null;
  expoTokens: (userId: number, provider: PushProviderName) => Promise<string[]>;
  revokeExpoTokens: (tokens: string[]) => Promise<void>;
  web: () => WebPushSend | null;
  webTargets: (userId: number) => Promise<WebPushTarget[]>;
  webOps: WebPushStoreOps;
}

type Outcome = { ok: true } | { ok: false; retryable: boolean; error: string };

/** PUSH goes to every device the user has: mobile app tokens (Expo) and browser subscriptions (Web Push). */
export function createPushAdapter(deps: PushAdapterDeps): ChannelAdapter {
  async function viaExpo(provider: PushProvider, userId: number, content: RenderedNotification, event: EventType): Promise<Outcome[]> {
    const tokens = await deps.expoTokens(userId, provider.name);
    if (!tokens.length) return [];
    let tickets: PushTicket[];
    try {
      tickets = await provider.send(tokens, { title: content.title, body: content.body, data: { event, path: content.path } });
    } catch (error) {
      return [{ ok: false, retryable: true, error: error instanceof Error ? error.message : "PUSH_ERROR" }];
    }
    await deps.revokeExpoTokens(tokens.filter((_, i) => { const t = tickets[i]; return t && !t.ok && t.invalidToken; }));
    return tickets.map((t) => (t.ok ? { ok: true } : { ok: false, retryable: false, error: t.error }));
  }

  async function viaWeb(send: WebPushSend, userId: number, content: RenderedNotification, event: EventType): Promise<Outcome[]> {
    const targets = await deps.webTargets(userId);
    if (!targets.length) return [];
    const summary = await deliverWebPush(targets, { title: content.title, body: content.body, url: content.path, tag: event.toLowerCase() }, send, deps.webOps);
    return summary.results.map((r) => (r.ok ? { ok: true } : { ok: false, retryable: r.retryable, error: r.error }));
  }

  return {
    async send(userId, content, event) {
      const expo = deps.expo();
      const web = deps.web();
      if (!expo && !web) return { status: "SKIPPED", reason: "PUSH_NOT_CONFIGURED" };
      const outcomes = [...(expo ? await viaExpo(expo, userId, content, event) : []), ...(web ? await viaWeb(web, userId, content, event) : [])];
      if (!outcomes.length) return { status: "SKIPPED", reason: "NO_DEVICE" };
      if (outcomes.some((o) => o.ok)) return { status: "SENT" };
      const failures = outcomes.filter((o): o is Extract<Outcome, { ok: false }> => !o.ok);
      return { status: "FAILED", reason: failures[0]?.error ?? "PUSH_ERROR", retryable: failures.some((f) => f.retryable) };
    },
  };
}

const push = createPushAdapter({
  expo: () => pushProvider(),
  expoTokens: activeTokens,
  revokeExpoTokens: revokeTokens,
  web: () => webPushSendFromEnv(),
  webTargets: subscriptionsForUser,
  webOps: dbStoreOps,
});

export const ADAPTERS: Record<Channel, ChannelAdapter> = { IN_APP: inApp, EMAIL: email, PUSH: push };

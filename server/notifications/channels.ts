import { sendEmail } from "../_core/email";
import { notify } from "../modules/notifications";
import type { Channel, EventType } from "./events";
import { activeTokens, pushProvider, revokeTokens } from "./push";
import type { RenderedNotification } from "./render";

export type ChannelResult =
  | { status: "SENT" }
  | { status: "SKIPPED"; reason: string }
  | { status: "FAILED"; reason: string; retryable: boolean };

export interface ChannelAdapter {
  send(userId: number, content: RenderedNotification, event: EventType): Promise<ChannelResult>;
}

const inApp: ChannelAdapter = {
  async send(userId, content) {
    await notify(userId, content.title.slice(0, 255), content.body);
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

const push: ChannelAdapter = {
  async send(userId, content, event) {
    const provider = pushProvider();
    if (!provider) return { status: "SKIPPED", reason: "PUSH_NOT_CONFIGURED" };
    const tokens = await activeTokens(userId, provider.name);
    if (!tokens.length) return { status: "SKIPPED", reason: "NO_DEVICE" };
    let tickets;
    try {
      tickets = await provider.send(tokens, { title: content.title, body: content.body, data: { event, path: content.path } });
    } catch (error) {
      return { status: "FAILED", reason: error instanceof Error ? error.message : "PUSH_ERROR", retryable: true };
    }
    await revokeTokens(tokens.filter((_, i) => { const t = tickets[i]; return t && !t.ok && t.invalidToken; }));
    if (tickets.some((t) => t.ok)) return { status: "SENT" };
    const first = tickets.find((t): t is Extract<typeof t, { ok: false }> => !t.ok);
    return { status: "FAILED", reason: first?.error ?? "PUSH_ERROR", retryable: false };
  },
};

export const ADAPTERS: Record<Channel, ChannelAdapter> = { IN_APP: inApp, EMAIL: email, PUSH: push };

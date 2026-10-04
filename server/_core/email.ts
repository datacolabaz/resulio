import { envString } from "./env";

/**
 * Transactional e-mail through Resend's HTTP API. Optional: without RESEND_API_KEY every send is
 * skipped. Callers fire and forget via `sendEmailInBackground`; nothing here throws.
 */

export const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const EMAIL_TIMEOUT_MS = 10_000;
export const DEFAULT_PUBLIC_URL = "https://resulio.co";
export const DEFAULT_EMAIL_FROM = "Resulio <noreply@resulio.co>";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailConfig {
  apiKey: string;
  from: string;
}

export function emailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig | null {
  const apiKey = envString("RESEND_API_KEY", env);
  if (!apiKey) return null;
  return { apiKey, from: envString("EMAIL_FROM", env) || DEFAULT_EMAIL_FROM };
}

/** Origin used for links in e-mails; APP_PUBLIC_URL, else https://resulio.co. */
export function publicAppUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = envString("APP_PUBLIC_URL", env);
  try {
    return raw ? new URL(raw).origin : DEFAULT_PUBLIC_URL;
  } catch {
    return DEFAULT_PUBLIC_URL;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** One-column layout with a single call-to-action button; every argument must already be escaped. */
export function emailLayout(input: {
  heading: string;
  paragraphs: string[];
  lists?: Array<{ heading: string; items: string[] }>;
  buttonLabel: string;
  buttonUrl: string;
  footer: string;
}): string {
  const p =
    input.paragraphs.map((x) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#1f2937">${x}</p>`).join("") +
    (input.lists ?? [])
      .filter((l) => l.items.length)
      .map(
        (l) =>
          `${l.heading ? `<p style="margin:16px 0 6px;font-size:15px;font-weight:bold;color:#111827">${l.heading}</p>` : ""}<ul style="margin:0 0 12px;padding-left:20px;font-size:15px;line-height:1.5;color:#1f2937">${l.items.map((i) => `<li>${i}</li>`).join("")}</ul>`,
      )
      .join("");
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:28px">
<tr><td>
<p style="margin:0 0 20px;font-size:18px;font-weight:bold;color:#111827">Resulio</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#111827">${input.heading}</h1>
${p}
<p style="margin:24px 0"><a href="${input.buttonUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">${input.buttonLabel}</a></p>
<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#6b7280">${input.footer}</p>
</td></tr></table>
</td></tr></table>
</body></html>`;
}

let loggedDisabled = false;

/** False (logged once per process) when RESEND_API_KEY is missing. */
export function emailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (emailConfig(env)) return true;
  if (!loggedDisabled) {
    loggedDisabled = true;
    console.info("[email] RESEND_API_KEY is not set; e-mails are skipped");
  }
  return false;
}

/** `retryable`: a later attempt may succeed (timeouts, 429, 5xx); 4xx and missing config will not. */
export type SendResult =
  | { ok: true; id: string | null }
  | { ok: false; reason: "NOT_CONFIGURED" | "HTTP_ERROR" | "NETWORK_ERROR"; retryable: boolean };

export const DEFAULT_EMAIL_MAX_PER_SECOND = 8;

export interface SendThrottle {
  /** Waits for this process's next send slot. */
  take(): Promise<void>;
  /** After a 429: halve the rate (not below 1/s) and hold every send for `pauseMs`. */
  slowDown(pauseMs: number): void;
  readonly rate: number;
}

/** Spaces sends evenly so a large class does not run into the provider's rate limit. */
export function createSendThrottle(perSecond: number, deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): SendThrottle {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let rate = Math.max(1, perSecond);
  let nextAt = 0;
  return {
    async take() {
      const t = now();
      const at = Math.max(t, nextAt);
      nextAt = at + 1000 / rate;
      if (at > t) await sleep(at - t);
    },
    slowDown(pauseMs) {
      rate = Math.max(1, rate / 2);
      nextAt = Math.max(nextAt, now() + pauseMs);
    },
    get rate() {
      return rate;
    },
  };
}

let sharedThrottle: SendThrottle | null = null;

/** EMAIL_MAX_PER_SECOND (default 8), shared by every e-mail this process sends. */
function emailThrottle(env: NodeJS.ProcessEnv = process.env): SendThrottle {
  if (!sharedThrottle) {
    const n = Number.parseFloat(envString("EMAIL_MAX_PER_SECOND", env));
    sharedThrottle = createSendThrottle(Number.isFinite(n) && n > 0 ? n : DEFAULT_EMAIL_MAX_PER_SECOND);
  }
  return sharedThrottle;
}

/** Retry-After in ms, bounded to 1–60 s. */
export function retryAfterMs(header: string | null): number {
  const s = Number.parseFloat(header ?? "");
  return Number.isFinite(s) ? Math.min(60_000, Math.max(1_000, s * 1000)) : 1_000;
}

/** A 429 is retried this many times in-process (after the pause) before the caller's own retry takes over. */
const RATE_LIMIT_RETRIES = 2;

export async function sendEmail(
  message: EmailMessage,
  deps: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv; throttle?: SendThrottle } = {},
): Promise<SendResult> {
  const config = emailEnabled(deps.env) ? emailConfig(deps.env) : null;
  if (!config) return { ok: false, reason: "NOT_CONFIGURED", retryable: false };
  const throttle = deps.throttle ?? emailThrottle(deps.env);
  try {
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      await throttle.take();
      response = await (deps.fetch ?? fetch)(RESEND_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: config.from, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
        signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
      });
      if (response.status !== 429) break;
      throttle.slowDown(retryAfterMs(response.headers?.get?.("retry-after") ?? null));
      if (attempt >= RATE_LIMIT_RETRIES) break;
      console.warn(`[email] Resend rate limit hit; slowing to ${throttle.rate}/s`);
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300);
      console.error(`[email] Resend responded ${response.status}`, body);
      return { ok: false, reason: "HTTP_ERROR", retryable: response.status === 429 || response.status >= 500 };
    }
    const json = (await response.json().catch(() => ({}))) as { id?: unknown };
    return { ok: true, id: typeof json.id === "string" ? json.id : null };
  } catch (error) {
    console.error("[email] send failed", error instanceof Error ? error.name : "unknown");
    return { ok: false, reason: "NETWORK_ERROR", retryable: true };
  }
}

/** Runs after the current request finishes; errors are logged, never thrown. */
export function sendEmailInBackground(task: () => Promise<unknown>) {
  setImmediate(() => {
    task().catch((error) => console.error("[email] background task failed", error instanceof Error ? error.message : error));
  });
}

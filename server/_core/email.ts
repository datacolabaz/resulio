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
export function emailLayout(input: { heading: string; paragraphs: string[]; buttonLabel: string; buttonUrl: string; footer: string }): string {
  const p = input.paragraphs.map((x) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#1f2937">${x}</p>`).join("");
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

export type SendResult = { ok: true; id: string | null } | { ok: false; reason: "NOT_CONFIGURED" | "HTTP_ERROR" | "NETWORK_ERROR" };

export async function sendEmail(message: EmailMessage, deps: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<SendResult> {
  const config = emailEnabled(deps.env) ? emailConfig(deps.env) : null;
  if (!config) return { ok: false, reason: "NOT_CONFIGURED" };
  try {
    const response = await (deps.fetch ?? fetch)(RESEND_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: config.from, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
      signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300);
      console.error(`[email] Resend responded ${response.status}`, body);
      return { ok: false, reason: "HTTP_ERROR" };
    }
    const json = (await response.json().catch(() => ({}))) as { id?: unknown };
    return { ok: true, id: typeof json.id === "string" ? json.id : null };
  } catch (error) {
    console.error("[email] send failed", error instanceof Error ? error.name : "unknown");
    return { ok: false, reason: "NETWORK_ERROR" };
  }
}

/** Runs after the current request finishes; errors are logged, never thrown. */
export function sendEmailInBackground(task: () => Promise<unknown>) {
  setImmediate(() => {
    task().catch((error) => console.error("[email] background task failed", error instanceof Error ? error.message : error));
  });
}

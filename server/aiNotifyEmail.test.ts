import { afterEach, describe, expect, it, vi } from "vitest";
import { emailConfig, escapeHtml, publicAppUrl, RESEND_ENDPOINT, sendEmail } from "./_core/email";
import { LlmHttpError } from "./_core/llm";
import { serverLocale } from "./_core/locale";
import { AI_ALERT_WINDOW_MS, aiAlertText, providerAlertFor, usageAlertFor } from "./modules/aiAlerts";
import { rerunBlockedBy, STALE_PENDING_MS } from "./modules/aiReview";
import { buildGradeEmail, gradeEmailKind } from "./modules/gradeEmail";
import { dedupeCutoff } from "./modules/notifications";

afterEach(() => { vi.restoreAllMocks(); });

const HOUR = 60 * 60 * 1000;

describe("AI usage alerts", () => {
  it("warns at 80% of the limit and reports the limit itself", () => {
    expect(usageAlertFor(79, 100)).toBeNull();
    expect(usageAlertFor(80, 100)).toBe("USAGE_80");
    expect(usageAlertFor(99, 100)).toBe("USAGE_80");
    expect(usageAlertFor(100, 100)).toBe("LIMIT_REACHED");
    expect(usageAlertFor(3, 10)).toBeNull();
    expect(usageAlertFor(8, 10)).toBe("USAGE_80");
  });

  it("rounds the 80% mark up and skips it when it coincides with the limit", () => {
    expect(usageAlertFor(4, 5)).toBe("USAGE_80");
    expect(usageAlertFor(1, 2)).toBeNull();
    expect(usageAlertFor(1, 1)).toBe("LIMIT_REACHED");
    expect(usageAlertFor(0, 0)).toBe("LIMIT_REACHED");
  });

  it("classifies only auth and quota provider errors", () => {
    expect(providerAlertFor(new LlmHttpError(401, "x"))).toBe("PROVIDER_AUTH");
    expect(providerAlertFor(new LlmHttpError(403, "x"))).toBe("PROVIDER_AUTH");
    expect(providerAlertFor(new LlmHttpError(429, "x"))).toBe("PROVIDER_QUOTA");
    expect(providerAlertFor(new LlmHttpError(500, "x"))).toBeNull();
    expect(providerAlertFor(new Error("network"))).toBeNull();
  });

  it("dedupes usage alerts for a day and provider alerts for 6 hours", () => {
    const now = new Date();
    const canResend = (lastSentAt: Date, windowMs: number) => lastSentAt <= dedupeCutoff(now, windowMs);
    expect(AI_ALERT_WINDOW_MS.USAGE_80).toBe(24 * HOUR);
    expect(AI_ALERT_WINDOW_MS.LIMIT_REACHED).toBe(24 * HOUR);
    expect(AI_ALERT_WINDOW_MS.PROVIDER_AUTH).toBe(6 * HOUR);
    expect(AI_ALERT_WINDOW_MS.PROVIDER_QUOTA).toBe(6 * HOUR);
    expect(canResend(new Date(now.getTime() - 5 * HOUR), 6 * HOUR)).toBe(false);
    expect(canResend(new Date(now.getTime() - 6 * HOUR), 6 * HOUR)).toBe(true);
    expect(canResend(new Date(now.getTime() - 23 * HOUR), 24 * HOUR)).toBe(false);
    expect(canResend(new Date(now.getTime() - 25 * HOUR), 24 * HOUR)).toBe(true);
  });

  it("writes alerts in the owner's language with the numbers filled in", () => {
    expect(aiAlertText("az", "LIMIT_REACHED", { workspace: "Riyaziyyat", limit: 100 }).title).toBe("AI yoxlama bu gün dayandı, sabah yenilənəcək");
    expect(aiAlertText("en", "USAGE_80", { workspace: "Maths", used: 80, limit: 100 }).body).toContain("80 of 100");
    expect(aiAlertText("ru", "USAGE_80", { workspace: "W", used: 8, limit: 10 }).body).toContain("8 из 10");
    expect(serverLocale("ru")).toBe("ru");
    expect(serverLocale(null)).toBe("az");
    expect(serverLocale("de")).toBe("az");
  });
});

describe("AI review rerun guard", () => {
  const now = Date.now();
  it("lets missing, finished and skipped reviews run immediately", () => {
    expect(rerunBlockedBy(undefined, now)).toBeNull();
    expect(rerunBlockedBy({ status: "SKIPPED", createdAt: new Date(now) }, now)).toBeNull();
    expect(rerunBlockedBy({ status: "DONE", createdAt: new Date(now) }, now)).toBeNull();
    expect(rerunBlockedBy({ status: "FAILED", createdAt: new Date(now) }, now)).toBeNull();
  });
  it("blocks only a fresh pending run", () => {
    expect(rerunBlockedBy({ status: "PENDING", createdAt: new Date(now - 60_000) }, now)).toBe("IN_PROGRESS");
    expect(rerunBlockedBy({ status: "PENDING", createdAt: new Date(now - STALE_PENDING_MS - 1) }, now)).toBeNull();
  });
});

describe("grade e-mail decision", () => {
  const save = (wasReleased: boolean, before: number | null, release: boolean, after: number | null) => ({ before: { wasReleased, score: before }, after: { release, score: after } });

  it("sends on the first release only", () => {
    expect(gradeEmailKind(save(false, null, true, 80), undefined)).toBe("released");
    expect(gradeEmailKind(save(false, null, false, 80), undefined)).toBeNull();
    expect(gradeEmailKind(save(true, 80, true, 80), 80)).toBeNull();
  });

  it("sends 'updated' when a released score changes, once per score", () => {
    expect(gradeEmailKind(save(true, 80, true, 90), 80)).toBe("updated");
    expect(gradeEmailKind(save(true, 90, true, 90), 90)).toBeNull();
    expect(gradeEmailKind(save(true, 80, true, null), 80)).toBe("updated");
    // A concurrent duplicate save sees the score already announced.
    expect(gradeEmailKind(save(true, 80, true, 90), 90)).toBeNull();
  });

  it("does not repeat after hide-and-show with the same score, but tells about a changed one", () => {
    expect(gradeEmailKind(save(false, 80, true, 80), 80)).toBeNull();
    expect(gradeEmailKind(save(false, 80, true, 70), 80)).toBe("updated");
  });

  it("ignores re-saves of grades released before e-mails existed unless the score changes", () => {
    expect(gradeEmailKind(save(true, 75, true, 75), undefined)).toBeNull();
    expect(gradeEmailKind(save(true, 75, true, 85), undefined)).toBe("updated");
  });

  it("never e-mails when the grade is hidden", () => {
    expect(gradeEmailKind(save(true, 80, false, 90), 80)).toBeNull();
  });
});

describe("grade e-mail content", () => {
  it("escapes HTML", () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;");
  });

  it("escapes the task title, links to the site and leaves out the feedback", () => {
    const mail = buildGradeEmail({ to: "s@example.com", locale: "az", kind: "released", taskTitle: `<img src=x onerror=alert(1)> "Esse"\r\nBcc: x`, score: 85.5, appUrl: "https://resulio.co" });
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(mail.html).toContain('href="https://resulio.co/student/assignments"');
    expect(mail.html).toContain("85.5/100");
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).toContain("Tapşırığınız qiymətləndirildi");
    expect(mail.text).toContain("https://resulio.co/student/assignments");
    expect(mail.text).toContain("85.5/100");
  });

  it("has EN and RU versions, and omits the score line when there is no score", () => {
    const en = buildGradeEmail({ to: "a@b.c", locale: "en", kind: "updated", taskTitle: "Essay", score: null, appUrl: "https://resulio.co" });
    expect(en.subject).toBe("Your grade was updated: Essay");
    expect(en.text).not.toContain("/100");
    const ru = buildGradeEmail({ to: "a@b.c", locale: "ru", kind: "released", taskTitle: "Эссе", score: 90, appUrl: "https://resulio.co" });
    expect(ru.subject).toBe("Ваше задание оценено: Эссе");
    expect(ru.text).toContain("Ваш балл: 90/100");
  });
});

describe("Resend client", () => {
  const message = { to: "s@example.com", subject: "S", html: "<p>x</p>", text: "x" };

  it("reads config and the public URL", () => {
    expect(emailConfig({})).toBeNull();
    expect(emailConfig({ RESEND_API_KEY: "re_1" })).toEqual({ apiKey: "re_1", from: "Resulio <noreply@resulio.co>" });
    expect(emailConfig({ RESEND_API_KEY: "re_1", EMAIL_FROM: "Resulio <hi@resulio.co>" })?.from).toBe("Resulio <hi@resulio.co>");
    expect(publicAppUrl({})).toBe("https://resulio.co");
    expect(publicAppUrl({ APP_PUBLIC_URL: "https://staging.resulio.co/" })).toBe("https://staging.resulio.co");
    expect(publicAppUrl({ APP_PUBLIC_URL: "not a url" })).toBe("https://resulio.co");
  });

  it("skips without a key and never calls the API", async () => {
    const request = vi.fn();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(await sendEmail(message, { fetch: request, env: {} })).toEqual({ ok: false, reason: "NOT_CONFIGURED" });
    expect(request).not.toHaveBeenCalled();
  });

  it("posts to Resend with a timeout and does not log the key on errors", async () => {
    const request = vi.fn(async (_url: string, _init: RequestInit) => new Response("bad", { status: 422 }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { RESEND_API_KEY: "re_secret_123", EMAIL_FROM: "Resulio <noreply@resulio.co>" };
    expect(await sendEmail(message, { fetch: request as unknown as typeof fetch, env })).toEqual({ ok: false, reason: "HTTP_ERROR" });
    const [url, init] = request.mock.calls[0];
    expect(url).toBe(RESEND_ENDPOINT);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer re_secret_123");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toMatchObject({ from: "Resulio <noreply@resulio.co>", to: ["s@example.com"], subject: "S" });
    expect(JSON.stringify(errors.mock.calls)).not.toContain("re_secret_123");
  });

  it("returns the message id on success and survives network errors", async () => {
    const env = { RESEND_API_KEY: "re_1" };
    const ok = vi.fn(async () => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
    expect(await sendEmail(message, { fetch: ok as unknown as typeof fetch, env })).toEqual({ ok: true, id: "msg_1" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const down = vi.fn(async () => { throw new DOMException("timeout", "TimeoutError"); });
    expect(await sendEmail(message, { fetch: down as unknown as typeof fetch, env })).toEqual({ ok: false, reason: "NETWORK_ERROR" });
  });
});

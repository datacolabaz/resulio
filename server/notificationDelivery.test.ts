import { describe, expect, it, vi } from "vitest";
import type { ChannelAdapter, ChannelResult } from "./notifications/channels";
import {
  createDispatcher,
  deliveryKey,
  MAX_ATTEMPTS,
  planDeliveries,
  retryDelayMs,
  settle,
  type DeliveryRow,
  type DeliveryStatus,
  type NewDelivery,
  type OutboxStore,
  type SendGuards,
} from "./notifications/dispatcher";
import { EVENTS, type Channel } from "./notifications/events";
import { channelEnabled, isMissingTable, type PreferenceMap } from "./notifications/preferences";
import { EXPO_PUSH_ENDPOINT, expoProvider, pushEnabled, pushProvider } from "./notifications/push";
import { renderNotification } from "./notifications/render";
import { AI_FEEDBACK_MAX_CHARS, AI_FEEDBACK_MAX_ITEMS, buildAiGradeEmail, cleanModelText } from "./notifications/templates";

const noPrefs: PreferenceMap = new Map();

describe("routing and preferences", () => {
  it("plans one queued delivery per channel the event supports", () => {
    const plan = planDeliveries({ event: "GRADE_RELEASED", dedupeKey: "g:1" }, noPrefs);
    expect(plan.map((p) => [p.channel, p.status])).toEqual([["IN_APP", "QUEUED"], ["EMAIL", "QUEUED"], ["PUSH", "QUEUED"]]);
    expect(plan[1].dedupeKey).toBe("g:1:EMAIL");
  });

  it("restricts to the requested channels, never adding unsupported ones", () => {
    expect(planDeliveries({ event: "GRADE_RELEASED", dedupeKey: "k", channels: ["IN_APP"] }, noPrefs).map((p) => p.channel)).toEqual(["IN_APP"]);
    expect(planDeliveries({ event: "AI_LIMIT_80", dedupeKey: "k", channels: ["IN_APP", "EMAIL"] }, noPrefs).map((p) => p.channel)).toEqual(["IN_APP"]);
    expect(planDeliveries({ event: "AI_LIMIT_80", dedupeKey: "k" }, noPrefs).map((p) => p.channel)).toEqual(["IN_APP", "PUSH"]);
  });

  it("records an opt-out as a skipped delivery", () => {
    const prefs: PreferenceMap = new Map([["GRADE_RELEASED:EMAIL", false]]);
    const plan = planDeliveries({ event: "GRADE_RELEASED", dedupeKey: "k" }, prefs);
    expect(plan.find((p) => p.channel === "EMAIL")).toMatchObject({ status: "SKIPPED", error: "OPTED_OUT" });
    expect(plan.find((p) => p.channel === "IN_APP")).toMatchObject({ status: "QUEUED" });
  });

  it("defaults every supported channel on and unsupported ones off", () => {
    expect(channelEnabled(noPrefs, "AI_GRADE_READY", "EMAIL")).toBe(true);
    expect(channelEnabled(noPrefs, "AI_LIMIT_80", "EMAIL")).toBe(false);
    expect(channelEnabled(new Map([["AI_LIMIT_80:EMAIL", true]]), "AI_LIMIT_80", "EMAIL")).toBe(false);
    expect(channelEnabled(new Map([["AI_LIMIT_80:IN_APP", false]]), "AI_LIMIT_80", "IN_APP")).toBe(false);
    // Opt-in channel: off until the user turns it on.
    expect(channelEnabled(noPrefs, "SYLLABUS_AT_RISK_DIGEST", "IN_APP")).toBe(true);
    expect(channelEnabled(noPrefs, "SYLLABUS_AT_RISK_DIGEST", "EMAIL")).toBe(false);
    expect(channelEnabled(new Map([["SYLLABUS_AT_RISK_DIGEST:EMAIL", true]]), "SYLLABUS_AT_RISK_DIGEST", "EMAIL")).toBe(true);
  });

  it("detects a missing table through wrapped driver errors", () => {
    expect(isMissingTable({ errno: 1146 })).toBe(true);
    expect(isMissingTable(new Error("wrapped", { cause: { code: "ER_NO_SUCH_TABLE" } }))).toBe(true);
    expect(isMissingTable(new Error("other"))).toBe(false);
  });
});

describe("dedupe keys and retries", () => {
  it("keeps keys within the column and stable", () => {
    expect(deliveryKey("ai-feedback:abc", "EMAIL")).toBe("ai-feedback:abc:EMAIL");
    const long = deliveryKey("x".repeat(300), "PUSH");
    expect(long.length).toBeLessThanOrEqual(191);
    expect(long).toBe(deliveryKey("x".repeat(300), "PUSH"));
    expect(long).not.toBe(deliveryKey("x".repeat(300), "EMAIL"));
  });

  it("backs off on transient failures and stops after the last attempt", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const transient: ChannelResult = { status: "FAILED", reason: "HTTP_ERROR", retryable: true };
    expect(settle(transient, 1, now)).toEqual({ status: "QUEUED", error: "HTTP_ERROR", nextAttemptAt: new Date(now.getTime() + 60_000) });
    expect(settle(transient, 2, now).nextAttemptAt).toEqual(new Date(now.getTime() + retryDelayMs(2)));
    expect(retryDelayMs(1) < retryDelayMs(2) && retryDelayMs(2) < retryDelayMs(3)).toBe(true);
    expect(settle(transient, MAX_ATTEMPTS, now)).toEqual({ status: "FAILED", error: "HTTP_ERROR", nextAttemptAt: null });
    expect(settle({ status: "FAILED", reason: "HTTP_ERROR", retryable: false }, 1, now).status).toBe("FAILED");
    expect(settle({ status: "SKIPPED", reason: "NO_EMAIL" }, 1, now)).toEqual({ status: "SKIPPED", error: "NO_EMAIL", nextAttemptAt: null });
    expect(settle({ status: "SENT" }, 3, now)).toEqual({ status: "SENT", error: null, nextAttemptAt: null });
  });
});

/** In-memory outbox with the same semantics as the MySQL one. */
function memoryStore(opts: { missingTable?: boolean } = {}) {
  const rows: Array<DeliveryRow & { dedupeKey: string; status: DeliveryStatus; error: string | null; nextAttemptAt: Date | null }> = [];
  const missing = () => {
    if (opts.missingTable) throw Object.assign(new Error("Table doesn't exist"), { errno: 1146 });
  };
  const store: OutboxStore = {
    async insert(row: NewDelivery) {
      missing();
      if (rows.some((r) => r.dedupeKey === row.dedupeKey)) return null;
      rows.push({ ...row, id: rows.length + 1, attempts: 0, nextAttemptAt: null });
      return rows.length;
    },
    async claim(id) {
      const row = rows.find((r) => r.id === id && r.status === "QUEUED");
      if (!row) return null;
      Object.assign(row, { status: "SENDING", attempts: row.attempts + 1 });
      return { ...row };
    },
    async finish(id, outcome) {
      Object.assign(rows.find((r) => r.id === id)!, outcome);
    },
    async due(now) {
      return rows.filter((r) => r.status === "QUEUED" && r.nextAttemptAt && r.nextAttemptAt <= now).map((r) => r.id);
    },
  };
  return { store, rows };
}

function harness(results: Partial<Record<Channel, ChannelResult[]>> = {}, opts: { missingTable?: boolean; prefs?: PreferenceMap; guards?: SendGuards } = {}) {
  const { store, rows } = memoryStore(opts);
  const sent: Array<{ channel: Channel; title: string; html?: string }> = [];
  const adapter = (channel: Channel): ChannelAdapter => ({
    async send(_userId, content) {
      const result = results[channel]?.shift() ?? { status: "SENT" };
      if (result.status === "SENT") sent.push({ channel, title: content.title, html: content.email?.html });
      return result;
    },
  });
  const dispatcher = createDispatcher({
    store,
    adapters: { IN_APP: adapter("IN_APP"), EMAIL: adapter("EMAIL"), PUSH: adapter("PUSH") },
    preferences: async () => opts.prefs ?? new Map(),
    recipient: async () => ({ locale: "en", email: "student@example.com" }),
    appUrl: () => "https://resulio.co",
    guards: opts.guards ?? {},
  });
  return { ...dispatcher, rows, sent };
}

const gradeData = { submissionId: "s1", taskTitle: "Essay", score: 85, feedback: "Good structure.", strengths: ["Clear"], improvements: ["Cite sources"] };

describe("dispatcher", () => {
  it("delivers every channel once and ignores a duplicate dispatch", async () => {
    const h = harness();
    const input = { event: "AI_GRADE_READY" as const, userId: 7, dedupeKey: "ai-grade:s1", data: gradeData };
    await h.dispatchNow(input);
    await h.dispatchNow(input);
    expect(h.sent.map((s) => s.channel)).toEqual(["IN_APP", "EMAIL", "PUSH"]);
    expect(h.rows.map((r) => r.status)).toEqual(["SENT", "SENT", "SENT"]);
  });

  it("skips opted-out channels without calling the adapter", async () => {
    const h = harness({}, { prefs: new Map([["GRADE_UPDATED:EMAIL", false]]) });
    await h.dispatchNow({ event: "GRADE_UPDATED", userId: 7, dedupeKey: "u:1", data: { taskTitle: "Essay", score: 80 } });
    expect(h.sent.map((s) => s.channel)).toEqual(["IN_APP", "PUSH"]);
    expect(h.rows.find((r) => r.channel === "EMAIL")).toMatchObject({ status: "SKIPPED", error: "OPTED_OUT" });
  });

  it("queues a transient failure for retry and sends it when due", async () => {
    const h = harness({ EMAIL: [{ status: "FAILED", reason: "HTTP_ERROR", retryable: true }] });
    await h.dispatchNow({ event: "AI_GRADE_READY", userId: 7, dedupeKey: "ai-grade:s1", data: gradeData, channels: ["EMAIL"] });
    expect(h.rows[0]).toMatchObject({ status: "QUEUED", attempts: 1, error: "HTTP_ERROR" });
    await h.runDeliveryWorker(new Date(Date.now() + 30_000));
    expect(h.sent).toHaveLength(0);
    await h.runDeliveryWorker(new Date(Date.now() + 2 * 60_000));
    expect(h.rows[0]).toMatchObject({ status: "SENT", attempts: 2 });
    expect(h.sent).toHaveLength(1);
  });

  it("gives up after MAX_ATTEMPTS", async () => {
    const fail: ChannelResult = { status: "FAILED", reason: "HTTP_ERROR", retryable: true };
    const h = harness({ PUSH: Array(MAX_ATTEMPTS).fill(fail) });
    await h.dispatchNow({ event: "AI_LIMIT_80", userId: 1, dedupeKey: "k", channels: ["PUSH"], data: { workspace: "W", used: 80, limit: 100 } });
    for (let i = 0; i < MAX_ATTEMPTS; i++) await h.runDeliveryWorker(new Date(Date.now() + 24 * 60 * 60_000));
    expect(h.rows[0]).toMatchObject({ status: "FAILED", attempts: MAX_ATTEMPTS });
  });

  it("drops a queued retry when its send guard says no (teacher changed the grade meanwhile)", async () => {
    let changed = false;
    const h = harness({ EMAIL: [{ status: "FAILED", reason: "NETWORK_ERROR", retryable: true }] }, { guards: { AI_GRADE_READY: async () => (changed ? "GRADE_CHANGED" : null) } });
    await h.dispatchNow({ event: "AI_GRADE_READY", userId: 7, dedupeKey: "ai-grade:s1", data: gradeData, channels: ["EMAIL"] });
    changed = true;
    await h.runDeliveryWorker(new Date(Date.now() + 60 * 60_000));
    expect(h.rows[0]).toMatchObject({ status: "SKIPPED", error: "GRADE_CHANGED" });
    expect(h.sent).toHaveLength(0);
  });

  it("never re-sends with a used key, even after a failure", async () => {
    const h = harness({ EMAIL: [{ status: "FAILED", reason: "HTTP_ERROR", retryable: false }] });
    const input = { event: "GRADE_RELEASED" as const, userId: 7, dedupeKey: "g:1", channels: ["EMAIL" as const], data: { taskTitle: "T", score: 1 } };
    await h.dispatchNow(input);
    await h.dispatchNow(input);
    expect(h.sent).toHaveLength(0);
  });

  it("without the outbox table delivers directly", async () => {
    const h = harness({}, { missingTable: true });
    await h.dispatchNow({ event: "GRADE_RELEASED", userId: 7, dedupeKey: "g:1", channels: ["IN_APP"], data: { taskTitle: "T", score: 1 } });
    await h.dispatchNow({ event: "AI_GRADE_READY", userId: 7, dedupeKey: "ai-grade:s1", channels: ["EMAIL"], data: gradeData });
    expect(h.sent.map((s) => s.channel)).toEqual(["IN_APP", "EMAIL"]);
  });

  it("covers every declared event with a renderer", () => {
    for (const event of Object.keys(EVENTS) as Array<keyof typeof EVENTS>) {
      const data = {
        AI_GRADE_READY: gradeData,
        GRADE_RELEASED: { taskTitle: "T", score: 1 },
        GRADE_UPDATED: { taskTitle: "T", score: 2 },
        AI_LIMIT_80: { workspace: "W", used: 80, limit: 100 },
        AI_LIMIT_REACHED: { workspace: "W", used: 100, limit: 100 },
        AI_PROVIDER_ERROR: { workspace: "W", problem: "AUTH" as const },
        ANSWER_KEY_DRAFTED: { taskId: "t1", taskTitle: "T" },
        SYLLABUS_ACCESS_GRANTED: { syllabusId: "s1", syllabusTitle: "S", startsAt: null },
        SYLLABUS_UNLOCKED: { syllabusId: "s1", syllabusTitle: "S", lessons: ["L"], modules: [], lessonId: "l1" },
        SYLLABUS_APPROVAL_NEEDED: { syllabusId: "s1", syllabusTitle: "S", count: 2, studentName: null },
        SYLLABUS_COMPLETED: { syllabusId: "s1", syllabusTitle: "S", verificationCode: "abc" },
        SYLLABUS_AT_RISK_DIGEST: { syllabusId: "s1", syllabusTitle: "S", count: 7, names: ["A", "B"] },
        TASK_ASSIGNED: { tasks: [{ taskId: "t1", title: "T", excerpt: "", deadline: "2026-10-05T14:00:00Z" }], total: 1, from: "W" },
        TASK_UPDATED: { taskId: "t1", title: "T", deadline: "2026-10-06T14:00:00Z", previousDeadline: "2026-10-05T14:00:00Z" },
      }[event];
      const rendered = renderNotification(event, data, { locale: "az", email: "a@b.c" }, "https://resulio.co");
      expect(rendered.title.length).toBeGreaterThan(0);
      expect(rendered.email === null).toBe(!EVENTS[event].channels.includes("EMAIL"));
    }
  });
});

describe("AI grade e-mail", () => {
  it("escapes model output and shows the score with the AI label", () => {
    const mail = buildAiGradeEmail({
      to: "s@example.com",
      locale: "az",
      taskTitle: "<b>Essay</b>\r\nBcc: x",
      score: 85,
      feedback: '<script>alert("x")</script> try <img src=x onerror=1>',
      strengths: ["<a href='javascript:1'>link</a>"],
      improvements: ["a & b"],
      appUrl: "https://resulio.co",
    });
    expect(mail.html).not.toMatch(/<script|<img|<a href='javascript/);
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("a &amp; b");
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).toContain("85/100");
    expect(mail.html).toContain("AI tərəfindən qiymətləndirilib");
    expect(mail.text).toContain("Müəlliminiz onu yoxlayıb dəyişə bilər");
  });

  it("bounds the length of model text and lists", () => {
    const mail = buildAiGradeEmail({
      to: "s@example.com",
      locale: "en",
      taskTitle: "T",
      score: 40,
      feedback: "x".repeat(10_000),
      strengths: Array.from({ length: 20 }, (_, i) => `s${i} ${"y".repeat(1000)}`),
      improvements: [],
      appUrl: "https://resulio.co",
    });
    expect(mail.text).not.toContain("x".repeat(AI_FEEDBACK_MAX_CHARS + 1));
    expect(mail.text.match(/^- s\d+/gm)).toHaveLength(AI_FEEDBACK_MAX_ITEMS);
    expect(mail.text).toContain("Graded by AI");
    expect(cleanModelText("a\u0000b\r\n\n\n\nc", 100)).toBe("ab\n\nc");
  });
});


describe("push", () => {
  it("is off unless a provider is configured", () => {
    expect(pushProvider({})).toBeNull();
    expect(pushEnabled({ PUSH_PROVIDER: "something-else" })).toBe(false);
    expect(pushProvider({ PUSH_PROVIDER: "expo" })?.name).toBe("expo");
  });

  it("maps Expo tickets and flags unregistered devices", async () => {
    const request = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ data: [{ status: "ok" }, { status: "error", details: { error: "DeviceNotRegistered" } }] }), { status: 200 }),
    );
    const tickets = await expoProvider("tok_secret", request as unknown as typeof fetch).send(["ExponentPushToken[a]", "ExponentPushToken[b]"], { title: "T", body: "B", data: { path: "/x" } });
    expect(tickets).toEqual([{ ok: true }, { ok: false, invalidToken: true, error: "DeviceNotRegistered" }]);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe(EXPO_PUSH_ENDPOINT);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok_secret");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws on transport errors so the dispatcher retries", async () => {
    const down = vi.fn(async () => new Response("", { status: 503 }));
    await expect(expoProvider("", down as unknown as typeof fetch).send(["t"], { title: "T", body: "B", data: {} })).rejects.toThrow("503");
  });
});

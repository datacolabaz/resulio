import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import webpush from "web-push";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIGH_RISK_PERMISSIONS, permissionsOf } from "../shared/adminPermissions";
import {
  announcementTextsValid,
  audiencePlan,
  isSafeAnnouncementUrl,
  pickAnnouncementText,
  type AnnouncementTexts,
} from "../shared/announcements";
import type { TrpcContext } from "./_core/context";
import { resetRateLimits } from "./_core/rateLimit";
import * as accessMod from "./modules/access";
import * as announcementsMod from "./notifications/announcements";
import { announcementDedupeKey, createAnnouncementRunner, type AnnouncementRunnerDeps, type AnonymousTarget } from "./notifications/announcements";
import { createPushAdapter } from "./notifications/channels";
import { EVENTS } from "./notifications/events";
import { renderNotification } from "./notifications/render";
import * as webPushMod from "./notifications/webPush";
import {
  buildPushPayload,
  createWebPushSend,
  deliverWebPush,
  isPushServiceEndpoint,
  webPushConfig,
  webPushSubscriptionInput,
  type WebPushResult,
  type WebPushSend,
  type WebPushStoreOps,
  type WebPushTarget,
} from "./notifications/webPush";
import { appRouter } from "./routers";

vi.mock("./modules/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/access")>()),
  platformRolesOf: vi.fn(async () => []),
}));
vi.mock("./notifications/announcements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./notifications/announcements")>()),
  createAnnouncement: vi.fn(async () => ({ id: 42 })),
}));
vi.mock("./notifications/webPush", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./notifications/webPush")>()),
  saveSubscription: vi.fn(async () => ({ ok: true })),
  deleteSubscription: vi.fn(async () => ({ ok: true })),
}));

const VAPID = webpush.generateVAPIDKeys();
const ENABLED_ENV = { WEB_PUSH_VAPID_PUBLIC_KEY: VAPID.publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: VAPID.privateKey, WEB_PUSH_SUBJECT: "mailto:ops@resulio.co" };
const P256DH = Buffer.alloc(65, 4).toString("base64url");
const AUTH = Buffer.alloc(16, 7).toString("base64url");
const FCM = "https://fcm.googleapis.com/fcm/send/abc123";
const subscription = (endpoint = FCM) => ({ endpoint, keys: { p256dh: P256DH, auth: AUTH } });
const target = (id: number): WebPushTarget => ({ id, endpoint: `${FCM}-${id}`, p256dh: P256DH, auth: AUTH });

function fakeOps() {
  const calls = { removed: [] as number[], failed: [] as number[], succeeded: [] as number[] };
  const ops: WebPushStoreOps = {
    remove: async (ids) => void calls.removed.push(...ids),
    failed: async (ids) => void calls.failed.push(...ids),
    succeeded: async (ids) => void calls.succeeded.push(...ids),
  };
  return { ops, calls };
}

const sendBy = (outcome: (t: WebPushTarget) => WebPushResult): WebPushSend & { calls: string[] } => {
  const calls: string[] = [];
  const fn = (async (t: WebPushTarget, payload: string) => {
    calls.push(payload);
    return outcome(t);
  }) as WebPushSend & { calls: string[] };
  fn.calls = calls;
  return fn;
};
const gone: WebPushResult = { ok: false, gone: true, retryable: false, error: "HTTP_410" };

describe("web push configuration", () => {
  it("is on only with well-formed VAPID keys and a mailto:/https: subject", () => {
    expect(webPushConfig(ENABLED_ENV)).toEqual({ publicKey: VAPID.publicKey, privateKey: VAPID.privateKey, subject: "mailto:ops@resulio.co" });
    expect(webPushConfig({})).toBeNull();
    expect(webPushConfig({ ...ENABLED_ENV, WEB_PUSH_SUBJECT: "ops@resulio.co" })).toBeNull();
    expect(webPushConfig({ ...ENABLED_ENV, WEB_PUSH_SUBJECT: "https://resulio.co" })).not.toBeNull();
    expect(webPushConfig({ ...ENABLED_ENV, WEB_PUSH_VAPID_PRIVATE_KEY: "short" })).toBeNull();
    expect(webPushConfig({ ...ENABLED_ENV, WEB_PUSH_VAPID_PUBLIC_KEY: VAPID.privateKey })).toBeNull();
  });
});

describe("subscription validation", () => {
  it("accepts the browsers' push services", () => {
    for (const endpoint of [
      FCM,
      "https://updates.push.services.mozilla.com/wpush/v2/gAAA",
      "https://web.push.apple.com/QGk1",
      "https://wns2-db5p.notify.windows.com/w/?token=BQYAAA",
      "https://fcm.googleapis.com:443/fcm/send/x",
    ]) {
      expect(isPushServiceEndpoint(endpoint), endpoint).toBe(true);
    }
  });

  it("rejects anything that could make the server call an arbitrary host", () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://evil.example/fcm.googleapis.com",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evilfcm.googleapis.com.attacker.io/",
      "https://notfcm.googleapis.co/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://127.0.0.1/x",
      "https://localhost/x",
      "not a url",
    ]) {
      expect(isPushServiceEndpoint(endpoint), endpoint).toBe(false);
    }
  });

  it("checks key sizes and lengths", () => {
    expect(webPushSubscriptionInput.safeParse(subscription()).success).toBe(true);
    expect(webPushSubscriptionInput.safeParse({ endpoint: FCM, keys: { p256dh: AUTH, auth: AUTH } }).success).toBe(false);
    expect(webPushSubscriptionInput.safeParse({ endpoint: FCM, keys: { p256dh: P256DH, auth: P256DH } }).success).toBe(false);
    expect(webPushSubscriptionInput.safeParse({ endpoint: FCM, keys: { p256dh: "%%%", auth: AUTH } }).success).toBe(false);
    expect(webPushSubscriptionInput.safeParse({ endpoint: `${FCM}/${"a".repeat(2100)}`, keys: { p256dh: P256DH, auth: AUTH } }).success).toBe(false);
  });
});

describe("web push sending", () => {
  it("builds a compact payload the service worker understands", () => {
    const payload = JSON.parse(buildPushPayload({ title: "T".repeat(200), body: "Hello", url: "", tag: "x" }));
    expect(payload).toEqual({ title: `${"T".repeat(119)}…`, body: "Hello", url: "/", tag: "x", icon: "/brand/resulio-icon.png", badge: "/brand/resulio-icon.png" });
  });

  it("maps push service answers: 410/404 gone, 429/5xx/network retryable, 400 permanent", async () => {
    const config = webPushConfig(ENABLED_ENV)!;
    const lib = (statusCode?: number) => ({
      sendNotification: vi.fn(async () => {
        if (statusCode === 201) return { statusCode: 201, body: "", headers: {} };
        throw Object.assign(new Error("push failed"), statusCode ? { statusCode } : {});
      }),
    });
    const opts = { ttlSeconds: 60, urgency: "normal" as const };
    const ok = lib(201);
    expect(await createWebPushSend(config, ok)(target(1), "{}", opts)).toEqual({ ok: true });
    expect(ok.sendNotification).toHaveBeenCalledWith(
      { endpoint: target(1).endpoint, keys: { p256dh: P256DH, auth: AUTH } },
      "{}",
      expect.objectContaining({ TTL: 60, urgency: "normal", vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey } }),
    );
    expect(await createWebPushSend(config, lib(410))(target(1), "{}", opts)).toEqual({ ok: false, gone: true, retryable: false, error: "HTTP_410" });
    expect(await createWebPushSend(config, lib(404))(target(1), "{}", opts)).toMatchObject({ gone: true });
    expect(await createWebPushSend(config, lib(429))(target(1), "{}", opts)).toEqual({ ok: false, gone: false, retryable: true, error: "HTTP_429" });
    expect(await createWebPushSend(config, lib(503))(target(1), "{}", opts)).toMatchObject({ gone: false, retryable: true });
    expect(await createWebPushSend(config, lib())(target(1), "{}", opts)).toEqual({ ok: false, gone: false, retryable: true, error: "NETWORK" });
    expect(await createWebPushSend(config, lib(400))(target(1), "{}", opts)).toMatchObject({ gone: false, retryable: false });
  });

  it("removes subscriptions the push service reports gone and counts the rest", async () => {
    const { ops, calls } = fakeOps();
    const send = sendBy((t) => (t.id === 2 ? gone : t.id === 3 ? { ok: false, gone: false, retryable: true, error: "HTTP_503" } : { ok: true }));
    const summary = await deliverWebPush([target(1), target(2), target(3)], { title: "T", body: "B", url: "/x" }, send, ops, undefined, 2);
    expect(summary).toMatchObject({ sent: 1, failed: 2, gone: 1, retryable: true, firstError: "HTTP_410" });
    expect(calls).toEqual({ removed: [2], failed: [3], succeeded: [1] });
    expect(send.calls).toHaveLength(3);
  });
});

describe("PUSH channel (Expo + browser)", () => {
  const content = { title: "Graded", body: "Your task was graded", path: "/student/tasks/1", email: null };
  const base = () => {
    const { ops, calls } = fakeOps();
    return {
      calls,
      deps: {
        expo: () => null,
        expoTokens: async () => [],
        revokeExpoTokens: async () => {},
        web: () => null as WebPushSend | null,
        webTargets: async () => [target(1), target(2)],
        webOps: ops,
      },
    };
  };

  it("skips when neither push transport is configured", async () => {
    const { deps } = base();
    expect(await createPushAdapter(deps).send(5, content, "GRADE_RELEASED")).toEqual({ status: "SKIPPED", reason: "PUSH_NOT_CONFIGURED" });
  });

  it("sends to the user's browsers and drops a 410 subscription", async () => {
    const { deps, calls } = base();
    const send = sendBy((t) => (t.id === 2 ? gone : { ok: true }));
    deps.web = () => send;
    expect(await createPushAdapter(deps).send(5, content, "GRADE_RELEASED")).toEqual({ status: "SENT" });
    expect(calls.removed).toEqual([2]);
    expect(JSON.parse(send.calls[0])).toMatchObject({ title: "Graded", url: "/student/tasks/1", tag: "grade_released" });
  });

  it("fails (not retryable) when every browser is gone, and skips users without devices", async () => {
    const { deps, calls } = base();
    deps.web = () => sendBy(() => gone);
    expect(await createPushAdapter(deps).send(5, content, "GRADE_RELEASED")).toEqual({ status: "FAILED", reason: "HTTP_410", retryable: false });
    expect(calls.removed).toEqual([1, 2]);
    deps.webTargets = async () => [];
    expect(await createPushAdapter(deps).send(5, content, "GRADE_RELEASED")).toEqual({ status: "SKIPPED", reason: "NO_DEVICE" });
  });

  it("delivers to Expo and browsers together", async () => {
    const { deps } = base();
    const expoSend = vi.fn(async (tokens: string[]) => tokens.map(() => ({ ok: true as const })));
    deps.expo = () => ({ name: "expo", send: expoSend }) as never;
    deps.expoTokens = async () => ["ExponentPushToken[a]"];
    const web = sendBy(() => ({ ok: true }));
    deps.web = () => web;
    expect(await createPushAdapter(deps).send(5, content, "GRADE_RELEASED")).toEqual({ status: "SENT" });
    expect(expoSend).toHaveBeenCalledOnce();
    expect(web.calls).toHaveLength(2);
  });
});

describe("announcement content rules", () => {
  const az = { title: "Salam", body: "Yeni funksiya" };
  const en = { title: "Hello", body: "New feature" };

  it("maps audiences to signed-in segments and anonymous subscribers", () => {
    expect(audiencePlan("ALL")).toEqual({ users: "ALL", anonymous: true });
    expect(audiencePlan("SIGNED_IN")).toEqual({ users: "ALL", anonymous: false });
    expect(audiencePlan("ANONYMOUS")).toEqual({ users: null, anonymous: true });
    expect(audiencePlan("TEACHERS")).toEqual({ users: "TEACHERS", anonymous: false });
    expect(audiencePlan("STUDENTS")).toEqual({ users: "STUDENTS", anonymous: false });
  });

  it("picks each recipient's language and falls back to Azerbaijani", () => {
    const texts: AnnouncementTexts = { az, en };
    expect(pickAnnouncementText(texts, "AUTO", "en")).toEqual(en);
    expect(pickAnnouncementText(texts, "AUTO", "ru")).toEqual(az);
    expect(pickAnnouncementText(texts, "en", "ru")).toEqual(en);
    expect(pickAnnouncementText({ az }, "ru", "ru")).toBeNull();
  });

  it("requires the chosen language (or Azerbaijani for AUTO) and no half-filled translations", () => {
    expect(announcementTextsValid("AUTO", { az })).toBe(true);
    expect(announcementTextsValid("AUTO", { en })).toBe(false);
    expect(announcementTextsValid("AUTO", { az, ru: { title: "Privet", body: " " } })).toBe(false);
    expect(announcementTextsValid("AUTO", { az, ru: { title: "", body: "" } })).toBe(true);
    expect(announcementTextsValid("en", { en })).toBe(true);
    expect(announcementTextsValid("en", { az })).toBe(false);
  });

  it("allows in-site paths and https links only", () => {
    for (const ok of ["/", "/about", "/student?x=1", "https://resulio.co/blog", "https://example.org"]) expect(isSafeAnnouncementUrl(ok), ok).toBe(true);
    for (const bad of ["//evil.example", "/\\evil.example", "http://resulio.co", "javascript:alert(1)", "data:text/html,x", "about", ""]) {
      expect(isSafeAnnouncementUrl(bad), bad).toBe(false);
    }
  });

  it("renders the recipient's language for the in-app feed and push", () => {
    const data = { announcementId: 1, language: "AUTO" as const, texts: { az, en }, url: "/about" };
    expect(renderNotification("ANNOUNCEMENT", data, { locale: "en", email: null }, "https://resulio.co")).toEqual({ title: "Hello", body: "New feature", path: "/about", email: null });
    expect(renderNotification("ANNOUNCEMENT", data, { locale: "ru", email: null }, "https://resulio.co").title).toBe("Salam");
    expect(EVENTS.ANNOUNCEMENT.channels).toEqual(["IN_APP", "PUSH"]);
  });
});

describe("announcement runner", () => {
  const az = { title: "Salam", body: "Yeni" };
  const en = { title: "Hello", body: "New" };

  function harness(audience: "ALL" | "SIGNED_IN" | "ANONYMOUS" | "TEACHERS" | "STUDENTS", opts: { users?: number[]; anon?: AnonymousTarget[]; webOn?: boolean } = {}) {
    const users = opts.users ?? [1, 2, 3];
    const anon = opts.anon ?? [
      { ...target(11), locale: "en" },
      { ...target(12), locale: "az" },
      { ...target(13), locale: "ru" },
    ];
    const claimedRows = new Set<number>();
    const dispatched: Array<{ userId: number; dedupeKey: string }> = [];
    const outbox = new Set<string>();
    const segments: string[] = [];
    const finished: Array<{ status: string; totals: unknown }> = [];
    const send = sendBy((t) => (t.id === 13 ? gone : { ok: true }));
    const { ops, calls } = fakeOps();
    let status = "QUEUED";
    const delivered = new Map<number, string>();
    const deps: AnnouncementRunnerDeps = {
      claim: async (id) => (status === "QUEUED" || status === "SENDING" ? ((status = "SENDING"), { id, audience, language: "AUTO", texts: { az, en }, url: "/about" }) : null),
      userBatch: async (segment, after, limit) => {
        segments.push(segment);
        return users.filter((u) => u > after).slice(0, limit);
      },
      dispatchMany: async (inputs) => {
        for (const i of inputs) {
          if (outbox.has(i.dedupeKey!)) continue;
          outbox.add(i.dedupeKey!);
          dispatched.push({ userId: i.userId, dedupeKey: i.dedupeKey! });
        }
      },
      anonymousBatch: async (after, limit) => anon.filter((s) => s.id > after).slice(0, limit),
      claimDeliveries: async (_a, ids) => ids.filter((id) => !claimedRows.has(id) && claimedRows.add(id)),
      finishDeliveries: async (_a, rows) => rows.forEach((r) => delivered.set(r.subscriptionId, r.status)),
      send: () => (opts.webOn === false ? null : send),
      ops,
      userTotals: async () => ({ inAppSent: dispatched.length, pushSent: 0, pushFailed: 0 }),
      anonymousTotals: async () => ({
        sent: [...delivered.values()].filter((s) => s === "SENT").length,
        failed: [...delivered.values()].filter((s) => s !== "SENT").length,
      }),
      finish: async (_id, s, totals) => {
        status = s;
        finished.push({ status: s, totals });
      },
    };
    return { run: createAnnouncementRunner(deps), dispatched, send, calls, segments, finished, delivered, reopen: () => (status = "SENDING") };
  }

  it("sends ALL to every signed-in user through the dispatcher and to anonymous subscribers in their language", async () => {
    const h = harness("ALL");
    const totals = await h.run(7);
    expect(h.dispatched).toEqual([1, 2, 3].map((userId) => ({ userId, dedupeKey: announcementDedupeKey(7, userId) })));
    expect(h.segments[0]).toBe("ALL");
    const titles = h.send.calls.map((p) => JSON.parse(p)).map((p) => [p.title, p.tag]);
    expect(titles).toEqual(expect.arrayContaining([["Hello", "announcement-7"], ["Salam", "announcement-7"]]));
    expect(h.calls.removed).toEqual([13]);
    expect(totals).toEqual({ targetUsers: 3, targetAnonymous: 3, inAppSent: 3, pushSent: 2, pushFailed: 1 });
    expect(h.finished.at(-1)?.status).toBe("SENT");
  });

  it("is idempotent: a resumed run sends nothing twice and a finished one does nothing", async () => {
    const h = harness("ALL");
    await h.run(7);
    h.reopen();
    await h.run(7);
    expect(h.dispatched).toHaveLength(3);
    expect(h.send.calls).toHaveLength(3);
    expect(await h.run(7)).toBeNull();
    expect(h.finished).toHaveLength(2);
  });

  it("targets only the chosen audience", async () => {
    const anonymous = harness("ANONYMOUS");
    await anonymous.run(1);
    expect(anonymous.dispatched).toEqual([]);
    expect(anonymous.send.calls).toHaveLength(3);

    for (const audience of ["SIGNED_IN", "TEACHERS", "STUDENTS"] as const) {
      const h = harness(audience);
      await h.run(1);
      expect(h.segments[0]).toBe(audience === "SIGNED_IN" ? "ALL" : audience);
      expect(h.send.calls, audience).toHaveLength(0);
      expect(h.dispatched).toHaveLength(3);
    }
  });

  it("still reaches signed-in users when web push is off", async () => {
    const h = harness("ALL", { webOn: false });
    const totals = await h.run(2);
    expect(h.dispatched).toHaveLength(3);
    expect(totals?.targetAnonymous).toBe(0);
    expect(h.finished.at(-1)?.status).toBe("SENT");
  });
});

describe("service worker", () => {
  const source = readFileSync(path.resolve(__dirname, "../client/public/sw.js"), "utf8");

  function load(self?: unknown) {
    const context: Record<string, unknown> = { URL, self };
    vm.runInNewContext(source, context);
    return context as { parsePushPayload: (text: string) => { title: string; options: Record<string, unknown> & { data: { url: string } } } };
  }

  it("parses payloads safely (pure function)", () => {
    const { parsePushPayload } = load();
    expect(parsePushPayload(buildPushPayload({ title: "Hi", body: "There", url: "/about", tag: "t1" }))).toEqual({
      title: "Hi",
      options: { body: "There", icon: "/brand/resulio-icon.png", badge: "/brand/resulio-icon.png", tag: "t1", data: { url: "/about" } },
    });
    expect(parsePushPayload("").title).toBe("Resulio.co");
    expect(parsePushPayload("plain text").options.body).toBe("plain text");
    expect(parsePushPayload("null").title).toBe("Resulio.co");
    expect(parsePushPayload(JSON.stringify({ url: "javascript:alert(1)" })).options.data.url).toBe("/");
    expect(parsePushPayload(JSON.stringify({ url: "//evil.example" })).options.data.url).toBe("/");
    expect(parsePushPayload(JSON.stringify({ url: "https://resulio.co/blog" })).options.data.url).toBe("https://resulio.co/blog");
    expect(parsePushPayload(JSON.stringify({ icon: "https://evil.example/x.png" })).options.icon).toBe("/brand/resulio-icon.png");
  });

  it("shows pushes and focuses an open tab on click (no fetch handler)", async () => {
    const handlers: Record<string, (event: unknown) => void> = {};
    const showNotification = vi.fn(async () => {});
    const tab = { url: "https://resulio.co/welcome", focus: vi.fn(async () => tab), navigate: vi.fn(async () => tab) };
    const openWindow = vi.fn(async () => null);
    const self = {
      addEventListener: (type: string, fn: (event: unknown) => void) => (handlers[type] = fn),
      skipWaiting: vi.fn(),
      registration: { showNotification },
      location: { origin: "https://resulio.co" },
      clients: { claim: vi.fn(), matchAll: vi.fn(async () => [tab]), openWindow },
    };
    load(self);
    expect(Object.keys(handlers).sort()).toEqual(["activate", "install", "notificationclick", "push"]);

    let pending: Promise<unknown> = Promise.resolve();
    const waitUntil = (p: Promise<unknown>) => (pending = p);
    handlers.push({ data: { text: () => buildPushPayload({ title: "Hi", body: "B", url: "/about" }) }, waitUntil });
    await pending;
    expect(showNotification).toHaveBeenCalledWith("Hi", expect.objectContaining({ body: "B", data: { url: "/about" } }));

    const close = vi.fn();
    handlers.notificationclick({ notification: { close, data: { url: "/about" } }, waitUntil });
    await pending;
    expect(close).toHaveBeenCalled();
    expect(tab.focus).toHaveBeenCalled();
    expect(tab.navigate).toHaveBeenCalledWith("https://resulio.co/about");
    expect(openWindow).not.toHaveBeenCalled();

    self.clients.matchAll = vi.fn(async () => []);
    handlers.notificationclick({ notification: { close, data: { url: "https://example.org/x" } }, waitUntil });
    await pending;
    expect(openWindow).toHaveBeenCalledWith("https://example.org/x");
  });
});

describe("web push endpoints", () => {
  const roles = vi.mocked(accessMod.platformRolesOf);
  const create = vi.mocked(announcementsMod.createAnnouncement);
  const save = vi.mocked(webPushMod.saveSubscription);
  const caller = (user: { id: number; email?: string } | null, authTimeMs?: number) =>
    appRouter.createCaller({
      user: user ? ({ id: user.id, email: user.email ?? null, accountStatus: "ACTIVE", role: "user", openId: `u${user.id}` } as unknown as TrpcContext["user"]) : null,
      session: authTimeMs ? ({ authTimeMs, issuedAtMs: authTimeMs } as unknown as TrpcContext["session"]) : null,
      req: { ip: "10.0.0.7", protocol: "https", headers: { "user-agent": "Edge" } } as unknown as TrpcContext["req"],
      res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    } as TrpcContext);
  const codeOf = (p: Promise<unknown>) => p.then(() => "resolved", (e: { code?: string; message?: string }) => `${e.code}:${e.message}`);
  const input = { audience: "ALL" as const, language: "AUTO" as const, texts: { az: { title: "Salam", body: "Yeni" } }, url: "/about" };

  beforeEach(() => {
    resetRateLimits();
    roles.mockReset();
    roles.mockResolvedValue([]);
    create.mockClear();
    save.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("exposes the public key at runtime and nothing when disabled", async () => {
    vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", "");
    expect(await caller(null).webPush.config()).toEqual({ enabled: false, publicKey: null });
    for (const [k, v] of Object.entries(ENABLED_ENV)) vi.stubEnv(k, v);
    expect(await caller(null).webPush.config()).toEqual({ enabled: true, publicKey: VAPID.publicKey });
  });

  it("stores anonymous and signed-in subscriptions, and refuses foreign endpoints", async () => {
    for (const [k, v] of Object.entries(ENABLED_ENV)) vi.stubEnv(k, v);
    expect(await caller(null).webPush.subscribe({ subscription: subscription(), locale: "en" })).toEqual({ ok: true, enabled: true });
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ endpoint: FCM, userId: null, locale: "en", userAgent: "Edge" }));
    await caller({ id: 9 }).webPush.subscribe({ subscription: subscription(), locale: "az" });
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 9 }));
    expect(await codeOf(caller(null).webPush.subscribe({ subscription: subscription("https://169.254.169.254/latest"), locale: "az" }))).toMatch(/^BAD_REQUEST/);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("does nothing when web push is off and rate-limits subscribing", async () => {
    vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", "");
    expect(await caller(null).webPush.subscribe({ subscription: subscription(), locale: "az" })).toEqual({ ok: false, enabled: false });
    expect(save).not.toHaveBeenCalled();
    for (let i = 0; i < 19; i++) await caller(null).webPush.subscribe({ subscription: subscription(), locale: "az" });
    expect(await codeOf(caller(null).webPush.subscribe({ subscription: subscription(), locale: "az" }))).toMatch(/^TOO_MANY_REQUESTS/);
  });

  it("lets only admins with announcements.send (and a recent sign-in) send", async () => {
    expect(await codeOf(caller(null).admin.announcements.send(input))).toMatch(/^UNAUTHORIZED/);
    expect(await codeOf(caller({ id: 3 }, Date.now()).admin.announcements.send(input))).toBe("FORBIDDEN:NOT_ADMIN");
    roles.mockResolvedValue(["SUPPORT_ADMIN"]);
    expect(await codeOf(caller({ id: 3 }, Date.now()).admin.announcements.send(input))).toBe("FORBIDDEN:ADMIN_PERMISSION");
    expect(await codeOf(caller({ id: 3 }, Date.now()).admin.announcements.list())).toBe("FORBIDDEN:ADMIN_PERMISSION");

    vi.stubEnv("SUPER_ADMIN_EMAILS", "boss@resulio.co");
    roles.mockResolvedValue(["SUPER_ADMIN"]);
    const boss = { id: 1, email: "boss@resulio.co" };
    expect(await codeOf(caller(boss, Date.now() - 2 * 60 * 60 * 1000).admin.announcements.send(input))).toBe("FORBIDDEN:REAUTH_REQUIRED");
    expect(create).not.toHaveBeenCalled();
    expect(await caller(boss, Date.now()).admin.announcements.send(input)).toEqual({ id: 42 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ userId: 1 }), input);
  });

  it("validates announcements on the server", async () => {
    vi.stubEnv("SUPER_ADMIN_EMAILS", "boss@resulio.co");
    roles.mockResolvedValue(["SUPER_ADMIN"]);
    const api = caller({ id: 1, email: "boss@resulio.co" }, Date.now()).admin.announcements;
    expect(await codeOf(api.send({ ...input, url: "javascript:alert(1)" }))).toMatch(/^BAD_REQUEST/);
    expect(await codeOf(api.send({ ...input, texts: { en: { title: "Hi", body: "x" } } }))).toMatch(/^BAD_REQUEST/);
    expect(await codeOf(api.send({ ...input, texts: { az: { title: "x".repeat(81), body: "y" } } }))).toMatch(/^BAD_REQUEST/);
    await api.send({ ...input, texts: { az: { title: " Salam ", body: "Yeni" }, ru: { title: "", body: "" } } });
    expect(create).toHaveBeenLastCalledWith(expect.anything(), { ...input, texts: { az: { title: "Salam", body: "Yeni" } } });
  });

  it("keeps announcement sending a high-risk, super-admin-only permission", () => {
    expect(HIGH_RISK_PERMISSIONS).toContain("announcements.send");
    expect(permissionsOf(["SUPPORT_ADMIN"])).not.toContain("announcements.send");
    expect(permissionsOf(["SUPPORT_ADMIN"])).not.toContain("announcements.view");
    expect(permissionsOf(["SUPER_ADMIN"])).toEqual(expect.arrayContaining(["announcements.view", "announcements.send"]));
  });
});

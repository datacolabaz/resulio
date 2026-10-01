import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeReturnTo as clientSafeReturnTo } from "../client/src/const";
import type { User } from "../drizzle/schema";
import { getSessionCookieOptions } from "./_core/cookies";
import type { TrpcContext } from "./_core/context";
import { isCrossSiteWrite } from "./_core/csrf";
import { safeReturnTo, encodeOAuthState, decodeOAuthState, loginCatchReason } from "./_core/googleAuth";
import { apiCors } from "./_core/cors";
import { ENV, envString, cookieDomainFromEnv, withWwwAliases } from "./_core/env";
import { canonicalRedirect, frontendRedirect } from "./_core/hostRedirect";
import { hitRateLimit, resetRateLimits } from "./_core/rateLimit";
import { isRevoked, sdk } from "./_core/sdk";
import { WORKSPACE_HEADER } from "../shared/const";
import * as access from "./modules/access";
import { validateAiQuestions } from "./modules/ai";
import { AppError, toTrpcError } from "./modules/errors";
import { appRouter } from "./routers";

vi.mock("./modules/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./modules/access")>();
  return {
    ...actual,
    resolveWorkspace: vi.fn(),
    partnerProfileOf: vi.fn(),
    platformRolesOf: vi.fn(),
    resolveAccess: vi.fn(),
  };
});

const mocked = vi.mocked(access);
const SECRET = "unit-test-session-secret-0123456789abcdef";

function user(overrides: Partial<User> = {}): User {
  return {
    id: 7,
    openId: "google:123",
    name: "Test",
    email: "test@example.com",
    avatarUrl: null,
    loginMethod: "google",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    preferredLocale: "az",
    lastActiveContext: null,
    accountStatus: "ACTIVE",
    suspendedAt: null,
    sessionsValidAfter: null,
    lastSeenAt: new Date(),
    timezone: null,
    targetExam: null,
    targetScore: null,
    targetExamDate: null,
    studentOnboardedAt: null,
    ...overrides,
  };
}

const WORKSPACE = {
  id: "ws_mine",
  ownerUserId: 7,
  title: "Mənim məkanım",
  publicDisplayName: "",
  providerType: "TEACHER" as const,
  subscriptionStatus: "BETA" as const,
  createdAt: new Date(),
};

function accessOf(over: Partial<access.UserAccess> = {}): access.UserAccess {
  return {
    contexts: { learning: false, teaching: false, partner: false },
    activeMemberships: 0,
    pendingMemberships: 0,
    workspaces: [],
    partnerStatus: null,
    platformRoles: [],
    ...over,
  };
}

function caller(u: User | null, ip = "10.0.0.1", headers: Record<string, string> = {}, session: TrpcContext["session"] = null) {
  const ctx: TrpcContext = {
    user: u,
    session,
    req: { ip, protocol: "https", headers } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof TRPCError ? `${e.code}:${e.message}` : `THROWN:${(e as Error).message}`;
  }
}

beforeEach(() => {
  resetRateLimits();
  mocked.resolveWorkspace.mockResolvedValue(WORKSPACE);
  mocked.partnerProfileOf.mockResolvedValue(null);
  mocked.platformRolesOf.mockResolvedValue([]);
  mocked.resolveAccess.mockResolvedValue(accessOf());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("context-based access", () => {
  it("requires a session for protected procedures", async () => {
    expect(await codeOf(caller(null).teacher.dashboard())).toMatch(/^UNAUTHORIZED/);
    expect(await codeOf(caller(null).student.results())).toMatch(/^UNAUTHORIZED/);
    expect(await codeOf(caller(null).workspaces.create({ title: "Məkan" }))).toMatch(/^UNAUTHORIZED/);
  });

  it("requires an owned provider workspace for teaching procedures", async () => {
    mocked.resolveWorkspace.mockResolvedValue(null);
    expect(await codeOf(caller(user()).teacher.dashboard())).toBe("FORBIDDEN:NO_WORKSPACE");
    expect(await codeOf(caller(user()).teacher.assessments.publish({ id: "a1" }))).toBe("FORBIDDEN:NO_WORKSPACE");
  });

  it("treats the workspace header only as a hint verified against ownership", async () => {
    mocked.resolveWorkspace.mockResolvedValue(null);
    const c = caller(user(), "10.0.0.1", { [WORKSPACE_HEADER]: "ws_someone_else" });
    expect(await codeOf(c.teacher.dashboard())).toBe("FORBIDDEN:NO_WORKSPACE");
    expect(mocked.resolveWorkspace).toHaveBeenCalledWith(7, "ws_someone_else");
  });

  it("picks only workspaces from the owned list", () => {
    const owned = [{ id: "ws_a" }, { id: "ws_b" }];
    expect(access.pickWorkspace(owned, "ws_b")).toEqual({ id: "ws_b" });
    expect(access.pickWorkspace(owned, "ws_foreign")).toBeNull();
    expect(access.pickWorkspace(owned, null)).toEqual({ id: "ws_a" });
    expect(access.pickWorkspace([], null)).toBeNull();
  });

  it("lets the same user act as student and teacher without a global role", async () => {
    const u = caller(user());
    expect(await codeOf(u.teacher.dashboard())).toBe("INTERNAL_SERVER_ERROR:DATABASE_UNAVAILABLE");
    expect(await codeOf(u.student.results())).toBe("INTERNAL_SERVER_ERROR:DATABASE_UNAVAILABLE");
  });

  it("opens the partner context only for an approved partner profile", async () => {
    expect(await codeOf(caller(user()).partner.dashboard())).toBe("FORBIDDEN:PARTNER_ONLY");
    const profile = { id: 1, userId: 7, status: "PENDING" as const, referralCode: "ABC", approvedAt: null, createdAt: new Date() };
    mocked.partnerProfileOf.mockResolvedValue(profile);
    expect(await codeOf(caller(user()).partner.dashboard())).toBe("FORBIDDEN:PARTNER_ONLY");
    mocked.partnerProfileOf.mockResolvedValue({ ...profile, status: "APPROVED", approvedAt: new Date() });
    expect(await caller(user()).partner.dashboard()).toMatchObject({ status: "APPROVED", referralCode: "ABC" });
  });

  it("requires an explicit platform_roles record and the permission for admin procedures", async () => {
    vi.stubEnv("SUPER_ADMIN_EMAILS", "test@example.com");
    expect(await codeOf(caller(null).admin.partners.list())).toMatch(/^UNAUTHORIZED/);
    expect(await codeOf(caller(user()).admin.partners.list())).toBe("FORBIDDEN:NOT_ADMIN");
    mocked.platformRolesOf.mockResolvedValue(["PARTNER_ADMIN", "FINANCE_ADMIN", "CONTENT_REVIEWER"]);
    expect(await codeOf(caller(user()).admin.partners.list())).toBe("FORBIDDEN:NOT_ADMIN");
    mocked.platformRolesOf.mockResolvedValue(["SUPPORT_ADMIN"]);
    expect(await codeOf(caller(user()).admin.partners.list())).toBe("INTERNAL_SERVER_ERROR:DATABASE_UNAVAILABLE");
    expect(await codeOf(caller(user()).admin.partners.decide({ id: 1, decision: "APPROVE", reason: "Sənədlər yoxlanıldı" }))).toBe(
      "FORBIDDEN:ADMIN_PERMISSION",
    );
    mocked.platformRolesOf.mockResolvedValue(["SUPER_ADMIN"]);
    expect(await codeOf(caller(user()).admin.partners.list())).toBe("INTERNAL_SERVER_ERROR:DATABASE_UNAVAILABLE");
  });

  it("counts SUPER_ADMIN only for allowlisted e-mails", async () => {
    mocked.platformRolesOf.mockResolvedValue(["SUPER_ADMIN"]);
    vi.stubEnv("SUPER_ADMIN_EMAILS", "owner@resulio.co");
    expect(await codeOf(caller(user()).admin.partners.list())).toBe("FORBIDDEN:NOT_ADMIN");
    vi.stubEnv("SUPER_ADMIN_EMAILS", "owner@resulio.co, TEST@example.com");
    expect(await codeOf(caller(user()).admin.partners.list())).toBe("INTERNAL_SERVER_ERROR:DATABASE_UNAVAILABLE");
  });

  it("requires a recent sign-in for high-risk admin actions", async () => {
    vi.stubEnv("SUPER_ADMIN_EMAILS", "test@example.com");
    mocked.platformRolesOf.mockResolvedValue(["SUPER_ADMIN"]);
    const input = { userId: 9, reason: "Şikayət üzrə yoxlama" };
    expect(await codeOf(caller(user()).admin.users.suspend(input))).toBe("FORBIDDEN:REAUTH_REQUIRED");
    const stale = Date.now() - 2 * 60 * 60 * 1000;
    expect(await codeOf(caller(user(), "10.0.0.1", {}, { issuedAtMs: stale, authTimeMs: stale }).admin.users.suspend(input))).toBe(
      "FORBIDDEN:REAUTH_REQUIRED",
    );
    const fresh = Date.now() - 60_000;
    expect(await codeOf(caller(user(), "10.0.0.1", {}, { issuedAtMs: fresh, authTimeMs: fresh }).admin.users.suspend(input))).toBe(
      "INTERNAL_SERVER_ERROR:DATABASE_UNAVAILABLE",
    );
    expect(await codeOf(caller(user(), "10.0.0.1", {}, { issuedAtMs: fresh, authTimeMs: fresh }).admin.users.suspend({ userId: 9, reason: "qısa" }))).toMatch(
      /^BAD_REQUEST/,
    );
  });

  it("refuses protected and admin procedures for a suspended account but still answers auth.me", async () => {
    vi.stubEnv("SUPER_ADMIN_EMAILS", "test@example.com");
    mocked.platformRolesOf.mockResolvedValue(["SUPER_ADMIN"]);
    mocked.resolveAccess.mockResolvedValue(accessOf({ platformRoles: ["SUPER_ADMIN"] }));
    const suspended = caller(user({ accountStatus: "SUSPENDED", suspendedAt: new Date() }));
    expect(await codeOf(suspended.student.results())).toBe("FORBIDDEN:ACCOUNT_SUSPENDED");
    expect(await codeOf(suspended.teacher.dashboard())).toBe("FORBIDDEN:ACCOUNT_SUSPENDED");
    expect(await codeOf(suspended.admin.partners.list())).toBe("FORBIDDEN:ACCOUNT_SUSPENDED");
    expect(await suspended.auth.me()).toMatchObject({ accountStatus: "SUSPENDED", admin: null, isAdmin: false });
    expect(await codeOf(suspended.auth.logout())).toBe("OK");
  });

  it("rejects switching to a context the user's records do not allow", async () => {
    expect(await codeOf(caller(user()).auth.setActiveContext({ context: "teaching" }))).toBe("FORBIDDEN:CONTEXT_UNAVAILABLE");
    expect(await codeOf(caller(user()).auth.setActiveContext({ context: "partner" }))).toBe("FORBIDDEN:CONTEXT_UNAVAILABLE");
    expect(await codeOf(caller(user()).auth.setActiveContext({ context: "admin" as never }))).toMatch(/^BAD_REQUEST/);
    mocked.resolveAccess.mockResolvedValue(accessOf({ contexts: { learning: false, teaching: true, partner: false } }));
    expect(await codeOf(caller(user({ lastActiveContext: "teaching" })).auth.setActiveContext({ context: "teaching" }))).toBe("OK");
  });

  it("enforces the teacher email allowlist when opening a workspace", async () => {
    vi.stubEnv("TEACHER_EMAIL_ALLOWLIST", "teacher@school.az");
    expect(await codeOf(caller(user()).workspaces.create({ title: "Məkan" }))).toBe("FORBIDDEN:WORKSPACE_NOT_ALLOWED");
  });

  it("exposes public profile fields plus derived contexts", async () => {
    vi.stubEnv("SUPER_ADMIN_EMAILS", "test@example.com");
    mocked.resolveAccess.mockResolvedValue(
      accessOf({ contexts: { learning: true, teaching: true, partner: false }, activeMemberships: 1, platformRoles: ["SUPER_ADMIN"] }),
    );
    const me = await caller(user({ lastActiveContext: "teaching" })).auth.me();
    expect(me).toMatchObject({
      id: 7,
      name: "Test",
      email: "test@example.com",
      avatarUrl: null,
      locale: "az",
      lastActiveContext: "teaching",
      contexts: { learning: true, teaching: true, partner: false },
      accountStatus: "ACTIVE",
      isAdmin: true,
      admin: { roles: ["SUPER_ADMIN"] },
      defaultContext: "teaching",
    });
    expect((me as { admin: { permissions: string[] } }).admin.permissions).toContain("users.suspend");
    expect(me).not.toHaveProperty("openId");
    expect(await caller(null).auth.me()).toBeNull();
  });

  it("guards activity tracking endpoints by session and owned workspace", async () => {
    expect(await codeOf(caller(null).teacher.activity())).toMatch(/^UNAUTHORIZED/);
    expect(await codeOf(caller(null).teacher.assessments.participants({ id: "a1" }))).toMatch(/^UNAUTHORIZED/);
    expect(await codeOf(caller(null).student.ping({ attemptId: "t1", interacted: true }))).toMatch(/^UNAUTHORIZED/);
    expect(await codeOf(caller(null).student.trackView({ assessmentId: "a1" }))).toMatch(/^UNAUTHORIZED/);

    mocked.resolveWorkspace.mockResolvedValue(null);
    const student = caller(user());
    expect(await codeOf(student.teacher.activity())).toBe("FORBIDDEN:NO_WORKSPACE");
    expect(await codeOf(student.teacher.assessments.participants({ id: "a1" }))).toBe("FORBIDDEN:NO_WORKSPACE");
    expect(await codeOf(student.teacher.assessments.setInactivityThreshold({ id: "a1", minutes: 10 }))).toBe("FORBIDDEN:NO_WORKSPACE");
  });

  it("disables demo login in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await caller(null).auth.demoAvailable()).toBe(false);
    expect(await codeOf(caller(null).auth.demoLogin({ role: "TEACHER" }))).toBe("FORBIDDEN:DEMO_DISABLED");
  });
});

describe("context resolution", () => {
  it("allows the learning area with active or pending memberships", () => {
    expect(access.canEnterContext(accessOf(), "learning")).toBe(false);
    expect(access.canEnterContext(accessOf({ pendingMemberships: 1 }), "learning")).toBe(true);
    expect(access.canEnterContext(accessOf({ activeMemberships: 2 }), "learning")).toBe(true);
    expect(access.canEnterContext(accessOf({ partnerStatus: "PENDING" }), "partner")).toBe(false);
  });

  it("prefers the last context while it is still valid", () => {
    const both = accessOf({ contexts: { learning: true, teaching: true, partner: false }, activeMemberships: 1 });
    expect(access.defaultContext(both, "teaching")).toBe("teaching");
    expect(access.defaultContext(both, "partner")).toBe("learning");
    expect(access.defaultContext(both, null)).toBe("learning");
    expect(access.defaultContext(accessOf({ contexts: { learning: false, teaching: true, partner: false } }), "learning")).toBe("teaching");
    expect(access.defaultContext(accessOf(), null)).toBeNull();
  });
});

describe("input validation and rate limits", () => {
  it("rejects malformed exam writes before touching the database", async () => {
    const s = caller(user());
    expect(await codeOf(s.student.save({ attemptId: "x", entries: [] }))).toMatch(/^BAD_REQUEST/);
    expect(await codeOf(s.student.save({ attemptId: "x", entries: [{ questionId: "q", answer: { nested: { deep: 1 } } as never }] }))).toMatch(/^BAD_REQUEST/);
    expect(await codeOf(caller(user()).teacher.results.grade({ resultId: "r", questionId: "q", points: -1 }))).toMatch(/^BAD_REQUEST/);
  });

  it("accepts only the offered inactivity thresholds", async () => {
    const t = caller(user()).teacher.assessments;
    for (const minutes of [0, 7, 60, -5]) expect(await codeOf(t.setInactivityThreshold({ id: "a1", minutes: minutes as never }))).toMatch(/^BAD_REQUEST/);
    expect(await codeOf(t.setInactivityThreshold({ id: "a1", minutes: "10" as never }))).toMatch(/^BAD_REQUEST/);
    expect(await codeOf(t.setInactivityThreshold({ id: "a1", minutes: 15 }))).toBe("INTERNAL_SERVER_ERROR:DATABASE_UNAVAILABLE");
    expect(await codeOf(t.setInactivityThreshold({ id: "a1", minutes: null }))).toBe("INTERNAL_SERVER_ERROR:DATABASE_UNAVAILABLE");
  });

  it("rejects invalid answer revisions and ping payloads", async () => {
    const s = caller(user());
    for (const revision of [0, -1, 1.5]) {
      expect(await codeOf(s.student.save({ attemptId: "t1", entries: [{ questionId: "q", answer: "a", revision }] }))).toMatch(/^BAD_REQUEST/);
    }
    expect(await codeOf(s.student.ping({ attemptId: "t1", interacted: "yes" as never }))).toMatch(/^BAD_REQUEST/);
  });

  it("limits session pings per user", async () => {
    const s = caller(user());
    for (let i = 0; i < 30; i++) await codeOf(s.student.ping({ attemptId: "t1", interacted: false }));
    expect(await codeOf(s.student.ping({ attemptId: "t1", interacted: false }))).toBe("TOO_MANY_REQUESTS:RATE_LIMITED");
  });

  it("limits exam start and submit per user", async () => {
    const s = caller(user());
    for (let i = 0; i < 10; i++) expect(await codeOf(s.student.start({ assessmentId: "a1" }))).not.toMatch(/^TOO_MANY_REQUESTS/);
    expect(await codeOf(s.student.start({ assessmentId: "a1" }))).toBe("TOO_MANY_REQUESTS:RATE_LIMITED");
    for (let i = 0; i < 10; i++) await codeOf(s.student.submit({ attemptId: "t1" }));
    expect(await codeOf(s.student.submit({ attemptId: "t1" }))).toBe("TOO_MANY_REQUESTS:RATE_LIMITED");
    const other = caller(user({ id: 8 }));
    expect(await codeOf(other.student.start({ assessmentId: "a1" }))).not.toMatch(/^TOO_MANY_REQUESTS/);
  });

  it("reports a missing database as a stable machine code", async () => {
    expect(await codeOf(caller(user()).teacher.dashboard())).toBe("INTERNAL_SERVER_ERROR:DATABASE_UNAVAILABLE");
  });

  it("uses fixed windows", () => {
    expect(hitRateLimit("k", 2, 1000, 0)).toBe(false);
    expect(hitRateLimit("k", 2, 1000, 10)).toBe(false);
    expect(hitRateLimit("k", 2, 1000, 20)).toBe(true);
    expect(hitRateLimit("k", 2, 1000, 1001)).toBe(false);
  });
});

describe("errors", () => {
  it("maps domain codes to tRPC codes and hides unknown errors", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(toTrpcError(new AppError("NO_ACCESS"))).toMatchObject({ code: "FORBIDDEN", message: "NO_ACCESS" });
    expect(toTrpcError(new AppError("NO_ATTEMPTS_LEFT"))).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(toTrpcError(new AppError("INVALID_QUESTION"))).toMatchObject({ code: "BAD_REQUEST" });
    expect(toTrpcError(new Error("ATTEMPT_CLOSED"))).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(toTrpcError(new Error("ER_ACCESS_DENIED password=secret"))).toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "INTERNAL_ERROR" });
  });
});

describe("sessions and cookies", () => {
  it("signs and verifies session tokens and rejects tampering", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const token = await sdk.createSessionToken("google:1", { name: "A" });
    expect(await sdk.verifySession(token)).toMatchObject({ openId: "google:1", name: "A" });
    expect(await sdk.verifySession(`${token.slice(0, -2)}xx`)).toBeNull();
    vi.stubEnv("SESSION_SECRET", `${SECRET}-rotated`);
    expect(await sdk.verifySession(token)).toBeNull();
  });

  it("carries millisecond issue and sign-in times, keeping the sign-in time across refreshes", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const before = Date.now();
    const fresh = await sdk.verifySession(await sdk.createSessionToken("google:1", { name: "A" }));
    expect(fresh!.issuedAtMs).toBeGreaterThanOrEqual(before);
    expect(fresh!.authTimeMs).toBe(fresh!.issuedAtMs);
    const signedInAt = before - 3_600_000;
    const refreshed = await sdk.verifySession(await sdk.createSessionToken("google:1", { name: "A", authTimeMs: signedInAt }));
    expect(refreshed!.authTimeMs).toBe(signedInAt);
  });

  it("treats sessions issued before sessionsValidAfter as revoked", () => {
    const cut = new Date("2026-09-29T10:00:00.500Z");
    const at = (ms: number) => ({ issuedAtMs: ms, authTimeMs: ms });
    expect(isRevoked({ sessionsValidAfter: null }, at(0))).toBe(false);
    expect(isRevoked({ sessionsValidAfter: cut }, at(cut.getTime() - 1))).toBe(true);
    expect(isRevoked({ sessionsValidAfter: cut }, at(cut.getTime()))).toBe(false);
    expect(isRevoked({ sessionsValidAfter: cut }, at(cut.getTime() + 1000))).toBe(false);
  });

  it("refuses to sign with a missing or short secret", async () => {
    vi.stubEnv("SESSION_SECRET", "short");
    await expect(sdk.createSessionToken("x")).rejects.toThrow("SESSION_SECRET");
  });

  it("issues httpOnly SameSite=Lax cookies, secure in production", () => {
    const http = { protocol: "http", headers: {} } as never;
    expect(getSessionCookieOptions(http)).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(getSessionCookieOptions(http).domain).toBeUndefined();
    vi.stubEnv("NODE_ENV", "production");
    expect(getSessionCookieOptions(http).secure).toBe(true);
  });

  it("shares the session cookie across resulio.co and api.resulio.co", () => {
    vi.stubEnv("FRONTEND_URL", "https://resulio.co");
    const https = { protocol: "https", headers: {} } as never;
    expect(getSessionCookieOptions(https).domain).toBe(".resulio.co");
  });
});

describe("CSRF guard", () => {
  const req = (method: string, headers: Record<string, string>, path = "/api/trpc/student.submit") => ({ method, headers, path }) as never;

  it("allows same-origin JSON writes and safe reads", () => {
    expect(isCrossSiteWrite(req("POST", { origin: "https://resulio.co", "content-type": "application/json" }), "resulio.co")).toBe(false);
    expect(isCrossSiteWrite(req("GET", { origin: "https://evil.example" }), "resulio.co")).toBe(false);
  });

  it("rejects cross-origin or non-JSON writes", () => {
    expect(isCrossSiteWrite(req("POST", { origin: "https://evil.example", "content-type": "application/json" }), "resulio.co")).toBe(true);
    expect(isCrossSiteWrite(req("POST", { referer: "https://evil.example/x", "content-type": "application/json" }), "resulio.co")).toBe(true);
    expect(isCrossSiteWrite(req("POST", { origin: "null", "content-type": "application/json" }), "resulio.co")).toBe(true);
    expect(isCrossSiteWrite(req("POST", { origin: "https://resulio.co", "content-type": "text/plain" }), "resulio.co")).toBe(true);
  });

  it("accepts the allowlisted frontend origin on the API host only", () => {
    const json = { "content-type": "application/json" };
    const allow = ["https://resulio.co"];
    expect(isCrossSiteWrite(req("POST", { origin: "https://resulio.co", ...json }), "api.resulio.co", allow)).toBe(false);
    expect(isCrossSiteWrite(req("POST", { origin: "https://resulio.co", ...json }), "api.resulio.co")).toBe(true);
    expect(isCrossSiteWrite(req("POST", { origin: "http://resulio.co", ...json }), "api.resulio.co", allow)).toBe(true);
    expect(isCrossSiteWrite(req("POST", { origin: "https://evil.example", ...json }), "api.resulio.co", allow)).toBe(true);
    expect(isCrossSiteWrite(req("POST", { origin: "https://resulio.co", "content-type": "text/plain" }), "api.resulio.co", allow)).toBe(true);
  });
});

describe("two-service CORS", () => {
  function call(method: string, path: string, origin?: string) {
    const headers: Record<string, string> = {};
    let status = 0;
    let nextCalled = false;
    const req = { method, path, get: (name: string) => (name.toLowerCase() === "origin" ? origin : undefined) } as never;
    const res = {
      setHeader: (k: string, v: string) => void (headers[k.toLowerCase()] = v),
      append: (k: string, v: string) => void (headers[k.toLowerCase()] = v),
      status(code: number) {
        status = code;
        return this;
      },
      end: () => undefined,
    } as never;
    apiCors(req, res, () => void (nextCalled = true));
    return { headers, status, nextCalled };
  }

  it("normalises the allowed origins", () => {
    vi.stubEnv("FRONTEND_URL", "https://resulio.co/");
    vi.stubEnv("CORS_ALLOWED_ORIGINS", " https://staging.resulio.co , not a url, https://resulio.co");
    expect(ENV.frontendUrl).toBe("https://resulio.co");
    expect(ENV.corsAllowedOrigins).toEqual(["https://resulio.co", "https://staging.resulio.co", "https://www.resulio.co"]);
  });

  it("allows credentials for the frontend origin and answers its preflight", () => {
    vi.stubEnv("FRONTEND_URL", "https://resulio.co");
    const get = call("POST", "/api/trpc/x", "https://resulio.co");
    expect(get.nextCalled).toBe(true);
    expect(get.headers["access-control-allow-origin"]).toBe("https://resulio.co");
    expect(get.headers["access-control-allow-credentials"]).toBe("true");
    const pre = call("OPTIONS", "/api/trpc/x", "https://resulio.co");
    expect(pre.nextCalled).toBe(false);
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-headers"]).toContain(WORKSPACE_HEADER);
  });

  it("gives other origins, non-API paths and single-service mode no CORS headers", () => {
    vi.stubEnv("FRONTEND_URL", "https://resulio.co");
    expect(call("POST", "/api/trpc/x", "https://evil.example").headers["access-control-allow-origin"]).toBeUndefined();
    expect(call("GET", "/assets/a.js", "https://resulio.co").headers["access-control-allow-origin"]).toBeUndefined();
    vi.stubEnv("FRONTEND_URL", "");
    expect(call("OPTIONS", "/api/trpc/x", "https://resulio.co").nextCalled).toBe(true);
  });

  it("sends page URLs on the API host to the frontend and keeps unknown API paths as 404", () => {
    const handler = frontendRedirect("https://resulio.co");
    const run = (method: string, originalUrl: string) => {
      const out: { status?: number; location?: string } = {};
      const res = {
        redirect: (s: number, l: string) => Object.assign(out, { status: s, location: l }),
        status(s: number) {
          out.status = s;
          return this;
        },
        json: () => undefined,
      } as never;
      handler({ method, originalUrl, path: originalUrl.split("?")[0] } as never, res);
      return out;
    };
    expect(run("GET", "/exam/ABC123?ref=p1")).toEqual({ status: 301, location: "https://resulio.co/exam/ABC123?ref=p1" });
    expect(run("GET", "/api/nope")).toEqual({ status: 404 });
    expect(run("POST", "/teacher")).toEqual({ status: 404 });
  });
});

describe("Google OAuth env", () => {
  it("treats quoted or padded Cloud Console values as configured", () => {
    expect(envString("GOOGLE_CLIENT_ID", { GOOGLE_CLIENT_ID: '  "abc.apps.googleusercontent.com"  ' })).toBe("abc.apps.googleusercontent.com");
    expect(envString("GOOGLE_CLIENT_SECRET", { GOOGLE_CLIENT_SECRET: "   " })).toBe("");
  });

  it("adds www aliases and infers the parent cookie domain", () => {
    expect(withWwwAliases(["https://resulio.co"])).toEqual(["https://resulio.co", "https://www.resulio.co"]);
    expect(cookieDomainFromEnv({ FRONTEND_URL: "https://www.resulio.co" })).toBe(".resulio.co");
    expect(cookieDomainFromEnv({ COOKIE_DOMAIN: "none", FRONTEND_URL: "https://resulio.co" })).toBe("");
  });
});

describe("OAuth state", () => {
  it("round-trips PKCE material without relying on a cookie", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const packed = encodeOAuthState({ nonce: "n1", verifier: "v1", returnTo: "/teacher" });
    expect(decodeOAuthState(packed)).toEqual({ nonce: "n1", verifier: "v1", returnTo: "/teacher" });
    expect(decodeOAuthState(packed.slice(0, -2) + "ab")).toBeNull();
  });
});

describe("Google callback catch-all reasons", () => {
  it("maps schema and JWT failures instead of collapsing everything to server", () => {
    expect(loginCatchReason(new Error("SESSION_SECRET must be set (min 32 chars)"))).toBe("session");
    expect(loginCatchReason(new Error("DATABASE_UNAVAILABLE"))).toBe("db");
    expect(loginCatchReason(Object.assign(new Error("Table 'app.auth_accounts' doesn't exist"), { code: "ER_NO_SUCH_TABLE", errno: 1146 }))).toBe("db");
    expect(loginCatchReason(Object.assign(new Error("Unknown column 'avatarUrl'"), { code: "ER_BAD_FIELD_ERROR", errno: 1054 }))).toBe("db");
    expect(loginCatchReason(Object.assign(new Error("wrapped"), { cause: Object.assign(new Error("jwt expired"), { name: "JWTExpired" }) }))).toBe("jwt");
    expect(loginCatchReason(new TypeError("fetch failed"))).toBe("token");
    expect(loginCatchReason(new Error("sub missing"))).toBe("sub");
    expect(loginCatchReason(new Error("boom"))).toBe("server");
  });
});

describe("API base", () => {
  it("sends the public site to api.resulio.co when VITE_API_URL is empty", async () => {
    const { getApiBase } = await import("../client/src/const");
    expect(getApiBase("resulio.co")).toBe("https://api.resulio.co");
    expect(getApiBase("www.resulio.co")).toBe("https://api.resulio.co");
    expect(getApiBase("localhost")).toBe("");
  });
});

describe("login redirects", () => {
  it("only allows same-origin relative return paths", () => {
    for (const fn of [safeReturnTo, clientSafeReturnTo]) {
      expect(fn("/exam/ABC123")).toBe("/exam/ABC123");
      expect(fn("https://evil.example")).toBe("/app");
      expect(fn("//evil.example")).toBe("/app");
      expect(fn("/\\evil.example")).toBe("/app");
      expect(fn("/api/auth/logout")).toBe("/app");
      expect(fn(undefined as never)).toBe("/app");
    }
  });
});

describe("AI question validation", () => {
  const input = { topic: "Fractions", grade: "5", language: "az", difficulty: "EASY", questionType: "MULTIPLE_CHOICE", count: 2, points: 1 } as const;
  const good = { text: "1/2 + 1/2 = ?", content: { options: [{ key: "A", text: "1" }, { key: "B", text: "2" }] }, answerKey: { correct: "A" } };

  it("keeps only questions that pass the manual-authoring schema", () => {
    const out = validateAiQuestions(
      {
        questions: [
          good,
          { ...good, answerKey: { correct: "Z" } },
          { text: "", content: good.content, answerKey: good.answerKey },
          "garbage",
          { ...good, type: "LONG_ANSWER" },
          good,
        ],
      },
      input,
    );
    expect(out).toHaveLength(2);
    expect(out.every((q) => q.type === "MULTIPLE_CHOICE" && q.points === 1 && q.difficulty === "EASY" && q.topic === "Fractions")).toBe(true);
  });

  it("returns nothing for malformed output", () => {
    expect(validateAiQuestions(null, input)).toEqual([]);
    expect(validateAiQuestions({ questions: "no" }, input)).toEqual([]);
  });
});

describe("canonical host redirect", () => {
  it("sends www and legacy hosts to resulio.co with path and query intact", () => {
    expect(canonicalRedirect("www.resulio.co", "GET", "/")).toEqual({ status: 301, location: "https://resulio.co/" });
    expect(canonicalRedirect("mentorix.io", "GET", "/login")).toEqual({ status: 301, location: "https://resulio.co/login" });
    expect(canonicalRedirect("www.mentorix.io", "GET", "/exams/abc123")?.location).toBe("https://resulio.co/exams/abc123");
    expect(canonicalRedirect("mentorix.io", "GET", "/invite/token-123?ref=partner1&utm_source=x")?.location).toBe(
      "https://resulio.co/invite/token-123?ref=partner1&utm_source=x",
    );
    expect(canonicalRedirect("MENTORIX.IO:443", "HEAD", "/results/result-123")?.location).toBe("https://resulio.co/results/result-123");
  });

  it("keeps the method for writes", () => {
    expect(canonicalRedirect("www.resulio.co", "POST", "/api/trpc/x")?.status).toBe(308);
  });

  it("leaves the canonical, staging and unknown hosts alone", () => {
    for (const host of ["resulio.co", "api.resulio.co", "backend-staging-c31a.up.railway.app", "evil-mentorix.io", undefined]) {
      expect(canonicalRedirect(host, "GET", "/")).toBeNull();
    }
  });

  it("never lets the request line change the target host", () => {
    expect(canonicalRedirect("mentorix.io", "GET", "//evil.example/x")?.location).toBe("https://resulio.co//evil.example/x");
    expect(new URL(canonicalRedirect("mentorix.io", "GET", "//evil.example/x")!.location).host).toBe("resulio.co");
    expect(canonicalRedirect("mentorix.io", "GET", "http://evil.example/")?.location).toBe("https://resulio.co/");
  });
});

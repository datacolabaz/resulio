import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOKIE_NAME } from "../shared/const";
import type { User } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import { resetRateLimits } from "./_core/rateLimit";
import * as access from "./modules/access";
import { AppError } from "./modules/errors";
import * as passwordAuth from "./modules/passwordAuth";
import { attributeReferral } from "./modules/referrals";
import { appRouter } from "./routers";

vi.mock("./modules/passwordAuth", () => ({ loginWithPassword: vi.fn(), registerWithPassword: vi.fn(), setOwnPassword: vi.fn() }));
vi.mock("./modules/referrals", () => ({ attributeReferral: vi.fn() }));
vi.mock("./modules/access", async (importOriginal) => ({ ...(await importOriginal<typeof import("./modules/access")>()), resolveAccess: vi.fn() }));

const mocked = vi.mocked(passwordAuth);

function user(overrides: Partial<User> = {}): User {
  return {
    id: 5,
    openId: "usr_abc",
    name: "Aysel",
    email: "aysel@example.az",
    avatarUrl: null,
    loginMethod: "password",
    preferredLocale: "az",
    lastActiveContext: null,
    accountStatus: "ACTIVE",
    sessionsValidAfter: null,
    passwordHash: "scrypt$32768$8$3$c2FsdA==$aGFzaA==",
    ...overrides,
  } as User;
}

function caller(u: User | null, ip = "10.0.0.1") {
  const res = { cookie: vi.fn(), clearCookie: vi.fn() };
  const ctx: TrpcContext = {
    user: u,
    session: null,
    req: { ip, protocol: "https", headers: {} } as TrpcContext["req"],
    res: res as unknown as TrpcContext["res"],
  };
  return { api: appRouter.createCaller(ctx), res };
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
  vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-0123456789abcdef");
  vi.mocked(access.resolveAccess).mockResolvedValue({
    contexts: { learning: false, teaching: false, partner: false },
    activeMemberships: 0,
    pendingMemberships: 0,
    workspaces: [],
    partnerStatus: null,
    platformRoles: [],
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("auth.passwordLogin", () => {
  it("starts the same session cookie as Google sign-in and passes sanitized attribution through", async () => {
    mocked.loginWithPassword.mockResolvedValue({ user: user(), isNew: false });
    const { api, res } = caller(null);
    expect(await api.auth.passwordLogin({ email: "aysel@example.az", password: "secret-pass", ref: "partner1", src: "telegram", campaign: "task_share" })).toEqual({
      ok: true,
    });
    expect(res.cookie).toHaveBeenCalledWith(COOKIE_NAME, expect.any(String), expect.objectContaining({ httpOnly: true, sameSite: "lax", secure: true, path: "/" }));
    expect(attributeReferral).toHaveBeenCalledWith(5, false, "PARTNER1", "TELEGRAM", "task_share");
  });

  it("drops unknown attribution values instead of failing the sign-in", async () => {
    mocked.loginWithPassword.mockResolvedValue({ user: user(), isNew: false });
    const { api } = caller(null);
    await api.auth.passwordLogin({ email: "aysel@example.az", password: "secret-pass", ref: "<script>", src: "evil", campaign: "nope" });
    expect(attributeReferral).toHaveBeenCalledWith(5, false, undefined, "DIRECT", undefined);
  });

  it("returns the generic INVALID_CREDENTIALS error and sets no cookie", async () => {
    mocked.loginWithPassword.mockRejectedValue(new AppError("INVALID_CREDENTIALS"));
    const { api, res } = caller(null);
    expect(await codeOf(api.auth.passwordLogin({ email: "aysel@example.az", password: "wrong" }))).toBe("BAD_REQUEST:INVALID_CREDENTIALS");
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("limits attempts per email across IP addresses and email spellings", async () => {
    mocked.loginWithPassword.mockRejectedValue(new AppError("INVALID_CREDENTIALS"));
    for (let i = 0; i < 10; i++) {
      const email = i % 2 ? "Aysel@Example.az" : " aysel@example.az ";
      expect(await codeOf(caller(null, `10.0.1.${i}`).api.auth.passwordLogin({ email, password: "guess" }))).toBe("BAD_REQUEST:INVALID_CREDENTIALS");
    }
    expect(await codeOf(caller(null, "10.0.2.1").api.auth.passwordLogin({ email: "aysel@example.az", password: "guess" }))).toBe("TOO_MANY_REQUESTS:RATE_LIMITED");
    expect(mocked.loginWithPassword).toHaveBeenCalledTimes(10);
    mocked.loginWithPassword.mockResolvedValue({ user: user({ email: "other@example.az" }), isNew: false });
    expect(await codeOf(caller(null, "10.0.2.1").api.auth.passwordLogin({ email: "other@example.az", password: "guess" }))).toBe("OK");
  });
});

describe("auth.passwordRegister", () => {
  it("attributes a brand-new signup and signs it in", async () => {
    mocked.registerWithPassword.mockResolvedValue({ user: user(), isNew: true });
    const { api, res } = caller(null);
    await api.auth.passwordRegister({ name: "Aysel", email: "aysel@example.az", password: "long-enough", ref: "ABCD1234", src: "wa" });
    expect(attributeReferral).toHaveBeenCalledWith(5, true, "ABCD1234", expect.any(String), undefined);
    expect(res.cookie).toHaveBeenCalledWith(COOKIE_NAME, expect.any(String), expect.anything());
  });

  it("rejects passwords shorter than 8 characters before touching the database", async () => {
    const { api } = caller(null);
    expect(await codeOf(api.auth.passwordRegister({ name: "Aysel", email: "aysel@example.az", password: "short" }))).toMatch(/^BAD_REQUEST:/);
    expect(mocked.registerWithPassword).not.toHaveBeenCalled();
  });

  it("passes the generic refusal through for an email that already has an account", async () => {
    mocked.registerWithPassword.mockRejectedValue(new AppError("REGISTRATION_UNAVAILABLE"));
    const { api, res } = caller(null);
    expect(await codeOf(api.auth.passwordRegister({ name: "Xəyal", email: "google.user@gmail.com", password: "long-enough" }))).toBe(
      "CONFLICT:REGISTRATION_UNAVAILABLE",
    );
    expect(res.cookie).not.toHaveBeenCalled();
  });
});

describe("auth.setPassword", () => {
  it("requires a signed-in user", async () => {
    expect(await codeOf(caller(null).api.auth.setPassword({ newPassword: "long-enough" }))).toMatch(/^UNAUTHORIZED/);
  });

  it("re-issues the current session cookie only when other sessions were ended", async () => {
    mocked.setOwnPassword.mockResolvedValue({ revokedOtherSessions: false });
    const first = caller(user({ passwordHash: null }));
    await first.api.auth.setPassword({ newPassword: "long-enough" });
    expect(first.res.cookie).not.toHaveBeenCalled();

    mocked.setOwnPassword.mockResolvedValue({ revokedOtherSessions: true });
    const change = caller(user());
    await change.api.auth.setPassword({ currentPassword: "old-password", newPassword: "long-enough" });
    expect(change.res.cookie).toHaveBeenCalledWith(COOKIE_NAME, expect.any(String), expect.anything());
  });
});

describe("auth.me", () => {
  it("says whether a password is set but never exposes the hash", async () => {
    const me = await caller(user()).api.auth.me();
    expect(me).toMatchObject({ id: 5, hasPassword: true });
    expect(JSON.stringify(me)).not.toContain("scrypt");
    expect(await caller(user({ passwordHash: null })).api.auth.me()).toMatchObject({ hasPassword: false });
  });
});

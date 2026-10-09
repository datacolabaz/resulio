import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIGH_RISK_PERMISSIONS, permissionsOf } from "../shared/adminPermissions";
import { effectiveLimit, nextPeriodStart, periodStart } from "../shared/aiUsage";
import type { TrpcContext } from "./_core/context";
import { resetRateLimits } from "./_core/rateLimit";
import { checkLimits, countingFrom, quotaView, resolveLimits } from "./aiUsage/limits";
import { AppError } from "./modules/errors";

const mocks = vi.hoisted(() => ({
  results: [] as unknown[][],
  dbError: null as Error | null,
  settings: {} as Record<string, number | null>,
  roles: new Map<number, string[]>(),
}));

/** Each awaited query resolves to the next queued result. */
vi.mock("./db", () => {
  const chain = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
              mocks.dbError ? reject(mocks.dbError) : resolve(mocks.results.shift() ?? []);
          }
          return () => chain();
        },
      },
    );
  return { requireDb: () => ({ select: () => chain() }), getDb: async () => null };
});
vi.mock("./platformSettings", () => ({
  getPlatformSettings: async () => ({
    "ai.monthlyBudgetUsd": null,
    "ai.defaultMonthlyTokenQuota": null,
    "ai.defaultDailyRequestCap": null,
    "storage.softQuotaBytes": null,
    ...mocks.settings,
  }),
  clearSettingsCache: () => undefined,
}));
vi.mock("./modules/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/access")>()),
  platformRolesOf: async (userId: number) => mocks.roles.get(userId) ?? [],
}));
vi.mock("./aiUsage/admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./aiUsage/admin")>()),
  teacherLimits: vi.fn(async () => ({ defaults: { monthlyTokenQuota: null, dailyRequestCap: null }, teachers: [] })),
  setTeacherLimit: vi.fn(async () => ({ ok: true })),
  resetTeacherUsage: vi.fn(async () => ({ ok: true })),
  upsertPrice: vi.fn(async () => ({ ok: true })),
  updateSettings: vi.fn(async () => ({})),
}));
vi.mock("./fileStorage/summary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fileStorage/summary")>()),
  storageSummary: vi.fn(async () => ({ totalBytes: 0 })),
}));

const { aiLimitCheck, assertAiAllowed } = await import("./aiUsage/limits");
const { appRouter } = await import("./routers");

// 2026-03-15 10:00 in Baku (UTC+4)
const NOW = new Date("2026-03-15T06:00:00Z");

describe("Baku-time periods", () => {
  it("start the day and the month at Baku midnight", () => {
    expect(periodStart("day", NOW).toISOString()).toBe("2026-03-14T20:00:00.000Z");
    expect(periodStart("month", NOW).toISOString()).toBe("2026-02-28T20:00:00.000Z");
    expect(nextPeriodStart("day", NOW).toISOString()).toBe("2026-03-15T20:00:00.000Z");
    expect(nextPeriodStart("month", NOW).toISOString()).toBe("2026-03-31T20:00:00.000Z");
  });

  it("treat 23:30 UTC on the last day of a month as the next month in Baku", () => {
    const late = new Date("2026-03-31T21:30:00Z");
    expect(periodStart("month", late).toISOString()).toBe("2026-03-31T20:00:00.000Z");
    expect(nextPeriodStart("month", new Date("2026-12-31T20:00:00Z")).toISOString()).toBe("2027-01-31T20:00:00.000Z");
  });
});

describe("limit precedence", () => {
  it("treats a null or 0 global default as unlimited", () => {
    expect(effectiveLimit(null, null)).toBeNull();
    expect(effectiveLimit(0, null)).toBeNull();
    expect(effectiveLimit(5000, null)).toBe(5000);
  });

  it("lets a teacher override win, with 0 meaning unlimited for that teacher", () => {
    expect(effectiveLimit(5000, 200)).toBe(200);
    expect(effectiveLimit(5000, 0)).toBeNull();
    expect(effectiveLimit(null, 300)).toBe(300);
  });

  it("resolves each limit independently", () => {
    expect(resolveLimits({ monthlyTokenQuota: 1000, dailyRequestCap: 10 }, { monthlyTokenQuota: null, dailyRequestCap: 0, usageResetAt: null })).toEqual({ monthlyTokenQuota: 1000, dailyRequestCap: null });
    expect(resolveLimits({ monthlyTokenQuota: 1000, dailyRequestCap: 10 }, null)).toEqual({ monthlyTokenQuota: 1000, dailyRequestCap: 10 });
  });
});

describe("limit checks", () => {
  const limits = { monthlyTokenQuota: 1000, dailyRequestCap: 3 };

  it("blocks at the monthly quota, resetting on the 1st", () => {
    expect(checkLimits({ monthTokens: 999, dayOperations: 0 }, limits, NOW)).toEqual({ ok: true });
    expect(checkLimits({ monthTokens: 1000, dayOperations: 0 }, limits, NOW)).toEqual({ ok: false, reason: "MONTHLY", resetsAt: nextPeriodStart("month", NOW) });
  });

  it("blocks at the daily cap, resetting at Baku midnight", () => {
    expect(checkLimits({ monthTokens: 0, dayOperations: 2 }, limits, NOW).ok).toBe(true);
    expect(checkLimits({ monthTokens: 0, dayOperations: 3 }, limits, NOW)).toEqual({ ok: false, reason: "DAILY", resetsAt: nextPeriodStart("day", NOW) });
  });

  it("never blocks without limits", () => {
    expect(checkLimits({ monthTokens: 1e12, dayOperations: 1e6 }, { monthlyTokenQuota: null, dailyRequestCap: null }, NOW).ok).toBe(true);
  });

  it("counts from an admin reset when it is inside the current period", () => {
    const reset = new Date("2026-03-15T05:00:00Z");
    expect(countingFrom(NOW, reset)).toEqual({ month: reset, day: reset });
    const old = new Date("2026-02-10T00:00:00Z");
    expect(countingFrom(NOW, old)).toEqual({ month: periodStart("month", NOW), day: periodStart("day", NOW) });
    expect(countingFrom(NOW, null)).toEqual({ month: periodStart("month", NOW), day: periodStart("day", NOW) });
  });

  it("warns from 80% and reports what blocks", () => {
    const view = quotaView({ monthTokens: 850, dayOperations: 1 }, limits, NOW);
    expect(view).toMatchObject({ limited: true, warn: true, blocked: null });
    expect(view.monthly).toMatchObject({ used: 850, limit: 1000 });
    expect(quotaView({ monthTokens: 10, dayOperations: 3 }, limits, NOW).blocked).toBe("DAILY");
    expect(quotaView({ monthTokens: 10, dayOperations: 0 }, { monthlyTokenQuota: null, dailyRequestCap: null }, NOW)).toMatchObject({ limited: false, warn: false });
  });
});

describe("server-side enforcement", () => {
  beforeEach(() => {
    mocks.results = [];
    mocks.dbError = null;
    mocks.settings = {};
  });

  const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof AppError ? e.code : String(e)));

  it("refuses with the monthly error once the default quota is used", async () => {
    mocks.settings = { "ai.defaultMonthlyTokenQuota": 1000 };
    mocks.results = [[], [{ tokens: 1000 }], [{ ops: 0 }]];
    expect(await codeOf(assertAiAllowed(7, NOW))).toBe("AI_TEACHER_MONTHLY_LIMIT");
  });

  it("refuses with the daily error once the cap is reached", async () => {
    mocks.settings = { "ai.defaultDailyRequestCap": 2 };
    mocks.results = [[], [{ tokens: 10 }], [{ ops: 2 }]];
    expect(await codeOf(assertAiAllowed(7, NOW))).toBe("AI_TEACHER_DAILY_LIMIT");
  });

  it("lets a teacher's own higher quota override the default", async () => {
    mocks.settings = { "ai.defaultMonthlyTokenQuota": 1000 };
    mocks.results = [[{ userId: 7, monthlyTokenQuota: 5000, dailyRequestCap: null, usageResetAt: null }], [{ tokens: 1000 }], [{ ops: 0 }]];
    expect(await codeOf(assertAiAllowed(7, NOW))).toBe("ok");
  });

  it("skips the usage queries for an unlimited teacher", async () => {
    mocks.settings = { "ai.defaultMonthlyTokenQuota": 1000 };
    mocks.results = [[{ userId: 7, monthlyTokenQuota: 0, dailyRequestCap: null, usageResetAt: null }], [{ tokens: 99_999 }]];
    expect(await codeOf(assertAiAllowed(7, NOW))).toBe("ok");
    expect(mocks.results).toHaveLength(1);
  });

  it("fails open when the limit tables cannot be read", async () => {
    mocks.settings = { "ai.defaultMonthlyTokenQuota": 1 };
    mocks.dbError = new Error("table missing");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await aiLimitCheck(7, NOW)).toEqual({ ok: true });
    warn.mockRestore();
  });
});

describe("admin permissions for AI and storage", () => {
  it("gives support read access only, and no new permission needs re-auth", () => {
    const support = permissionsOf(["SUPPORT_ADMIN"]);
    expect(support).toEqual(expect.arrayContaining(["ai.view", "storage.view"]));
    expect(support).not.toContain("ai.manage");
    expect(support).not.toContain("storage.manage");
    expect(permissionsOf(["SUPER_ADMIN"])).toEqual(expect.arrayContaining(["ai.view", "ai.manage", "storage.view", "storage.manage"]));
    for (const p of ["ai.view", "ai.manage", "storage.view", "storage.manage"] as const) expect(HIGH_RISK_PERMISSIONS).not.toContain(p);
  });

  const caller = (id: number, email: string) =>
    appRouter.createCaller({
      user: { id, email, role: "user", openId: `u${id}`, accountStatus: "ACTIVE" } as TrpcContext["user"],
      session: null,
      req: { ip: "10.0.0.9", protocol: "https", headers: {} } as TrpcContext["req"],
      res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    } as TrpcContext);
  const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; message?: string }) => `${e.code}:${e.message}`);

  beforeEach(() => {
    resetRateLimits();
    vi.stubEnv("SUPER_ADMIN_EMAILS", "boss@example.com");
    mocks.roles = new Map([
      [1, ["SUPER_ADMIN"]],
      [2, ["SUPPORT_ADMIN"]],
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("let support read AI usage and storage but not change limits, prices or quotas", async () => {
    const support = caller(2, "help@example.com");
    expect(await codeOf(support.admin.ai.teachers())).toBe("ok");
    expect(await codeOf(support.admin.storage.summary())).toBe("ok");
    expect(await codeOf(support.admin.ai.setTeacherLimit({ userId: 9, monthlyTokenQuota: 100, dailyRequestCap: null }))).toBe("FORBIDDEN:ADMIN_PERMISSION");
    expect(await codeOf(support.admin.ai.resetTeacherUsage({ userId: 9 }))).toBe("FORBIDDEN:ADMIN_PERMISSION");
    expect(await codeOf(support.admin.ai.setPrice({ model: "m", inputUsdPerMillion: 1, outputUsdPerMillion: 1 }))).toBe("FORBIDDEN:ADMIN_PERMISSION");
    expect(await codeOf(support.admin.ai.setSettings({ monthlyBudgetUsd: 10 }))).toBe("FORBIDDEN:ADMIN_PERMISSION");
    expect(await codeOf(support.admin.storage.setSoftQuota({ softQuotaBytes: 1 }))).toBe("FORBIDDEN:ADMIN_PERMISSION");
  });

  it("let a super admin change them", async () => {
    const boss = caller(1, "boss@example.com");
    expect(await codeOf(boss.admin.ai.setTeacherLimit({ userId: 9, monthlyTokenQuota: 100, dailyRequestCap: null }))).toBe("ok");
    expect(await codeOf(boss.admin.ai.setSettings({ monthlyBudgetUsd: 10 }))).toBe("ok");
  });

  it("refuse non-admins", async () => {
    expect(await codeOf(caller(3, "teacher@example.com").admin.ai.teachers())).toBe("FORBIDDEN:NOT_ADMIN");
  });
});

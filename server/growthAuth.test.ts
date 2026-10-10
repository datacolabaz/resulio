import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import { resetRateLimits } from "./_core/rateLimit";
import * as accessMod from "./modules/access";
import { AppError } from "./modules/errors";
import * as actions from "./growth/actions";
import * as availability from "./growth/availability";
import { reminderDue } from "./growth/jobs";
import * as planStore from "./growth/planStore";
import { groupReminders } from "./growth/planStore";
import * as practice from "./growth/practice";
import { renderNotification } from "./notifications/render";
import { appRouter } from "./routers";

vi.mock("./modules/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/access")>()),
  resolveWorkspace: vi.fn(),
  workspaceExists: vi.fn(async () => false),
  platformRolesOf: vi.fn(async () => []),
}));
vi.mock("./growth/availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./growth/availability")>()),
  growthEnabledFor: vi.fn(),
  assertGrowthEnabled: vi.fn(),
  studentGrowthGroups: vi.fn(),
}));
vi.mock("./growth/planStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./growth/planStore")>()),
  getPlan: vi.fn(),
  createPlan: vi.fn(),
  completeItem: vi.fn(),
  completePlan: vi.fn(),
  saveStudentSettings: vi.fn(),
  linkPracticeToItem: vi.fn(),
}));
vi.mock("./growth/practice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./growth/practice")>()),
  startPractice: vi.fn(),
  groupPracticeSettings: vi.fn(),
  setGroupPractice: vi.fn(),
}));
vi.mock("./growth/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./growth/actions")>()),
  riskList: vi.fn(),
  createRetake: vi.fn(),
}));

const m = {
  access: vi.mocked(accessMod),
  availability: vi.mocked(availability),
  plan: vi.mocked(planStore),
  practice: vi.mocked(practice),
  actions: vi.mocked(actions),
};

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof TRPCError) return e.code === "UNAUTHORIZED" || e.code === "BAD_REQUEST" ? e.code : `${e.code}:${e.message}`;
    if (e instanceof AppError) return e.code;
    return `THROWN:${(e as Error).message}`;
  }
}

function user(id: number): User {
  return { id, openId: `google:${id}`, name: "U", email: `u${id}@example.com`, accountStatus: "ACTIVE", sessionsValidAfter: null } as unknown as User;
}

function caller(u: User | null, headers: Record<string, string> = {}) {
  const ctx: TrpcContext = {
    user: u,
    session: null,
    req: { ip: "10.0.0.9", protocol: "https", headers } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}

const TEACHER = 7;
const STUDENT = 42;

beforeEach(() => {
  resetRateLimits();
  m.access.resolveWorkspace.mockResolvedValue({ id: "ws_t", ownerUserId: TEACHER } as never);
  m.availability.growthEnabledFor.mockResolvedValue(true);
  m.availability.assertGrowthEnabled.mockResolvedValue(undefined);
  m.availability.studentGrowthGroups.mockResolvedValue([{ groupId: "grp1", name: "A", workspaceId: "ws_t" }]);
  m.plan.getPlan.mockResolvedValue({} as never);
  m.plan.completeItem.mockResolvedValue({} as never);
  m.plan.linkPracticeToItem.mockResolvedValue(undefined as never);
  m.practice.startPractice.mockResolvedValue({ assessmentId: "as1", questionCount: 10 } as never);
  m.actions.riskList.mockResolvedValue([] as never);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("growth authorization", () => {
  it("needs a signed-in user everywhere except the parent report", async () => {
    expect(await codeOf(caller(null).student.growth.plan({ groupId: "grp1" }))).toBe("UNAUTHORIZED");
    expect(await codeOf(caller(null).teacher.growth.riskList({ groupId: null }))).toBe("UNAUTHORIZED");
    expect(await codeOf(caller(null).public.growthReport({ token: "short" }))).toBe("BAD_REQUEST");
  });

  it("teacher procedures need an owned workspace; a foreign workspace header gives nothing", async () => {
    m.access.resolveWorkspace.mockResolvedValue(null);
    const c = caller(user(99), { "x-workspace-id": "ws_t" });
    expect(await codeOf(c.teacher.growth.riskList({ groupId: null }))).toBe("FORBIDDEN:NO_WORKSPACE");
    expect(await codeOf(c.teacher.growth.groupPractice())).toBe("FORBIDDEN:NO_WORKSPACE");
    expect(await codeOf(c.teacher.growth.createRetake({ studentId: STUDENT, topicKeys: ["qt:a"], count: 5 }))).toBe("FORBIDDEN:NO_WORKSPACE");
    expect(m.actions.riskList).not.toHaveBeenCalled();
    expect(m.actions.createRetake).not.toHaveBeenCalled();
  });

  it("teacher procedures stay closed while the growth_engine flag is off", async () => {
    m.availability.assertGrowthEnabled.mockRejectedValue(new AppError("GROWTH_NOT_AVAILABLE"));
    const c = caller(user(TEACHER));
    for (const call of [
      c.teacher.growth.topicHealth(),
      c.teacher.growth.riskList({ groupId: null }),
      c.teacher.growth.settings(),
      c.teacher.growth.groupPractice(),
      c.teacher.growth.setGroupPractice({ groupId: "grp1", enabled: true }),
      c.teacher.growth.createRetake({ studentId: STUDENT, topicKeys: ["qt:a"], count: 5 }),
      c.teacher.growth.createReport({ studentId: STUDENT, email: null, locale: "az" }),
    ]) {
      expect(await codeOf(call)).toBe("FORBIDDEN:GROWTH_NOT_AVAILABLE");
    }
    expect(m.availability.assertGrowthEnabled).toHaveBeenCalledWith("ws_t");
    expect(m.practice.setGroupPractice).not.toHaveBeenCalled();
    expect(await caller(user(TEACHER)).teacher.growth.enabled()).toEqual({ enabled: true });
  });

  it("teacher services get the resolved workspace scope", async () => {
    await caller(user(TEACHER)).teacher.growth.riskList({ groupId: "grp1" });
    expect(m.actions.riskList).toHaveBeenCalledWith({ workspaceId: "ws_t", userId: TEACHER }, "grp1");
  });

  it("student procedures act on the caller only; extra ids in the input are ignored", async () => {
    const c = caller(user(STUDENT));
    await c.student.growth.plan({ groupId: "grp1", studentId: 99 } as never);
    expect(m.plan.getPlan).toHaveBeenCalledWith(STUDENT, "grp1");
    await c.student.growth.completeItem({ itemId: "it1" });
    expect(m.plan.completeItem).toHaveBeenCalledWith(STUDENT, "it1");
    await c.student.growth.startPractice({ groupId: "grp1", topicKey: "qt:a", itemId: "it1" });
    expect(m.practice.startPractice).toHaveBeenCalledWith(STUDENT, { groupId: "grp1", topicKey: "qt:a", itemId: "it1" });
    expect(m.plan.linkPracticeToItem).toHaveBeenCalledWith(STUDENT, "it1", "as1");
  });

  it("validates bounds before any service runs", async () => {
    const t = caller(user(TEACHER));
    expect(await codeOf(t.teacher.growth.createRetake({ studentId: STUDENT, topicKeys: ["qt:a"], count: 500 }))).toBe("BAD_REQUEST");
    expect(await codeOf(t.teacher.growth.createRetake({ studentId: STUDENT, topicKeys: [], count: 5 }))).toBe("BAD_REQUEST");
    const s = caller(user(STUDENT));
    expect(await codeOf(s.student.growth.createPlan({ groupId: "grp1", dailyMinutes: 500 }))).toBe("BAD_REQUEST");
    expect(m.actions.createRetake).not.toHaveBeenCalled();
    expect(m.plan.createPlan).not.toHaveBeenCalled();
  });

  it("rate-limits self practice", async () => {
    const s = caller(user(STUDENT));
    for (let i = 0; i < 5; i++) await s.student.growth.startPractice({ groupId: "grp1", topicKey: "qt:a", itemId: null });
    expect(await codeOf(s.student.growth.startPractice({ groupId: "grp1", topicKey: "qt:a", itemId: null }))).toBe("TOO_MANY_REQUESTS:RATE_LIMITED");
  });

  it("answers GROWTH_DB_NOT_READY instead of a 500 while the migration is pending", async () => {
    m.plan.getPlan.mockRejectedValue(Object.assign(new Error("Table 'review_plans' doesn't exist"), { errno: 1146, code: "ER_NO_SUCH_TABLE" }));
    expect(await codeOf(caller(user(STUDENT)).student.growth.plan({ groupId: "grp1" }))).toBe("PRECONDITION_FAILED:GROWTH_DB_NOT_READY");
  });
});

describe("plan reminder", () => {
  it("goes out in the afternoon only, once a day", () => {
    const at = (utcHour: number) => new Date(Date.UTC(2026, 9, 10, utcHour, 5));
    expect(reminderDue(at(11), null)).toBe(false);
    expect(reminderDue(at(12), null)).toBe(true);
    expect(reminderDue(at(12), "2026-10-10")).toBe(false);
    expect(reminderDue(at(17), null)).toBe(false);
  });

  it("sums today's unfinished steps per plan and leaves out opted-out students", () => {
    const rows = [
      { studentId: 1, planId: "p1", minutes: 20 },
      { studentId: 1, planId: "p1", minutes: 15 },
      { studentId: 2, planId: "p2", minutes: 10 },
    ];
    expect(groupReminders(rows, new Set([2]))).toEqual([{ studentId: 1, planId: "p1", items: 2, minutes: 35 }]);
  });

  it("renders in every language and links to the growth page", () => {
    for (const locale of ["az", "en", "ru"] as const) {
      const r = renderNotification("PLAN_REMINDER", { planId: "p1", items: 2, minutes: 35 }, { locale, email: "s@example.com" }, "https://app.test");
      expect(r.path).toBe("/student/growth");
      expect(r.body).toContain("35");
      expect(r.email).toBeNull();
    }
  });
});

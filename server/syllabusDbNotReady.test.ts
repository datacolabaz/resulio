import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import { resetRateLimits } from "./_core/rateLimit";
import * as accessMod from "./modules/access";
import { appRouter } from "./routers";
import { guardTables, isSchemaBehind } from "./syllabus/availability";

/** A database where every syllabus query fails the way MySQL does before migrations 0026+ ran. */
const missingTable = () => Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("Table 'x.syllabi' doesn't exist"), { errno: 1146, code: "ER_NO_SUCH_TABLE" }) });
function brokenDb(): unknown {
  const handler: ProxyHandler<() => void> = {
    get: (_t, prop) => {
      if (prop === "then") return (_ok: unknown, fail: (e: unknown) => void) => fail(missingTable());
      if (prop === "transaction") return async (fn: (tx: unknown) => unknown) => fn(proxy);
      return () => proxy;
    },
    apply: () => proxy,
  };
  const proxy: unknown = new Proxy(() => {}, handler);
  return proxy;
}

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: () => brokenDb(),
  requireDb: () => brokenDb(),
}));
vi.mock("./modules/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/access")>()),
  resolveWorkspace: vi.fn(),
}));
vi.mock("./modules/groups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/groups")>()),
  activeGroupIdsOfStudent: vi.fn(async () => []),
}));
vi.mock("./syllabus/availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./syllabus/availability")>()),
  assertSyllabusEnabled: vi.fn(async () => undefined),
}));

function caller(id: number) {
  const user = { id, openId: `google:${id}`, name: "U", email: `u${id}@example.com`, accountStatus: "ACTIVE", sessionsValidAfter: null } as unknown as User;
  const ctx: TrpcContext = {
    user,
    session: null,
    req: { ip: "10.0.0.9", protocol: "https", headers: {} } as TrpcContext["req"],
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

const NOT_READY = "PRECONDITION_FAILED:SYLLABUS_DB_NOT_READY";

beforeEach(() => {
  resetRateLimits();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(accessMod.resolveWorkspace).mockResolvedValue({ id: "ws1", ownerUserId: 7 } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("syllabus before the migration ran", () => {
  it("recognizes missing tables and columns anywhere in the cause chain", () => {
    expect(isSchemaBehind(missingTable())).toBe(true);
    expect(isSchemaBehind({ errno: 1054 })).toBe(true);
    expect(isSchemaBehind(new Error("x", { cause: { code: "ER_BAD_FIELD_ERROR" } }))).toBe(true);
    expect(isSchemaBehind(new Error("Incorrect datetime value"))).toBe(false);
  });

  it("guardTables turns it into SYLLABUS_DB_NOT_READY and leaves other errors alone", async () => {
    await expect(guardTables(async () => Promise.reject(missingTable()))).rejects.toMatchObject({ code: "SYLLABUS_DB_NOT_READY" });
    await expect(guardTables(async () => Promise.reject(new Error("other")))).rejects.toThrow("other");
  });

  it("every teacher endpoint answers SYLLABUS_DB_NOT_READY, including the list and the sample", async () => {
    const t = caller(7).teacher.syllabus;
    expect(await codeOf(t.list())).toBe(NOT_READY);
    expect(await codeOf(t.createSample({ locale: "az" }))).toBe(NOT_READY);
    expect(await codeOf(t.create({ title: "Java" }))).toBe(NOT_READY);
    expect(await codeOf(t.get({ id: "syl1" }))).toBe(NOT_READY);
    expect(await codeOf(t.grants({ id: "syl1" }))).toBe(NOT_READY);
    expect(await codeOf(t.students({ id: "syl1" }))).toBe(NOT_READY);
    expect(await codeOf(t.approvals({ id: "syl1" }))).toBe(NOT_READY);
    expect(await codeOf(t.versions({ id: "syl1" }))).toBe(NOT_READY);
    expect(await codeOf(t.setProgressVisibleToGroup({ groupId: "g1", visible: true }))).toBe(NOT_READY);
  });

  it("every student endpoint answers SYLLABUS_DB_NOT_READY, and the nav flag just says no", async () => {
    const s = caller(21).student.syllabus;
    expect(await s.enabled()).toEqual({ enabled: false });
    expect(await codeOf(s.list())).toBe(NOT_READY);
    expect(await codeOf(s.path({ id: "syl1" }))).toBe(NOT_READY);
    expect(await codeOf(s.lesson({ id: "syl1", lessonId: "l1" }))).toBe(NOT_READY);
    expect(await codeOf(s.overview({ id: "syl1" }))).toBe(NOT_READY);
  });
});

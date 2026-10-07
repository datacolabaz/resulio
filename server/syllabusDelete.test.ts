import { getTableName, type Table } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import { resetRateLimits } from "./_core/rateLimit";
import * as accessMod from "./modules/access";
import { AppError } from "./modules/errors";
import { appRouter } from "./routers";
import * as access from "./syllabus/access";
import { deleteBlocker, deleteSyllabus } from "./syllabus/authoring";
import * as availability from "./syllabus/availability";
import * as practiceTasks from "./syllabus/practiceTasks";
import * as db from "./db";

vi.mock("./db", async (importOriginal) => ({ ...(await importOriginal<typeof import("./db")>()), requireDb: vi.fn() }));
vi.mock("./syllabus/access", async (importOriginal) => ({ ...(await importOriginal<typeof import("./syllabus/access")>()), ownedSyllabus: vi.fn() }));
vi.mock("./syllabus/practiceTasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./syllabus/practiceTasks")>()),
  deleteContainers: vi.fn(),
}));
vi.mock("./syllabus/availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./syllabus/availability")>()),
  assertSyllabusEnabled: vi.fn(),
}));
vi.mock("./modules/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/access")>()),
  resolveWorkspace: vi.fn(),
  platformRolesOf: vi.fn(async () => []),
}));

const m = {
  db: vi.mocked(db),
  access: vi.mocked(access),
  practice: vi.mocked(practiceTasks),
  availability: vi.mocked(availability),
  workspace: vi.mocked(accessMod),
};

const SCOPE = { workspaceId: "ws_teacher", userId: 7 };

/** A transaction whose selects return the queued results and whose deletes are recorded by table. */
function fakeTx(selects: unknown[]) {
  const deleted: string[] = [];
  const chain = (value: () => unknown): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (resolve: (v: unknown) => void) => resolve(value());
          return () => chain(value);
        },
      },
    );
  const tx = {
    select: () => chain(() => selects.shift() ?? []),
    delete: (table: Table) => (deleted.push(getTableName(table)), chain(() => undefined)),
  };
  const transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  m.db.requireDb.mockReturnValue({ transaction } as never);
  return { deleted, transaction };
}

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof AppError ? e.code : `${(e as { code?: string }).code}:${(e as Error).message}`;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  m.access.ownedSyllabus.mockResolvedValue({ id: "syl1", providerWorkspaceId: "ws_teacher" } as never);
  m.practice.deleteContainers.mockResolvedValue(undefined as never);
  m.availability.assertSyllabusEnabled.mockResolvedValue(undefined);
});

describe("deleteBlocker", () => {
  it("only enrolled students block a delete", () => {
    expect(deleteBlocker({ enrollments: 0 })).toBeNull();
    expect(deleteBlocker({ enrollments: 1 })).toBe("SYLLABUS_HAS_STUDENTS");
  });
});

describe("deleteSyllabus", () => {
  it("purges every child table and the syllabus itself in one transaction", async () => {
    const { deleted, transaction } = fakeTx([[{ id: "syl1" }], [{ n: 0 }], [{ id: "v1" }, { id: "v2" }]]);
    await expect(deleteSyllabus(SCOPE, "syl1")).resolves.toEqual({ ok: true, id: "syl1" });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(m.practice.deleteContainers).toHaveBeenCalledWith(expect.anything(), "ws_teacher", "syl1");
    expect(deleted).toEqual(
      expect.arrayContaining([
        "syllabus_version_items",
        "syllabus_versions",
        "syllabus_items",
        "syllabus_lessons",
        "syllabus_modules",
        "syllabus_access_grants",
        "syllabus_item_progress",
        "syllabus_lesson_progress",
        "syllabus_module_progress",
        "syllabus_manual_unlocks",
        "syllabus_completions",
        "syllabus_assessment_assignments",
        "syllabus_analytics_settings",
        "syllabus_notice_batches",
        "learning_activity",
      ]),
    );
    expect(deleted.at(-1)).toBe("syllabi");
  });

  it("refuses when students are enrolled and deletes nothing", async () => {
    const { deleted } = fakeTx([[{ id: "syl1" }], [{ n: "3" }]]);
    expect(await codeOf(deleteSyllabus(SCOPE, "syl1"))).toBe("SYLLABUS_HAS_STUDENTS");
    expect(deleted).toEqual([]);
    expect(m.practice.deleteContainers).not.toHaveBeenCalled();
  });

  it("never touches a syllabus outside the teacher's workspace", async () => {
    const { transaction } = fakeTx([]);
    m.access.ownedSyllabus.mockRejectedValue(new AppError("NOT_FOUND"));
    expect(await codeOf(deleteSyllabus(SCOPE, "syl_other"))).toBe("NOT_FOUND");
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("teacher.syllabus.remove", () => {
  const caller = (userId: number) =>
    appRouter.createCaller({
      user: { id: userId, role: "user", openId: `u${userId}` } as TrpcContext["user"],
      session: null,
      req: { ip: "10.0.0.9", protocol: "https", headers: {} } as TrpcContext["req"],
      res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    } as TrpcContext);

  it("maps enrolled students to a CONFLICT the client can explain", async () => {
    m.workspace.resolveWorkspace.mockResolvedValue({ id: "ws_teacher", ownerUserId: 7 } as never);
    fakeTx([[{ id: "syl1" }], [{ n: 2 }]]);
    expect(await codeOf(caller(7).teacher.syllabus.remove({ id: "syl1" }))).toBe("CONFLICT:SYLLABUS_HAS_STUDENTS");
  });

  it("requires a teacher workspace", async () => {
    m.workspace.resolveWorkspace.mockResolvedValue(null);
    expect(await codeOf(caller(9).teacher.syllabus.remove({ id: "syl1" }))).toBe("FORBIDDEN:NO_WORKSPACE");
  });
});

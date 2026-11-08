import { getTableName, type Table } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "./db";
import { deleteBankQuestions } from "./questionBank/bank";

vi.mock("./db", async (importOriginal) => ({ ...(await importOriginal<typeof import("./db")>()), requireDb: vi.fn() }));

const m = { db: vi.mocked(db) };
const SCOPE = { workspaceId: "ws_teacher", userId: 7 };

function chain(value: () => unknown): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(value());
        return () => chain(value);
      },
    },
  );
}

/**
 * Queues results for the top-level `db.select(...)` calls `deleteBankQuestions` makes in order
 * (owned ids, then the ids in use in an exam, then the ids in use in a task quiz), and records
 * which tables a later `db.transaction` deletes from.
 */
function fakeDb(selects: unknown[]) {
  const deleted: string[] = [];
  const tx = { delete: (table: Table) => (deleted.push(getTableName(table)), chain(() => undefined)) };
  const transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  m.db.requireDb.mockReturnValue({ select: () => chain(() => selects.shift() ?? []), transaction } as never);
  return { deleted, transaction };
}

beforeEach(() => vi.clearAllMocks());

describe("deleteBankQuestions", () => {
  it("deletes questions that are owned and not used anywhere", async () => {
    const { deleted, transaction } = fakeDb([[{ id: "q1" }, { id: "q2" }], [], []]);
    await expect(deleteBankQuestions(SCOPE, ["q1", "q2"])).resolves.toEqual({ deleted: 2, inUse: 0 });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual(["question_meta", "questions"]);
  });

  it("skips questions used in an exam or a task quiz instead of deleting them", async () => {
    const { deleted, transaction } = fakeDb([[{ id: "q1" }, { id: "q2" }, { id: "q3" }], [{ id: "q1" }], [{ id: "q3" }]]);
    await expect(deleteBankQuestions(SCOPE, ["q1", "q2", "q3"])).resolves.toEqual({ deleted: 1, inUse: 2 });
    expect(transaction).toHaveBeenCalledTimes(1);
    // Only q2 was deletable, but the whole batch is still one transaction.
    expect(deleted).toEqual(["question_meta", "questions"]);
  });

  it("deletes nothing, and never opens a transaction, when every selected question is in use", async () => {
    const { transaction } = fakeDb([[{ id: "q1" }], [{ id: "q1" }], []]);
    await expect(deleteBankQuestions(SCOPE, ["q1"])).resolves.toEqual({ deleted: 0, inUse: 1 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("ignores ids that don't belong to the teacher's workspace", async () => {
    const { transaction } = fakeDb([[]]);
    await expect(deleteBankQuestions(SCOPE, ["someone-elses-question"])).resolves.toEqual({ deleted: 0, inUse: 0 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("returns immediately for an empty id list without touching the database", async () => {
    await expect(deleteBankQuestions(SCOPE, [])).resolves.toEqual({ deleted: 0, inUse: 0 });
    expect(m.db.requireDb).not.toHaveBeenCalled();
  });
});

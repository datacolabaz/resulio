import { beforeEach, describe, expect, it, vi } from "vitest";
import { sqlLabConfigs, sqlLabSubmissions, tasks } from "../../drizzle/schema";

/**
 * Fakes requireDb() the same way server/answerKey.test.ts does: each table gets its own mutable
 * row array, and `.where()` is a no-op pass-through rather than a real predicate evaluator (every
 * test keeps exactly the one row relevant to the call it's exercising, so this stays correct
 * without having to reverse-engineer drizzle-orm's internal query-condition shape).
 */
function makeFakeDb() {
  const state = {
    tasks: [] as Record<string, unknown>[],
    sqlLabConfigs: [] as Record<string, unknown>[],
    sqlLabSubmissions: [] as Record<string, unknown>[],
  };
  const tableFor = (table: unknown) =>
    table === tasks
      ? state.tasks
      : table === sqlLabConfigs
        ? state.sqlLabConfigs
        : table === sqlLabSubmissions
          ? state.sqlLabSubmissions
          : (() => {
              throw new Error("unknown table in fakeDb");
            })();

  const query = (rows: Record<string, unknown>[]) => {
    const resolved = () => Promise.resolve([...rows]);
    const chain: PromiseLike<unknown> & {
      where: () => typeof chain;
      limit: (n: number) => Promise<unknown[]>;
    } = {
      where: () => chain,
      limit: async (n: number) => rows.slice(0, n),
      then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
        resolved().then(onOk, onErr),
    } as never;
    return chain;
  };

  const db = {
    select: () => ({ from: (table: unknown) => query(tableFor(table)) }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        tableFor(table).push({ ...values });
        return [{ affectedRows: 1 }];
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          for (const row of tableFor(table)) Object.assign(row, patch);
          return [{ affectedRows: tableFor(table).length }];
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        const rows = tableFor(table);
        const removed = rows.length;
        rows.length = 0;
        return [{ affectedRows: removed }];
      },
    }),
  };
  return { db, state };
}

const mocks = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../db", () => ({ requireDb: () => mocks.db }));

const fileMocks = vi.hoisted(() => ({ fileRow: vi.fn(), fileBytes: vi.fn() }));
vi.mock("./files", async () => {
  const actual = await vi.importActual<typeof import("./files")>("./files");
  return {
    ...actual,
    fileRow: fileMocks.fileRow,
    fileBytes: fileMocks.fileBytes,
  };
});

import {
  removeSqlLabConfig,
  saveSqlLabConfig,
  sqlLabConfigOf,
  sqlLabConfigsForTasks,
  sqlLabSubmissionsForStudent,
  submitSqlLabQuery,
} from "./sqlLab";

const CSV = "name,score\nAli,90\nVali,60\n";
const SCOPE = { workspaceId: "ws1", userId: 7 };

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    providerWorkspaceId: "ws1",
    accessMode: "PUBLIC",
    studentIds: [1, 5],
    groupIds: [],
    attachments: [],
    ...overrides,
  };
}

beforeEach(() => {
  const { db, state } = makeFakeDb();
  mocks.db = db;
  state.tasks.push(baseTask());
  fileMocks.fileRow.mockReset();
  fileMocks.fileBytes.mockReset();
  fileMocks.fileRow.mockResolvedValue({
    id: "f1",
    fileName: "dataset.csv",
    workspaceId: "ws1",
    dataBase64: "",
    sizeBytes: CSV.length,
  });
  fileMocks.fileBytes.mockResolvedValue(Buffer.from(CSV, "utf-8"));
  (
    mocks.db as ReturnType<typeof makeFakeDb>["db"] & { __state: typeof state }
  ).__state = state;
});

function currentState() {
  return (
    mocks.db as unknown as { __state: ReturnType<typeof makeFakeDb>["state"] }
  ).__state;
}

describe("saveSqlLabConfig", () => {
  it("runs the reference query for real and stores the expected result", async () => {
    const config = await saveSqlLabConfig(SCOPE, "t1", {
      datasetFileId: "f1",
      referenceQuery: "SELECT name, score FROM dataset WHERE score > 70",
      gradeMode: "EXACT_UNORDERED",
    });
    expect(config.expectedColumns).toEqual(["name", "score"]);
    expect(config.expectedRows).toEqual([["Ali", 90]]);
    expect(config.datasetColumns).toEqual(["name", "score"]);
  });

  it("adds the dataset file to the task's own attachments, for the existing download-access rules to cover it", async () => {
    await saveSqlLabConfig(SCOPE, "t1", {
      datasetFileId: "f1",
      referenceQuery: "SELECT * FROM dataset",
      gradeMode: "ROW_COUNT_ONLY",
    });
    expect(currentState().tasks[0].attachments).toEqual([
      { fileId: "f1", name: "dataset.csv", size: CSV.length },
    ]);
  });

  it("rejects a non-csv dataset file", async () => {
    fileMocks.fileRow.mockResolvedValue({
      id: "f1",
      fileName: "dataset.xlsx",
      workspaceId: "ws1",
      dataBase64: "",
    });
    await expect(
      saveSqlLabConfig(SCOPE, "t1", {
        datasetFileId: "f1",
        referenceQuery: "SELECT * FROM dataset",
        gradeMode: "ROW_COUNT_ONLY",
      })
    ).rejects.toMatchObject({ code: "FILE_TYPE_NOT_ALLOWED" });
  });

  it("rejects a reference query that errors against the dataset, so the teacher finds out immediately", async () => {
    await expect(
      saveSqlLabConfig(SCOPE, "t1", {
        datasetFileId: "f1",
        referenceQuery: "SELEKT * FROM dataset",
        gradeMode: "ROW_COUNT_ONLY",
      })
    ).rejects.toMatchObject({ code: "SQL_LAB_REFERENCE_QUERY_FAILED" });
  });

  it("rejects a task from another workspace (ownership check)", async () => {
    await expect(
      saveSqlLabConfig({ workspaceId: "someone-else", userId: 1 }, "t1", {
        datasetFileId: "f1",
        referenceQuery: "SELECT * FROM dataset",
        gradeMode: "ROW_COUNT_ONLY",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("re-saving replaces the previous config rather than duplicating it", async () => {
    await saveSqlLabConfig(SCOPE, "t1", {
      datasetFileId: "f1",
      referenceQuery: "SELECT * FROM dataset",
      gradeMode: "ROW_COUNT_ONLY",
    });
    await saveSqlLabConfig(SCOPE, "t1", {
      datasetFileId: "f1",
      referenceQuery: "SELECT name FROM dataset",
      gradeMode: "EXACT_UNORDERED",
    });
    expect(currentState().sqlLabConfigs).toHaveLength(1);
    expect(currentState().sqlLabConfigs[0].referenceQuery).toBe(
      "SELECT name FROM dataset"
    );
  });
});

describe("sqlLabConfigOf / removeSqlLabConfig", () => {
  it("returns null when the task has no SQL lab configured", async () => {
    expect(await sqlLabConfigOf(SCOPE, "t1")).toBeNull();
  });

  it("removeSqlLabConfig deletes the config and any submissions", async () => {
    await saveSqlLabConfig(SCOPE, "t1", {
      datasetFileId: "f1",
      referenceQuery: "SELECT * FROM dataset",
      gradeMode: "ROW_COUNT_ONLY",
    });
    currentState().sqlLabSubmissions.push({ id: "s1", taskId: "t1" });
    await removeSqlLabConfig(SCOPE, "t1");
    expect(currentState().sqlLabConfigs).toHaveLength(0);
    expect(currentState().sqlLabSubmissions).toHaveLength(0);
  });
});

describe("submitSqlLabQuery", () => {
  beforeEach(async () => {
    await saveSqlLabConfig(SCOPE, "t1", {
      datasetFileId: "f1",
      referenceQuery: "SELECT name, score FROM dataset ORDER BY score DESC",
      gradeMode: "EXACT_ORDERED",
    });
  });

  it("re-runs the student's query independently and grades CORRECT when it matches", async () => {
    const r = await submitSqlLabQuery(
      1,
      [],
      "t1",
      "SELECT name, score FROM dataset ORDER BY score DESC"
    );
    expect(r.status).toBe("CORRECT");
    expect(r.autoScore).toBe(100);
    expect(r.resultRowCount).toBe(2);
  });

  it("grades WRONG when the student's result differs from the reference", async () => {
    const r = await submitSqlLabQuery(
      1,
      [],
      "t1",
      "SELECT name, score FROM dataset ORDER BY score ASC"
    );
    expect(r.status).toBe("WRONG");
    expect(r.autoScore).toBe(0);
  });

  it("never trusts a client-supplied result -- only the text is sent, and the server re-executes it", async () => {
    // There is no "reportedResult" parameter at all; this just documents the function's shape.
    expect(submitSqlLabQuery.length).toBe(4);
  });

  it("records a QUERY_ERROR as status ERROR with the sandbox's message, not a thrown exception", async () => {
    const r = await submitSqlLabQuery(1, [], "t1", "SELEKT * FROM dataset");
    expect(r.status).toBe("ERROR");
    expect(r.errorMessage).toBeTruthy();
    expect(r.autoScore).toBe(0);
  });

  it("resubmitting updates the same row instead of accumulating history", async () => {
    await submitSqlLabQuery(
      1,
      [],
      "t1",
      "SELECT name, score FROM dataset ORDER BY score ASC"
    );
    await submitSqlLabQuery(
      1,
      [],
      "t1",
      "SELECT name, score FROM dataset ORDER BY score DESC"
    );
    expect(currentState().sqlLabSubmissions).toHaveLength(1);
    expect(currentState().sqlLabSubmissions[0].status).toBe("CORRECT");
  });

  it("throws SQL_LAB_NOT_CONFIGURED for a task with no reference query saved", async () => {
    currentState().sqlLabConfigs.length = 0;
    await expect(
      submitSqlLabQuery(1, [], "t1", "SELECT 1")
    ).rejects.toMatchObject({ code: "SQL_LAB_NOT_CONFIGURED" });
  });

  it("throws TASK_NO_ACCESS / NOT_FOUND when the task doesn't reach this student", async () => {
    currentState().tasks[0] = baseTask({
      accessMode: "GROUPS",
      groupIds: ["g1"],
    });
    await expect(
      submitSqlLabQuery(1, [], "t1", "SELECT 1")
    ).rejects.toMatchObject({ code: "TASK_NO_ACCESS" });
  });
});

describe("sqlLabConfigsForTasks / sqlLabSubmissionsForStudent (student-safe projections)", () => {
  it("never exposes the reference query or expected rows to the student view", async () => {
    await saveSqlLabConfig(SCOPE, "t1", {
      datasetFileId: "f1",
      referenceQuery: "SELECT * FROM dataset",
      gradeMode: "EXACT_UNORDERED",
    });
    const map = await sqlLabConfigsForTasks(["t1"], mocks.db as never);
    const config = map.get("t1");
    expect(config).toBeDefined();
    expect(config).not.toHaveProperty("referenceQuery");
    expect(config).not.toHaveProperty("expectedRows");
    expect(config?.datasetColumns).toEqual(["name", "score"]);
  });

  it("sqlLabSubmissionsForStudent keys the map by taskId", async () => {
    await saveSqlLabConfig(SCOPE, "t1", {
      datasetFileId: "f1",
      referenceQuery: "SELECT * FROM dataset",
      gradeMode: "ROW_COUNT_ONLY",
    });
    await submitSqlLabQuery(5, [], "t1", "SELECT * FROM dataset");
    const map = await sqlLabSubmissionsForStudent(5, ["t1"], mocks.db as never);
    expect(map.get("t1")?.status).toBe("CORRECT");
  });
});

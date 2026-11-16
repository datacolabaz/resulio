import { describe, expect, it } from "vitest";
import {
  compareSqlResults,
  inferColumnType,
  parseDataset,
  runSandboxedQuery,
  SANDBOX_TIMEOUT_MS,
  SandboxExecutionError,
} from "./sqlSandbox";

const CSV = "id,name,score\n1,Ali,91.5\n2,Vali,\n3,Ziya,70\n";

describe("parseDataset", () => {
  it("reads header + rows, blank cells become null", () => {
    const d = parseDataset(CSV);
    expect(d.columns).toEqual(["id", "name", "score"]);
    expect(d.rows).toEqual([
      ["1", "Ali", "91.5"],
      ["2", "Vali", null],
      ["3", "Ziya", "70"],
    ]);
  });

  it("sanitizes headers into bare SQL identifiers and de-duplicates them", () => {
    const d = parseDataset("Tələbə Adı,Tələbə Adı,1 nömrə\nA,B,C\n");
    expect(d.columns).toEqual(["Tələbə_Adı", "Tələbə_Adı_2", "c_1_nömrə"]);
  });

  it("throws DATASET_EMPTY for a blank CSV", () => {
    expect(() => parseDataset("\n\n")).toThrowError(SandboxExecutionError);
    try {
      parseDataset("");
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxExecutionError);
      expect((e as SandboxExecutionError).kind).toBe("DATASET_EMPTY");
    }
  });
});

describe("inferColumnType", () => {
  it("picks BIGINT only when every value is a plain integer", () => {
    expect(inferColumnType(["1", "2", "-3"])).toBe("BIGINT");
  });
  it("falls back to DOUBLE once a decimal appears", () => {
    expect(inferColumnType(["1", "2.5", "-3"])).toBe("DOUBLE");
  });
  it("falls back to VARCHAR once any non-numeric value appears", () => {
    expect(inferColumnType(["1", "Ali", "3"])).toBe("VARCHAR");
  });
  it("ignores nulls when inferring", () => {
    expect(inferColumnType(["1", null, "3"])).toBe("BIGINT");
  });
  it("an all-null column is VARCHAR (nothing to infer from)", () => {
    expect(inferColumnType([null, null])).toBe("VARCHAR");
  });
});

describe("runSandboxedQuery", () => {
  it("loads the CSV as table `dataset` and runs a real query against it", async () => {
    const r = await runSandboxedQuery(
      CSV,
      "SELECT name, score FROM dataset WHERE score > 50 ORDER BY score DESC"
    );
    expect(r.columns).toEqual(["name", "score"]);
    expect(r.rows).toEqual([
      ["Ali", 91.5],
      ["Ziya", 70],
    ]);
    expect(r.rowCount).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it('keeps NULLs as null, not the string "null"', async () => {
    const r = await runSandboxedQuery(
      CSV,
      "SELECT name, score FROM dataset ORDER BY id"
    );
    expect(r.rows[1]).toEqual(["Vali", null]);
  });

  it("surfaces a DuckDB syntax error as its own message, not a generic failure", async () => {
    await expect(
      runSandboxedQuery(CSV, "SELEKT * FROM dataset")
    ).rejects.toMatchObject({
      kind: "QUERY_ERROR",
    });
  });

  it("has no filesystem access even if a query tries to read one", async () => {
    await expect(
      runSandboxedQuery(CSV, "SELECT * FROM read_csv_auto('/etc/passwd')")
    ).rejects.toMatchObject({
      kind: "QUERY_ERROR",
    });
  });

  it("has no network access even if a query tries to reach one", async () => {
    await expect(
      runSandboxedQuery(
        CSV,
        "SELECT * FROM read_csv_auto('https://example.com/x.csv')"
      )
    ).rejects.toMatchObject({
      kind: "QUERY_ERROR",
    });
  });

  it("interrupts a query that runs past the timeout instead of hanging forever", async () => {
    const started = Date.now();
    await expect(
      runSandboxedQuery(
        CSV,
        "SELECT count(*) FROM range(100000000000) a, range(100000) b",
        { timeoutMs: 300 }
      )
    ).rejects.toMatchObject({ kind: "TIMEOUT" });
    // generous upper bound: proves it was interrupted near the requested timeout, not left running
    expect(Date.now() - started).toBeLessThan(5 * SANDBOX_TIMEOUT_MS);
  }, 20_000);

  it("truncates a result larger than maxRows but still reports the true row count", async () => {
    const bigCsv =
      "n\n" + Array.from({ length: 50 }, (_, i) => i).join("\n") + "\n";
    const r = await runSandboxedQuery(
      bigCsv,
      "SELECT n FROM dataset ORDER BY n",
      { maxRows: 10 }
    );
    expect(r.rows.length).toBe(10);
    expect(r.rowCount).toBe(50);
    expect(r.truncated).toBe(true);
  });
});

describe("compareSqlResults", () => {
  const expected = {
    columns: ["name", "score"],
    rows: [
      ["Ali", 91.5],
      ["Ziya", 70],
    ],
  };

  it("EXACT_ORDERED accepts an identical result", () => {
    expect(compareSqlResults(expected, expected, "EXACT_ORDERED")).toEqual({
      correct: true,
    });
  });

  it("EXACT_ORDERED rejects the same rows in a different order", () => {
    const flipped = {
      columns: ["name", "score"],
      rows: [
        ["Ziya", 70],
        ["Ali", 91.5],
      ],
    };
    expect(compareSqlResults(expected, flipped, "EXACT_ORDERED").correct).toBe(
      false
    );
  });

  it("EXACT_UNORDERED accepts the same rows in a different order", () => {
    const flipped = {
      columns: ["name", "score"],
      rows: [
        ["Ziya", 70],
        ["Ali", 91.5],
      ],
    };
    expect(compareSqlResults(expected, flipped, "EXACT_UNORDERED")).toEqual({
      correct: true,
    });
  });

  it("EXACT_UNORDERED rejects a different row count", () => {
    const short = { columns: ["name", "score"], rows: [["Ali", 91.5]] };
    expect(compareSqlResults(expected, short, "EXACT_UNORDERED")).toEqual({
      correct: false,
      reason: "ROW_COUNT",
    });
  });

  it("EXACT_UNORDERED rejects a column rename", () => {
    const renamed = { columns: ["Name", "points"], rows: expected.rows };
    expect(compareSqlResults(expected, renamed, "EXACT_UNORDERED")).toEqual({
      correct: false,
      reason: "COLUMN_NAMES",
    });
  });

  it("column name comparison is case-insensitive", () => {
    const upper = { columns: ["NAME", "SCORE"], rows: expected.rows };
    expect(compareSqlResults(expected, upper, "EXACT_UNORDERED")).toEqual({
      correct: true,
    });
  });

  it("ROW_COUNT_ONLY ignores column names and row content, only counts rows", () => {
    const differentShape = { columns: ["x"], rows: [["anything"], ["else"]] };
    expect(
      compareSqlResults(expected, differentShape, "ROW_COUNT_ONLY")
    ).toEqual({ correct: true });
  });

  it("treats null consistently regardless of representation", () => {
    const withNull = { columns: ["name", "score"], rows: [["Ali", null]] };
    const sameNull = { columns: ["name", "score"], rows: [["Ali", null]] };
    expect(compareSqlResults(withNull, sameNull, "EXACT_ORDERED")).toEqual({
      correct: true,
    });
  });
});

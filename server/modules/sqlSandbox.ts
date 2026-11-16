/**
 * Fully isolated SQL execution sandbox for SQL Practice Lab.
 *
 * Used for exactly two things: (1) the teacher's reference query, run once at upload time to
 * snapshot the expected result into `sql_lab_configs`, and (2) the server-side re-execution that
 * grading relies on when a student submits -- the browser's own DuckDB-Wasm result is never
 * trusted, so the student's query text is run again here, independently, before it is compared
 * against the saved reference snapshot (see `compareSqlResults`).
 *
 * Isolation, concretely, every run:
 *  - gets a brand-new in-memory DuckDB instance (`:memory:`), destroyed after the call returns;
 *  - is created with `enable_external_access: false`, which blocks every SQL-level path to a file
 *    or the network (ATTACH, COPY, httpfs, read_csv_auto on a path, ...) -- verified against the
 *    installed DuckDB build, not just documentation (see server/modules/sqlSandbox.test.ts);
 *  - never reads the dataset from disk: the CSV is parsed in JS and loaded into an in-memory table
 *    through the Appender API, so no file path is ever handed to DuckDB;
 *  - runs single-threaded (`SET threads=1`) with a 256 MB memory cap (`SET memory_limit`);
 *  - is interrupted (not just abandoned) after a hard wall-clock timeout.
 *
 * This module must NEVER import `requireDb()` or anything that reaches the production MySQL
 * pool -- that is the isolation boundary this whole module exists to enforce. See the SQL
 * Practice Lab audit doc ("Təhlükəsizlik") for the full design and the reasoning behind each limit.
 */
import {
  DuckDBInstance,
  type DuckDBAppender,
  type DuckDBConnection,
} from "@duckdb/node-api";
import type { SqlLabGradeMode } from "../../drizzle/schema";
import { parseCsv } from "./textExtract";

export const SANDBOX_MEMORY_LIMIT = "256MB";
export const SANDBOX_TIMEOUT_MS = 5_000;
/** What actually gets persisted to `sql_lab_submissions.resultRowsPreview` (the cost note's "ən baş 50 sətir"). */
export const SANDBOX_PREVIEW_ROWS = 50;
/** Hard cap on rows this module will ever materialize into JS for ANY caller -- grading needs the
 *  full comparison, but nothing here should hold an unbounded result in memory. Comfortably above
 *  what a classroom CSV (<=8 MB upload) and a simple SELECT can produce. */
export const SANDBOX_MAX_RESULT_ROWS = 20_000;

export type SandboxErrorKind = "DATASET_EMPTY" | "TIMEOUT" | "QUERY_ERROR";

/** Carries the sandbox's OWN error text (a DuckDB parser/binder message, or a plain timeout
 *  notice) -- this is shown back to the student as-is, per the architecture doc, so the message is
 *  part of the contract, not incidental. `kind` is for callers that need to branch (e.g. mapping to
 *  an AppErrorCode at the router boundary in a later phase). */
export class SandboxExecutionError extends Error {
  constructor(
    public readonly kind: SandboxErrorKind,
    message: string
  ) {
    super(message);
    this.name = "SandboxExecutionError";
  }
}

export interface SandboxDataset {
  columns: string[];
  rows: (string | null)[][];
}

/**
 * Parses a teacher's CSV upload into a header row + string rows (reusing the same RFC-4180-ish
 * parser `textExtract.ts` already uses for AI text extraction -- no second CSV parser). Blank
 * trailing lines are dropped; a blank cell becomes `null` rather than `""`, so NULL-aware grading
 * and type inference (below) both see absence consistently.
 */
export function parseDataset(csvText: string): SandboxDataset {
  const parsed = parseCsv(csvText).filter(row =>
    row.some(cell => cell.trim() !== "")
  );
  if (!parsed.length)
    throw new SandboxExecutionError(
      "DATASET_EMPTY",
      "CSV faylı boşdur və ya heç bir sətir tapılmadı."
    );
  const [header, ...dataRows] = parsed;
  const seen = new Map<string, number>();
  const columns = header.map((raw, i) => {
    const base = sanitizeColumnName(raw) || `column_${i + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}_${n + 1}`;
  });
  const width = columns.length;
  return {
    columns,
    rows: dataRows.map(r =>
      Array.from({ length: width }, (_, i) => {
        const v = (r[i] ?? "").trim();
        return v === "" ? null : v;
      })
    ),
  };
}

/** A column header becomes a bare SQL identifier: letters/digits/underscore only, never starting
 *  with a digit (DuckDB would otherwise need the header quoted everywhere a student's query refers
 *  to it, which defeats the point of showing them the real column names). */
function sanitizeColumnName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^\p{L}\p{N}_]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return /^[0-9]/.test(cleaned) ? `c_${cleaned}` : cleaned;
}

export type InferredType = "BIGINT" | "DOUBLE" | "VARCHAR";

const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?\d+\.\d+$/;

/**
 * Column type, inferred the same simple way a clean classroom CSV would be read by any CSV
 * sniffer: every non-null value in the column must agree, else it falls back to VARCHAR -- the
 * safe default, since a text column still compares correctly character-for-character.
 *
 * Known MVP simplification (tracked for a later phase, not silently dropped): no DATE inference.
 * A date-looking column (`2026-09-01`) is loaded as VARCHAR; a query that needs it as a real date
 * can `CAST(col AS DATE)` explicitly. Adding DATE inference needs the Appender's `appendDate`,
 * which takes a days-since-epoch value object rather than a string -- real work, deliberately left
 * out of this foundation increment rather than rushed in half-tested.
 */
export function inferColumnType(values: (string | null)[]): InferredType {
  const present = values.filter((v): v is string => v !== null);
  if (!present.length) return "VARCHAR";
  if (present.every(v => INT_RE.test(v))) return "BIGINT";
  if (present.every(v => INT_RE.test(v) || FLOAT_RE.test(v))) return "DOUBLE";
  return "VARCHAR";
}

async function loadDataset(
  conn: DuckDBConnection,
  dataset: SandboxDataset
): Promise<void> {
  const types = dataset.columns.map((_, i) =>
    inferColumnType(dataset.rows.map(r => r[i]))
  );
  const ddl = dataset.columns
    .map((c, i) => `"${c.replace(/"/g, '""')}" ${types[i]}`)
    .join(", ");
  await conn.run(`CREATE TABLE dataset (${ddl})`);
  if (!dataset.rows.length) return;
  const appender = await conn.createAppender("dataset");
  try {
    for (const row of dataset.rows) {
      row.forEach((value, i) => appendValue(appender, types[i], value));
      appender.endRow();
    }
    appender.flushSync();
  } finally {
    appender.closeSync();
  }
}

function appendValue(
  appender: DuckDBAppender,
  type: InferredType,
  value: string | null
): void {
  if (value === null) {
    appender.appendNull();
    return;
  }
  if (type === "BIGINT") appender.appendBigInt(BigInt(value));
  else if (type === "DOUBLE") appender.appendDouble(Number(value));
  else appender.appendVarchar(value);
}

/** DuckDB's own JS values (BigInt for BIGINT columns, Date objects for timestamps, ...) collapsed
 *  to plain JSON-storable values -- the same shape for the reference snapshot and every grading
 *  re-run, so they can be compared and persisted (`sql_lab_configs`/`sql_lab_submissions`) without
 *  a second conversion step anywhere else. */
function toJsonSafe(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint")
    return Number.isSafeInteger(Number(value))
      ? Number(value)
      : value.toString();
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "string"
  )
    return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export interface SandboxResult {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  /** Row count BEFORE any truncation -- `rows` may be shorter; `truncated` says so explicitly. */
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

export interface SandboxOptions {
  timeoutMs?: number;
  maxRows?: number;
}

/**
 * Runs one SQL statement against one CSV dataset, from nothing to a finished result, inside the
 * isolation boundary described at the top of this file. Throws `SandboxExecutionError` for an
 * empty dataset, a DuckDB parser/binder/runtime error (its own message, unmodified), or a timeout.
 */
export async function runSandboxedQuery(
  csvText: string,
  sql: string,
  opts: SandboxOptions = {}
): Promise<SandboxResult> {
  const timeoutMs = opts.timeoutMs ?? SANDBOX_TIMEOUT_MS;
  const maxRows = opts.maxRows ?? SANDBOX_MAX_RESULT_ROWS;
  const dataset = parseDataset(csvText);
  const instance = await DuckDBInstance.create(":memory:", {
    enable_external_access: "false",
  });
  try {
    const conn = await instance.connect();
    try {
      await conn.run(`SET memory_limit='${SANDBOX_MEMORY_LIMIT}'`);
      await conn.run("SET threads=1");
      await loadDataset(conn, dataset);

      const start = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          conn.interrupt();
          reject(
            new SandboxExecutionError(
              "TIMEOUT",
              `Sorğu ${timeoutMs} ms ərzində tamamlanmadı və dayandırıldı.`
            )
          );
        }, timeoutMs);
      });
      let reader: Awaited<ReturnType<typeof conn.runAndReadAll>>;
      try {
        reader = await Promise.race([conn.runAndReadAll(sql), timedOut]);
      } catch (e) {
        if (e instanceof SandboxExecutionError) throw e;
        throw new SandboxExecutionError(
          "QUERY_ERROR",
          e instanceof Error ? e.message : String(e)
        );
      } finally {
        clearTimeout(timer);
      }
      const elapsedMs = Date.now() - start;
      const columns = reader.columnNames();
      const allRows = reader
        .getRowsJS()
        .map((row: unknown[]) => row.map(toJsonSafe));
      return {
        columns,
        rows: allRows.slice(0, maxRows),
        rowCount: allRows.length,
        truncated: allRows.length > maxRows,
        elapsedMs,
      };
    } finally {
      conn.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}

export interface SandboxComparison {
  correct: boolean;
  /** Machine-readable mismatch reason, for logs -- never shown to the student verbatim. */
  reason?: "COLUMN_COUNT" | "COLUMN_NAMES" | "ROW_COUNT" | "ROW_MISMATCH";
}

function cellSignature(v: unknown): string {
  if (v === null || v === undefined) return "\0null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return String(v).trim();
}

function rowSignature(row: unknown[]): string {
  return JSON.stringify(row.map(cellSignature));
}

/**
 * Compares a student's (server-side, re-executed) result against the teacher's saved reference
 * snapshot, per the task's `gradeMode`:
 *  - EXACT_ORDERED: same columns in the same order, same rows in the same order.
 *  - EXACT_UNORDERED: same columns in the same order, same rows as a multiset (row order free).
 *  - ROW_COUNT_ONLY: only the row count has to match (column names/order ignored).
 * Column names compare case-insensitively (a student aliasing `AS Name` instead of `AS name`
 * shouldn't fail on casing alone); cell values compare by trimmed string form, so `7` and `7.0`
 * from differently-typed columns still agree where a teacher would expect them to.
 */
export function compareSqlResults(
  expected: { columns: string[]; rows: unknown[][] },
  actual: { columns: string[]; rows: unknown[][] },
  mode: SqlLabGradeMode
): SandboxComparison {
  if (mode !== "ROW_COUNT_ONLY") {
    if (expected.columns.length !== actual.columns.length)
      return { correct: false, reason: "COLUMN_COUNT" };
    const sameNames = expected.columns.every(
      (c, i) =>
        c.trim().toLowerCase() ===
        (actual.columns[i] ?? "").trim().toLowerCase()
    );
    if (!sameNames) return { correct: false, reason: "COLUMN_NAMES" };
  }
  if (expected.rows.length !== actual.rows.length)
    return { correct: false, reason: "ROW_COUNT" };
  if (mode === "ROW_COUNT_ONLY") return { correct: true };
  if (mode === "EXACT_ORDERED") {
    const ok = expected.rows.every(
      (r, i) => rowSignature(r) === rowSignature(actual.rows[i] ?? [])
    );
    return ok ? { correct: true } : { correct: false, reason: "ROW_MISMATCH" };
  }
  const a = expected.rows.map(rowSignature).sort();
  const b = actual.rows.map(rowSignature).sort();
  const ok = a.every((v, i) => v === b[i]);
  return ok ? { correct: true } : { correct: false, reason: "ROW_MISMATCH" };
}

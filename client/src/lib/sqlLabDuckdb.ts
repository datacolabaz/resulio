import * as duckdb from "@duckdb/duckdb-wasm";

/**
 * In-browser SQL execution for the SQL Practice Lab's instant "İşlət" preview, via DuckDB-Wasm.
 * PREVIEW ONLY -- never trusted for grading. The "Göndər" submit always sends the raw query text to
 * the server, which re-runs it independently in its own sandbox (server/modules/sqlSandbox.ts) and
 * that result is the only one that ever becomes the grade. See client/src/components/tasks/SqlLab.tsx.
 *
 * Loaded from jsDelivr's CDN bundles (duckdb.getJsDelivrBundles()) rather than bundled by Vite --
 * the officially documented zero-config path, so this needs no build changes. One AsyncDuckDB
 * instance is shared for the whole tab session (DuckDB-Wasm's own init is not cheap); each task's
 * dataset gets its own named table inside it.
 */

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

async function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], {
          type: "text/javascript",
        })
      );
      const worker = new Worker(workerUrl);
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(workerUrl);
      return db;
    })();
  }
  return dbPromise;
}

export interface BrowserQueryResult {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  rowCount: number;
}

function toJsonSafe(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint")
    return Number.isSafeInteger(Number(value))
      ? Number(value)
      : value.toString();
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  return String(value);
}

const PREVIEW_ROW_LIMIT = 100;

/**
 * Loads `csvText` as table `dataset` in a fresh, private DuckDB-Wasm connection, runs `sql` once,
 * and tears the connection down -- a new connection per run keeps one task's half-finished query
 * from leaking state into the next, and keeps this cheap enough to not bother pooling.
 */
export async function runBrowserPreview(
  csvText: string,
  sql: string
): Promise<BrowserQueryResult> {
  const db = await getDb();
  const conn = await db.connect();
  try {
    await db.registerFileText("dataset.csv", csvText);
    await conn.insertCSVFromPath("dataset.csv", {
      name: "dataset",
      detect: true,
    });
    const result = await conn.query(sql);
    const columns = result.schema.fields.map(f => f.name);
    const all = result
      .toArray()
      .map(row => columns.map(c => toJsonSafe(row[c])));
    return {
      columns,
      rows: all.slice(0, PREVIEW_ROW_LIMIT),
      rowCount: all.length,
    };
  } finally {
    await conn.close();
  }
}

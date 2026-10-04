import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";
import { envString } from "./env";

const LOCK_NAME = "resulio_migrations";
const LOCK_TIMEOUT_SECONDS = 60;
const TRACKING_TABLE = "__drizzle_migrations";

export type MigrationState = "pending" | "disabled" | "no_database" | "up_to_date" | "applied" | "skipped_untracked" | "failed";
export type MigrationStatus = { state: MigrationState; latest: string | null; applied: string[]; error?: string };
export type JournalEntry = { idx: number; tag: string; when: number };
/** Tables in the database, and the newest `created_at` in the tracking table (null = table missing or empty). */
export type DbState = { tables: string[]; lastAppliedAt: number | null };
export type Plan = { action: "migrate" } | { action: "baseline"; entries: JournalEntry[] } | { action: "skip"; reason: string };
export type SqlConn = Pick<mysql.Connection, "query">;

let status: MigrationStatus = { state: "pending", latest: null, applied: [] };

/** Outcome of the startup migration run, for /api/health. */
export function getMigrationStatus(): MigrationStatus {
  return status;
}

/** `drizzle/` next to the built `dist/index.js`, next to the repo root in dev (tsx), or under the cwd. */
export function resolveMigrationsFolder(moduleUrl = import.meta.url, cwd = process.cwd(), exists = fs.existsSync): string | null {
  const here = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [path.resolve(here, "../drizzle"), path.resolve(here, "../../drizzle"), path.resolve(cwd, "drizzle")];
  return candidates.find((dir) => exists(path.join(dir, "meta", "_journal.json"))) ?? null;
}

export function readJournal(folder: string): JournalEntry[] {
  const journal = JSON.parse(fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] };
  return journal.entries.map(({ idx, tag, when }) => ({ idx, tag, when }));
}

/** The hash drizzle stores in `__drizzle_migrations`: sha256 of the SQL file text. */
export function migrationHash(folder: string, tag: string): string {
  const text = fs.readFileSync(path.join(folder, `${tag}.sql`)).toString();
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Drizzle's migrator applies every journal entry newer than the last tracked `created_at`. With no tracking rows it
 * would replay 0000..N, which fails on a database whose tables were created another way (`drizzle-kit push`, manual
 * SQL). Such a database is only migrated after an operator names the last migration it already contains.
 */
export function planMigration(state: DbState, journal: JournalEntry[], baselineTag: string): Plan {
  if (state.lastAppliedAt !== null) return { action: "migrate" };
  const appTables = state.tables.filter((t) => t !== TRACKING_TABLE);
  if (appTables.length === 0) return { action: "migrate" };
  if (!baselineTag) {
    return {
      action: "skip",
      reason:
        `The database already has ${appTables.length} table(s) but no migration history (${TRACKING_TABLE} is missing or empty), ` +
        "so replaying every migration from 0000 would fail. Nothing was changed. Set AUTO_MIGRATE_BASELINE=<tag of the newest " +
        "migration already in this database> (e.g. 0014_add_share_event_downloaded) and redeploy. See RAILWAY.md.",
    };
  }
  const idx = journal.findIndex((e) => e.tag === baselineTag);
  if (idx < 0) return { action: "skip", reason: `AUTO_MIGRATE_BASELINE=${baselineTag} is not a tag in drizzle/meta/_journal.json. Nothing was changed.` };
  return { action: "baseline", entries: journal.slice(0, idx + 1) };
}

async function rows<T>(conn: SqlConn, sql: string, values: unknown[] = []): Promise<T[]> {
  const [result] = await conn.query(sql, values);
  return result as T[];
}

export async function readDbState(conn: SqlConn): Promise<DbState> {
  const tables = (await rows<{ t: string }>(conn, "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()")).map((r) => r.t);
  if (!tables.includes(TRACKING_TABLE)) return { tables, lastAppliedAt: null };
  const [last] = await rows<{ at: unknown }>(conn, `SELECT MAX(created_at) AS at FROM \`${TRACKING_TABLE}\``);
  return { tables, lastAppliedAt: last?.at == null ? null : Number(last.at) };
}

/** Same table definition and rows drizzle's migrator writes. */
export async function applyBaseline(conn: SqlConn, folder: string, entries: JournalEntry[]) {
  await conn.query(`CREATE TABLE IF NOT EXISTS \`${TRACKING_TABLE}\` (id serial primary key, hash text not null, created_at bigint)`);
  for (const e of entries) {
    await conn.query(`INSERT INTO \`${TRACKING_TABLE}\` (\`hash\`, \`created_at\`) VALUES (?, ?)`, [migrationHash(folder, e.tag), e.when]);
  }
}

/** Runs under a MySQL named lock so concurrently starting instances migrate one at a time on this connection. */
export async function migrateLocked(conn: SqlConn, folder: string, env: NodeJS.ProcessEnv, runMigrator: () => Promise<void>): Promise<MigrationStatus> {
  const journal = readJournal(folder);
  const tagAt = (when: number | null) => (when === null ? null : (journal.find((e) => e.when === when)?.tag ?? `unknown (created_at ${when})`));
  const [lock] = await rows<{ got: unknown }>(conn, "SELECT GET_LOCK(?, ?) AS got", [LOCK_NAME, LOCK_TIMEOUT_SECONDS]);
  if (Number(lock?.got) !== 1) {
    return { state: "failed", latest: null, applied: [], error: `Could not get the '${LOCK_NAME}' lock within ${LOCK_TIMEOUT_SECONDS}s (another instance still migrating?)` };
  }
  try {
    let state = await readDbState(conn);
    const baselineTag = envString("AUTO_MIGRATE_BASELINE", env);
    const plan = planMigration(state, journal, baselineTag);
    if (plan.action === "skip") return { state: "skipped_untracked", latest: null, applied: [], error: plan.reason };
    if (plan.action === "baseline") {
      await applyBaseline(conn, folder, plan.entries);
      const last = plan.entries[plan.entries.length - 1];
      console.warn(`[Migrations] Baseline: recorded ${plan.entries.length} migration(s) up to ${last.tag} as already applied (AUTO_MIGRATE_BASELINE).`);
      state = { ...state, lastAppliedAt: last.when };
    } else if (baselineTag && state.lastAppliedAt !== null) {
      console.warn("[Migrations] AUTO_MIGRATE_BASELINE is ignored because the migration history already exists; remove the variable.");
    }

    const lastBefore = state.lastAppliedAt;
    const pending = journal.filter((e) => lastBefore === null || e.when > lastBefore);
    if (pending.length === 0) return { state: "up_to_date", latest: tagAt(lastBefore), applied: [] };
    console.log(`[Migrations] Applying ${pending.length} pending migration(s): ${pending.map((e) => e.tag).join(", ")}`);
    try {
      await runMigrator();
    } catch (error) {
      const after = await readDbState(conn).catch(() => state);
      const failedAt = journal.find((e) => after.lastAppliedAt === null || e.when > after.lastAppliedAt);
      return {
        state: "failed",
        latest: tagAt(after.lastAppliedAt),
        applied: pending.filter((e) => after.lastAppliedAt !== null && e.when <= after.lastAppliedAt).map((e) => e.tag),
        error: `${failedAt?.tag ?? "migration"} failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { state: "applied", latest: journal[journal.length - 1].tag, applied: pending.map((e) => e.tag) };
  } finally {
    await conn.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]).catch(() => undefined);
  }
}

async function attempt(env: NodeJS.ProcessEnv): Promise<MigrationStatus> {
  if (envString("AUTO_MIGRATE", env) === "0") return { state: "disabled", latest: null, applied: [] };
  const url = envString("DATABASE_URL", env);
  if (!url) return { state: "no_database", latest: null, applied: [] };
  const folder = resolveMigrationsFolder();
  if (!folder) return { state: "failed", latest: null, applied: [], error: "drizzle/meta/_journal.json not found next to the server build" };
  let conn: mysql.Connection | undefined;
  try {
    const c = (conn = await mysql.createConnection({ uri: url, timezone: "Z" }));
    await c.query("SET time_zone = '+00:00'");
    return await migrateLocked(c, folder, env, () => migrate(drizzle(c), { migrationsFolder: folder }));
  } catch (error) {
    return { state: "failed", latest: null, applied: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    await conn?.end().catch(() => undefined);
  }
}

/**
 * Applies pending migrations from `drizzle/` at startup. Never throws: on failure the server keeps serving (features
 * whose tables are missing degrade on their own) and the outcome is logged and shown on /api/health.
 * AUTO_MIGRATE=0 turns it off.
 */
export async function runAutoMigrate(env: NodeJS.ProcessEnv = process.env): Promise<MigrationStatus> {
  status = await attempt(env);
  const { state, latest, applied, error } = status;
  if (state === "disabled") console.warn("[Migrations] Auto-migrate is off (AUTO_MIGRATE=0); apply migrations manually with pnpm db:migrate.");
  else if (state === "no_database") console.warn("[Migrations] DATABASE_URL is not set; auto-migrate skipped.");
  else if (state === "up_to_date") console.log(`[Migrations] Database schema is up to date (latest: ${latest}).`);
  else if (state === "applied") console.log(`[Migrations] Applied ${applied.length} migration(s); database schema is up to date (latest: ${latest}).`);
  else if (state === "skipped_untracked") console.error(`[Migrations] AUTO-MIGRATE SKIPPED: ${error}`);
  else if (state === "failed") {
    console.error(
      `[Migrations] AUTO-MIGRATE FAILED: ${error}. Applied this run: ${applied.join(", ") || "none"}; latest applied: ${latest ?? "unknown"}. ` +
        "The server keeps running; features needing the missing schema stay off until this is fixed.",
    );
  }
  return status;
}

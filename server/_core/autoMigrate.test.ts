import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMigrationStatus,
  migrateLocked,
  migrationHash,
  planMigration,
  readJournal,
  resolveMigrationsFolder,
  runAutoMigrate,
  type SqlConn,
} from "./autoMigrate";

const FOLDER = path.resolve(import.meta.dirname, "../../drizzle");
const journal = readJournal(FOLDER);
const tag = (prefix: string) => journal.find((e) => e.tag.startsWith(prefix))!;

function mockConn({ tables = [] as string[], lastAppliedAt = null as number | null, lock = 1 } = {}) {
  const tableSet = new Set(tables);
  const db = { lastAppliedAt };
  const calls: { sql: string; values: unknown[] }[] = [];
  const conn = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("GET_LOCK")) return [[{ got: lock }], []];
      if (sql.includes("information_schema.TABLES")) return [[...tableSet].map((t) => ({ t })), []];
      if (sql.includes("MAX(created_at)")) return [[{ at: db.lastAppliedAt === null ? null : String(db.lastAppliedAt) }], []];
      if (sql.startsWith("CREATE TABLE IF NOT EXISTS")) tableSet.add("__drizzle_migrations");
      if (sql.startsWith("INSERT INTO")) db.lastAppliedAt = Number(values[1]);
      return [[], []];
    },
  };
  return { conn: conn as unknown as SqlConn, calls, db };
}

describe("resolveMigrationsFolder", () => {
  const url = (...p: string[]) => pathToFileURL(path.resolve(...p)).href;
  const only = (dir: string) => (f: fs.PathLike) => String(f) === path.join(path.resolve(dir), "meta", "_journal.json");

  it("finds drizzle/ next to the built dist/index.js", () => {
    expect(resolveMigrationsFolder(url("/app/dist/index.js"), path.resolve("/elsewhere"), only("/app/drizzle"))).toBe(path.resolve("/app/drizzle"));
  });
  it("finds the repo drizzle/ from the dev source file", () => {
    expect(resolveMigrationsFolder(url("/repo/server/_core/autoMigrate.ts"), path.resolve("/elsewhere"), only("/repo/drizzle"))).toBe(path.resolve("/repo/drizzle"));
  });
  it("falls back to the working directory, else null", () => {
    expect(resolveMigrationsFolder(url("/x/dist/index.js"), path.resolve("/srv"), only("/srv/drizzle"))).toBe(path.resolve("/srv/drizzle"));
    expect(resolveMigrationsFolder(url("/x/dist/index.js"), path.resolve("/srv"), () => false)).toBeNull();
  });
  it("resolves the real folder in this repo", () => {
    expect(resolveMigrationsFolder()).toBe(FOLDER);
  });
});

describe("committed migrations", () => {
  it("hash and timestamp exactly as drizzle's migrator does", () => {
    const drizzleView = readMigrationFiles({ migrationsFolder: FOLDER });
    expect(drizzleView.map((m) => [m.hash, m.folderMillis])).toEqual(journal.map((e) => [migrationHash(FOLDER, e.tag), e.when]));
  });
  it("have strictly increasing journal timestamps (the migrator relies on it)", () => {
    for (let i = 1; i < journal.length; i++) expect(journal[i].when, journal[i].tag).toBeGreaterThan(journal[i - 1].when);
  });
  it("put at most one SQL statement between statement breakpoints", () => {
    for (const e of journal) {
      const chunks = fs.readFileSync(path.join(FOLDER, `${e.tag}.sql`), "utf8").split("--> statement-breakpoint");
      for (const chunk of chunks) {
        const code = chunk
          .split(/\r?\n/)
          .filter((l) => !l.trim().startsWith("--"))
          .join("\n")
          .replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
        expect((code.match(/;\s*(\n|$)/g) ?? []).length, e.tag).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("planMigration", () => {
  it("migrates a fresh database and one with history", () => {
    expect(planMigration({ tables: [], lastAppliedAt: null }, journal, "")).toEqual({ action: "migrate" });
    expect(planMigration({ tables: ["__drizzle_migrations"], lastAppliedAt: null }, journal, "")).toEqual({ action: "migrate" });
    expect(planMigration({ tables: ["users", "__drizzle_migrations"], lastAppliedAt: 1 }, journal, "0003_activity_tracking")).toEqual({ action: "migrate" });
  });
  it("skips existing tables without history unless a known baseline is given", () => {
    expect(planMigration({ tables: ["users"], lastAppliedAt: null }, journal, "")).toMatchObject({ action: "skip" });
    expect(planMigration({ tables: ["users", "__drizzle_migrations"], lastAppliedAt: null }, journal, "")).toMatchObject({ action: "skip" });
    expect(planMigration({ tables: ["users"], lastAppliedAt: null }, journal, "0099_nope")).toMatchObject({ action: "skip" });
    const plan = planMigration({ tables: ["users"], lastAppliedAt: null }, journal, "0002_assessment_engine");
    expect(plan.action === "baseline" && plan.entries.map((e) => e.tag)).toEqual(["0000_initial_users", "0001_user_app_role", "0002_assessment_engine"]);
  });
});

describe("migrateLocked", () => {
  it("applies everything on a fresh database under the named lock", async () => {
    const { conn, calls } = mockConn();
    const run = vi.fn(async () => undefined);
    const result = await migrateLocked(conn, FOLDER, {}, run);
    expect(run).toHaveBeenCalledOnce();
    expect(result).toEqual({ state: "applied", latest: journal.at(-1)!.tag, applied: journal.map((e) => e.tag) });
    expect(calls[0]).toEqual({ sql: "SELECT GET_LOCK(?, ?) AS got", values: ["resulio_migrations", 60] });
    expect(calls.at(-1)).toEqual({ sql: "SELECT RELEASE_LOCK(?)", values: ["resulio_migrations"] });
  });

  it("applies only migrations newer than the last tracked one", async () => {
    const { conn } = mockConn({ tables: ["users", "__drizzle_migrations"], lastAppliedAt: tag("0014").when });
    const result = await migrateLocked(conn, FOLDER, {}, async () => undefined);
    expect(result.applied[0]).toBe(tag("0015").tag);
    expect(result.applied).toHaveLength(journal.length - 15);
  });

  it("does nothing when up to date", async () => {
    const { conn } = mockConn({ tables: ["users", "__drizzle_migrations"], lastAppliedAt: journal.at(-1)!.when });
    const run = vi.fn(async () => undefined);
    expect(await migrateLocked(conn, FOLDER, { AUTO_MIGRATE_BASELINE: "0003_activity_tracking" }, run)).toEqual({ state: "up_to_date", latest: journal.at(-1)!.tag, applied: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses to replay onto an untracked database and writes nothing", async () => {
    const { conn, calls } = mockConn({ tables: ["users", "tasks"] });
    const run = vi.fn(async () => undefined);
    const result = await migrateLocked(conn, FOLDER, {}, run);
    expect(result.state).toBe("skipped_untracked");
    expect(result.error).toContain("AUTO_MIGRATE_BASELINE");
    expect(run).not.toHaveBeenCalled();
    expect(calls.some((c) => /^(CREATE|INSERT)/.test(c.sql))).toBe(false);
    expect(calls.at(-1)?.sql).toBe("SELECT RELEASE_LOCK(?)");
  });

  it("records a baseline with drizzle's hashes, then applies the rest", async () => {
    const { conn, calls } = mockConn({ tables: ["users", "tasks"] });
    const run = vi.fn(async () => undefined);
    const result = await migrateLocked(conn, FOLDER, { AUTO_MIGRATE_BASELINE: tag("0014").tag }, run);
    const inserts = calls.filter((c) => c.sql.startsWith("INSERT INTO"));
    expect(inserts.map((c) => c.values)).toEqual(journal.slice(0, 15).map((e) => [migrationHash(FOLDER, e.tag), e.when]));
    expect(calls.some((c) => c.sql.startsWith("CREATE TABLE IF NOT EXISTS `__drizzle_migrations`"))).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(result.state).toBe("applied");
    expect(result.applied[0]).toBe(tag("0015").tag);
  });

  it("does not migrate without the lock", async () => {
    const { conn } = mockConn({ lock: 0 });
    const run = vi.fn(async () => undefined);
    expect((await migrateLocked(conn, FOLDER, {}, run)).state).toBe("failed");
    expect(run).not.toHaveBeenCalled();
  });

  it("reports which migration failed and releases the lock", async () => {
    const { conn, calls, db } = mockConn({ tables: ["users", "__drizzle_migrations"], lastAppliedAt: tag("0014").when });
    const result = await migrateLocked(conn, FOLDER, {}, async () => {
      db.lastAppliedAt = tag("0016").when;
      throw new Error("Duplicate column name 'x'");
    });
    expect(result).toEqual({
      state: "failed",
      latest: tag("0016").tag,
      applied: [tag("0015").tag, tag("0016").tag],
      error: `${tag("0017").tag} failed: Duplicate column name 'x'`,
    });
    expect(calls.at(-1)?.sql).toBe("SELECT RELEASE_LOCK(?)");
  });
});

describe("runAutoMigrate", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is off with AUTO_MIGRATE=0 and without DATABASE_URL", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await runAutoMigrate({ AUTO_MIGRATE: "0", DATABASE_URL: "mysql://u:p@db/x" })).state).toBe("disabled");
    expect(getMigrationStatus().state).toBe("disabled");
    expect((await runAutoMigrate({})).state).toBe("no_database");
    expect(getMigrationStatus().state).toBe("no_database");
  });
});

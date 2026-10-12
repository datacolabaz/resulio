import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DRIZZLE = join(__dirname, "..", "drizzle");
const MAX_IDENTIFIER = 64;

/** Every backticked name in a migration: tables, columns, indexes, constraints. */
function longIdentifiers(sql: string, max = MAX_IDENTIFIER): string[] {
  return [...sql.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((name) => name.length > max);
}

describe("migration identifiers", () => {
  it("flags names over 64 characters", () => {
    expect(longIdentifiers("CONSTRAINT `student_topic_mastery_workspaceId_studentId_dimension_topicKey_pk` PRIMARY KEY")).toHaveLength(1);
    expect(longIdentifiers("CREATE TABLE IF NOT EXISTS `coach_events` (`id` bigint)")).toEqual([]);
  });

  it("keeps every name in drizzle/*.sql within MySQL's 64 characters", () => {
    const hits = readdirSync(DRIZZLE)
      .filter((f) => f.endsWith(".sql"))
      .flatMap((f) => longIdentifiers(readFileSync(join(DRIZZLE, f), "utf8")).map((n) => `${f}: ${n}`));
    expect(hits).toEqual([]);
  });

  it("keeps the generated names of the latest snapshot within 64 characters", () => {
    const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta", "_journal.json"), "utf8")) as { entries: { idx: number }[] };
    const last = journal.entries.at(-1)!;
    const snapshot = JSON.parse(readFileSync(join(DRIZZLE, "meta", `${String(last.idx).padStart(4, "0")}_snapshot.json`), "utf8")) as {
      tables: Record<string, { indexes: object; compositePrimaryKeys: object; uniqueConstraints: object; columns: object }>;
    };
    const hits = Object.entries(snapshot.tables).flatMap(([table, t]) =>
      [table, ...Object.keys(t.indexes), ...Object.keys(t.compositePrimaryKeys), ...Object.keys(t.uniqueConstraints), ...Object.keys(t.columns)]
        .filter((n) => n.length > MAX_IDENTIFIER)
        .map((n) => `${table}.${n}`),
    );
    expect(hits).toEqual([]);
  });
});

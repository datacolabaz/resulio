// Compares a live MySQL schema with the latest drizzle snapshot.
// Usage: node scripts/inspect-schema.mjs <mysql-url> [--expect-legacy] [--snapshot drizzle/meta/0002_snapshot.json]
// Tables named _rollback_* (left by docs/migrations/*-rollback.sql) are reported but not compared.
// Refuses to connect to anything other than a local host unless ALLOW_REMOTE_SCHEMA_INSPECT=1.
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/inspect-schema.mjs <mysql-url> [--expect-legacy]");
  process.exit(2);
}
const parsed = new URL(url);
if (!["127.0.0.1", "localhost"].includes(parsed.hostname) && process.env.ALLOW_REMOTE_SCHEMA_INSPECT !== "1") {
  console.error(`Refusing non-local host ${parsed.hostname}`);
  process.exit(2);
}
const dbName = parsed.pathname.slice(1);
const expectLegacy = process.argv.includes("--expect-legacy");
const LEGACY = "_legacy_user_roles_0002";

const dir = path.resolve("drizzle");
const journal = JSON.parse(fs.readFileSync(path.join(dir, "meta/_journal.json"), "utf8"));
const snapshotArg = process.argv.indexOf("--snapshot");
const snapshotPath =
  snapshotArg > 0
    ? path.resolve(process.argv[snapshotArg + 1])
    : path.join(dir, `meta/${String(journal.entries.at(-1).idx).padStart(4, "0")}_snapshot.json`);
const last = { tag: path.basename(snapshotPath, ".json") };
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));

const conn = await mysql.createConnection(url);
const q = async (sql) => (await conn.query(sql, [dbName]))[0];

const tables = (await q("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'")).map((r) => r.t);
const columns = await q(
  "SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE type, IS_NULLABLE nullable, COLUMN_DEFAULT def, EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?",
);
const stats = await q(
  "SELECT TABLE_NAME t, INDEX_NAME i, NON_UNIQUE nu, SEQ_IN_INDEX seq, COLUMN_NAME c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY t, i, seq",
);
const fks = await q(
  "SELECT TABLE_NAME t, CONSTRAINT_NAME n, REFERENCED_TABLE_NAME rt FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?",
);
const [{ engineCount }] = await q("SELECT COUNT(*) engineCount FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND ENGINE <> 'InnoDB'");
const migrations = (await conn.query("SELECT COUNT(*) n FROM __drizzle_migrations").catch(() => [[{ n: null }]]))[0][0].n;
await conn.end();

const problems = [];
const rollbackLeftovers = tables.filter((t) => t.startsWith("_rollback_"));
const ignored = new Set(["__drizzle_migrations", LEGACY, ...rollbackLeftovers]);
const live = tables.filter((t) => !ignored.has(t)).sort();
const expected = Object.keys(snapshot.tables).sort();
for (const t of expected) if (!live.includes(t)) problems.push(`missing table ${t}`);
for (const t of live) if (!expected.includes(t)) problems.push(`unexpected table ${t}`);
if (expectLegacy && !tables.includes(LEGACY)) problems.push(`missing backup table ${LEGACY}`);

const normDefault = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v);
  if (/^\(?(now\(\)|CURRENT_TIMESTAMP)\)?$/i.test(s)) return "CURRENT_TIMESTAMP";
  if (s === "true") return "1";
  if (s === "false") return "0";
  return s.replace(/^'(.*)'$/, "$1");
};
const normType = (t) => (t === "boolean" ? "tinyint(1)" : t.toLowerCase());

let columnCount = 0;
for (const t of expected) {
  const e = snapshot.tables[t];
  const liveCols = new Map(columns.filter((c) => c.t === t).map((c) => [c.c, c]));
  for (const [name, col] of Object.entries(e.columns)) {
    columnCount++;
    const l = liveCols.get(name);
    if (!l) {
      problems.push(`${t}.${name}: missing column`);
      continue;
    }
    liveCols.delete(name);
    if (normType(col.type) !== l.type.toLowerCase()) problems.push(`${t}.${name}: type ${l.type} vs ${col.type}`);
    if ((l.nullable === "NO") !== Boolean(col.notNull || col.primaryKey)) problems.push(`${t}.${name}: nullable ${l.nullable} vs notNull ${col.notNull}`);
    if (normDefault(l.def) !== normDefault(col.default)) problems.push(`${t}.${name}: default ${l.def} vs ${col.default}`);
    if (/auto_increment/i.test(l.extra) !== Boolean(col.autoincrement)) problems.push(`${t}.${name}: auto_increment mismatch`);
    if (/on update/i.test(l.extra) !== Boolean(col.onUpdate)) problems.push(`${t}.${name}: on update mismatch`);
  }
  for (const extra of liveCols.keys()) problems.push(`${t}.${extra}: column not in snapshot`);

  const idx = {};
  for (const s of stats.filter((s) => s.t === t)) {
    idx[s.i] ??= { unique: Number(s.nu) === 0, cols: [] };
    idx[s.i].cols.push(s.c);
  }
  const want = {};
  for (const pk of Object.values(e.compositePrimaryKeys)) want.PRIMARY = { unique: true, cols: pk.columns };
  for (const [name, col] of Object.entries(e.columns)) if (col.primaryKey) want.PRIMARY = { unique: true, cols: [name] };
  for (const u of Object.values(e.uniqueConstraints)) want[u.name] = { unique: true, cols: u.columns };
  for (const i of Object.values(e.indexes)) want[i.name] = { unique: Boolean(i.isUnique), cols: i.columns };
  for (const name of new Set([...Object.keys(idx), ...Object.keys(want)])) {
    const a = idx[name];
    const b = want[name];
    if (!a || !b) problems.push(`${t}: index ${name} ${a ? "not in snapshot" : "missing"}`);
    else if (a.unique !== b.unique || a.cols.join() !== b.cols.join())
      problems.push(`${t}: index ${name} ${a.unique ? "UNIQUE " : ""}(${a.cols}) vs ${b.unique ? "UNIQUE " : ""}(${b.cols})`);
  }
  const wantFks = Object.keys(e.foreignKeys ?? {}).length;
  const liveFks = fks.filter((f) => f.t === t).length;
  if (wantFks !== liveFks) problems.push(`${t}: ${liveFks} foreign keys vs ${wantFks} in snapshot`);
}
if (Number(engineCount) > 0) problems.push(`${engineCount} non-InnoDB tables`);

const indexCount = new Set(stats.filter((s) => !ignored.has(s.t)).map((s) => `${s.t}.${s.i}`)).size;
console.log(`Database ${dbName}: ${live.length} tables, ${columnCount} columns, ${indexCount} indexes (incl. PK), ${fks.length} foreign keys, ${migrations ?? "?"} applied migrations`);
console.log(`Backup table ${LEGACY}: ${tables.includes(LEGACY) ? "present" : "absent"}`);
if (rollbackLeftovers.length) console.log(`Rollback copies (not compared): ${rollbackLeftovers.join(", ")}`);
if (problems.length) {
  console.log(`MISMATCHES (${problems.length}):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`OK: live schema matches snapshot ${last.tag}`);

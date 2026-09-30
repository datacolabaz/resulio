const fs = require("fs");
const path = require("path");

const dir = path.resolve(process.argv[2] || "drizzle");
const IGNORED_TABLES = new Set(["_legacy_user_roles_0002"]);
const journal = JSON.parse(fs.readFileSync(path.join(dir, "meta/_journal.json"), "utf8"));
const last = journal.entries[journal.entries.length - 1];
const snapshot = JSON.parse(fs.readFileSync(path.join(dir, `meta/${String(last.idx).padStart(4, "0")}_snapshot.json`), "utf8"));

const tables = {};
const unq = s => s.replace(/`/g, "");
const cols = s => s.split(",").map(c => unq(c.trim()));

function parseColumn(line) {
  const m = line.match(/^`([^`]+)`\s+(.*)$/);
  const name = m[1];
  let rest = m[2];
  const typeMatch = rest.match(/^(enum\((?:'[^']*',?)+\)|[a-z]+(?:\([^)]*\))?(?: unsigned)?)/i);
  const type = typeMatch[1];
  rest = rest.slice(type.length);
  const def = rest.match(/DEFAULT\s+(\([^)]*\)\)?|'[^']*'|\S+)/);
  let defaultValue;
  if (def) defaultValue = def[1].replace(/,$/, "");
  return {
    name,
    type,
    notNull: /NOT NULL/.test(rest),
    autoincrement: /AUTO_INCREMENT/.test(rest),
    default: defaultValue,
    onUpdate: /ON UPDATE/.test(rest),
  };
}

function apply(stmt) {
  const s = stmt.trim().replace(/;$/, "");
  if (!s) return;
  if (/^(INSERT|UPDATE|DELETE|SET)\b/i.test(s)) return;
  let m;
  if ((m = s.match(/^CREATE TABLE (?:IF NOT EXISTS )?`([^`]+)` \(([\s\S]*)\)$/))) {
    const t = { columns: {}, pk: null, unique: {}, indexes: {} };
    for (const raw of m[2].split("\n")) {
      const line = raw.trim().replace(/,$/, "");
      if (!line) continue;
      let c;
      if ((c = line.match(/^CONSTRAINT `([^`]+)` PRIMARY KEY\((.*)\)$/))) t.pk = cols(c[2]).join(",");
      else if ((c = line.match(/^CONSTRAINT `([^`]+)` UNIQUE\((.*)\)$/))) t.unique[c[1]] = cols(c[2]).join(",");
      else if (line.startsWith("`")) {
        const col = parseColumn(line);
        t.columns[col.name] = col;
      } else throw new Error(`Unparsed CREATE TABLE line: ${line}`);
    }
    tables[m[1]] = t;
    return;
  }
  if ((m = s.match(/^CREATE (UNIQUE )?INDEX `([^`]+)` ON `([^`]+)` \((.*)\)$/))) {
    const t = tables[m[3]];
    if (m[1]) t.unique[m[2]] = cols(m[4]).join(",");
    else t.indexes[m[2]] = cols(m[4]).join(",");
    return;
  }
  if ((m = s.match(/^ALTER TABLE `([^`]+)` ADD (`[\s\S]*)$/))) {
    const col = parseColumn(m[2]);
    tables[m[1]].columns[col.name] = col;
    return;
  }
  if ((m = s.match(/^ALTER TABLE `([^`]+)` MODIFY COLUMN (`[\s\S]*)$/))) {
    const col = parseColumn(m[2]);
    if (!tables[m[1]].columns[col.name]) throw new Error(`MODIFY missing column ${m[1]}.${col.name}`);
    tables[m[1]].columns[col.name] = col;
    return;
  }
  if ((m = s.match(/^ALTER TABLE `([^`]+)` DROP COLUMN `([^`]+)`$/))) {
    if (!tables[m[1]].columns[m[2]]) throw new Error(`DROP missing column ${m[1]}.${m[2]}`);
    delete tables[m[1]].columns[m[2]];
    return;
  }
  if ((m = s.match(/^DROP TABLE `([^`]+)`$/))) {
    delete tables[m[1]];
    return;
  }
  throw new Error(`Unparsed statement: ${s.slice(0, 120)}`);
}

for (const entry of journal.entries) {
  const sql = fs.readFileSync(path.join(dir, `${entry.tag}.sql`), "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) apply(stmt);
}

const problems = [];
const norm = v => (v === undefined ? undefined : String(v));
const replayed = Object.keys(tables).filter(t => !IGNORED_TABLES.has(t)).sort();
const expected = Object.keys(snapshot.tables).sort();
if (replayed.join() !== expected.join()) problems.push(`tables differ:\n  replay   ${replayed}\n  snapshot ${expected}`);

for (const name of expected) {
  const t = tables[name];
  const e = snapshot.tables[name];
  if (!t) continue;
  const ec = e.columns;
  const names = new Set([...Object.keys(ec), ...Object.keys(t.columns)]);
  for (const c of names) {
    const a = t.columns[c];
    const b = ec[c];
    if (!a || !b) { problems.push(`${name}.${c}: ${a ? "not in snapshot" : "missing in replay"}`); continue; }
    if (a.type !== b.type) problems.push(`${name}.${c}: type ${a.type} vs ${b.type}`);
    if (a.notNull !== b.notNull) problems.push(`${name}.${c}: notNull ${a.notNull} vs ${b.notNull}`);
    if (a.autoincrement !== b.autoincrement) problems.push(`${name}.${c}: autoincrement ${a.autoincrement} vs ${b.autoincrement}`);
    if (norm(a.default) !== norm(b.default)) problems.push(`${name}.${c}: default ${a.default} vs ${b.default}`);
    if (a.onUpdate !== Boolean(b.onUpdate)) problems.push(`${name}.${c}: onUpdate ${a.onUpdate} vs ${Boolean(b.onUpdate)}`);
  }
  const pk = Object.values(e.compositePrimaryKeys).map(p => p.columns.join(","))[0] ?? null;
  if (t.pk !== pk) problems.push(`${name}: primary key ${t.pk} vs ${pk}`);
  const eu = {};
  for (const u of Object.values(e.uniqueConstraints)) eu[u.name] = u.columns.join(",");
  const ei = {};
  for (const i of Object.values(e.indexes)) (i.isUnique ? eu : ei)[i.name] = i.columns.join(",");
  const cmp = (label, got, want) => {
    for (const k of new Set([...Object.keys(got), ...Object.keys(want)]))
      if (got[k] !== want[k]) problems.push(`${name}: ${label} ${k} ${got[k]} vs ${want[k]}`);
  };
  cmp("unique", t.unique, eu);
  cmp("index", t.indexes, ei);
}

console.log(`Replayed ${journal.entries.length} migrations -> ${replayed.length} tables (ignored: ${[...IGNORED_TABLES].filter(t => tables[t]).join(", ") || "none"})`);
console.log(`Snapshot ${last.tag}: id ${snapshot.id}, prevId ${snapshot.prevId}`);
if (problems.length) {
  console.log(`MISMATCHES (${problems.length}):\n` + problems.join("\n"));
  process.exit(1);
}
console.log("OK: replayed schema matches snapshot (columns, types, nullability, defaults, PKs, unique keys, indexes)");

// Full migration rehearsal on a disposable local MySQL:
//   0000+0001 → seed legacy users → 0002 (+ runbook reconciliation D1–D8) → seed 0002-era exam data →
//   mysqldump backup → 0003 (+ backfill checks, schema inspection) → restore backup into a second database →
//   0003 down script → re-apply 0003 → 0002 down script on the restored copy → re-apply 0002+0003 →
//   0004 (role rename) → append-only audit triggers → 0004 down script → re-apply 0004 → half-applied 0004
//   recovered from a backup.
// Every section of docs/migrations/legacy-audit-queries.sql is executed at its stage, then against planted
// defects; the output is written to docs/verification/legacy-audit-rehearsal.json.
//
// Usage: REHEARSAL_MYSQL_URL=mysql://user:pass@127.0.0.1:3307/ MYSQL_BIN=<dir with mysqldump/mysql> \
//        node scripts/migration-rehearsal.mjs
// Only local hosts; only databases named resulio_rh_*_test are created or dropped.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";

const base = new URL(process.env.REHEARSAL_MYSQL_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(base.hostname)) {
  console.error("REHEARSAL_MYSQL_URL must point to a local MySQL (127.0.0.1/localhost)");
  process.exit(2);
}
const MAIN = "resulio_rh_main_test";
const RESTORE = "resulio_rh_restore_test";
const bin = (name) => path.join(process.env.MYSQL_BIN ?? "", process.platform === "win32" ? `${name}.exe` : name);
const drizzleDir = path.resolve("drizzle");
const journal = JSON.parse(fs.readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "resulio-rehearsal-"));
const urlFor = (db) => Object.assign(new URL(base.href), { pathname: `/${db}` }).href;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function connect(db) {
  const conn = await mysql.createConnection({ uri: urlFor(db), timezone: "Z", multipleStatements: true });
  await conn.query("SET time_zone = '+00:00'");
  return conn;
}
async function rows(conn, sql, params = []) {
  return (await conn.query(sql, params))[0];
}
async function recreate(db) {
  const conn = await mysql.createConnection({ uri: base.href });
  await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
  await conn.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await conn.end();
}
/** Applies journal entries [0, n) with the real drizzle migrator (idempotent for already-applied ones). */
async function applyUpTo(db, n) {
  const dir = path.join(work, `m${n}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
    const entries = journal.entries.slice(0, n);
    for (const e of entries) fs.copyFileSync(path.join(drizzleDir, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
    fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  }
  const conn = await connect(db);
  try {
    await migrate(drizzle(conn), { migrationsFolder: dir });
  } finally {
    await conn.end();
  }
}
function inspect(db, ...args) {
  const r = spawnSync(process.execPath, ["scripts/inspect-schema.mjs", urlFor(db), ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout + r.stderr).trim().split(/\r?\n/).at(-1) };
}
const childEnv = () => ({ ...process.env, MYSQL_PWD: decodeURIComponent(base.password) });
const clientArgs = () => [`--host=${base.hostname}`, `--port=${base.port || 3306}`, `--user=${decodeURIComponent(base.username)}`];
function dump(db, file) {
  const r = spawnSync(
    bin("mysqldump"),
    [...clientArgs(), "--single-transaction", "--routines", "--triggers", "--hex-blob", "--set-gtid-purged=OFF", "--default-character-set=utf8mb4", `--result-file=${file}`, db],
    { env: childEnv(), encoding: "utf8" },
  );
  return r.status === 0 ? null : r.stderr;
}
function restore(db, file) {
  return new Promise((resolve) => {
    const p = spawn(bin("mysql"), [...clientArgs(), "--default-character-set=utf8mb4", db], { env: childEnv() });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    fs.createReadStream(file).pipe(p.stdin);
    p.on("close", (code) => resolve(code === 0 ? null : err));
  });
}
async function tableCounts(conn) {
  const tables = (await rows(conn, "SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY t")).map((r) => r.t);
  const out = {};
  for (const t of tables) out[t] = Number((await rows(conn, `SELECT COUNT(*) n FROM \`${t}\``))[0].n);
  return out;
}
const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Parses docs/migrations/legacy-audit-queries.sql into { section, id, title, sql } (skips @template blocks). */
function parseAuditPack(file) {
  const queries = [];
  let section = null;
  let current = null;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const sec = line.match(/^-- @section (\S+)/);
    const q = line.match(/^-- @query (\S+) \| (.*)$/);
    if (sec || q || line.startsWith("-- @template")) current = null;
    if (sec) section = sec[1];
    if (q) queries.push((current = { section, id: q[1], title: q[2], sql: "" }));
    else if (current && !line.startsWith("--")) current.sql += `${line}\n`;
  }
  return queries.map((q) => ({ ...q, sql: q.sql.trim().replace(/;$/, "") }));
}
const auditPack = parseAuditPack("docs/migrations/legacy-audit-queries.sql");
const auditLog = {};
/** Runs every query of one audit-pack section; returns { id: rows[] } and records the output. */
async function runAudit(conn, stage, ...sections) {
  const out = {};
  const errors = [];
  for (const q of auditPack.filter((x) => sections.includes(x.section))) {
    try {
      const [r] = await conn.query(q.sql);
      out[q.id] = Array.isArray(r) ? r : [];
    } catch (e) {
      errors.push(`${q.id}: ${e.message}`);
    }
  }
  auditLog[stage] = Object.fromEntries(Object.entries(out).map(([id, r]) => [id, { rows: r.length, result: r.slice(0, 20) }]));
  check(`Audit pack [${sections.join(" + ")}] executes (${stage})`, errors.length === 0, errors.join("; ") || `${Object.keys(out).length} queries`);
  return out;
}
const num = (v) => Number(v ?? 0);

// ---------------------------------------------------------------------------------------------------------
console.log(`MySQL ${base.host}, work dir ${work}\n`);
await recreate(MAIN);

// 1. Pre-0002 production shape.
await applyUpTo(MAIN, 2);
let db = await connect(MAIN);
check("A1 pre-0002 tables are exactly users + __drizzle_migrations", JSON.stringify(Object.keys(await tableCounts(db))) === '["__drizzle_migrations","users"]');
check("A3 two migrations applied", Number((await rows(db, "SELECT COUNT(*) n FROM __drizzle_migrations"))[0].n) === 2);

const longName = "Ə".repeat(400);
const legacyUsers = [
  [1, "Aysel Müəllim", "aysel@example.test", "user", "TEACHER", "google"],
  [2, "", "empty-name@example.test", "user", "TEACHER", "google"],
  [3, null, null, "user", "TEACHER", "manus"],
  [4, "Admin", "admin@example.test", "admin", null, "google"],
  [5, "Tələbə Bir", "s1@example.test", "user", "STUDENT", "google"],
  [6, "Tələbə İki", "s2@example.test", "user", "STUDENT", "google"],
  [7, "Admin Müəllim", "admin-teacher@example.test", "admin", "TEACHER", "google"],
  [8, longName, "long@example.test", "user", "TEACHER", "google"],
  [9, "Tələbə Üç", "s3@example.test", "user", "STUDENT", "google"],
  [10, "Dup Upper", "Dup@Example.test", "user", null, "manus"],
  [11, "Dup Lower", "dup@example.test", "user", "STUDENT", "google"],
  [12, "Demo Teacher", "demo@example.test", "user", "TEACHER", "demo"],
];
for (const [id, name, email, role, appRole, loginMethod] of legacyUsers) {
  await db.query("INSERT INTO users (id, openId, name, email, role, appRole, loginMethod) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    id, `legacy_${id}`, name, email, role, appRole, loginMethod,
  ]);
}
const [a4] = await rows(
  db,
  "SELECT COUNT(*) total, SUM(role='admin') admins, SUM(appRole='TEACHER') teachers, SUM(appRole='STUDENT') students, SUM(appRole IS NULL) no_role FROM users",
);
check("A4 legacy counts recorded", Number(a4.total) === 12, `total ${a4.total}, admins ${a4.admins}, teachers ${a4.teachers}, students ${a4.students}, no appRole ${a4.no_role}`);
const dupEmails = await rows(db, "SELECT LOWER(email) e, COUNT(*) n FROM users WHERE email IS NOT NULL GROUP BY LOWER(email) HAVING COUNT(*) > 1");
check("A7 duplicate-email audit finds the case-variant pair", dupEmails.length === 1 && dupEmails[0].e === "dup@example.test");
let audit = await runAudit(db, "1 legacy users, before 0002", "pre-0002");
const cat = Object.fromEntries((audit.L4 ?? []).map((r) => [r.category.slice(0, 2), num(r.users)]));
check("Audit L1/L2 see the pre-0002 baseline", audit.L1?.length === 2 && audit.L2?.length === 2);
check("Audit L4 classifies teacher signals", cat.T1 === 6 && cat.T2 === 1 && cat.T3 === 1 && cat.T4 === 4, JSON.stringify(cat));
check("Audit L5 lists the admin and the no-appRole user as hidden-teacher candidates", JSON.stringify(audit.L5?.map((r) => r.id).sort((a, b) => a - b)) === "[4,10]");
check("Audit L6/L7 find no unknown ownership tables", audit.L6?.length === 0 && audit.L7?.length === 0);
check("Audit L9 finds the duplicate e-mail pair", audit.L9?.length === 1 && audit.L9[0].user_ids === "10,11");
check("Audit L10 finds teachers needing title fallback/truncation", JSON.stringify(audit.L10?.map((r) => r.id)) === "[2,3,8]");
check("Audit L11 flags the demo-login account", audit.L11?.some((r) => r.id === 12));
check("Audit L12 workspace id fits varchar(32)", num(audit.L12?.[0]?.max_workspace_id_length) <= 32);
await db.end();

// 2. Migration 0002 on legacy data + runbook reconciliation.
await applyUpTo(MAIN, 3);
db = await connect(MAIN);
check("D1 user count unchanged", Number((await rows(db, "SELECT COUNT(*) n FROM users"))[0].n) === 12);
check(
  "D2 every legacy teacher has its ws_legacy workspace",
  (await rows(db, "SELECT l.userId FROM _legacy_user_roles_0002 l LEFT JOIN provider_workspaces w ON w.id = CONCAT('ws_legacy_', l.userId) AND w.ownerUserId = l.userId WHERE l.appRole = 'TEACHER' AND w.id IS NULL")).length === 0,
);
check(
  "D3 no workspace for non-teachers, none without owner",
  (await rows(db, "SELECT w.id FROM provider_workspaces w JOIN _legacy_user_roles_0002 l ON l.userId = w.ownerUserId WHERE w.id LIKE 'ws\\_legacy\\_%' AND (l.appRole IS NULL OR l.appRole <> 'TEACHER')")).length === 0 &&
    (await rows(db, "SELECT w.id FROM provider_workspaces w LEFT JOIN users u ON u.id = w.ownerUserId WHERE u.id IS NULL")).length === 0,
);
const [d4] = await rows(db, "SELECT (SELECT COUNT(*) FROM _legacy_user_roles_0002 WHERE role='admin') legacy, (SELECT COUNT(*) FROM platform_roles WHERE role='ADMIN') platform");
check("D4 admins carried over", Number(d4.legacy) === 2 && Number(d4.platform) === 2, `${d4.legacy} → ${d4.platform}`);
const [d5] = await rows(db, "SELECT (SELECT COUNT(*) FROM _legacy_user_roles_0002 WHERE appRole='TEACHER') teachers, (SELECT COUNT(*) FROM users WHERE lastActiveContext='teaching') teaching");
check("D5 teaching context only for legacy teachers", Number(d5.teachers) === 6 && Number(d5.teaching) === 6, `${d5.teachers} teachers, ${d5.teaching} teaching`);
const d6 = (await rows(db, "SELECT column_name c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name IN ('role','appRole','avatarUrl','lastActiveContext') ORDER BY c")).map((r) => r.c);
check("D6 legacy role columns dropped, new columns present", JSON.stringify(d6) === '["avatarUrl","lastActiveContext"]', d6.join(","));
check("D7 three migrations applied", Number((await rows(db, "SELECT COUNT(*) n FROM __drizzle_migrations"))[0].n) === 3);
const legacyCopy = await rows(db, "SELECT userId, role, appRole FROM _legacy_user_roles_0002 ORDER BY userId");
check(
  "Backup table holds every legacy role",
  legacyCopy.length === 12 && legacyCopy.every((r, i) => r.role === legacyUsers[i][3] && (r.appRole ?? null) === legacyUsers[i][4]),
);
const titles = Object.fromEntries((await rows(db, "SELECT id, title, CHAR_LENGTH(title) len FROM provider_workspaces")).map((r) => [r.id, r]));
check("Workspace title falls back to email for an empty name", titles.ws_legacy_2?.title === "empty-name@example.test");
check("Workspace title falls back to 'Tədris məkanı' (utf8mb4 intact)", titles.ws_legacy_3?.title === "Tədris məkanı");
check("Workspace title of a 400-char name is truncated to 255", titles.ws_legacy_8?.len === 255);
check("Demo-login legacy teacher also gets a workspace (review in audit)", Boolean(titles.ws_legacy_12));

// 3. 0002-era exam data.
const settings = JSON.stringify({ title: "Legacy exam", description: "", instructions: "", subject: "", durationSeconds: 2700, attemptsAllowed: 2, randomize: false, releaseMode: "IMMEDIATE", reviewMode: "FULL", showCorrectAnswers: false, showExplanations: false });
const mc = (c) => [JSON.stringify({ options: [{ key: "a", text: "A" }, { key: "b", text: "B" }] }), JSON.stringify({ correct: c })];
await db.query(
  `INSERT INTO study_groups (id, providerWorkspaceId, name, inviteCode) VALUES ('g1', 'ws_legacy_1', 'Qrup 1', 'INV00001');
   INSERT INTO group_members (groupId, userId, status) VALUES ('g1', 5, 'ACTIVE'), ('g1', 6, 'ACTIVE'), ('g1', 9, 'ACTIVE');
   INSERT INTO assessments (id, providerWorkspaceId, createdBy, type, status, settings, shareCode, currentVersionId, hasDraftChanges)
     VALUES ('as1', 'ws_legacy_1', 1, 'EXAM', 'PUBLISHED', ?, 'SHARE0001', 'v1', false);
   INSERT INTO assessment_versions (id, assessmentId, versionNo, settings, publishedBy) VALUES ('v1', 'as1', 1, ?, 1);
   INSERT INTO version_questions (id, versionId, position, type, text, points, difficulty, content, answerKey) VALUES
     ('vq1', 'v1', 1, 'MULTIPLE_CHOICE', 'Q1', 1, 'MEDIUM', ?, ?),
     ('vq2', 'v1', 2, 'MULTIPLE_CHOICE', 'Q2', 1, 'MEDIUM', ?, ?),
     ('vq3', 'v1', 3, 'MULTIPLE_CHOICE', 'Q3', 1, 'MEDIUM', ?, ?);
   INSERT INTO assessment_assignments (id, assessmentId, assessmentVersionId, groupId, assignedBy) VALUES (1, 'as1', 'v1', 'g1', 1);
   INSERT INTO attempts (id, assessmentId, versionId, assignmentId, studentId, attemptNo, status, questionOrder, startedAt, deadlineAt, submittedAt) VALUES
     ('t1', 'as1', 'v1', 1, 5, 1, 'SUBMITTED',      '["vq1","vq2","vq3"]', '2026-09-01 10:00:00', '2026-09-01 10:45:00', '2026-09-01 10:20:00'),
     ('t4', 'as1', 'v1', 1, 5, 2, 'IN_PROGRESS',    '["vq3","vq1","vq2"]', '2026-09-02 10:00:00', '2037-12-31 00:00:00', NULL),
     ('t2', 'as1', 'v1', 1, 6, 1, 'IN_PROGRESS',    '["vq1","vq2","vq3"]', '2026-09-03 09:00:00', '2037-12-31 00:00:00', NULL),
     ('t3', 'as1', 'v1', 1, 9, 1, 'AUTO_SUBMITTED', '["vq2","vq3","vq1"]', '2026-09-04 09:00:00', '2026-09-04 09:45:00', '2026-09-04 09:45:00');
   INSERT INTO student_answers (attemptId, versionQuestionId, answer) VALUES
     ('t1', 'vq1', CAST('"a"' AS JSON)), ('t1', 'vq2', CAST('""' AS JSON)), ('t1', 'vq3', CAST('null' AS JSON)),
     ('t2', 'vq1', CAST('["x"]' AS JSON)), ('t2', 'vq2', CAST('[]' AS JSON)), ('t2', 'vq3', NULL),
     ('t3', 'vq1', CAST('{"l1":"r1"}' AS JSON)), ('t3', 'vq2', CAST('{}' AS JSON));
   INSERT INTO results (id, attemptId, assessmentId, versionId, studentId, totalPoints, earnedPoints, percentage, correctCount, wrongCount, unansweredCount, durationSeconds, completedAt) VALUES
     ('r1', 't1', 'as1', 'v1', 5, 3, 1, 33.3, 1, 0, 2, 1200, '2026-09-01 10:20:00'),
     ('r3', 't3', 'as1', 'v1', 9, 3, 0, 0, 0, 1, 2, 2700, '2026-09-04 09:45:00');`,
  [settings, settings, ...mc("a"), ...mc("b"), ...mc("a")],
);
const pre0003 = await tableCounts(db);
audit = await runAudit(db, "3 0002-era data, before 0003", "post-0002", "pre-0003");
const empty = (...ids) => ids.filter((id) => audit[id]?.length !== 0);
check("Audit M2-M10 find no integrity problems in clean 0002 data", empty("M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10").length === 0, empty("M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10").join(",") || "all empty");
check("Audit M11 flags the far-future deadlines", num(audit.M11?.find((r) => r.col === "attempts.deadlineAt")?.near_limit) === 2);
check("Audit Q2 has only pre-0003 statuses", audit.Q2?.every((r) => ["IN_PROGRESS", "SUBMITTED", "AUTO_SUBMITTED"].includes(r.status)));
check("Audit Q3 finds no stale open attempts", num(audit.Q3?.[0]?.stale_open_attempts) === 0);
const q4 = audit.Q4?.[0] ?? {};
check("Audit Q4 counts ignored answer shapes", [q4.sql_null, q4.json_null, q4.empty_string, q4.empty_array, q4.empty_object].every((v) => num(v) === 1) && num(q4.total_answers) === 8);
check("Audit Q5 finds no unusable questionOrder", audit.Q5?.length === 0);
const baselineQ1 = JSON.stringify(audit.Q1?.[0]);
await db.end();

// 4. Backup before 0003.
const backup = path.join(work, "pre-0003.sql");
const dumpError = dump(MAIN, backup);
check("mysqldump backup before 0003", !dumpError && fs.statSync(backup).size > 0, dumpError ?? `${fs.statSync(backup).size} bytes`);

// 5. Migration 0003 with backfill.
await applyUpTo(MAIN, 4);
db = await connect(MAIN);
audit = await runAudit(db, "5 right after 0003", "post-0002", "post-0003");
const zeros = (row) => Object.entries(row ?? {}).filter(([k]) => !["attempts", "student_assessment_pairs", "progress_rows"].includes(k)).every(([, v]) => num(v) === 0);
check("Audit R1 journal has 4 rows ending with 0003", num(audit.R1?.[0]?.journal_rows) === 4 && String(audit.R1[0].last_created_at) === String(journal.entries[3].when));
check("Audit R2 row counts equal the Q1 baseline", JSON.stringify(audit.R2?.[0]) === baselineQ1, JSON.stringify(audit.R2?.[0]));
check("Audit R3 attempt backfill has no mismatches", zeros(audit.R3?.[0]) && num(audit.R3[0].attempts) === 4, JSON.stringify(audit.R3?.[0]));
check("Audit R4 progress matches attempts", zeros(audit.R4?.[0]) && num(audit.R4[0].progress_rows) === num(audit.R4[0].student_assessment_pairs), JSON.stringify(audit.R4?.[0]));
check("Audit R5 defaults applied", zeros(audit.R5?.[0]));
check("Audit R6 enum has the new statuses", audit.R6?.[0]?.attempts_status_type === "enum('IN_PROGRESS','SUBMITTED','AUTO_SUBMITTED','EXPIRED_NO_ANSWERS','VOIDED')", audit.R6?.[0]?.attempts_status_type);
check("Audit R7 finds the 5 new indexes", audit.R7?.length === 5);
check("Audit R8 finds no orphans in new tables; M-section still clean", audit.R8?.length === 0 && empty("M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10").length === 0);
const att = Object.fromEntries((await rows(db, "SELECT * FROM attempts")).map((r) => [r.id, r]));
check("Backfill totalQuestionCount = JSON_LENGTH(questionOrder)", ["t1", "t2", "t3", "t4"].every((id) => att[id].totalQuestionCount === 3));
check(
  "Backfill answeredCount ignores null, JSON null, \"\", [] and {}",
  att.t1.answeredCount === 1 && att.t2.answeredCount === 1 && att.t3.answeredCount === 1 && att.t4.answeredCount === 0,
  `t1 ${att.t1.answeredCount}, t2 ${att.t2.answeredCount}, t3 ${att.t3.answeredCount}, t4 ${att.t4.answeredCount}`,
);
check("Backfill lastActivityAt = submittedAt ?? startedAt", iso(att.t1.lastActivityAt) === "2026-09-01T10:20:00.000Z" && iso(att.t2.lastActivityAt) === "2026-09-03T09:00:00.000Z");
check("Backfill autoSubmittedAt only for AUTO_SUBMITTED", iso(att.t3.autoSubmittedAt) === "2026-09-04T09:45:00.000Z" && att.t1.autoSubmittedAt === null);
check("New attempt columns default safely", ["t1", "t2", "t3", "t4"].every((id) => att[id].lastHeartbeatAt === null && att[id].voidedAt === null));
const prog = Object.fromEntries((await rows(db, "SELECT * FROM assessment_student_progress")).map((r) => [r.studentId, r]));
check("Backfill one progress row per student and assessment", Object.keys(prog).length === 3);
check(
  "Progress for a student with two attempts",
  prog[5]?.attemptCount === 2 && prog[5].activeAttemptId === "t4" && iso(prog[5].startedAt) === "2026-09-01T10:00:00.000Z" &&
    iso(prog[5].completedAt) === "2026-09-01T10:20:00.000Z" && iso(prog[5].latestActivityAt) === "2026-09-02T10:00:00.000Z" &&
    prog[5].versionId === "v1" && prog[5].assignmentId === 1,
);
check("Progress for an open attempt and an auto-submitted one", prog[6]?.activeAttemptId === "t2" && prog[6].completedAt === null && prog[9]?.activeAttemptId === null && iso(prog[9].completedAt) === "2026-09-04T09:45:00.000Z");
check("Existing assessments get inactivity threshold 10", (await rows(db, "SELECT inactivityThresholdMinutes m FROM assessments"))[0].m === 10);
check("Existing answers get revision 0", (await rows(db, "SELECT COUNT(*) n FROM student_answers WHERE revision <> 0"))[0].n == 0);
check("Enum accepts the new statuses", await db.query("UPDATE attempts SET status = 'EXPIRED_NO_ANSWERS' WHERE id = 't4'").then(() => true, () => false));
check("Enum rejects unknown statuses (strict mode)", await db.query("UPDATE attempts SET status = 'ABANDONED' WHERE id = 't4'").then(() => false, () => true));
await db.query("INSERT INTO student_activity_events (userId, providerWorkspaceId, entityType, entityId, eventType) VALUES (5, 'ws_legacy_1', 'ASSESSMENT', 'as1', 'ASSESSMENT_EXPIRED')");
check("Progress unique key rejects a duplicate row", await db.query("INSERT INTO assessment_student_progress (assessmentId, studentId) VALUES ('as1', 5)").then(() => false, (e) => e.code === "ER_DUP_ENTRY"));
check("Result unique key rejects a second result per attempt", await db.query("INSERT INTO results (id, attemptId, assessmentId, versionId, studentId, totalPoints, earnedPoints, percentage, correctCount, wrongCount, unansweredCount, durationSeconds, completedAt) VALUES ('r1b', 't1', 'as1', 'v1', 5, 3, 3, 100, 3, 0, 0, 1, NOW())").then(() => false, (e) => e.code === "ER_DUP_ENTRY"));
const SNAP_0003 = ["--snapshot", "drizzle/meta/0003_snapshot.json"];
let s = inspect(MAIN, "--expect-legacy", ...SNAP_0003);
check("Schema after 0003 matches 0003 snapshot", s.ok, s.out);
await db.end();

// 6. Restore the pre-0003 backup into a second database.
await recreate(RESTORE);
const restoreError = await restore(RESTORE, backup);
check("Backup restores into a scratch database", !restoreError, restoreError ?? "");
db = await connect(RESTORE);
const restored = await tableCounts(db);
check("Restored row counts equal pre-0003 counts", JSON.stringify(restored) === JSON.stringify(pre0003), Object.entries(restored).map(([t, n]) => `${t}=${n}`).join(" "));
await db.end();
s = inspect(RESTORE, "--expect-legacy", "--snapshot", "drizzle/meta/0002_snapshot.json");
check("Restored schema matches 0002 snapshot", s.ok, s.out);

// 7. 0003 down script on the migrated database, then forward again.
db = await connect(MAIN);
await db.query(fs.readFileSync("docs/migrations/0003-rollback.sql", "utf8"));
s = inspect(MAIN, "--expect-legacy", "--snapshot", "drizzle/meta/0002_snapshot.json");
check("After 0003 rollback the schema matches 0002 snapshot", s.ok, s.out);
const kept = await rows(db, "SELECT status FROM _rollback_0003_attempts WHERE id = 't4'");
check("Rollback keeps the original EXPIRED_NO_ANSWERS status in _rollback_0003_attempts", kept[0]?.status === "EXPIRED_NO_ANSWERS");
check("Rollback maps it to AUTO_SUBMITTED for the old code", (await rows(db, "SELECT status FROM attempts WHERE id = 't4'"))[0].status === "AUTO_SUBMITTED");
check("Rollback keeps activity events (renamed table)", Number((await rows(db, "SELECT COUNT(*) n FROM _rollback_0003_student_activity_events"))[0].n) === 1);
check("Rollback removes the 0003 journal row", Number((await rows(db, "SELECT COUNT(*) n FROM __drizzle_migrations"))[0].n) === 3);
check("No answers or results lost by rollback", Number((await rows(db, "SELECT COUNT(*) n FROM student_answers"))[0].n) === 8 && Number((await rows(db, "SELECT COUNT(*) n FROM results"))[0].n) === 2);
await db.end();
await applyUpTo(MAIN, 4);
s = inspect(MAIN, "--expect-legacy", ...SNAP_0003);
check("0003 re-applies cleanly after rollback", s.ok, s.out);

// 8. 0002 down script on the restored copy (pre-0003 state), then forward again.
db = await connect(RESTORE);
await db.query(fs.readFileSync("docs/migrations/0002-rollback.sql", "utf8"));
const afterDown = await rows(db, "SELECT id, role, appRole FROM users ORDER BY id");
check(
  "0002 rollback restores every legacy role exactly",
  afterDown.length === 12 && afterDown.every((r, i) => r.role === legacyUsers[i][3] && (r.appRole ?? null) === legacyUsers[i][4]),
);
check("0002 rollback returns to the pre-0002 table set", JSON.stringify(Object.keys(await tableCounts(db))) === '["__drizzle_migrations","users"]');
check("0002 rollback leaves two journal rows", Number((await rows(db, "SELECT COUNT(*) n FROM __drizzle_migrations"))[0].n) === 2);
await db.end();
await applyUpTo(RESTORE, 4);
s = inspect(RESTORE, "--expect-legacy", ...SNAP_0003);
check("0002 + 0003 re-apply cleanly after full rollback", s.ok, s.out);

// 9. Audit detection: plant known defects in the migrated database and expect the pack to report them.
db = await connect(MAIN);
await db.query(
  `DELETE FROM group_members WHERE groupId = 'g1' AND userId = 9;
   INSERT INTO group_members (groupId, userId, status) VALUES ('g1', 999, 'ACTIVE');
   INSERT INTO provider_workspaces (id, ownerUserId, title) VALUES ('ws_legacy_77', 1, 'Stray copy'), ('ws_dup_10', 10, 'Dup A'), ('ws_dup_11', 11, 'Dup B');
   INSERT INTO assessments (id, providerWorkspaceId, createdBy, type, status, settings, shareCode, hasDraftChanges)
     VALUES ('as_x', 'ws_legacy_1', 6, 'EXAM', 'DRAFT', ?, 'SHARE0002', true);`,
  [settings],
);
audit = await runAudit(db, "9 planted defects", "post-0002", "post-0003");
check("Audit M5 reports the attempt of a student who left the group", audit.M5?.length === 1 && audit.M5[0].attempt_id === "t3" && audit.M5[0].finding.startsWith("LEFT GROUP"));
check("Audit M8 reports the membership of a missing user", audit.M8?.length === 1 && audit.M8[0].relation === "group_members.userId -> users" && num(audit.M8[0].orphans) === 1);
check("Audit M6 reports the stray ws_legacy for owner 1", JSON.stringify(audit.M6?.map((r) => r.id).sort()) === '["ws_legacy_1","ws_legacy_77"]');
check("Audit M7 reports one e-mail owning two workspaces", audit.M7?.length === 1 && audit.M7[0].user_ids === "10,11");
check("Audit M3/M4 report content by a non-owner without workspace", audit.M3?.length === 1 && audit.M3[0].user_id === 6 && audit.M4?.length === 1 && audit.M4[0].id === "as_x");
await db.end();

// 10. Migration 0004 (admin console) on the migrated database: role rename, defaults, append-only triggers,
//     rollback with data kept, re-apply. Then a failure half-way through 0004, recovered from a backup.
const count = async (conn, sql) => Number((await rows(conn, sql))[0].n);
db = await connect(MAIN);
await db.query("INSERT INTO platform_roles (userId, role) VALUES (5, 'SUPPORT')");
await db.query("INSERT INTO partner_profiles (userId, status, referralCode) VALUES (7, 'PENDING', 'RHPARTNER1')");
const users0003 = await count(db, "SELECT COUNT(*) n FROM users");
await db.end();
await applyUpTo(MAIN, 5);
db = await connect(MAIN);
const roleCounts = async () => Object.fromEntries((await rows(db, "SELECT role, COUNT(*) n FROM platform_roles GROUP BY role")).map((r) => [r.role, Number(r.n)]));
let roles = await roleCounts();
check("0004 D4: legacy admins carried over as SUPER_ADMIN, SUPPORT as SUPPORT_ADMIN", JSON.stringify(roles) === '{"SUPER_ADMIN":2,"SUPPORT_ADMIN":1}', JSON.stringify(roles));
const roleType = (await rows(db, "SELECT column_type t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'platform_roles' AND column_name = 'role'"))[0].t;
check("0004 role enum has exactly the five new roles", roleType === "enum('SUPER_ADMIN','SUPPORT_ADMIN','PARTNER_ADMIN','FINANCE_ADMIN','CONTENT_REVIEWER')", roleType);
check("0004 keeps every user and makes them ACTIVE with no revocation", (await count(db, "SELECT COUNT(*) n FROM users")) === users0003 && (await count(db, "SELECT COUNT(*) n FROM users WHERE accountStatus <> 'ACTIVE' OR sessionsValidAfter IS NOT NULL OR suspendedAt IS NOT NULL OR lastSeenAt IS NOT NULL")) === 0);
const svaPrecision = (await rows(db, "SELECT datetime_precision p FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'sessionsValidAfter'"))[0].p;
check("0004 sessionsValidAfter keeps milliseconds (timestamp(3))", Number(svaPrecision) === 3, `precision ${svaPrecision}`);
check("0004 new tables exist and are empty", (await count(db, "SELECT COUNT(*) n FROM audit_logs")) + (await count(db, "SELECT COUNT(*) n FROM security_events")) + (await count(db, "SELECT COUNT(*) n FROM feature_flags")) + (await count(db, "SELECT COUNT(*) n FROM feature_flag_overrides")) === 0);
check("0004 existing partner profile untouched", (await rows(db, "SELECT status FROM partner_profiles WHERE userId = 7"))[0].status === "PENDING");
const j4 = (await rows(db, "SELECT COUNT(*) n, MAX(created_at) last FROM __drizzle_migrations"))[0];
check("0004 journal has 5 rows ending with 0004", Number(j4.n) === 5 && String(j4.last) === String(journal.entries[4].when));
s = inspect(MAIN, "--expect-legacy");
check("Schema after 0004 matches 0004 snapshot", s.ok, s.out);
audit = await runAudit(db, "10 after 0004", "post-0004");
check("Audit S1 journal has 5 rows ending with 0004", num(audit.S1?.[0]?.journal_rows) === 5 && String(audit.S1[0].last_created_at) === String(journal.entries[4].when));
check("Audit S2 shows only renamed roles", JSON.stringify(audit.S2?.map((r) => [r.role, num(r.users)])) === '[["SUPER_ADMIN",2],["SUPPORT_ADMIN",1]]');
check("Audit S3 role enum and timestamp(3)", audit.S3?.[0]?.role_type === roleType && num(audit.S3[0].sessions_valid_after_precision) === 3);
check("Audit S4 no user suspended or revoked", zeros(audit.S4?.[0]));
check("Audit S5 lists the legacy admins for the allowlist review", audit.S5?.filter((r) => r.role === "SUPER_ADMIN").length === 2);
check("Audit S6 finds no triggers before the ops step", audit.S6?.length === 0);

await db.query(
  `UPDATE users SET accountStatus = 'SUSPENDED', suspendedAt = NOW(), sessionsValidAfter = NOW(3) WHERE id = 6;
   UPDATE partner_profiles SET status = 'INFO_REQUESTED', applicationAnswers = '{"audience":"x"}' WHERE userId = 7;
   INSERT INTO platform_roles (userId, role) VALUES (8, 'PARTNER_ADMIN');
   INSERT INTO audit_logs (actorUserId, actorAdminRole, action, targetType, targetId, userId, reason) VALUES (1, 'SUPER_ADMIN', 'USER_SUSPENDED', 'USER', '6', 6, 'Rehearsal suspension');
   INSERT INTO security_events (type, severity) VALUES ('CSRF_REJECTED', 'MEDIUM');`,
);
await db.end();
const triggerError = await restore(MAIN, path.resolve("docs/migrations/audit-append-only-triggers.sql"));
check("Append-only triggers install with the privileged account", !triggerError, triggerError ?? "");
db = await connect(MAIN);
audit = await runAudit(db, "10 after trigger ops step", "post-0004");
check("Audit S6 finds both audit triggers", JSON.stringify(audit.S6?.map((r) => r.trigger_name)) === '["audit_logs_no_delete","audit_logs_no_update"]');
const blocked = (sql) => db.query(sql).then(() => "allowed", (e) => (e.sqlState === "45000" && /append-only/.test(e.message) ? "blocked" : e.message));
check("Trigger blocks UPDATE on audit_logs", (await blocked("UPDATE audit_logs SET reason = 'tampered'")) === "blocked");
check("Trigger blocks DELETE on audit_logs", (await blocked("DELETE FROM audit_logs")) === "blocked");
check("Inserts into audit_logs still work", await db.query("INSERT INTO audit_logs (action, targetType, actorAdminRole) VALUES ('ROLE_GRANTED', 'PLATFORM_ROLE', 'SYSTEM')").then(() => true, () => false));
const auditRows = await count(db, "SELECT COUNT(*) n FROM audit_logs");

await db.query(fs.readFileSync("docs/migrations/0004-rollback.sql", "utf8"));
s = inspect(MAIN, "--expect-legacy", ...SNAP_0003);
check("After 0004 rollback the schema matches 0003 snapshot", s.ok, s.out);
roles = await roleCounts();
check("0004 rollback maps roles back to ADMIN/SUPPORT", JSON.stringify(roles) === '{"ADMIN":2,"SUPPORT":1}', JSON.stringify(roles));
check("0004 rollback keeps the reserved role row in _rollback_0004_platform_roles", (await count(db, "SELECT COUNT(*) n FROM _rollback_0004_platform_roles WHERE role = 'PARTNER_ADMIN' AND userId = 8")) === 1);
check("0004 rollback returns INFO_REQUESTED to PENDING, original kept", (await rows(db, "SELECT status FROM partner_profiles WHERE userId = 7"))[0].status === "PENDING" && (await rows(db, "SELECT p.status FROM _rollback_0004_partner_profiles p JOIN partner_profiles pp ON pp.id = p.id WHERE pp.userId = 7"))[0].status === "INFO_REQUESTED");
check("0004 rollback keeps the suspension record in _rollback_0004_users", (await rows(db, "SELECT accountStatus s FROM _rollback_0004_users WHERE id = 6"))[0].s === "SUSPENDED");
check("0004 rollback keeps audit history (renamed) and its triggers", (await count(db, "SELECT COUNT(*) n FROM _rollback_0004_audit_logs")) === auditRows && (await blocked("DELETE FROM _rollback_0004_audit_logs")) === "blocked");
check("0004 rollback removes the 0004 journal row", (await count(db, "SELECT COUNT(*) n FROM __drizzle_migrations")) === 4);
await db.end();
await applyUpTo(MAIN, 5);
s = inspect(MAIN, "--expect-legacy");
check("0004 re-applies cleanly after rollback", s.ok, s.out);
db = await connect(MAIN);
roles = await roleCounts();
check("0004 re-apply renames roles again", JSON.stringify(roles) === '{"SUPER_ADMIN":2,"SUPPORT_ADMIN":1}', JSON.stringify(roles));
await db.end();

// A failure after the role UPDATE but before the enum shrink leaves a mixed state; recovery is the backup.
const backup4 = path.join(work, "pre-0004.sql");
const dump4Error = dump(RESTORE, backup4);
check("mysqldump backup before 0004", !dump4Error, dump4Error ?? "");
const statements0004 = fs.readFileSync(path.join(drizzleDir, `${journal.entries[4].tag}.sql`), "utf8").split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean);
const stopAt = statements0004.findIndex((x) => x.includes("SET `role` = 'SUPER_ADMIN'"));
db = await connect(RESTORE);
for (const stmt of statements0004.slice(0, stopAt + 1)) await db.query(stmt);
roles = await roleCounts();
check("Simulated half-applied 0004 leaves a mixed role state", roles.SUPER_ADMIN === 2 && !roles.ADMIN && (await count(db, "SELECT COUNT(*) n FROM __drizzle_migrations")) === 4, JSON.stringify(roles));
const rerun = await applyUpTo(RESTORE, 5).then(() => "applied", (e) => e.message);
check("Re-running 0004 on a half-applied database stops instead of guessing", rerun !== "applied", rerun.slice(0, 80));
await db.end();
await recreate(RESTORE);
const restore4Error = await restore(RESTORE, backup4);
check("Pre-0004 backup restores after the failure", !restore4Error, restore4Error ?? "");
await applyUpTo(RESTORE, 5);
s = inspect(RESTORE, "--expect-legacy");
check("0004 applies cleanly after restoring the backup", s.ok, s.out);
db = await connect(RESTORE);
roles = await roleCounts();
check("Restored-then-migrated copy has the renamed roles", roles.SUPER_ADMIN === 2 && !roles.ADMIN && !roles.SUPPORT, JSON.stringify(roles));
await db.end();

fs.mkdirSync("docs/verification", { recursive: true });
fs.writeFileSync(
  "docs/verification/legacy-audit-rehearsal.json",
  JSON.stringify(auditLog, (_, v) => (typeof v === "bigint" ? Number(v) : v instanceof Date ? v.toISOString() : v), 2),
);

// ---------------------------------------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
fs.rmSync(work, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);

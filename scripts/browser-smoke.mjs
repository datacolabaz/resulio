#!/usr/bin/env node
/**
 * Browser smoke run: headless Chromium (Playwright) against a LOCAL dev server and a LOCAL database.
 * It resets activity for the demo assessment and edits deadlines directly in the database, so it
 * refuses anything that is not localhost + a resulio_dev / *_test / *_it database.
 *
 *   SMOKE_DATABASE_URL=mysql://user:pass@127.0.0.1:3307/resulio_dev \
 *   SMOKE_TOKENS_FILE=~/.tools/mysql-test/smoke-tokens.json \
 *   node scripts/browser-smoke.mjs
 *
 * Tokens come from `scripts/smoke-personas.ts` (same SESSION_SECRET as the running server).
 * Playwright is not a repo dependency: PLAYWRIGHT_DIR points at a folder where `playwright` is installed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import mysql from "mysql2/promise";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const DB_URL = process.env.SMOKE_DATABASE_URL ?? "";
const TOKENS_FILE = process.env.SMOKE_TOKENS_FILE ?? "";
const OUT = path.resolve(process.env.SMOKE_OUT ?? "docs/verification");
const SHOTS = path.join(OUT, "screenshots");
const PW_DIR = process.env.PLAYWRIGHT_DIR ?? path.join(os.homedir(), ".tools", "smoke-browser");
const SWEEP_WAIT_MS = 45_000;
/** SMOKE_ONLY=<regex> runs matching check ids only (for iterating); the report files are then left untouched. */
const ONLY = process.env.SMOKE_ONLY ? new RegExp(process.env.SMOKE_ONLY) : null;

const LOCAL = new Set(["localhost", "127.0.0.1", "::1"]);
function guard() {
  const base = new URL(BASE);
  if (!LOCAL.has(base.hostname)) throw new Error(`SMOKE_BASE_URL must be local, got ${base.hostname}`);
  if (!DB_URL) throw new Error("SMOKE_DATABASE_URL is required");
  const db = new URL(DB_URL);
  const name = db.pathname.replace(/^\//, "");
  if (!LOCAL.has(db.hostname)) throw new Error(`SMOKE_DATABASE_URL must be local, got ${db.hostname}`);
  if (!/^resulio_dev$|_test$|_it$/.test(name)) throw new Error(`refusing database "${name}" (expected resulio_dev, *_test or *_it)`);
  if (process.env.NODE_ENV === "production") throw new Error("refusing to run with NODE_ENV=production");
  if (!TOKENS_FILE || !fs.existsSync(TOKENS_FILE)) throw new Error("SMOKE_TOKENS_FILE missing");
}
guard();

process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(PW_DIR, "browsers");
const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright");
const readJson = (file) => {
  const buf = fs.readFileSync(file);
  // PowerShell `>` writes UTF-16LE with a BOM
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString("utf16le") : buf.toString("utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
};
const tokens = readJson(TOKENS_FILE);
fs.mkdirSync(SHOTS, { recursive: true });

const DESKTOP = { width: 1366, height: 900 };
const MOBILE = { width: 390, height: 844 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, step = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t0 > ms) return v;
    await sleep(step);
  }
}

// ---------- database ----------
const db = await mysql.createConnection({ uri: DB_URL, timezone: "Z" });
await db.query("SET time_zone = '+00:00'");
const q = async (sql, params = []) => (await db.query(sql, params))[0];
const one = async (sql, params = []) => (await q(sql, params))[0];

const userId = {};
for (const r of await q("SELECT id, openId FROM users")) userId[r.openId] = r.id;
const teacherWs = `ws_demo_${userId["demo-teacher"]}`;
const assessment = await one(
  "SELECT id FROM assessments WHERE providerWorkspaceId = ? AND status = 'PUBLISHED' ORDER BY createdAt LIMIT 1",
  [teacherWs],
);
if (!assessment) throw new Error(`no published assessment in ${teacherWs}; run pnpm db:seed first`);
const A = assessment.id;

async function resetActivity() {
  await q("DELETE ri FROM result_items ri JOIN results r ON r.id = ri.resultId WHERE r.assessmentId = ?", [A]);
  await q("DELETE FROM results WHERE assessmentId = ?", [A]);
  await q("DELETE sa FROM student_answers sa JOIN attempts a ON a.id = sa.attemptId WHERE a.assessmentId = ?", [A]);
  await q("DELETE FROM student_activity_events WHERE entityId = ? OR entityId IN (SELECT id FROM attempts WHERE assessmentId = ?)", [A, A]);
  await q("DELETE FROM attempts WHERE assessmentId = ?", [A]);
  await q("DELETE FROM assessment_student_progress WHERE assessmentId = ?", [A]);
  await q("UPDATE users SET lastActiveContext = NULL WHERE openId LIKE 'smoke-%'");
}
/** Clears one student's attempts on the demo assessment so a check can start a fresh session. */
async function resetStudent(openId) {
  const sid = userId[openId];
  await q("DELETE ri FROM result_items ri JOIN results r ON r.id = ri.resultId WHERE r.assessmentId = ? AND r.studentId = ?", [A, sid]);
  await q("DELETE FROM results WHERE assessmentId = ? AND studentId = ?", [A, sid]);
  await q("DELETE sa FROM student_answers sa JOIN attempts a ON a.id = sa.attemptId WHERE a.assessmentId = ? AND a.studentId = ?", [A, sid]);
  await q("DELETE FROM student_activity_events WHERE entityId IN (SELECT id FROM attempts WHERE assessmentId = ? AND studentId = ?)", [A, sid]);
  await q("DELETE FROM attempts WHERE assessmentId = ? AND studentId = ?", [A, sid]);
  await q("DELETE FROM assessment_student_progress WHERE assessmentId = ? AND studentId = ?", [A, sid]);
}

/** Every string stored in content tables: names, titles, questions, options. Not UI text, so never translated. */
const userContent = [];
{
  const collect = (v) => {
    if (typeof v === "string") {
      if (v.trim().length >= 2) userContent.push(v.trim());
    } else if (v && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) {
      Object.values(v).forEach(collect);
    }
  };
  for (const table of ["users", "provider_workspaces", "study_groups", "questions", "assessments", "assessment_versions", "version_questions", "partner_profiles"]) {
    for (const row of await q(`SELECT * FROM ${table}`)) collect(row);
  }
  userContent.sort((a, b) => b.length - a.length);
}
const attemptsOf = (openId) => q("SELECT * FROM attempts WHERE assessmentId = ? AND studentId = ? ORDER BY attemptNo", [A, userId[openId]]);
const attempt = (id) => one("SELECT * FROM attempts WHERE id = ?", [id]);
const resultsOf = (attemptId) => q("SELECT * FROM results WHERE attemptId = ?", [attemptId]);
const answersOf = (attemptId) => q("SELECT versionQuestionId, answer, revision FROM student_answers WHERE attemptId = ?", [attemptId]);

// ---------- browser ----------
const browser = await chromium.launch();
const browserVersion = `Chromium ${browser.version()} (Playwright headless)`;

async function session(persona, { mobile = false, init, viewport, colorScheme = "light", theme, locale } = {}) {
  const context = await browser.newContext({
    viewport: viewport ?? (mobile ? MOBILE : DESKTOP),
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: mobile ? 2 : 1,
    locale: locale === "en" ? "en-US" : "az-AZ",
    timezoneId: "Asia/Baku",
    colorScheme,
  });
  await context.addInitScript((initial) => {
    if (!localStorage.getItem("resulio-locale")) {
      localStorage.setItem("resulio-locale", initial);
      localStorage.setItem("resulio-locale-chosen", "1");
    }
  }, locale ?? "az");
  if (theme) await context.addInitScript((value) => localStorage.setItem("resulio.theme", value), theme);
  if (init) await context.addInitScript(init);
  if (persona) {
    const value = typeof persona === "string" ? tokens[persona] : persona.token;
    await context.addCookies([{ name: "resulio_session", value, domain: new URL(BASE).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  }
  const page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) consoleErrors.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`));
  page.on("response", (r) => {
    if (r.status() >= 500) consoleErrors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
  });
  return { context, page, consoleErrors, mobile, viewport: viewport ?? (mobile ? MOBILE : DESKTOP) };
}

const trpcGet = (page, proc, input, headers = {}) =>
  page.evaluate(
    async ({ proc, input, headers }) => {
      const qs = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
      const r = await fetch(`/api/trpc/${proc}${qs}`, { headers });
      const body = await r.json().catch(() => null);
      return { status: r.status, data: body?.result?.data?.json, error: body?.error?.json?.message };
    },
    { proc, input, headers },
  );

const path_ = (page) => {
  const u = new URL(page.url());
  return u.pathname + u.search;
};
async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
/** Innermost elements sticking out past the right edge of the viewport. */
function overflowCulprits(page) {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const over = [...document.querySelectorAll("body *")].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.right > w + 0.5;
    });
    return over
      .filter((e) => !over.some((o) => o !== e && e.contains(o)))
      .slice(0, 4)
      .map((e) => `${e.getAttribute("data-loc") ?? e.tagName} "${(e.textContent ?? "").trim().slice(0, 30)}"`);
  });
}
async function text(page) {
  return page.evaluate(() => document.body.innerText);
}
async function waitText(page, needle, timeout = 10_000) {
  await page.waitForFunction((n) => document.body.innerText.includes(n), needle, { timeout });
}
/** Waits until no loading placeholder ("Yüklənir…") is on screen. */
async function settled(page, timeout = 10_000) {
  await page.waitForFunction(() => !/yüklənir/i.test(document.body.innerText), undefined, { timeout });
}

// ---------- recording ----------
const results = [];
/** The session most recently opened by the running check (a check may open more than one). */
let current = null;
const currentPage = () => current.page;
function check(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function test(id, area, name, fn) {
  if (ONLY && !ONLY.test(id)) return null;
  const rec = { id, area, name, route: "", viewport: "", browser: browserVersion, result: "PASS", screenshot: null, issues: [], console: [], notes: [] };
  const started = Date.now();
  let s;
  const ctx = {
    rec,
    async open(persona, opts) {
      if (s) {
        rec.console.push(...s.consoleErrors);
        await s.context.close().catch(() => {});
      }
      s = await session(persona, opts);
      current = s;
      const size = `${s.viewport.width}x${s.viewport.height}`;
      const desc = s.mobile ? `${size} mobile (touch, DPR 2)` : `${size} desktop`;
      rec.viewport = rec.viewport && !rec.viewport.includes(desc) ? `${rec.viewport}; ${desc}` : desc;
      return s;
    },
    async shot(page, label, { fullPage = false } = {}) {
      const file = `${id.toLowerCase()}-${label}.png`;
      await page.screenshot({ path: path.join(SHOTS, file), fullPage });
      rec.screenshot = rec.screenshot ? `${rec.screenshot}, ${file}` : file;
    },
    route(page) {
      rec.route = rec.route ? `${rec.route} → ${path_(page)}` : path_(page);
    },
    async noOverflow(page) {
      const px = await overflow(page);
      if (px <= 1) return;
      rec.issues.push(`horizontal overflow ${px}px on ${path_(page)} (${(await overflowCulprits(page)).join(", ")})`);
    },
  };
  try {
    await fn(ctx);
  } catch (e) {
    rec.result = "FAIL";
    rec.issues.push(e.message.split("\n")[0]);
    if (s) await ctx.shot(s.page, "failure").catch(() => {});
  } finally {
    if (s) {
      rec.console = [...new Set([...rec.console, ...s.consoleErrors])];
      await s.context.close().catch(() => {});
    }
  }
  if (rec.result === "PASS" && rec.issues.length) rec.result = "PASS (issues noted)";
  rec.ms = Date.now() - started;
  results.push(rec);
  console.log(`${rec.result.padEnd(20)} ${id} ${name}${rec.issues.length ? `  — ${rec.issues.join("; ")}` : ""}`);
  return rec;
}
function na(id, area, name, reason) {
  results.push({ id, area, name, route: "-", viewport: "-", browser: "-", result: "N/A", screenshot: null, issues: [reason], console: [], notes: [] });
  console.log(`${"N/A".padEnd(20)} ${id} ${name} — ${reason}`);
}

// ---------- exam helpers ----------
async function startExam(page, { dbl = false } = {}) {
  await page.goto(`${BASE}/student/assessments/${A}`);
  const start = page.getByRole("button", { name: /başla|start/i });
  await start.waitFor();
  if (dbl) await start.dblclick();
  else await start.click();
  await page.waitForURL(/\/student\/sessions\//);
  await page.getByRole("timer").waitFor();
  return new URL(page.url()).pathname.split("/").pop();
}
/** Answers whatever question is on screen; returns a label or null for types it does not handle. */
async function answerCurrent(page, alt = false) {
  const main = page.locator("main");
  for (const [a, b] of [["Bakı", "Gəncə"], ["Doğru", "Yanlış"]]) {
    const radio = main.getByRole("radio", { name: alt ? b : a });
    if (await radio.count()) {
      // the native radio is visually hidden; its <label> is the click target
      await radio.first().locator("xpath=ancestor::label[1]").click();
      return alt ? b : a;
    }
  }
  const num = main.getByPlaceholder("Rəqəm");
  if (await num.count()) {
    await num.fill(alt ? "143" : "144");
    return "numeric";
  }
  const essay = main.getByPlaceholder("Cavabınızı yazın");
  if (await essay.count()) {
    await essay.fill(alt ? "Smoke test esse (late)" : "Smoke test esse");
    return "essay";
  }
  return null;
}
async function answerN(page, attemptId, n) {
  const labels = [];
  for (let i = 0; i < 5 && labels.length < n; i++) {
    const got = await answerCurrent(page);
    if (got) labels.push(got);
    if (labels.length < n) await page.getByRole("button", { name: "Növbəti →" }).click();
  }
  const saved = await until(async () => (await answersOf(attemptId)).length >= n, 10_000);
  check(saved, `expected ${n} autosaved answers in DB`);
  return labels;
}
const timerSeconds = async (page) => {
  // CSS locator: while a modal is open the timer is aria-hidden and not reachable by role
  const t = (await page.locator('[role="timer"]').innerText()).trim();
  const m = t.match(/(\d+):(\d{2})(?::(\d{2}))?/);
  if (!m) return NaN;
  return m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
};
async function openMenu(page) {
  await page.getByRole("button", { name: "Hesab menyusu" }).click();
  await page.getByRole("menu").waitFor();
}

// =====================================================================
await resetActivity();
console.log(`assessment ${A}, workspace ${teacherWs}, ${browserVersion}\n`);

// ---------- AUTH ----------
await test("AUTH-01", "Auth", "Landing page renders with demo login (dev only)", async ({ open, shot, route, noOverflow }) => {
  const { page } = await open(null);
  await page.goto(`${BASE}/`);
  await page.getByRole("button", { name: "Demo müəllim" }).waitFor();
  check(await page.getByRole("button", { name: "Google ilə daxil ol" }).isVisible(), "Google button missing");
  route(page);
  await noOverflow(page);
  await shot(page, "landing");
});

await test("AUTH-02", "Auth", "Google sign-in start without OAuth credentials fails safely", async ({ open, shot, route, rec }) => {
  const { page } = await open(null);
  const r = await page.goto(`${BASE}/api/auth/google/start?returnTo=%2Fapp`);
  route(page);
  check(r.status() === 503, `expected 503, got ${r.status()}`);
  check((await text(page)).includes("not configured"), "missing explanation text");
  rec.notes.push("Real Google login cannot be exercised locally (no OAuth client; production credentials must not be used).");
  await shot(page, "google-unconfigured");
});

await test("AUTH-03", "Auth", "OAuth cancel returns to landing with message", async ({ open, shot, route }) => {
  const { page } = await open(null);
  await page.goto(`${BASE}/api/auth/google/callback?error=access_denied`);
  await page.waitForURL(/login=cancelled/);
  await waitText(page, "Giriş ləğv edildi");
  route(page);
  await shot(page, "oauth-cancelled");
});

await test("AUTH-04", "Auth", "Protected URL while signed out redirects with returnTo; demo login returns there", async ({ open, shot, route }) => {
  const { page } = await open(null);
  await page.goto(`${BASE}/teacher/assessments`);
  await page.waitForURL(/returnTo=%2Fteacher%2Fassessments/);
  route(page);
  await shot(page, "redirected");
  await page.getByRole("button", { name: "Demo müəllim" }).click();
  await page.waitForURL(`${BASE}/teacher/assessments`);
  await page.getByRole("heading", { level: 1, name: "İmtahanlar" }).waitFor();
  route(page);
  await shot(page, "returned");
});

await test("AUTH-05", "Auth", "Session persists across reload; cookie flags", async ({ open, shot, route, rec }) => {
  const { page, context } = await open("demo-teacher");
  await page.goto(`${BASE}/teacher`);
  await waitText(page, "Bu günün vəziyyəti");
  await page.reload();
  await waitText(page, "Bu günün vəziyyəti");
  route(page);
  const c = (await context.cookies()).find((x) => x.name === "resulio_session");
  check(c?.httpOnly, "session cookie must be httpOnly");
  check(c?.sameSite === "Lax", `sameSite ${c?.sameSite}`);
  rec.notes.push(`cookie httpOnly=${c.httpOnly} sameSite=${c.sameSite} secure=${c.secure} (secure is expected only over https/production)`);
  await shot(page, "teacher-after-reload");
});

await test("AUTH-06", "Auth", "Sign out clears session; protected URL redirects afterwards", async ({ open, shot, route }) => {
  const { page } = await open("demo-teacher");
  await page.goto(`${BASE}/teacher`);
  await waitText(page, "Bu günün vəziyyəti");
  await openMenu(page);
  await page.getByRole("menuitem", { name: "Çıxış" }).click();
  await page.waitForURL(`${BASE}/`);
  const me = await trpcGet(page, "auth.me");
  check(me.data === null, "auth.me should be null after sign out");
  await page.goto(`${BASE}/teacher`);
  await page.waitForURL(/returnTo=%2Fteacher/);
  route(page);
  await shot(page, "signed-out");
});

await test("AUTH-07", "Auth", "Forged session cookie is treated as signed out", async ({ open, route }) => {
  const t = tokens["demo-teacher"];
  const forged = t.slice(0, -4) + (t.endsWith("AAAA") ? "BBBB" : "AAAA");
  const { page } = await open({ token: forged });
  await page.goto(`${BASE}/teacher`);
  await page.waitForURL(/returnTo=%2Fteacher/);
  const me = await trpcGet(page, "auth.me");
  check(me.data === null, "forged cookie must not authenticate");
  route(page);
});

await test("AUTH-08", "Auth", "Demo student login lands in learning context", async ({ open, shot, route }) => {
  const { page } = await open(null);
  await page.goto(`${BASE}/`);
  await page.getByRole("button", { name: "Demo tələbə" }).click();
  await page.waitForURL(`${BASE}/student`);
  await waitText(page, "ÖYRƏNMƏ MƏKANIM");
  route(page);
  await shot(page, "student-home");
});

// ---------- CONTEXT ----------
await test("CTX-01", "Context", "User with no context goes to onboarding; every context URL is blocked", async ({ open, shot, route }) => {
  const { page } = await open("smoke-new");
  await page.goto(`${BASE}/app`);
  await page.waitForURL(`${BASE}/welcome`);
  await shot(page, "welcome");
  for (const p of ["/teacher", "/student", "/partner", "/teacher/assessments"]) {
    await page.goto(`${BASE}${p}`);
    await page.waitForURL(`${BASE}/welcome`);
  }
  route(page);
  const api = await trpcGet(page, "teacher.dashboard");
  check(api.status === 403 && api.error === "NO_WORKSPACE", `teacher API: ${api.status} ${api.error}`);
});

await test("CTX-02", "Context", "Learning ↔ Teaching switch (student + teacher persona)", async ({ open, shot, route }) => {
  const { page } = await open("smoke-both");
  await page.goto(`${BASE}/app`);
  await page.waitForURL(`${BASE}/student`);
  await openMenu(page);
  await shot(page, "menu");
  await page.getByRole("menuitem", { name: "Tədris məkanım" }).click();
  await page.waitForURL(`${BASE}/teacher`);
  await waitText(page, "Smoke Tələbə+Müəllim məkanı");
  check(!(await text(page)).includes("Demo imtahan"), "teaching context shows another workspace's exam");
  await shot(page, "teaching");
  await page.reload();
  await waitText(page, "Smoke Tələbə+Müəllim məkanı");
  await page.goto(`${BASE}/app`);
  await page.waitForURL(`${BASE}/teacher`);
  const u = await one("SELECT lastActiveContext FROM users WHERE openId = 'smoke-both'");
  check(u.lastActiveContext === "teaching", `lastActiveContext=${u.lastActiveContext}`);
  await openMenu(page);
  await page.getByRole("menuitem", { name: "Öyrənmə məkanım" }).click();
  await page.waitForURL(`${BASE}/student`);
  route(page);
  await shot(page, "back-to-learning");
});

await test("CTX-03", "Context", "Spoofed workspace id (another teacher's) is rejected and the UI recovers", async ({ open, shot, route, rec }) => {
  const { page } = await open("smoke-both", { init: () => localStorage.setItem("resulio.workspace", "ws_demo_1") });
  await page.goto(`${BASE}/teacher`);
  await waitText(page, "Smoke Tələbə+Müəllim məkanı");
  const body = await text(page);
  check(!body.includes("Demo imtahan") && !body.includes("Demo Tədris Məkanı"), "spoofed workspace data rendered");
  const ws = await page.evaluate(() => localStorage.getItem("resulio.workspace"));
  rec.notes.push(`client workspace hint after load: ${ws}`);
  const api = await trpcGet(page, "teacher.dashboard", undefined, { "x-resulio-workspace": teacherWs });
  check(api.status === 403 && api.error === "NO_WORKSPACE", `spoofed header: ${api.status} ${api.error}`);
  route(page);
  await shot(page, "own-workspace");
});

await test("CTX-04", "Context", "Approved partner sees partner panel and three contexts", async ({ open, shot, route }) => {
  const { page } = await open("smoke-all");
  await page.goto(`${BASE}/partner`);
  await waitText(page, "Referal kodu");
  await openMenu(page);
  const items = await page.getByRole("menuitem").allInnerTexts();
  for (const label of ["Öyrənmə məkanım", "Tədris məkanım", "Partner paneli"]) check(items.some((t) => t.includes(label)), `menu lacks ${label}`);
  route(page);
  await shot(page, "partner");
});

await test("CTX-05", "Context", "Pending partner cannot open partner panel (UI + API)", async ({ open, shot, route }) => {
  const { page } = await open("smoke-pending-partner");
  await page.goto(`${BASE}/partner`);
  await page.waitForURL(`${BASE}/student`);
  const api = await trpcGet(page, "partner.dashboard");
  check(api.status === 403 && api.error === "PARTNER_ONLY", `partner API: ${api.status} ${api.error}`);
  route(page);
  await shot(page, "redirected");
});

await test("CTX-06", "Context", "Student cannot open teacher pages or teacher APIs", async ({ open, route }) => {
  const { page } = await open("demo-student");
  for (const p of ["/teacher", `/teacher/assessments/${A}/participants`, "/teacher/results"]) {
    await page.goto(`${BASE}${p}`);
    await page.waitForURL(`${BASE}/student`);
  }
  const api = await trpcGet(page, "teacher.assessments.participants", { id: A });
  check(api.status === 403 && api.error === "NO_WORKSPACE", `participants API: ${api.status} ${api.error}`);
  route(page);
});

// ---------- EXAM (student S1 = smoke-pending-partner) ----------
let s1Attempt;
await test("EXAM-01", "Assessment", "Double-click Start creates exactly one attempt", async ({ open, shot, route }) => {
  const { page } = await open("smoke-pending-partner");
  await page.goto(`${BASE}/student/assessments/${A}`);
  await waitText(page, "0 / 2");
  await shot(page, "detail");
  s1Attempt = await startExam(page, { dbl: true });
  await sleep(1500);
  const rows = await attemptsOf("smoke-pending-partner");
  check(rows.length === 1, `expected 1 attempt, got ${rows.length}`);
  const progress = await one("SELECT attemptCount FROM assessment_student_progress WHERE assessmentId = ? AND studentId = ?", [A, userId["smoke-pending-partner"]]);
  check(progress?.attemptCount === 1, `progress.attemptCount=${progress?.attemptCount}`);
  route(page);
  await shot(page, "session");
});

await test("EXAM-02", "Assessment", "Autosave writes answers and shows saved state", async ({ open, shot, route, noOverflow }) => {
  const { page } = await open("smoke-pending-partner");
  await page.goto(`${BASE}/student/sessions/${s1Attempt}`);
  await page.getByRole("timer").waitFor();
  await answerN(page, s1Attempt, 2);
  await waitText(page, "Yadda saxlanıldı");
  await noOverflow(page);
  const a = await attempt(s1Attempt);
  check(a.answeredCount === 2, `attempts.answeredCount=${a.answeredCount}`);
  check(a.lastAutosaveAt, "lastAutosaveAt not set");
  route(page);
  await shot(page, "saved");
});

await test("EXAM-03", "Assessment", "Refresh resumes the same attempt with answers and remaining time", async ({ open, shot, route, rec }) => {
  const { page } = await open("smoke-pending-partner");
  await page.goto(`${BASE}/student/sessions/${s1Attempt}`);
  await page.getByRole("timer").waitFor();
  const before = await timerSeconds(page);
  await sleep(2000);
  await page.reload();
  await page.getByRole("timer").waitFor();
  await waitText(page, "2 / 5 cavablandı");
  const after = await timerSeconds(page);
  check(after < before, `timer did not continue (before ${before}s, after ${after}s)`);
  check(new URL(page.url()).pathname.endsWith(s1Attempt), "resumed a different attempt");
  rec.notes.push(`timer ${before}s → ${after}s across reload`);
  route(page);
  await shot(page, "resumed");
});

await test("EXAM-04", "Assessment", "Timer counts down and is announced", async ({ open, route }) => {
  const { page } = await open("smoke-pending-partner");
  await page.goto(`${BASE}/student/sessions/${s1Attempt}`);
  const t1 = await (await page.getByRole("timer").waitFor(), timerSeconds(page));
  await sleep(2200);
  const t2 = await timerSeconds(page);
  check(t2 < t1, `timer not decreasing (${t1} → ${t2})`);
  const label = await page.getByRole("timer").getAttribute("aria-label");
  check(label?.startsWith("Qalan vaxt"), `aria-label: ${label}`);
  route(page);
});

await test("TRK-01", "Tracking", "Inactive session appears on dashboard card and participants report", async ({ open, shot, route, rec }) => {
  await q("UPDATE attempts SET lastActivityAt = NOW() - INTERVAL 15 MINUTE WHERE id = ?", [s1Attempt]);
  const { page } = await open("demo-teacher");
  await page.goto(`${BASE}/teacher`);
  await waitText(page, "İmtahanların fəaliyyəti");
  const api = await trpcGet(page, "teacher.activity");
  check(api.data.totals.inactiveNow === 1, `inactiveNow=${api.data.totals.inactiveNow}`);
  const statCard = page.getByRole("region", { name: "Bu günün vəziyyəti" }).getByText("Fəaliyyətsiz sessiya").locator("xpath=..");
  const value = (await statCard.innerText()).split("\n").map((s) => s.trim()).filter(Boolean)[1];
  check(value === "1", `dashboard card shows "${value}" inactive`);
  await shot(page, "dashboard");
  await page.goto(`${BASE}/teacher/assessments/${A}/participants`);
  await waitText(page, "Smoke Gözləyən Partnyor");
  const report = await trpcGet(page, "teacher.assessments.participants", { id: A });
  const row = report.data.participants.find((p) => p.studentId === userId["smoke-pending-partner"]);
  check(row?.state === "INACTIVE", `participant state ${row?.state}`);
  rec.notes.push(`report counts ${JSON.stringify(report.data.summary.counts)}`);
  route(page);
  await shot(page, "participants");
});

await test("TRK-02", "Tracking", "Resuming the session page counts as activity (by design)", async ({ open, rec, route }) => {
  const { page } = await open("smoke-pending-partner");
  await page.goto(`${BASE}/student/sessions/${s1Attempt}`);
  await page.getByRole("timer").waitFor();
  await sleep(2500);
  const a = await attempt(s1Attempt);
  const ageMin = (Date.now() - new Date(a.lastActivityAt).getTime()) / 60_000;
  check(ageMin < 1, `lastActivityAt still ${ageMin.toFixed(1)} min old after resuming`);
  rec.notes.push("first ping after load sends interacted=true, so a returning student is active again; later heartbeats without interaction do not reset inactivity (server integration test)");
  route(page);
});

await test("EXAM-05", "Assessment", "Double-click final submit creates exactly one result", async ({ open, shot, route }) => {
  const { page } = await open("smoke-pending-partner");
  await page.goto(`${BASE}/student/sessions/${s1Attempt}`);
  await page.getByRole("timer").waitFor();
  await page.locator("header").getByRole("button", { name: "Təhvil ver" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await shot(page, "confirm");
  await dialog.getByRole("button", { name: "Təhvil ver" }).dblclick();
  await page.waitForURL(/\/student\/results\//);
  await settled(page);
  await sleep(1000);
  const res = await resultsOf(s1Attempt);
  check(res.length === 1, `expected 1 result, got ${res.length}`);
  const a = await attempt(s1Attempt);
  check(a.status === "SUBMITTED", `status ${a.status}`);
  route(page);
  await shot(page, "result");
});

await test("EXAM-06", "Assessment", "Result is visible in the student's results list", async ({ open, shot, route }) => {
  const { page } = await open("smoke-pending-partner");
  await page.goto(`${BASE}/student/results`);
  await waitText(page, "Demo imtahan");
  route(page);
  await shot(page, "results-list");
});

// ---------- EXPIRY ----------
await test("EXP-01", "Expiry", "Deadline passed while away: reopening auto-submits saved answers", async ({ open, shot, route }) => {
  const { page } = await open("smoke-all");
  const id = await startExam(page);
  await answerN(page, id, 1);
  await q("UPDATE attempts SET deadlineAt = NOW() - INTERVAL 5 SECOND WHERE id = ?", [id]);
  await page.reload();
  await page.waitForURL(/\/student\/results\//, { timeout: 15_000 });
  await settled(page);
  const a = await attempt(id);
  check(a.status === "AUTO_SUBMITTED" && a.autoSubmittedAt, `status ${a.status}`);
  check((await resultsOf(id)).length === 1, "missing result");
  route(page);
  await shot(page, "auto-submitted-result");
});

await test("EXP-02", "Expiry", "Timer reaches zero on screen: controls lock, then result opens", async ({ open, shot, route, rec }) => {
  const { page } = await open("smoke-both");
  const id = await startExam(page);
  await answerN(page, id, 1);
  await q("UPDATE attempts SET deadlineAt = NOW() + INTERVAL 6 SECOND WHERE id = ?", [id]);
  await page.reload();
  await page.getByRole("timer").waitFor();
  await waitText(page, "Vaxt bitdi", 15_000);
  const disabled = await page.locator("header").getByRole("button", { name: "Təhvil ver" }).isDisabled();
  check(disabled, "submit button still enabled after expiry");
  await sleep(400);
  await shot(page, "expired-toast");
  await page.waitForURL(/\/student\/results\//, { timeout: 15_000 });
  await settled(page);
  const a = await attempt(id);
  check(a.status === "AUTO_SUBMITTED", `status ${a.status}`);
  rec.notes.push("timer display at expiry verified via toast + disabled submit");
  route(page);
  await shot(page, "result");
});

await test("EXP-03", "Expiry", "Expired with no answers: no result, clear state for student and teacher", async ({ open, shot, route, rec }) => {
  const { page } = await open("smoke-both");
  const id = await startExam(page);
  await q("UPDATE attempts SET deadlineAt = NOW() - INTERVAL 5 SECOND WHERE id = ?", [id]);
  await page.reload();
  await page.waitForURL(`${BASE}/student/results`, { timeout: 15_000 });
  await settled(page);
  const a = await attempt(id);
  check(a.status === "EXPIRED_NO_ANSWERS", `status ${a.status}`);
  check((await resultsOf(id)).length === 0, "a result was created for an empty attempt");
  route(page);
  await shot(page, "student-results");
  await page.goto(`${BASE}/student/assessments/${A}`);
  await waitText(page, "Demo imtahan");
  rec.notes.push(`detail page text: ${(await text(page)).match(/Cəhd[\s\S]{0,20}/)?.[0]?.replace(/\s+/g, " ")}`);
  await shot(page, "detail-after");
});

await test("EXP-04", "Expiry", "Background sweeper auto-submits with no browser open", async ({ open, rec }) => {
  const { page, context } = await open("smoke-all");
  const id = await startExam(page);
  await answerN(page, id, 1);
  await context.close();
  await q("UPDATE attempts SET deadlineAt = NOW() - INTERVAL 2 SECOND WHERE id = ?", [id]);
  const t0 = Date.now();
  const done = await until(async () => (await attempt(id)).status !== "IN_PROGRESS", SWEEP_WAIT_MS, 1000);
  const a = await attempt(id);
  check(done && a.status === "AUTO_SUBMITTED", `status after ${SWEEP_WAIT_MS / 1000}s: ${a.status}`);
  check((await resultsOf(id)).length === 1, "missing result");
  rec.notes.push(`sweeper finalized ${((Date.now() - t0) / 1000).toFixed(0)}s after the deadline (interval 30s)`);
  rec.route = "(no page; server sweeper)";
});

await test("EXP-05", "Expiry", "Answer changed after the deadline is rejected; saved answer kept", async ({ open, shot, route, rec }) => {
  const { page } = await open("demo-student");
  const id = await startExam(page);
  const [first] = await answerN(page, id, 1);
  const saved = JSON.stringify(await answersOf(id));
  await q("UPDATE attempts SET deadlineAt = NOW() - INTERVAL 1 SECOND WHERE id = ?", [id]);
  // the page still believes time remains (its deadline came from the earlier load)
  const btnAlt = await answerCurrent(page, true);
  rec.notes.push(`first answer "${first}", late change "${btnAlt}"`);
  await page.waitForURL(/\/student\/results\//, { timeout: 20_000 });
  await settled(page);
  const a = await attempt(id);
  check(["AUTO_SUBMITTED"].includes(a.status), `status ${a.status}`);
  check(JSON.stringify(await answersOf(id)) === saved, "late answer overwrote the saved answer");
  route(page);
  await shot(page, "result");
});

// ---------- TRACKING (after flows) ----------
await test("TRK-03", "Tracking", "Dashboard card and participants report agree after all flows", async ({ open, shot, route, rec, noOverflow }) => {
  const { page } = await open("demo-teacher");
  await page.goto(`${BASE}/teacher`);
  await waitText(page, "İmtahanların fəaliyyəti");
  await noOverflow(page);
  const cards = await trpcGet(page, "teacher.activity");
  const report = await trpcGet(page, "teacher.assessments.participants", { id: A });
  const card = cards.data.cards.find((c) => c.id === A);
  check(JSON.stringify(card.summary.counts) === JSON.stringify(report.data.summary.counts), "card counts differ from report counts");
  rec.notes.push(`counts ${JSON.stringify(report.data.summary.counts)}`);
  await shot(page, "dashboard");
  await page.goto(`${BASE}/teacher/assessments/${A}/participants`);
  await waitText(page, "Smoke Gözləyən Partnyor");
  await noOverflow(page);
  route(page);
  await shot(page, "participants");
});

// ---------- MOBILE ----------
await test("MOB-01", "Mobile", "Landing page on phone", async ({ open, shot, route, noOverflow }) => {
  const { page } = await open(null, { mobile: true });
  await page.goto(`${BASE}/`);
  await page.getByRole("button", { name: "Demo tələbə" }).waitFor();
  await noOverflow(page);
  route(page);
  await shot(page, "landing");
});

await test("MOB-02", "Mobile", "Student home and navigation drawer on phone", async ({ open, shot, route, noOverflow }) => {
  const { page } = await open("demo-student", { mobile: true });
  await page.goto(`${BASE}/student`);
  await waitText(page, "İndi yaza bilərsiniz");
  await noOverflow(page);
  await shot(page, "home");
  await page.getByRole("button", { name: "Menyu", exact: true }).click();
  await page.getByRole("link", { name: "Nəticələrim" }).waitFor({ state: "visible" });
  await shot(page, "drawer");
  await page.getByRole("link", { name: "Nəticələrim" }).click();
  await page.waitForURL(`${BASE}/student/results`);
  route(page);
});

await test("MOB-03", "Mobile", "Exam session on phone: answer, timer, submit", async ({ open, shot, route, noOverflow }) => {
  const { page } = await open("demo-student", { mobile: true });
  const id = await startExam(page);
  await answerN(page, id, 1);
  await noOverflow(page);
  check(await page.getByRole("timer").isVisible(), "timer hidden on mobile");
  await shot(page, "session");
  await page.locator("header").getByRole("button", { name: "Təhvil ver" }).tap();
  await page.getByRole("dialog").getByRole("button", { name: "Təhvil ver" }).tap();
  await page.waitForURL(/\/student\/results\//);
  await settled(page);
  await noOverflow(page);
  route(page);
  await shot(page, "result");
});

await test("MOB-04", "Mobile", "Teacher dashboard and participants report on phone", async ({ open, shot, route, noOverflow }) => {
  const { page } = await open("demo-teacher", { mobile: true });
  await page.goto(`${BASE}/teacher`);
  await waitText(page, "İmtahanların fəaliyyəti");
  await noOverflow(page);
  await shot(page, "dashboard");
  await page.goto(`${BASE}/teacher/assessments/${A}/participants`);
  await waitText(page, "Smoke Gözləyən Partnyor");
  await noOverflow(page);
  route(page);
  await shot(page, "participants");
});

// ---------- PHASE 1B: localisation, dates, accessibility, layout, theme ----------
const AZ_LETTER = /[əğıöüşçƏĞİÖÜŞÇ]/;
const DATE_EN = /\b[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2}\b/g;
const DATE_AZ = /\b\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}\b/g;
const BAD_DATE = /\b\d{4} M\d{2} \d{1,2}\b|\bM\d{2}\b/;
const DARK_BG = "rgb(11, 18, 32)";
const groupRow = await one("SELECT id FROM study_groups WHERE providerWorkspaceId = ? ORDER BY createdAt LIMIT 1", [teacherWs]);
const latestResult = () => one("SELECT id FROM results WHERE assessmentId = ? ORDER BY completedAt DESC LIMIT 1", [A]);
const teacherPages = async () => {
  const r = await latestResult();
  return [
    "/teacher", "/teacher/assessments", `/teacher/assessments/${A}`, `/teacher/assessments/${A}?tab=questions`, `/teacher/assessments/${A}?tab=participants`,
    `/teacher/assessments/${A}?tab=results`, `/teacher/assessments/${A}?tab=analytics`, `/teacher/assessments/${A}?tab=versions`, `/teacher/assessments/${A}?tab=settings`,
    `/teacher/assessments/${A}/participants`, `/teacher/assessments/${A}/edit`, "/teacher/assessments/new", "/teacher/groups",
    ...(groupRow ? [`/teacher/groups/${groupRow.id}`] : []), "/teacher/assignments", "/teacher/library", "/teacher/results",
    ...(r ? [`/teacher/results/${r.id}`] : []), "/teacher/analytics", "/teacher/usage", "/settings",
  ];
};
const studentPages = async (openId) => {
  const r = await one("SELECT id FROM results WHERE studentId = ? ORDER BY completedAt DESC LIMIT 1", [userId[openId]]);
  return [
    "/student", "/student/assessments", `/student/assessments/${A}`, "/student/assignments", "/student/materials", "/student/groups",
    "/student/results", ...(r ? [`/student/results/${r.id}`] : []), "/student/progress", "/settings",
  ];
};
async function visit(page, p) {
  await page.goto(`${BASE}${p}`);
  await page.locator("main").first().waitFor();
  await page.waitForFunction(() => !/yüklənir|loading…|загрузка/i.test(document.body.innerText), undefined, { timeout: 10_000 });
  await sleep(300);
}
/** Visible (and screen-reader) UI text that is still Azerbaijani once stored user content is taken out. */
async function untranslated(page) {
  const found = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || el.closest('script,style,[lang="az"]')) continue;
      const v = (n.nodeValue ?? "").replace(/\s+/g, " ").trim();
      if (v) out.push(v);
    }
    for (const el of document.querySelectorAll("[aria-label],[placeholder],[title],img[alt]")) {
      if (el.closest('[lang="az"]')) continue;
      for (const a of ["aria-label", "placeholder", "title", "alt"]) {
        const v = el.getAttribute(a);
        if (v) out.push(v.replace(/\s+/g, " ").trim());
      }
    }
    out.push(document.title);
    return out;
  });
  return [...new Set(found)].filter((v) => {
    if (!AZ_LETTER.test(v) || userContent.some((c) => c.includes(v))) return false;
    let rest = v;
    for (const c of userContent) if (rest.includes(c)) rest = rest.split(c).join(" ");
    return AZ_LETTER.test(rest);
  });
}
async function dateAudit(page, locale) {
  const body = await text(page);
  const good = body.match(locale === "en" ? DATE_EN : DATE_AZ) ?? [];
  const wrong = body.match(locale === "en" ? DATE_AZ : DATE_EN) ?? [];
  return { good, wrong, bad: body.match(BAD_DATE)?.[0] ?? null };
}
const nestedInteractive = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("a a, a button, button a, button button, a input, button input, a select, button select, a textarea, a [role=button], button [role=button], [role=button] a, [role=button] button")]
      .map((e) => `${e.parentElement?.closest("a,button,[role=button]")?.tagName}>${e.tagName} "${(e.textContent ?? "").trim().slice(0, 30)}"`),
  );
/** Elements that visibly cut their text (ellipsis / line clamp) without a title or aria-label carrying the full text. */
const hiddenTruncation = (page) =>
  page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      const clamp = cs.webkitLineClamp && cs.webkitLineClamp !== "none";
      const clipsX = cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1;
      const clipsY = clamp && el.scrollHeight > el.clientHeight + 1;
      if (!clipsX && !clipsY) continue;
      const full = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      const label = (el.getAttribute("title") ?? el.getAttribute("aria-label") ?? el.closest("[title]")?.getAttribute("title") ?? "").replace(/\s+/g, " ").trim();
      if (label !== full) out.push(full.slice(0, 50));
    }
    return out;
  });
const focusInfo = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const target = el.classList.contains("sr-only") ? (el.closest("label") ?? el) : el;
    const cs = getComputedStyle(target);
    const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 1;
    const ring = cs.boxShadow && cs.boxShadow !== "none";
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") ?? el.getAttribute("type") ?? "",
      name: (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
      visible: Boolean(outline || ring),
      how: outline ? `outline ${cs.outlineWidth} ${cs.outlineColor}` : ring ? "box-shadow ring" : "none",
    };
  });
const FIRST_FRAME = () => {
  requestAnimationFrame(() => {
    const r = document.documentElement;
    window.__firstFrame = { dark: r.classList.contains("dark"), scheme: r.style.colorScheme, lang: r.lang };
  });
};
const isDark = (page) => page.evaluate(() => document.documentElement.classList.contains("dark"));
const bodyBg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
async function pickTheme(page, label) {
  await page.getByRole("radio", { name: label }).locator("xpath=ancestor::label[1]").click();
}

await test("I18N-01", "Localisation", "English locale: teacher pages have no Azerbaijani UI text; dates use en format", async ({ open, shot, route, rec }) => {
  const { page } = await open("demo-teacher", { locale: "en" });
  const leftovers = [];
  let dates = 0;
  for (const p of await teacherPages()) {
    await visit(page, p);
    for (const v of await untranslated(page)) leftovers.push(`${p}: "${v.slice(0, 60)}"`);
    const d = await dateAudit(page, "en");
    dates += d.good.length;
    check(!d.bad, `${p}: bad date "${d.bad}"`);
    check(!d.wrong.length, `${p}: az-format date "${d.wrong[0]}" in English UI`);
  }
  check(await page.evaluate(() => document.documentElement.lang) === "en", "html lang is not en");
  check(!leftovers.length, `untranslated: ${leftovers.slice(0, 6).join(" | ")}${leftovers.length > 6 ? ` (+${leftovers.length - 6})` : ""}`);
  check(dates > 0, "no English-format dates found on any teacher page");
  rec.notes.push(`${(await teacherPages()).length} pages scanned; ${dates} en-format dates seen (e.g. ${(await dateAudit(page, "en")).good[0] ?? "-"})`);
  await visit(page, "/teacher");
  route(page);
  await shot(page, "teacher-en");
});

await test("I18N-02", "Localisation", "English locale: student pages and exam session have no Azerbaijani UI text", async ({ open, shot, route, rec }) => {
  await resetStudent("demo-student");
  const { page } = await open("demo-student", { locale: "en" });
  const leftovers = [];
  let dates = 0;
  for (const p of await studentPages("demo-student")) {
    await visit(page, p);
    for (const v of await untranslated(page)) leftovers.push(`${p}: "${v.slice(0, 60)}"`);
    const d = await dateAudit(page, "en");
    dates += d.good.length;
    check(!d.bad, `${p}: bad date "${d.bad}"`);
    check(!d.wrong.length, `${p}: az-format date "${d.wrong[0]}" in English UI`);
  }
  const id = await startExam(page);
  await answerN(page, id, 1);
  for (const v of await untranslated(page)) leftovers.push(`session: "${v.slice(0, 60)}"`);
  const timerLabel = await page.getByRole("timer").getAttribute("aria-label");
  check(timerLabel?.startsWith("Time left"), `timer aria-label "${timerLabel}"`);
  check(!leftovers.length, `untranslated: ${leftovers.slice(0, 6).join(" | ")}${leftovers.length > 6 ? ` (+${leftovers.length - 6})` : ""}`);
  rec.notes.push(`${dates} en-format dates on student pages`);
  route(page);
  await shot(page, "session-en");
});

await test("I18N-03", "Localisation", "Azerbaijani locale: dates are dd.MM.yyyy, HH:mm everywhere; never 'M09'", async ({ open, route, rec }) => {
  const { page } = await open("demo-teacher");
  let dates = 0;
  const samples = new Set();
  for (const p of [...(await teacherPages()), ...(await studentPages("demo-student")).filter((x) => x === "/settings")]) {
    await visit(page, p);
    const d = await dateAudit(page, "az");
    dates += d.good.length;
    d.good.slice(0, 1).forEach((x) => samples.add(x));
    check(!d.bad, `${p}: bad date "${d.bad}"`);
    check(!d.wrong.length, `${p}: en-format date "${d.wrong[0]}" in Azerbaijani UI`);
  }
  check(dates > 0, "no az-format dates found");
  rec.notes.push(`${dates} az-format dates, samples ${[...samples].slice(0, 3).join(", ")}`);
  route(page);
});

await test("I18N-04", "Localisation", "Switching language updates the whole shell without a reload", async ({ open, shot, route, rec }) => {
  const { page } = await open("demo-teacher");
  await visit(page, "/teacher");
  await page.evaluate(() => (window.__marker = 42));
  await page.getByRole("button", { name: "English" }).first().click();
  await page.getByRole("link", { name: "Exams", exact: true }).first().waitFor();
  check(await page.evaluate(() => window.__marker) === 42, "page reloaded on language switch");
  check(await page.evaluate(() => document.documentElement.lang) === "en", "html lang not updated");
  const left = await untranslated(page);
  check(!left.length, `after switch still Azerbaijani: ${left.slice(0, 4).join(" | ")}`);
  const title = await page.evaluate(() => document.title);
  rec.notes.push(`document.title after switch: "${title}"`);
  await shot(page, "en");
  await page.getByRole("button", { name: "Русский" }).first().click();
  await page.getByRole("link", { name: "Экзамены", exact: true }).first().waitFor();
  await shot(page, "ru");
  await page.getByRole("button", { name: "Azərbaycanca" }).first().click();
  await page.getByRole("link", { name: "İmtahanlar", exact: true }).first().waitFor();
  check(await page.evaluate(() => localStorage.getItem("resulio-locale")) === "az", "locale not persisted");
  route(page);
});

await test("A11Y-01", "Accessibility", "No nested interactive elements on teacher and student pages", async ({ open, route, rec }) => {
  const found = [];
  const { page } = await open("demo-teacher");
  const tp = await teacherPages();
  for (const p of tp) {
    await visit(page, p);
    for (const n of await nestedInteractive(page)) found.push(`${p}: ${n}`);
  }
  await open("demo-student");
  const sp = await studentPages("demo-student");
  for (const p of sp) {
    await visit(currentPage(), p);
    for (const n of await nestedInteractive(currentPage())) found.push(`${p}: ${n}`);
  }
  check(!found.length, found.slice(0, 5).join(" | "));
  rec.notes.push(`${tp.length + sp.length} pages checked for a>button, button>a, a>a, button>button and interactive-in-role=button`);
  route(currentPage());
});

await test("A11Y-02", "Accessibility", "Multiple choice: radio semantics, labelled group, keyboard selection, visible focus, no answer leak", async ({ open, shot, route, rec }) => {
  await resetStudent("demo-student");
  const { page } = await open("demo-student");
  const id = await startExam(page);
  const group = page.locator("main").getByRole("radiogroup").first();
  await group.waitFor();
  const prompt = await group.evaluate((g) => document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() ?? "");
  check(prompt.length > 0, "radiogroup is not labelled by the question prompt");
  const radios = group.getByRole("radio");
  const count = await radios.count();
  check(count >= 2, `expected radios, found ${count}`);
  check((await group.getByRole("radio", { checked: true }).count()) === 0, "a radio is pre-selected");

  await page.locator("main").getByRole("navigation").first().focus().catch(() => {});
  let focus = null;
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    focus = await focusInfo(page);
    if (focus?.role === "radio") break;
  }
  check(focus?.role === "radio", "Tab never reached the radio group");
  check(focus.visible, `focused option has no visible focus indicator (${focus.how})`);
  rec.notes.push(`focus indicator on option: ${focus.how}`);
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  const checked = group.getByRole("radio", { checked: true });
  check((await checked.count()) === 1, "ArrowDown did not select exactly one option");
  const checkedName = (await checked.first().evaluate((r) => r.closest("label")?.textContent ?? "")).trim();
  const secondName = (await radios.nth(1).evaluate((r) => r.closest("label")?.textContent ?? "")).trim();
  check(checkedName === secondName, `ArrowDown selected "${checkedName}", expected "${secondName}"`);
  const aria = await group.evaluate((g) => ({ role: g.getAttribute("role"), labelledby: g.getAttribute("aria-labelledby") }));
  rec.notes.push(`group role=${aria.role} aria-labelledby=${aria.labelledby}; selected "${checkedName}" exposed via checked=true`);
  if (typeof group.ariaSnapshot === "function") rec.notes.push(`aria: ${(await group.ariaSnapshot()).replace(/\s+/g, " ").slice(0, 160)}`);
  const saved = await until(async () => (await answersOf(id)).length >= 1, 10_000);
  check(saved, "keyboard answer not autosaved");
  const sessionText = await text(page);
  check(!/düzgün cavab|doğru cavab/i.test(sessionText), "session page mentions the correct answer");
  check((await page.locator('main [aria-label="correct"], main [data-correct]').count()) === 0, "session exposes a correct-answer marker");
  await shot(page, "keyboard-selected");

  await page.locator("header").getByRole("button", { name: "Təhvil ver" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Təhvil ver" }).click();
  await page.waitForURL(/\/student\/results\//);
  await settled(page);
  check((await page.getByRole("radio").count()) === 0, "result review renders answer radios (review must not look selectable)");
  check((await page.getByRole("radiogroup").count()) === 0, "result review renders a radiogroup");
  rec.notes.push("review uses text (your answer / correct answer) with status badges; no selectable controls");
  route(page);
  await shot(page, "review");
});

await test("A11Y-03", "Accessibility", "Keyboard: visible focus on every tab stop; Enter follows links; Space opens menus", async ({ open, shot, route, rec }) => {
  const { page } = await open("demo-teacher");
  await visit(page, "/teacher");
  const missing = [];
  const seen = [];
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    const f = await focusInfo(page);
    if (!f) continue;
    seen.push(`${f.tag}:${f.name}`);
    if (!f.visible) missing.push(`${f.tag} "${f.name}"`);
  }
  check(!missing.length, `no visible focus on: ${[...new Set(missing)].slice(0, 5).join(", ")}`);
  rec.notes.push(`${seen.length} tab stops checked`);
  const exams = page.getByRole("navigation", { name: "Əsas naviqasiya" }).getByRole("link", { name: "İmtahanlar" });
  await exams.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(`${BASE}/teacher/assessments`);
  await page.getByRole("button", { name: "Hesab menyusu" }).focus();
  await page.keyboard.press("Space");
  await page.getByRole("menu").waitFor();
  await shot(page, "menu-by-keyboard");
  await page.keyboard.press("Escape");
  route(page);
});

await test("SCROLL-01", "Layout", "Route change scrolls to top; tabs and popovers do not move the page", async ({ open, route, rec }) => {
  const { page } = await open("demo-teacher", { viewport: { width: 1366, height: 520 } });
  await visit(page, "/teacher");
  await page.evaluate(() => window.scrollTo(0, 600));
  const before = await page.evaluate(() => window.scrollY);
  check(before > 0, "dashboard not tall enough to scroll at 520px height");
  await page.getByRole("navigation", { name: "Əsas naviqasiya" }).getByRole("link", { name: "İmtahanlar" }).click();
  await page.waitForURL(`${BASE}/teacher/assessments`);
  await sleep(200);
  check(await page.evaluate(() => window.scrollY) === 0, "new route kept the old scroll position");

  await visit(page, `/teacher/assessments/${A}`);
  // park the tab strip just under the sticky header, so the click itself needs no scrolling
  await page.evaluate(() => {
    const list = document.querySelector('[role="tablist"]');
    window.scrollTo(0, window.scrollY + list.getBoundingClientRect().top - 72);
  });
  const y1 = await page.evaluate(() => window.scrollY);
  check(y1 > 0, "could not scroll the assessment page for the tab check");
  await page.getByRole("tab", { name: "Nəticələr" }).click();
  await sleep(300);
  const y2 = await page.evaluate(() => window.scrollY);
  // a shorter tab panel legitimately clamps the position; anything below that is a reset
  const maxAfter = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  check(Math.abs(y2 - Math.min(y1, maxAfter)) <= 2, `tab change moved the page ${y1} → ${y2} (max ${maxAfter})`);

  await visit(page, "/teacher");
  const details = page.getByRole("button", { name: /fəaliyyət təfərrüatları/i }).first();
  check(await details.count(), "activity details button not found");
  await details.evaluate((el) => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 200));
  const y3 = await page.evaluate(() => window.scrollY);
  await details.click();
  await page.getByRole("dialog").first().waitFor();
  await sleep(300);
  const y4 = await page.evaluate(() => window.scrollY);
  check(Math.abs(y4 - y3) <= 2, `opening the details popover moved the page ${y3} → ${y4}`);
  await page.keyboard.press("Escape");
  rec.notes.push(`popover open: scrollY ${y3} → ${y4}`);
  rec.notes.push(`route: ${before} → 0; tab: ${y1} → ${y2}`);
  route(page);
});

await test("SCROLL-02", "Layout", "Exam session: next question and autosave do not reset scroll", async ({ open, route, rec }) => {
  await resetStudent("demo-student");
  const { page } = await open("demo-student", { mobile: true, viewport: { width: 360, height: 420 } });
  const id = await startExam(page);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const y1 = await page.evaluate(() => window.scrollY);
  check(y1 > 0, "session page not tall enough to scroll");
  await answerCurrent(page);
  await until(async () => (await answersOf(id)).length >= 1, 10_000);
  await waitText(page, "Yadda saxlanıldı");
  const y2 = await page.evaluate(() => window.scrollY);
  check(Math.abs(y2 - y1) <= 2, `autosave moved the page ${y1} → ${y2}`);
  await page.getByRole("button", { name: "Növbəti →" }).click();
  await page.locator('section[aria-label^="Sual 2"]').waitFor();
  await sleep(300);
  const y3 = await page.evaluate(() => window.scrollY);
  const max = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  check(y3 > 0 && (Math.abs(y3 - y2) <= 2 || y3 >= max - 2), `question change reset scroll ${y2} → ${y3} (max ${max})`);
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
  check(focused.startsWith("Sual 2"), `focus not moved to the new question (${focused})`);
  rec.notes.push(`scrollY: bottom ${y1}, after autosave ${y2}, after next ${y3}; focus → "${focused}" (preventScroll)`);
  route(page);
});

await test("CARD-01", "Layout", "Activity card labels readable at 320–1366px; no overflow; truncation always labelled", async ({ open, shot, route, rec }) => {
  const { page } = await open("demo-teacher");
  const widths = [320, 360, 390, 768, 1024, 1366];
  const problems = [];
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: 900 });
    await visit(page, "/teacher");
    await page.locator("article").first().waitFor();
    const over = await overflow(page);
    if (over > 1) problems.push(`${w}px: page overflow ${over}px`);
    const cut = await hiddenTruncation(page);
    if (cut.length) problems.push(`${w}px: truncated without label: ${cut.slice(0, 3).join(", ")}`);
    const outside = await page.evaluate(() => {
      const out = [];
      for (const card of document.querySelectorAll("article")) {
        const box = card.getBoundingClientRect();
        for (const li of card.querySelectorAll("ul li")) {
          const r = li.getBoundingClientRect();
          if (r.right > box.right + 0.5 || r.left < box.left - 0.5) out.push(li.textContent.trim().slice(0, 30));
          const label = li.querySelector("span:last-child");
          if (label && label.scrollWidth > label.clientWidth + 1) out.push(`clipped "${label.textContent.trim()}"`);
        }
      }
      return out;
    });
    if (outside.length) problems.push(`${w}px: bucket labels escape the card: ${outside.slice(0, 3).join(", ")}`);
    if (w === 320 || w === 768) await page.locator("article").first().screenshot({ path: path.join(SHOTS, `card-01-${w}.png`) });
  }
  rec.screenshot = "card-01-320.png, card-01-768.png";
  for (const p of ["/teacher/assessments", "/teacher/assignments", "/teacher/library"]) {
    for (const w of [320, 1024]) {
      await page.setViewportSize({ width: w, height: 900 });
      await visit(page, p);
      const over = await overflow(page);
      if (over > 1) problems.push(`${p} ${w}px: overflow ${over}px`);
      const cut = await hiddenTruncation(page);
      if (cut.length) problems.push(`${p} ${w}px: truncated without label: ${cut.slice(0, 3).join(", ")}`);
    }
  }
  await open("demo-student");
  for (const p of ["/student", "/student/assessments", "/student/assignments", "/student/materials"]) {
    for (const w of [320, 1024]) {
      await currentPage().setViewportSize({ width: w, height: 900 });
      await visit(currentPage(), p);
      const over = await overflow(currentPage());
      if (over > 1) problems.push(`${p} ${w}px: overflow ${over}px`);
      const cut = await hiddenTruncation(currentPage());
      if (cut.length) problems.push(`${p} ${w}px: truncated without label: ${cut.slice(0, 3).join(", ")}`);
    }
  }
  check(!problems.length, problems.slice(0, 5).join(" | "));
  rec.notes.push(`dashboard at ${widths.join("/")}px; assessment, assignment and material lists at 320/1024px (teacher + student)`);
  route(currentPage());
});

await test("MOB-05", "Mobile", "Every teacher and student page fits 320px and 390px without horizontal scrolling", async ({ open, route, rec }) => {
  const problems = [];
  let checked = 0;
  for (const [persona, pages] of [["demo-teacher", await teacherPages()], ["demo-student", await studentPages("demo-student")]]) {
    const { page } = await open(persona, { mobile: true, viewport: { width: 320, height: 720 } });
    for (const w of [320, 390]) {
      await page.setViewportSize({ width: w, height: 720 });
      for (const p of pages) {
        await visit(page, p);
        checked++;
        const px = await overflow(page);
        if (px > 1) problems.push(`${p} @${w}: ${px}px (${(await overflowCulprits(page)).join(", ")})`);
      }
    }
  }
  check(!problems.length, problems.slice(0, 5).join(" | "));
  rec.notes.push(`${checked} page × width combinations`);
  route(currentPage());
});

await test("THEME-01", "Theme", "System setting follows the OS; dark renders before first paint (no light flash)", async ({ open, route, rec }) => {
  const { page } = await open("demo-teacher", { colorScheme: "dark", init: FIRST_FRAME });
  await visit(page, "/teacher");
  const first = await page.evaluate(() => window.__firstFrame);
  check(first?.dark === true && first.scheme === "dark", `first frame was not dark: ${JSON.stringify(first)}`);
  check(await isDark(page), "OS dark, no stored choice: page is not dark");
  const bg = await bodyBg(page);
  check(bg === DARK_BG, `dark page background ${bg}, expected ${DARK_BG} (#0B1220)`);
  const html = await (await page.request.get(`${BASE}/`)).text();
  const script = html.indexOf("resulio.theme");
  const firstCss = html.search(/<link[^>]+rel="stylesheet"/);
  check(script > 0 && script < html.indexOf("<body") && (firstCss < 0 || script < firstCss), "pre-paint theme script is not in <head> before stylesheets");
  await open("demo-teacher", { colorScheme: "light", init: FIRST_FRAME });
  await visit(currentPage(), "/teacher");
  check(!(await isDark(currentPage())), "OS light, no stored choice: page is dark");
  check((await currentPage().evaluate(() => window.__firstFrame))?.dark === false, "first frame dark under OS light");
  rec.notes.push(`OS dark → first frame ${JSON.stringify(first)}, body ${bg}; OS light → light`);
  route(currentPage());
});

await test("THEME-02", "Theme", "Explicit choice (Settings radios) applies immediately and persists across reloads", async ({ open, shot, route, rec }) => {
  const { page } = await open("demo-teacher", { colorScheme: "light", init: FIRST_FRAME });
  await visit(page, "/settings");
  for (const label of ["Açıq rejim", "Tünd rejim", "Sistem ayarı"]) check(await page.getByRole("radio", { name: label }).count(), `theme option "${label}" missing`);
  await pickTheme(page, "Tünd rejim");
  check(await isDark(page), "Tünd rejim did not apply");
  check(await page.evaluate(() => localStorage.getItem("resulio.theme")) === "dark", "choice not stored");
  await sleep(500);
  await shot(page, "settings-dark");
  await page.reload();
  await page.locator("main").waitFor();
  check((await page.evaluate(() => window.__firstFrame))?.dark === true, "reload flashed light before dark");
  check(await page.getByRole("radio", { name: "Tünd rejim" }).isChecked(), "stored choice not reflected in Settings");
  await page.getByRole("radio", { name: "Tünd rejim" }).focus();
  await page.keyboard.press("ArrowUp");
  check(!(await isDark(page)), "ArrowUp to Açıq rejim did not switch to light");
  const f = await focusInfo(page);
  check(f?.visible, `theme radio focus not visible (${f?.how})`);
  await pickTheme(page, "Sistem ayarı");
  check(!(await isDark(page)), "Sistem ayarı under OS light should be light");
  await waitText(page, "açıq rejim");
  rec.notes.push("dark persisted across reload with dark first frame; keyboard arrows change theme; system note names the active mode");
  route(page);
});

await test("THEME-03", "Theme", "Switching theme mid-exam keeps question, answers, timer and the open dialog", async ({ open, shot, route, rec }) => {
  await resetStudent("demo-student");
  const { page, context } = await open("demo-student");
  const id = await startExam(page);
  await answerN(page, id, 1);
  await page.getByRole("button", { name: "Növbəti →" }).click();
  await page.locator('section[aria-label^="Sual 2"]').waitFor();
  await page.locator("header").getByRole("button", { name: "Təhvil ver" }).click();
  await page.getByRole("dialog").waitFor();
  await page.evaluate(() => (window.__marker = 7));
  const t1 = await timerSeconds(page);
  const t0 = Date.now();
  const other = await context.newPage();
  await other.goto(`${BASE}/settings`);
  await other.locator("main").waitFor();
  await pickTheme(other, "Tünd rejim");
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"), undefined, { timeout: 5000 });
  check(await page.evaluate(() => window.__marker) === 7, "exam page reloaded");
  check(await page.getByRole("dialog").isVisible(), "confirm dialog closed by theme switch");
  await page.bringToFront();
  await sleep(500);
  await shot(page, "dialog-dark");
  await page.keyboard.press("Escape");
  check(await page.locator('section[aria-label^="Sual 2"]').count(), "current question changed");
  await waitText(page, "1 / 5 cavablandı");
  const t2 = await timerSeconds(page);
  const elapsed = (Date.now() - t0) / 1000;
  check(t2 <= t1 && t2 >= t1 - elapsed - 2, `timer jumped ${t1}s → ${t2}s over ${elapsed.toFixed(1)}s`);
  check((await answersOf(id)).length === 1, "saved answers changed");
  await pickTheme(other, "Açıq rejim");
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"), undefined, { timeout: 5000 });
  check(await page.evaluate(() => window.__marker) === 7, "exam page reloaded on switch back");
  rec.notes.push(`theme changed from another tab (storage event); timer ${t1}s → ${t2}s, question 2 kept, dialog stayed open`);
  route(page);
});

await test("THEME-04", "Theme", "Switching theme from the account menu keeps an open form's input and workspace", async ({ open, shot, route, rec }) => {
  const { page, context } = await open("demo-teacher");
  await visit(page, "/teacher/groups");
  await page.getByRole("button", { name: "+ Yeni qrup" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.getByRole("textbox").first().fill("Tema testi qrupu");
  const ws = await page.evaluate(() => localStorage.getItem("resulio.workspace"));
  const other = await context.newPage();
  await other.goto(`${BASE}/teacher`);
  await openMenu(other);
  await other.getByRole("menuitemradio", { name: "Tünd rejim" }).click();
  check(await other.getByRole("menu").isVisible(), "account menu closed on theme pick");
  check(await isDark(other), "menu choice did not apply");
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"), undefined, { timeout: 5000 });
  await page.bringToFront();
  check(await dialog.isVisible(), "group dialog closed by theme switch");
  check(await dialog.getByRole("textbox").first().inputValue() === "Tema testi qrupu", "form input lost");
  check(await page.evaluate(() => localStorage.getItem("resulio.workspace")) === ws, "workspace context changed");
  await sleep(500); // let colour transitions finish before the screenshot
  await shot(page, "dialog-dark");
  await dialog.getByRole("button", { name: "Ləğv et" }).click();
  rec.notes.push("menu uses menuitemradio items and stays open after a pick");
  route(page);
});

for (const [id, name, persona, run] of [
  ["SHOT-TEACHER", "Teacher dashboard, Light and Dark", "demo-teacher", async (page) => visit(page, "/teacher")],
  ["SHOT-STUDENT", "Student home, Light and Dark", "demo-student", async (page) => visit(page, "/student")],
  ["SHOT-EXAM", "Active exam, Light and Dark", "demo-student", async (page) => {
    await resetStudent("demo-student");
    const attemptId = await startExam(page);
    await answerN(page, attemptId, 1);
    await waitText(page, "Yadda saxlanıldı");
  }],
]) {
  await test(id, "Theme", name, async ({ open, shot, route, noOverflow }) => {
    const { page } = await open(persona);
    await run(page);
    await noOverflow(page);
    await shot(page, "light");
    await page.evaluate(() => localStorage.setItem("resulio.theme", "dark"));
    await page.reload();
    await page.locator("main").first().waitFor();
    await settled(page);
    await sleep(500);
    check(await isDark(page), "dark not applied after reload");
    check(await bodyBg(page) === DARK_BG, "dark background token not applied");
    await shot(page, "dark");
    route(page);
  });
}

await test("SHOT-MOBILE", "Theme", "Mobile (390px): teacher dashboard and active exam, Light and Dark", async ({ open, shot, route, noOverflow }) => {
  const { page } = await open("demo-teacher", { mobile: true });
  await visit(page, "/teacher");
  await noOverflow(page);
  await shot(page, "teacher-light");
  await page.evaluate(() => localStorage.setItem("resulio.theme", "dark"));
  await page.reload();
  await settled(page);
  await sleep(400);
  await shot(page, "teacher-dark");
  await open("demo-student", { mobile: true });
  const attempt = await one("SELECT id FROM attempts WHERE assessmentId = ? AND studentId = ? AND status = 'IN_PROGRESS' ORDER BY attemptNo DESC LIMIT 1", [A, userId["demo-student"]]);
  check(attempt, "no open attempt left by SHOT-EXAM");
  await currentPage().goto(`${BASE}/student/sessions/${attempt.id}`);
  await currentPage().getByRole("timer").waitFor();
  await noOverflow(currentPage());
  await shot(currentPage(), "exam-light");
  await currentPage().evaluate(() => localStorage.setItem("resulio.theme", "dark"));
  await currentPage().reload();
  await currentPage().getByRole("timer").waitFor();
  await sleep(400);
  check(await isDark(currentPage()), "dark not applied on mobile exam");
  await shot(currentPage(), "exam-dark");
  route(currentPage());
});

await test("SHOT-DARK", "Theme", "Dark sweep: charts, participants, builder, settings, landing", async ({ open, shot, route, rec }) => {
  const { page } = await open("demo-teacher", { theme: "dark" });
  for (const [label, p] of [
    ["analytics", "/teacher/analytics"],
    ["assessment-analytics", `/teacher/assessments/${A}?tab=analytics`],
    ["participants", `/teacher/assessments/${A}/participants`],
    ["builder", `/teacher/assessments/${A}/edit`],
    ["settings", "/settings"],
  ]) {
    await visit(page, p);
    await sleep(600); // charts animate in
    check(await bodyBg(page) === DARK_BG, `${p}: not on the dark background`);
    await shot(page, label);
  }
  await visit(page, `/teacher/assessments/${A}?tab=analytics`);
  await sleep(600);
  const ticks = await page.evaluate(() => [...new Set([...document.querySelectorAll(".recharts-cartesian-axis-tick text")].map((e) => getComputedStyle(e).fill))]);
  check(ticks.length, "no chart axis labels rendered on the assessment analytics tab");
  rec.notes.push(`dark chart axis label fill: ${ticks.join(", ")}`);
  await open(null, { theme: "dark" });
  await currentPage().goto(`${BASE}/`);
  await currentPage().getByRole("button", { name: "Demo müəllim" }).waitFor();
  await sleep(300);
  await shot(currentPage(), "landing");
  route(currentPage());
});

na("NA-01", "Auth", "Real Google sign-in / account linking", "No OAuth client locally; production credentials must not be used. Covered by production step 9 after deploy.");
na("NA-02", "Tracking", "Material download tracking", "Not implemented yet (materials are in-memory; no download report endpoint).");
na("NA-03", "Tracking", "Assignment activity / reminders", "Not implemented yet (Phase 2).");

await browser.close();
await db.end();

// ---------- report ----------
if (ONLY) {
  const failedOnly = results.filter((r) => r.result === "FAIL").length;
  console.log(`\n${results.length} checks (SMOKE_ONLY=${ONLY.source}), ${failedOnly} failed. Report not written.`);
  process.exit(failedOnly ? 1 : 0);
}
fs.writeFileSync(path.join(OUT, "browser-smoke-results.json"), JSON.stringify({ base: BASE, assessment: A, browser: browserVersion, ranAt: new Date().toISOString(), results }, null, 2));
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const md = [
  `# Browser smoke results`,
  ``,
  `Generated by \`scripts/browser-smoke.mjs\` on ${new Date().toISOString()} against ${BASE} (local dev server, database \`${new URL(DB_URL).pathname.slice(1)}\`).`,
  `Browser: ${browserVersion}.`,
  ``,
  `| ID | Area | Test | Result | Route | Viewport | Screenshot | Issues / notes | Console errors |`,
  `|---|---|---|---|---|---|---|---|---|`,
  ...results.map((r) =>
    `| ${r.id} | ${r.area} | ${cell(r.name)} | ${r.result} | ${cell(r.route)} | ${cell(r.viewport)} | ${cell(r.screenshot ?? "-")} | ${cell([...r.issues, ...r.notes].join("; ") || "-")} | ${cell(r.console.join("; ") || "-")} |`,
  ),
  ``,
].join("\n");
fs.writeFileSync(path.join(OUT, "browser-smoke-results.md"), md);
const failed = results.filter((r) => r.result === "FAIL").length;
console.log(`\n${results.length} checks, ${failed} failed. Report: ${path.relative(process.cwd(), path.join(OUT, "browser-smoke-results.md"))}`);
process.exit(failed ? 1 : 0);

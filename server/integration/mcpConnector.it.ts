import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { and, eq, like, sql } from "drizzle-orm";
import express from "express";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assessmentAssignments, mcpAuditLog, mcpEntitlements, mcpUpgradeRequests, notifications, oauthCodes, tasks as tasksTable, users } from "../../drizzle/schema";
import { closeUpgradeRequest } from "../mcp/entitlement";
import { registerMcpRoutes } from "../mcp/http";
import * as tasks from "../modules/tasks";
import { caller, db, makeAdmin, makeGroup, makeTeacher, makeUser, mcQuestion, outcome, publishedAssessment } from "./fixtures";

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

let server: Server;
let base = "";
let clientId = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  registerMcpRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  clientId = (await register()).client_id;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function register(body: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: "Claude", token_endpoint_auth_method: "none", ...body }),
  });
  return { status: res.status, ...(await res.json()) } as { status: number; client_id: string; error?: string };
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function entitle(userId: number, opts: { expiresAt?: Date | null; enabled?: boolean } = {}) {
  const values = { enabled: opts.enabled ?? true, plan: "premium", expiresAt: opts.expiresAt ?? null };
  await db().insert(mcpEntitlements).values({ userId, ...values }).onDuplicateKeyUpdate({ set: values });
}

/** GET /oauth/authorize → the consent page's request id (or the raw response when it is not a consent redirect). */
async function authorize(params: Record<string, string>) {
  const res = await fetch(`${base}/oauth/authorize?${new URLSearchParams(params)}`, { redirect: "manual" });
  const location = res.headers.get("location") ?? "";
  const request = location.includes("/connect/claude") ? new URL(location).searchParams.get("request") : null;
  return { res, location, request };
}

async function startGrant(scope?: string) {
  const { verifier, challenge } = pkce();
  const { request } = await authorize({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    ...(scope ? { scope } : {}),
  });
  expect(request).toBeTruthy();
  return { request: request!, verifier };
}

const tokenRequest = (body: Record<string, string>) =>
  fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, ...body }) });

async function exchange(code: string, verifier: string) {
  const res = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CALLBACK });
  return { status: res.status, body: (await res.json()) as { access_token: string; refresh_token: string; scope: string; error?: string; error_description?: string } };
}

/** Teacher approves on the consent page; returns tokens. */
async function connect(teacher: Awaited<ReturnType<typeof makeTeacher>>, scope?: string) {
  const { request, verifier } = await startGrant(scope);
  const { redirectTo } = await caller(teacher.user).mcpConnector.approve({ request });
  const redirect = new URL(redirectTo);
  expect(redirect.origin + redirect.pathname).toBe(CALLBACK);
  expect(redirect.searchParams.get("state")).toBe("st-1");
  const { status, body } = await exchange(redirect.searchParams.get("code")!, verifier);
  expect(status).toBe(200);
  return body;
}

async function mcpClient(accessToken: string) {
  const client = new Client({ name: "it", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}

/** Raw MCP POST, to look at HTTP status codes the SDK client turns into exceptions. */
const rawMcp = (accessToken: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
  });

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
const json = (r: ToolResult) => JSON.parse(r.content[0].text);

describe("Claude connector end to end", () => {
  it("DCR → authorize (PKCE) → consent → token → MCP tools → refresh → revoke, with audit rows", async () => {
    const teacher = await makeTeacher("MCP Müəllim");
    const student = await makeUser("MCP Tələbə");
    const group = await makeGroup(teacher.scope, [student]);
    await entitle(teacher.user.id);

    const { request, verifier } = await startGrant();
    const details = await caller(teacher.user).mcpConnector.consent({ request });
    expect(details).toMatchObject({ clientName: "Claude", redirectHost: "claude.ai", isTeacher: true, entitlement: { status: "ACTIVE" } });
    expect(details.scopes).toEqual(["exams:read", "exams:write", "groups:read", "assignments:send", "results:read"]);
    const { redirectTo } = await caller(teacher.user).mcpConnector.approve({ request });
    const tokens = (await exchange(new URL(redirectTo).searchParams.get("code")!, verifier)).body;
    expect(tokens.access_token).toMatch(/^rsl_at_/);

    const client = await mcpClient(tokens.access_token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["create_exam", "get_results", "list_exams", "list_groups", "list_students", "list_tasks", "send_assignment"]);
    expect(tools.some((t) => /delete|remove/i.test(t.name))).toBe(false);

    expect(json(await call(client, "list_groups"))).toEqual([expect.objectContaining({ id: group.id, student_count: 1 })]);
    const created = json(await call(client, "create_exam", { title: "Claude imtahanı", duration_minutes: 30, questions: [mcQuestion("2+2?")] }));
    expect(created).toMatchObject({ status: "DRAFT", question_count: 1 });
    expect(created.edit_url).toContain(`/teacher/assessments/${created.exam_id}/edit`);

    const preview = json(await call(client, "send_assignment", { kind: "exam", id: created.exam_id, group_ids: [group.id], confirm: false }));
    expect(preview).toMatchObject({ sent: false, will_publish: true });
    expect(await db().select().from(assessmentAssignments).where(eq(assessmentAssignments.assessmentId, created.exam_id))).toHaveLength(0);
    const sent = json(await call(client, "send_assignment", { kind: "exam", id: created.exam_id, group_ids: [group.id], confirm: true }));
    expect(sent).toMatchObject({ sent: true, status: "ACTIVE" });
    const results = json(await call(client, "get_results", { exam_id: created.exam_id }));
    expect(results.students).toEqual([expect.objectContaining({ student_id: student.id })]);
    await client.close();

    expect((await caller(teacher.user).mcpConnector.status()).clients).toEqual([expect.objectContaining({ clientId, clientName: "Claude" })]);

    const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect((await rawMcp(next.access_token)).status).toBe(200);

    const revoked = await fetch(`${base}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, token: next.refresh_token }) });
    expect(revoked.status).toBe(200);
    expect((await rawMcp(next.access_token)).status).toBe(401);
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: next.refresh_token })).status).toBe(400);

    const audit = await db().select().from(mcpAuditLog).where(eq(mcpAuditLog.userId, teacher.user.id));
    const seen = audit.map((a) => `${a.tool}:${a.status}`);
    expect(seen).toEqual(expect.arrayContaining(["oauth:approve:OK", "list_groups:OK", "create_exam:OK", "send_assignment:PREVIEW", "send_assignment:OK", "get_results:OK", "oauth:revoke:OK"]));
    const createRow = audit.find((a) => a.tool === "create_exam")!;
    expect(createRow.args).toMatchObject({ title: "Claude imtahanı", questions: { count: 1 } });
    expect(JSON.stringify(createRow.args)).not.toContain("2+2?");
  });

  it("reusing a rotated refresh token revokes the whole grant", async () => {
    const teacher = await makeTeacher("Rotasiya");
    await entitle(teacher.user.id);
    const tokens = await connect(teacher);
    const first = (await (await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).json()) as { access_token: string };
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status).toBe(400);
    expect((await rawMcp(first.access_token)).status).toBe(401);
  });

  it("refuses a wrong PKCE verifier and burns the code", async () => {
    const teacher = await makeTeacher("PKCE");
    await entitle(teacher.user.id);
    const { request, verifier } = await startGrant();
    const code = new URL((await caller(teacher.user).mcpConnector.approve({ request })).redirectTo).searchParams.get("code")!;
    const wrong = await exchange(code, pkce().verifier);
    expect(wrong).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect((await exchange(code, verifier)).status).toBe(400);
  });

  it("refuses unknown redirect URIs at registration and authorization", async () => {
    expect(await register({ redirect_uris: ["https://evil.example/cb"] })).toMatchObject({ status: 400, error: "invalid_redirect_uri" });
    const { res, location } = await authorize({ response_type: "code", client_id: clientId, redirect_uri: "https://claude.com/api/mcp/auth_callback", code_challenge: pkce().challenge, code_challenge_method: "S256" });
    expect(res.status).toBe(400);
    expect(location).toBe("");
    const plain = await authorize({ response_type: "code", client_id: clientId, redirect_uri: CALLBACK, code_challenge: pkce().challenge, code_challenge_method: "plain" });
    expect(new URL(plain.location).searchParams.get("error")).toBe("invalid_request");
  });

  it("refuses expired and already used codes; a replayed code revokes the tokens issued from it", async () => {
    const teacher = await makeTeacher("Kod");
    await entitle(teacher.user.id);

    const late = await startGrant();
    const lateCode = new URL((await caller(teacher.user).mcpConnector.approve({ request: late.request })).redirectTo).searchParams.get("code")!;
    await db().update(oauthCodes).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(oauthCodes.id, late.request));
    expect(await exchange(lateCode, late.verifier)).toMatchObject({ status: 400, body: { error: "invalid_grant", error_description: "Authorization code expired" } });

    const { request, verifier } = await startGrant();
    const code = new URL((await caller(teacher.user).mcpConnector.approve({ request })).redirectTo).searchParams.get("code")!;
    const ok = await exchange(code, verifier);
    expect(ok.status).toBe(200);
    expect(await exchange(code, verifier)).toMatchObject({ status: 400, body: { error_description: "Authorization code already used" } });
    expect((await rawMcp(ok.body.access_token)).status).toBe(401);
    expect(await outcome(caller(teacher.user).mcpConnector.approve({ request }))).toBe("PRECONDITION_FAILED:OAUTH_REQUEST_INVALID");
  });

  it("denies teachers without an active subscription and students at consent", async () => {
    const teacher = await makeTeacher("Abunəsiz");
    const { request } = await startGrant();
    expect((await caller(teacher.user).mcpConnector.consent({ request })).entitlement.status).toBe("NONE");
    expect(await outcome(caller(teacher.user).mcpConnector.approve({ request }))).toBe("FORBIDDEN:MCP_NOT_ENABLED");

    await entitle(teacher.user.id, { expiresAt: new Date(Date.now() - 60_000) });
    expect(await outcome(caller(teacher.user).mcpConnector.approve({ request }))).toBe("FORBIDDEN:MCP_ENTITLEMENT_EXPIRED");

    const student = await makeUser("Tələbə");
    await entitle(student.id);
    const other = await startGrant();
    expect((await caller(student).mcpConnector.consent({ request: other.request })).isTeacher).toBe(false);
    expect(await outcome(caller(student).mcpConnector.approve({ request: other.request }))).toBe("FORBIDDEN:NO_WORKSPACE");

    const denied = await caller(teacher.user).mcpConnector.deny({ request: other.request });
    expect(new URL(denied.redirectTo).searchParams.get("error")).toBe("access_denied");
  });

  it("an expired subscription blocks an existing token on the next MCP call and refuses refresh", async () => {
    const teacher = await makeTeacher("Bitən");
    await entitle(teacher.user.id, { expiresAt: new Date(Date.now() + 86_400_000) });
    const tokens = await connect(teacher);
    expect((await rawMcp(tokens.access_token)).status).toBe(200);

    await entitle(teacher.user.id, { expiresAt: new Date(Date.now() - 1000) });
    const blocked = await rawMcp(tokens.access_token);
    expect(blocked.status).toBe(403);
    const body = (await blocked.json()) as { error: { message: string; data: { reason: string } } };
    expect(body.error.data.reason).toBe("MCP_ENTITLEMENT_EXPIRED");
    expect(body.error.message).toMatch(/expired/i);

    const refresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: "invalid_grant", error_description: expect.stringContaining("MCP_ENTITLEMENT_EXPIRED") });

    const audit = await db().select().from(mcpAuditLog).where(and(eq(mcpAuditLog.userId, teacher.user.id), eq(mcpAuditLog.tool, "mcp:request")));
    expect(audit.map((a) => `${a.status}:${a.errorCode}`)).toContain("DENIED:MCP_ENTITLEMENT_EXPIRED");
  });

  it("an admin revocation stops tokens at once", async () => {
    const teacher = await makeTeacher("Ləğv");
    await entitle(teacher.user.id);
    const tokens = await connect(teacher);
    await entitle(teacher.user.id, { enabled: false });
    const res = await rawMcp(tokens.access_token);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { data: { reason: string } } }).error.data.reason).toBe("MCP_NOT_ENABLED");
  });

  it("enforces granted scopes per tool and audits the denial", async () => {
    const teacher = await makeTeacher("Scope");
    await entitle(teacher.user.id);
    const tokens = await connect(teacher, "groups:read");
    expect(tokens.scope).toBe("groups:read");
    const client = await mcpClient(tokens.access_token);
    const denied = await call(client, "create_exam", { title: "X", duration_minutes: 10, questions: [mcQuestion("q")] });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("exams:write");
    await client.close();
    const [row] = await db().select().from(mcpAuditLog).where(and(eq(mcpAuditLog.userId, teacher.user.id), eq(mcpAuditLog.tool, "create_exam")));
    expect(row).toMatchObject({ status: "DENIED", errorCode: "INSUFFICIENT_SCOPE" });
  });

  it("sends to individual students only within the teacher's own roster and resources", async () => {
    const a = await makeTeacher("Müəllim A");
    const b = await makeTeacher("Müəllim B");
    const mine = await makeUser("A tələbəsi");
    const theirs = await makeUser("B tələbəsi");
    await makeGroup(a.scope, [mine]);
    const bGroup = await makeGroup(b.scope, [theirs]);
    const bExam = await publishedAssessment(b.scope);
    await entitle(a.user.id);
    const client = await mcpClient((await connect(a)).access_token);

    const exam = json(await call(client, "create_exam", { title: "Fərdi", duration_minutes: 20, questions: [mcQuestion("q")] }));
    const sent = json(await call(client, "send_assignment", { kind: "exam", id: exam.exam_id, student_ids: [mine.id], confirm: true }));
    expect(sent).toMatchObject({ sent: true, students: [{ id: mine.id }] });
    const rows = await db().select().from(assessmentAssignments).where(eq(assessmentAssignments.assessmentId, exam.exam_id));
    expect(rows).toEqual([expect.objectContaining({ studentId: mine.id, groupId: null, status: "ACTIVE" })]);

    const foreignStudent = await call(client, "send_assignment", { kind: "exam", id: exam.exam_id, student_ids: [theirs.id], confirm: true });
    expect(foreignStudent.isError).toBe(true);
    expect(foreignStudent.content[0].text).toContain("Student not found");
    const foreignGroup = await call(client, "send_assignment", { kind: "exam", id: exam.exam_id, group_ids: [bGroup.id], confirm: true });
    expect(foreignGroup.isError).toBe(true);
    const foreignExam = await call(client, "send_assignment", { kind: "exam", id: bExam.id, student_ids: [mine.id], confirm: true });
    expect(foreignExam).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Not found") }] });
    expect(await db().select().from(assessmentAssignments).where(and(eq(assessmentAssignments.assessmentId, bExam.id), eq(assessmentAssignments.studentId, mine.id)))).toHaveLength(0);
    const foreignResults = await call(client, "get_results", { student_id: theirs.id });
    expect(foreignResults.isError).toBe(true);

    const task = await tasks.createAssignment(a.scope, { title: "Ev tapşırığı", description: "", instructions: "", deadline: new Date(Date.now() + 86_400_000), groupIds: [], studentIds: [], attachments: [], accessMode: "PUBLIC" }, { notify: false });
    const taskPreview = json(await call(client, "send_assignment", { kind: "task", id: task.id, student_ids: [mine.id], confirm: false, notify_students: false }));
    expect(taskPreview).toMatchObject({ sent: false, kind: "task" });
    const taskSent = json(await call(client, "send_assignment", { kind: "task", id: task.id, student_ids: [mine.id], confirm: true, notify_students: false }));
    expect(taskSent).toMatchObject({ sent: true, kind: "task" });
    const [taskRow] = await db().select().from(tasksTable).where(eq(tasksTable.id, task.id));
    expect(taskRow.studentIds).toEqual([mine.id]);
    expect((await call(client, "send_assignment", { kind: "task", id: task.id, student_ids: [theirs.id], confirm: true })).isError).toBe(true);
    await client.close();
  });
});

describe("Claude connector subscription requests", () => {
  it("keeps one open upgrade request per teacher and notifies admins once", async () => {
    const admin = await makeAdmin("SUPER_ADMIN");
    const teacher = await makeTeacher("Abunə istəyən");
    const notices = async () =>
      (await db().select().from(notifications).where(and(eq(notifications.userId, admin.id), like(notifications.body, `%${teacher.user.email}%`)))).length;

    const outcomes = await Promise.all([1, 2, 3].map(() => caller(teacher.user).mcpConnector.requestUpgrade()));
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["ALREADY_OPEN", "ALREADY_OPEN", "CREATED"]);
    expect((await caller(teacher.user).mcpConnector.requestUpgrade()).outcome).toBe("ALREADY_OPEN");
    expect(await db().select().from(mcpUpgradeRequests).where(eq(mcpUpgradeRequests.userId, teacher.user.id))).toEqual([expect.objectContaining({ status: "OPEN" })]);
    expect(await notices()).toBe(1);
    expect((await caller(teacher.user).mcpConnector.status()).upgradeRequested).toBe(true);

    await closeUpgradeRequest({ userId: admin.id } as never, teacher.user.id);
    expect((await caller(teacher.user).mcpConnector.requestUpgrade()).outcome).toBe("CREATED");
    expect(await notices()).toBe(2);

    await entitle(teacher.user.id);
    expect((await caller(teacher.user).mcpConnector.requestUpgrade()).outcome).toBe("ALREADY_ACTIVE");
    const status = await caller(teacher.user).mcpConnector.status();
    expect(status.entitlement.status).toBe("ACTIVE");
    expect(status.connectorUrl).toMatch(/\/mcp$/);
  });

  it("admins grant with an end date and revoke; others cannot", async () => {
    const admin = await makeAdmin("SUPER_ADMIN");
    const teacher = await makeTeacher("Admin verir");
    await caller(teacher.user).mcpConnector.requestUpgrade();
    expect(await outcome(caller(teacher.user).admin.ai.grantMcp({ userId: teacher.user.id, plan: "premium", expiresAt: null }))).toMatch(/^FORBIDDEN/);

    const until = new Date(Date.now() + 30 * 86_400_000);
    const adminCaller = caller(admin, {}, { session: { issuedAtMs: Date.now(), authTimeMs: Date.now() } });
    const granted = await adminCaller.admin.ai.grantMcp({ userId: teacher.user.id, plan: "premium", expiresAt: until, note: "Okt" });
    expect(granted).toMatchObject({ status: "ACTIVE", plan: "premium" });
    expect(await db().select().from(mcpUpgradeRequests).where(eq(mcpUpgradeRequests.userId, teacher.user.id))).toEqual([expect.objectContaining({ status: "HANDLED" })]);
    const listed = (await adminCaller.admin.ai.teachers({ query: teacher.user.email! })).teachers.find((t) => t.id === teacher.user.id);
    expect(listed?.mcpConnector).toMatchObject({ status: "ACTIVE", requestedAt: null });
    expect(await outcome(adminCaller.admin.ai.grantMcp({ userId: teacher.user.id, plan: "premium", expiresAt: new Date(Date.now() - 1000) }))).toMatch(/^BAD_REQUEST/);

    expect(await adminCaller.admin.ai.revokeMcp({ userId: teacher.user.id })).toMatchObject({ status: "DISABLED" });
  });
});

describe("migration 0059 demo seed", () => {
  const seed = readFileSync(path.resolve(import.meta.dirname, "../../drizzle/0059_mcp_connector.sql"), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .find((s) => s.includes("INSERT IGNORE INTO `mcp_entitlements`"))!
    .replace(/^--.*$/gm, "")
    .trim();
  const demo = () => db().select().from(mcpEntitlements).innerJoin(users, eq(users.id, mcpEntitlements.userId)).where(eq(users.email, "telmanabdulladev@gmail.com"));

  it("is a no-op without the account and grants a no-expiry demo plan once it exists", async () => {
    await db().execute(sql.raw(seed));
    expect(await demo()).toHaveLength(0);
    const user = await makeUser("Telman");
    await db().update(users).set({ email: "telmanabdulladev@gmail.com" }).where(eq(users.id, user.id));
    await db().execute(sql.raw(seed));
    await db().execute(sql.raw(seed));
    const rows = await demo();
    expect(rows).toHaveLength(1);
    expect(rows[0].mcp_entitlements).toMatchObject({ enabled: true, plan: "demo", expiresAt: null });
  });
});

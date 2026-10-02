import { COOKIE_NAME, WORKSPACE_HEADER } from "@shared/const";
import { and, desc, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLogs, partnerProfiles, platformRoles, securityEvents, type User } from "../../drizzle/schema";
import type { SecurityEventType } from "../../shared/adminPermissions";
import { csrfGuard } from "../_core/csrf";
import { resetRateLimits } from "../_core/rateLimit";
import { sdk } from "../_core/sdk";
import { systemGrantRole, systemRevokeRole } from "../modules/admin/roles";
import { resetSecurityEventWindows, settleSecurityEvents } from "../modules/securityEvents";
import { caller, db, makeAdmin, makeGroup, makePartner, makeTeacher, makeUser, outcome, publishedAssessment, reloadUser, signedIn } from "./fixtures";

const REASON = "Dəstək sorğusu #123 üzrə yoxlama";
const fresh = { session: signedIn() };

beforeEach(async () => {
  resetRateLimits();
  await settleSecurityEvents();
  resetSecurityEventWindows();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const auditFor = (userId: number) => db().select().from(auditLogs).where(eq(auditLogs.userId, userId)).orderBy(desc(auditLogs.id));
async function eventsOf(type: SecurityEventType, where: { userId?: number; workspaceId?: string } = {}) {
  await settleSecurityEvents();
  const conds = [eq(securityEvents.type, type)];
  if (where.userId !== undefined) conds.push(eq(securityEvents.userId, where.userId));
  if (where.workspaceId) conds.push(eq(securityEvents.workspaceId, where.workspaceId));
  return db().select().from(securityEvents).where(and(...conds));
}

async function authenticate(token: string) {
  return sdk.authenticateRequest({ headers: { cookie: `${COOKIE_NAME}=${token}` } } as Request).then(
    () => "OK",
    (e: Error) => e.message,
  );
}
const tokenFor = (u: User) => sdk.createSessionToken(u.openId, { name: u.name ?? "" });
const tick = () => new Promise((r) => setTimeout(r, 5));

/** Every admin procedure, called with valid input. */
function adminCalls(c: ReturnType<typeof caller>, targetId: number) {
  return {
    me: () => c.admin.me(),
    suspend: () => c.admin.users.suspend({ userId: targetId, reason: REASON }),
    unsuspend: () => c.admin.users.unsuspend({ userId: targetId, reason: REASON }),
    revokeSessions: () => c.admin.users.revokeSessions({ userId: targetId, reason: REASON }),
    rolesList: () => c.admin.roles.list(),
    grant: () => c.admin.roles.grant({ userId: targetId, role: "SUPPORT_ADMIN", reason: REASON }),
    revoke: () => c.admin.roles.revoke({ userId: targetId, role: "SUPPORT_ADMIN", reason: REASON }),
    partnersList: () => c.admin.partners.list(),
    partnersDecide: () => c.admin.partners.decide({ id: 999999, decision: "APPROVE", reason: REASON }),
    auditList: () => c.admin.audit.list({ userId: targetId }),
    securityList: () => c.admin.security.list({}),
    securityReview: () => c.admin.security.review({ id: 999999, status: "REVIEWED", reason: REASON }),
    notify: () => c.system.notifyOwner({ title: "t", content: "c" }),
  };
}
const SUPER_ONLY = ["suspend", "unsuspend", "revokeSessions", "rolesList", "grant", "revoke", "partnersDecide", "securityReview", "notify"] as const;

describe("admin authorization", () => {
  it("refuses anonymous, student, teacher, partner and reserved-role users on every admin procedure", async () => {
    const target = await makeUser("Hədəf");
    const reserved = await makeAdmin("FINANCE_ADMIN");
    const people: [string, User | null][] = [
      ["anonymous", null],
      ["student", await makeUser("Tələbə")],
      ["teacher", (await makeTeacher("Müəllim")).user],
      ["partner", await makePartner("Partnyor")],
      ["reserved", reserved],
    ];
    for (const [label, person] of people) {
      const calls = adminCalls(caller(person, {}, fresh), target.id);
      for (const [name, call] of Object.entries(calls)) {
        const expected = person ? "FORBIDDEN:NOT_ADMIN" : /^UNAUTHORIZED/;
        expect([label, name, await outcome(call())]).toEqual([label, name, expect.stringMatching(expected)]);
      }
    }
    expect(await auditFor(target.id)).toHaveLength(0);
    const calls = Object.keys(adminCalls(caller(null), 0)).length;
    expect((await eventsOf("ADMIN_ACCESS_DENIED", { userId: reserved.id }))[0]).toMatchObject({ severity: "HIGH", occurrences: calls });
  });

  it("refuses SUPPORT_ADMIN on every SUPER_ADMIN action but allows read-only views", async () => {
    const support = await makeAdmin("SUPPORT_ADMIN");
    const target = await makeUser("Hədəf");
    const calls = adminCalls(caller(support, {}, fresh), target.id);
    for (const name of SUPER_ONLY) expect([name, await outcome(calls[name]())]).toEqual([name, "FORBIDDEN:ADMIN_PERMISSION"]);
    for (const name of ["me", "partnersList", "auditList", "securityList"] as const) expect([name, await outcome(calls[name]())]).toEqual([name, "OK"]);
    expect(await caller(support).admin.me()).toMatchObject({ roles: ["SUPPORT_ADMIN"] });
    expect(await auditFor(target.id)).toHaveLength(0);
  });

  it("ignores a SUPER_ADMIN row whose e-mail is not allowlisted, and a suspended admin", async () => {
    const unlisted = await makeAdmin("SUPER_ADMIN", { allowlisted: false });
    expect(await outcome(caller(unlisted).admin.me())).toBe("FORBIDDEN:NOT_ADMIN");
    const admin = await makeAdmin("SUPER_ADMIN");
    const support = await makeAdmin("SUPPORT_ADMIN");
    await caller(admin, {}, fresh).admin.users.suspend({ userId: support.id, reason: REASON });
    expect(await outcome(caller(await reloadUser(support.id), {}, fresh).admin.me())).toBe("FORBIDDEN:ACCOUNT_SUSPENDED");
  });

  it("requires a linked Google account for admins in production", async () => {
    const demoAdmin = await makeAdmin("SUPER_ADMIN", { google: false });
    expect(await outcome(caller(demoAdmin).admin.me())).toBe("OK");
    vi.stubEnv("APP_ENV", "production");
    expect(await outcome(caller(demoAdmin).admin.me())).toBe("FORBIDDEN:ADMIN_GOOGLE_REQUIRED");
    const googleAdmin = await makeAdmin("SUPER_ADMIN");
    expect(await outcome(caller(googleAdmin).admin.me())).toBe("OK");
  });

  it("requires a sign-in within the last hour for high-risk actions", async () => {
    const admin = await makeAdmin("SUPER_ADMIN");
    const target = await makeUser("Hədəf");
    const input = { userId: target.id, reason: REASON };
    expect(await outcome(caller(admin).admin.users.revokeSessions(input))).toBe("FORBIDDEN:REAUTH_REQUIRED");
    expect(await outcome(caller(admin, {}, { session: signedIn(61 * 60_000) }).admin.users.revokeSessions(input))).toBe("FORBIDDEN:REAUTH_REQUIRED");
    expect(await outcome(caller(admin, {}, { session: signedIn(59 * 60_000) }).admin.users.revokeSessions(input))).toBe("OK");
    expect(await outcome(caller(admin).admin.partners.list())).toBe("OK");
  });

  it("limits admin mutations to 20 per minute", async () => {
    const admin = await makeAdmin("SUPER_ADMIN");
    const target = await makeUser("Hədəf");
    const c = caller(admin, {}, fresh);
    for (let i = 0; i < 20; i++) expect(await outcome(c.admin.users.revokeSessions({ userId: target.id, reason: REASON }))).toBe("OK");
    expect(await outcome(c.admin.users.revokeSessions({ userId: target.id, reason: REASON }))).toBe("TOO_MANY_REQUESTS:RATE_LIMITED");
    expect(await outcome(c.admin.partners.list())).toBe("OK");
    expect(await eventsOf("RATE_LIMIT_BLOCK", { userId: admin.id })).toHaveLength(1);
  });
});

describe("suspension and session revocation", () => {
  it("suspends with one audit row, revokes open sessions and blocks every protected area", async () => {
    const admin = await makeAdmin("SUPER_ADMIN");
    const { user: target } = await makeTeacher("Hədəf müəllim");
    const oldToken = await tokenFor(target);
    expect(await authenticate(oldToken)).toBe("OK");
    await tick();

    expect(await caller(admin, {}, { ...fresh, requestId: "req-suspend-1" }).admin.users.suspend({ userId: target.id, reason: REASON })).toMatchObject({
      accountStatus: "SUSPENDED",
    });
    const row = await reloadUser(target.id);
    expect(row).toMatchObject({ accountStatus: "SUSPENDED" });
    expect(row.suspendedAt).toBeInstanceOf(Date);
    const audit = await auditFor(target.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorUserId: admin.id,
      actorAdminRole: "SUPER_ADMIN",
      action: "USER_SUSPENDED",
      targetType: "USER",
      targetId: String(target.id),
      reason: REASON,
      requestId: "req-suspend-1",
      beforeJson: { accountStatus: "ACTIVE" },
    });
    expect(audit[0].ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect((audit[0].afterJson as { sessionsValidAfter: string }).sessionsValidAfter).toBe(row.sessionsValidAfter!.toISOString());

    expect(await authenticate(oldToken)).toBe("Session revoked");
    const suspended = caller(row);
    expect(await outcome(suspended.teacher.dashboard())).toBe("FORBIDDEN:ACCOUNT_SUSPENDED");
    expect(await outcome(suspended.student.results())).toBe("FORBIDDEN:ACCOUNT_SUSPENDED");
    expect(await outcome(suspended.partner.dashboard())).toBe("FORBIDDEN:ACCOUNT_SUSPENDED");
    expect(await suspended.auth.me()).toMatchObject({ accountStatus: "SUSPENDED" });
    expect(await outcome(suspended.auth.logout())).toBe("OK");
    expect((await eventsOf("SUSPENDED_ACCESS", { userId: target.id }))[0].occurrences).toBe(3);

    await tick();
    expect(await caller(admin, {}, fresh).admin.users.unsuspend({ userId: target.id, reason: REASON })).toMatchObject({ accountStatus: "ACTIVE" });
    expect(await authenticate(oldToken)).toBe("Session revoked");
    expect(await authenticate(await tokenFor(target))).toBe("OK");
    expect(await outcome(caller(await reloadUser(target.id)).teacher.dashboard())).toBe("OK");
    expect((await auditFor(target.id)).map((a) => a.action)).toEqual(["USER_UNSUSPENDED", "USER_SUSPENDED"]);
  });

  it("refuses self-targeting, SUPER_ADMIN targets, repeated or missing-reason suspension without writing audit rows", async () => {
    const admin = await makeAdmin("SUPER_ADMIN");
    const otherSuper = await makeAdmin("SUPER_ADMIN");
    const target = await makeUser("Hədəf");
    const c = caller(admin, {}, fresh);
    expect(await outcome(c.admin.users.suspend({ userId: admin.id, reason: REASON }))).toBe("FORBIDDEN:CANNOT_TARGET_SELF");
    expect(await outcome(c.admin.users.suspend({ userId: otherSuper.id, reason: REASON }))).toBe("FORBIDDEN:TARGET_IS_SUPER_ADMIN");
    expect(await outcome(c.admin.users.suspend({ userId: target.id, reason: "" }))).toMatch(/^BAD_REQUEST/);
    expect(await outcome(c.admin.users.suspend({ userId: target.id, reason: "qısa" }))).toMatch(/^BAD_REQUEST/);
    expect(await outcome(c.admin.users.unsuspend({ userId: target.id, reason: REASON }))).toBe("CONFLICT:NOT_SUSPENDED");
    expect(await outcome(c.admin.users.suspend({ userId: 99_999_999, reason: REASON }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(await outcome(c.admin.users.suspend({ userId: target.id, reason: REASON }))).toBe("OK");
    expect(await outcome(c.admin.users.suspend({ userId: target.id, reason: REASON }))).toBe("CONFLICT:ALREADY_SUSPENDED");
    expect(await auditFor(target.id)).toHaveLength(1);
    expect(await auditFor(admin.id)).toHaveLength(0);
    expect(await auditFor(otherSuper.id)).toHaveLength(0);
  });

  it("lets students finish assessments already assigned by a suspended teacher", async () => {
    const admin = await makeAdmin("SUPER_ADMIN");
    const teacher = await makeTeacher("Dayandırılan müəllim");
    const student = await makeUser("Tələbə");
    const group = await makeGroup(teacher.scope, [student]);
    const assessment = await publishedAssessment(teacher.scope, { groupIds: [group.id] });
    await caller(admin, {}, fresh).admin.users.suspend({ userId: teacher.user.id, reason: REASON });
    expect(await outcome(caller(await reloadUser(teacher.user.id)).teacher.dashboard())).toBe("FORBIDDEN:ACCOUNT_SUSPENDED");
    const { attemptId } = await caller(student).student.start({ assessmentId: assessment.id });
    expect(await outcome(caller(student).student.submit({ attemptId }))).toBe("OK");
  });

  it("serializes concurrent suspensions of the same user", async () => {
    const a = await makeAdmin("SUPER_ADMIN");
    const b = await makeAdmin("SUPER_ADMIN");
    const target = await makeUser("Hədəf");
    const results = await Promise.all([a, b].map((admin) => outcome(caller(admin, {}, fresh).admin.users.suspend({ userId: target.id, reason: REASON }))));
    expect(results.sort()).toEqual(["CONFLICT:ALREADY_SUSPENDED", "OK"]);
    expect(await auditFor(target.id)).toHaveLength(1);
  });

  it("rolls back the suspension when the audit write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const admin = await makeAdmin("SUPER_ADMIN");
    const target = await makeUser("Hədəf");
    const tooLong = "x".repeat(100);
    expect(await outcome(caller(admin, {}, { ...fresh, requestId: tooLong }).admin.users.suspend({ userId: target.id, reason: REASON }))).toMatch(
      /^INTERNAL_SERVER_ERROR/,
    );
    expect(await reloadUser(target.id)).toMatchObject({ accountStatus: "ACTIVE", suspendedAt: null, sessionsValidAfter: null });
    expect(await auditFor(target.id)).toHaveLength(0);
  });

  it("revokes sessions without suspending: old tokens fail, new sign-ins work", async () => {
    const admin = await makeAdmin("SUPER_ADMIN");
    const target = await makeUser("Hədəf");
    const oldToken = await tokenFor(target);
    await tick();
    await caller(admin, {}, fresh).admin.users.revokeSessions({ userId: target.id, reason: REASON });
    expect(await authenticate(oldToken)).toBe("Session revoked");
    await tick();
    expect(await authenticate(await tokenFor(target))).toBe("OK");
    expect(await reloadUser(target.id)).toMatchObject({ accountStatus: "ACTIVE" });
    expect((await auditFor(target.id))[0]).toMatchObject({ action: "USER_SESSIONS_REVOKED", reason: REASON });
  });
});

describe("partner applications", () => {
  /**
   * `requestProfile`/`admin.partners.decide` are what's left of the old apply-and-get-reviewed
   * gate (no client UI calls them any more -- see `ensurePartnerProfile`'s doc comment). A row
   * this flow leaves in PENDING, INFO_REQUESTED, or REJECTED is never a real, lasting block any
   * more: the next time anything looks the profile up through `ensurePartnerProfile` (here,
   * `dashboard()`), it's auto-approved on the spot, with no admin in the loop. SUSPEND is the one
   * decision that still sticks, because it's the fraud-control lever this product actually has now.
   */
  it("auto-approves a PENDING/INFO_REQUESTED profile on next lookup, but suspend still sticks", async () => {
    const admin = await makeAdmin("SUPER_ADMIN");
    const applicant = await makeUser("Namizəd");
    const app = caller(applicant);
    expect(await app.partner.requestProfile({ answers: { audience: "Məktəb müəllimləri", channel: "Instagram" } })).toEqual({ status: "PENDING" });
    expect(await outcome(app.partner.requestProfile({ answers: { audience: "yenə" } }))).toBe("CONFLICT:PARTNER_EXISTS");
    const [profile] = await db().select().from(partnerProfiles).where(eq(partnerProfiles.userId, applicant.id));
    const decide = (decision: "APPROVE" | "REJECT" | "REQUEST_INFO" | "SUSPEND" | "REACTIVATE", reason = REASON) =>
      outcome(caller(admin, {}, fresh).admin.partners.decide({ id: profile.id, decision, reason }));

    expect(await decide("REQUEST_INFO")).toBe("OK");
    // Still genuinely PENDING/INFO_REQUESTED in the DB -- nothing has looked it up yet to trigger
    // the auto-approve, so SUSPEND (APPROVED-only) is still correctly rejected here.
    expect(await decide("SUSPEND")).toBe("PRECONDITION_FAILED:INVALID_TRANSITION");
    expect(await decide("SUSPEND", "")).toMatch(/^BAD_REQUEST/);
    expect(await app.partner.requestProfile({ answers: { audience: "Riyaziyyat müəllimləri", channel: "Telegram" } })).toEqual({ status: "PENDING" });

    // First lookup through ensurePartnerProfile: the leftover PENDING row is auto-approved, with
    // no admin decision behind it -- dashboard() succeeds instead of staying FORBIDDEN.
    expect(await outcome(app.partner.dashboard())).toBe("OK");
    const [approved] = await db().select().from(partnerProfiles).where(eq(partnerProfiles.id, profile.id));
    expect(approved).toMatchObject({ status: "APPROVED", decidedBy: null, applicationAnswers: { audience: "Riyaziyyat müəllimləri", channel: "Telegram" } });
    expect(approved.decidedAt).toBeNull(); // auto-approved, not an admin decision
    expect(approved.approvedAt).toBeInstanceOf(Date);

    // An explicit APPROVE is no longer a valid transition once it's already APPROVED.
    expect(await decide("APPROVE")).toBe("PRECONDITION_FAILED:INVALID_TRANSITION");
    // SUSPEND is the real, lasting gate -- it still works, and still sticks.
    expect(await decide("SUSPEND")).toBe("OK");
    expect(await outcome(app.partner.dashboard())).toBe("FORBIDDEN:PARTNER_ONLY");

    const audit = await auditFor(applicant.id);
    expect(audit.map((a) => a.action).reverse()).toEqual([
      "PARTNER_APPLIED",
      "PARTNER_INFO_REQUESTED",
      "PARTNER_APPLICATION_UPDATED",
      "PARTNER_APPROVED",
      "PARTNER_SUSPENDED",
    ]);
    const applied = audit[audit.length - 1];
    expect(applied).toMatchObject({ actorUserId: applicant.id, actorAdminRole: null, afterJson: { status: "PENDING", answeredFields: ["audience", "channel"] } });
    const autoApproved = audit.find((a) => a.action === "PARTNER_APPROVED")!;
    expect(autoApproved).toMatchObject({ actorUserId: null, actorAdminRole: "SYSTEM", afterJson: { status: "APPROVED" } });
    expect(JSON.stringify(audit)).not.toContain("Riyaziyyat");
  });

  it("auto-approves a REJECTED profile on next lookup too -- REJECTED only ever meant the old review didn't pass, which no longer applies to anyone", async () => {
    const admin = await makeAdmin("SUPER_ADMIN");
    const applicant = await makeUser("Namizəd");
    const app = caller(applicant);
    await app.partner.requestProfile();
    const [profile] = await db().select().from(partnerProfiles).where(eq(partnerProfiles.userId, applicant.id));
    expect(await outcome(caller(admin, {}, fresh).admin.partners.decide({ id: profile.id, decision: "REJECT", reason: REASON }))).toBe("OK");
    expect(await outcome(app.partner.dashboard())).toBe("OK");
    const [row] = await db().select().from(partnerProfiles).where(eq(partnerProfiles.id, profile.id));
    expect(row).toMatchObject({ status: "APPROVED", decidedBy: null });
  });

  it("does not let an admin decide their own application", async () => {
    const admin = await makeAdmin("SUPER_ADMIN");
    await caller(admin).partner.requestProfile();
    const [own] = await db().select().from(partnerProfiles).where(eq(partnerProfiles.userId, admin.id));
    expect(await outcome(caller(admin, {}, fresh).admin.partners.decide({ id: own.id, decision: "APPROVE", reason: REASON }))).toBe(
      "FORBIDDEN:CANNOT_TARGET_SELF",
    );
  });
});

describe("platform roles", () => {
  it("lets SUPER_ADMIN grant and revoke SUPPORT_ADMIN only, with audit and security events", async () => {
    const admin = await makeAdmin("SUPER_ADMIN");
    const staff = await makeUser("Dəstək");
    const c = caller(admin, {}, fresh);
    expect(await outcome(c.admin.roles.grant({ userId: staff.id, role: "SUPPORT_ADMIN", reason: REASON }))).toBe("OK");
    expect(await caller(staff).admin.me()).toMatchObject({ roles: ["SUPPORT_ADMIN"] });
    expect(await outcome(c.admin.roles.grant({ userId: staff.id, role: "SUPPORT_ADMIN", reason: REASON }))).toBe("CONFLICT:ALREADY_HAS_ROLE");
    expect(await outcome(c.admin.roles.grant({ userId: staff.id, role: "SUPER_ADMIN", reason: REASON }))).toBe("FORBIDDEN:ROLE_NOT_GRANTABLE");
    expect(await outcome(c.admin.roles.grant({ userId: staff.id, role: "FINANCE_ADMIN", reason: REASON }))).toBe("FORBIDDEN:ROLE_NOT_GRANTABLE");
    expect(await outcome(c.admin.roles.grant({ userId: admin.id, role: "SUPPORT_ADMIN", reason: REASON }))).toBe("FORBIDDEN:CANNOT_TARGET_SELF");
    expect(await outcome(c.admin.roles.revoke({ userId: admin.id, role: "SUPER_ADMIN", reason: REASON }))).toBe("FORBIDDEN:ROLE_NOT_GRANTABLE");
    expect(await outcome(c.admin.roles.revoke({ userId: staff.id, role: "SUPPORT_ADMIN", reason: REASON }))).toBe("OK");
    expect(await outcome(caller(staff).admin.me())).toBe("FORBIDDEN:NOT_ADMIN");
    expect((await auditFor(staff.id)).map((a) => a.action)).toEqual(["ROLE_REVOKED", "ROLE_GRANTED"]);
    expect(await eventsOf("ADMIN_ROLE_CHANGED", { userId: staff.id })).toHaveLength(1);
  });

  it("lets the ops path grant SUPER_ADMIN only to allowlisted e-mails and never remove the last one", async () => {
    await db().delete(platformRoles).where(eq(platformRoles.role, "SUPER_ADMIN"));
    const owner = await makeUser("Sahib");
    await expect(systemGrantRole(owner.id, owner.email, "SUPER_ADMIN", REASON, [])).rejects.toThrow("ROLE_NOT_GRANTABLE");
    await systemGrantRole(owner.id, owner.email, "SUPER_ADMIN", REASON, [owner.email!]);
    expect((await auditFor(owner.id))[0]).toMatchObject({ actorUserId: null, actorAdminRole: "SYSTEM", action: "ROLE_GRANTED", afterJson: { role: "SUPER_ADMIN" } });
    await expect(systemRevokeRole(owner.id, "SUPER_ADMIN", REASON)).rejects.toThrow("LAST_SUPER_ADMIN");
    const second = await makeAdmin("SUPER_ADMIN");
    await systemRevokeRole(owner.id, "SUPER_ADMIN", REASON);
    await expect(systemRevokeRole(second.id, "SUPER_ADMIN", REASON)).rejects.toThrow("LAST_SUPER_ADMIN");

    const third = await makeAdmin("SUPER_ADMIN");
    const results = await Promise.allSettled([second, third].map((u) => systemRevokeRole(u.id, "SUPER_ADMIN", REASON)));
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toContain("LAST_SUPER_ADMIN");
    expect(await db().select().from(platformRoles).where(eq(platformRoles.role, "SUPER_ADMIN"))).toHaveLength(1);
  });
});

describe("audit log access", () => {
  it("shows SUPPORT_ADMIN only entries of the user being inspected", async () => {
    const admin = await makeAdmin("SUPER_ADMIN");
    const support = await makeAdmin("SUPPORT_ADMIN");
    const a = await makeUser("A");
    const b = await makeUser("B");
    await caller(admin, {}, fresh).admin.users.revokeSessions({ userId: a.id, reason: REASON });
    await caller(admin, {}, fresh).admin.users.revokeSessions({ userId: b.id, reason: REASON });
    expect(await outcome(caller(support).admin.audit.list({}))).toBe("FORBIDDEN:FORBIDDEN");
    const rows = await caller(support).admin.audit.list({ userId: a.id });
    expect(rows.map((r) => r.userId)).toEqual([a.id]);
    const all = await caller(admin).admin.audit.list({ action: "USER_SESSIONS_REVOKED", limit: 200 });
    expect(all.map((r) => r.userId)).toEqual(expect.arrayContaining([a.id, b.id]));
  });
});

describe("security events", () => {
  it("records a workspace header spoof only for a real foreign workspace and merges repeats", async () => {
    const a = await makeTeacher("A");
    const b = await makeTeacher("B");
    const spoof = caller(a.user, { [WORKSPACE_HEADER]: b.workspaceId });
    for (let i = 0; i < 3; i++) expect(await outcome(spoof.teacher.dashboard())).toBe("FORBIDDEN:NO_WORKSPACE");
    const rows = await eventsOf("WORKSPACE_HEADER_SPOOF", { userId: a.user.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: b.workspaceId, occurrences: 3, severity: "MEDIUM", status: "REVIEW_REQUIRED" });
    expect(await outcome(caller(a.user, { [WORKSPACE_HEADER]: "ws_does_not_exist" }).teacher.dashboard())).toBe("FORBIDDEN:NO_WORKSPACE");
    expect(await eventsOf("WORKSPACE_HEADER_SPOOF", { workspaceId: "ws_does_not_exist" })).toHaveLength(0);
  });

  it("records rate-limit blocks and CSRF rejections, and lets SUPER_ADMIN review them with audit", async () => {
    const anon = caller(null);
    for (let i = 0; i < 20; i++) await outcome(anon.auth.demoLogin({ role: "TEACHER" }));
    expect(await outcome(anon.auth.demoLogin({ role: "TEACHER" }))).toBe("TOO_MANY_REQUESTS:RATE_LIMITED");
    const blocks = (await eventsOf("RATE_LIMIT_BLOCK")).filter((e) => (e.details as { limiter?: string })?.limiter === "demoLogin");
    expect(blocks.length).toBeGreaterThanOrEqual(1);

    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    const next = vi.fn();
    csrfGuard(
      { method: "POST", path: "/api/trpc/admin.users.suspend", ip: "198.51.100.7", headers: { origin: "https://evil.example" }, get: () => "resulio.co" } as unknown as Request,
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    const [csrf] = (await eventsOf("CSRF_REJECTED")).filter((e) => (e.details as { path?: string })?.path === "/api/trpc/admin.users.suspend");
    expect(csrf).toMatchObject({ severity: "MEDIUM", occurrences: 1 });

    const support = await makeAdmin("SUPPORT_ADMIN");
    const admin = await makeAdmin("SUPER_ADMIN");
    expect((await caller(support).admin.security.list({ type: "CSRF_REJECTED" })).map((e) => e.id)).toContain(csrf.id);
    expect(await outcome(caller(support, {}, fresh).admin.security.review({ id: csrf.id, status: "DISMISSED", reason: REASON }))).toBe(
      "FORBIDDEN:ADMIN_PERMISSION",
    );
    expect(await caller(admin, {}, fresh).admin.security.review({ id: csrf.id, status: "REVIEWED", reason: REASON })).toEqual({ id: csrf.id, status: "REVIEWED" });
    const [reviewed] = await db().select().from(securityEvents).where(eq(securityEvents.id, csrf.id));
    expect(reviewed).toMatchObject({ status: "REVIEWED", reviewedBy: admin.id });
    const [audit] = await db().select().from(auditLogs).where(and(eq(auditLogs.action, "SECURITY_EVENT_REVIEWED"), eq(auditLogs.targetId, String(csrf.id))));
    expect(audit).toMatchObject({ actorUserId: admin.id, reason: REASON, afterJson: { status: "REVIEWED" } });
  });
});

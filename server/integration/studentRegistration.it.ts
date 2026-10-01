import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { authAccounts, groupEmailInvites, groupMembers, users } from "../../drizzle/schema";
import { resetRateLimits } from "../_core/rateLimit";
import * as db from "../db";
import { defaultContext, resolveAccess } from "../modules/access";
import * as emailInvites from "../modules/groupEmailInvites";
import * as groups from "../modules/groups";
import { caller, db as testDb, makeTeacher, makeUser, outcome } from "./fixtures";

beforeEach(() => resetRateLimits());

// ---------------------------------------------------------------------------
// Google-only auth: one provider identity maps to exactly one internal user
// ---------------------------------------------------------------------------

describe("Google auth identity dedup", () => {
  it("the same Google sub always resolves to the same internal user, never a duplicate", async () => {
    const sub = `sub_${Date.now()}_a`;
    const first = await db.upsertProviderUser({ provider: "google", providerAccountId: sub, email: "dedup.a@example.test", name: "A", avatarUrl: null });
    const second = await db.upsertProviderUser({ provider: "google", providerAccountId: sub, email: "dedup.a@example.test", name: "A renamed", avatarUrl: null });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("A renamed"); // refreshed from the latest Google profile
    const links = await testDb().select().from(authAccounts).where(eq(authAccounts.providerAccountId, sub));
    expect(links).toHaveLength(1);
  });

  it("attaches to a pre-existing (pre-auth_accounts) user by verified email instead of duplicating it", async () => {
    const legacy = await makeUser("Legacy istifadəçi");
    await testDb().update(users).set({ email: "legacy.dedup@example.test" }).where(eq(users.id, legacy.id));
    const linked = await db.upsertProviderUser({
      provider: "google",
      providerAccountId: `sub_${Date.now()}_legacy`,
      email: "legacy.dedup@example.test",
      name: legacy.name,
      avatarUrl: null,
    });
    expect(linked.id).toBe(legacy.id);
    const links = await testDb().select().from(authAccounts).where(eq(authAccounts.userId, legacy.id));
    expect(links).toHaveLength(1);
  });

  it("two different Google accounts sharing an email never collapse into one user", async () => {
    const email = `shared.${Date.now()}@example.test`;
    const first = await db.upsertProviderUser({ provider: "google", providerAccountId: `sub_${Date.now()}_x`, email, name: "X", avatarUrl: null });
    const second = await db.upsertProviderUser({ provider: "google", providerAccountId: `sub_${Date.now()}_y`, email, name: "Y", avatarUrl: null });
    expect(second.id).not.toBe(first.id);
  });
});

// ---------------------------------------------------------------------------
// Group-code entry path
// ---------------------------------------------------------------------------

describe("student entry via group code", () => {
  it("joins PENDING when auto-join is off, ACTIVE when it's on", async () => {
    const teacher = await makeTeacher("Kod müəllimi");
    const off = await groups.createGroup(teacher.scope, { name: "Auto-join off", subject: "", grade: "", description: "" });
    const on = await groups.createGroup(teacher.scope, { name: "Auto-join on", subject: "", grade: "", description: "" });
    await groups.setAutoJoin(teacher.scope, on.id, true);

    const s1 = await makeUser("Tələbə off");
    const joined1 = await groups.joinByInvite(s1.id, off.inviteCode);
    expect(joined1.status).toBe("PENDING");

    const s2 = await makeUser("Tələbə on");
    const joined2 = await groups.joinByInvite(s2.id, on.inviteCode);
    expect(joined2.status).toBe("ACTIVE");
  });

  it("regenerating the code invalidates the old one immediately", async () => {
    const teacher = await makeTeacher("Regenerate müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Regenerate", subject: "", grade: "", description: "" });
    const oldCode = group.inviteCode;
    await groups.regenerateInviteCode(teacher.scope, group.id);
    const student = await makeUser("Gec gələn");
    await expect(groups.joinByInvite(student.id, oldCode)).rejects.toThrow("INVITE_NOT_FOUND");
  });

  it("rejects a second join and the group owner joining their own group", async () => {
    const teacher = await makeTeacher("Owner müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Owner", subject: "", grade: "", description: "" });
    await expect(groups.joinByInvite(teacher.user.id, group.inviteCode)).rejects.toThrow("CANNOT_JOIN_OWN_GROUP");
    const student = await makeUser("İkiqat qoşulan");
    await groups.joinByInvite(student.id, group.inviteCode);
    await expect(groups.joinByInvite(student.id, group.inviteCode)).rejects.toThrow("ALREADY_MEMBER");
  });

  it("rate-limits repeated join attempts per user", async () => {
    const student = await makeUser("Rate-limit tələbəsi");
    const s = caller(student).student;
    for (let i = 0; i < 10; i++) expect(await outcome(s.join({ inviteCode: "NOPE-NOPE" }))).toBe("NOT_FOUND:INVITE_NOT_FOUND");
    expect(await outcome(s.join({ inviteCode: "NOPE-NOPE" }))).toBe("TOO_MANY_REQUESTS:RATE_LIMITED");
  });
});

// ---------------------------------------------------------------------------
// Email-specific invitation
// ---------------------------------------------------------------------------

describe("student entry via email invite", () => {
  it("activates membership immediately even when the group requires approval, because the email already proves the target", async () => {
    const teacher = await makeTeacher("Email müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Email group", subject: "", grade: "", description: "" });
    expect(group.autoJoinEnabled).toBe(false);
    const { token } = await emailInvites.createEmailInvite(teacher.scope, group.id, "matching@example.test");
    const student = await makeUser("Email uyğun tələbə");
    await testDb().update(users).set({ email: "matching@example.test" }).where(eq(users.id, student.id));
    const result = await emailInvites.acceptEmailInvite(student.id, "matching@example.test", token);
    expect(result.groupId).toBe(group.id);
    const [membership] = await testDb().select().from(groupMembers).where(eq(groupMembers.userId, student.id));
    expect(membership.status).toBe("ACTIVE");
  });

  it("the preview never leaks the invited email address", async () => {
    const teacher = await makeTeacher("Preview müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Preview group", subject: "", grade: "", description: "" });
    const { token } = await emailInvites.createEmailInvite(teacher.scope, group.id, "secret@example.test");
    const preview = await emailInvites.publicEmailInvitePreview(token);
    expect(preview).not.toBeNull();
    expect(JSON.stringify(preview)).not.toContain("secret@example.test");
  });

  it("blocks a Google account whose email doesn't match the invited address", async () => {
    const teacher = await makeTeacher("Mismatch müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Mismatch group", subject: "", grade: "", description: "" });
    const { token } = await emailInvites.createEmailInvite(teacher.scope, group.id, "invited@example.test");
    const student = await makeUser("Yanlış hesab");
    await expect(emailInvites.acceptEmailInvite(student.id, "someone-else@example.test", token)).rejects.toThrow("EMAIL_INVITE_MISMATCH");
    const membership = await testDb().select().from(groupMembers).where(eq(groupMembers.userId, student.id));
    expect(membership).toHaveLength(0);
  });

  it("a revoked invite can never be accepted again", async () => {
    const teacher = await makeTeacher("Revoke müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Revoke group", subject: "", grade: "", description: "" });
    const { id: inviteId, token } = await emailInvites.createEmailInvite(teacher.scope, group.id, "revoked@example.test");
    await emailInvites.revokeEmailInvite(teacher.scope, group.id, inviteId);
    const student = await makeUser("Revoke sonrası");
    await expect(emailInvites.acceptEmailInvite(student.id, "revoked@example.test", token)).rejects.toThrow("EMAIL_INVITE_NOT_FOUND");
  });

  it("resend invalidates the old token and issues a new one-time token", async () => {
    const teacher = await makeTeacher("Resend müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Resend group", subject: "", grade: "", description: "" });
    const { id: inviteId, token: oldToken } = await emailInvites.createEmailInvite(teacher.scope, group.id, "resend@example.test");
    const { token: newToken } = await emailInvites.resendEmailInvite(teacher.scope, group.id, inviteId);
    expect(newToken).not.toBe(oldToken);
    const student = await makeUser("Resend tələbəsi");
    await expect(emailInvites.acceptEmailInvite(student.id, "resend@example.test", oldToken)).rejects.toThrow("EMAIL_INVITE_NOT_FOUND");
    const result = await emailInvites.acceptEmailInvite(student.id, "resend@example.test", newToken);
    expect(result.groupId).toBe(group.id);
  });

  it("a token cannot be redeemed twice (one-time use)", async () => {
    const teacher = await makeTeacher("Onetime müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Onetime group", subject: "", grade: "", description: "" });
    const { token } = await emailInvites.createEmailInvite(teacher.scope, group.id, "onetime@example.test");
    const student = await makeUser("Onetime tələbə");
    await emailInvites.acceptEmailInvite(student.id, "onetime@example.test", token);
    await expect(emailInvites.acceptEmailInvite(student.id, "onetime@example.test", token)).rejects.toThrow("ALREADY_MEMBER");
  });

  it("an expired invite is rejected without being revoked", async () => {
    const teacher = await makeTeacher("Expired müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Expired group", subject: "", grade: "", description: "" });
    const { id: inviteId, token } = await emailInvites.createEmailInvite(teacher.scope, group.id, "expired@example.test");
    await testDb().update(groupEmailInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(groupEmailInvites.id, inviteId));
    const student = await makeUser("Gecikmiş tələbə");
    await expect(emailInvites.acceptEmailInvite(student.id, "expired@example.test", token)).rejects.toThrow("EMAIL_INVITE_EXPIRED");
  });

  it("the group owner cannot accept their own invite", async () => {
    const teacher = await makeTeacher("Öz dəvəti müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Self group", subject: "", grade: "", description: "" });
    const { token } = await emailInvites.createEmailInvite(teacher.scope, group.id, teacher.user.email ?? "");
    await expect(emailInvites.acceptEmailInvite(teacher.user.id, teacher.user.email ?? "", token)).rejects.toThrow("CANNOT_JOIN_OWN_GROUP");
  });

  it("revoke is now rate-limited (regression check for the previously-missing limiter)", async () => {
    const teacher = await makeTeacher("Revoke-limit müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Revoke-limit group", subject: "", grade: "", description: "" });
    const g = caller(teacher.user).teacher.groups;
    for (let i = 0; i < 30; i++) expect(await outcome(g.emailInviteRevoke({ groupId: group.id, inviteId: "missing" }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(await outcome(g.emailInviteRevoke({ groupId: group.id, inviteId: "missing" }))).toBe("TOO_MANY_REQUESTS:RATE_LIMITED");
  });
});

// ---------------------------------------------------------------------------
// Student → Teacher transition preserves existing student data
// ---------------------------------------------------------------------------

describe("student-to-teacher transition", () => {
  it("creating a Provider Workspace never touches the user's existing group membership", async () => {
    const otherTeacher = await makeTeacher("Digər müəllim");
    const group = await groups.createGroup(otherTeacher.scope, { name: "Öyrənmə qrupu", subject: "", grade: "", description: "" });
    await groups.setAutoJoin(otherTeacher.scope, group.id, true);
    const student = await makeUser("İkili istifadəçi");
    await groups.joinByInvite(student.id, group.inviteCode);

    const before = await testDb().select().from(groupMembers).where(eq(groupMembers.userId, student.id));
    expect(before).toHaveLength(1);
    expect(before[0].status).toBe("ACTIVE");

    const api = caller(student).workspaces;
    const ws = await api.create({ title: "Mənim tədris məkanım", publicDisplayName: "", providerType: "TEACHER" });
    expect(ws.ownerUserId).toBe(student.id);

    const after = await testDb().select().from(groupMembers).where(eq(groupMembers.userId, student.id));
    expect(after).toEqual(before); // byte-for-byte unchanged — same status, same joinedAt, same row

    const access = await resolveAccess(student.id);
    expect(access.contexts.learning).toBe(true);
    expect(access.contexts.teaching).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Direct sign-in with no invite: onboarding vs. dashboard contract
// ---------------------------------------------------------------------------

describe("direct sign-in default context", () => {
  it("a brand-new user with no memberships and no workspace gets no default context (the onboarding screen)", async () => {
    const fresh = await makeUser("Təzə istifadəçi");
    const access = await resolveAccess(fresh.id);
    expect(defaultContext(access, null)).toBeNull();
  });

  it("even a PENDING join is enough to leave the onboarding screen (shows the pending-approval state instead)", async () => {
    const teacher = await makeTeacher("Pending default-context müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Pending group", subject: "", grade: "", description: "" });
    const student = await makeUser("Gözləyən tələbə");
    await groups.joinByInvite(student.id, group.inviteCode);
    const access = await resolveAccess(student.id);
    expect(access.pendingMemberships).toBe(1);
    expect(defaultContext(access, null)).toBe("learning");
  });
});

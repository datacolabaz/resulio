import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { authAccounts, groupEmailInvites, groupMembers, shareEvents, users } from "../../drizzle/schema";
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
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.name).toBe("A renamed"); // refreshed from the latest Google profile
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
    expect(linked.isNew).toBe(false); // attached to the pre-existing row, not a fresh signup
    expect(linked.user.id).toBe(legacy.id);
    const links = await testDb().select().from(authAccounts).where(eq(authAccounts.userId, legacy.id));
    expect(links).toHaveLength(1);
  });

  it("two different Google accounts sharing an email never collapse into one user", async () => {
    const email = `shared.${Date.now()}@example.test`;
    const first = await db.upsertProviderUser({ provider: "google", providerAccountId: `sub_${Date.now()}_x`, email, name: "X", avatarUrl: null });
    const second = await db.upsertProviderUser({ provider: "google", providerAccountId: `sub_${Date.now()}_y`, email, name: "Y", avatarUrl: null });
    expect(second.user.id).not.toBe(first.user.id);
  });
});

// ---------------------------------------------------------------------------
// Group-code entry path
// ---------------------------------------------------------------------------

describe("student entry via group code", () => {
  it("a valid invite link joins ACTIVE at once, with no approval step", async () => {
    const teacher = await makeTeacher("Kod müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Instant join", subject: "", grade: "", description: "" });
    expect(group.joinPolicy).toBe("AUTO");

    const student = await makeUser("Linklə gələn");
    const joined = await groups.joinByInvite(student.id, group.inviteCode);
    expect(joined.status).toBe("ACTIVE");
    expect(joined.activatedPending).toBe(false);
    const [membership] = await testDb().select().from(groupMembers).where(eq(groupMembers.userId, student.id));
    expect(membership).toMatchObject({ groupId: group.id, status: "ACTIVE", id: joined.membershipId });
    expect(await groups.activeGroupIdsOfStudent(student.id)).toEqual([group.id]);
  });

  it("a request left PENDING from the approval era is activated when the student opens the valid link again", async () => {
    const teacher = await makeTeacher("Köhnə sorğu müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Legacy pending", subject: "", grade: "", description: "" });
    const student = await makeUser("Gözləyən tələbə (link)");
    await testDb().insert(groupMembers).values({ groupId: group.id, userId: student.id, status: "PENDING" });

    const joined = await groups.joinByInvite(student.id, group.inviteCode);
    expect(joined.status).toBe("ACTIVE");
    expect(joined.activatedPending).toBe(true);
    await expect(groups.joinByInvite(student.id, group.inviteCode)).rejects.toThrow("ALREADY_MEMBER");
  });

  it("the startup backfill activates only pending requests recorded as coming through the current, valid link", async () => {
    const teacher = await makeTeacher("Backfill müəllimi");
    const viaLink = await groups.createGroup(teacher.scope, { name: "Backfill via link", subject: "", grade: "", description: "" });
    const regenerated = await groups.createGroup(teacher.scope, { name: "Backfill regenerated", subject: "", grade: "", description: "" });
    const closed = await groups.createGroup(teacher.scope, { name: "Backfill closed", subject: "", grade: "", description: "" });
    const [proven, unproven, stale, refused] = await Promise.all(["Sübutlu", "Sübutsuz", "Köhnə kod", "Bağlı qrup"].map((n) => makeUser(n)));
    await testDb().insert(groupMembers).values([
      { groupId: viaLink.id, userId: proven.id, status: "PENDING" },
      { groupId: viaLink.id, userId: unproven.id, status: "PENDING" },
      { groupId: regenerated.id, userId: stale.id, status: "PENDING" },
      { groupId: closed.id, userId: refused.id, status: "PENDING" },
    ]);
    const joinedVia = (code: string, actorUserId: number) => ({ targetType: "GROUP" as const, targetId: code, channel: "DIRECT" as const, eventType: "JOINED" as const, actorUserId });
    await testDb().insert(shareEvents).values([joinedVia(viaLink.inviteCode, proven.id), joinedVia(regenerated.inviteCode, stale.id), joinedVia(closed.inviteCode, refused.id)]);
    await groups.regenerateInviteCode(teacher.scope, regenerated.id);
    await groups.setJoinPolicy(teacher.scope, closed.id, "MANUAL");

    // The backfill is global; other tests' PENDING rows (none with a recorded link join) may share the table.
    const activated = (await groups.activatePendingLinkJoins()).filter((a) => [proven.id, unproven.id, stale.id, refused.id].includes(a.userId));
    expect(activated.map((a) => a.userId)).toEqual([proven.id]);
    expect(activated[0]).toMatchObject({ groupId: viaLink.id, groupName: "Backfill via link", ownerUserId: teacher.user.id });
    const statusOf = async (userId: number) => (await testDb().select().from(groupMembers).where(eq(groupMembers.userId, userId)))[0].status;
    expect(await statusOf(proven.id)).toBe("ACTIVE");
    expect(await statusOf(unproven.id)).toBe("PENDING");
    expect(await statusOf(stale.id)).toBe("PENDING");
    expect(await statusOf(refused.id)).toBe("PENDING");
    expect((await groups.activatePendingLinkJoins()).map((a) => a.userId)).not.toContain(proven.id);
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

  it("MANUAL join policy refuses self-join by code even for a brand-new student", async () => {
    const teacher = await makeTeacher("Manual müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Manual only", subject: "", grade: "", description: "" });
    await groups.setJoinPolicy(teacher.scope, group.id, "MANUAL");
    const student = await makeUser("Manual tələbə");
    await expect(groups.joinByInvite(student.id, group.inviteCode)).rejects.toThrow("GROUP_NOT_ACCEPTING");
    // The teacher can still add the same student directly — MANUAL only blocks self-join.
    const added = await groups.addMemberByEmail(teacher.scope, group.id, student.email ?? "");
    expect(added.status).toBe("ACTIVE");
  });

  it("a deactivated code refuses new joins without changing its value", async () => {
    const teacher = await makeTeacher("Deaktiv müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Deactivated", subject: "", grade: "", description: "" });
    await groups.setInviteCodeActive(teacher.scope, group.id, false);
    const student = await makeUser("Deaktiv koda gələn");
    await expect(groups.joinByInvite(student.id, group.inviteCode)).rejects.toThrow("INVITE_CODE_INACTIVE");
    await groups.setInviteCodeActive(teacher.scope, group.id, true);
    const joined = await groups.joinByInvite(student.id, group.inviteCode);
    expect(joined.status).toBe("ACTIVE");
  });

  it("an expired code refuses joins; clearing the expiry lets them through again", async () => {
    const teacher = await makeTeacher("Son tarix müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Expiring", subject: "", grade: "", description: "" });
    await groups.setInviteCodeExpiry(teacher.scope, group.id, new Date(Date.now() - 1000));
    const student = await makeUser("Vaxtı bitmiş koda gələn");
    await expect(groups.joinByInvite(student.id, group.inviteCode)).rejects.toThrow("INVITE_CODE_EXPIRED");
    await groups.setInviteCodeExpiry(teacher.scope, group.id, null);
    const joined = await groups.joinByInvite(student.id, group.inviteCode);
    expect(joined.status).toBe("ACTIVE");
  });

  it("regenerating the code resets it to active with no expiry", async () => {
    const teacher = await makeTeacher("Regenerate-reset müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Regenerate reset", subject: "", grade: "", description: "" });
    await groups.setInviteCodeActive(teacher.scope, group.id, false);
    await groups.setInviteCodeExpiry(teacher.scope, group.id, new Date(Date.now() + 1000 * 3600));
    await groups.regenerateInviteCode(teacher.scope, group.id);
    const refreshed = await groups.assertGroupOwner(teacher.scope, group.id);
    expect(refreshed.codeActive).toBe(true);
    expect(refreshed.codeExpiresAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Email-specific invitation
// ---------------------------------------------------------------------------

describe("student entry via email invite", () => {
  it("activates membership immediately, even while self-join by code is closed, because the email already proves the target", async () => {
    const teacher = await makeTeacher("Email müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Email group", subject: "", grade: "", description: "" });
    await groups.setJoinPolicy(teacher.scope, group.id, "MANUAL");
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
    await groups.setJoinPolicy(otherTeacher.scope, group.id, "AUTO");
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

  it("even a PENDING join (left from the approval era) is enough to leave the onboarding screen", async () => {
    const teacher = await makeTeacher("Pending default-context müəllimi");
    const group = await groups.createGroup(teacher.scope, { name: "Pending group", subject: "", grade: "", description: "" });
    const student = await makeUser("Gözləyən tələbə");
    await testDb().insert(groupMembers).values({ groupId: group.id, userId: student.id, status: "PENDING" });
    const access = await resolveAccess(student.id);
    expect(access.pendingMemberships).toBe(1);
    expect(defaultContext(access, null)).toBe("learning");
  });
});

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { groupInviteLinks, groupMembers, groupMemberSources, notificationDeliveries, shareEvents } from "../../drizzle/schema";
import { resetRateLimits } from "../_core/rateLimit";
import * as activity from "../modules/activity";
import * as assessments from "../modules/assessments";
import { createEmailInvite } from "../modules/groupEmailInvites";
import { runJoinSourceBackfill } from "../modules/groupJoinSources";
import * as groups from "../modules/groups";
import { caller, db, makeGroup, makeTeacher, makeUser, outcome, publishedAssessment } from "./fixtures";

/**
 * Every way a student gets into a group (and so onto its exams), against real MySQL: single-use
 * links admit exactly one person even under concurrent redemption, the group code is multi-use
 * with an optional cap that concurrent joins can't overshoot, and each membership records how it
 * came to be.
 */

beforeEach(() => resetRateLimits());

const membersOf = (groupId: string) => db().select().from(groupMembers).where(eq(groupMembers.groupId, groupId));
const sourceOf = async (groupId: string, userId: number) =>
  (await db().select().from(groupMemberSources).where(and(eq(groupMemberSources.groupId, groupId), eq(groupMemberSources.userId, userId))))[0];

async function setupGroup() {
  const teacher = await makeTeacher("Müəllim");
  const group = await makeGroup(teacher.scope, []);
  return { teacher, group, api: caller(teacher.user) };
}

async function oneLink(setup: Awaited<ReturnType<typeof setupGroup>>, label = "") {
  const [link] = await setup.api.teacher.groups.inviteLinkCreate({ groupId: setup.group.id, labels: [label] });
  return link;
}

describe("single-use link /g/<token>", () => {
  it("sequential: the first student joins, a second is refused with INVITE_LINK_USED, the first may reopen it", async () => {
    const s = await setupGroup();
    const link = await oneLink(s, "Xəyalə");
    const [a, b] = [await makeUser("A"), await makeUser("B")];
    expect((await caller(a).student.redeemInviteLink({ token: link.token })).outcome).toBe("JOINED");
    expect(await outcome(caller(b).student.redeemInviteLink({ token: link.token }))).toBe("CONFLICT:INVITE_LINK_USED");
    expect((await caller(a).student.redeemInviteLink({ token: link.token })).outcome).toBe("ALREADY_REDEEMED");
    expect((await membersOf(s.group.id)).map((m) => m.userId)).toEqual([a.id]);
    expect(await sourceOf(s.group.id, a.id)).toMatchObject({ joinedVia: "SINGLE_USE_LINK", sourceId: link.id, actorUserId: a.id, backfilled: false });
  });

  it("concurrent: 10 different students race for one link, exactly one becomes a member", async () => {
    const s = await setupGroup();
    const link = await oneLink(s);
    const people = await Promise.all(Array.from({ length: 10 }, (_, i) => makeUser(`S${i}`)));
    const res = await Promise.allSettled(people.map((p) => caller(p).student.redeemInviteLink({ token: link.token })));
    expect(res.filter((r) => r.status === "fulfilled" && r.value.outcome === "JOINED")).toHaveLength(1);
    expect(res.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.message)).toEqual(Array(9).fill("INVITE_LINK_USED"));
    const members = await membersOf(s.group.id);
    expect(members).toHaveLength(1);
    const [row] = await db().select().from(groupInviteLinks).where(eq(groupInviteLinks.id, link.id));
    expect(row.usedByUserId).toBe(members[0].userId);
  });

  it("concurrent double-click by one student: one membership, one JOINED", async () => {
    const s = await setupGroup();
    const link = await oneLink(s);
    const a = await makeUser("A");
    const res = await Promise.allSettled(Array.from({ length: 5 }, () => caller(a).student.redeemInviteLink({ token: link.token })));
    expect(res.filter((r) => r.status === "fulfilled" && r.value.outcome === "JOINED")).toHaveLength(1);
    expect(await membersOf(s.group.id)).toHaveLength(1);
  });

  it("a removed student can't come back through the link they used", async () => {
    const s = await setupGroup();
    const link = await oneLink(s);
    const a = await makeUser("A");
    await caller(a).student.redeemInviteLink({ token: link.token });
    await groups.removeMember(s.teacher.scope, s.group.id, a.id);
    expect(await outcome(caller(a).student.redeemInviteLink({ token: link.token }))).toBe("CONFLICT:INVITE_LINK_USED");
    expect(await membersOf(s.group.id)).toHaveLength(0);
  });

  it("revoke racing a redeem: never both", async () => {
    const s = await setupGroup();
    for (let i = 0; i < 5; i++) {
      const link = await oneLink(s);
      const student = await makeUser(`R${i}`);
      const [redeem, revoke] = await Promise.allSettled([
        caller(student).student.redeemInviteLink({ token: link.token }),
        s.api.teacher.groups.inviteLinkRevoke({ groupId: s.group.id, linkId: link.id }),
      ]);
      expect(redeem.status === "fulfilled" && revoke.status === "fulfilled").toBe(false);
      const [row] = await db().select().from(groupInviteLinks).where(eq(groupInviteLinks.id, link.id));
      expect(row.usedByUserId !== null && row.revokedAt !== null).toBe(false);
    }
  });
});

describe("group code /join/<code>", () => {
  it("is multi-use by design: everyone with the link joins at once, each recorded as a code join", async () => {
    const s = await setupGroup();
    const people = await Promise.all(Array.from({ length: 4 }, (_, i) => makeUser(`C${i}`)));
    await Promise.all(people.map((p) => caller(p).student.join({ inviteCode: s.group.inviteCode })));
    expect((await membersOf(s.group.id)).filter((m) => m.status === "ACTIVE")).toHaveLength(4);
    expect(await sourceOf(s.group.id, people[0].id)).toMatchObject({ joinedVia: "GROUP_CODE_LINK", sourceId: s.group.inviteCode, actorUserId: people[0].id });
    expect(await groups.inviteCodeUsage(s.teacher.scope, s.group.id)).toEqual({ uses: 4, maxUses: null });
  });

  it("MANUAL policy, turned off, expired or regenerated: refused", async () => {
    const s = await setupGroup();
    const st = await makeUser("S");
    const join = (code = s.group.inviteCode) => outcome(caller(st).student.join({ inviteCode: code }));
    await groups.setJoinPolicy(s.teacher.scope, s.group.id, "MANUAL");
    expect(await join()).toBe("FORBIDDEN:GROUP_NOT_ACCEPTING");
    await groups.setJoinPolicy(s.teacher.scope, s.group.id, "AUTO");
    await groups.setInviteCodeActive(s.teacher.scope, s.group.id, false);
    expect(await join()).toBe("PRECONDITION_FAILED:INVITE_CODE_INACTIVE");
    await groups.setInviteCodeActive(s.teacher.scope, s.group.id, true);
    await groups.setInviteCodeExpiry(s.teacher.scope, s.group.id, new Date(Date.now() - 1000));
    expect(await join()).toBe("PRECONDITION_FAILED:INVITE_CODE_EXPIRED");
    await groups.regenerateInviteCode(s.teacher.scope, s.group.id);
    expect(await join()).toBe("NOT_FOUND:INVITE_NOT_FOUND");
    expect(await membersOf(s.group.id)).toHaveLength(0);
  });

  it("max uses: 10 concurrent joins against a cap of 3 admit exactly 3; a new code counts from zero", async () => {
    const s = await setupGroup();
    await s.api.teacher.groups.setInviteCodeMaxUses({ groupId: s.group.id, maxUses: 3 });
    const people = await Promise.all(Array.from({ length: 10 }, (_, i) => makeUser(`M${i}`)));
    const res = await Promise.allSettled(people.map((p) => caller(p).student.join({ inviteCode: s.group.inviteCode })));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(res.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.message)).toEqual(Array(7).fill("INVITE_CODE_LIMIT_REACHED"));
    expect(await membersOf(s.group.id)).toHaveLength(3);
    expect((await groups.publicInvite(s.group.inviteCode))?.rejection).toBe("INVITE_CODE_LIMIT_REACHED");

    // Removing a member does not free a use: the cap counts joins through this code.
    await groups.removeMember(s.teacher.scope, s.group.id, (await membersOf(s.group.id))[0].userId);
    expect(await outcome(caller(people[9]).student.join({ inviteCode: s.group.inviteCode }))).toBe("PRECONDITION_FAILED:INVITE_CODE_LIMIT_REACHED");

    const { inviteCode } = await groups.regenerateInviteCode(s.teacher.scope, s.group.id);
    expect(await outcome(caller(people[9]).student.join({ inviteCode }))).toBe("OK");
    expect(await groups.inviteCodeUsage(s.teacher.scope, s.group.id)).toEqual({ uses: 1, maxUses: 3 });

    await s.api.teacher.groups.setInviteCodeMaxUses({ groupId: s.group.id, maxUses: null });
    expect((await groups.publicInvite(inviteCode))?.rejection).toBeNull();
  });
});

describe("join sources of the other paths", () => {
  it("e-mail invite, teacher add, syllabus request and approval are each recorded with their actor", async () => {
    const s = await setupGroup();
    const [mailed, added, requested, pending] = [await makeUser("Mail"), await makeUser("Added"), await makeUser("Req"), await makeUser("Pending")];

    const invite = await createEmailInvite(s.teacher.scope, s.group.id, mailed.email!);
    await caller(mailed).student.acceptEmailInvite({ token: invite.token });
    await s.api.teacher.groups.addMember({ groupId: s.group.id, email: added.email! });
    await groups.addMemberById(s.teacher.scope, s.group.id, requested.id, "req-1");
    await db().insert(groupMembers).values({ groupId: s.group.id, userId: pending.id, status: "PENDING" });
    await s.api.teacher.groups.approveMember({ groupId: s.group.id, studentId: pending.id });

    expect(await sourceOf(s.group.id, mailed.id)).toMatchObject({ joinedVia: "EMAIL_INVITE", sourceId: invite.id, actorUserId: mailed.id });
    expect(await sourceOf(s.group.id, added.id)).toMatchObject({ joinedVia: "TEACHER_ADDED", sourceId: null, actorUserId: s.teacher.user.id });
    expect(await sourceOf(s.group.id, requested.id)).toMatchObject({ joinedVia: "SYLLABUS_REQUEST", sourceId: "req-1", actorUserId: s.teacher.user.id });
    expect(await sourceOf(s.group.id, pending.id)).toMatchObject({ joinedVia: "TEACHER_APPROVED", actorUserId: s.teacher.user.id });

    const { members } = await s.api.teacher.groups.detail({ id: s.group.id });
    const byId = new Map(members.map((m) => [m.studentId, m.joinSource]));
    expect(byId.get(mailed.id)).toMatchObject({ joinedVia: "EMAIL_INVITE", detail: mailed.email!.toLowerCase() });
    expect(byId.get(added.id)).toMatchObject({ joinedVia: "TEACHER_ADDED", detail: null });
  });

  it("the members list shows a single-use link's label", async () => {
    const s = await setupGroup();
    const link = await oneLink(s, "Xəyalə üçün");
    const a = await makeUser("A");
    await caller(a).student.redeemInviteLink({ token: link.token });
    const { members } = await s.api.teacher.groups.detail({ id: s.group.id });
    expect(members[0].joinSource).toMatchObject({ joinedVia: "SINGLE_USE_LINK", detail: "Xəyalə üçün" });
  });
});

describe("startup backfill for memberships older than migration 0043", () => {
  it("derives the source from what is on record, else UNKNOWN; never overwrites a recorded one", async () => {
    const s = await setupGroup();
    const [viaLink, viaCodeNotice, viaShareEvent, unknown, recorded] = await Promise.all(["L", "N", "E", "U", "R"].map((n) => makeUser(n)));
    const link = await oneLink(s);
    await caller(viaLink).student.redeemInviteLink({ token: link.token });
    await caller(recorded).student.join({ inviteCode: s.group.inviteCode });
    await db().insert(groupMembers).values([viaCodeNotice, viaShareEvent, unknown].map((u) => ({ groupId: s.group.id, userId: u.id, status: "ACTIVE" as const })));
    // Pretend the link join and the three direct rows predate the side table.
    for (const u of [viaLink, viaCodeNotice, viaShareEvent, unknown]) {
      await db().delete(groupMemberSources).where(and(eq(groupMemberSources.groupId, s.group.id), eq(groupMemberSources.userId, u.id)));
    }
    const [noticeRow] = await db().select().from(groupMembers).where(and(eq(groupMembers.groupId, s.group.id), eq(groupMembers.userId, viaCodeNotice.id)));
    await db().insert(notificationDeliveries).values({
      dedupeKey: `group-join:${noticeRow.id}:IN_APP`,
      event: "GROUP_MEMBER_JOINED",
      userId: s.teacher.user.id,
      channel: "IN_APP",
      status: "SENT",
      payload: {},
    });
    await db().insert(shareEvents).values({ targetType: "GROUP", targetId: s.group.inviteCode, eventType: "JOINED", actorUserId: viaShareEvent.id });

    const plan = await runJoinSourceBackfill();
    const via = new Map(plan.filter((r) => r.groupId === s.group.id).map((r) => [r.userId, r.joinedVia]));
    expect(via.get(viaLink.id)).toBe("SINGLE_USE_LINK");
    expect(via.get(viaCodeNotice.id)).toBe("GROUP_CODE_LINK");
    expect(via.get(viaShareEvent.id)).toBe("GROUP_CODE_LINK");
    expect(via.get(unknown.id)).toBe("UNKNOWN");
    expect(via.has(recorded.id)).toBe(false);
    expect(await sourceOf(s.group.id, unknown.id)).toMatchObject({ joinedVia: "UNKNOWN", backfilled: true });
    expect(await sourceOf(s.group.id, recorded.id)).toMatchObject({ joinedVia: "GROUP_CODE_LINK", backfilled: false });
    expect((await runJoinSourceBackfill()).filter((r) => r.groupId === s.group.id)).toEqual([]);
  });
});

describe("exam participants", () => {
  it("a late code-link joiner of an assigned group is NOT_STARTED with the group and join path; outsiders never appear", async () => {
    const s = await setupGroup();
    const early = await makeUser("Early");
    await s.api.teacher.groups.addMember({ groupId: s.group.id, email: early.email! });
    const picked = await makeUser("Picked");
    const other = await makeGroup(s.teacher.scope, [picked]);
    const exam = await publishedAssessment(s.teacher.scope, { groupIds: [s.group.id], studentIds: [picked.id] });
    const late = await makeUser("Late");
    await caller(late).student.join({ inviteCode: s.group.inviteCode });

    const outsider = await makeUser("Outsider");
    expect(await outcome(caller(outsider).student.start({ assessmentId: exam.id }))).toMatch(/NO_ACCESS/);
    expect(await assessments.publicByShareCode(exam.shareCode)).toBeTruthy();

    const report = await activity.assessmentParticipants(s.teacher.scope, exam.id);
    const byId = new Map(report.participants.map((p) => [p.studentId, p]));
    expect(byId.get(late.id)).toMatchObject({
      state: "NOT_STARTED",
      onRoster: true,
      viewedAt: null,
      rosterSource: { kind: "GROUP", groupName: s.group.name, joinedVia: "GROUP_CODE_LINK" },
    });
    expect(byId.get(early.id)?.rosterSource).toMatchObject({ kind: "GROUP", joinedVia: "TEACHER_ADDED" });
    expect(byId.get(picked.id)?.rosterSource).toMatchObject({ kind: "INDIVIDUAL" });
    expect(byId.has(outsider.id)).toBe(false);
    expect(report.participants).toHaveLength(3);
    expect(other.id).toBeTruthy();
  });
});

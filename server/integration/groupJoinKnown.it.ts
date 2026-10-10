import { and, eq, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { groupJoinSettings, groupMembers, groupMemberSources, notificationDeliveries, syllabusAccessGrants, syllabusJoinRequests, type User } from "../../drizzle/schema";
import { JOIN_REQUEST_COOLDOWN_MS } from "../../shared/groupJoinPolicy";
import { resetRateLimits } from "../_core/rateLimit";
import { knownStudentReason } from "../modules/groupJoinApproval";
import * as groups from "../modules/groups";
import * as authoring from "../syllabus/authoring";
import { caller, db, makeGroup, makeTeacher, makeUser, outcome } from "./fixtures";

/**
 * APPROVAL with "admit students I already know" (on by default) against real MySQL: who counts as
 * known to the group's owner, that such a student is admitted at once and marked so (source and
 * teacher notice), and that the decline cooldown, the use cap and the teacher's opt-out still win.
 */

beforeEach(() => resetRateLimits());

type Teacher = Awaited<ReturnType<typeof makeTeacher>>;

const membershipOf = async (groupId: string, userId: number) =>
  (await db().select().from(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId))))[0];
const sourceOf = async (groupId: string, userId: number) =>
  (await db().select().from(groupMemberSources).where(and(eq(groupMemberSources.groupId, groupId), eq(groupMemberSources.userId, userId))))[0];

async function deliveriesOf(dedupeKey: string) {
  return vi.waitFor(
    async () => {
      const rows = await db().select().from(notificationDeliveries).where(like(notificationDeliveries.dedupeKey, `${dedupeKey}:%`));
      if (!rows.length) throw new Error(`no delivery for ${dedupeKey}`);
      return rows;
    },
    { timeout: 5000, interval: 50 },
  );
}

async function approvalGroup(teacher?: Teacher) {
  const t = teacher ?? (await makeTeacher("Tanış müəllim"));
  const group = await makeGroup(t.scope, []);
  const api = caller(t.user);
  await api.teacher.groups.setJoinPolicy({ groupId: group.id, joinPolicy: "APPROVAL" });
  return { teacher: t, group, api };
}

const join = (student: User, inviteCode: string) => caller(student).student.join({ inviteCode });
const known = (teacher: Teacher, groupId: string, student: User) => knownStudentReason(db(), { ownerUserId: teacher.user.id, groupId, userId: student.id });

async function syllabusOf(teacher: Teacher) {
  return authoring.createSyllabus(teacher.scope, { title: `Sillabus ${nanoid(4)}` });
}

describe("a known student is admitted at once", () => {
  it("via another of the teacher's groups: ACTIVE, recorded as an automatic code join, the teacher is told why", async () => {
    const { teacher, group, api } = await approvalGroup();
    const student = await makeUser("Tanış Aysel");
    await makeGroup(teacher.scope, [student]);

    expect(await join(student, group.inviteCode)).toEqual({ groupId: group.id, groupName: group.name, status: "ACTIVE" });
    const m = await membershipOf(group.id, student.id);
    expect(m.status).toBe("ACTIVE");
    expect(await sourceOf(group.id, student.id)).toMatchObject({ joinedVia: "GROUP_CODE_LINK", sourceId: group.inviteCode, actorUserId: student.id, autoReason: "KNOWN_STUDENT" });
    expect(await groups.inviteCodeUsage(teacher.scope, group.id)).toEqual({ uses: 1, maxUses: null });

    const notices = await deliveriesOf(`group-join:${m.id}`);
    expect(notices.every((d) => d.userId === teacher.user.id && d.event === "GROUP_MEMBER_JOINED")).toBe(true);
    expect(notices[0].payload).toMatchObject({ groupId: group.id, studentName: "Tanış Aysel", autoKnown: true });
    expect(notices[0].payload).not.toHaveProperty("pending");

    const { members } = await api.teacher.groups.detail({ id: group.id });
    expect(members.find((x) => x.studentId === student.id)).toMatchObject({ status: "ACTIVE", joinSource: { joinedVia: "GROUP_CODE_LINK", autoReason: "KNOWN_STUDENT" } });
  });

  it("via a group they were removed from (the membership's source outlives it)", async () => {
    const teacher = await makeTeacher("Keçmiş müəllim");
    const old = await makeGroup(teacher.scope, []);
    const student = await makeUser("Keçmiş üzv");
    expect(await join(student, old.inviteCode)).toMatchObject({ status: "ACTIVE" });
    await caller(teacher.user).teacher.groups.removeMember({ groupId: old.id, studentId: student.id });
    expect(await membershipOf(old.id, student.id)).toBeUndefined();

    const { group } = await approvalGroup(teacher);
    expect(await known(teacher, group.id, student)).toBe("FORMER_MEMBER");
    expect(await join(student, group.inviteCode)).toMatchObject({ status: "ACTIVE" });
  });

  it("via an accepted syllabus join request of the teacher's", async () => {
    const { teacher, group } = await approvalGroup();
    const syllabus = await syllabusOf(teacher);
    const [accepted, refused] = [await makeUser("Qəbul olunan"), await makeUser("Rədd olunan")];
    const request = (studentId: number, status: "ACCEPTED" | "REJECTED") =>
      db().insert(syllabusJoinRequests).values({ id: nanoid(), syllabusId: syllabus.id, workspaceId: teacher.workspaceId, studentId, type: "INDIVIDUAL", status });
    await request(accepted.id, "ACCEPTED");
    await request(refused.id, "REJECTED");

    expect(await known(teacher, group.id, accepted)).toBe("SYLLABUS_REQUEST");
    expect(await join(accepted, group.inviteCode)).toMatchObject({ status: "ACTIVE" });
    expect(await known(teacher, group.id, refused)).toBeNull();
    expect(await join(refused, group.inviteCode)).toMatchObject({ status: "PENDING" });
  });

  it("via individual access to one of the teacher's syllabi, even if since revoked", async () => {
    const { teacher, group } = await approvalGroup();
    const syllabus = await syllabusOf(teacher);
    const student = await makeUser("Girişi olan");
    await db().insert(syllabusAccessGrants).values({ id: nanoid(), syllabusId: syllabus.id, studentId: student.id, status: "REVOKED", grantedBy: teacher.user.id });
    expect(await known(teacher, group.id, student)).toBe("SYLLABUS_GRANT");
    expect(await join(student, group.inviteCode)).toMatchObject({ status: "ACTIVE" });
  });

  it("a request made before the student became known is admitted when they submit the code again", async () => {
    const { teacher, group } = await approvalGroup();
    const student = await makeUser("Sonradan tanış");
    expect(await join(student, group.inviteCode)).toMatchObject({ status: "PENDING" });
    const { id } = await membershipOf(group.id, student.id);
    await makeGroup(teacher.scope, [student]);
    expect(await groups.joinByInvite(student.id, group.inviteCode)).toMatchObject({ status: "ACTIVE", activatedPending: true, autoKnown: true, membershipId: id });
    expect(await sourceOf(group.id, student.id)).toMatchObject({ autoReason: "KNOWN_STUDENT" });
  });
});

describe("everyone else still waits", () => {
  it("an unknown student leaves a PENDING request with no automatic marker", async () => {
    const { teacher, group } = await approvalGroup();
    const student = await makeUser("Yeni tələbə");
    expect(await known(teacher, group.id, student)).toBeNull();
    expect(await join(student, group.inviteCode)).toMatchObject({ status: "PENDING" });
    expect(await sourceOf(group.id, student.id)).toMatchObject({ joinedVia: "GROUP_CODE_LINK", autoReason: null });
  });

  it("a request waiting (or removed) in another group, or a membership of this very group, doesn't make a student known", async () => {
    const { teacher, group, api } = await approvalGroup();
    const other = await approvalGroup(teacher);
    const [waiting, withdrawn] = [await makeUser("Gözləyən"), await makeUser("Silinən sorğu")];
    for (const s of [waiting, withdrawn]) expect(await join(s, other.group.inviteCode)).toMatchObject({ status: "PENDING" });
    await api.teacher.groups.removeMember({ groupId: other.group.id, studentId: withdrawn.id });
    expect(await sourceOf(other.group.id, withdrawn.id)).toBeUndefined();
    for (const s of [waiting, withdrawn]) {
      expect(await known(teacher, group.id, s)).toBeNull();
      expect(await join(s, group.inviteCode)).toMatchObject({ status: "PENDING" });
    }

    const removed = await makeUser("Bu qrupdan çıxarılan");
    await db().insert(groupMembers).values({ groupId: group.id, userId: removed.id, status: "ACTIVE" });
    await api.teacher.groups.removeMember({ groupId: group.id, studentId: removed.id });
    expect(await known(teacher, group.id, removed)).toBeNull();
  });

  it("another teacher's student is not known to this teacher", async () => {
    const { teacher, group } = await approvalGroup();
    const stranger = await makeTeacher("Başqa müəllim");
    const student = await makeUser("Başqasının tələbəsi");
    await makeGroup(stranger.scope, [student]);
    const syllabus = await syllabusOf(stranger);
    await db().insert(syllabusJoinRequests).values({ id: nanoid(), syllabusId: syllabus.id, workspaceId: stranger.workspaceId, studentId: student.id, type: "INDIVIDUAL", status: "ACCEPTED" });
    await db().insert(syllabusAccessGrants).values({ id: nanoid(), syllabusId: syllabus.id, studentId: student.id, grantedBy: stranger.user.id });

    expect(await known(teacher, group.id, student)).toBeNull();
    expect(await join(student, group.inviteCode)).toMatchObject({ status: "PENDING" });
  });

  it("the teacher can turn it off (on by default); the choice survives policy changes and is read back", async () => {
    const { teacher, group, api } = await approvalGroup();
    expect(await groups.teacherGroup(teacher.scope, group.id)).toMatchObject({ joinPolicy: "APPROVAL", autoApproveKnown: true });
    await api.teacher.groups.setJoinPolicy({ groupId: group.id, joinPolicy: "APPROVAL", autoApproveKnown: false });
    expect(await groups.teacherGroup(teacher.scope, group.id)).toMatchObject({ joinPolicy: "APPROVAL", autoApproveKnown: false });
    await api.teacher.groups.setJoinPolicy({ groupId: group.id, joinPolicy: "AUTO" });
    await api.teacher.groups.setJoinPolicy({ groupId: group.id, joinPolicy: "APPROVAL" });
    expect((await api.teacher.groups.list()).find((g) => g.id === group.id)).toMatchObject({ joinPolicy: "APPROVAL", autoApproveKnown: false });
    const [settings] = await db().select().from(groupJoinSettings).where(eq(groupJoinSettings.groupId, group.id));
    expect(settings).toMatchObject({ approvalRequired: true, autoApproveKnown: false });

    const student = await makeUser("Tanış, amma gözləyir");
    await makeGroup(teacher.scope, [student]);
    expect(await join(student, group.inviteCode)).toMatchObject({ status: "PENDING" });
  });

  it("the decline cooldown beats being known; after it a known student is admitted", async () => {
    const { teacher, group, api } = await approvalGroup();
    const student = await makeUser("Rədd edilmiş");
    await join(student, group.inviteCode);
    await api.teacher.groups.decideRequests({ groupId: group.id, studentIds: [student.id], decision: "DECLINED" });
    await makeGroup(teacher.scope, [student]);
    expect(await known(teacher, group.id, student)).toBe("OTHER_GROUP");

    expect(await outcome(join(student, group.inviteCode))).toBe("TOO_MANY_REQUESTS:JOIN_REQUEST_COOLDOWN");
    expect(await membershipOf(group.id, student.id)).toBeUndefined();
    const later = new Date(Date.now() + JOIN_REQUEST_COOLDOWN_MS + 1000);
    expect(await groups.joinByInvite(student.id, group.inviteCode, later)).toMatchObject({ status: "ACTIVE", autoKnown: true });
  });

  it("the use cap still applies to known students, and their join counts as a use", async () => {
    const { teacher, group, api } = await approvalGroup();
    await api.teacher.groups.setInviteCodeMaxUses({ groupId: group.id, maxUses: 2 });
    const [first, second, late] = [await makeUser("Tanış 1"), await makeUser("Yad"), await makeUser("Tanış 2")];
    await makeGroup(teacher.scope, [first, late]);
    expect(await join(first, group.inviteCode)).toMatchObject({ status: "ACTIVE" });
    expect(await join(second, group.inviteCode)).toMatchObject({ status: "PENDING" });
    expect(await groups.inviteCodeUsage(teacher.scope, group.id)).toEqual({ uses: 2, maxUses: 2 });
    expect(await outcome(join(late, group.inviteCode))).toBe("PRECONDITION_FAILED:INVITE_CODE_LIMIT_REACHED");
    expect(await membershipOf(group.id, late.id)).toBeUndefined();
  });

  it("the teacher's approval of a request is not marked automatic", async () => {
    const { group, api } = await approvalGroup();
    const student = await makeUser("Təsdiqlənən");
    await join(student, group.inviteCode);
    await api.teacher.groups.decideRequests({ groupId: group.id, studentIds: [student.id], decision: "APPROVED" });
    expect(await sourceOf(group.id, student.id)).toMatchObject({ joinedVia: "GROUP_CODE_LINK", autoReason: null });
  });
});

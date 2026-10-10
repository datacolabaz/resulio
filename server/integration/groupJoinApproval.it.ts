import { and, eq, like } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { groupJoinDeclines, groupJoinSettings, groupMembers, groupMemberSources, notificationDeliveries } from "../../drizzle/schema";
import { JOIN_REQUEST_COOLDOWN_MS } from "../../shared/groupJoinPolicy";
import { resetRateLimits } from "../_core/rateLimit";
import * as activity from "../modules/activity";
import * as attempts from "../modules/attempts";
import { createEmailInvite } from "../modules/groupEmailInvites";
import * as groups from "../modules/groups";
import * as access from "../syllabus/access";
import * as authoring from "../syllabus/authoring";
import { setWorkspaceEnabled } from "../syllabus/availability";
import * as learning from "../syllabus/learning";
import * as publishing from "../syllabus/publishing";
import { caller, db, makeGroup, makeTeacher, makeUser, outcome, publishedAssessment } from "./fixtures";

/**
 * The APPROVAL join policy against real MySQL: the group code/link leaves one PENDING request per
 * student (even under concurrency), the request holds a place in the code's use cap from the
 * start, a PENDING student reaches nothing of the group, and the teacher's approval or decline
 * (one or many) is recorded, notified and, for declines, followed by a cooldown.
 */

beforeEach(() => resetRateLimits());

const membersOf = (groupId: string) => db().select().from(groupMembers).where(eq(groupMembers.groupId, groupId));
const membershipOf = async (groupId: string, userId: number) =>
  (await db().select().from(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId))))[0];
const sourceOf = async (groupId: string, userId: number) =>
  (await db().select().from(groupMemberSources).where(and(eq(groupMemberSources.groupId, groupId), eq(groupMemberSources.userId, userId))))[0];

/** Notices go out in the background; waits for the delivery rows of one dedupe key. */
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

async function approvalGroup() {
  const teacher = await makeTeacher("Təsdiq müəllimi");
  const group = await makeGroup(teacher.scope, []);
  const api = caller(teacher.user);
  await api.teacher.groups.setJoinPolicy({ groupId: group.id, joinPolicy: "APPROVAL" });
  return { teacher, group, api };
}

describe("join policy", () => {
  it("is stored beside the group and read back as AUTO, APPROVAL or MANUAL everywhere", async () => {
    const { teacher, group, api } = await approvalGroup();
    expect((await groups.teacherGroup(teacher.scope, group.id)).joinPolicy).toBe("APPROVAL");
    expect((await api.teacher.groups.list()).find((g) => g.id === group.id)?.joinPolicy).toBe("APPROVAL");
    expect(await groups.publicInvite(group.inviteCode)).toMatchObject({ joinPolicy: "APPROVAL", rejection: null, viewerStatus: null });

    await api.teacher.groups.setJoinPolicy({ groupId: group.id, joinPolicy: "MANUAL" });
    expect((await groups.teacherGroup(teacher.scope, group.id)).joinPolicy).toBe("MANUAL");
    const [settings] = await db().select().from(groupJoinSettings).where(eq(groupJoinSettings.groupId, group.id));
    expect(settings.approvalRequired).toBe(false);

    await api.teacher.groups.setJoinPolicy({ groupId: group.id, joinPolicy: "AUTO" });
    expect((await groups.teacherGroup(teacher.scope, group.id)).joinPolicy).toBe("AUTO");
  });

  it("only the group's owner can change it", async () => {
    const { group } = await approvalGroup();
    const stranger = await makeTeacher("Kənar müəllim");
    expect(await outcome(caller(stranger.user).teacher.groups.setJoinPolicy({ groupId: group.id, joinPolicy: "AUTO" }))).toBe("NOT_FOUND:NOT_FOUND");
    const student = await makeUser("Tələbə");
    expect(await outcome(caller(student).teacher.groups.setJoinPolicy({ groupId: group.id, joinPolicy: "AUTO" }))).toMatch(/^FORBIDDEN/);
  });
});

describe("requests through the group code", () => {
  it("a join leaves one PENDING request recorded as a code join; asking again changes nothing", async () => {
    const { teacher, group } = await approvalGroup();
    const student = await makeUser("Xəyalə");
    const first = await caller(student).student.join({ inviteCode: group.inviteCode });
    expect(first).toEqual({ groupId: group.id, groupName: group.name, status: "PENDING" });
    expect(await caller(student).student.join({ inviteCode: group.inviteCode.toLowerCase() })).toMatchObject({ status: "PENDING" });

    const rows = await membersOf(group.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: student.id, status: "PENDING" });
    expect(await sourceOf(group.id, student.id)).toMatchObject({ joinedVia: "GROUP_CODE_LINK", sourceId: group.inviteCode, actorUserId: student.id });
    expect(await groups.publicInvite(group.inviteCode, student.id)).toMatchObject({ viewerStatus: "PENDING", rejection: null });

    // The teacher hears of the request once, with a link to the requests tab.
    const notices = await deliveriesOf(`group-join-request:${rows[0].id}`);
    expect(notices.map((d) => d.channel).sort()).toEqual(["IN_APP", "PUSH"]);
    expect(notices.every((d) => d.userId === teacher.user.id && d.event === "GROUP_MEMBER_JOINED")).toBe(true);
    expect(notices[0].payload).toMatchObject({ groupId: group.id, pending: true, studentName: "Xəyalə" });
    const { members } = await caller(teacher.user).teacher.groups.detail({ id: group.id });
    expect(members.find((m) => m.studentId === student.id)).toMatchObject({ status: "PENDING", joinSource: { joinedVia: "GROUP_CODE_LINK" } });
  });

  it("concurrency: 10 different students give 10 requests; one student double-clicking gives one", async () => {
    const { group, teacher } = await approvalGroup();
    const people = await Promise.all(Array.from({ length: 10 }, (_, i) => makeUser(`P${i}`)));
    const res = await Promise.allSettled(people.map((p) => caller(p).student.join({ inviteCode: group.inviteCode })));
    expect(res.filter((r) => r.status === "fulfilled" && r.value.status === "PENDING")).toHaveLength(10);
    const rows = await membersOf(group.id);
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((r) => r.userId)).size).toBe(10);
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);

    const solo = await makeUser("Tələsən");
    const clicks = await Promise.allSettled(Array.from({ length: 5 }, () => caller(solo).student.join({ inviteCode: group.inviteCode })));
    expect(clicks.every((r) => r.status === "fulfilled" && r.value.status === "PENDING")).toBe(true);
    expect((await membersOf(group.id)).filter((r) => r.userId === solo.id)).toHaveLength(1);
    expect(await groups.inviteCodeUsage(teacher.scope, group.id)).toEqual({ uses: 11, maxUses: null });
  });

  it("an inactive, expired or regenerated code takes no requests; MANUAL takes none either", async () => {
    const { group, api, teacher } = await approvalGroup();
    const st = await makeUser("S");
    const join = (code = group.inviteCode) => outcome(caller(st).student.join({ inviteCode: code }));
    await api.teacher.groups.setInviteCodeActive({ groupId: group.id, active: false });
    expect(await join()).toBe("PRECONDITION_FAILED:INVITE_CODE_INACTIVE");
    await api.teacher.groups.setInviteCodeActive({ groupId: group.id, active: true });
    await groups.setInviteCodeExpiry(teacher.scope, group.id, new Date(Date.now() - 1000));
    expect(await join()).toBe("PRECONDITION_FAILED:INVITE_CODE_EXPIRED");
    const { inviteCode } = await groups.regenerateInviteCode(teacher.scope, group.id);
    expect(await join()).toBe("NOT_FOUND:INVITE_NOT_FOUND");
    await api.teacher.groups.setJoinPolicy({ groupId: group.id, joinPolicy: "MANUAL" });
    expect(await join(inviteCode)).toBe("FORBIDDEN:GROUP_NOT_ACCEPTING");
    expect(await membersOf(group.id)).toHaveLength(0);
  });

  it("max uses count requests: a full cap refuses newcomers, a decline frees a place, an approval never fails on the cap", async () => {
    const { group, api, teacher } = await approvalGroup();
    await api.teacher.groups.setInviteCodeMaxUses({ groupId: group.id, maxUses: 3 });
    const people = await Promise.all(Array.from({ length: 5 }, (_, i) => makeUser(`M${i}`)));
    const res = await Promise.allSettled(people.map((p) => caller(p).student.join({ inviteCode: group.inviteCode })));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(res.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.message)).toEqual(Array(2).fill("INVITE_CODE_LIMIT_REACHED"));
    expect(await groups.inviteCodeUsage(teacher.scope, group.id)).toEqual({ uses: 3, maxUses: 3 });

    const waiting = (await membersOf(group.id)).map((m) => m.userId);
    const refused = people.find((p) => !waiting.includes(p.id))!;
    // A student who already asked still reads as "request sent" at a full cap.
    expect(await caller(people.find((p) => p.id === waiting[0])!).student.join({ inviteCode: group.inviteCode })).toMatchObject({ status: "PENDING" });

    await api.teacher.groups.decideRequests({ groupId: group.id, studentIds: [waiting[0]], decision: "DECLINED" });
    expect(await groups.inviteCodeUsage(teacher.scope, group.id)).toEqual({ uses: 2, maxUses: 3 });
    expect(await caller(refused).student.join({ inviteCode: group.inviteCode })).toMatchObject({ status: "PENDING" });

    expect(await api.teacher.groups.decideRequests({ groupId: group.id, studentIds: [waiting[1], waiting[2], refused.id], decision: "APPROVED" })).toEqual({ decided: 3 });
    expect(await groups.inviteCodeUsage(teacher.scope, group.id)).toEqual({ uses: 3, maxUses: 3 });
    expect((await membersOf(group.id)).every((m) => m.status === "ACTIVE")).toBe(true);
  });

  it("switching to AUTO keeps waiting requests for the teacher; the student's next valid visit activates theirs", async () => {
    const { group, api } = await approvalGroup();
    const [kept, back] = [await makeUser("Gözləyən"), await makeUser("Qayıdan")];
    for (const s of [kept, back]) await caller(s).student.join({ inviteCode: group.inviteCode });
    await api.teacher.groups.setJoinPolicy({ groupId: group.id, joinPolicy: "AUTO" });
    expect((await membershipOf(group.id, kept.id)).status).toBe("PENDING");
    expect(await caller(back).student.join({ inviteCode: group.inviteCode })).toMatchObject({ status: "ACTIVE" });
    expect((await membershipOf(group.id, back.id)).status).toBe("ACTIVE");
  });
});

describe("single-use links, e-mail invites and teacher adds stay instant under APPROVAL", () => {
  it("each admits as ACTIVE at once", async () => {
    const { group, api, teacher } = await approvalGroup();
    const [viaLink, viaMail, added] = [await makeUser("Link"), await makeUser("Mail"), await makeUser("Added")];
    const [link] = await api.teacher.groups.inviteLinkCreate({ groupId: group.id, labels: [""] });
    expect((await caller(viaLink).student.redeemInviteLink({ token: link.token })).outcome).toBe("JOINED");
    const invite = await createEmailInvite(teacher.scope, group.id, viaMail.email!);
    await caller(viaMail).student.acceptEmailInvite({ token: invite.token });
    await groups.addMemberById(teacher.scope, group.id, added.id, "req-approval");
    for (const s of [viaLink, viaMail, added]) expect((await membershipOf(group.id, s.id)).status).toBe("ACTIVE");
  });
});

describe("a PENDING student reaches nothing of the group until approved", () => {
  it("exams, tasks, materials and syllabi follow ACTIVE membership only", async () => {
    const { teacher, group, api } = await approvalGroup();
    await setWorkspaceEnabled(teacher.workspaceId, true, teacher.user.id);
    const exam = await publishedAssessment(teacher.scope, { groupIds: [group.id] });
    const task = await api.teacher.tasks.create({ title: "Qrup tapşırığı", deadline: new Date(Date.now() + 86_400_000), groupIds: [group.id] });
    const material = await api.teacher.tasks.createMaterial({ title: "Qrup materialı", fileName: "qrup.pdf", groupIds: [group.id] });
    const syllabus = await authoring.createSyllabus(teacher.scope, { title: "Qrup sillabusu" });
    const mod = await authoring.createModule(teacher.scope, syllabus.id, { title: "M" });
    const lesson = await authoring.createLesson(teacher.scope, mod.id, { title: "D" });
    await authoring.createItem(teacher.scope, syllabus.id, { scope: "LESSON", lessonId: lesson.id }, { kind: "THEORY", title: "T", content: { blocks: [{ type: "markdown", md: "x" }] } });
    await publishing.publish(teacher.scope, syllabus.id, { label: "v1" });
    await access.grantAccess(teacher.scope, syllabus.id, { groupIds: [group.id], studentIds: [], startsAt: null, endsAt: null });

    const student = await makeUser("Gözləyən tələbə");
    await caller(student).student.join({ inviteCode: group.inviteCode });
    const me = caller(student).student;

    const reach = async () => ({
      groupIds: await groups.activeGroupIdsOfStudent(student.id),
      roster: (await groups.activeStudentIdsOfGroups([group.id])).includes(student.id),
      exam: (await attempts.studentAssessments(student.id)).some((a) => a.id === exam.id),
      participant: (await activity.assessmentParticipants(teacher.scope, exam.id)).participants.some((p) => p.studentId === student.id),
      task: (await me.tasks()).some((t) => t.id === task.id),
      material: (await me.materials()).some((m) => m.id === material.id),
      syllabus: (await learning.mySyllabi(student.id)).some((s) => s.id === syllabus.id),
      syllabusRoster: (await api.teacher.syllabus.roster({ id: syllabus.id })).students.some((r) => r.studentId === student.id),
    });

    expect(await reach()).toEqual({ groupIds: [], roster: false, exam: false, participant: false, task: false, material: false, syllabus: false, syllabusRoster: false });
    expect(await outcome(me.start({ assessmentId: exam.id }))).toMatch(/NO_ACCESS/);

    await api.teacher.groups.decideRequests({ groupId: group.id, studentIds: [student.id], decision: "APPROVED" });
    expect(await reach()).toEqual({ groupIds: [group.id], roster: true, exam: true, participant: true, task: true, material: true, syllabus: true, syllabusRoster: true });
    // A late joiner of an assigned group: on the roster, not started, joined through the code.
    expect((await activity.assessmentParticipants(teacher.scope, exam.id)).participants.find((p) => p.studentId === student.id)).toMatchObject({
      state: "NOT_STARTED",
      rosterSource: { kind: "GROUP", joinedVia: "GROUP_CODE_LINK" },
    });
    expect(await outcome(me.start({ assessmentId: exam.id }))).toBe("OK");
  });
});

describe("teacher decisions", () => {
  it("approve (bulk): ACTIVE, still a code join with the teacher as actor, the student is notified once", async () => {
    const { teacher, group, api } = await approvalGroup();
    const [a, b] = [await makeUser("A"), await makeUser("B")];
    for (const s of [a, b]) await caller(s).student.join({ inviteCode: group.inviteCode });
    const ids = [a.id, b.id];
    expect(await api.teacher.groups.decideRequests({ groupId: group.id, studentIds: ids, decision: "APPROVED" })).toEqual({ decided: 2 });
    expect(await api.teacher.groups.decideRequests({ groupId: group.id, studentIds: ids, decision: "APPROVED" })).toEqual({ decided: 0 });
    for (const s of [a, b]) {
      const m = await membershipOf(group.id, s.id);
      expect(m.status).toBe("ACTIVE");
      expect(await sourceOf(group.id, s.id)).toMatchObject({ joinedVia: "GROUP_CODE_LINK", sourceId: group.inviteCode, actorUserId: teacher.user.id });
      const notices = await deliveriesOf(`group-join-decided:${m.id}`);
      expect(notices.every((d) => d.userId === s.id && d.event === "GROUP_JOIN_DECIDED")).toBe(true);
      expect(notices[0].payload).toMatchObject({ groupId: group.id, decision: "APPROVED" });
    }
    const { members } = await api.teacher.groups.detail({ id: group.id });
    expect(members.find((m) => m.studentId === a.id)?.joinSource).toMatchObject({ joinedVia: "GROUP_CODE_LINK" });
  });

  it("the single approve button goes the same way", async () => {
    const { teacher, group, api } = await approvalGroup();
    const a = await makeUser("A");
    await caller(a).student.join({ inviteCode: group.inviteCode });
    await api.teacher.groups.approveMember({ groupId: group.id, studentId: a.id });
    expect(await sourceOf(group.id, a.id)).toMatchObject({ joinedVia: "GROUP_CODE_LINK", actorUserId: teacher.user.id });
    expect(await outcome(api.teacher.groups.approveMember({ groupId: group.id, studentId: a.id }))).toBe("NOT_FOUND:NOT_FOUND");
  });

  it("decline: the request and its source go, the student is told neutrally and can't ask again for a day", async () => {
    const { teacher, group, api } = await approvalGroup();
    const a = await makeUser("A");
    await caller(a).student.join({ inviteCode: group.inviteCode });
    const { id: membershipId } = await membershipOf(group.id, a.id);
    expect(await api.teacher.groups.decideRequests({ groupId: group.id, studentIds: [a.id], decision: "DECLINED" })).toEqual({ decided: 1 });
    expect(await membershipOf(group.id, a.id)).toBeUndefined();
    expect(await sourceOf(group.id, a.id)).toBeUndefined();
    const [decline] = await db().select().from(groupJoinDeclines).where(and(eq(groupJoinDeclines.groupId, group.id), eq(groupJoinDeclines.userId, a.id)));
    expect(decline.declinedBy).toBe(teacher.user.id);
    const [notice] = await deliveriesOf(`group-join-decided:${membershipId}`);
    expect(notice).toMatchObject({ userId: a.id, event: "GROUP_JOIN_DECIDED" });
    expect(notice.payload).toMatchObject({ decision: "DECLINED" });

    expect(await outcome(caller(a).student.join({ inviteCode: group.inviteCode }))).toBe("TOO_MANY_REQUESTS:JOIN_REQUEST_COOLDOWN");
    expect(await membersOf(group.id)).toHaveLength(0);
    const later = new Date(decline.declinedAt.getTime() + JOIN_REQUEST_COOLDOWN_MS + 1000);
    expect(await groups.joinByInvite(a.id, group.inviteCode, later)).toMatchObject({ status: "PENDING", newRequest: true });
  });

  it("only the owner decides; students and other teachers can't, and active members aren't touched", async () => {
    const { group, api } = await approvalGroup();
    const [a, member] = [await makeUser("A"), await makeUser("Üzv")];
    await caller(a).student.join({ inviteCode: group.inviteCode });
    await db().insert(groupMembers).values({ groupId: group.id, userId: member.id, status: "ACTIVE" });
    const other = await makeTeacher("Başqa müəllim");
    for (const decision of ["APPROVED", "DECLINED"] as const) {
      expect(await outcome(caller(other.user).teacher.groups.decideRequests({ groupId: group.id, studentIds: [a.id], decision }))).toBe("NOT_FOUND:NOT_FOUND");
      expect(await outcome(caller(a).teacher.groups.decideRequests({ groupId: group.id, studentIds: [a.id], decision }))).toMatch(/^FORBIDDEN/);
    }
    expect((await membershipOf(group.id, a.id)).status).toBe("PENDING");
    expect(await api.teacher.groups.decideRequests({ groupId: group.id, studentIds: [member.id], decision: "DECLINED" })).toEqual({ decided: 0 });
    expect((await membershipOf(group.id, member.id)).status).toBe("ACTIVE");
  });
});

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { groupMembers } from "../../drizzle/schema";
import { resetRateLimits } from "../_core/rateLimit";
import * as assessments from "../modules/assessments";
import { activeGroupIdsOfStudent } from "../modules/groups";
import { taskReachesStudent } from "../modules/taskAccess";
import * as tasks from "../modules/tasks";
import { caller, db, makeGroup, makeTeacher, makeUser, outcome } from "./fixtures";

/**
 * What the groups-and-students picker sends, as the real routers store it: a whole group reaches
 * students who join later, a partial selection only the picked students; every id is checked
 * against the teacher's workspace, except recipients already on the row (share-link joiners).
 */

beforeEach(() => resetRateLimits());

async function setup() {
  const teacher = await makeTeacher("Müəllim");
  const [a, b, c] = [await makeUser("A"), await makeUser("B"), await makeUser("C")];
  const group = await makeGroup(teacher.scope, [a, b]);
  const other = await makeTeacher("Başqa müəllim");
  const stranger = await makeUser("Kənar");
  const otherGroup = await makeGroup(other.scope, [stranger]);
  return { teacher, a, b, c, group, other, stranger, otherGroup, api: caller(teacher.user) };
}

const join = (groupId: string, userId: number) => db().insert(groupMembers).values({ groupId, userId, status: "ACTIVE" });
const leave = (groupId: string, userId: number) => db().delete(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
const seesMaterial = async (userId: number, id: string) => (await tasks.studentMaterials(userId, await activeGroupIdsOfStudent(userId))).some((m) => m.id === id);
const material = (over: Record<string, unknown>) => ({ title: "Excel", fileName: "text_functions.xlsx", ...over });
const deadline = () => new Date(Date.now() + 7 * 86_400_000);

describe("materials", () => {
  it("a whole group reaches later joiners; a partial selection only the picked students", async () => {
    const { api, group, a, b, c } = await setup();
    const whole = await api.teacher.tasks.createMaterial(material({ groupIds: [group.id] }));
    const partial = await api.teacher.tasks.createMaterial(material({ studentIds: [a.id] }));
    await join(group.id, c.id);
    expect(await seesMaterial(c.id, whole.id)).toBe(true);
    expect(await seesMaterial(c.id, partial.id)).toBe(false);
    expect(await seesMaterial(b.id, partial.id)).toBe(false);
    expect(await seesMaterial(a.id, partial.id)).toBe(true);
  });

  it("rejects another workspace's group or student", async () => {
    const { api, otherGroup, stranger } = await setup();
    expect(await outcome(api.teacher.tasks.createMaterial(material({ groupIds: [otherGroup.id] })))).toMatch(/^NOT_FOUND/);
    expect(await outcome(api.teacher.tasks.createMaterial(material({ studentIds: [stranger.id] })))).toMatch(/^FORBIDDEN/);
  });

  it("edit keeps a share-link joiner but refuses a new outsider", async () => {
    const { api, a, stranger } = await setup();
    const m = await api.teacher.tasks.createMaterial(material({ studentIds: [a.id] }));
    await tasks.claimMaterial(stranger.id, m.shareCode);
    expect(await outcome(api.teacher.tasks.updateMaterial({ id: m.id, patch: { studentIds: [stranger.id] } }))).toBe("OK");
    const outsider = await makeUser("Yeni kənar");
    expect(await outcome(api.teacher.tasks.updateMaterial({ id: m.id, patch: { studentIds: [stranger.id, outsider.id] } }))).toMatch(/^FORBIDDEN/);
  });
});

describe("tasks", () => {
  it("open link: group + individual picks; edit keeps a share-link joiner", async () => {
    const { api, group, a, stranger } = await setup();
    const task = await api.teacher.tasks.create({ title: "Funksiyalar", deadline: deadline(), groupIds: [], studentIds: [a.id], accessMode: "PUBLIC" });
    await tasks.claimAssignment(stranger.id, "Kənar", task.shareCode);
    expect(await outcome(api.teacher.tasks.update({ id: task.id, patch: { groupIds: [group.id], studentIds: [stranger.id] }, notifyStudents: false }))).toBe("OK");
    const outsider = await makeUser("Yeni kənar");
    expect(await outcome(api.teacher.tasks.update({ id: task.id, patch: { studentIds: [outsider.id] }, notifyStudents: false }))).toMatch(/^FORBIDDEN/);
  });

  it("restricted: whole groups only, later joiners included, individual ids grant nothing", async () => {
    const { api, group, c } = await setup();
    const loner = await makeUser("Qrupsuz");
    const task = await api.teacher.tasks.create({ title: "Məhdud", deadline: deadline(), groupIds: [group.id], studentIds: [], accessMode: "GROUPS" });
    await join(group.id, c.id);
    expect(taskReachesStudent(task, c.id, await activeGroupIdsOfStudent(c.id))).toBe(true);
    expect(taskReachesStudent({ ...task, studentIds: [loner.id] }, loner.id, [])).toBe(false);
    expect(await outcome(api.teacher.tasks.create({ title: "Boş", deadline: deadline(), groupIds: [], studentIds: [], accessMode: "GROUPS" }))).toMatch(/^BAD_REQUEST|^PRECONDITION/);
  });
});

describe("exams", () => {
  it("group target reaches later joiners; individual target stays after the student leaves the group; outsiders refused", async () => {
    const { teacher, group, a, c, stranger } = await setup();
    const exam = await assessments.createAssessment(teacher.scope, { type: "EXAM", settings: { title: "İmtahan" } });
    await assessments.setTargets(teacher.scope, exam.id, { groupIds: [group.id], studentIds: [] });
    await join(group.id, c.id);
    expect(await assessments.accessibleAssessmentIds(c.id)).toContain(exam.id);

    await assessments.setTargets(teacher.scope, exam.id, { groupIds: [], studentIds: [a.id] });
    await leave(group.id, a.id);
    await expect(assessments.setTargets(teacher.scope, exam.id, { groupIds: [], studentIds: [a.id] })).resolves.toBeTruthy();
    expect(await assessments.getTargets(exam.id)).toEqual({ groupIds: [], studentIds: [a.id] });
    await expect(assessments.setTargets(teacher.scope, exam.id, { groupIds: [], studentIds: [a.id, stranger.id] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

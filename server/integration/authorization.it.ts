import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { User } from "../../drizzle/schema";
import { WORKSPACE_HEADER } from "../../shared/const";
import { resetRateLimits } from "../_core/rateLimit";
import * as sessions from "../modules/attempts";
import { caller, makeGroup, makePartner, makeTeacher, makeUser, outcome, publishedAssessment, questionIdsOf } from "./fixtures";

type Tenant = {
  teacher: Awaited<ReturnType<typeof makeTeacher>>;
  student: User;
  groupId: string;
  assessmentId: string;
  attemptId: string;
  resultId: string;
  openAttemptId: string;
  taskId: string;
  materialId: string;
};

const NOT_FOUND = "NOT_FOUND:NOT_FOUND";
const NO_WORKSPACE = "FORBIDDEN:NO_WORKSPACE";
const NO_ACCESS = "FORBIDDEN:NO_ACCESS";

let A: Tenant;
let B: Tenant;
let shared: User;
let partner: User;
let outsider: User;
let pending: User;

async function tenant(name: string, extraMembers: User[] = []): Promise<Tenant> {
  const teacher = await makeTeacher(`Müəllim ${name}`);
  const student = await makeUser(`Tələbə ${name}`);
  const group = await makeGroup(teacher.scope, [student, ...extraMembers]);
  const graded = await publishedAssessment(teacher.scope, { groupIds: [group.id] });
  const { attemptId } = await sessions.startAttempt(graded.id, student.id);
  const [q1] = await questionIdsOf(attemptId);
  await sessions.saveAnswers(attemptId, student.id, [{ questionId: q1, answer: "a", revision: 1 }]);
  const { resultId } = await sessions.submitAttempt(attemptId, student.id);
  const open = await publishedAssessment(teacher.scope, { groupIds: [group.id] });
  const { attemptId: openAttemptId } = await sessions.startAttempt(open.id, student.id);
  const t = caller(teacher.user);
  const task = await t.teacher.tasks.create({ title: `Tapşırıq ${name}`, deadline: new Date(Date.now() + 86_400_000), groupIds: [group.id] });
  const material = await t.teacher.tasks.createMaterial({ title: `Material ${name}`, fileName: `${name}.pdf`, groupIds: [group.id] });
  return {
    teacher,
    student,
    groupId: group.id,
    assessmentId: graded.id,
    attemptId,
    resultId: resultId!,
    openAttemptId,
    taskId: task.id,
    materialId: material.id,
  };
}

beforeAll(async () => {
  shared = await makeUser("Hər iki müəllimin tələbəsi");
  A = await tenant("A", [shared]);
  B = await tenant("B", [shared]);
  partner = await makePartner("Partnyor");
  outsider = await makeUser("Qrupsuz istifadəçi");
  pending = await makeUser("Gözləyən üzv");
  await makeGroup(A.teacher.scope, [pending], "PENDING").then(async (g) => {
    await caller(A.teacher.user).teacher.assessments.setTargets({ id: A.assessmentId, targets: { groupIds: [A.groupId, g.id], studentIds: [] } });
  });
});
beforeEach(() => resetRateLimits());

describe("teacher A cannot reach teacher B's workspace", () => {
  it("assessment reports, analytics and exports", async () => {
    const t = caller(A.teacher.user).teacher;
    const id = B.assessmentId;
    const results = await Promise.all([
      outcome(t.assessments.participants({ id })),
      outcome(t.assessments.detail({ id })),
      outcome(t.assessments.versions({ id })),
      outcome(t.assessments.preview({ id })),
      outcome(t.assessments.csv({ id })),
      outcome(t.analytics.assessment({ id })),
      outcome(t.analytics.ranking({ id })),
      outcome(t.analytics.questions({ id })),
    ]);
    expect(results).toEqual(Array(results.length).fill(NOT_FOUND));
  });

  it("assessment mutations", async () => {
    const t = caller(A.teacher.user).teacher.assessments;
    const id = B.assessmentId;
    expect(await outcome(t.setInactivityThreshold({ id, minutes: 5 }))).toBe(NOT_FOUND);
    expect(await outcome(t.updateSettings({ id, patch: { title: "hijack" } }))).toBe(NOT_FOUND);
    expect(await outcome(t.setTargets({ id, targets: { groupIds: [A.groupId], studentIds: [] } }))).toBe(NOT_FOUND);
    expect(await outcome(t.publish({ id }))).toBe(NOT_FOUND);
    expect(await outcome(t.close({ id }))).toBe(NOT_FOUND);
  });

  it("student results and grading", async () => {
    const t = caller(A.teacher.user).teacher;
    expect(await outcome(t.results.detail({ id: B.resultId }))).toBe(NOT_FOUND);
    expect(await outcome(t.results.grade({ resultId: B.resultId, questionId: "q", points: 1 }))).toBe(NOT_FOUND);
    expect(await t.results.list({ assessmentId: B.assessmentId })).toEqual([]);
    expect(await t.results.list({ studentId: B.student.id })).toEqual([]);
    expect(await t.results.pendingReviews({ assessmentId: B.assessmentId })).toEqual([]);
    const own = await t.results.list({});
    expect(own.map((r) => r.id)).toEqual([A.resultId]);
  });

  it("group details, analytics and membership", async () => {
    const g = caller(A.teacher.user).teacher.groups;
    expect(await outcome(g.detail({ id: B.groupId }))).toBe(NOT_FOUND);
    expect(await outcome(g.analytics({ id: B.groupId }))).toBe(NOT_FOUND);
    expect(await outcome(g.addMember({ groupId: B.groupId, email: "x@example.test" }))).toBe(NOT_FOUND);
    expect(await outcome(g.removeMember({ groupId: B.groupId, studentId: B.student.id }))).toBe(NOT_FOUND);
    const own = (await g.list()).map((x) => x.id);
    expect(own).toContain(A.groupId);
    expect(own).not.toContain(B.groupId);
  });

  it("student analytics only covers own students and own results", async () => {
    const t = caller(A.teacher.user).teacher;
    expect(await outcome(t.analytics.student({ studentId: B.student.id }))).toBe(NOT_FOUND);
    const sharedProgress = await t.analytics.student({ studentId: shared.id });
    expect(sharedProgress.series).toEqual([]);
    const studentIds = (await t.students()).map((s) => s.id).sort();
    expect(studentIds).toEqual([A.student.id, shared.id].sort());
  });

  it("cannot assign own work to teacher B's groups or students", async () => {
    const t = caller(A.teacher.user).teacher;
    expect(await outcome(t.assessments.setTargets({ id: A.assessmentId, targets: { groupIds: [B.groupId], studentIds: [] } }))).toBe(
      "FORBIDDEN:FORBIDDEN",
    );
    expect(await outcome(t.assessments.setTargets({ id: A.assessmentId, targets: { groupIds: [], studentIds: [B.student.id] } }))).toBe(
      "FORBIDDEN:FORBIDDEN",
    );
    expect(await outcome(t.tasks.create({ title: "x y", deadline: new Date(), groupIds: [B.groupId] }))).toBe(NOT_FOUND);
    expect(await outcome(t.tasks.createMaterial({ title: "x y", fileName: "f.pdf", studentIds: [B.student.id] }))).toBe("FORBIDDEN:FORBIDDEN");
  });

  it("activity dashboard, assignments and materials are workspace-scoped", async () => {
    const t = caller(A.teacher.user).teacher;
    const cards = await t.activity();
    expect(cards.cards.map((c) => c.id)).not.toContain(B.assessmentId);
    expect(cards.cards.map((c) => c.id)).toContain(A.assessmentId);
    expect((await t.tasks.list()).map((x) => x.id)).toEqual([A.taskId]);
    expect((await t.tasks.materials()).map((x) => x.id)).toEqual([A.materialId]);
  });

  it("the workspace header cannot grant access to a workspace the user does not own", async () => {
    const spoofed = caller(A.teacher.user, { [WORKSPACE_HEADER]: B.teacher.workspaceId }).teacher;
    expect(await outcome(spoofed.dashboard())).toBe(NO_WORKSPACE);
    expect(await outcome(spoofed.assessments.participants({ id: B.assessmentId }))).toBe(NO_WORKSPACE);
    const own = caller(A.teacher.user, { [WORKSPACE_HEADER]: A.teacher.workspaceId }).teacher;
    expect(await outcome(own.dashboard())).toBe("OK");
    const student = caller(A.student, { [WORKSPACE_HEADER]: A.teacher.workspaceId }).teacher;
    expect(await outcome(student.dashboard())).toBe(NO_WORKSPACE);
  });
});

describe("student A cannot reach student B's data", () => {
  it("results, sessions and answers", async () => {
    const s = caller(A.student).student;
    expect(await outcome(s.result({ id: B.resultId }))).toBe(NOT_FOUND);
    expect(await outcome(s.session({ attemptId: B.openAttemptId }))).toBe(NOT_FOUND);
    expect(await outcome(s.save({ attemptId: B.openAttemptId, entries: [{ questionId: "q", answer: "a", revision: 9 }] }))).toBe(NOT_FOUND);
    expect(await outcome(s.ping({ attemptId: B.openAttemptId, interacted: true }))).toBe(NOT_FOUND);
    expect(await outcome(s.submit({ attemptId: B.openAttemptId }))).toBe(NOT_FOUND);
    expect((await s.results()).map((r) => r.id)).toEqual([A.resultId]);
    expect((await s.progress()).series.map((x) => x.resultId)).toEqual([A.resultId]);
  });

  it("assessments of groups they are not in", async () => {
    const s = caller(A.student).student;
    expect(await outcome(s.assessment({ id: B.assessmentId }))).toBe(NO_ACCESS);
    expect(await outcome(s.start({ assessmentId: B.assessmentId }))).toBe(NO_ACCESS);
    expect(await outcome(s.trackView({ assessmentId: B.assessmentId }))).toBe(NO_ACCESS);
    expect((await s.assessments()).map((a) => a.id)).not.toContain(B.assessmentId);
  });

  it("assignments, submissions and materials", async () => {
    const s = caller(A.student).student;
    expect((await s.tasks()).map((t) => t.id)).toEqual([A.taskId]);
    expect(await outcome(s.submitTask({ assignmentId: B.taskId, files: [{ fileId: "f1", name: "x.pdf", size: 1024 }] }))).toBe(NOT_FOUND);
    expect((await s.materials()).map((m) => m.id)).toEqual([A.materialId]);
  });

  it("teacher analytics and activity", async () => {
    const t = caller(A.student).teacher;
    for (const call of [
      () => t.dashboard(),
      () => t.activity(),
      () => t.analytics.overview(),
      () => t.assessments.participants({ id: A.assessmentId }),
      () => t.results.list({}),
    ]) {
      expect(await outcome(call())).toBe(NO_WORKSPACE);
    }
  });
});

describe("partner, outsider and pending member", () => {
  it("partner sees no teaching or student data", async () => {
    const api = caller(partner);
    expect(await outcome(api.partner.dashboard())).toBe("OK");
    for (const call of [
      () => api.teacher.dashboard(),
      () => api.teacher.activity(),
      () => api.teacher.assessments.participants({ id: A.assessmentId }),
      () => api.teacher.results.detail({ id: A.resultId }),
      () => api.teacher.groups.analytics({ id: A.groupId }),
      () => api.teacher.tasks.materials(),
      () => api.teacher.tasks.list(),
    ]) {
      expect(await outcome(call())).toBe(NO_WORKSPACE);
    }
    expect(await outcome(api.student.result({ id: A.resultId }))).toBe(NOT_FOUND);
    expect(await outcome(api.student.start({ assessmentId: A.assessmentId }))).toBe(NO_ACCESS);
    expect(await api.student.results()).toEqual([]);
    expect(await api.student.assessments()).toEqual([]);
    expect(await api.student.tasks()).toEqual([]);
    expect(await api.student.materials()).toEqual([]);
    expect(await outcome(api.admin.partners.list())).toMatch(/^FORBIDDEN/);
  });

  it("users without an active membership cannot open or start an assessment", async () => {
    for (const u of [outsider, pending]) {
      const s = caller(u).student;
      expect(await outcome(s.start({ assessmentId: A.assessmentId }))).toBe(NO_ACCESS);
      expect(await outcome(s.assessment({ id: A.assessmentId }))).toBe(NO_ACCESS);
      expect(await s.assessments()).toEqual([]);
    }
  });

  it("users without a provider workspace cannot use teacher endpoints", async () => {
    expect(await outcome(caller(outsider).teacher.dashboard())).toBe(NO_WORKSPACE);
    expect(await outcome(caller(shared).teacher.groups.list())).toBe(NO_WORKSPACE);
  });
});

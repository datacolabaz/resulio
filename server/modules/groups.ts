import { and, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { GROUP_FORMATS, GROUP_JOIN_POLICIES, groupMembers, groups, providerWorkspaces, users } from "../../drizzle/schema";
import type { ClassScheduleEntry } from "../../shared/schedule";
import { requireDb, type DbOrTx } from "../db";
import type { TeacherScope } from "./access";
import { AppError } from "./errors";

export type GroupFormat = (typeof GROUP_FORMATS)[number];
export type GroupJoinPolicy = (typeof GROUP_JOIN_POLICIES)[number];

export async function assertGroupOwner(scope: TeacherScope, groupId: string, db: DbOrTx = requireDb()) {
  const [group] = await db
    .select()
    .from(groups)
    .where(and(eq(groups.id, groupId), eq(groups.providerWorkspaceId, scope.workspaceId)))
    .limit(1);
  if (!group) throw new AppError("NOT_FOUND");
  return group;
}

export async function teacherGroups(scope: TeacherScope) {
  const db = requireDb();
  const rows = await db
    .select()
    .from(groups)
    .where(eq(groups.providerWorkspaceId, scope.workspaceId))
    .orderBy(groups.createdAt);
  if (!rows.length) return [];
  const counts = await db
    .select({
      groupId: groupMembers.groupId,
      active: sql<number>`sum(case when ${groupMembers.status} = 'ACTIVE' then 1 else 0 end)`,
      pending: sql<number>`sum(case when ${groupMembers.status} = 'PENDING' then 1 else 0 end)`,
    })
    .from(groupMembers)
    .where(inArray(groupMembers.groupId, rows.map((g) => g.id)))
    .groupBy(groupMembers.groupId);
  const byGroup = new Map(counts.map((c) => [c.groupId, c]));
  return rows.map((g) => ({
    ...g,
    studentCount: Number(byGroup.get(g.id)?.active ?? 0),
    pendingCount: Number(byGroup.get(g.id)?.pending ?? 0),
  }));
}

export interface GroupScheduleInput {
  language: string;
  format: GroupFormat;
  startDate: Date | null;
  classSchedule: ClassScheduleEntry[];
  scheduleVisible: boolean;
}

export async function createGroup(
  scope: TeacherScope,
  data: { name: string; subject: string; grade: string; description: string } & Partial<GroupScheduleInput>,
) {
  const db = requireDb();
  const id = nanoid();
  await db.insert(groups).values({ id, providerWorkspaceId: scope.workspaceId, inviteCode: nanoid(10).toUpperCase(), ...data });
  return assertGroupOwner(scope, id);
}

export async function renameGroup(
  scope: TeacherScope,
  groupId: string,
  patch: Partial<{ name: string; subject: string; grade: string; description: string } & GroupScheduleInput>,
) {
  await assertGroupOwner(scope, groupId);
  await requireDb().update(groups).set(patch).where(eq(groups.id, groupId));
  return assertGroupOwner(scope, groupId);
}

export async function groupMembersList(scope: TeacherScope, groupId: string) {
  await assertGroupOwner(scope, groupId);
  return requireDb()
    .select({
      studentId: groupMembers.userId,
      status: groupMembers.status,
      joinedAt: groupMembers.joinedAt,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
    })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(groupMembers.status, users.name);
}

export async function workspaceOwnerOf(workspaceId: string, db: DbOrTx) {
  const [ws] = await db.select().from(providerWorkspaces).where(eq(providerWorkspaces.id, workspaceId)).limit(1);
  if (!ws) throw new AppError("NOT_FOUND");
  return ws;
}

/** Teacher adds an existing Resulio user (by email) directly as an active student. */
export async function addMemberByEmail(scope: TeacherScope, groupId: string, email: string) {
  const db = requireDb();
  await assertGroupOwner(scope, groupId);
  const [student] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
  if (!student) throw new AppError("STUDENT_NOT_FOUND");
  const ws = await workspaceOwnerOf(scope.workspaceId, db);
  if (ws.ownerUserId === student.id) throw new AppError("CANNOT_JOIN_OWN_GROUP");
  const [existing] = await db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, student.id)))
    .limit(1);
  if (existing?.status === "ACTIVE") throw new AppError("ALREADY_MEMBER");
  if (existing) {
    await db.update(groupMembers).set({ status: "ACTIVE" }).where(eq(groupMembers.id, existing.id));
  } else {
    await db.insert(groupMembers).values({ groupId, userId: student.id, membershipRole: "STUDENT", status: "ACTIVE" });
  }
  return { studentId: student.id, status: "ACTIVE" as const };
}

/** Any signed-in user may request to join another provider's group as a student. */
export async function joinByInvite(userId: number, inviteCode: string) {
  const db = requireDb();
  const [group] = await db.select().from(groups).where(eq(groups.inviteCode, inviteCode)).limit(1);
  if (!group) throw new AppError("INVITE_NOT_FOUND");
  if (!group.codeActive) throw new AppError("INVITE_CODE_INACTIVE");
  if (group.codeExpiresAt && group.codeExpiresAt.getTime() <= Date.now()) throw new AppError("INVITE_CODE_EXPIRED");
  if (group.joinPolicy === "MANUAL") throw new AppError("GROUP_NOT_ACCEPTING");
  const ws = await workspaceOwnerOf(group.providerWorkspaceId, db);
  if (ws.ownerUserId === userId) throw new AppError("CANNOT_JOIN_OWN_GROUP");
  const [existing] = await db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.userId, userId)))
    .limit(1);
  if (existing) throw new AppError("ALREADY_MEMBER");
  const status = group.joinPolicy === "AUTO" ? ("ACTIVE" as const) : ("PENDING" as const);
  await db.insert(groupMembers).values({ groupId: group.id, userId, membershipRole: "STUDENT", status });
  return { groupId: group.id, groupName: group.name, ownerUserId: ws.ownerUserId, status };
}

/** Teacher sets whether `joinByInvite` activates immediately, needs approval, or is refused outright. */
export async function setJoinPolicy(scope: TeacherScope, groupId: string, joinPolicy: GroupJoinPolicy) {
  await assertGroupOwner(scope, groupId);
  await requireDb().update(groups).set({ joinPolicy }).where(eq(groups.id, groupId));
  return { ok: true, joinPolicy };
}

/** Old code stops working the instant a new one is issued — the simplest form of revoke. Reactivates and clears any expiry. */
export async function regenerateInviteCode(scope: TeacherScope, groupId: string) {
  await assertGroupOwner(scope, groupId);
  const inviteCode = nanoid(10).toUpperCase();
  await requireDb().update(groups).set({ inviteCode, codeActive: true, codeExpiresAt: null }).where(eq(groups.id, groupId));
  return { inviteCode };
}

/** Disables the current code/link without changing its value — distinct from regenerating. */
export async function setInviteCodeActive(scope: TeacherScope, groupId: string, active: boolean) {
  await assertGroupOwner(scope, groupId);
  await requireDb().update(groups).set({ codeActive: active }).where(eq(groups.id, groupId));
  return { ok: true, codeActive: active };
}

export async function setInviteCodeExpiry(scope: TeacherScope, groupId: string, expiresAt: Date | null) {
  await assertGroupOwner(scope, groupId);
  await requireDb().update(groups).set({ codeExpiresAt: expiresAt }).where(eq(groups.id, groupId));
  return { ok: true, codeExpiresAt: expiresAt };
}

export interface PublicGroupPreview {
  name: string;
  subject: string;
  grade: string;
  teacherName: string;
  language: string;
  format: GroupFormat;
  joinPolicy: GroupJoinPolicy;
  description: string | null;
  startDate: Date | null;
  classSchedule: ClassScheduleEntry[];
  /** The teacher's own workspace specialty — lets the join flow suggest/lock the student's learning goal. */
  teachingCategory: string;
  teachingSubcategory: string;
}

export async function publicInvite(inviteCode: string): Promise<PublicGroupPreview | null> {
  const [group] = await requireDb()
    .select({
      name: groups.name,
      subject: groups.subject,
      grade: groups.grade,
      description: groups.description,
      language: groups.language,
      format: groups.format,
      joinPolicy: groups.joinPolicy,
      startDate: groups.startDate,
      classSchedule: groups.classSchedule,
      scheduleVisible: groups.scheduleVisible,
      providerName: providerWorkspaces.publicDisplayName,
      providerTitle: providerWorkspaces.title,
      teachingCategory: providerWorkspaces.teachingCategory,
      teachingSubcategory: providerWorkspaces.teachingSubcategory,
    })
    .from(groups)
    .innerJoin(providerWorkspaces, eq(providerWorkspaces.id, groups.providerWorkspaceId))
    .where(eq(groups.inviteCode, inviteCode))
    .limit(1);
  if (!group) return null;
  return {
    name: group.name,
    subject: group.subject,
    grade: group.grade,
    teacherName: group.providerName || group.providerTitle,
    language: group.language,
    format: group.format,
    joinPolicy: group.joinPolicy,
    description: group.description,
    startDate: group.scheduleVisible ? group.startDate : null,
    classSchedule: group.scheduleVisible ? group.classSchedule : [],
    teachingCategory: group.teachingCategory,
    teachingSubcategory: group.teachingSubcategory,
  };
}

export async function approveMember(scope: TeacherScope, groupId: string, studentId: number) {
  await assertGroupOwner(scope, groupId);
  const [res] = await requireDb()
    .update(groupMembers)
    .set({ status: "ACTIVE" })
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, studentId)));
  if (res.affectedRows !== 1) throw new AppError("NOT_FOUND");
  return { ok: true };
}

export async function removeMember(scope: TeacherScope, groupId: string, studentId: number) {
  await assertGroupOwner(scope, groupId);
  await requireDb()
    .delete(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, studentId)));
  return { ok: true };
}

export async function activeGroupIdsOfStudent(userId: number, db: DbOrTx = requireDb()) {
  const rows = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(
      and(eq(groupMembers.userId, userId), eq(groupMembers.status, "ACTIVE"), eq(groupMembers.membershipRole, "STUDENT")),
    );
  return rows.map((r) => r.groupId);
}

export async function activeStudentIdsOfGroups(groupIds: string[], db: DbOrTx = requireDb()) {
  if (!groupIds.length) return [];
  const rows = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(
      and(inArray(groupMembers.groupId, groupIds), eq(groupMembers.status, "ACTIVE"), eq(groupMembers.membershipRole, "STUDENT")),
    );
  return [...new Set(rows.map((r) => r.userId))];
}

/** All users with an active student membership in any group of the workspace. */
export async function teacherStudentIds(scope: TeacherScope) {
  const rows = await requireDb()
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(
      and(
        eq(groups.providerWorkspaceId, scope.workspaceId),
        eq(groupMembers.status, "ACTIVE"),
        eq(groupMembers.membershipRole, "STUDENT"),
      ),
    );
  return [...new Set(rows.map((r) => r.userId))];
}

export async function assertTeacherHasStudent(scope: TeacherScope, studentId: number) {
  const ids = await teacherStudentIds(scope);
  if (!ids.includes(studentId)) throw new AppError("NOT_FOUND");
}

export async function teacherStudents(scope: TeacherScope) {
  const db = requireDb();
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
      groupName: groups.name,
      groupId: groups.id,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(
      and(
        eq(groups.providerWorkspaceId, scope.workspaceId),
        eq(groupMembers.status, "ACTIVE"),
        eq(groupMembers.membershipRole, "STUDENT"),
      ),
    );
  const byStudent = new Map<number, { id: number; name: string | null; email: string | null; avatarUrl: string | null; groups: string[] }>();
  for (const r of rows) {
    const cur = byStudent.get(r.id) ?? { id: r.id, name: r.name, email: r.email, avatarUrl: r.avatarUrl, groups: [] };
    cur.groups.push(r.groupName);
    byStudent.set(r.id, cur);
  }
  return [...byStudent.values()];
}

/** Groups the user belongs to as a student, with the provider's public name. */
export async function studentGroups(userId: number) {
  const rows = await requireDb()
    .select({
      id: groups.id,
      name: groups.name,
      subject: groups.subject,
      status: groupMembers.status,
      providerName: providerWorkspaces.publicDisplayName,
      providerTitle: providerWorkspaces.title,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(providerWorkspaces, eq(providerWorkspaces.id, groups.providerWorkspaceId))
    .where(and(eq(groupMembers.userId, userId), eq(groupMembers.membershipRole, "STUDENT")));
  return rows.map(({ providerName, providerTitle, ...g }) => ({ ...g, provider: providerName || providerTitle }));
}

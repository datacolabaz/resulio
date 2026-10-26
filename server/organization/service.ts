import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import { departments, providerWorkspaces, users, workspaceMembers, type WorkspaceMember } from "../../drizzle/schema";
import {
  INVITE_EXPIRY_DAYS,
  MAX_MEMBERS_PER_WORKSPACE,
  canAssignRole,
  canManageDepartments,
  canManageMembers,
  canRemoveRole,
  memberDisplayStatus,
  type DepartmentInput,
  type InviteMemberInput,
  type UpdateMemberInput,
  type WorkspaceMemberRole,
} from "../../shared/organization";
import type { TeacherScope } from "../modules/access";
import { AppError } from "../modules/errors";
import { requireDb, type DbOrTx } from "../db";

/**
 * Təşkilat / Korporativ Workspace service: staff invites/members and departments on top of a
 * Provider Workspace. Mirrors server/modules/groupEmailInvites.ts's hashed-token invite pattern.
 * server/modules/access.ts's `managedWorkspaces` already recognizes ACTIVE ADMIN rows here as
 * owner-equivalent for every other teacher-facing module; everything in this file enforces its
 * own, finer permission matrix (shared/organization.ts) on top of that.
 */

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("hex");
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

/** The acting user's effective role in this workspace: OWNER if they own it (no row needed),
 * else their ACTIVE workspace_members role, else null if they have no standing there at all. */
export async function actorRoleOf(scope: TeacherScope, db: DbOrTx = requireDb()): Promise<WorkspaceMemberRole | null> {
  const [ws] = await db.select({ ownerUserId: providerWorkspaces.ownerUserId }).from(providerWorkspaces).where(eq(providerWorkspaces.id, scope.workspaceId)).limit(1);
  if (ws?.ownerUserId === scope.userId) return "OWNER";
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, scope.workspaceId), eq(workspaceMembers.userId, scope.userId), eq(workspaceMembers.status, "ACTIVE")))
    .limit(1);
  return row?.role ?? null;
}

async function requireManageMembers(scope: TeacherScope, db: DbOrTx): Promise<WorkspaceMemberRole> {
  const role = await actorRoleOf(scope, db);
  if (!role || !canManageMembers(role)) throw new AppError("ORG_NOT_MANAGER");
  return role;
}

async function requireManageDepartments(scope: TeacherScope, db: DbOrTx): Promise<WorkspaceMemberRole> {
  const role = await actorRoleOf(scope, db);
  if (!role || !canManageDepartments(role)) throw new AppError("ORG_NOT_MANAGER");
  return role;
}

export type MemberView = {
  id: string;
  userId: number | null;
  name: string | null;
  email: string;
  role: WorkspaceMemberRole;
  displayStatus: ReturnType<typeof memberDisplayStatus>;
  departmentId: string | null;
  invitedAt: Date;
  joinedAt: Date | null;
};

/** Every staff seat on this workspace: the synthesized OWNER row (there's no `workspace_members`
 * row for the owner -- see drizzle/organizationSchema.ts), then every member row that isn't a
 * long-settled REVOKED one past its own relevance. */
export async function listMembers(scope: TeacherScope): Promise<MemberView[]> {
  const db = requireDb();
  await requireManageMembers(scope, db);
  const [[owner], rows] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(providerWorkspaces)
      .innerJoin(users, eq(users.id, providerWorkspaces.ownerUserId))
      .where(eq(providerWorkspaces.id, scope.workspaceId))
      .limit(1),
    db
      .select({ member: workspaceMembers, name: users.name })
      .from(workspaceMembers)
      .leftJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, scope.workspaceId))
      .orderBy(desc(workspaceMembers.createdAt)),
  ]);
  const now = new Date();
  const out: MemberView[] = [];
  if (owner) {
    out.push({
      id: `owner:${owner.id}`,
      userId: owner.id,
      name: owner.name,
      email: owner.email ?? "",
      role: "OWNER",
      displayStatus: "ACTIVE",
      departmentId: null,
      invitedAt: now,
      joinedAt: now,
    });
  }
  for (const r of rows) {
    out.push({
      id: r.member.id,
      userId: r.member.userId,
      name: r.name ?? null,
      email: r.member.invitedEmail,
      role: r.member.role,
      displayStatus: memberDisplayStatus(r.member, now),
      departmentId: r.member.departmentId,
      invitedAt: r.member.createdAt,
      joinedAt: r.member.joinedAt,
    });
  }
  return out;
}

/** Invites staff by email. Returns the raw token once (never stored) so the caller can build and
 * share the accept link themselves -- same convention as `createEmailInvite`; no email-dispatch
 * integration exists for this yet (P1, see ORGANIZATION-PLAN.md). */
export async function inviteMember(scope: TeacherScope, input: InviteMemberInput): Promise<{ id: string; token: string }> {
  const db = requireDb();
  const actorRole = await requireManageMembers(scope, db);
  if (!canAssignRole(actorRole, input.role)) throw new AppError("ORG_ROLE_NOT_ASSIGNABLE");

  const [owner] = await db.select({ email: users.email }).from(providerWorkspaces).innerJoin(users, eq(users.id, providerWorkspaces.ownerUserId)).where(eq(providerWorkspaces.id, scope.workspaceId)).limit(1);
  if (owner?.email && owner.email.toLowerCase() === input.email) throw new AppError("ORG_CANNOT_INVITE_SELF");

  const existing = await db
    .select({ id: workspaceMembers.id, status: workspaceMembers.status, expiresAt: workspaceMembers.expiresAt })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, scope.workspaceId), eq(workspaceMembers.invitedEmail, input.email), ne(workspaceMembers.status, "REVOKED")));
  const now = new Date();
  for (const row of existing) {
    const status = memberDisplayStatus({ status: row.status, expiresAt: row.expiresAt }, now);
    if (status === "ACTIVE") throw new AppError("ORG_ALREADY_MEMBER");
    if (status === "PENDING") throw new AppError("ORG_ALREADY_INVITED");
  }

  const activeCount = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, scope.workspaceId), eq(workspaceMembers.status, "ACTIVE")));
  if (activeCount.length >= MAX_MEMBERS_PER_WORKSPACE) throw new AppError("ORG_MEMBER_LIMIT");

  if (input.departmentId) await departmentOrThrow(scope, input.departmentId, db);

  const token = newToken();
  const id = nanoid();
  await db.insert(workspaceMembers).values({
    id,
    workspaceId: scope.workspaceId,
    invitedEmail: input.email,
    role: input.role,
    status: "PENDING",
    departmentId: input.departmentId ?? null,
    invitedByUserId: scope.userId,
    tokenHash: hashToken(token),
    expiresAt: addDays(now, INVITE_EXPIRY_DAYS),
  });
  return { id, token };
}

/** Accepts an email-restricted org invite for the signed-in user; activates the seat immediately. */
export async function acceptInvite(userId: number, userEmail: string, token: string): Promise<{ workspaceId: string; workspaceTitle: string }> {
  const db = requireDb();
  const normalizedEmail = userEmail.trim().toLowerCase();
  const [invite] = await db.select().from(workspaceMembers).where(eq(workspaceMembers.tokenHash, hashToken(token))).limit(1);
  if (!invite) throw new AppError("ORG_INVITE_NOT_FOUND");
  const status = memberDisplayStatus(invite);
  if (status === "REVOKED") throw new AppError("ORG_INVITE_NOT_FOUND");
  if (status === "EXPIRED") throw new AppError("ORG_INVITE_EXPIRED");
  if (status === "ACTIVE") throw new AppError("ORG_ALREADY_MEMBER");
  if (invite.invitedEmail !== normalizedEmail) throw new AppError("ORG_INVITE_MISMATCH");

  const [workspace] = await db.select({ title: providerWorkspaces.title }).from(providerWorkspaces).where(eq(providerWorkspaces.id, invite.workspaceId)).limit(1);
  if (!workspace) throw new AppError("NOT_FOUND");

  await db.update(workspaceMembers).set({ userId, status: "ACTIVE", joinedAt: new Date() }).where(eq(workspaceMembers.id, invite.id));
  return { workspaceId: invite.workspaceId, workspaceTitle: workspace.title };
}

async function memberOrThrow(scope: TeacherScope, memberId: string, db: DbOrTx): Promise<WorkspaceMember> {
  const [row] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, scope.workspaceId))).limit(1);
  if (!row) throw new AppError("ORG_MEMBER_NOT_FOUND");
  return row;
}

export async function updateMember(scope: TeacherScope, input: UpdateMemberInput): Promise<void> {
  const db = requireDb();
  const actorRole = await requireManageMembers(scope, db);
  const target = await memberOrThrow(scope, input.memberId, db);
  if (!canAssignRole(actorRole, input.role) || !canRemoveRole(actorRole, target.role)) throw new AppError("ORG_ROLE_NOT_ASSIGNABLE");
  if (input.departmentId) await departmentOrThrow(scope, input.departmentId, db);
  await db.update(workspaceMembers).set({ role: input.role, departmentId: input.departmentId ?? null }).where(eq(workspaceMembers.id, input.memberId));
}

export async function removeMember(scope: TeacherScope, memberId: string): Promise<void> {
  const db = requireDb();
  const actorRole = await requireManageMembers(scope, db);
  const target = await memberOrThrow(scope, memberId, db);
  if (!canRemoveRole(actorRole, target.role)) throw new AppError("ORG_CANNOT_REMOVE_ROLE");
  await db.update(workspaceMembers).set({ status: "REVOKED", revokedAt: new Date() }).where(eq(workspaceMembers.id, memberId));
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

async function departmentOrThrow(scope: TeacherScope, departmentId: string, db: DbOrTx) {
  const [row] = await db.select().from(departments).where(and(eq(departments.id, departmentId), eq(departments.workspaceId, scope.workspaceId))).limit(1);
  if (!row) throw new AppError("ORG_DEPARTMENT_NOT_FOUND");
  return row;
}

export async function listDepartments(scope: TeacherScope) {
  const db = requireDb();
  await requireManageDepartments(scope, db);
  return db.select().from(departments).where(eq(departments.workspaceId, scope.workspaceId)).orderBy(desc(departments.createdAt));
}

export async function createDepartment(scope: TeacherScope, input: DepartmentInput) {
  const db = requireDb();
  await requireManageDepartments(scope, db);
  const [dupe] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.workspaceId, scope.workspaceId), eq(departments.name, input.name))).limit(1);
  if (dupe) throw new AppError("ORG_DEPARTMENT_NAME_EXISTS");
  const id = nanoid();
  await db.insert(departments).values({ id, workspaceId: scope.workspaceId, name: input.name, createdByUserId: scope.userId });
  const [row] = await db.select().from(departments).where(eq(departments.id, id)).limit(1);
  return row!;
}

export async function renameDepartment(scope: TeacherScope, departmentId: string, name: string) {
  const db = requireDb();
  await requireManageDepartments(scope, db);
  await departmentOrThrow(scope, departmentId, db);
  const [dupe] = await db
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.workspaceId, scope.workspaceId), eq(departments.name, name), ne(departments.id, departmentId)))
    .limit(1);
  if (dupe) throw new AppError("ORG_DEPARTMENT_NAME_EXISTS");
  await db.update(departments).set({ name }).where(eq(departments.id, departmentId));
}

/** Deleting a department never deletes the members in it (no FK constraints in this schema --
 * app-level cleanup, same convention as deleteLesson's cascade): they're simply un-assigned. */
export async function deleteDepartment(scope: TeacherScope, departmentId: string) {
  const db = requireDb();
  await requireManageDepartments(scope, db);
  await departmentOrThrow(scope, departmentId, db);
  await db.update(workspaceMembers).set({ departmentId: null }).where(and(eq(workspaceMembers.workspaceId, scope.workspaceId), eq(workspaceMembers.departmentId, departmentId)));
  await db.delete(departments).where(eq(departments.id, departmentId));
}

/** Pending/accepted invites this email has outstanding, for a signed-in user's own "my invites" view. */
export async function invitesForEmail(email: string) {
  const db = requireDb();
  const normalized = email.trim().toLowerCase();
  const rows = await db
    .select({ member: workspaceMembers, workspaceTitle: providerWorkspaces.title })
    .from(workspaceMembers)
    .innerJoin(providerWorkspaces, eq(providerWorkspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.invitedEmail, normalized), eq(workspaceMembers.status, "PENDING")));
  const now = new Date();
  return rows
    .filter((r) => memberDisplayStatus(r.member, now) === "PENDING")
    .map((r) => ({ workspaceId: r.member.workspaceId, workspaceTitle: r.workspaceTitle, role: r.member.role, invitedAt: r.member.createdAt }));
}

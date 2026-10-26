import { z } from "zod";

/**
 * Təşkilat / Korporativ Workspace (Organization / Corporate Workspace): lets a Provider
 * Workspace's single owner (`providerWorkspaces.ownerUserId`) delegate staff seats to other
 * accounts instead of being the only person who can manage it. Additive to the existing
 * single-owner model -- the owner keeps `ownerUserId` exactly as before and is never required to
 * also hold a `workspace_members` row (see `server/organization/service.ts`'s `listMembers`,
 * which synthesizes the owner as the first row). Types, zod input schemas and pure
 * permission-matrix helpers live here so client and server agree on them; DB-aware logic lives in
 * server/organization/service.ts, following the shared/lessonIntegration.ts + server/lessons/
 * split used by the lesson-integration feature.
 */

export const WORKSPACE_MEMBER_ROLES = ["OWNER", "ADMIN", "HR_ADMIN", "TRAINER", "MANAGER"] as const;
export type WorkspaceMemberRole = (typeof WORKSPACE_MEMBER_ROLES)[number];

/** Roles that may be invited through `inviteMember`. OWNER is never invited -- there is exactly
 * one per workspace (`providerWorkspaces.ownerUserId`); transferring it is a separate, not-yet-built
 * flow (see ORGANIZATION-PLAN.md P1). */
export const INVITABLE_ROLES = ["ADMIN", "HR_ADMIN", "TRAINER", "MANAGER"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export const WORKSPACE_MEMBER_STATUSES = ["PENDING", "ACTIVE", "REVOKED"] as const;
export type WorkspaceMemberStatus = (typeof WORKSPACE_MEMBER_STATUSES)[number];

/** Derived display status: a PENDING row past its invite's `expiresAt` reads as expired without a DB write. */
export type MemberDisplayStatus = "PENDING" | "ACTIVE" | "REVOKED" | "EXPIRED";

export const INVITE_EXPIRY_DAYS = 7;
export const MAX_MEMBERS_PER_WORKSPACE = 50;

// ---------------------------------------------------------------------------
// Permission matrix (pure, no DB -- unit-testable and shared by client + server)
// ---------------------------------------------------------------------------

/**
 * Full workspace-management authority: resolving the teaching scope for every existing
 * teacher-facing endpoint (exams, groups, question bank, analytics...) as if they owned it. This
 * first implementation pass only wires OWNER and ADMIN into that resolution (server/modules/access.ts
 * `managedWorkspaces`) -- HR_ADMIN/TRAINER/MANAGER get the organization module's own member/department
 * management surface, but fine-grained restricted access to the *existing* subsystems ("Trainer sees
 * only their own exams", "Manager sees only their department's results") is an explicitly-flagged P1
 * follow-up, not a blanket grant, to avoid a single risky change to the live authorization path.
 */
export function isOwnerEquivalent(role: WorkspaceMemberRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export function canManageMembers(role: WorkspaceMemberRole): boolean {
  return isOwnerEquivalent(role);
}

export function canManageDepartments(role: WorkspaceMemberRole): boolean {
  return isOwnerEquivalent(role);
}

/**
 * Roles an actor holding `actorRole` may assign to someone else (inviting or re-assigning).
 * OWNER may hand out any staff role; ADMIN may hand out the non-admin staff roles but never
 * ADMIN or OWNER itself -- otherwise an admin could silently mint a peer admin. Nobody else may
 * assign any role.
 */
export function assignableRoles(actorRole: WorkspaceMemberRole): readonly WorkspaceMemberRole[] {
  if (actorRole === "OWNER") return ["ADMIN", "HR_ADMIN", "TRAINER", "MANAGER"];
  if (actorRole === "ADMIN") return ["HR_ADMIN", "TRAINER", "MANAGER"];
  return [];
}

export function canAssignRole(actorRole: WorkspaceMemberRole, role: WorkspaceMemberRole): boolean {
  return assignableRoles(actorRole).includes(role);
}

/**
 * Whether `actorRole` may remove/revoke a member holding `targetRole`. The OWNER seat itself can
 * never be removed this way (ownership transfer, if ever built, is its own flow); an ADMIN may
 * remove any staff member except another ADMIN -- only the OWNER can do that.
 */
export function canRemoveRole(actorRole: WorkspaceMemberRole, targetRole: WorkspaceMemberRole): boolean {
  if (targetRole === "OWNER") return false;
  if (actorRole === "OWNER") return true;
  if (actorRole === "ADMIN") return targetRole !== "ADMIN";
  return false;
}

export function memberDisplayStatus(member: { status: WorkspaceMemberStatus; expiresAt: Date | null }, now = new Date()): MemberDisplayStatus {
  if (member.status !== "PENDING") return member.status;
  return member.expiresAt && member.expiresAt.getTime() < now.getTime() ? "EXPIRED" : "PENDING";
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const inviteMemberInput = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  role: z.enum(INVITABLE_ROLES),
  departmentId: z.string().trim().min(1).max(32).nullable().optional(),
});
export type InviteMemberInput = z.infer<typeof inviteMemberInput>;

export const memberIdInput = z.object({ memberId: z.string().trim().min(1).max(32) });
export type MemberIdInput = z.infer<typeof memberIdInput>;

export const updateMemberInput = z.object({
  memberId: z.string().trim().min(1).max(32),
  role: z.enum(INVITABLE_ROLES),
  departmentId: z.string().trim().min(1).max(32).nullable().optional(),
});
export type UpdateMemberInput = z.infer<typeof updateMemberInput>;

export const acceptInviteInput = z.object({ token: z.string().trim().min(1).max(128) });
export type AcceptInviteInput = z.infer<typeof acceptInviteInput>;

export const departmentInput = z.object({ name: z.string().trim().min(1).max(160) });
export type DepartmentInput = z.infer<typeof departmentInput>;

export const departmentIdInput = z.object({ departmentId: z.string().trim().min(1).max(32) });
export type DepartmentIdInput = z.infer<typeof departmentIdInput>;

export const renameDepartmentInput = z.object({
  departmentId: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(160),
});
export type RenameDepartmentInput = z.infer<typeof renameDepartmentInput>;

import { and, asc, eq } from "drizzle-orm";
import {
  groupMembers,
  partnerProfiles,
  platformRoles,
  providerWorkspaces,
  type PartnerProfile,
  type PlatformRole,
  type ProviderWorkspace,
  type UiContext,
} from "../../drizzle/schema";
import { requireDb, type DbOrTx } from "../db";

/** Resolved teaching authority for one request: the managed workspace plus the acting user. */
export type TeacherScope = { workspaceId: string; userId: number };

export async function managedWorkspaces(userId: number, db: DbOrTx = requireDb()) {
  return db
    .select()
    .from(providerWorkspaces)
    .where(eq(providerWorkspaces.ownerUserId, userId))
    .orderBy(asc(providerWorkspaces.createdAt));
}

/**
 * The workspace this user may manage for the current request. `requestedId` is only a
 * client hint and must match a workspace the user actually owns.
 */
export async function resolveWorkspace(userId: number, requestedId?: string | null): Promise<ProviderWorkspace | null> {
  return pickWorkspace(await managedWorkspaces(userId), requestedId);
}

/** Only for classifying a refused workspace header; never grants access. */
export async function workspaceExists(id: string, db: DbOrTx = requireDb()) {
  const [row] = await db.select({ id: providerWorkspaces.id }).from(providerWorkspaces).where(eq(providerWorkspaces.id, id)).limit(1);
  return !!row;
}

export function pickWorkspace<W extends { id: string }>(owned: W[], requestedId?: string | null): W | null {
  if (requestedId) return owned.find((w) => w.id === requestedId) ?? null;
  return owned[0] ?? null;
}

export async function membershipCounts(userId: number, db: DbOrTx = requireDb()) {
  const rows = await db
    .select({ status: groupMembers.status })
    .from(groupMembers)
    .where(and(eq(groupMembers.userId, userId), eq(groupMembers.membershipRole, "STUDENT")));
  return {
    active: rows.filter((r) => r.status === "ACTIVE").length,
    pending: rows.filter((r) => r.status === "PENDING").length,
  };
}

export async function partnerProfileOf(userId: number, db: DbOrTx = requireDb()): Promise<PartnerProfile | null> {
  const [row] = await db.select().from(partnerProfiles).where(eq(partnerProfiles.userId, userId)).limit(1);
  return row ?? null;
}

export async function platformRolesOf(userId: number, db: DbOrTx = requireDb()): Promise<PlatformRole[]> {
  const rows = await db.select({ role: platformRoles.role }).from(platformRoles).where(eq(platformRoles.userId, userId));
  return rows.map((r) => r.role);
}

export type UserAccess = {
  /** Contexts shown in the switcher. */
  contexts: Record<UiContext, boolean>;
  activeMemberships: number;
  pendingMemberships: number;
  workspaces: Pick<ProviderWorkspace, "id" | "title" | "publicDisplayName" | "providerType" | "subscriptionStatus">[];
  partnerStatus: PartnerProfile["status"] | null;
  platformRoles: PlatformRole[];
};

export async function resolveAccess(userId: number): Promise<UserAccess> {
  const [memberships, workspaces, partner, roles] = await Promise.all([
    membershipCounts(userId),
    managedWorkspaces(userId),
    partnerProfileOf(userId),
    platformRolesOf(userId),
  ]);
  return {
    contexts: {
      learning: memberships.active > 0,
      teaching: workspaces.length > 0,
      partner: partner?.status === "APPROVED",
    },
    activeMemberships: memberships.active,
    pendingMemberships: memberships.pending,
    workspaces: workspaces.map((w) => ({
      id: w.id,
      title: w.title,
      publicDisplayName: w.publicDisplayName,
      providerType: w.providerType,
      subscriptionStatus: w.subscriptionStatus,
    })),
    partnerStatus: partner?.status ?? null,
    platformRoles: roles,
  };
}

/** Whether the user may open a context's UI. A pending join request is enough to see the learning area. */
export function canEnterContext(access: UserAccess, context: UiContext): boolean {
  if (context === "learning") return access.activeMemberships + access.pendingMemberships > 0;
  return access.contexts[context];
}

/** Last used context if still valid, otherwise the first one the user can enter. */
export function defaultContext(access: UserAccess, last: UiContext | null): UiContext | null {
  if (last && canEnterContext(access, last)) return last;
  return (["learning", "teaching", "partner"] as const).find((c) => canEnterContext(access, c)) ?? null;
}

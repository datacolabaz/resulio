import { and, asc, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
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

export const generateReferralCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 10);

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

/**
 * Every user is a referral partner from the moment they're first looked up this way -- there is
 * no apply/review step before someone can see and share their own referral link. An admin can
 * still SUSPEND an individual account after the fact (see `decidePartnerProfile`); that is the
 * fraud-control lever now, not a gate in front of everyone.
 *
 * Lazily provisions on first call so this also backfills any account that existed before this
 * behavior shipped, with no migration script needed. `partnerProfiles.userId` is unique, so a
 * concurrent double-call just loses the insert race and falls through to re-reading the row the
 * other call created.
 */
export async function ensurePartnerProfile(userId: number, db: DbOrTx = requireDb()): Promise<PartnerProfile> {
  const existing = await partnerProfileOf(userId, db);
  if (existing) return existing;
  try {
    await db.insert(partnerProfiles).values({ userId, status: "APPROVED", referralCode: generateReferralCode(), approvedAt: new Date() });
  } catch {
    // Unique-constraint race: another concurrent call already created this user's row.
  }
  const row = await partnerProfileOf(userId, db);
  if (!row) throw new Error(`Failed to provision partner profile for user ${userId}`);
  return row;
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
    ensurePartnerProfile(userId),
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

/**
 * Last used context if still valid, otherwise the first substantive one the user can enter.
 * `partner` is deliberately excluded from this automatic fallback: every user can always enter
 * it now (see `ensurePartnerProfile`), so it would otherwise become the landing screen for a
 * brand-new user with nothing else set up yet, instead of the onboarding screen. It only becomes
 * the active context by explicit choice -- navigating there, which the `last` check above then
 * remembers for next time.
 */
export function defaultContext(access: UserAccess, last: UiContext | null): UiContext | null {
  if (last && canEnterContext(access, last)) return last;
  return (["learning", "teaching"] as const).find((c) => canEnterContext(access, c)) ?? null;
}

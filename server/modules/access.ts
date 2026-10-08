import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import type { PartnerStatus } from "../../shared/adminPermissions";
import {
  groupMembers,
  partnerProfiles,
  platformRoles,
  providerWorkspaces,
  syllabusAccessGrants,
  type PartnerProfile,
  type PlatformRole,
  type ProviderWorkspace,
  type UiContext,
} from "../../drizzle/schema";
import type { RequestMeta } from "../_core/requestMeta";
import { requireDb, type DbOrTx } from "../db";
import { appendAudit } from "./admin/audit";

export const generateReferralCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 10);

/** NULL actor on the audit entry below -- see appendAudit's SYSTEM convention. Not a real request. */
const ENSURE_PARTNER_META: RequestMeta = { requestId: null, ipHash: null, userAgentSummary: "ensure-partner-profile" };

/**
 * Statuses a `partner_profiles` row can be left in from the old apply/admin-review gate (removed --
 * see `ensurePartnerProfile`). None of these are a deliberate post-hoc admin decision the way
 * SUSPENDED is, so an account stuck in one of them is auto-upgraded rather than left stranded
 * behind a gate the product no longer has a UI for.
 */
const LEGACY_GATE_STATUSES: readonly PartnerStatus[] = ["PENDING", "INFO_REQUESTED", "REJECTED"];

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

/**
 * Whether the user holds an individual syllabus grant that hasn't expired or been revoked. Such
 * a student (e.g. accepted from a public syllabus link) may belong to no group at all, but still
 * needs the learning area to open the programme.
 */
export async function hasIndividualSyllabusGrant(userId: number, db: DbOrTx = requireDb()) {
  const [row] = await db
    .select({ id: syllabusAccessGrants.id })
    .from(syllabusAccessGrants)
    .where(
      and(
        eq(syllabusAccessGrants.studentId, userId),
        eq(syllabusAccessGrants.status, "ACTIVE"),
        or(isNull(syllabusAccessGrants.endsAt), gt(syllabusAccessGrants.endsAt, new Date())),
      ),
    )
    .limit(1);
  return !!row;
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
 *
 * An account that applied through the old "Apply to become a partner" flow before this gate was
 * removed can already have a row sitting in PENDING, INFO_REQUESTED, or REJECTED -- none of those
 * were ever a decision an admin made about THIS person specifically (REJECTED there meant "this
 * application wasn't convincing enough", a bar that no longer exists for anyone). Left alone, that
 * leftover row would keep such an account locked out forever, since a row already existing is what
 * skips provisioning above. So any of those three statuses is auto-upgraded to APPROVED here, the
 * same outcome a brand-new user gets. SUSPENDED is the one status this never touches: it's the
 * fraud-control action described above, made about this specific account after they already had
 * access, and only an admin REACTIVATE should undo it.
 */
export async function ensurePartnerProfile(userId: number, db: DbOrTx = requireDb()): Promise<PartnerProfile> {
  const existing = await partnerProfileOf(userId, db);
  if (existing) {
    if (!LEGACY_GATE_STATUSES.includes(existing.status)) return existing;
    const now = new Date();
    // decidedBy/decidedAt are cleared, not kept: whatever human decision is on that row (an
    // admin's REQUEST_INFO or REJECT) is exactly what's being overridden here, so leaving their
    // id in place would misattribute this approval to them.
    await db
      .update(partnerProfiles)
      .set({ status: "APPROVED", approvedAt: existing.approvedAt ?? now, decidedBy: null, decidedAt: null })
      .where(eq(partnerProfiles.id, existing.id));
    await appendAudit(
      db,
      null,
      {
        action: "PARTNER_APPROVED",
        targetType: "PARTNER_PROFILE",
        targetId: existing.id,
        userId,
        before: { status: existing.status },
        after: { status: "APPROVED" },
        reason: "Auto-approved: the apply/review gate this status came from was removed.",
      },
      ENSURE_PARTNER_META,
    );
    return { ...existing, status: "APPROVED", approvedAt: existing.approvedAt ?? now, decidedBy: null, decidedAt: null };
  }
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
  const learning = memberships.active > 0 || (await hasIndividualSyllabusGrant(userId));
  return {
    contexts: {
      learning,
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
  if (context === "learning") return access.contexts.learning || access.pendingMemberships > 0;
  return access.contexts[context];
}

/**
 * Last used context if still valid, otherwise the first substantive one the user can enter.
 *
 * `partner` is never returned here, from either path. It isn't a landing destination at all --
 * it's one page reached from inside the teaching/learning sidebar (see PartnerPage), not a space
 * of its own to land back in. Every user can always enter it (see `ensurePartnerProfile`), so if
 * it were allowed through the `last` check below, visiting it even once would make it "sticky":
 * the very next login -- Google included, which asks this function for the post-login
 * destination -- would open straight to Partner instead of the real workspace. (A `lastActiveContext`
 * of "partner" can also simply be stale: it's how an older build, before the client stopped ever
 * recording it, left some accounts. Filtering it out here self-heals those on their next login,
 * same as `ensurePartnerProfile` self-heals a leftover pre-auto-approval status -- no migration
 * needed.)
 */
export function defaultContext(access: UserAccess, last: UiContext | null): UiContext | null {
  if (last && last !== "partner" && canEnterContext(access, last)) return last;
  return (["learning", "teaching"] as const).find((c) => canEnterContext(access, c)) ?? null;
}

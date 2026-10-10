import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { groupInviteLinks, groupMembers, groups, providerWorkspaces, users, type GroupInviteLink } from "../../drizzle/schema";
import type { GroupType } from "../../shared/groupType";
import type { ClassScheduleEntry } from "../../shared/schedule";
import { requireDb } from "../db";
import type { TeacherScope } from "./access";
import { AppError } from "./errors";
import { recordJoinSource } from "./groupJoinSources";
import { groupProfileOf } from "./groupProfiles";
import { assertGroupOwner, type GroupFormat } from "./groups";

/** 32 random bytes = 256 bits, base64url-encoded to exactly 43 URL-safe characters. */
const TOKEN_BYTES = 32;
export const INVITE_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const DEFAULT_INVITE_LINK_EXPIRY_DAYS = 7;
export const MAX_INVITE_LINK_EXPIRY_DAYS = 90;
export const MAX_INVITE_LINKS_PER_BATCH = 50;

export const newInviteLinkToken = () => randomBytes(TOKEN_BYTES).toString("base64url");
export const hashInviteLinkToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const isWellFormedInviteLinkToken = (token: string) => INVITE_LINK_TOKEN_PATTERN.test(token);

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

export type InviteLinkStatus = "ACTIVE" | "USED" | "EXPIRED" | "REVOKED";

/** Derived, never stored. A used link stays USED even after it would have expired or been revoked. */
export function inviteLinkStatus(
  link: Pick<GroupInviteLink, "usedByUserId" | "revokedAt" | "expiresAt">,
  now = new Date(),
): InviteLinkStatus {
  if (link.usedByUserId !== null) return "USED";
  if (link.revokedAt) return "REVOKED";
  return link.expiresAt.getTime() <= now.getTime() ? "EXPIRED" : "ACTIVE";
}

/** Labels win over `count` when given: one link per label. Blank labels are kept as unlabeled links. */
export function plannedLabels(input: { count?: number; labels?: string[] }): string[] {
  const labels = (input.labels ?? []).map((l) => l.trim().slice(0, 120));
  const planned = labels.length ? labels : Array.from({ length: input.count ?? 1 }, () => "");
  if (!planned.length || planned.length > MAX_INVITE_LINKS_PER_BATCH) throw new AppError("INVITE_LINK_BATCH_TOO_LARGE");
  return planned;
}

// ---------------------------------------------------------------------------
// Teacher side
// ---------------------------------------------------------------------------

/** Bulk-creates single-use links. The raw tokens are returned exactly once and never stored. */
export async function createInviteLinks(
  scope: TeacherScope,
  groupId: string,
  input: { count?: number; labels?: string[]; expiresInDays?: number },
) {
  const db = requireDb();
  await assertGroupOwner(scope, groupId, db);
  const labels = plannedLabels(input);
  const days = Math.min(Math.max(input.expiresInDays ?? DEFAULT_INVITE_LINK_EXPIRY_DAYS, 1), MAX_INVITE_LINK_EXPIRY_DAYS);
  const expiresAt = addDays(new Date(), days);
  const created = labels.map((label) => ({ id: nanoid(), label, token: newInviteLinkToken(), expiresAt }));
  await db.insert(groupInviteLinks).values(
    created.map((c) => ({
      id: c.id,
      groupId,
      tokenHash: hashInviteLinkToken(c.token),
      label: c.label,
      createdByUserId: scope.userId,
      expiresAt,
    })),
  );
  return created;
}

export async function listInviteLinks(scope: TeacherScope, groupId: string) {
  const db = requireDb();
  await assertGroupOwner(scope, groupId, db);
  const rows = await db
    .select({ link: groupInviteLinks, usedByName: users.name, usedByEmail: users.email })
    .from(groupInviteLinks)
    .leftJoin(users, eq(users.id, groupInviteLinks.usedByUserId))
    .where(eq(groupInviteLinks.groupId, groupId))
    .orderBy(desc(groupInviteLinks.createdAt));
  const now = new Date();
  return rows.map(({ link, usedByName, usedByEmail }) => ({
    id: link.id,
    label: link.label,
    status: inviteLinkStatus(link, now),
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    usedAt: link.usedAt,
    revokedAt: link.revokedAt,
    usedBy: link.usedByUserId === null ? null : { id: link.usedByUserId, name: usedByName, email: usedByEmail },
  }));
}

/** Only an unused, unrevoked link can be revoked; the WHERE clause makes that race-free too. */
export async function revokeInviteLink(scope: TeacherScope, groupId: string, linkId: string) {
  const db = requireDb();
  await assertGroupOwner(scope, groupId, db);
  const [res] = await db
    .update(groupInviteLinks)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(groupInviteLinks.id, linkId),
        eq(groupInviteLinks.groupId, groupId),
        isNull(groupInviteLinks.usedByUserId),
        isNull(groupInviteLinks.revokedAt),
      ),
    );
  if (res.affectedRows !== 1) throw new AppError("NOT_FOUND");
  return { ok: true };
}

/** Raw tokens can't be shown again, so "copy the link again" means: revoke this one, issue a fresh one with the same label. */
export async function reissueInviteLink(scope: TeacherScope, groupId: string, linkId: string, expiresInDays?: number) {
  const db = requireDb();
  await assertGroupOwner(scope, groupId, db);
  const [link] = await db
    .select()
    .from(groupInviteLinks)
    .where(and(eq(groupInviteLinks.id, linkId), eq(groupInviteLinks.groupId, groupId)))
    .limit(1);
  if (!link || link.usedByUserId !== null) throw new AppError("NOT_FOUND");
  if (!link.revokedAt) {
    await db
      .update(groupInviteLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(groupInviteLinks.id, linkId), isNull(groupInviteLinks.usedByUserId), isNull(groupInviteLinks.revokedAt)));
  }
  const [fresh] = await createInviteLinks(scope, groupId, { labels: [link.label], expiresInDays });
  return fresh;
}

/** All link ids of a group, as the share-event target ids their tagged links were logged under. */
export async function inviteLinkShareTargets(groupId: string) {
  const rows = await requireDb().select({ id: groupInviteLinks.id }).from(groupInviteLinks).where(eq(groupInviteLinks.groupId, groupId));
  return rows.map((r) => inviteLinkShareTarget(r.id));
}

/** Share events for a single-use link are logged under its public row id — never the secret token. */
export const inviteLinkShareTarget = (linkId: string) => `link:${linkId}`;

// ---------------------------------------------------------------------------
// Public preview
// ---------------------------------------------------------------------------

export interface InviteLinkGroupPreview {
  name: string;
  subject: string;
  groupType: GroupType;
  grade: string;
  level: string;
  teacherName: string;
  language: string;
  format: GroupFormat;
  description: string | null;
  startDate: Date | null;
  classSchedule: ClassScheduleEntry[];
  teachingCategory: string;
  teachingSubcategory: string;
}

export type InviteLinkPreview =
  | { state: "NOT_FOUND" | "USED" | "EXPIRED" | "REVOKED" }
  | { state: "ACTIVE" | "REDEEMED_BY_YOU"; linkId: string; group: InviteLinkGroupPreview };

/**
 * What the holder of a link may see. Group details only for a link that can still be redeemed (or
 * that this very viewer redeemed); a dead link says only that it's dead — nothing about the group,
 * the teacher's label, or who used it.
 */
export function previewState(link: GroupInviteLink | null, viewerId: number | null, now = new Date()): InviteLinkPreview["state"] {
  if (!link) return "NOT_FOUND";
  if (viewerId !== null && link.usedByUserId === viewerId) return "REDEEMED_BY_YOU";
  return inviteLinkStatus(link, now);
}

async function linkByToken(token: string) {
  if (!isWellFormedInviteLinkToken(token)) return null;
  const [link] = await requireDb().select().from(groupInviteLinks).where(eq(groupInviteLinks.tokenHash, hashInviteLinkToken(token))).limit(1);
  return link ?? null;
}

export async function publicInviteLinkPreview(token: string, viewerId: number | null): Promise<InviteLinkPreview> {
  const link = await linkByToken(token);
  const state = previewState(link, viewerId);
  if (state !== "ACTIVE" && state !== "REDEEMED_BY_YOU") return { state };
  if (!link) return { state: "NOT_FOUND" };
  const db = requireDb();
  const [g] = await db
    .select({
      id: groups.id,
      name: groups.name,
      subject: groups.subject,
      grade: groups.grade,
      description: groups.description,
      language: groups.language,
      format: groups.format,
      startDate: groups.startDate,
      classSchedule: groups.classSchedule,
      scheduleVisible: groups.scheduleVisible,
      providerName: providerWorkspaces.publicDisplayName,
      providerTitle: providerWorkspaces.title,
      teachingCategory: providerWorkspaces.teachingCategory,
      teachingSubcategory: providerWorkspaces.teachingSubcategory,
      providerType: providerWorkspaces.providerType,
    })
    .from(groups)
    .innerJoin(providerWorkspaces, eq(providerWorkspaces.id, groups.providerWorkspaceId))
    .where(eq(groups.id, link.groupId))
    .limit(1);
  if (!g) return { state: "NOT_FOUND" };
  return {
    state,
    linkId: link.id,
    group: {
      name: g.name,
      subject: g.subject,
      ...(await groupProfileOf(g, db)),
      teacherName: g.providerName || g.providerTitle,
      language: g.language,
      format: g.format,
      description: g.description,
      startDate: g.scheduleVisible ? g.startDate : null,
      classSchedule: g.scheduleVisible ? g.classSchedule : [],
      teachingCategory: g.teachingCategory,
      teachingSubcategory: g.teachingSubcategory,
    },
  };
}

// ---------------------------------------------------------------------------
// Redemption
// ---------------------------------------------------------------------------

/** The storage operations redemption needs; the real one is MySQL, tests use an in-memory fake. */
export interface RedeemStore {
  findByHash(tokenHash: string): Promise<GroupInviteLink | null>;
  groupInfo(groupId: string): Promise<{ name: string; ownerUserId: number } | null>;
  membershipStatus(groupId: string, userId: number): Promise<"ACTIVE" | "PENDING" | null>;
  /**
   * In one transaction: bind the link to `userId` only if it is still unused, unrevoked and
   * unexpired at `now` (a conditional UPDATE — the database decides the single winner), then make
   * the membership ACTIVE. Returns false, changing nothing, if the link was no longer claimable.
   */
  claimAndActivate(linkId: string, groupId: string, userId: number, now: Date): Promise<boolean>;
}

export type RedeemResult = { linkId: string; groupId: string; groupName: string; ownerUserId: number; outcome: "JOINED" | "ALREADY_REDEEMED" };

const errorFor = (status: InviteLinkStatus) =>
  status === "REVOKED" ? "INVITE_LINK_REVOKED" : status === "EXPIRED" ? "INVITE_LINK_EXPIRED" : "INVITE_LINK_USED";

export async function redeemWithStore(store: RedeemStore, userId: number, token: string, now = new Date()): Promise<RedeemResult> {
  if (!isWellFormedInviteLinkToken(token)) throw new AppError("INVITE_LINK_NOT_FOUND");
  const link = await store.findByHash(hashInviteLinkToken(token));
  if (!link) throw new AppError("INVITE_LINK_NOT_FOUND");
  const group = await store.groupInfo(link.groupId);
  if (!group) throw new AppError("INVITE_LINK_NOT_FOUND");
  const base = { linkId: link.id, groupId: link.groupId, groupName: group.name, ownerUserId: group.ownerUserId };

  // Re-opening a link you already redeemed is fine — unless the teacher has since removed you.
  if (link.usedByUserId === userId) {
    if ((await store.membershipStatus(link.groupId, userId)) === "ACTIVE") return { ...base, outcome: "ALREADY_REDEEMED" };
    throw new AppError("INVITE_LINK_USED");
  }
  const status = inviteLinkStatus(link, now);
  if (status !== "ACTIVE") throw new AppError(errorFor(status));
  if (group.ownerUserId === userId) throw new AppError("CANNOT_JOIN_OWN_GROUP");
  // Already in the group another way: leave the link unused so the teacher can give it to someone else.
  if ((await store.membershipStatus(link.groupId, userId)) === "ACTIVE") throw new AppError("ALREADY_MEMBER");

  if (await store.claimAndActivate(link.id, link.groupId, userId, now)) return { ...base, outcome: "JOINED" };

  // Lost the race (or the link changed in between): report what actually happened to it.
  const after = await store.findByHash(link.tokenHash);
  if (after?.usedByUserId === userId) return { ...base, outcome: "ALREADY_REDEEMED" };
  throw new AppError(after ? errorFor(inviteLinkStatus(after, now)) : "INVITE_LINK_NOT_FOUND");
}

const mysqlRedeemStore: RedeemStore = {
  async findByHash(tokenHash) {
    const [link] = await requireDb().select().from(groupInviteLinks).where(eq(groupInviteLinks.tokenHash, tokenHash)).limit(1);
    return link ?? null;
  },
  async groupInfo(groupId) {
    const [row] = await requireDb()
      .select({ name: groups.name, ownerUserId: providerWorkspaces.ownerUserId })
      .from(groups)
      .innerJoin(providerWorkspaces, eq(providerWorkspaces.id, groups.providerWorkspaceId))
      .where(eq(groups.id, groupId))
      .limit(1);
    return row ?? null;
  },
  async membershipStatus(groupId, userId) {
    const [row] = await requireDb()
      .select({ status: groupMembers.status })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
      .limit(1);
    return row?.status ?? null;
  },
  async claimAndActivate(linkId, groupId, userId, now) {
    return requireDb().transaction(async (tx) => {
      const [res] = await tx
        .update(groupInviteLinks)
        .set({ usedByUserId: userId, usedAt: now })
        .where(
          and(
            eq(groupInviteLinks.id, linkId),
            isNull(groupInviteLinks.usedByUserId),
            isNull(groupInviteLinks.revokedAt),
            gt(groupInviteLinks.expiresAt, now),
          ),
        );
      if (res.affectedRows !== 1) return false;
      await tx
        .insert(groupMembers)
        .values({ groupId, userId, membershipRole: "STUDENT", status: "ACTIVE" })
        .onDuplicateKeyUpdate({ set: { status: "ACTIVE" } });
      await recordJoinSource(tx, { groupId, userId, joinedVia: "SINGLE_USE_LINK", sourceId: linkId, actorUserId: userId, at: now });
      return true;
    });
  },
};

export const redeemInviteLink = (userId: number, token: string) => redeemWithStore(mysqlRedeemStore, userId, token);

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { groupEmailInvites, groupMembers, groups, providerWorkspaces, type GroupEmailInvite } from "../../drizzle/schema";
import { requireDb, type DbOrTx } from "../db";
import type { TeacherScope } from "./access";
import { AppError } from "./errors";
import { assertGroupOwner, workspaceOwnerOf } from "./groups";

const TOKEN_BYTES = 32;
const EXPIRY_DAYS = 7;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(TOKEN_BYTES).toString("hex");
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Derived display status: a PENDING row past `expiresAt` reads as expired without a DB write. */
export type EmailInviteDisplayStatus = "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";

export function inviteDisplayStatus(invite: Pick<GroupEmailInvite, "status" | "expiresAt">, now = new Date()): EmailInviteDisplayStatus {
  if (invite.status !== "PENDING") return invite.status;
  return invite.expiresAt.getTime() < now.getTime() ? "EXPIRED" : "PENDING";
}

async function groupById(groupId: string, db: DbOrTx) {
  const [group] = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
  if (!group) throw new AppError("NOT_FOUND");
  return group;
}

/** Teacher creates a one-time invite scoped to a single email. The raw token is returned once and never stored. */
export async function createEmailInvite(scope: TeacherScope, groupId: string, email: string) {
  const db = requireDb();
  await assertGroupOwner(scope, groupId, db);
  const token = newToken();
  const id = nanoid();
  await db.insert(groupEmailInvites).values({
    id,
    groupId,
    invitedByUserId: scope.userId,
    email: normalizeEmail(email),
    tokenHash: hashToken(token),
    expiresAt: addDays(new Date(), EXPIRY_DAYS),
  });
  return { id, token };
}

export async function listEmailInvites(scope: TeacherScope, groupId: string) {
  const db = requireDb();
  await assertGroupOwner(scope, groupId, db);
  const rows = await db
    .select()
    .from(groupEmailInvites)
    .where(eq(groupEmailInvites.groupId, groupId))
    .orderBy(desc(groupEmailInvites.createdAt));
  const now = new Date();
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayStatus: inviteDisplayStatus(r, now),
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  }));
}

export async function revokeEmailInvite(scope: TeacherScope, groupId: string, inviteId: string) {
  const db = requireDb();
  await assertGroupOwner(scope, groupId, db);
  const [res] = await db
    .update(groupEmailInvites)
    .set({ status: "REVOKED", revokedAt: new Date() })
    .where(and(eq(groupEmailInvites.id, inviteId), eq(groupEmailInvites.groupId, groupId), eq(groupEmailInvites.status, "PENDING")));
  if (res.affectedRows !== 1) throw new AppError("NOT_FOUND");
  return { ok: true };
}

/** Revokes the old invite (if still pending) and issues a fresh token for the same email. */
export async function resendEmailInvite(scope: TeacherScope, groupId: string, inviteId: string) {
  const db = requireDb();
  await assertGroupOwner(scope, groupId, db);
  const [existing] = await db
    .select()
    .from(groupEmailInvites)
    .where(and(eq(groupEmailInvites.id, inviteId), eq(groupEmailInvites.groupId, groupId)))
    .limit(1);
  if (!existing) throw new AppError("NOT_FOUND");
  if (existing.status === "PENDING") {
    await db.update(groupEmailInvites).set({ status: "REVOKED", revokedAt: new Date() }).where(eq(groupEmailInvites.id, inviteId));
  }
  return createEmailInvite(scope, groupId, existing.email);
}

/** Safe public preview before Google Sign-In: never exposes the invited email itself. */
export async function publicEmailInvitePreview(token: string) {
  const db = requireDb();
  const [invite] = await db.select().from(groupEmailInvites).where(eq(groupEmailInvites.tokenHash, hashToken(token))).limit(1);
  if (!invite || inviteDisplayStatus(invite) !== "PENDING") return null;
  const [group] = await db
    .select({
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
    })
    .from(groups)
    .innerJoin(providerWorkspaces, eq(providerWorkspaces.id, groups.providerWorkspaceId))
    .where(eq(groups.id, invite.groupId))
    .limit(1);
  if (!group) return null;
  return {
    name: group.name,
    subject: group.subject,
    grade: group.grade,
    teacherName: group.providerName || group.providerTitle,
    language: group.language,
    format: group.format,
    description: group.description,
    startDate: group.scheduleVisible ? group.startDate : null,
    classSchedule: group.scheduleVisible ? group.classSchedule : [],
  };
}

/**
 * Accepts an email-restricted invite for the signed-in user. Membership is activated immediately
 * (bypassing teacher approval) because the invite already proves the teacher targeted this exact
 * email, and a successful accept proves the signer controls that same Google account.
 */
export async function acceptEmailInvite(userId: number, userEmail: string, token: string) {
  const db = requireDb();
  const [invite] = await db.select().from(groupEmailInvites).where(eq(groupEmailInvites.tokenHash, hashToken(token))).limit(1);
  if (!invite) throw new AppError("EMAIL_INVITE_NOT_FOUND");
  const display = inviteDisplayStatus(invite);
  if (display === "REVOKED") throw new AppError("EMAIL_INVITE_NOT_FOUND");
  if (display === "EXPIRED") throw new AppError("EMAIL_INVITE_EXPIRED");
  if (display === "ACCEPTED") throw new AppError("ALREADY_MEMBER");
  if (normalizeEmail(userEmail) !== invite.email) throw new AppError("EMAIL_INVITE_MISMATCH");

  const group = await groupById(invite.groupId, db);
  const ws = await workspaceOwnerOf(group.providerWorkspaceId, db);
  if (ws.ownerUserId === userId) throw new AppError("CANNOT_JOIN_OWN_GROUP");

  const [existing] = await db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, invite.groupId), eq(groupMembers.userId, userId)))
    .limit(1);
  if (existing?.status !== "ACTIVE") {
    if (existing) {
      await db.update(groupMembers).set({ status: "ACTIVE" }).where(eq(groupMembers.id, existing.id));
    } else {
      await db.insert(groupMembers).values({ groupId: invite.groupId, userId, membershipRole: "STUDENT", status: "ACTIVE" });
    }
  }
  await db.update(groupEmailInvites).set({ status: "ACCEPTED", acceptedAt: new Date() }).where(eq(groupEmailInvites.id, invite.id));
  return { groupId: invite.groupId, groupName: group.name };
}

import { desc, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import type { AuditAction, PartnerDecision, PartnerStatus } from "../../shared/adminPermissions";
import { partnerProfiles, users } from "../../drizzle/schema";
import type { RequestMeta } from "../_core/requestMeta";
import { requireDb } from "../db";
import { partnerProfileOf } from "./access";
import { appendAudit } from "./admin/audit";
import type { AdminContext } from "./admin/authz";
import { AppError } from "./errors";

const referralCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 10);

export type PartnerAnswers = Record<string, string>;

/**
 * A partner profile starts PENDING; the partner context opens only after admin approval.
 * Re-submitting while INFO_REQUESTED updates the answers and returns the application to PENDING.
 */
export async function applyAsPartner(userId: number, answers: PartnerAnswers | undefined, meta: RequestMeta) {
  const db = requireDb();
  const applicant = { userId, primaryRole: null };
  const existing = await partnerProfileOf(userId, db);
  if (existing) {
    if (existing.status !== "INFO_REQUESTED" || !answers) throw new AppError("PARTNER_EXISTS");
    await db.transaction(async (tx) => {
      await tx.update(partnerProfiles).set({ status: "PENDING", applicationAnswers: answers }).where(eq(partnerProfiles.id, existing.id));
      await appendAudit(
        tx,
        applicant,
        {
          action: "PARTNER_APPLICATION_UPDATED",
          targetType: "PARTNER_PROFILE",
          targetId: existing.id,
          userId,
          before: { status: existing.status },
          after: { status: "PENDING", answeredFields: Object.keys(answers) },
        },
        meta,
      );
    });
    return (await partnerProfileOf(userId, db))!;
  }
  await db.transaction(async (tx) => {
    const [row] = await tx.insert(partnerProfiles).values({ userId, referralCode: referralCode(), applicationAnswers: answers ?? null }).$returningId();
    await appendAudit(
      tx,
      applicant,
      {
        action: "PARTNER_APPLIED",
        targetType: "PARTNER_PROFILE",
        targetId: row.id,
        userId,
        after: { status: "PENDING", answeredFields: Object.keys(answers ?? {}) },
      },
      meta,
    );
  });
  return (await partnerProfileOf(userId, db))!;
}

export async function listPartnerProfiles(status?: PartnerStatus) {
  return requireDb()
    .select({
      id: partnerProfiles.id,
      userId: partnerProfiles.userId,
      status: partnerProfiles.status,
      referralCode: partnerProfiles.referralCode,
      applicationAnswers: partnerProfiles.applicationAnswers,
      approvedAt: partnerProfiles.approvedAt,
      decidedAt: partnerProfiles.decidedAt,
      decidedBy: partnerProfiles.decidedBy,
      createdAt: partnerProfiles.createdAt,
      name: users.name,
      email: users.email,
    })
    .from(partnerProfiles)
    .innerJoin(users, eq(users.id, partnerProfiles.userId))
    .where(status ? eq(partnerProfiles.status, status) : undefined)
    .orderBy(desc(partnerProfiles.createdAt));
}

const TRANSITIONS: Record<PartnerDecision, { from: readonly PartnerStatus[]; to: PartnerStatus; action: AuditAction }> = {
  APPROVE: { from: ["PENDING", "INFO_REQUESTED", "REJECTED"], to: "APPROVED", action: "PARTNER_APPROVED" },
  REJECT: { from: ["PENDING", "INFO_REQUESTED"], to: "REJECTED", action: "PARTNER_REJECTED" },
  REQUEST_INFO: { from: ["PENDING"], to: "INFO_REQUESTED", action: "PARTNER_INFO_REQUESTED" },
  SUSPEND: { from: ["APPROVED"], to: "SUSPENDED", action: "PARTNER_SUSPENDED" },
  REACTIVATE: { from: ["SUSPENDED"], to: "APPROVED", action: "PARTNER_REACTIVATED" },
};

export async function decidePartnerProfile(admin: AdminContext, profileId: number, decision: PartnerDecision, reason: string) {
  const rule = TRANSITIONS[decision];
  return requireDb().transaction(async (tx) => {
    const [row] = await tx.select().from(partnerProfiles).where(eq(partnerProfiles.id, profileId)).for("update");
    if (!row) throw new AppError("NOT_FOUND");
    if (row.userId === admin.userId) throw new AppError("CANNOT_TARGET_SELF");
    if (!rule.from.includes(row.status)) throw new AppError("INVALID_TRANSITION");
    const now = new Date();
    await tx
      .update(partnerProfiles)
      .set({
        status: rule.to,
        approvedAt: rule.to === "APPROVED" ? (row.approvedAt ?? now) : row.approvedAt,
        decidedBy: admin.userId,
        decidedAt: now,
      })
      .where(eq(partnerProfiles.id, profileId));
    await appendAudit(
      tx,
      admin,
      {
        action: rule.action,
        targetType: "PARTNER_PROFILE",
        targetId: profileId,
        userId: row.userId,
        before: { status: row.status },
        after: { status: rule.to },
        reason,
      },
      admin.meta,
    );
    return { id: profileId, status: rule.to };
  });
}

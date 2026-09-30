import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import type { SecurityEventStatus, SecurityEventType, SecuritySeverity } from "../../../shared/adminPermissions";
import { securityEvents } from "../../../drizzle/schema";
import { requireDb } from "../../db";
import { AppError } from "../errors";
import { appendAudit } from "./audit";
import type { AdminContext } from "./authz";

export type SecurityFilters = {
  status?: SecurityEventStatus;
  type?: SecurityEventType;
  severity?: SecuritySeverity;
  userId?: number;
  before?: number;
  limit?: number;
};

export async function listSecurityEvents(f: SecurityFilters) {
  const where: SQL[] = [];
  if (f.status) where.push(eq(securityEvents.status, f.status));
  if (f.type) where.push(eq(securityEvents.type, f.type));
  if (f.severity) where.push(eq(securityEvents.severity, f.severity));
  if (f.userId !== undefined) where.push(eq(securityEvents.userId, f.userId));
  if (f.before !== undefined) where.push(lt(securityEvents.id, f.before));
  return requireDb()
    .select()
    .from(securityEvents)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(securityEvents.id))
    .limit(Math.min(f.limit ?? 50, 200));
}

export async function reviewSecurityEvent(admin: AdminContext, id: number, status: Exclude<SecurityEventStatus, "REVIEW_REQUIRED">, reason: string) {
  return requireDb().transaction(async (tx) => {
    const [row] = await tx.select().from(securityEvents).where(eq(securityEvents.id, id)).for("update");
    if (!row) throw new AppError("NOT_FOUND");
    if (row.status === status) throw new AppError("INVALID_TRANSITION");
    await tx.update(securityEvents).set({ status, reviewedBy: admin.userId, reviewedAt: new Date() }).where(eq(securityEvents.id, id));
    await appendAudit(
      tx,
      admin,
      { action: "SECURITY_EVENT_REVIEWED", targetType: "SECURITY_EVENT", targetId: id, userId: row.userId, before: { status: row.status }, after: { status }, reason },
      admin.meta,
    );
    return { id, status };
  });
}

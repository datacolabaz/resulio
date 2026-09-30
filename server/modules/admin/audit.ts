import { and, desc, eq, gte, lt, lte, type SQL } from "drizzle-orm";
import type { AdminRole, AuditAction, AuditTargetType } from "../../../shared/adminPermissions";
import { auditLogs } from "../../../drizzle/schema";
import type { RequestMeta } from "../../_core/requestMeta";
import { requireDb, type DbOrTx } from "../../db";
import { AppError } from "../errors";

/** NULL actor = SYSTEM (ops script). A non-admin actor (e.g. a partner applicant) has role null. */
export type AuditActor = { userId: number; primaryRole: AdminRole | null } | null;

export type AuditEntry = {
  action: AuditAction;
  targetType: AuditTargetType;
  targetId?: string | number | null;
  workspaceId?: string | null;
  userId?: number | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
};

/** Keys that must never be copied into audit metadata. */
const FORBIDDEN_KEYS = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "cookie",
  "secret",
  "password",
  "answer",
  "answers",
  "answerkey",
  "content",
  "fileurl",
]);

export function assertAuditSafe(value: unknown, depth = 0): void {
  if (value === null || typeof value !== "object" || depth > 5) return;
  for (const [key, inner] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new AppError("AUDIT_UNSAFE_METADATA");
    assertAuditSafe(inner, depth + 1);
  }
}

/** The only write path for audit_logs. Call inside the transaction that performs the action. */
export async function appendAudit(tx: DbOrTx, actor: AuditActor, entry: AuditEntry, meta: RequestMeta) {
  assertAuditSafe(entry.before);
  assertAuditSafe(entry.after);
  await tx.insert(auditLogs).values({
    actorUserId: actor?.userId ?? null,
    actorAdminRole: actor ? actor.primaryRole : "SYSTEM",
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId === undefined || entry.targetId === null ? null : String(entry.targetId),
    workspaceId: entry.workspaceId ?? null,
    userId: entry.userId ?? null,
    beforeJson: entry.before ?? null,
    afterJson: entry.after ?? null,
    reason: entry.reason ?? null,
    requestId: meta.requestId,
    ipHash: meta.ipHash,
    userAgentSummary: meta.userAgentSummary,
    createdAt: new Date(),
  });
}

export type AuditFilters = {
  from?: Date;
  to?: Date;
  actorUserId?: number;
  action?: AuditAction;
  targetType?: AuditTargetType;
  targetId?: string;
  userId?: number;
  workspaceId?: string;
  /** Return rows with id below this value (newest first). */
  before?: number;
  limit?: number;
};

export async function listAudit(f: AuditFilters) {
  const where: SQL[] = [];
  if (f.from) where.push(gte(auditLogs.createdAt, f.from));
  if (f.to) where.push(lte(auditLogs.createdAt, f.to));
  if (f.actorUserId !== undefined) where.push(eq(auditLogs.actorUserId, f.actorUserId));
  if (f.action) where.push(eq(auditLogs.action, f.action));
  if (f.targetType) where.push(eq(auditLogs.targetType, f.targetType));
  if (f.targetId) where.push(eq(auditLogs.targetId, f.targetId));
  if (f.userId !== undefined) where.push(eq(auditLogs.userId, f.userId));
  if (f.workspaceId) where.push(eq(auditLogs.workspaceId, f.workspaceId));
  if (f.before !== undefined) where.push(lt(auditLogs.id, f.before));
  return requireDb()
    .select()
    .from(auditLogs)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(auditLogs.id))
    .limit(Math.min(f.limit ?? 50, 200));
}

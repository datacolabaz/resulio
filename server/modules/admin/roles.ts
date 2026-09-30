import { and, asc, eq, sql } from "drizzle-orm";
import { API_GRANTABLE_ROLES, type AdminRole } from "../../../shared/adminPermissions";
import { platformRoles, users } from "../../../drizzle/schema";
import type { RequestMeta } from "../../_core/requestMeta";
import { requireDb, type Tx } from "../../db";
import { AppError } from "../errors";
import { recordSecurityEvent } from "../securityEvents";
import { appendAudit, type AuditActor } from "./audit";
import type { AdminContext } from "./authz";

type RoleChange = { actor: AuditActor; meta: RequestMeta; userId: number; role: AdminRole; reason: string };

async function assertUser(tx: Tx, userId: number) {
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
  if (!user) throw new AppError("NOT_FOUND");
}

async function grant(c: RoleChange) {
  await requireDb().transaction(async (tx) => {
    await assertUser(tx, c.userId);
    const [existing] = await tx
      .select({ id: platformRoles.id })
      .from(platformRoles)
      .where(and(eq(platformRoles.userId, c.userId), eq(platformRoles.role, c.role)));
    if (existing) throw new AppError("ALREADY_HAS_ROLE");
    await tx.insert(platformRoles).values({ userId: c.userId, role: c.role, createdBy: c.actor?.userId ?? null });
    await appendAudit(
      tx,
      c.actor,
      { action: "ROLE_GRANTED", targetType: "PLATFORM_ROLE", targetId: `${c.userId}:${c.role}`, userId: c.userId, before: { role: null }, after: { role: c.role }, reason: c.reason },
      c.meta,
    );
  });
  recordSecurityEvent({ type: "ADMIN_ROLE_CHANGED", severity: "MEDIUM", userId: c.userId, ipHash: c.meta.ipHash, details: { change: "granted", role: c.role, by: c.actor?.userId ?? "SYSTEM" } });
  return { userId: c.userId, role: c.role, granted: true };
}

async function revoke(c: RoleChange) {
  await requireDb().transaction(async (tx) => {
    await assertUser(tx, c.userId);
    if (c.role === "SUPER_ADMIN") {
      // Lock every SUPER_ADMIN row so two concurrent revocations cannot both pass the check.
      const supers = await tx.select({ userId: platformRoles.userId }).from(platformRoles).where(eq(platformRoles.role, "SUPER_ADMIN")).for("update");
      if (supers.length <= 1 && supers.some((s) => s.userId === c.userId)) throw new AppError("LAST_SUPER_ADMIN");
    }
    const removed = await tx.delete(platformRoles).where(and(eq(platformRoles.userId, c.userId), eq(platformRoles.role, c.role)));
    if (removed[0].affectedRows === 0) throw new AppError("NOT_FOUND");
    await appendAudit(
      tx,
      c.actor,
      { action: "ROLE_REVOKED", targetType: "PLATFORM_ROLE", targetId: `${c.userId}:${c.role}`, userId: c.userId, before: { role: c.role }, after: { role: null }, reason: c.reason },
      c.meta,
    );
  });
  recordSecurityEvent({ type: "ADMIN_ROLE_CHANGED", severity: "MEDIUM", userId: c.userId, ipHash: c.meta.ipHash, details: { change: "revoked", role: c.role, by: c.actor?.userId ?? "SYSTEM" } });
  return { userId: c.userId, role: c.role, granted: false };
}

function assertApiChange(admin: AdminContext, userId: number, role: AdminRole) {
  if (!API_GRANTABLE_ROLES.includes(role)) throw new AppError("ROLE_NOT_GRANTABLE");
  if (userId === admin.userId) throw new AppError("CANNOT_TARGET_SELF");
}

/** Admin API: SUPPORT_ADMIN only. SUPER_ADMIN is never granted or revoked through the API. */
export async function grantRole(admin: AdminContext, userId: number, role: AdminRole, reason: string) {
  assertApiChange(admin, userId, role);
  return grant({ actor: admin, meta: admin.meta, userId, role, reason });
}

export async function revokeRole(admin: AdminContext, userId: number, role: AdminRole, reason: string) {
  assertApiChange(admin, userId, role);
  return revoke({ actor: admin, meta: admin.meta, userId, role, reason });
}

const SYSTEM_META: RequestMeta = { requestId: null, ipHash: null, userAgentSummary: "ops-script" };

/** Ops script path (scripts/admin-grant.ts). SUPER_ADMIN only for e-mails on the allowlist. */
export async function systemGrantRole(userId: number, email: string | null, role: AdminRole, reason: string, superAdminEmails: readonly string[]) {
  const allowlisted = !!email && superAdminEmails.some((e) => e.trim().toLowerCase() === email.trim().toLowerCase());
  if (role === "SUPER_ADMIN" && !allowlisted) throw new AppError("ROLE_NOT_GRANTABLE");
  return grant({ actor: null, meta: SYSTEM_META, userId, role, reason });
}

export async function systemRevokeRole(userId: number, role: AdminRole, reason: string) {
  return revoke({ actor: null, meta: SYSTEM_META, userId, role, reason });
}

export async function listAdmins() {
  return requireDb()
    .select({ userId: platformRoles.userId, role: platformRoles.role, createdAt: platformRoles.createdAt, name: users.name, email: users.email })
    .from(platformRoles)
    .innerJoin(users, eq(users.id, platformRoles.userId))
    .orderBy(asc(platformRoles.role), asc(sql`lower(${users.email})`));
}

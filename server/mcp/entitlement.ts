import { and, asc, eq, inArray } from "drizzle-orm";
import { mcpEntitlements, mcpUpgradeRequests, platformRoles, users, type User } from "../../drizzle/schema";
import { ROLE_PERMISSIONS, type AdminRole } from "../../shared/adminPermissions";
import { entitlementState, type McpEntitlementState } from "../../shared/mcpConnector";
import { getUserById, requireDb } from "../db";
import { appendAudit } from "../modules/admin/audit";
import type { AdminContext } from "../modules/admin/authz";
import { AppError } from "../modules/errors";
import * as notifications from "../modules/notifications";
import { isMissingTable } from "../notifications/preferences";

/**
 * The connector is a paid feature granted per teacher like a subscription (mcp_entitlements). There is
 * no payment system yet: teachers send an upgrade request and an admin grants, extends or revokes.
 * Read on every check without caching, so an expiry or revocation takes effect on the next request.
 */

export async function mcpEntitlement(userId: number, now = new Date()): Promise<McpEntitlementState> {
  try {
    const [row] = await requireDb().select().from(mcpEntitlements).where(eq(mcpEntitlements.userId, userId)).limit(1);
    return entitlementState(row, now);
  } catch (error) {
    if (isMissingTable(error)) return entitlementState(null);
    throw error;
  }
}

/** Throws MCP_ENTITLEMENT_EXPIRED for a lapsed subscription and MCP_NOT_ENABLED otherwise unless active. */
export async function assertMcpEntitled(userId: number, now = new Date()): Promise<McpEntitlementState> {
  const state = await mcpEntitlement(userId, now);
  if (state.status === "EXPIRED") throw new AppError("MCP_ENTITLEMENT_EXPIRED");
  if (state.status !== "ACTIVE") throw new AppError("MCP_NOT_ENABLED");
  return state;
}

/** Admin list: entitlement and open upgrade request for each of these users. */
export async function mcpAdminStates(userIds: number[], now = new Date()) {
  const out = new Map<number, McpEntitlementState & { note: string | null; requestedAt: Date | null }>();
  if (!userIds.length) return out;
  const db = requireDb();
  try {
    const [rows, requests] = await Promise.all([
      db.select().from(mcpEntitlements).where(inArray(mcpEntitlements.userId, userIds)),
      db.select().from(mcpUpgradeRequests).where(and(inArray(mcpUpgradeRequests.userId, userIds), eq(mcpUpgradeRequests.status, "OPEN"))),
    ]);
    const byUser = new Map(rows.map((r) => [r.userId, r]));
    const openBy = new Map(requests.map((r) => [r.userId, r.requestedAt]));
    for (const id of userIds) {
      const row = byUser.get(id);
      out.set(id, { ...entitlementState(row, now), note: row?.note ?? null, requestedAt: openBy.get(id) ?? null });
    }
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    for (const id of userIds) out.set(id, { ...entitlementState(null), note: null, requestedAt: null });
  }
  return out;
}

async function teacherOrNotFound(userId: number) {
  const user = await getUserById(userId);
  if (!user) throw new AppError("NOT_FOUND");
  return user;
}

/** Admin: grant or extend (expiresAt null: no end date). Closes the teacher's open upgrade request. */
export async function grantMcpEntitlement(admin: AdminContext, userId: number, input: { plan: string; expiresAt: Date | null; note: string | null }, now = new Date()) {
  await teacherOrNotFound(userId);
  const db = requireDb();
  const before = await mcpEntitlement(userId, now);
  const values = { enabled: true, plan: input.plan, expiresAt: input.expiresAt, note: input.note, grantedBy: admin.userId };
  await db.transaction(async (tx) => {
    await tx.insert(mcpEntitlements).values({ userId, ...values }).onDuplicateKeyUpdate({ set: values });
    await tx
      .update(mcpUpgradeRequests)
      .set({ status: "HANDLED", handledAt: now, handledBy: admin.userId })
      .where(and(eq(mcpUpgradeRequests.userId, userId), eq(mcpUpgradeRequests.status, "OPEN")));
    await appendAudit(
      tx,
      admin,
      { action: "MCP_ENTITLEMENT_CHANGED", targetType: "USER", targetId: userId, userId, before, after: { status: "ACTIVE", plan: input.plan, expiresAt: input.expiresAt } },
      admin.meta,
    );
  });
  if (before.status !== "ACTIVE") {
    await notifications
      .notify(userId, "Claude inteqrasiyası aktivdir", "Resulio-nu Claude-a qoşmaq üçün Parametrlər → Claude inteqrasiyası bölməsini açın.")
      .catch(() => undefined);
  }
  return mcpEntitlement(userId, now);
}

/** Admin: switch off now; existing tokens stop working on their next request. */
export async function revokeMcpEntitlement(admin: AdminContext, userId: number, now = new Date()) {
  await teacherOrNotFound(userId);
  const db = requireDb();
  const before = await mcpEntitlement(userId, now);
  await db.transaction(async (tx) => {
    await tx.update(mcpEntitlements).set({ enabled: false, grantedBy: admin.userId }).where(eq(mcpEntitlements.userId, userId));
    await appendAudit(tx, admin, { action: "MCP_ENTITLEMENT_CHANGED", targetType: "USER", targetId: userId, userId, before, after: { status: "DISABLED" } }, admin.meta);
  });
  return mcpEntitlement(userId, now);
}

/** Admins who manage AI features (and so this subscription) get the in-app notice about new requests. */
async function entitlementAdminIds(): Promise<number[]> {
  const roles = (Object.keys(ROLE_PERMISSIONS) as AdminRole[]).filter((r) => ROLE_PERMISSIONS[r].includes("ai.manage"));
  const rows = await requireDb().selectDistinct({ userId: platformRoles.userId }).from(platformRoles).where(inArray(platformRoles.role, roles));
  return rows.map((r) => r.userId);
}

export type UpgradeOutcome = "CREATED" | "ALREADY_OPEN" | "ALREADY_ACTIVE";

/**
 * Teacher's "Subscribe" button. At most one open request per teacher (one row per teacher, reopened
 * after an admin handled it), so repeated clicks or concurrent requests notify admins once.
 */
export async function requestMcpUpgrade(user: User, now = new Date()): Promise<UpgradeOutcome> {
  if ((await mcpEntitlement(user.id, now)).status === "ACTIVE") return "ALREADY_ACTIVE";
  const db = requireDb();
  // Two single-statement claims (no transaction): a lock upgrade inside one deadlocks concurrent clicks.
  const [inserted] = await db.insert(mcpUpgradeRequests).ignore().values({ userId: user.id, status: "OPEN", requestedAt: now });
  let created = inserted.affectedRows === 1;
  if (!created) {
    const [reopened] = await db
      .update(mcpUpgradeRequests)
      .set({ status: "OPEN", requestedAt: now, handledAt: null, handledBy: null })
      .where(and(eq(mcpUpgradeRequests.userId, user.id), eq(mcpUpgradeRequests.status, "HANDLED")));
    created = reopened.affectedRows === 1;
  }
  if (!created) return "ALREADY_OPEN";
  const who = [user.name, user.email].filter(Boolean).join(", ") || `#${user.id}`;
  for (const adminId of await entitlementAdminIds().catch(() => [])) {
    await notifications
      .notify(adminId, "Claude inteqrasiyası: abunə sorğusu", `${who} premium AI inteqrasiyasına (Claude) abunə olmaq istəyir. Admin → Müəllim limitləri.`)
      .catch(() => undefined);
  }
  return "CREATED";
}

export async function hasOpenUpgradeRequest(userId: number): Promise<boolean> {
  try {
    const [row] = await requireDb()
      .select({ status: mcpUpgradeRequests.status })
      .from(mcpUpgradeRequests)
      .where(and(eq(mcpUpgradeRequests.userId, userId), eq(mcpUpgradeRequests.status, "OPEN")))
      .limit(1);
    return Boolean(row);
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

/** Admin: open upgrade requests, oldest first. */
export async function openUpgradeRequests() {
  return requireDb()
    .select({ userId: mcpUpgradeRequests.userId, requestedAt: mcpUpgradeRequests.requestedAt, name: users.name, email: users.email })
    .from(mcpUpgradeRequests)
    .innerJoin(users, eq(users.id, mcpUpgradeRequests.userId))
    .where(eq(mcpUpgradeRequests.status, "OPEN"))
    .orderBy(asc(mcpUpgradeRequests.requestedAt))
    .limit(200);
}

/** Admin: mark a request handled without granting (e.g. the teacher declined). */
export async function closeUpgradeRequest(admin: AdminContext, userId: number, now = new Date()) {
  await requireDb()
    .update(mcpUpgradeRequests)
    .set({ status: "HANDLED", handledAt: now, handledBy: admin.userId })
    .where(and(eq(mcpUpgradeRequests.userId, userId), eq(mcpUpgradeRequests.status, "OPEN")));
  return { userId };
}

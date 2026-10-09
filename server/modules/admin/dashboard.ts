import { and, eq, sql } from "drizzle-orm";
import type { AdminPermission } from "../../../shared/adminPermissions";
import { periodStart } from "../../../shared/aiUsage";
import { groupMembers, providerWorkspaces, users } from "../../../drizzle/schema";
import { aiMonthTotals, budgetView } from "../../aiUsage/admin";
import { requireDb } from "../../db";
import { storageTotalBytes } from "../../fileStorage/summary";
import { getPlatformSettings } from "../../platformSettings";
import type { AdminContext } from "./authz";

/** Admin dashboard numbers; AI and storage figures only for admins who may see those sections. */
export async function dashboard(admin: Pick<AdminContext, "permissions">, now = new Date()) {
  const db = requireDb();
  const [u] = await db
    .select({
      total: sql<number>`count(*)`,
      newThisMonth: sql<number>`coalesce(sum(${users.createdAt} >= ${periodStart("month", now)}), 0)`,
      activeWeek: sql<number>`coalesce(sum(${users.lastSeenAt} >= ${new Date(now.getTime() - 7 * 86_400_000)}), 0)`,
    })
    .from(users);
  const [teachers] = await db.select({ n: sql<number>`count(distinct ${providerWorkspaces.ownerUserId})` }).from(providerWorkspaces);
  const [students] = await db
    .select({ n: sql<number>`count(distinct ${groupMembers.userId})` })
    .from(groupMembers)
    .where(and(eq(groupMembers.status, "ACTIVE"), eq(groupMembers.membershipRole, "STUDENT")));
  const can = (p: AdminPermission) => admin.permissions.includes(p);
  const settings = await getPlatformSettings();
  const ai = can("ai.view") ? await aiMonthTotals(now) : null;
  return {
    users: { total: Number(u?.total ?? 0), newThisMonth: Number(u?.newThisMonth ?? 0), activeWeek: Number(u?.activeWeek ?? 0) },
    teachers: Number(teachers?.n ?? 0),
    students: Number(students?.n ?? 0),
    ai: ai ? { ...ai, budget: budgetView(ai.costUsd, settings["ai.monthlyBudgetUsd"], now) } : null,
    storage: can("storage.view") ? { totalBytes: await storageTotalBytes(), softQuotaBytes: settings["storage.softQuotaBytes"] || null } : null,
  };
}

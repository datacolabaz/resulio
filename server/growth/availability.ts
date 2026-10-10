import { and, eq, inArray } from "drizzle-orm";
import { featureFlagOverrides, featureFlags, groupMembers, groups, providerWorkspaces } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { requireDb } from "../db";
import { AppError } from "../modules/errors";
import { isMissingTable } from "../notifications/preferences";

/**
 * Feature flag `growth_engine`. Off unless one of these turns it on for a workspace:
 *   1. env GROWTH_ENGINE_ENABLED_WORKSPACES — comma-separated workspace ids, or "*";
 *   2. a `feature_flag_overrides` row (flagKey growth_engine, scopeType WORKSPACE);
 *   3. a global `feature_flags` row (key growth_engine, enabled = 1).
 * An override with enabled = 0 turns a workspace off even when the global flag is on; the env list
 * always wins. Missing tables mean "off", never an error. Students see the feature for the
 * workspaces of their active groups that have it on.
 */

export const GROWTH_FLAG = "growth_engine";
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; value: boolean }>();

export function envEnablesGrowth(workspaceId: string, list: readonly string[] = ENV.growthEnabledWorkspaces) {
  return list.includes("*") || list.includes(workspaceId);
}

async function globalFlag(): Promise<boolean> {
  const [row] = await requireDb().select({ enabled: featureFlags.enabled }).from(featureFlags).where(eq(featureFlags.key, GROWTH_FLAG)).limit(1);
  return row?.enabled ?? false;
}

async function dbEnables(workspaceId: string): Promise<boolean> {
  try {
    const [override] = await requireDb()
      .select({ enabled: featureFlagOverrides.enabled })
      .from(featureFlagOverrides)
      .where(and(eq(featureFlagOverrides.flagKey, GROWTH_FLAG), eq(featureFlagOverrides.scopeType, "WORKSPACE"), eq(featureFlagOverrides.scopeId, workspaceId)))
      .limit(1);
    if (override) return override.enabled;
    return await globalFlag();
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

export async function growthEnabledFor(workspaceId: string): Promise<boolean> {
  if (envEnablesGrowth(workspaceId)) return true;
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await dbEnables(workspaceId);
  cache.set(workspaceId, { at: Date.now(), value });
  return value;
}

export async function assertGrowthEnabled(workspaceId: string) {
  if (!(await growthEnabledFor(workspaceId))) throw new AppError("GROWTH_NOT_AVAILABLE");
}

export function clearGrowthCache() {
  cache.clear();
}

/** Every workspace with the flag on, for the background jobs. */
export async function growthWorkspaceIds(): Promise<string[]> {
  const db = requireDb();
  const env = ENV.growthEnabledWorkspaces;
  let all = env.includes("*");
  try {
    if (!all) all = await globalFlag();
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  const ids = all ? (await db.select({ id: providerWorkspaces.id }).from(providerWorkspaces)).map((r) => r.id) : [...env];
  let overrides: { scopeId: string; enabled: boolean }[] = [];
  try {
    overrides = await db
      .select({ scopeId: featureFlagOverrides.scopeId, enabled: featureFlagOverrides.enabled })
      .from(featureFlagOverrides)
      .where(and(eq(featureFlagOverrides.flagKey, GROWTH_FLAG), eq(featureFlagOverrides.scopeType, "WORKSPACE")));
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  const set = new Set(ids);
  for (const o of overrides) {
    if (o.enabled) set.add(o.scopeId);
    else if (!envEnablesGrowth(o.scopeId)) set.delete(o.scopeId);
  }
  return [...set];
}

/** The student's active groups whose workspace has the Growth Engine on. */
export async function studentGrowthGroups(userId: number) {
  const db = requireDb();
  const rows = await db
    .select({ groupId: groups.id, name: groups.name, workspaceId: groups.providerWorkspaceId })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.userId, userId), eq(groupMembers.status, "ACTIVE"), eq(groupMembers.membershipRole, "STUDENT")));
  const out: typeof rows = [];
  for (const r of rows) if (await growthEnabledFor(r.workspaceId)) out.push(r);
  return out;
}

/** Workspace of a group the student is an active member of, with the flag on; otherwise NOT_FOUND. */
export async function studentGroupWorkspace(userId: number, groupId: string) {
  const list = await studentGrowthGroups(userId);
  const hit = list.find((g) => g.groupId === groupId);
  if (!hit) throw new AppError("NOT_FOUND");
  return hit;
}

export async function groupWorkspaces(groupIds: string[]) {
  if (!groupIds.length) return new Map<string, string>();
  const rows = await requireDb().select({ id: groups.id, workspaceId: groups.providerWorkspaceId }).from(groups).where(inArray(groups.id, groupIds));
  return new Map(rows.map((r) => [r.id, r.workspaceId]));
}

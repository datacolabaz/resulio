import { and, eq, inArray } from "drizzle-orm";
import { featureFlagOverrides, featureFlags, groupMembers, groups } from "../../drizzle/schema";
import { COACH_FLAG } from "../../shared/coach";
import { ENV } from "../_core/env";
import { requireDb } from "../db";
import { AppError } from "../modules/errors";
import { isMissingTable } from "../notifications/preferences";

/**
 * Feature flag `study_coach`, per student. Off unless one of these turns it on:
 *   1. env STUDY_COACH_ENABLED_USERS (user ids or "*") or STUDY_COACH_ENABLED_WORKSPACES (the
 *      workspaces of the student's active groups, or "*");
 *   2. a USER override row for the student (its value wins, on or off);
 *   3. a WORKSPACE override that is on for one of the student's group workspaces;
 *   4. the global `feature_flags` row.
 * Students without any group are covered by 1 ("*"), 2 and 4. Missing tables mean "off".
 */

const CACHE_MS = 30_000;
const cache = new Map<number, { at: number; value: boolean }>();

export function envEnablesCoach(userId: number, workspaceIds: readonly string[], users: readonly string[] = ENV.coachEnabledUsers, workspaces: readonly string[] = ENV.coachEnabledWorkspaces) {
  if (users.includes("*") || users.includes(String(userId))) return true;
  if (workspaces.includes("*")) return true;
  return workspaceIds.some((w) => workspaces.includes(w));
}

/** The flag decision from the DB rows alone; pure. */
export function decideFromRows(rows: { userOverride: boolean | null; workspaceOverrides: boolean[]; global: boolean }) {
  if (rows.userOverride !== null) return rows.userOverride;
  if (rows.workspaceOverrides.some(Boolean)) return true;
  return rows.global;
}

export async function activeGroupWorkspaces(userId: number): Promise<string[]> {
  const rows = await requireDb()
    .select({ workspaceId: groups.providerWorkspaceId })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.userId, userId), eq(groupMembers.status, "ACTIVE"), eq(groupMembers.membershipRole, "STUDENT")));
  return [...new Set(rows.map((r) => r.workspaceId))];
}

async function dbEnables(userId: number, workspaceIds: string[]): Promise<boolean> {
  const db = requireDb();
  try {
    const [user] = await db
      .select({ enabled: featureFlagOverrides.enabled })
      .from(featureFlagOverrides)
      .where(and(eq(featureFlagOverrides.flagKey, COACH_FLAG), eq(featureFlagOverrides.scopeType, "USER"), eq(featureFlagOverrides.scopeId, String(userId))))
      .limit(1);
    const ws = workspaceIds.length
      ? await db
          .select({ enabled: featureFlagOverrides.enabled })
          .from(featureFlagOverrides)
          .where(and(eq(featureFlagOverrides.flagKey, COACH_FLAG), eq(featureFlagOverrides.scopeType, "WORKSPACE"), inArray(featureFlagOverrides.scopeId, workspaceIds)))
      : [];
    const [global] = await db.select({ enabled: featureFlags.enabled }).from(featureFlags).where(eq(featureFlags.key, COACH_FLAG)).limit(1);
    return decideFromRows({ userOverride: user ? user.enabled : null, workspaceOverrides: ws.map((r) => r.enabled), global: global?.enabled ?? false });
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

export async function coachEnabledFor(userId: number): Promise<boolean> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const workspaceIds = await activeGroupWorkspaces(userId);
  const value = envEnablesCoach(userId, workspaceIds) || (await dbEnables(userId, workspaceIds));
  cache.set(userId, { at: Date.now(), value });
  return value;
}

export async function assertCoachEnabled(userId: number) {
  if (!(await coachEnabledFor(userId))) throw new AppError("COACH_NOT_AVAILABLE");
}

export function clearCoachCache() {
  cache.clear();
}
